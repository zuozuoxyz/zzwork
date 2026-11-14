// zzwork 执行体运行器：在任务文件所在环境（本机/WSL/SSH）拉起 CLI agent 并流式回传
const { spawn, exec } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { splitCommand, spawnCommand, commandParts } = require('./mcpTest')

// 已知 CLI 智能体（在任务所在环境检测是否安装）
// homeDir: 额外的安装痕迹目录（相对 home），PATH 找不到时兜底
const KNOWN_AGENTS = [
  { id: 'claude-code', name: 'Claude Code', cmd: 'claude', homeDir: '.claude' },
  { id: 'zcode', name: 'zcode', cmd: 'zcode', homeDir: '.zcode' },
  { id: 'codex', name: 'OpenAI Codex', cmd: 'codex', homeDir: '.codex' },
  { id: 'cursor-agent', name: 'Cursor Agent', cmd: 'cursor-agent' },
  { id: 'copilot', name: 'Copilot CLI', cmd: 'copilot' },
  { id: 'opencode', name: 'opencode', cmd: 'opencode' },
  { id: 'gemini', name: 'Gemini CLI', cmd: 'gemini', homeDir: '.gemini' },
  { id: 'qwen', name: 'Qwen Code', cmd: 'qwen' },
  { id: 'crush', name: 'Crush', cmd: 'crush' },
  { id: 'amp', name: 'Amp', cmd: 'amp' },
  { id: 'kimi', name: 'Kimi', cmd: 'kimi' },
]

// 识别任务路径所在环境
function resolveEnv(taskPath, agent) {
  const m = (taskPath || '').match(/^\\\\wsl(?:\.localhost|\$)?\\([^\\]+)\\(.*)$/i)
  if (m) return { kind: 'wsl', distro: m[1], unixPath: '/' + m[2].replace(/\\/g, '/') }
  if (agent.where === 'ssh' && agent.host) return { kind: 'ssh', host: agent.host }
  return { kind: 'local' }
}

// ---- 安装检测（结果缓存 60s / 环境）----
const detectCache = new Map()
function sh(cmd, timeoutMs) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs || 6000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout))
  })
}
async function detectAgents(env) {
  const key = env.kind === 'wsl' ? `wsl:${env.distro}` : env.kind === 'ssh' ? `ssh:${env.host}` : 'local'
  const hit = detectCache.get(key)
  if (hit && Date.now() - hit.at < 60000) return hit.ids
  let ids = []
  try {
    if (env.kind === 'local') {
      const home = os.homedir()
      for (const a of KNOWN_AGENTS) {
        let ok = false
        const out = await sh(process.platform === 'win32' ? `where ${a.cmd}` : `which ${a.cmd}`)
        if (out && out.trim()) {
          // 找到不代表能跑（npm shim 可能指向缺失的二进制），用 --version 验证
          const ver = await sh(`"${a.cmd}" --version`, 5000)
          ok = !!(ver && ver.trim())
        }
        // PATH 失败时看安装痕迹目录（如 zcode 的 ~/.zcode）
        if (!ok && a.homeDir) {
          try { ok = fs.existsSync(path.join(home, a.homeDir)) } catch {}
        }
        if (ok) ids.push(a.id)
      }
    } else if (env.kind === 'wsl') {
      const checks = KNOWN_AGENTS.map((a) => {
        const v = a.homeDir ? ` || [ -d "$HOME/${a.homeDir}" ]` : ''
        return `(which ${a.cmd} >/dev/null 2>&1 && ${a.cmd} --version >/dev/null 2>&1${v}) && echo ${a.id}`
      }).join('; ')
      const out = await sh(`wsl.exe -d ${env.distro} -- sh -lc ${JSON.stringify(checks)}`, 25000)
      if (out) for (const a of KNOWN_AGENTS) if (out.split(/\s+/).includes(a.id)) ids.push(a.id)
    } else if (env.kind === 'ssh') {
      const checks = KNOWN_AGENTS.map((a) => {
        const v = a.homeDir ? ` || [ -d "$HOME/${a.homeDir}" ]` : ''
        return `(which ${a.cmd} >/dev/null 2>&1 && ${a.cmd} --version >/dev/null 2>&1${v}) && echo ${a.id}`
      }).join('; ')
      const host = env.host || (env.config && env.config.host)
      const out = await sh(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${host} ${JSON.stringify(checks)}`, 25000)
      if (out) for (const a of KNOWN_AGENTS) if (out.split(/\s+/).includes(a.id)) ids.push(a.id)
    }
  } catch {}
  detectCache.set(key, { at: Date.now(), ids })
  return ids
}

function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32') {
      const { exec } = require('child_process')
      exec(`taskkill /pid ${child.pid} /T /F`, () => {})
    } else child.kill('SIGKILL')
  } catch {}
}

// 统一入口：返回 { kill }
async function runAgent(opts) {
  const { task, agent } = opts
  const env = resolveEnv(task.path, agent)

  // Claude Code：stdin 传 prompt，stream-json 流式解析，按任务记忆会话 id
  if (agent.id === 'claude-code') return runClaude(opts)

  // 通用 CLI：模板 {prompt} 或 追加参数
  return runGeneric({ task, agent, prompt: opts.prompt, onDelta: opts.onDelta, onDone: opts.onDone, onError: opts.onError, env })
}

// 把任务选中的 MCP / Skills 注入 claude
function prepareInjection(task, env, selection, systemExtra) {
  const out = { args: [], note: '' }
  if (!selection || env.kind === 'ssh') return out

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
    const dir = path.join(task.path, '.zzwork')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2))
    let argPath = path.join(dir, 'mcp.json')
    if (env.kind === 'wsl') {
      const m = task.path.match(/^\\\\wsl(?:\.localhost|\$)?\\[^\\]+\\(.*)$/i)
      if (m) argPath = '/' + m[1].replace(/\\/g, '/') + '/.zzwork/mcp.json'
    }
    out.args.push('--mcp-config', argPath, '--strict-mcp-config')
  } catch (e) {
    out.note = 'MCP 配置写入失败: ' + e.message
  }

  // Skills：把选中的清单 appended 到 system prompt（只给路径，按需读取，省 token）
  const lines = (selection.skills || []).map((s) => {
    const desc = String(s.description || '').replace(/\s+/g, ' ').slice(0, 160)
    return `- ${s.name}: ${desc || '(无描述)'} | 文件: ${s.path}`
  })
  if (lines.length) {
    const text = ('可用 Skills（相关时先读对应 SKILL.md 再执行）：\n' + lines.join('\n')).slice(0, 4000)
    out.args.push('--append-system-prompt', text)
  }
  return out
}

async function runClaude({ task, prompt, meta, selection, systemExtra, onMeta, onDelta, onDone, onError, env }) {
  const sidKey = 'sid:claude-code'
  const sid = (meta || {})[sidKey]
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  if (env.kind !== 'local') {
    try {
      const { syncSkillsToEnv } = require('./envs')
      const dirs = (selection && selection.skills || []).map((x) => require('path').dirname(x.path)).filter((d) => require('fs').existsSync(d))
      const r = await syncSkillsToEnv(env, dirs)
      if (r && r.ok && r.synced) onDelta && onDelta('[zzwork] 已同步 ' + r.synced + ' 个 skill 到该环境\n')
      else if (r && !r.ok) onDelta && onDelta('[zzwork] skill 同步失败: ' + r.error + '\n')
    } catch (e) { onDelta && onDelta('[zzwork] skill 同步异常: ' + e.message + '\n') }
  }
  const inj = prepareInjection(task, env, selection, systemExtra)
  if (inj.args.length) args.push(...inj.args)
  if (inj.note) onDelta && onDelta(`[zzwork] ${inj.note}\n`)
  if (sid) args.push('--resume', sid)

  let child, carry = ''
  const handleLine = (line) => {
    line = line.trim(); if (!line) return
    let ev; try { ev = JSON.parse(line) } catch { onDelta(line + '\n'); return }
    if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      onMeta && onMeta(sidKey, ev.session_id)
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) if (c.type === 'text' && c.text) onDelta(c.text)
    } else if (ev.type === 'result') {
      if (ev.session_id) onMeta && onMeta(sidKey, ev.session_id)
      if (ev.result) { onDelta('\n[完成]\n'); onDone && onDone(ev.result) }
    }
  }

  if (env.kind === 'wsl') {
    child = spawn('wsl.exe', ['-d', env.distro, '--cd', env.unixPath, '--', 'claude', ...args], { windowsHide: true })
  } else if (env.kind === 'ssh') {
    child = spawn('ssh', [env.host, `cd ${JSON.stringify(task.path)} && claude ${args.join(' ')}`], { windowsHide: true })
  } else {
    // Windows 本机：npm shim 需要走 shell；stdin 传 prompt 避开引号地狱
    child = spawnCommand('claude', args, { cwd: task.path, windowsHide: true })
  }

  let finished = false
  const finish = (err, result) => {
    if (finished) return; finished = true
    if (err) onError && onError(err); else onDone && onDone(result || '')
  }
  child.stdout.on('data', (b) => {
    carry += b.toString()
    const lines = carry.split('\n'); carry = lines.pop()
    lines.forEach(handleLine)
  })
  child.stderr.on('data', (b) => onDelta && onDelta(b.toString()))
  child.on('error', (e) => finish(`无法启动 claude（${e.message}）。请确认已安装并在 PATH 中。`))
  child.on('close', (code) => {
    if (carry) handleLine(carry)
    if (!finished) finish(code === 0 ? null : `claude 退出码 ${code}`)
  })
  child.stdin.write(prompt); child.stdin.end()
  return { kill: () => killTree(child), child }
}

function runGeneric({ task, agent, prompt, onDelta, onDone, onError, env }) {
  // 模板支持 {prompt}；没有占位符则把 prompt 作为尾参追加
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`
  const tmpl = agent.cmd || 'echo'
  const cmdLine = tmpl.includes('{prompt}')
    ? tmpl.replace(/\{prompt\}/g, q(prompt))
    : `${tmpl} ${q(prompt)}`

  let child
  if (env.kind === 'wsl') {
    child = spawn('wsl.exe', ['-d', env.distro, '--cd', env.unixPath, '--', 'sh', '-c', cmdLine], { windowsHide: true })
  } else if (env.kind === 'ssh') {
    child = spawn('ssh', [env.host, `cd ${JSON.stringify(task.path)} && ${cmdLine}`], { windowsHide: true })
  } else {
    child = spawn(cmdLine, { shell: true, cwd: task.path, windowsHide: true })
  }

  let out = '', finished = false
  const finish = (err) => { if (finished) return; finished = true; err ? (onError && onError(err)) : (onDone && onDone(out)) }
  child.stdout.on('data', (b) => { const s = b.toString(); out += s; onDelta && onDelta(s) })
  child.stderr.on('data', (b) => { const s = b.toString(); out += s; onDelta && onDelta(s) })
  child.on('error', (e) => finish(`无法启动 ${agent.name}（${e.message}）`))
  child.on('close', (code) => finish(code === 0 ? null : `${agent.name} 退出码 ${code}`))
  return { kill: () => killTree(child), child }
}

module.exports = { runAgent, resolveEnv, detectAgents, KNOWN_AGENTS, prepareInjection }
