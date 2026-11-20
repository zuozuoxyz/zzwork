// 终端服务：每个任务按所在环境开交互式 PTY（本机 node-pty / WSL wsl.exe / SSH ssh2 shell）
const os = require('os')
const fs = require('fs')
const crypto = require('crypto')
const { execFile, execFileSync } = require('child_process')
const { getStore } = require('./store')
const { resolveTaskEnv } = require('../../core/envs')
const secrets = require('./secrets')
const { connect, friendlyError } = require('../../core/sshconn')

const terms = new Map() // id -> { id, taskId, kind, title, cwd, pty|stream|client, dead, buf, timer }
let getWin = null

function post(channel, payload) {
  const win = getWin && getWin()
  if (win && !win.isDestroyed()) win.webContents.send('zz:terminal:' + channel, payload)
}

function clamp(n, lo, hi) {
  const v = Number(n) || lo
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function posixQuote(s) {
  return `'${String(s || '').replace(/'/g, `'\\''`)}'`
}

// ---------- 输出批量上屏 ----------

function flush(entry) {
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
  if (!entry.buf) return
  const data = entry.buf
  entry.buf = ''
  post('data', { id: entry.id, data })
}

const FLUSH_DELAY = 16
const FLUSH_NOW = 64 * 1024
const PENDING_CAP = 1024 * 1024

function pushData(entry, data) {
  if (entry.dead || !data) return
  entry.buf += data
  if (entry.buf.length > PENDING_CAP) entry.buf = entry.buf.slice(-PENDING_CAP / 2)
  if (entry.buf.length >= FLUSH_NOW) { flush(entry); return }
  if (!entry.timer) entry.timer = setTimeout(() => { entry.timer = null; flush(entry) }, FLUSH_DELAY)
}

function exitWith(entry, code, error) {
  if (entry.dead) return
  entry.dead = true
  flush(entry)
  post('exit', { id: entry.id, code: typeof code === 'number' ? code : -1, error: error || '' })
  try { entry.client && entry.client.end() } catch {}
}

// ---------- 环境探测 ----------

let localShellCache
function localShell() {
  if (localShellCache !== undefined) return localShellCache
  for (const exe of ['pwsh.exe', 'powershell.exe']) {
    try { execFileSync('where', [exe], { stdio: 'ignore' }); localShellCache = exe; return exe } catch {}
  }
  localShellCache = process.env.ComSpec || 'cmd.exe'
  return localShellCache
}

function taskEnvFor(task) {
  const env = resolveTaskEnv(getStore(), task)
  if (env.kind === 'ssh' && !env.secret) env.secret = secrets.get('zzwork.ssh.' + env.id) || ''
  return env
}

function shellTitle(env, task) {
  if (env.kind === 'wsl') return 'WSL · ' + (env.distro || (env.config && env.config.distro) || 'Linux')
  if (env.kind === 'ssh') return 'SSH · ' + ((env.config && env.config.user) ? env.config.user + '@' : '') + ((env.config && env.config.host) || env.id)
  const exe = localShell()
  return exe.startsWith('pwsh') ? 'pwsh' : exe.startsWith('powershell') ? 'PowerShell' : '命令提示符'
}

function killPty(entry) {
  if (!entry.pty) return
  try {
    if (process.platform === 'win32' && entry.pty.pid) execFile('taskkill', ['/pid', String(entry.pty.pid), '/T', '/F'])
    else entry.pty.kill()
  } catch {}
}

// ---------- 创建 ----------

async function create({ taskId, cols, rows, paneId }) {
  const S = getStore()
  const task = S.getTask(taskId)
  if (!task) throw new Error('任务不存在')
  const env = taskEnvFor(task)
  const c = clamp(cols, 2, 500)
  const r = clamp(rows, 2, 500)
  // 渲染层重载后会用同一 paneId 重新创建，先清掉旧进程，避免孤儿 PTY 堆积
  if (paneId) {
    for (const old of [...terms.values()]) if (old.taskId === task.id && old.paneId === paneId) kill(old.id)
  }
  const id = crypto.randomUUID()
  const entry = { id, taskId: task.id, paneId: paneId || '', kind: env.kind, title: shellTitle(env, task), cwd: '', dead: false, buf: '', timer: null }

  if (env.kind === 'ssh') {
    let client
    try { client = await connect(env, env.secret || '') } catch (e) {
      throw new Error(friendlyError(e) || e.message || 'SSH 连接失败')
    }
    const stream = await new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols: c, rows: r }, (err, s) => (err ? reject(err) : resolve(s)))
    })
    entry.client = client
    entry.stream = stream
    entry.cwd = env.unixPath || '/'
    terms.set(id, entry)
    stream.on('data', (d) => pushData(entry, d.toString('utf8')))
    stream.on('close', (code) => exitWith(entry, typeof code === 'number' ? code : 0))
    stream.on('error', (e) => exitWith(entry, -1, e.message))
    client.on('error', (e) => exitWith(entry, -1, e.message))
    client.on('close', () => exitWith(entry, 0))
    stream.write(`cd ${posixQuote(entry.cwd)} && exec "\${SHELL:-/bin/bash}" -l\r`)
    return { id, title: entry.title, kind: env.kind, cwd: entry.cwd }
  }

  let pty
  try { pty = require('node-pty') } catch (e) {
    throw new Error('node-pty 不可用：' + e.message)
  }

  if (env.kind === 'wsl') {
    const distro = env.distro || (env.config && env.config.distro) || ''
    if (!distro) throw new Error('WSL 发行版未识别')
    const unixPath = env.unixPath || '/'
    entry.cwd = unixPath
    // 本机 WSL 不支持 --cd（Wsl/E_FILE_NOT_FOUND），统一 sh -lc 里 cd 后 exec 登录 shell
    entry.pty = pty.spawn('wsl.exe', ['-d', distro, '--', 'sh', '-lc', `cd ${posixQuote(unixPath)} && exec "\${SHELL:-/bin/bash}" -l`], {
      name: 'xterm-256color', cols: c, rows: r, env: process.env
    })
  } else {
    let cwd = task.path
    let warn = ''
    if (!cwd || !fs.existsSync(cwd) || /^ssh:\/\//i.test(cwd) || /^\\\\wsl/i.test(cwd)) {
      warn = '[zzwork] 任务目录不可用，已在用户主目录启动\r\n'
      cwd = os.homedir()
    }
    entry.cwd = cwd
    entry.pty = pty.spawn(localShell(), ['-NoLogo'], { name: 'xterm-256color', cols: c, rows: r, cwd, env: process.env })
    if (warn) pushData(entry, warn)
  }

  terms.set(id, entry)
  entry.pty.onData((d) => pushData(entry, d))
  entry.pty.onExit(({ exitCode }) => exitWith(entry, exitCode))
  return { id, title: entry.title, kind: env.kind, cwd: entry.cwd }
}

// ---------- 操作 ----------

function write(id, data) {
  const e = terms.get(id)
  if (!e || e.dead) return false
  const s = String(data || '').slice(0, 64 * 1024)
  try {
    if (e.pty) e.pty.write(s)
    else if (e.stream) e.stream.write(s)
    return true
  } catch { return false }
}

function resize(id, cols, rows) {
  const e = terms.get(id)
  if (!e || e.dead) return false
  const c = clamp(cols, 2, 500)
  const r = clamp(rows, 2, 500)
  try {
    if (e.pty) e.pty.resize(c, r)
    else if (e.stream && e.stream.setWindow) e.stream.setWindow(r, c, 0, 0)
    return true
  } catch { return false }
}

function kill(id) {
  const e = terms.get(id)
  if (!e) return true
  if (e.timer) clearTimeout(e.timer)
  e.timer = null
  killPty(e)
  try { e.client && e.client.end() } catch {}
  e.dead = true
  terms.delete(id)
  return true
}

function list(taskId) {
  return [...terms.values()]
    .filter((e) => !taskId || e.taskId === taskId)
    .map((e) => ({ id: e.id, taskId: e.taskId, title: e.title, kind: e.kind, cwd: e.cwd, dead: e.dead }))
}

function killTask(taskId) {
  for (const e of [...terms.values()]) if (e.taskId === taskId) kill(e.id)
  return true
}

function killAll() {
  for (const id of [...terms.keys()]) kill(id)
}

function register(ipcMain, winGetter) {
  getWin = winGetter
  const { clipboard } = require('electron')
  ipcMain.handle('zz:terminal:create', (_e, p) => create(p || {}))
  ipcMain.handle('zz:terminal:write', (_e, p) => write(p && p.id, p && p.data))
  ipcMain.handle('zz:terminal:resize', (_e, p) => resize(p && p.id, p && p.cols, p && p.rows))
  ipcMain.handle('zz:terminal:kill', (_e, p) => kill(p && p.id))
  ipcMain.handle('zz:terminal:list', (_e, p) => list(p && p.taskId))
  ipcMain.handle('zz:terminal:killTask', (_e, p) => killTask(p && p.taskId))
  ipcMain.handle('zz:terminal:copy', (_e, p) => { clipboard.writeText(String((p && p.text) || '')); return true })
  ipcMain.handle('zz:terminal:paste', () => clipboard.readText() || '')
}

module.exports = { register, create, write, resize, kill, list, killTask, killAll }
