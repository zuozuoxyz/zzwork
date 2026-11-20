// MCP 连接测试：真实 JSON-RPC 握手（initialize + tools/list）
const { spawn, exec } = require('child_process')
const fs = require('fs')
const http = require('http')
const https = require('https')

function splitCommand(line) {
  const out = []
  let cur = '', quote = null
  for (const ch of String(line || '')) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = '' } continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function commandParts(raw) {
  const s = String(raw || '')
  if (s && fs.existsSync(s)) return [s]
  return splitCommand(s)
}

// Windows 下：绝对路径/.exe 直接 spawn；裸命令（npx、claude）走 shell 并自行加引号
function spawnCommand(cmd, args, opts) {
  const isWin = process.platform === 'win32'
  const isPath = /[\\/]/.test(cmd) || /\.exe$/i.test(cmd)
  if (isWin && !isPath) {
    const q = (s) => (/[\s"]/.test(String(s)) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s))
    return spawn([cmd, ...args].map(q).join(' '), { ...(opts || {}), shell: true })
  }
  return spawn(cmd, args, { ...(opts || {}), shell: false })
}

function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32') exec(`taskkill /pid ${child.pid} /T /F`, () => {})
    else child.kill('SIGKILL')
  } catch {}
}

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params })
}

function testStdio(server, timeoutMs) {
  return new Promise((resolve) => {
    const cfg = server.config || {}
    const parts = commandParts(cfg.command || '')
    if (!parts.length) return resolve({ ok: false, error: '未配置启动命令' })
    const cmd = parts[0]
    const args = [...parts.slice(1), ...(Array.isArray(cfg.args) ? cfg.args : [])]
    const started = Date.now()
    let child
    try {
      child = spawnCommand(cmd, args, {
        cwd: cfg.cwd || undefined,
        env: { ...process.env, ...(cfg.env || {}) },
        windowsHide: true,
      })
    } catch (e) {
      return resolve({ ok: false, error: '无法启动: ' + e.message })
    }

    let buf = '', stderr = '', sentList = false, done = false
    const finish = (res) => {
      if (done) return
      done = true
      clearTimeout(timer)
      killTree(child)
      resolve({ ...res, ms: Date.now() - started, transport: 'stdio' })
    }
    const timer = setTimeout(() => finish({ ok: false, error: '握手超时（8s）' }), timeoutMs || 8000)

    const handle = (msg) => {
      if (msg.id === 1 && msg.result) {
        if (sentList) return
        sentList = true
        child.stdin.write(rpc(2, 'tools/list', {}) + '\n')
      } else if (msg.id === 2) {
        const tools = msg.result && Array.isArray(msg.result.tools) ? msg.result.tools : []
        finish({ ok: true, tools: tools.length, toolNames: tools.slice(0, 20).map((t) => t.name) })
      } else if (msg.id === 1 && msg.error) {
        finish({ ok: false, error: msg.error.message || 'initialize 失败' })
      }
    }

    child.stdout.on('data', (b) => {
      buf += b.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try { handle(JSON.parse(line)) } catch {}
      }
    })
    child.stderr.on('data', (b) => { stderr += b.toString() })
    child.on('error', (e) => finish({ ok: false, error: '启动失败: ' + e.message }))
    child.on('exit', (code) => {
      if (!done) finish({ ok: false, error: `进程退出(${code})${stderr ? ': ' + stderr.slice(0, 200) : ''}` })
    })
    try {
      child.stdin.write(rpc(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'zzwork', version: '0.4.0' },
      }) + '\n')
    } catch (e) { finish({ ok: false, error: '写入失败: ' + e.message }) }
  })
}

function postJson(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(urlStr) } catch { return resolve({ ok: false, error: 'URL 无效' }) }
    const mod = u.protocol === 'https:' ? https : http
    const data = JSON.stringify(body)
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      timeout: timeoutMs || 8000,
    }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }) })
    req.on('error', (e) => resolve({ ok: false, error: e.message }))
    req.write(data)
    req.end()
  })
}

function parseRpc(raw) {
  const tryParse = (s) => { try { return JSON.parse(s) } catch { return null } }
  const whole = tryParse(raw)
  if (whole) return whole
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('data:')) {
      const v = tryParse(t.slice(5).trim())
      if (v) return v
    }
  }
  return null
}

async function testHttp(server, timeoutMs) {
  const cfg = server.config || {}
  if (!cfg.url) return { ok: false, error: '未配置 URL' }
  const started = Date.now()
  const init = await postJson(cfg.url, cfg.headers || {}, JSON.parse(rpc(1, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'zzwork', version: '0.4.0' },
  })), timeoutMs)
  if (init.ok === false) return { ok: false, error: init.error, ms: Date.now() - started, transport: 'http' }
  const initMsg = parseRpc(init.raw)
  if (!initMsg || initMsg.error) {
    return { ok: false, error: (initMsg && initMsg.error && initMsg.error.message) || `HTTP ${init.status}`, ms: Date.now() - started, transport: 'http' }
  }
  const sid = init.headers && (init.headers['mcp-session-id'] || init.headers['Mcp-Session-Id'])
  const headers = { ...(cfg.headers || {}) }
  if (sid) headers['mcp-session-id'] = sid
  const list = await postJson(cfg.url, headers, JSON.parse(rpc(2, 'tools/list', {})), timeoutMs)
  const listMsg = list.ok === false ? null : parseRpc(list.raw)
  const tools = listMsg && listMsg.result && Array.isArray(listMsg.result.tools) ? listMsg.result.tools : []
  return { ok: true, tools: tools.length, toolNames: tools.slice(0, 20).map((t) => t.name), ms: Date.now() - started, transport: 'http' }
}

async function testMcp(server) {
  if (server.type === 'http' || server.type === 'sse') return testHttp(server)
  return testStdio(server)
}

module.exports = { testMcp, splitCommand, spawnCommand, commandParts }
