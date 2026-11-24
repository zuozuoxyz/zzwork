// 任务分享：本机起一个轻量 HTTP 服务，把「被分享任务」以只读问答 + 只读文件的形式暴露给外部 zzwork。
// 不引入中央服务器：用户自带公网隧道（cloudflared/ngrok…）把本机端口暴露到公网；链接里带 token 鉴权。
const http = require('http')
const fs = require('fs')
const path = require('path')
const { getStore } = require('./store')
const { parseRemotePath } = require('../../core/envs')
const remotefs = require('./remotefs')
const { listTaskDir } = require('./taskfiles')
const shareLink = require('../../core/shareLink')
const chat = require('./chat')

const BODY_MAX = 256 * 1024
const FILE_MAX = 512 * 1024
const RATE_WINDOW = 60 * 1000
const RATE_MAX = 10
const CONCURRENCY_MAX = 2

let server = null
let sockets = null
let state = { running: false, port: 0, bind: '', error: '' }
const gates = new Map() // token -> { times: number[], active: number }

// ---- settings ----
function getShares(S) {
  try { return JSON.parse(S.getSetting('shares', '{}')) || {} } catch { return {} }
}
function setShares(S, m) { S.setSetting('shares', JSON.stringify(m)) }
function getConfig(S) {
  let c = {}
  try { c = JSON.parse(S.getSetting('share.config', '{}')) || {} } catch {}
  return {
    port: Number(c.port) > 0 && Number(c.port) < 65536 ? Number(c.port) : 8787,
    bind: String(c.bind || '127.0.0.1'),
    publicBase: String(c.publicBase || '').replace(/\/+$/, '')
  }
}
function shareLinkFor(cfg, token) {
  const base = cfg.publicBase || ('http://localhost:' + cfg.port)
  return base + '/s/' + token
}

// ---- task share CRUD ----
function taskGet(S, taskId) {
  const cfg = getConfig(S)
  const e = getShares(S)[taskId]
  const out = { running: state.running, port: cfg.port, bind: cfg.bind, publicBase: cfg.publicBase, error: state.error, enabled: false, link: '', allowFs: true }
  if (e) {
    out.enabled = !!e.enabled
    out.allowFs = e.allowFs !== false
    out.link = (e.enabled && e.token) ? shareLinkFor(cfg, e.token) : ''
    out.token = e.token || ''
  }
  return out
}
function enable(S, taskId) {
  const shares = getShares(S)
  let e = shares[taskId]
  if (!e) e = { token: shareLink.makeToken(), enabled: true, createdAt: Date.now(), allowFs: true }
  else { e.enabled = true; if (!e.token) e.token = shareLink.makeToken() }
  shares[taskId] = e
  setShares(S, shares)
  return taskGet(S, taskId)
}
function disable(S, taskId) {
  const shares = getShares(S)
  if (shares[taskId]) { shares[taskId].enabled = false; setShares(S, shares) }
  return taskGet(S, taskId)
}
function regenerate(S, taskId) {
  const shares = getShares(S)
  const e = shares[taskId] || { enabled: true, allowFs: true, createdAt: Date.now() }
  e.token = shareLink.makeToken()
  shares[taskId] = e
  setShares(S, shares)
  return taskGet(S, taskId)
}

function findShareByToken(S, token) {
  const shares = getShares(S)
  for (const [taskId, e] of Object.entries(shares)) {
    if (!e || !e.enabled || !e.token) continue
    if (shareLink.tokenEquals(e.token, token)) {
      const task = S.getTask(taskId)
      if (task && !task.deleted_at) return { taskId, entry: e, task }
    }
  }
  return null
}

// ---- server lifecycle ----
function startAll() {
  stopAll()
  const S = getStore()
  const cfg = getConfig(S)
  const shares = getShares(S)
  const anyEnabled = Object.values(shares).some((e) => e && e.enabled && e.token)
  state = { running: false, port: cfg.port, bind: cfg.bind, error: '' }
  if (!anyEnabled) return Promise.resolve(state)
  return new Promise((resolve) => {
    sockets = new Set()
    const srv = http.createServer((req, res) => {
      handle(req, res).catch((e) => { try { sendJson(res, 500, { ok: false, error: String(e.message || e) }) } catch {} })
    })
    srv.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)) })
    let settled = false
    const settle = () => { if (!settled) { settled = true; resolve(state) } }
    srv.on('error', (e) => {
      state = { running: false, port: cfg.port, bind: cfg.bind, error: String(e.message || e) }
      settle()
    })
    srv.listen(cfg.port, cfg.bind, () => {
      server = srv
      state = { running: true, port: cfg.port, bind: cfg.bind, error: '' }
      settle()
    })
    server = srv
  })
}
function stopAll() {
  if (server) {
    try { for (const s of (sockets || [])) { try { s.destroy() } catch {} } } catch {}
    try { server.close() } catch {}
    server = null
  }
  if (sockets) sockets.clear()
  state = { running: false, port: 0, bind: '', error: '' }
}
function restart() { return startAll() }

// ---- request handling ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  } catch {}
}
function notFound(res) { sendJson(res, 404, { ok: false, error: 'not found' }) }

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_MAX) { try { req.destroy() } catch {}; finish({}); return }
      chunks.push(c)
    })
    req.on('end', () => { try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })
}

function rateGate(token) {
  let g = gates.get(token)
  if (!g) { g = { times: [], active: 0 }; gates.set(token, g) }
  const now = Date.now()
  g.times = g.times.filter((t) => now - t < RATE_WINDOW)
  if (g.active >= CONCURRENCY_MAX) return { ok: false, error: '请求过于频繁，请稍后再试', release() {} }
  if (g.times.length >= RATE_MAX) return { ok: false, error: '请求过于频繁，请稍后再试', release() {} }
  g.times.push(now)
  g.active++
  let released = false
  return { ok: true, release() { if (released) return; released = true; g.active = Math.max(0, g.active - 1) } }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const m = /^\/s\/([A-Za-z0-9_-]+)\/([a-z]+(?:\/[a-z]+)?)\/?$/.exec(url.pathname || '')
  if (!m) return notFound(res)
  const token = m[1]
  const action = m[2]
  if (String(req.headers['x-zzwork-share'] || '') !== '1') return notFound(res)
  const S = getStore()
  const hit = findShareByToken(S, token)
  if (!hit) return notFound(res)

  if (action === 'health') {
    return sendJson(res, 200, { ok: true, name: hit.task.name, files: hit.entry.allowFs !== false })
  }

  if (req.method !== 'POST') return notFound(res)

  if (action === 'ask') {
    const body = await readJson(req)
    const q = String(body.question || '').trim()
    if (!q) return sendJson(res, 400, { ok: false, error: '缺少问题' })
    if (q.length > 8000) return sendJson(res, 413, { ok: false, error: '问题过长' })
    if ((hit.task.scope || 'long') === 'board') return sendJson(res, 200, { ok: false, error: '该任务不支持远程问答' })
    const gate = rateGate(token)
    if (!gate.ok) return sendJson(res, 429, { ok: false, error: gate.error })
    let r
    try { r = await chat.askRemote(hit.taskId, q, String(body.fromTask || '外部任务')) }
    catch (e) { r = { ok: false, error: String(e.message || e) } }
    finally { gate.release() }
    return sendJson(res, 200, r)
  }

  if (action === 'fs/list' || action === 'fs/read') {
    if (hit.entry.allowFs === false) return sendJson(res, 403, { ok: false, error: '该分享未开放文件读取' })
    const body = await readJson(req)
    try {
      if (action === 'fs/list') return sendJson(res, 200, { ok: true, list: await listShared(hit.task, String(body.path || '')) })
      return sendJson(res, 200, { ok: true, ...(await readShared(hit.task, String(body.path || ''))) })
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String(e.message || e) })
    }
  }

  return notFound(res)
}

// ---- shared file access (scoped to the task working dir) ----
function relSegs(rel) {
  const s = String(rel || '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.')
  if (s.includes('..')) throw new Error('不允许 ..')
  if (s.some((x) => x === '.zzwork' || x === '.git')) throw new Error('该目录不可访问')
  return s
}
function isBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}
function remoteRelPath(base, rel) {
  const r = parseRemotePath(base)
  const root = r.remotePath.replace(/\/+$/, '')
  const segs = relSegs(rel)
  return { envId: r.envId, root, path: root + (segs.length ? '/' + segs.join('/') : '') }
}

async function listShared(task, relDir) {
  const base = task && task.path
  if (!base) throw new Error('任务无工作目录')
  if (parseRemotePath(base)) {
    const rr = remoteRelPath(base, relDir)
    const list = await remotefs.readDir(rr.envId, rr.path).catch(() => [])
    return list.map((x) => {
      const rp = parseRemotePath(x.path)
      const full = rp ? rp.remotePath : x.path
      const rel = full.startsWith(rr.root) ? full.slice(rr.root.length).replace(/^\/+/, '') : x.name
      return { name: x.name, path: rel, dir: x.dir }
    })
  }
  const abs = shareLink.safeResolve(base, relDir)
  const list = await listTaskDir(abs)
  return list.map((x) => ({ name: x.name, path: path.relative(base, x.path).replace(/\\/g, '/'), dir: x.dir }))
}

async function readShared(task, rel) {
  const base = task && task.path
  if (!base) throw new Error('任务无工作目录')
  if (parseRemotePath(base)) {
    const rr = remoteRelPath(base, rel)
    if (!rr.path || rr.path === rr.root) throw new Error('目标是目录')
    const content = await remotefs.readFile(rr.envId, rr.path).catch((e) => { throw new Error(String(e.message || e)) })
    if (content.length > FILE_MAX) throw new Error('文件过大（>512KB）')
    if (content.indexOf('\u0000') >= 0) throw new Error('二进制文件不支持预览')
    return { content, path: rel }
  }
  const abs = shareLink.safeResolve(base, rel)
  const st = fs.statSync(abs)
  if (st.isDirectory()) throw new Error('目标是目录')
  if (st.size > FILE_MAX) throw new Error('文件过大（>512KB）')
  const buf = fs.readFileSync(abs)
  if (isBinary(buf)) throw new Error('二进制文件不支持预览')
  return { content: buf.toString('utf8'), path: rel }
}

// ---- consumer-side helpers (call the remote link) ----
async function remotePost(link, action, body) {
  const pl = shareLink.parseShareLink(link)
  if (!pl) throw new Error('链接格式不正确')
  const r = await fetch(pl.base + '/s/' + pl.token + '/' + action, {
    method: 'POST',
    headers: { 'x-zzwork-share': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
  return j
}
async function agentTest(link) {
  const pl = shareLink.parseShareLink(link)
  if (!pl) return { ok: false, error: '链接格式不正确' }
  try {
    const r = await fetch(pl.base + '/s/' + pl.token + '/health', { headers: { 'x-zzwork-share': '1' } })
    const j = await r.json().catch(() => ({}))
    if (r.ok && j.ok) return { ok: true, name: j.name || '远端任务', files: !!j.files }
    return { ok: false, error: j.error || ('HTTP ' + r.status) }
  } catch (e) { return { ok: false, error: '无法连接：' + String(e.message || e) } }
}
async function remoteFsList(link, p) { return remotePost(link, 'fs/list', { path: p || '' }) }
async function remoteFsRead(link, p) { return remotePost(link, 'fs/read', { path: p || '' }) }

// ---- IPC ----
function register(ipcMain) {
  ipcMain.handle('zz:share:status', () => {
    const S = getStore()
    return { ...state, publicBase: getConfig(S).publicBase }
  })
  ipcMain.handle('zz:share:config.save', async (_e, p) => {
    const S = getStore()
    const cfg = getConfig(S)
    const next = {
      port: (Number(p && p.port) > 0 && Number(p.port) < 65536) ? Number(p.port) : cfg.port,
      bind: String((p && p.bind) || cfg.bind),
      publicBase: String((p && p.publicBase) || '').replace(/\/+$/, '')
    }
    S.setSetting('share.config', JSON.stringify(next))
    const st = await startAll()
    return { ...st, publicBase: next.publicBase }
  })
  ipcMain.handle('zz:share:task.get', (_e, p) => taskGet(getStore(), p.taskId))
  ipcMain.handle('zz:share:task.enable', async (_e, p) => { const r = enable(getStore(), p.taskId); await startAll(); return taskGet(getStore(), p.taskId) || r })
  ipcMain.handle('zz:share:task.disable', (_e, p) => disable(getStore(), p.taskId))
  ipcMain.handle('zz:share:task.regenerate', (_e, p) => regenerate(getStore(), p.taskId))
  ipcMain.handle('zz:share:agent.test', (_e, p) => agentTest(p.link))
  ipcMain.handle('zz:share:fs.list', (_e, p) => remoteFsList(p.link, p.path))
  ipcMain.handle('zz:share:fs.read', (_e, p) => remoteFsRead(p.link, p.path))
}

module.exports = { startAll, stopAll, restart, register }
