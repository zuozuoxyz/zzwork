// zzwork 执行体运行器：在任务文件所在环境（本机/WSL/SSH）拉起 CLI agent 并流式回传
const { spawn, exec, execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { splitCommand, spawnCommand, commandParts } = require('./mcpTest')

// 已知 CLI 智能体（在任务所在环境检测是否安装；PATH 找不到时再查常见安装位置。
// 仅以可执行文件 + --version 为准，避免仅有 ~/.zcode 之类数据目录就误判为可用）
// pkg: 一键安装用的 npm 包名（未提供则视为不支持 npm 安装，如 GUI 应用）
const KNOWN_AGENTS = [
  { id: 'claude-code', name: 'Claude Code', cmd: 'claude', pkg: '@anthropic-ai/claude-code' },
  { id: 'zcode', name: 'zcode', cmd: 'zcode' },
  { id: 'codex', name: 'OpenAI Codex', cmd: 'codex', pkg: '@openai/codex' },
  { id: 'opencode', name: 'opencode', cmd: 'opencode', pkg: 'opencode-ai' },
]

// 识别任务路径所在环境
function resolveEnv(taskPath, agent) {
  const m = (taskPath || '').match(/^\\\\wsl(?:\.localhost|\$)?\\([^\\]+)\\(.*)$/i)
  if (m) return { kind: 'wsl', distro: m[1], unixPath: '/' + m[2].replace(/\\/g, '/') }
  const remote = (taskPath || '').match(/^ssh:\/\/([^/]+)(\/.*)?$/i)
  if (remote) return { kind: 'ssh', envId: remote[1], unixPath: remote[2] || '/', host: (agent && agent.host) || '' }
  if (agent.where === 'ssh' && agent.host) return { kind: 'ssh', host: agent.host }
  return { kind: 'local' }
}

// Claude Code 在 Windows 上要求 Git Bash；从 PATH 里找到 git 目录兜底
function detectGitBash() {
  if (process.platform !== 'win32') return ''
  const preset = process.env.CLAUDE_CODE_GIT_BASH_PATH
  if (preset && fs.existsSync(preset)) return preset
  const cands = []
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!/git/i.test(dir)) continue
    const root = path.dirname(dir)
    cands.push(path.join(root, 'bin', 'bash.exe'), path.join(dir, 'bash.exe'))
  }
  cands.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe')
  return cands.find((p) => fs.existsSync(p)) || ''
}

// ---- 安装检测（结果缓存 60s / 环境）----
const detectCache = new Map()
function clearDetectCache() { detectCache.clear() }
function sh(cmd, timeoutMs) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs || 6000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout))
  })
}

// ---- PATH 之外的常见安装位置（Windows：应用内自装 / GUI 应用随附 CLI）----
function newestByMtime(list) {
  return list
    .map((p) => { let m = 0; try { m = fs.statSync(p).mtimeMs } catch {} return { p, m } })
    .sort((a, b) => b.m - a.m)[0]?.p || ''
}

async function regInstallLocations(like) {
  if (process.platform !== 'win32') return []
  const script = `Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',`
    + `'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',`
    + `'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue`
    + ` | Where-Object { $_.DisplayName -like '*${like}*' }`
    + ` | ForEach-Object { $_.InstallLocation; $_.DisplayIcon; $_.UninstallString }`
  const out = await sh(`powershell -NoProfile -Command "${script}"`, 8000)
  return String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

// 注册表里能拿到安装目录（InstallLocation 可能为空，退化为 DisplayIcon / UninstallString 的父目录）
function dirCandidates(raw) {
  const s = String(raw || '').trim()
  const m = s.match(/^"([^"]+)"|^([^\s"]+)/)
  const p = m ? (m[1] || m[2]) : ''
  if (!p) return []
  const out = [path.dirname(p)]
  try { if (p !== path.dirname(p) && fs.statSync(p).isDirectory()) out.unshift(p) } catch {}
  return out
}

// ZCode 桌面端把内置 provider 配置放在 resources/config/provider，
// 而 CLI 只认 resources/glm/provider；缺失时补一份，否则 --prompt 会报错
function ensureZcodeProvider(cjsPath) {
  try {
    const glmDir = path.dirname(cjsPath)
    const dest = path.join(glmDir, 'provider', 'zcode-builtin.json')
    if (fs.existsSync(dest)) return
    const src = path.join(path.dirname(glmDir), 'config', 'provider', 'zcode-builtin.json')
    if (!fs.existsSync(src)) return
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
  } catch {}
}

// 返回绝对路径（.exe/.cmd 或 .cjs/.js）；找不到返回 ''
async function findAgentExe(id) {
  if (process.platform !== 'win32') return ''
  if (id === 'codex') {
    const cands = []
    const binBase = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : ''
    if (binBase) {
      try {
        for (const d of fs.readdirSync(binBase)) {
          for (const n of ['codex.exe', 'codex.cmd']) {
            const p = path.join(binBase, d, n)
            if (fs.existsSync(p)) cands.push(p)
          }
        }
      } catch {}
    }
    for (const home of [path.join(os.homedir(), '.codex', 'bin'), path.join(process.env.APPDATA || '', 'npm')]) {
      for (const n of ['codex.exe', 'codex.cmd']) {
        const p = path.join(home, n)
        if (fs.existsSync(p)) cands.push(p)
      }
    }
    return newestByMtime(cands)
  }
  if (id === 'zcode') {
    const pick = (p) => { if (p && fs.existsSync(p)) { ensureZcodeProvider(p); return p } return '' }
    const roots = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.ProgramW6432,
    ].filter(Boolean)
    for (const r of roots) {
      for (const n of ['zcode.cjs', 'zcode.js']) {
        const hit = pick(path.join(r, 'ZCode', 'resources', 'glm', n))
        if (hit) return hit
      }
    }
    for (const raw of await regInstallLocations('ZCode')) {
      for (const dir of dirCandidates(raw)) {
        for (const n of ['zcode.cjs', 'zcode.js']) {
          const hit = pick(path.join(dir, 'resources', 'glm', n))
          if (hit) return hit
        }
      }
    }
  }
  return ''
}

// 非交互启动参数：部分 CLI 需要子命令；未在 PATH 时用绝对路径（.cjs 用 node 运行）
// codex 用 --json 输出结构化事件：只取思考过程与最终答复，屏蔽命令/日志等噪音
const AGENT_ARGS = {
  codex: 'exec --json --skip-git-repo-check -s workspace-write',
  zcode: '-p',
  opencode: 'run'
}
// Windows 版 codex 的 workspace-write 沙箱失效（写入一律按 read-only 拒绝），
// 而执行体必须能改任务文件，故 Windows 本机退化为 danger-full-access
function codexSandboxArgs(env, sid) {
  const windowsLocal = process.platform === 'win32' && env && env.kind === 'local'
  const mode = windowsLocal ? 'danger-full-access' : 'workspace-write'
  if (sid) {
    // resume 子命令不接受 -s，沙箱只能用 -c sandbox_mode=... 传入
    const cfg = env && env.kind === 'local' ? `-c sandbox_mode="${mode}"` : `-c ${posixQuote(`sandbox_mode="${mode}"`)}`
    return `exec resume ${sid} --json --skip-git-repo-check ${cfg}`
  }
  return `exec --json --skip-git-repo-check -s ${mode}`
}
function agentTmpl(agent, exe, env, model, extraArgs, sid, imagePaths) {
  const base = String(agent.cmd || agent.id || 'echo').trim()
  if (base.includes('{prompt}')) return base
  let args
  if (agent.id === 'codex') args = codexSandboxArgs(env, sid)
  else if (agent.id === 'opencode' && sid) args = `run --session ${env && env.kind === 'local' ? `"${sid}"` : posixQuote(sid)}`
  else args = AGENT_ARGS[agent.id] || ''
  const head = exe ? (/\.(c?js)$/i.test(exe) ? `node "${exe}"` : `"${exe}"`) : base
  const mArg = modelArgFor(agent, model, env)
  const extra = (extraArgs || []).filter(Boolean).join(' ')
  // codex 支持 -i 传图片；路径已转为执行环境内可读形式
  const imgs = (imagePaths || []).map((p) => env && env.kind === 'local'
    ? `-i "${String(p).replace(/"/g, '\\"')}"`
    : `-i ${posixQuote(p)}`).join(' ')
  const tail = [args, mArg, extra, imgs].filter(Boolean).join(' ')
  return tail ? `${head} ${tail} {prompt}` : head
}

// 各 CLI 指定模型的参数；仅收录已确认的非交互参数，未配置模型时不追加
const MODEL_FLAG = { opencode: '-m', codex: '--model' }
function modelArgFor(agent, model, env) {
  const m = String(model || '').trim()
  const flag = agent && MODEL_FLAG[agent.id]
  if (!m || !flag) return ''
  const local = !env || env.kind === 'local'
  return `${flag} ${local ? `"${m.replace(/"/g, '\\"')}"` : posixQuote(m)}`
}

// 启动命令首个 token，用于判断可执行文件是否存在
const SHELL_BUILTINS = new Set(['echo', 'cd', 'dir', 'type', 'set', 'export', 'sh', 'bash', 'cmd', 'powershell', 'pwsh'])
function commandName(tmpl) {
  const s = String(tmpl || '').trim()
  const m = s.match(/^"([^"]+)"|^'([^']+)'|^([^\s{]+)/)
  return m ? (m[1] || m[2] || m[3] || '') : ''
}

async function commandExists(cmd, cwd) {
  if (!cmd) return false
  if (/[\\/]/.test(cmd)) {
    try { return fs.existsSync(path.isAbsolute(cmd) ? cmd : path.resolve(cwd || '.', cmd)) } catch { return false }
  }
  const probe = process.platform === 'win32'
    ? `where "${cmd}"`
    : `command -v '${cmd.replace(/'/g, `'\\''`)}'`
  const out = await sh(probe, 5000)
  return !!(out && out.trim())
}

// Windows 命令行输出常为 GBK：UTF-8 严格解码失败时回退 GBK，并保留不完整的多字节尾部
function utf8TailStart(buf) {
  const n = buf.length
  let i = n - 1
  let back = 0
  while (i >= 0 && back < 4) {
    const b = buf[i]
    if ((b & 0xC0) === 0x80) { i -= 1; back += 1; continue }
    let need = 0
    if ((b & 0x80) === 0) need = 1
    else if ((b & 0xE0) === 0xC0) need = 2
    else if ((b & 0xF0) === 0xE0) need = 3
    else if ((b & 0xF8) === 0xF0) need = 4
    else return n
    return n - i < need ? i : n
  }
  return n
}

function makeDecoder() {
  let carry = Buffer.alloc(0)
  const decode = (buf) => {
    const all = carry.length ? Buffer.concat([carry, buf]) : buf
    const cut = utf8TailStart(all)
    carry = Buffer.from(all.subarray(cut))
    const head = all.subarray(0, cut)
    if (!head.length) return ''
    try { return new TextDecoder('utf-8', { fatal: true }).decode(head) }
    catch {
      try { return new TextDecoder('gbk').decode(head) } catch { return head.toString('utf8') }
    }
  }
  decode.flush = () => {
    if (!carry.length) return ''
    const b = carry
    carry = Buffer.alloc(0)
    try { return new TextDecoder('gbk').decode(b) } catch { return b.toString('utf8') }
  }
  return decode
}

const NOT_FOUND_RE = /不是内部或外部命令|is not recognized as an internal or external command|command not found|不是可运行的程序|No such file or directory/i

function closeError(code, output, name) {
  if (NOT_FOUND_RE.test(String(output || ''))) {
    return `未找到命令「${name}」，请确认已安装并在 PATH 中，或在「环境」中修改该执行体的启动命令。`
  }
  return `${name} 退出码 ${code}`
}
// 远端探测：CLI 常装在 ~/.local/bin、~/.opencode/bin、nvm 等目录，非交互 shell 的 PATH 往往缺失。
// 注意 1：WSL 的 wsl.exe 会丢弃形如 VAR=... 的独立赋值语句，故统一用 env PATH=... sh -c。
// 注意 2：WSL 桥接的 PATH 含 Windows 路径（如 Program Files (x86)），赋值必须加引号，否则 dash 语法报错。
const REMOTE_AUG_PATH = [
  '$HOME/.local/bin', '$HOME/.npm-global/bin', '$HOME/.opencode/bin', '$HOME/.bun/bin',
  '$HOME/.volta/bin', '$HOME/.cargo/bin', '$HOME/.deno/bin', '$HOME/.local/share/pnpm',
  "$(ls -d $HOME/.nvm/versions/node/*/bin $HOME/.local/share/fnm/node-versions/*/installation/bin 2>/dev/null | tr '\\n' ':')",
  '/usr/local/bin', '$PATH'
].join(':')
function remoteDetectCmd() {
  const checks = KNOWN_AGENTS.map((a) => `{ ${a.cmd} --version >/dev/null 2>&1 && echo ${a.id}; }`).join('; ')
  return `env PATH="${REMOTE_AUG_PATH}" sh -c ${JSON.stringify(checks)}`
}
// POSIX 单引号转义
function posixQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}
// 用补全后的 PATH 执行一条远端命令（WSL / SSH）；extra: [[key, value]] 额外环境变量
function envPathShell(cmd, extra) {
  const kv = (extra || []).map(([k, v]) => `${k}=${posixQuote(v)}`).join(' ')
  return `env PATH="${REMOTE_AUG_PATH}"${kv ? ' ' + kv : ''} sh -c ${posixQuote(cmd)}`
}
// 直接调用 wsl.exe（execFile 传参，绕过 cmd.exe 对引号/$ 的二次解析）
function wslOut(distro, script, timeoutMs) {
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-d', distro, '--', 'sh', '-c', script], { timeout: timeoutMs || 25000, windowsHide: true }, (err, stdout) => resolve(String(stdout || '')))
  })
}

async function detectAgents(env, force) {
  const key = env.kind === 'wsl' ? `wsl:${env.distro}`
    : env.kind === 'ssh' ? `ssh:${env.id || `${(env.config && env.config.user) || ''}@${env.host || (env.config && env.config.host)}:${(env.config && env.config.port) || 22}`}`
      : 'local'
  const hit = detectCache.get(key)
  if (!force && hit && Date.now() - hit.at < 60000) return hit.ids
  let ids = []
  try {
    if (env.kind === 'local') {
      // 并行探测，避免逐个 --version 串行拖慢任务信息页
      const found = await Promise.all(KNOWN_AGENTS.map(async (a) => {
        const base = a.cmd || a.id
        if (await commandExists(base)) {
          // 找到不代表能跑（npm shim 可能指向缺失的二进制），用 --version 验证
          const ver = await sh(`"${base}" --version`, 5000)
          return ver && ver.trim() ? a.id : null
        }
        // PATH 上没有：查应用内自装 / GUI 应用随附 CLI 的常见位置
        const exe = await findAgentExe(a.id)
        if (!exe) return null
        const probe = /\.(c?js)$/i.test(exe) ? `node "${exe}" --version` : `"${exe}" --version`
        const ver = await sh(probe, 12000)
        return ver && ver.trim() ? a.id : null
      }))
      ids = found.filter(Boolean)
    } else if (env.kind === 'wsl') {
      const out = await wslOut(env.distro, remoteDetectCmd(), 25000)
      if (out) for (const a of KNOWN_AGENTS) if (out.split(/\s+/).includes(a.id)) ids.push(a.id)
    } else if (env.kind === 'ssh') {
      const { runRemote } = require('./sshconn')
      const r = await runRemote(env, env.secret || '', remoteDetectCmd(), 30000)
      if (r.stdout) for (const a of KNOWN_AGENTS) if (r.stdout.split(/\s+/).includes(a.id)) ids.push(a.id)
    }
  } catch {}
  detectCache.set(key, { at: Date.now(), ids })
  return ids
}

function killTree(child) {
  if (!child || child.killed) return
  try {
    // 远程 ssh2 适配对象没有真实 pid，直接走它的 kill
    if (typeof child.pid === 'number' && child.pid < 0 && typeof child.kill === 'function') { child.kill(); return }
    if (process.platform === 'win32') {
      const { exec } = require('child_process')
      exec(`taskkill /pid ${child.pid} /T /F`, () => {})
    } else child.kill('SIGKILL')
  } catch {}
}

// 统一入口：返回 { kill }
async function runAgent(opts) {
  const { task, agent } = opts
  // 优先使用主进程解析好的环境（含 ssh 的 host/secret/unixPath）；否则按路径推断
  const env = opts.env || resolveEnv(task.path, agent)

  // Claude Code：stdin 传 prompt，stream-json 流式解析，按任务记忆会话 id
  if (agent.id === 'claude-code') return runClaude({ ...opts, env })

  // 通用 CLI：模板 {prompt} 或 追加参数
  return runGeneric({ task, agent, prompt: opts.prompt, model: opts.model, envVars: opts.envVars, extraArgs: opts.extraArgs, meta: opts.meta, onMeta: opts.onMeta, attachments: opts.attachments, onDelta: opts.onDelta, onThinking: opts.onThinking, onStep: opts.onStep, onPlan: opts.onPlan, onDone: opts.onDone, onError: opts.onError, env })
}

// 方案路径（WSL UNC / ssh://）-> 执行环境内可直接读取的 posix 路径
function toEnvPath(env, p) {
  const s = String(p || '')
  if (env && env.kind === 'wsl') {
    const m = s.match(/^\\\\wsl(?:\.localhost|\$)?\\[^\\]+\\(.*)$/i)
    return m ? '/' + m[1].replace(/\\/g, '/') : s
  }
  if (env && env.kind === 'ssh') {
    const m = s.match(/^ssh:\/\/[^/]+(\/.*)$/i)
    return m ? m[1] : s
  }
  return s
}

// Skills 清单（只给名称/描述/路径，按需读取，省 token）
function skillsPrompt(selection, env) {
  const lines = (selection && selection.skills || []).map((s) => {
    const desc = String(s.description || '').replace(/\s+/g, ' ').slice(0, 160)
    return `- ${s.name}: ${desc || '(无描述)'} | 文件: ${toEnvPath(env, s.path)}`
  })
  if (!lines.length) return ''
  return ('可用 Skills（相关时先读对应 SKILL.md 再执行）：\n' + lines.join('\n')).slice(0, 4000)
}

// 把任务选中的 MCP / Skills 注入 claude（本机 / WSL / SSH 都支持）
async function prepareInjection(task, env, selection, systemExtra) {
  const out = { args: [], note: '', skillText: '' }
  if (!selection) return out

  // MCP：写任务级 .zzwork/mcp.json，并只在本次会话生效
  const servers = {}
  for (const m of selection.mcps || []) {
    let cfg = {}
    try { cfg = JSON.parse(m.config || '{}') } catch {}
    if (m.type === 'http' || m.type === 'sse') {
      if (cfg.url) servers[m.name] = { type: 'http', url: cfg.url, headers: cfg.headers || undefined }
    } else {
      const parts = commandParts(cfg.command || '')
      if (parts.length) {
        servers[m.name] = {
          command: parts[0],
          args: [...parts.slice(1), ...(Array.isArray(cfg.args) ? cfg.args : [])],
          env: cfg.env || undefined,
          cwd: cfg.cwd || undefined,
        }
      }
    }
  }
  try {
    const content = JSON.stringify({ mcpServers: servers }, null, 2)
    if (env.kind === 'ssh') {
      const root = String(env.unixPath || '').replace(/\/+$/, '') || '/'
      const argPath = (root === '/' ? '' : root) + '/.zzwork/mcp.json'
      await require('../../main/services/remotefs').writeFile(env.id, argPath, content)
      out.args.push('--mcp-config', argPath, '--strict-mcp-config')
    } else {
      const dir = path.join(task.path, '.zzwork')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'mcp.json'), content)
      let argPath = path.join(dir, 'mcp.json')
      if (env.kind === 'wsl') {
        const m = task.path.match(/^\\\\wsl(?:\.localhost|\$)?\\[^\\]+\\(.*)$/i)
        if (m) argPath = '/' + m[1].replace(/\\/g, '/') + '/.zzwork/mcp.json'
      } else {
        argPath = argPath.replace(/\\/g, '/')
      }
      out.args.push('--mcp-config', argPath, '--strict-mcp-config')
    }
  } catch (e) {
    out.note = 'MCP 配置写入失败: ' + e.message
  }

  out.skillText = skillsPrompt(selection, env)
  const sysParts = [systemExtra, out.skillText].filter(Boolean)
  if (sysParts.length) out.args.push('--append-system-prompt', sysParts.join('\n\n').slice(0, 8000))
  return out
}

// 把 zzwork 选中的 provider env 写成临时 settings 文件，经 --settings 注入 claude，
// 覆盖用户级 ~/.claude/settings.json（如 cc-switch 代理）——--settings 优先级更高。
// 注意：该文件含明文 token，且 --settings 必须用它才能压过用户全局配置（env 会被 settings 覆盖、
// 且 settings 的 env 值不支持 ${VAR} 插值），所以无法完全去掉；但绝不能落在可随任务拷贝的
// .zzwork 目录里。改为写到所在环境的私有临时目录，回合结束即删。
// 返回 { argPath, cleanup } 或 null。
async function writeClaudeSettings(task, env, envVars) {
  const content = JSON.stringify({ env: envVars || {} }, null, 2)
  const name = 'zzwork-claude-settings-' + process.pid + '-' + Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8) + '.json'
  try {
    if (env.kind === 'ssh') {
      const argPath = '/tmp/' + name
      const rf = require('../../main/services/remotefs')
      await rf.writeFile(env.id, argPath, content)
      return { argPath, cleanup: () => { try { Promise.resolve(rf.remove(env.id, argPath)).catch(() => {}) } catch {} } }
    }
    if (env.kind === 'wsl') {
      // 写进 WSL 的 /tmp（经 \\wsl$\<distro>\tmp UNC 路径），claude 用 /tmp/xxx 读取
      const d = String(task.path || '').match(/^\\\\wsl(?:\$|\.localhost)?\\([^\\]+)\\/i)
      if (!d) return null
      const winDir = '\\\\wsl$\\' + d[1] + '\\tmp'
      const winPath = path.join(winDir, name)
      fs.writeFileSync(winPath, content)
      return { argPath: '/tmp/' + name, cleanup: () => { try { fs.unlinkSync(winPath) } catch {} } }
    }
    // Windows 本机：写到系统临时目录（非任务目录），正斜杠路径传给 claude
    const dir = path.join(os.tmpdir(), 'zzwork-claude-settings')
    fs.mkdirSync(dir, { recursive: true })
    const winPath = path.join(dir, name)
    fs.writeFileSync(winPath, content, { mode: 0o600 })
    const argPath = winPath.replace(/\\/g, '/')
    return { argPath, cleanup: () => { try { fs.unlinkSync(winPath) } catch {} } }
  } catch {
    return null
  }
}

// 旧版本会把这些文件写进任务的 .zzwork 目录（可随任务拷贝），这里顺手清掉遗留明文
function cleanupLegacyClaudeSettings(task, env) {
  try {
    if (env.kind === 'ssh') {
      const root = String(env.unixPath || '').replace(/\/+$/, '') || '/'
      Promise.resolve(require('../../main/services/remotefs').remove(env.id, (root === '/' ? '' : root) + '/.zzwork/claude-settings.json')).catch(() => {})
      return
    }
    const p = path.join(task.path, '.zzwork', 'claude-settings.json')
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {}
}

// 工具调用的一行摘要：优先展示命令/文件等最有信息量的字段
function toolInputDetail(input) {
  const inp = input || {}
  const s = inp.command || inp.file_path || inp.path || inp.pattern || inp.query || inp.url
    || inp.description || inp.prompt || inp.skill || ''
  return String(s).replace(/\s+/g, ' ').slice(0, 160)
}

// 计划（TodoWrite / todo_list）→ 统一条目：{ id, text, status: pending|in_progress|completed }
function normalizePlan(raw) {
  if (!Array.isArray(raw) || !raw.length) return null
  const out = []
  raw.forEach((t, i) => {
    if (!t || typeof t !== 'object') return
    const text = String(t.content || t.activeForm || t.text || t.subject || '').trim()
    if (!text) return
    const s = String(t.status || (t.completed ? 'completed' : 'pending')).toLowerCase()
    const status = s === 'completed' ? 'completed'
      : (s === 'in_progress' || s === 'in-progress' || s === 'inprogress' || s === 'running') ? 'in_progress'
      : 'pending'
    out.push({ id: String(t.id != null ? t.id : i), text, status })
  })
  return out.length ? out : null
}

function toolResultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((x) => (x && (x.text || x.content)) || '').filter(Boolean).join('\n')
  }
  return ''
}

async function runClaude({ task, prompt, meta, selection, systemExtra, model, envVars, onMeta, onDelta, onThinking, onStep, onPlan, onDone, onError, env, onAsk, onShell, attachments }) {
  const sidKey = 'sid:claude-code'
  const sid = (meta || {})[sidKey]
  // --include-partial-messages：thinking/text 按增量下发，过程能实时显示
  // --input-format stream-json + --permission-prompt-tool stdio：双向控制通道，
  //   让 AskUserQuestion 等需要"询问用户"的工具通过 stdin/stdout 的 control_request 往返
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default']
  if (model) args.push('--model', String(model))
  if (env.kind !== 'local') {
    try {
      const { syncSkillsToEnv } = require('./envs')
      const dirs = (selection && selection.skills || []).map((x) => require('path').dirname(x.path)).filter((d) => require('fs').existsSync(d))
      const r = await syncSkillsToEnv(env, dirs)
      if (r && !r.ok) onDelta && onDelta('[zzwork] skill 同步失败: ' + r.error + '\n')
    } catch (e) { onDelta && onDelta('[zzwork] skill 同步异常: ' + e.message + '\n') }
  }
  const inj = await prepareInjection(task, env, selection, systemExtra)
  const injArgs = inj.args.slice()
  // claude 2.1.x：--append-system-prompt 与 --resume 同时出现会 fork 出新会话、丢掉历史。
  // 续接回合把系统附加内容并入用户消息，首轮仍走 --append-system-prompt（建会话时带上）
  let resumeSystemText = ''
  if (sid) {
    const ai = injArgs.indexOf('--append-system-prompt')
    if (ai >= 0 && ai + 1 < injArgs.length) { resumeSystemText = injArgs[ai + 1]; injArgs.splice(ai, 2) }
  }
  if (injArgs.length) args.push(...injArgs)
  if (inj.note) onDelta && onDelta(`[zzwork] ${inj.note}\n`)
  // 用 zzwork 选中的 provider 覆盖用户级 settings（--settings 优先级高于 ~/.claude/settings.json）
  let cleanupSettings = null
  if (envVars && envVars.ANTHROPIC_BASE_URL) {
    cleanupLegacyClaudeSettings(task, env)
    const sp = await writeClaudeSettings(task, env, envVars)
    if (sp) { args.push('--settings', sp.argPath); cleanupSettings = sp.cleanup }
  }
  if (sid) args.push('--resume', sid)

  let child, carry = ''
  let partialSeen = false
  const askInputs = new Map() // request_id -> AskUserQuestion 原始 input（回答时并回 updatedInput）
  // 权限控制响应：写回 control_response，resolve 该 can_use_tool 请求
  const writeControl = (requestId, response) => {
    try {
      child.stdin.write(JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response }
      }) + '\n')
    } catch {}
  }
  const emitStep = (id, patch) => {
    if (!id || !onStep) return
    onStep({ id, ...patch })
  }
  const handleLine = (line) => {
    line = line.trim(); if (!line) return
    let ev; try { ev = JSON.parse(line) } catch { onDelta(line + '\n'); return }
    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      onMeta && onMeta(sidKey, ev.session_id)
    } else if (ev.type === 'stream_event' && ev.event) {
      partialSeen = true
      const e = ev.event
      if (e.type === 'content_block_delta') {
        const d = e.delta || {}
        if (d.type === 'thinking_delta' && d.thinking) onThinking && onThinking(d.thinking)
        else if (d.type === 'text_delta' && d.text) onDelta && onDelta(d.text)
      } else if (e.type === 'content_block_start') {
        const cb = e.content_block || {}
        if (cb.type === 'tool_use') {
          if (cb.name === 'TodoWrite') {
            const plan = normalizePlan(cb.input && cb.input.todos)
            if (plan && onPlan) onPlan(plan)
          } else emitStep(cb.id || ('tool-' + e.index), { name: cb.name || '工具', detail: toolInputDetail(cb.input), input: cb.input, status: 'running' })
        }
      }
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        // 有 partial 流时以增量为准，整块内容只用来补齐工具调用参数
        if (c.type === 'thinking' && c.thinking) { if (!partialSeen) onThinking && onThinking(c.thinking) }
        else if (c.type === 'text' && c.text) { if (!partialSeen) onDelta && onDelta(c.text) }
        else if (c.type === 'tool_use') {
          if (c.name === 'TodoWrite') {
            const plan = normalizePlan(c.input && c.input.todos)
            if (plan && onPlan) onPlan(plan)
          } else {
            emitStep(c.id, { name: c.name || '工具', detail: toolInputDetail(c.input), input: c.input, status: 'running' })
            // 后台命令（run_in_background）：记入会话的后台 shell 列表
            const inp = c.input || {}
            if (onShell && c.name === 'Bash' && inp.run_in_background) {
              onShell({
                id: 'sh-' + c.id, toolId: c.id, command: String(inp.command || ''),
                cwd: String(inp.cwd || ''), status: 'running', at: Date.now(),
                pid: (child && child.pid) || null
              })
            }
          }
        }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'tool_result') {
          const txt = toolResultText(c.content)
          emitStep(c.tool_use_id, { status: c.is_error ? 'error' : 'done', output: txt })
          if (onShell) {
            const m = /background with ID[:\s]+([A-Za-z0-9_-]+)/i.exec(txt)
            if (m) {
              onShell({
                id: 'sh-' + c.tool_use_id, shellId: m[1],
                status: c.is_error ? 'error' : 'running', output: txt.slice(0, 2000), at: Date.now()
              })
            }
          }
        }
      }
    } else if (ev.type === 'control_request') {
      const req = ev.request || {}
      if (req.subtype !== 'can_use_tool') return
      const rid = ev.request_id
      if (req.tool_name === 'AskUserQuestion') {
        if (!onAsk) { writeControl(rid, { behavior: 'deny', message: '当前无交互界面，无法询问用户。' }); return }
        askInputs.set(rid, req.input || {})
        onAsk({ requestId: rid, input: req.input || {} })
      } else {
        // 其余工具沿用原有"直接放行"行为，避免打断执行
        writeControl(rid, { behavior: 'allow', updatedInput: req.input || {} })
      }
    } else if (ev.type === 'result') {
      if (ev.session_id) onMeta && onMeta(sidKey, ev.session_id)
      // result 是最后一帧；在此收尾，避免 close 时再回调一次 onDone（重复落库）
      finish(null, ev.result || '')
    }
  }

  const extraEnv = Object.entries(envVars || {})
  if (env.kind === 'wsl') {
    const line = envPathShell(`claude ${args.map(posixQuote).join(' ')}`, extraEnv)
    child = spawn('wsl.exe', ['-d', env.distro, '--cd', env.unixPath, '--', 'sh', '-c', line], { windowsHide: true })
  } else if (env.kind === 'ssh') {
    const { spawnRemote } = require('./sshconn')
    const cd = env.unixPath || task.path
    child = spawnRemote(env, env.secret || '', `cd ${posixQuote(cd)} && ` + envPathShell(`claude ${args.map(posixQuote).join(' ')}`, extraEnv))
  } else {
    // Windows 本机：npm shim 需要走 shell；stdin 传 prompt 避开引号地狱
    const childEnv = { ...process.env, ...(envVars || {}) }
    const gitBash = detectGitBash()
    if (gitBash && !childEnv.CLAUDE_CODE_GIT_BASH_PATH) childEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBash
    child = spawnCommand('claude', args, { cwd: task.path, windowsHide: true, env: childEnv })
  }

  let finished = false
  let errAcc = ''
  const decOut = makeDecoder()
  const decErr = makeDecoder()
  const finish = (err, result) => {
    if (finished) return; finished = true
    try { child.stdin.end() } catch {}
    try { cleanupSettings && cleanupSettings() } catch {}
    if (err) onError && onError(err); else onDone && onDone(result || '')
  }
  child.stdout.on('data', (b) => {
    carry += decOut(b)
    const lines = carry.split('\n'); carry = lines.pop()
    lines.forEach(handleLine)
  })
  // stderr 多为诊断信息，不实时贴进对话，失败时并入错误提示
  child.stderr.on('data', (b) => { errAcc += decErr(b) })
  child.on('error', (e) => finish(`无法启动 claude（${e.message}）。请确认已安装并在 PATH 中。`))
  child.on('close', (code) => {
    carry += decOut.flush()
    const tail = decErr.flush()
    if (tail) errAcc += tail
    if (carry) handleLine(carry)
    if (!finished) finish(code === 0 ? null : closeError(code, errAcc, 'claude'))
  })
  // 双向 stream-json：以 user 帧写 prompt，stdin 保持打开以接收权限控制响应；
  // 回合结束时由 finish() 关闭 stdin，进程随之退出。图片以 base64 内容块随帧下发（local/WSL/SSH 通用）
  const effPrompt = resumeSystemText ? (resumeSystemText + '\n\n' + (prompt || '')) : prompt
  const content = effPrompt ? [{ type: 'text', text: effPrompt }] : []
  for (const a of attachments || []) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(String(a.dataUrl || ''))
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
  }
  if (!content.length) content.push({ type: 'text', text: '' })
  const userFrame = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
  child.stdin.write(JSON.stringify(userFrame) + '\n')
  return {
    kill: () => killTree(child),
    child,
    // 回答某次 AskUserQuestion（answers 为 null 表示用户取消/拒绝）
    answer: (requestId, answers) => {
      const orig = askInputs.get(requestId) || {}
      askInputs.delete(requestId)
      if (answers == null) writeControl(requestId, { behavior: 'deny', message: '用户取消了该提问', interrupt: false })
      else writeControl(requestId, { behavior: 'allow', updatedInput: { ...orig, answers } })
    }
  }
}

// 去掉 ANSI 颜色/控制序列（opencode 等 CLI 的彩色输出）；跨块保留未完成的转义
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g
function ansiFilter() {
  let rem = ''
  return {
    push(text) {
      let s = rem + text
      const m = s.match(/\x1b(\[[0-9;?]*[ -\/]*)?$/)
      if (m) { rem = m[0]; s = s.slice(0, s.length - m[0].length) } else rem = ''
      return s.replace(ANSI_RE, '')
    },
    flush() { const r = rem; rem = ''; return r.replace(ANSI_RE, '') }
  }
}

async function runGeneric({ task, agent, prompt, model, envVars, extraArgs, meta, onMeta, attachments, onDelta, onThinking, onStep, onPlan, onDone, onError, env }) {
  // 会话续接：sid 取自会话 meta（sid:<agent.id>），校验形状并防止命令行注入
  const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
  const rawSid = String((meta || {})['sid:' + agent.id] || '').trim()
  const sid = SID_RE.test(rawSid) ? rawSid : ''
  // 图片附件路径转为执行环境内可读形式（codex -i 用；其余执行体走文本后缀兜底）
  const imagePaths = (attachments || []).filter((a) => a && a.path).map((a) => toEnvPath(env, a.path))
  // 模板支持 {prompt}；没有占位符则把 prompt 作为尾参追加
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`
  // 远端 shell 用单引号，避免 $、反引号被展开
  const qPrompt = env.kind === 'local' ? q : posixQuote
  const extraEnv = Object.entries(envVars || {})
  let tmpl = agent.cmd || 'echo'
  const customPromptTmpl = tmpl.includes('{prompt}')
  if (!customPromptTmpl) {
    // 本机找不到命令时回退到常见安装位置；codex/zcode 等补上非交互子命令
    let exe = ''
    if (env.kind === 'local' && !(await commandExists(commandName(tmpl)))) exe = await findAgentExe(agent.id)
    tmpl = agentTmpl(agent, exe, env, model, extraArgs, sid, imagePaths)
  }
  // 不支持图片参数的执行体（含自定义 {prompt} 的 codex）：把图片路径附在 prompt 末尾
  let promptText = prompt
  const argsHasImages = agent.id === 'codex' && !customPromptTmpl
  if (imagePaths.length && !argsHasImages) {
    promptText += '\n\n---\n【图片附件（请用文件读取工具打开）】\n' + imagePaths.map((p) => '- ' + p).join('\n')
  }
  // Windows 本地经 cmd.exe（shell:true）传参，带换行的参数会被截断到首个换行处，
  // 导致 [工作区变更摘要] / 上下文历史等前缀之后的真正指令丢失（进一步压缩成首行）。
  const shellPrompt = env.kind === 'local' && process.platform === 'win32'
    ? promptText.replace(/\r?\n/g, '  ')
    : promptText
  const cmdLine = tmpl.includes('{prompt}')
    ? tmpl.replace(/\{prompt\}/g, () => qPrompt(shellPrompt))
    : `${tmpl} ${qPrompt(shellPrompt)}`
  const cmdName = commandName(tmpl)

  // 本机：先确认命令存在，给出可读提示而不是 shell 噪音 + 退出码
  if (env.kind === 'local' && cmdName && !SHELL_BUILTINS.has(cmdName.toLowerCase())) {
    const ok = await commandExists(cmdName, task.path)
    if (!ok) {
      onError && onError(`未找到命令「${cmdName}」，请确认 ${agent.name} 已安装并在 PATH 中，或在「环境」中修改该执行体的启动命令。`)
      return { kill: () => {}, child: null }
    }
  }

  let child
  if (env.kind === 'wsl') {
    child = spawn('wsl.exe', ['-d', env.distro, '--cd', env.unixPath, '--', 'sh', '-c', envPathShell(cmdLine, extraEnv)], { windowsHide: true })
  } else if (env.kind === 'ssh') {
    const { spawnRemote } = require('./sshconn')
    const cd = env.unixPath || task.path
    child = spawnRemote(env, env.secret || '', `cd ${posixQuote(cd)} && ` + envPathShell(cmdLine, extraEnv))
  } else {
    child = spawn(cmdLine, { shell: true, cwd: task.path, windowsHide: true, env: { ...process.env, ...(envVars || {}) } })
  }
  // 部分 CLI（如 codex exec）会等待 stdin EOF 才结束，非交互场景直接关闭
  try { child.stdin && child.stdin.end() } catch {}

  // codex --json：逐行解析结构化事件，只展示思考过程与最终答复，屏蔽命令/日志噪音
  const jsonMode = agent.id === 'codex'
  const items = new Map()
  let carry = ''
  let failMsg = ''
  let errTail = ''
  const itemText = (item) => {
    if (!item) return ''
    if (item.type === 'reasoning') {
      if (typeof item.text === 'string' && item.text) return item.text
      const sum = Array.isArray(item.summary) ? item.summary : []
      return sum.map((s) => (s && (s.text || s.text_summary)) || '').filter(Boolean).join('\n')
    }
    return typeof item.text === 'string' ? item.text : ''
  }
  // 命令 / MCP / 搜索等作为「运行过程」的一行，不带输出内容
  const itemStep = (item, status) => {
    const t = item && item.type
    let name = '', detail = ''
    if (t === 'command_execution') { name = '命令'; detail = item.command || '' }
    else if (t === 'mcp_tool_call') { name = 'MCP'; detail = item.tool || item.name || (item.server ? `${item.server}:${item.tool || ''}` : '') }
    else if (t === 'web_search') { name = '搜索'; detail = item.query || '' }
    else if (t === 'file_change') {
      name = '文件变更'
      detail = (Array.isArray(item.changes) ? item.changes : []).map((c) => c && c.path).filter(Boolean).join(', ')
    } else if (t === 'collab_tool_call') { name = '子代理'; detail = item.prompt || '' }
    else return null
    const st = { id: item.id, status }
    if (name) st.name = name
    if (detail) st.detail = String(detail).replace(/\s+/g, ' ').slice(0, 160)
    // 完整命令/输出尽力而为（仅用于落盘，渲染只取 detail/status）
    if (t === 'command_execution') {
      st.input = { command: item.command || '' }
      if (item.cwd) st.input.cwd = item.cwd
      const o = item.aggregated_output != null ? item.aggregated_output : item.output
      if (o != null && o !== '') st.output = typeof o === 'string' ? o : String(o)
    }
    return st
  }
  const handleJsonLine = (line) => {
    line = line.trim()
    if (!line) return
    let ev; try { ev = JSON.parse(line) } catch { return }
    const t = ev.type
    if (t === 'thread.started') {
      // codex 首个事件带会话 id；落库后下次同执行体走 resume 原生续接
      const tid = ev.thread_id || ev.threadId
      if (tid && onMeta) onMeta('sid:' + agent.id, String(tid))
      return
    }
    if (t === 'item.started' || t === 'item.updated' || t === 'item.completed') {
      const item = ev.item || {}
      if (item.type === 'todo_list' || item.type === 'plan' || item.type === 'update_plan') {
        const plan = normalizePlan(item.items || item.todos || item.plan)
        if (plan && onPlan) onPlan(plan)
        return
      }
      if (item.type === 'reasoning' || item.type === 'agent_message') {
        const text = itemText(item)
        const key = String(item.id || item.type)
        const prev = items.get(key) || ''
        if (!text || text === prev || prev.startsWith(text)) return
        items.set(key, text)
        // 事件中的文本是累计值：只追加增量，避免重复
        const add = text.startsWith(prev) ? text.slice(prev.length) : (prev ? '\n' : '') + text
        if (!add) return
        if (item.type === 'reasoning') onThinking && onThinking(add)
        else { out += add; onDelta && onDelta(add) }
        return
      }
      const failed = item.exit_code != null && item.exit_code !== 0
      const st = itemStep(item, t === 'item.completed' ? (failed ? 'error' : 'done') : 'running')
      if (st && onStep) onStep(st)
      return
    }
    if (t === 'turn.failed') failMsg = (ev.error && (ev.error.message || ev.error.text)) || '执行失败'
    else if (t === 'error' || t === 'stream_error') failMsg = ev.message || '执行失败'
  }

  let out = '', finished = false
  let errOut = ''
  let ocSidSeen = !!sid // 已续接的不再重复捕获
  const decOut = makeDecoder()
  const decErr = makeDecoder()
  const cleanOut = ansiFilter()
  const cleanErr = ansiFilter()
  const finish = (err) => {
    if (finished) return; finished = true
    if (failMsg) { onError && onError(failMsg); return }
    err ? (onError && onError(err)) : (onDone && onDone(out))
  }
  child.stdout.on('data', (b) => {
    if (!jsonMode) {
      const s = cleanOut.push(decOut(b)); out += s; onDelta && onDelta(s)
      // opencode 会话 id 尽力而为：从输出里嗅探一次，命中则下次续接（未实测，捕获不到就回退纯文本历史）
      if (agent.id === 'opencode' && onMeta && !ocSidSeen) {
        const m = String(s).match(/\bses_[A-Za-z0-9]{8,}\b/)
        if (m) { ocSidSeen = true; onMeta('sid:opencode', m[0]) }
      }
      return
    }
    carry += decOut(b)
    const lines = carry.split('\n'); carry = lines.pop()
    lines.forEach(handleJsonLine)
  })
  child.stderr.on('data', (b) => {
    const s = cleanErr.push(decErr(b))
    // 诊断日志（进度/警告）不往对话里贴，仅在失败时并入错误信息
    if (jsonMode) { errTail = (errTail + s).slice(-2000); return }
    errOut = (errOut + s).slice(-8000)
  })
  child.on('error', (e) => finish(`无法启动 ${agent.name}（${e.message}）`))
  child.on('close', (code) => {
    const to = decOut.flush()
    if (to) {
      if (jsonMode) { carry += to; if (carry) handleJsonLine(carry) }
      else { const s = cleanOut.push(to); out += s; onDelta && onDelta(s) }
    }
    const te = decErr.flush()
    if (te) {
      const s = cleanErr.push(te)
      if (jsonMode) errTail = (errTail + s).slice(-2000)
      else errOut = (errOut + s).slice(-8000)
    }
    // 有些 CLI 正常退出时只把答复写到 stderr
    if (!jsonMode && !out.trim() && errOut.trim()) { out = errOut; onDelta && onDelta(errOut) }
    finish(code === 0 ? null : closeError(code, jsonMode ? (errTail || out) : (errOut || out), cmdName || agent.name))
  })
  return { kill: () => killTree(child), child }
}

module.exports = { runAgent, resolveEnv, detectAgents, clearDetectCache, KNOWN_AGENTS, prepareInjection, envPathShell }
