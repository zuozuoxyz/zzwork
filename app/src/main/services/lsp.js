// 语言服务（LSP）：按任务所在环境启动 language server，桥接 Monaco 的「转到定义」
// 支持本机 / WSL / SSH；服务器按 (env, language, taskRoot) 复用，闲置回收
const fs = require('fs')
const path = require('path')
const { spawn, exec, execFile } = require('child_process')
const { pathToFileURL } = require('url')
const { LspClient, LanguageSession } = require('../../core/lsp/client')
const envsCore = require('../../core/envs')
const { spawnRemote, runRemote } = require('../../core/sshconn')
const { getStore } = require('./store')
const secrets = require('./secrets')

const IDLE_MS = 5 * 60 * 1000
const sessions = new Map()      // key -> { session, client, proc, key, timer }
const probeCache = new Map()    // envKey -> { at, tools:Set, servers:Set }

// 远端语言服务器 / 安装工具常装在非交互 PATH 之外，探测与启动统一用补全后的 PATH
const LSP_PATH = [
  '$HOME/go/bin', '$HOME/.local/bin', '$HOME/.cargo/bin', '$HOME/.npm-global/bin',
  "$(ls -d $HOME/.nvm/versions/node/*/bin $HOME/.local/share/fnm/node-versions/*/installation/bin 2>/dev/null | tr '\\n' ':')",
  '/usr/local/bin', '/usr/bin', '$PATH'
].join(':')

// POSIX 单引号转义
function posixQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'` }
function lspShell(cmd) { return `env PATH="${LSP_PATH}" sh -c ${posixQuote(cmd)}` }

// Monaco languageId -> 候选启动命令（按顺序探测第一个可用的）
const SERVER_REGISTRY = {
  python: [
    { cmd: 'pyright-langserver', args: ['--stdio'], label: 'pyright' },
    { cmd: 'pylsp', args: [], label: 'pylsp' },
    { cmd: 'jedi-language-server', args: [], label: 'jedi' }
  ],
  c: [{ cmd: 'clangd', args: [], label: 'clangd' }],
  cpp: [{ cmd: 'clangd', args: [], label: 'clangd' }],
  go: [{ cmd: 'gopls', args: [], label: 'gopls' }],
  rust: [{ cmd: 'rust-analyzer', args: [], label: 'rust-analyzer' }]
}

const LANG_LABEL = { python: 'Python', c: 'C', cpp: 'C/C++', go: 'Go', rust: 'Rust' }

// 用于一次性探测的候选二进制 / 安装工具
const ALL_SERVER_CMDS = Array.from(new Set(Object.values(SERVER_REGISTRY).flat().map((c) => c.cmd)))
const TOOLS = ['npm', 'pip3', 'pip', 'go', 'rustup', 'apt-get', 'dnf', 'pacman', 'apk', 'winget', 'choco']

// 每种语言的一键安装策略（按顺序尝试第一个「工具存在」的项）
const LANG_INSTALL = {
  python: [
    { tool: 'npm', via: 'npm', cmd: 'npm install -g pyright' },
    { tool: 'pip3', via: 'pip', cmd: 'pip3 install pyright' },
    { tool: 'pip', via: 'pip', cmd: 'pip install pyright' }
  ],
  c: [
    { tool: 'apt-get', via: 'apt', cmd: '(sudo -n apt-get install -y clangd 2>/dev/null || apt-get install -y clangd)' },
    { tool: 'dnf', via: 'dnf', cmd: '(sudo -n dnf install -y clangd 2>/dev/null || dnf install -y clangd)' },
    { tool: 'pacman', via: 'pacman', cmd: '(sudo -n pacman -Sy --noconfirm clang 2>/dev/null || pacman -Sy --noconfirm clang)' },
    { tool: 'apk', via: 'apk', cmd: 'apk add --no-cache clang-extra-tools' },
    { tool: 'winget', via: 'winget', cmd: 'winget install --id LLVM.LLVM -e --silent --accept-package-agreements --accept-source-agreements' },
    { tool: 'choco', via: 'choco', cmd: 'choco install llvm -y' }
  ],
  go: [
    { tool: 'go', via: 'go', cmd: 'go install golang.org/x/tools/gopls@latest' }
  ],
  rust: [
    { tool: 'rustup', via: 'rustup', cmd: 'rustup component add rust-analyzer' }
  ]
}
LANG_INSTALL.cpp = LANG_INSTALL.c

// ---------- 路径 / URI 映射（scheme 路径 ↔ 环境内 native 路径 ↔ file URI）----------
function toNative(env, schemePath) {
  const s = String(schemePath || '')
  if (env.kind === 'wsl') {
    const rest = s.replace(/^\\\\wsl(?:\.localhost|\$)?\\[^\\]+/i, '')
    return rest.replace(/\\/g, '/') || '/'
  }
  if (env.kind === 'ssh') {
    const rp = envsCore.parseRemotePath(s)
    return rp ? rp.remotePath : s
  }
  return s
}

function fromNative(env, nativePath) {
  const p = String(nativePath || '')
  if (env.kind === 'wsl') {
    const distro = (env.config && env.config.distro) || env.distro || ''
    return '\\\\wsl$\\' + distro + p.replace(/\//g, '\\')
  }
  if (env.kind === 'ssh') return 'ssh://' + env.id + p
  return p
}

function posixFileUri(p) {
  const encoded = String(p || '/').split('/').map((seg) => {
    try { return encodeURIComponent(seg) } catch { return seg }
  }).join('/')
  return 'file://' + encoded
}

function nativeToUri(env, nativePath) {
  if (env.kind === 'local') {
    try { return pathToFileURL(path.resolve(String(nativePath))).href } catch { return posixFileUri(String(nativePath).replace(/\\/g, '/')) }
  }
  return posixFileUri(nativePath)
}

function uriToNative(env, uriOrObj) {
  const u = String((uriOrObj && (uriOrObj.uri || uriOrObj.uriString)) || uriOrObj || '')
  if (!/^file:/i.test(u)) return null
  let p = u.replace(/^file:\/\//i, '')
  p = p.split('/').map((seg) => {
    try { return decodeURIComponent(seg) } catch { return seg }
  }).join('/')
  if (env.kind === 'local') {
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : p
  }
  return p || '/'
}

function nativeRoot(env, taskPath) {
  if (env.kind === 'local') return taskPath
  return env.unixPath || '/'
}

// ---------- 服务器探测 ----------
function spawnLocal(cmd, args, opts) {
  if (process.platform === 'win32' && !/[\\/]/.test(cmd) && !/\.exe$/i.test(cmd)) {
    const q = (s) => (/[\s"]/.test(String(s)) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s))
    return spawn([cmd, ...args].map(q).join(' '), { ...(opts || {}), shell: true, windowsHide: true })
  }
  return spawn(cmd, args, { windowsHide: true, ...(opts || {}) })
}

function wslOut(distro, script, timeoutMs) {
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-d', distro, '--', 'sh', '-c', script],
      { timeout: timeoutMs || 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout || '')))
  })
}

function commandExistsLocal(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const d of dirs) {
    for (const ext of exts) {
      try { if (fs.existsSync(path.join(d, cmd + ext))) return true } catch {}
    }
  }
  return false
}

function envKey(env) {
  return (env.id || env.kind) + (env.kind === 'wsl' ? ':' + ((env.config && env.config.distro) || env.distro || '') : '')
}

// 一次探测：环境内可用的安装工具 + 已安装的语言服务器二进制（本机查 PATH，远端一条脚本）
async function probeEnv(env, force) {
  const key = envKey(env)
  const hit = probeCache.get(key)
  if (!force && hit && Date.now() - hit.at < 60000) return hit
  const tools = new Set()
  const servers = new Set()
  if (env.kind === 'local') {
    for (const t of TOOLS) if (commandExistsLocal(t)) tools.add(t)
    for (const c of ALL_SERVER_CMDS) if (commandExistsLocal(c)) servers.add(c)
  } else {
    const script = 'for t in ' + TOOLS.join(' ') + '; do command -v $t >/dev/null 2>&1 && echo "T:$t"; done; '
      + 'for c in ' + ALL_SERVER_CMDS.join(' ') + '; do command -v $c >/dev/null 2>&1 && echo "S:$c"; done'
    let out = ''
    try {
      if (env.kind === 'wsl') out = (await wslOut((env.config && env.config.distro) || env.distro || '', lspShell(script), 20000)) || ''
      else { const r = await runRemote(env, env.secret || '', lspShell(script), 25000); out = (r && r.stdout) || '' }
    } catch {}
    for (const tok of String(out).split(/\s+/)) {
      if (tok.startsWith('T:')) tools.add(tok.slice(2))
      else if (tok.startsWith('S:')) servers.add(tok.slice(2))
    }
  }
  const rec = { at: Date.now(), tools, servers }
  probeCache.set(key, rec)
  return rec
}

async function detectServer(env, lang) {
  const cands = SERVER_REGISTRY[lang] || []
  if (!cands.length) return null
  const { servers } = await probeEnv(env)
  return cands.find((c) => servers.has(c.cmd)) || null
}

function installersFor(lang, tools) {
  return (LANG_INSTALL[lang] || []).filter((c) => tools.has(c.tool))
}

// 环境描述（来自 UI 的 envDesc）-> 内部 env（附 SSH 密码）
function buildEnvFromDesc(desc) {
  const d = desc || {}
  const cfg = d.config || {}
  const distro = d.distro || cfg.distro
  const host = d.host || cfg.host
  const user = d.user || cfg.user
  const port = d.port || cfg.port
  const kind = d.kind || 'local'
  const env = { id: d.id || '', kind, distro, host, config: { distro, host, user, port } }
  if (kind === 'ssh' && env.id) {
    try { env.secret = secrets.get('zzwork.ssh.' + env.id) || '' } catch {}
  }
  return env
}

// 列出各语言服务器状态 + 该环境可用的安装方式
async function listServers(desc) {
  try {
    const env = buildEnvFromDesc(desc)
    const { tools } = await probeEnv(env)
    const out = []
    for (const lang of Object.keys(SERVER_REGISTRY)) {
      const server = await detectServer(env, lang)
      const installers = installersFor(lang, tools)
      out.push({
        id: lang,
        label: LANG_LABEL[lang] || lang,
        server: server ? server.label : null,
        installed: !!server,
        installers: installers.map((c) => ({ tool: c.tool, via: c.via, cmd: c.cmd }))
      })
    }
    return out
  } catch (e) {
    return []
  }
}

function runInstall(env, cmd) {
  const opts = { timeout: 300000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  if (env.kind === 'ssh') {
    return runRemote(env, env.secret || '', lspShell(cmd), 300000).then((r) => ({
      ok: !!(r && r.ok),
      output: String((r && r.stdout) || '') + String((r && r.stderr) || '') + (r && r.error ? String(r.error) : '')
    }))
  }
  if (env.kind === 'wsl') {
    const distro = (env.config && env.config.distro) || env.distro || ''
    return new Promise((resolve) => {
      execFile('wsl.exe', ['-d', distro, '--', 'sh', '-c', lspShell(cmd)], opts,
        (err, stdout, stderr) => resolve({ ok: !err, output: String(stdout || '') + String(stderr || '') }))
    })
  }
  return new Promise((resolve) => {
    exec(cmd, opts, (err, stdout, stderr) => resolve({ ok: !err, output: String(stdout || '') + String(stderr || '') }))
  })
}

async function installLang(desc, languageId) {
  const env = buildEnvFromDesc(desc)
  const lang = String(languageId || '')
  if (!LANG_INSTALL[lang]) return { ok: false, output: '不支持的语言：' + lang }
  const { tools } = await probeEnv(env, true)
  const cands = installersFor(lang, tools)
  if (!cands.length) {
    return { ok: false, output: '该环境没有可用的安装工具（需要 npm / pip / apt / go / rustup / winget 之一）' }
  }
  const pick = cands[0]
  const r = await runInstall(env, pick.cmd)
  probeCache.delete(envKey(env))   // 让下次检测反映新安装结果
  return { ok: r.ok, via: pick.via, cmd: pick.cmd, output: String(r.output || '').slice(-4000) }
}

// ---------- 会话管理 ----------
function spawnServer(env, server, taskPath) {
  const line = [server.cmd, ...(server.args || [])].join(' ')
  if (env.kind === 'wsl') {
    const distro = (env.config && env.config.distro) || env.distro || ''
    return spawn('wsl.exe', ['-d', distro, '--cd', env.unixPath || '/', '--', 'sh', '-c', lspShell(line)], { windowsHide: true })
  }
  if (env.kind === 'ssh') return spawnRemote(env, env.secret || '', lspShell(line))
  return spawnLocal(server.cmd, server.args || [], { cwd: taskPath, env: process.env })
}

function sessionKey(env, lang, taskPath) {
  return envKey(env) + '::' + lang + '::' + nativeRoot(env, taskPath)
}

function touch(s) {
  clearTimeout(s.timer)
  s.timer = setTimeout(() => {
    try { s.session.dispose() } catch {}
    if (sessions.get(s.key) === s) sessions.delete(s.key)
  }, IDLE_MS)
  if (s.timer.unref) s.timer.unref()
}

async function getSession(env, lang, server, taskPath) {
  const key = sessionKey(env, lang, taskPath)
  const existing = sessions.get(key)
  if (existing) { touch(existing); return existing.session }
  const proc = spawnServer(env, server, taskPath)
  const client = new LspClient(proc)
  const rootUri = nativeToUri(env, nativeRoot(env, taskPath))
  const session = new LanguageSession(client, lang, rootUri)
  await session.open()
  const s = { session, client, proc, key, timer: null }
  touch(s)
  sessions.set(key, s)
  proc.on('close', () => { if (sessions.get(key) === s) sessions.delete(key) })
  return session
}

// ---------- 定义查询 ----------
function normalizeLocations(res) {
  if (!res) return []
  const arr = Array.isArray(res) ? res : [res]
  const out = []
  for (const it of arr) {
    if (!it) continue
    const uri = it.uri || it.targetUri
    const range = it.range || it.targetSelectionRange || it.targetRange
    if (!uri || !range || !range.start) continue
    out.push({ uri, line: range.start.line | 0, character: range.start.character | 0 })
  }
  return out
}

function resolveEnv(task) {
  const S = getStore()
  const env = envsCore.resolveTaskEnv(S, task)
  if (env.kind === 'ssh' && !env.secret) {
    try { env.secret = secrets.get('zzwork.ssh.' + env.id) || '' } catch {}
  }
  return env
}

async function definition(payload) {
  const { taskPath, filePath, languageId, position, content } = payload || {}
  try {
    if (!taskPath || !filePath) return { locations: [], reason: 'invalid' }
    const lang = String(languageId || '')
    if (!SERVER_REGISTRY[lang]) return { locations: [], reason: 'unsupported', language: lang }
    const env = resolveEnv({ path: taskPath })
    const server = await detectServer(env, lang)
    if (!server) {
      return { locations: [], reason: 'no-server', language: lang, candidates: SERVER_REGISTRY[lang].map((c) => c.cmd) }
    }
    const session = await getSession(env, lang, server, taskPath)
    const uri = nativeToUri(env, toNative(env, filePath))
    session.ensureDoc(uri, content)
    const reqPos = {
      line: Math.max(0, (position && position.line) | 0),
      character: Math.max(0, (position && position.character) | 0)
    }
    const res = await session.definition(uri, reqPos)
    const locations = normalizeLocations(res).map((l) => {
      const native = uriToNative(env, l.uri)
      if (native == null) return null
      return { path: fromNative(env, native), line: l.line, character: l.character }
    }).filter(Boolean)
    return { locations, server: server.label }
  } catch (e) {
    return { locations: [], reason: 'error', message: String((e && e.message) || e).slice(0, 500) }
  }
}

async function status(payload) {
  try {
    const env = resolveEnv({ path: payload && payload.taskPath })
    const installed = {}
    for (const lang of Object.keys(SERVER_REGISTRY)) {
      const s = await detectServer(env, lang)
      installed[lang] = s ? s.label : null
    }
    return { languages: Object.keys(SERVER_REGISTRY), installed, envName: env.name || env.kind }
  } catch (e) {
    return { languages: Object.keys(SERVER_REGISTRY), installed: {}, error: String((e && e.message) || e) }
  }
}

function disposeAll() {
  for (const [, s] of sessions) { try { s.session.dispose() } catch {} }
  sessions.clear()
}

module.exports = {
  definition,
  status,
  listServers,
  installLang,
  disposeAll,
  register(ipcMain) {
    ipcMain.handle('zz:lsp:definition', (_e, p) => definition(p || {}))
    ipcMain.handle('zz:lsp:status', (_e, p) => status(p || {}))
    ipcMain.handle('zz:lsp:list', (_e, p) => listServers(p || {}))
    ipcMain.handle('zz:lsp:install', (_e, p) => installLang(p || {}, p && p.languageId))
    ipcMain.handle('zz:lsp:dispose', () => { disposeAll(); return true })
  }
}
