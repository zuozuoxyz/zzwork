// 会话内容落盘：<task>/.zzwork/sessions/<sessionId>/{meta.json,transcript.jsonl}
// 文件为权威、可随任务目录拷走；SQLite 的 sessions/messages 作为可重建的缓存/索引。
// 本地/WSL 走 fs，SSH 走 SFTP（在线写；离线抛错由上层吞掉，靠 reconcile 合并补写）。
const fs = require('fs')
const path = require('path')
const { parseRemotePath } = require('../../core/envs')

const THINKING_LIMIT = 30000

function remotefs() { return require('./remotefs') }

function joinTask(taskPath, ...segs) {
  const r = parseRemotePath(taskPath)
  if (r) return 'ssh://' + r.envId + '/' + [r.remotePath.replace(/^\/+|\/+$/g, ''), ...segs].filter(Boolean).join('/')
  return path.join(taskPath, ...segs)
}

function sessionsRoot(taskPath) { return joinTask(taskPath, '.zzwork', 'sessions') }
function sessionDir(taskPath, sid) { return joinTask(taskPath, '.zzwork', 'sessions', sid) }
function transcriptPath(taskPath, sid) { return joinTask(taskPath, '.zzwork', 'sessions', sid, 'transcript.jsonl') }
function metaPath(taskPath, sid) { return joinTask(taskPath, '.zzwork', 'sessions', sid, 'meta.json') }

function parseMeta(s) {
  if (s && typeof s === 'object') return s
  try { return JSON.parse(s || '{}') } catch { return {} }
}

// 与键顺序无关的序列化，用于判断文件与 DB 缓存内容是否一致（避免每次打开都无谓 upsert）
function stableStr(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStr(v[k])).join(',') + '}'
  return JSON.stringify(v)
}

// ---- 底层文件操作（本地/WSL 用 fs，ssh 用 SFTP）----
// 一律异步：\\wsl$ 等 9p/UNC 路径同步读写在主线程会阻塞数秒（界面无响应），转 libuv 线程池
async function fileExists(p) {
  const r = parseRemotePath(p)
  if (r) { try { return await remotefs().exists(r.envId, r.remotePath) } catch { return false } }
  try { await fs.promises.access(p); return true } catch { return false }
}
async function fileRead(p) {
  const r = parseRemotePath(p)
  if (r) return remotefs().readFile(r.envId, r.remotePath)
  return fs.promises.readFile(p, 'utf8')
}
async function fileWrite(p, text) {
  const r = parseRemotePath(p)
  if (r) return remotefs().writeFile(r.envId, r.remotePath, text)
  await fs.promises.mkdir(path.dirname(p), { recursive: true })
  await fs.promises.writeFile(p, text)
}
async function fileAppend(p, text) {
  const r = parseRemotePath(p)
  if (r) return remotefs().appendText(r.envId, r.remotePath, text)
  await fs.promises.mkdir(path.dirname(p), { recursive: true })
  await fs.promises.appendFile(p, text)
}
async function fileRemove(p) {
  const r = parseRemotePath(p)
  if (r) return remotefs().remove(r.envId, r.remotePath)
  try { await fs.promises.rm(p, { recursive: true, force: true }) } catch {}
}
async function dirNames(p) {
  const r = parseRemotePath(p)
  if (r) {
    try { return (await remotefs().readDir(r.envId, r.remotePath)).filter((d) => d.dir).map((d) => d.name) }
    catch { return [] }
  }
  try { return (await fs.promises.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) }
  catch { return [] }
}

// 同一 task|session 的写入串行化，保证 append 顺序；失败记录但不阻塞回合
const queues = new Map()
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve()
  const next = prev.then(() => fn()).catch((e) => { try { console.error('[sessionFiles] ' + (e && e.message)) } catch {} })
  queues.set(key, next)
  next.then(() => { if (queues.get(key) === next) queues.delete(key) })
  return next
}
const qkey = (taskPath, sid) => taskPath + '|' + sid

// ---- 行构造：thinking / parts 提到顶层，便于阅读；meta 存其余字段 ----
function splitMeta(metaObj) {
  const m = { ...(metaObj || {}) }
  const thinking = m.thinking
  const parts = m.parts
  delete m.thinking
  delete m.parts
  return { meta: m, thinking, parts }
}
function joinMeta(metaObj, thinking, parts) {
  const m = { ...(metaObj || {}) }
  if (thinking != null) m.thinking = thinking
  if (parts != null) m.parts = parts
  return m
}
function buildRow(msg) {
  const { meta, thinking, parts } = splitMeta(msg.meta)
  const row = {
    t: 'msg', id: msg.id, role: msg.role, kind: msg.kind || 'text',
    content: msg.content == null ? '' : String(msg.content),
    run_id: msg.run_id || '', created_at: msg.created_at || new Date().toISOString(), meta
  }
  if (thinking != null) row.thinking = thinking
  if (parts != null) row.parts = parts
  return row
}

// 全量 meta → DB 缓存投影：工具调用去掉 input/output、思考截断
function slimMeta(meta) {
  const m = { ...(meta || {}) }
  if (typeof m.thinking === 'string' && m.thinking.length > THINKING_LIMIT) m.thinking = m.thinking.slice(0, THINKING_LIMIT)
  if (Array.isArray(m.parts)) {
    m.parts = m.parts.map((p) => {
      if (!p || p.t !== 'tool') return p
      const { input, output, ...rest } = p
      return rest
    })
  }
  if (Array.isArray(m.steps)) {
    m.steps = m.steps.map((s) => {
      if (!s || (s.input === undefined && s.output === undefined)) return s
      const { input, output, ...rest } = s
      return rest
    })
  }
  return m
}

function sessionFileMeta(session) {
  return {
    id: session.id, title: session.title || '', kind: session.kind || 'chat',
    parent_session_id: session.parent_session_id || '', agent_id: session.agent_id || '',
    model_id: session.model_id || '', summary: session.summary || '',
    meta: parseMeta(session.meta), created_at: session.created_at || '', updated_at: session.updated_at || ''
  }
}

// ---- 写入口（供 store 适配器调用，fire-and-forget）----
function appendMessage(task, sessionId, msg) {
  if (!task || !task.path || !sessionId || !msg || !msg.id) return
  let line
  try { line = JSON.stringify(buildRow(msg)) + '\n' } catch { return }
  enqueue(qkey(task.path, sessionId), () => fileAppend(transcriptPath(task.path, sessionId), line))
}
function appendUpdate(task, sessionId, id, patch) {
  if (!task || !task.path || !sessionId || !id || !patch) return
  let line
  try { line = JSON.stringify({ t: 'upd', id, patch }) + '\n' } catch { return }
  enqueue(qkey(task.path, sessionId), () => fileAppend(transcriptPath(task.path, sessionId), line))
}
function writeMeta(task, session) {
  if (!task || !task.path || !session || !session.id) return
  const obj = sessionFileMeta(session)
  enqueue(qkey(task.path, session.id) + '|meta', () => fileWrite(metaPath(task.path, session.id), JSON.stringify(obj, null, 2)))
}

async function readMeta(task, sid) {
  try {
    const mp = metaPath(task.path, sid)
    if (!(await fileExists(mp))) return null
    return JSON.parse(await fileRead(mp))
  } catch { return null }
}

async function listSessionIds(task) {
  if (!task || !task.path) return []
  const names = await dirNames(sessionsRoot(task.path))
  return names.filter((n) => /^[A-Za-z0-9._-]+$/.test(n) && n !== '.' && n !== '..')
}

// 读取合并后的消息（按 id last-wins，按 created_at 稳定排序）；无文件返回 []，远程不可读返回 null
async function readTranscript(task, sid) {
  const tp = transcriptPath(task.path, sid)
  let raw
  try {
    if (!(await fileExists(tp))) return []
    raw = await fileRead(tp)
  } catch { return null }
  if (raw == null) return null
  const order = []
  const byId = new Map()
  for (const line of String(raw).split('\n')) {
    const s = line.trim(); if (!s) continue
    let row; try { row = JSON.parse(s) } catch { continue }
    if (row.t === 'msg' && row.id) {
      const rec = {
        id: row.id, role: row.role || 'assistant',
        content: row.content == null ? '' : String(row.content),
        kind: row.kind || 'text', run_id: row.run_id || '',
        created_at: row.created_at || '', meta: joinMeta(row.meta, row.thinking, row.parts)
      }
      if (!byId.has(row.id)) order.push(row.id)
      byId.set(row.id, rec)
    } else if (row.t === 'upd' && row.id && row.patch) {
      const cur = byId.get(row.id)
      if (!cur) continue
      const p = row.patch
      if (p.content !== undefined) cur.content = p.content
      if (p.kind !== undefined) cur.kind = p.kind
      if (p.run_id !== undefined) cur.run_id = p.run_id
      if (p.meta !== undefined) cur.meta = parseMeta(p.meta)
    }
  }
  const list = order.map((id) => byId.get(id))
  list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  return list
}

async function removeSessionDir(task, sid) {
  if (!task || !task.path || !sid) return
  await enqueue(qkey(task.path, sid), () => fileRemove(sessionDir(task.path, sid)))
}

// DB → 文件（惰性迁移 / 直接写库的兼容路径）
async function exportFromDb(task, S, sid) {
  const session = S.getSession(sid)
  if (!session) return
  await enqueue(qkey(task.path, sid) + '|meta', () => fileWrite(metaPath(task.path, sid), JSON.stringify(sessionFileMeta(session), null, 2)))
  const msgs = S.listMessages(task.id, sid)
  const lines = msgs.map((m) => JSON.stringify(buildRow({
    id: m.id, role: m.role, kind: m.kind, content: m.content, run_id: m.run_id, created_at: m.created_at, meta: parseMeta(m.meta)
  })))
  const body = lines.length ? lines.join('\n') + '\n' : ''
  await enqueue(qkey(task.path, sid), () => fileWrite(transcriptPath(task.path, sid), body))
}

// 文件 → DB 缓存（可移植性：拷走任务目录后会话自动出现）
async function importSession(task, S, sid) {
  const meta = await readMeta(task, sid)
  const rec = {
    id: sid, task_id: task.id,
    parent_session_id: (meta && meta.parent_session_id) || '',
    kind: (meta && meta.kind) || 'chat',
    title: (meta && meta.title) || '会话',
    agent_id: (meta && meta.agent_id) || '', model_id: (meta && meta.model_id) || '',
    summary: (meta && meta.summary) || '',
    meta: JSON.stringify((meta && meta.meta) || {}),
    created_at: (meta && meta.created_at) || new Date().toISOString(),
    updated_at: (meta && meta.updated_at) || (meta && meta.created_at) || new Date().toISOString()
  }
  S.upsertSession(rec)
  const msgs = await readTranscript(task, sid)
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      S.upsertMessage({
        id: m.id, task_id: task.id, role: m.role, content: m.content, session_id: sid,
        kind: m.kind, run_id: m.run_id, meta: JSON.stringify(slimMeta(m.meta)), created_at: m.created_at || rec.created_at
      })
    }
  }
  return rec
}

// 双向按 id 合并（文件优先），不丢数据、可重复执行
async function mergeSession(task, S, session) {
  const sid = session.id
  const fileMsgs = await readTranscript(task, sid)
  if (fileMsgs == null) return // 远程不可读：保留 DB 缓存
  const dbMsgs = S.listMessages(task.id, sid)
  const dbById = new Map(dbMsgs.map((m) => [m.id, m]))
  for (const fm of fileMsgs) {
    const slim = slimMeta(fm.meta)
    const slimStr = JSON.stringify(slim)
    const dbm = dbById.get(fm.id)
    if (!dbm) {
      S.upsertMessage({ id: fm.id, task_id: task.id, role: fm.role, content: fm.content, session_id: sid, kind: fm.kind, run_id: fm.run_id, meta: slimStr, created_at: fm.created_at || session.created_at })
      continue
    }
    const same = (dbm.content || '') === fm.content && (dbm.kind || 'text') === fm.kind && stableStr(parseMeta(dbm.meta)) === stableStr(slim)
    if (!same) S.upsertMessage({ id: fm.id, task_id: task.id, role: fm.role, content: fm.content, session_id: sid, kind: fm.kind, run_id: fm.run_id, meta: slimStr, created_at: fm.created_at || dbm.created_at })
  }
  const fileIds = new Set(fileMsgs.map((m) => m.id))
  const missing = dbMsgs.filter((m) => m.id && !fileIds.has(m.id))
  if (missing.length) {
    missing.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    const body = missing.map((m) => JSON.stringify(buildRow({
      id: m.id, role: m.role, kind: m.kind, content: m.content, run_id: m.run_id, created_at: m.created_at, meta: parseMeta(m.meta)
    }))).join('\n') + '\n'
    await enqueue(qkey(task.path, sid), () => fileAppend(transcriptPath(task.path, sid), body))
  }
}

async function reconcileTask(task, S) {
  if (!task || !task.path) return
  const disk = new Set(await listSessionIds(task))
  const dbIds = new Set(S.listSessions(task.id).map((s) => s.id))
  // 文件有、DB 无 → 导入
  for (const sid of disk) {
    if (dbIds.has(sid)) continue
    try { await importSession(task, S, sid) } catch (e) { try { console.error('[sessionFiles] import ' + e.message) } catch {} }
  }
  // DB 有、文件无 → 导出（惰性迁移）；两边都有 → 双向合并
  for (const s of S.listSessions(task.id)) {
    try {
      if (!disk.has(s.id)) await exportFromDb(task, S, s.id)
      else await mergeSession(task, S, s)
    } catch (e) { try { console.error('[sessionFiles] sync ' + e.message) } catch {} }
  }
}

module.exports = {
  sessionDir, transcriptPath, metaPath, parseMeta, slimMeta,
  appendMessage, appendUpdate, writeMeta, readMeta, listSessionIds, readTranscript,
  removeSessionDir, exportFromDb, importSession, reconcileTask
}
