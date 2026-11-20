// SSH 连接：优先用 ssh2（支持密码/私钥/agent），失败或不可用时回退系统 ssh
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { spawn } = require('child_process')

let ssh2 = null
function lib() {
  if (ssh2 === null) {
    try { ssh2 = require('ssh2') } catch { ssh2 = false }
  }
  return ssh2 || null
}

function friendlyError(e) {
  const msg = String((e && (e.message || e.level || e.code)) || e)
  if (/all configured authentication methods failed|authentication failed|permission denied/i.test(msg)) {
    return 'SSH 认证失败：请检查用户名、密码或私钥'
  }
  if (/ECONNREFUSED|connection refused/i.test(msg)) return 'SSH 连接被拒绝：目标端口未开放'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|could not resolve hostname/i.test(msg)) return 'SSH 无法解析主机名'
  if (/timed? ?out|ETIMEDOUT/i.test(msg)) return 'SSH 连接超时：检查主机地址与网络'
  return 'SSH 连接失败：' + msg
}

function defaultKeyPath() {
  const cands = [
    process.env.ZZ_SSH_KEY,
    path.join(os.homedir(), '.ssh', 'id_ed25519'),
    path.join(os.homedir(), '.ssh', 'id_rsa')
  ].filter(Boolean)
  return cands.find((p) => { try { return fs.existsSync(p) } catch { return false } }) || ''
}

function connectConfig(env, secret) {
  const c = env.config || {}
  const cfg = {
    host: c.host,
    port: Number(c.port) || 22,
    username: c.user || os.userInfo().username,
    readyTimeout: 10000,
    keepaliveInterval: 15000
  }
  if (secret) {
    cfg.password = secret
  } else {
    const keyPath = c.keyPath || defaultKeyPath()
    if (keyPath) {
      try { cfg.privateKey = fs.readFileSync(keyPath) } catch {}
    }
    if (process.env.SSH_AUTH_SOCK) cfg.agent = process.env.SSH_AUTH_SOCK
  }
  return cfg
}

function connect(env, secret) {
  const L = lib()
  if (!L) return Promise.reject(new Error('ssh2 未安装'))
  return new Promise((resolve, reject) => {
    const client = new L.Client()
    let settled = false
    const fail = (e) => {
      if (settled) return
      settled = true
      try { client.end() } catch {}
      reject(new Error(friendlyError(e)))
    }
    client.once('ready', () => { if (!settled) { settled = true; resolve(client) } })
    client.once('error', fail)
    try { client.connect(connectConfig(env, secret)) } catch (e) { fail(e) }
  })
}

// 执行一条远程命令，返回 { ok, code, stdout, stderr, error }
async function execRemote(env, secret, command, timeout = 20000) {
  const client = await connect(env, secret)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code, error) => {
      if (done) return
      done = true
      try { client.end() } catch {}
      resolve({ ok: !error && code === 0, code, stdout, stderr, error })
    }
    const timer = setTimeout(() => finish(-1, '远程命令超时'), timeout)
    client.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); finish(-1, friendlyError(err)); return }
      stream.on('data', (d) => { stdout += d })
      stream.stderr.on('data', (d) => { stderr += d })
      stream.on('close', (code) => { clearTimeout(timer); finish(code == null ? 0 : code) })
    })
  })
}

// 与 child_process 类似的最小适配，供 agentRunner 流式复用
function spawnRemote(env, secret, command) {
  const ee = new EventEmitter()
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  const stdinQueue = []
  ee.stdin = {
    write(d) { if (stream) { try { stream.write(d) } catch {} } else stdinQueue.push(d) },
    end() { if (stream) { try { stream.end() } catch {} } else stdinQueue.push(null) }
  }
  let client = null
  let stream = null
  let killed = false
  connect(env, secret).then((c) => {
    client = c
    c.exec(command, (err, s) => {
      if (killed) { try { c.end() } catch {}; return }
      if (err) { ee.emit('error', new Error(friendlyError(err))); return }
      stream = s
      for (const d of stdinQueue) { try { d === null ? stream.end() : stream.write(d) } catch {} }
      stdinQueue.length = 0
      s.on('data', (d) => ee.stdout.emit('data', d))
      s.stderr.on('data', (d) => ee.stderr.emit('data', d))
      s.on('close', (code) => {
        try { c.end() } catch {}
        if (!killed) ee.emit('close', code == null ? 0 : code)
      })
    })
  }).catch((e) => { if (!killed) ee.emit('error', e) })
  ee.kill = () => {
    killed = true
    try { stream && stream.close() } catch {}
    try { client && client.end() } catch {}
    ee.emit('close', 130)
  }
  ee.pid = -1
  return ee
}

// 系统 ssh 参数（密钥/ssh-agent 认证，BatchMode 防止无 TTY 时挂起）
function systemSshParts(env) {
  const c = env.config || {}
  const user = c.user ? `${c.user}@` : ''
  const port = Number(c.port) ? ['-p', String(Number(c.port))] : []
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...port, `${user}${c.host}`]
}

// 统一入口：有密码走 ssh2，否则回退系统 ssh。返回 { ok, code, stdout, stderr, error }
async function runRemote(env, secret, command, timeout = 20000) {
  if (secret && lib()) {
    try { return await execRemote(env, secret, command, timeout) } catch (e) {
      return { ok: false, code: -1, stdout: '', stderr: '', error: String((e && e.message) || e) }
    }
  }
  return new Promise((resolve) => {
    const child = spawn('ssh', [...systemSshParts(env), command], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code, error) => {
      if (done) return
      done = true
      let errMsg = error
      if (!errMsg && code !== 0) errMsg = friendlyError(stderr.trim() || ('ssh 退出码 ' + code))
      resolve({ ok: !errMsg && code === 0, code, stdout, stderr, error: errMsg || '' })
    }
    const timer = setTimeout(() => { try { child.kill() } catch {}; finish(-1, '远程命令超时') }, timeout)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => { clearTimeout(timer); finish(-1, friendlyError(e)) })
    child.on('close', (code) => { clearTimeout(timer); finish(code == null ? 0 : code) })
  })
}

module.exports = { connect, execRemote, spawnRemote, runRemote, systemSshParts, defaultKeyPath, friendlyError }
