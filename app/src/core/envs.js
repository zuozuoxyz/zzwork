// zzwork 环境扫描：Skills 全局(~/.zzwork/skills)、MCP(~/.zzwork/mcp.json + 任务级)、WSL 枚举、远程同步
const fs = require('fs')
const path = require('path')
const os = require('os')
const { exec, execFile } = require('child_process')
const sshConn = require('./sshconn')

const GLOBAL_ENV = 'global'
const CACHE = new Map()
const TTL = 10 * 60 * 1000

function sh(cmd, timeout) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeout || 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)))
  })
}
function cacheGet(key) {
  const v = CACHE.get(key)
  if (v && Date.now() - v.at < TTL) return v.value
  return undefined
}
function cacheSet(key, value) { CACHE.set(key, { at: Date.now(), value }) }
function clearCache() { CACHE.clear() }

async function envExec(env, posixCmd) {
  if (env.kind === 'wsl') return sh(`wsl.exe -d ${env.config.distro} -- sh -lc ${JSON.stringify(posixCmd)}`, 15000)
  if (env.kind === 'ssh') {
    // 有密码走 ssh2，否则回退系统 ssh（密钥 / ssh-agent）
    const r = await sshConn.runRemote(env, env.secret || '', posixCmd, 20000)
    return r.ok ? r.stdout : null
  }
  return null
}

function skillsRoot(home) { return path.join(home || os.homedir(), '.zzwork', 'skills') }
// 扫描根：自身 skills 目录 + Claude / agents 通用 skills 目录
function skillRoots(home) {
  const h = home || os.homedir()
  return [path.join(h, '.zzwork', 'skills'), path.join(h, '.agents', 'skills'), path.join(h, '.claude', 'skills')]
}
function globalMcpPath(home) { return path.join(home || os.homedir(), '.zzwork', 'mcp.json') }

// ---------- SKILL.md ----------
function parseSkillText(raw, file, source) {
  let name = '', description = '', body = raw
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (m) {
    body = raw.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/)
      if (!kv) continue
      const k = kv[1].toLowerCase()
      const v = kv[2].trim().replace(/^["']|["']$/g, '')
      if (k === 'name') name = v
      else if (k === 'description') description = v
    }
  }
  if (!name) name = path.basename(path.dirname(file)) || file
  if (!description) {
    const first = body.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'))
    description = (first || '').slice(0, 200)
  }
  return { name, description, path: file, source: source || 'user' }
}

function walkSkills(root, out, depth, seen) {
  if (depth > 5) return
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(root, e.name)
    let isDir = e.isDirectory()
    if (!isDir && e.isSymbolicLink()) {
      try { isDir = fs.statSync(p).isDirectory() } catch {}
    }
    if (isDir) {
      // 目录即 skill：有 SKILL.md 才收录；symlink 与实体目录去重（如 .claude -> .agents）
      let real = p
      try { real = fs.realpathSync(p) } catch {}
      if (seen && seen.has(real)) continue
      if (seen) seen.add(real)
      walkSkills(p, out, depth + 1, seen)
    } else if (e.isFile() && e.name === 'SKILL.md') {
      try { out.push(parseSkillText(fs.readFileSync(p, 'utf8'), p, 'user')) } catch {}
    }
  }
}

// 多目录同名 skill 只保留一个：按扫描顺序 .zzwork > .agents > .claude
function dedupeSkills(list) {
  const seen = new Set()
  const out = []
  for (const s of list) {
    const k = String(s.name || '').toLowerCase()
    if (k && seen.has(k)) continue
    if (k) seen.add(k)
    out.push(s)
  }
  return out
}

// 本机 skills：~/.zzwork/skills + ~/.agents/skills + ~/.claude/skills
function scanSkillsSync() {
  const out = []
  const seen = new Set()
  for (const root of skillRoots()) {
    if (fs.existsSync(root)) walkSkills(root, out, 0, seen)
  }
  return dedupeSkills(out)
}
async function scanSkills() {
  const hit = cacheGet('skills:global')
  if (hit) return hit
  const list = scanSkillsSync()
  cacheSet('skills:global', list)
  return list
}

// 远端 skills（WSL / SSH）：一次命令取回三个根目录下的 SKILL.md 头部分块
async function scanSkillsRemote(env) {
  if (!env || (env.kind !== 'wsl' && env.kind !== 'ssh')) return []
  // 脚本经 base64 传入：wsl.exe 会对命令行里的 $VAR 做预展开，直接传会丢失变量
  const script = 'for d in "$HOME/.zzwork/skills" "$HOME/.agents/skills" "$HOME/.claude/skills"; '
    + 'do [ -d "$d" ] || continue; find "$d" -maxdepth 6 -name SKILL.md -type f 2>/dev/null; done '
    + "| while IFS= read -r f; do printf '@@SKILL@@%s\\n' \"$f\"; head -c 4000 \"$f\" 2>/dev/null; printf '\\n@@END@@\\n'; done"
  const b64 = Buffer.from(script, 'utf8').toString('base64')
  const text = await envExec(env, `printf %s ${b64} | base64 -d | sh`)
  if (!text) return []
  const out = []
  const re = /@@SKILL@@(.+)\r?\n([\s\S]*?)\n@@END@@/g
  let m
  while ((m = re.exec(text))) {
    const file = m[1].trim()
    try { out.push(parseSkillText(m[2], file, 'user')) } catch {}
  }
  return dedupeSkills(out)
}

// ---------- MCP ----------
function normalizeServers(obj, topKey, originPath, out) {
  if (!obj || typeof obj !== 'object') return
  const servers = obj[topKey]
  if (!servers || typeof servers !== 'object') return
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    let type = cfg.type
    if (!type) type = cfg.url ? 'http' : 'stdio'
    const config = {}
    for (const k of ['command', 'args', 'env', 'envFile', 'cwd', 'url', 'headers', 'oauth']) {
      if (cfg[k] !== undefined) config[k] = cfg[k]
    }
    out.push({ name, type, config, source: 'discovered', origin_path: originPath })
  }
}
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// 全局 MCP：~/.zzwork/mcp.json + 任务级 .mcp.json / .vscode/mcp.json（本机路径）
async function scanMcp(taskPath) {
  const key = 'mcp:global:' + (taskPath || '')
  const hit = cacheGet(key)
  if (hit) return hit
  const out = []
  const userCfg = readJsonSafe(globalMcpPath())
  if (userCfg) normalizeServers(userCfg, 'mcpServers', '~/.zzwork/mcp.json', out)
  if (taskPath) {
    const proj = readJsonSafe(path.join(taskPath, '.mcp.json'))
    if (proj) normalizeServers(proj, 'mcpServers', '.mcp.json', out)
    const vscode = readJsonSafe(path.join(taskPath, '.vscode', 'mcp.json'))
    if (vscode) normalizeServers(vscode, 'servers', '.vscode/mcp.json', out)
  }
  cacheSet(key, out)
  return out
}

// ---------- WSL 发行版枚举 ----------
const WSL_ROW_RE = /^(\*)?\s*(.+?)\s+(Running|Stopped|Installing|Uninstalling|Converting|Starting|Unknown)\s+(\d+)\s*$/i
// 不缓存：仅在打开「添加环境」时调用，且新装发行版后应立即出现在列表里
async function listWslDistros() {
  let list = []
  const buf = await new Promise((resolve) => {
    execFile('wsl.exe', ['--list', '--verbose'], { timeout: 10000, windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout))
  })
  if (buf && buf.length) {
    const utf16 = (buf[0] === 0xFF && buf[1] === 0xFE) || buf[1] === 0
    const text = utf16 ? buf.toString('utf16le') : buf.toString('utf8')
    list = text.replace(/^﻿/, '').replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .map((line) => {
        const m = line.match(WSL_ROW_RE)
        if (!m) return null
        return { name: m[2].trim(), state: m[3], version: m[4], default: !!m[1] }
      })
      .filter((d) => d && d.name && !/docker/i.test(d.name))
  }
  return list
}

// ---------- 远程同步：skills（按需，把本机 ~/.zzwork/skills/<name> 拷到远端同名目录）----------
// 异步递归拷贝：目标常是 \\wsl$ UNC，同步 fs 会阻塞主线程（回合内执行）
async function copyDirRecursive(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true })
  for (const e of await fs.promises.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name)
    if (e.isDirectory()) await copyDirRecursive(s, d)
    else await fs.promises.copyFile(s, d)
  }
}

async function syncSkillsToEnv(env, skillDirs) {
  if (!skillDirs || !skillDirs.length) return { ok: true, synced: 0 }
  const names = skillDirs.map((p) => path.basename(path.dirname(p))).filter(Boolean)
  if (env.kind === 'local' || env.kind === undefined) return { ok: true, synced: 0 }
  if (env.kind === 'wsl') {
    // 通过 \\wsl$ UNC 直接拷贝
    try {
      const homeOut = await envExec(env, 'printf %s "$HOME"')
      const home = (homeOut || '').trim()
      if (!home) return { ok: false, error: '无法取到远端 HOME' }
      const m = home.match(/^\/(mnt\/[a-z])\/(.*)$/i) // Windows 下 home 通常是 /home/user
      const winHome = home.replace(/\//g, '\\')
      const unc = `\\\\wsl$\\${env.config.distro}${winHome}\\.zzwork\\skills`
      await fs.promises.mkdir(unc, { recursive: true })
      let n = 0
      for (const dir of skillDirs) {
        const name = path.basename(dir)
        await copyDirRecursive(dir, path.join(unc, name))
        n++
      }
      return { ok: true, synced: n }
    } catch (e) { return { ok: false, error: e.message } }
  }
  if (env.kind === 'ssh') {
    try {
      let n = 0
      for (const dir of skillDirs) {
        const name = path.basename(dir)
        // 逐文件 cat 写入远端
        const files = []
        ;(function walk(p, rel) {
          for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const fp = path.join(p, e.name), rp = rel ? rel + '/' + e.name : e.name
            if (e.isDirectory()) walk(fp, rp)
            else files.push([fp, rp])
          }
        })(dir, '')
        for (const [fp, rp] of files) {
          const content = fs.readFileSync(fp)
          const b64 = content.toString('base64')
          const res = await envExec(env, `mkdir -p "$HOME/.zzwork/skills/${name}" && printf %s ${JSON.stringify(b64)} | base64 -d > "$HOME/.zzwork/skills/${name}/${rp}"`)
          if (res === null) return { ok: false, error: 'ssh 写入失败' }
        }
        n++
      }
      return { ok: true, synced: n }
    } catch (e) { return { ok: false, error: e.message } }
  }
  return { ok: true, synced: 0 }
}

// ssh://<envId>/<远程绝对路径> 形式的任务路径
function parseRemotePath(p) {
  const m = String(p || '').match(/^ssh:\/\/([^/]+)(\/.*)?$/i)
  return m ? { envId: m[1], remotePath: m[2] || '/' } : null
}

function parseMeta(s) {
  if (s && typeof s === 'object') return s
  try { return JSON.parse(s || '{}') } catch { return {} }
}

function normalizeSsh(e, unixPath) {
  const c = e.config || {}
  return { ...e, host: c.host, user: c.user, port: c.port, config: c, unixPath: unixPath || '/' }
}

// 任务路径 -> 环境（WSL UNC / SSH ssh:// 自动识别；可显式绑定 meta.envId）
function resolveTaskEnv(store, task) {
  const envs = store.listEnvironments ? store.listEnvironments() : []
  const p = task && task.path ? task.path : ''
  const wsl = p.match(/^\\\\wsl(?:\.localhost|\$)?\\([^\\]+)\\(.*)$/i)
  if (wsl) {
    const distro = wsl[1]
    const unixPath = '/' + wsl[2].replace(/\\/g, '/')
    const found = envs.find((e) => e.kind === 'wsl' && (e.config.distro === distro || e.name === distro))
    const base = found || { id: `wsl:${distro}`, name: distro, kind: 'wsl', config: { distro } }
    return { ...base, distro, unixPath }
  }
  const remote = parseRemotePath(p)
  if (remote) {
    const fe = envs.find((e) => e.id === remote.envId)
    if (fe) return normalizeSsh(fe, remote.remotePath)
    return { id: remote.envId, name: remote.envId, kind: 'ssh', config: {}, unixPath: remote.remotePath }
  }
  // 兼容：SSH 环境显式绑定在 task.meta.envId（路径不是 ssh:// 时）
  const meta = task ? parseMeta(task.meta) : {}
  if (meta.envId) {
    const fe = envs.find((e) => e.id === meta.envId)
    if (fe) return fe.kind === 'ssh' ? normalizeSsh(fe, p) : fe
  }
  return envs.find((e) => e.kind === 'local') || { id: 'local', name: '本机', kind: 'local', config: {} }
}

module.exports = { GLOBAL_ENV, scanSkills, scanSkillsRemote, scanMcp, resolveTaskEnv, parseRemotePath, listWslDistros, syncSkillsToEnv, skillsRoot, skillRoots, globalMcpPath, clearCache }
