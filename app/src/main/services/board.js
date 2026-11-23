// 任务看板（短期任务）：卡片复用 tasks(scope='board') + 会话/聊天管线
const fs = require('fs')
const path = require('path')
const os = require('os')
const { getStore } = require('./store')
const chat = require('./chat')

function workRoot() {
  const S = getStore()
  return S.workdir || path.join(os.homedir(), 'zzwork-tasks')
}

function boardDir() {
  return path.join(workRoot(), '.zzwork', 'board')
}

function safeName(name) {
  return String(name || 'card').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'card'
}

function uniquePath(base, S) {
  let p = base
  let i = 2
  const used = new Set(S.listTasks().map((t) => path.resolve(t.path || '').toLowerCase()))
  while (used.has(path.resolve(p).toLowerCase()) || fs.existsSync(p)) p = base + '-' + i++
  return p
}

function readMeta(task) {
  try { return JSON.parse(task.meta || '{}') || {} } catch { return {} }
}

function readConfig() {
  const S = getStore()
  try {
    const raw = S.getSetting('board.config', '')
    if (!raw) return { model_id: '', agent_id: '', skillExclude: [], mcpExclude: [] }
    const c = JSON.parse(raw) || {}
    return {
      model_id: c.model_id || '',
      agent_id: c.agent_id || '',
      skillExclude: Array.isArray(c.skillExclude) ? c.skillExclude : [],
      mcpExclude: Array.isArray(c.mcpExclude) ? c.mcpExclude : []
    }
  } catch { return { model_id: '', agent_id: '', skillExclude: [], mcpExclude: [] } }
}

function saveConfig(cfg) {
  const S = getStore()
  const clean = {
    model_id: (cfg && cfg.model_id) || '',
    agent_id: (cfg && cfg.agent_id) || '',
    skillExclude: Array.isArray(cfg && cfg.skillExclude) ? cfg.skillExclude : [],
    mcpExclude: Array.isArray(cfg && cfg.mcpExclude) ? cfg.mcpExclude : []
  }
  S.setSetting('board.config', JSON.stringify(clean))
  return clean
}

const ORDER = { todo: 0, doing: 1, review: 2, done: 3 }

// AI 作答结束（run 成功）后把卡片从进行中推到待审核；stopped/error 保持进行中便于重试
function toReview(taskId) {
  const S = getStore()
  try {
    const t = S.getTask(taskId)
    if (t && (t.scope || 'long') === 'board' && t.status === 'doing') S.updateTask(taskId, { status: 'review' })
  } catch {}
}

function list() {
  const S = getStore()
  return S.listTasks()
    .filter((t) => (t.scope || 'long') === 'board')
    .sort((a, b) => (ORDER[a.status] ?? 1) - (ORDER[b.status] ?? 1) || String(a.created_at).localeCompare(String(b.created_at)))
    .map((t) => ({ ...t, meta: readMeta(t) }))
}

function create(p) {
  const S = getStore()
  const title = String((p && p.title) || '').trim() || '未命名卡片'
  const content = String((p && p.content) || '')
  const target = uniquePath(path.join(boardDir(), safeName(title)), S)
  return S.createTask({
    name: title, type: 'work', scope: 'board', status: 'todo', path: target,
    agentId: 'builtin', meta: { content }
  })
}

function update(p) {
  const S = getStore()
  const task = S.getTask(p && p.id)
  if (!task) throw new Error('卡片不存在')
  const patch = {}
  if (p.title !== undefined) patch.name = String(p.title).trim() || task.name
  if (p.content !== undefined) patch.meta = JSON.stringify({ ...readMeta(task), content: String(p.content) })
  return S.updateTask(task.id, patch)
}

function applyExclusions(S, taskId, cfg) {
  for (const id of cfg.skillExclude || []) { try { S.setTaskSkillExcluded(taskId, id, true) } catch {} }
  for (const id of cfg.mcpExclude || []) { try { S.setTaskMcpExcluded(taskId, id, true) } catch {} }
}

async function start(p) {
  const S = getStore()
  const task = S.getTask(p && p.id)
  if (!task) throw new Error('卡片不存在')
  const cfg = readConfig()
  try { fs.mkdirSync(task.path, { recursive: true }) } catch {}
  const patch = { status: 'doing' }
  const agentId = p.agent_id !== undefined ? p.agent_id : cfg.agent_id
  if (agentId) patch.agent_id = agentId
  const modelId = p.model_id !== undefined ? p.model_id : cfg.model_id
  if (modelId) patch.model_id = modelId
  S.updateTask(task.id, patch)
  applyExclusions(S, task.id, cfg)

  const session = S.ensureSession(task.id)
  const msgs = S.listMessages(task.id, session.id)
  let runId = ''
  if (!msgs.length) {
    const content = readMeta(task).content || ''
    const r = await chat.send({
      taskId: task.id, sessionId: session.id, text: `【任务】${task.name}\n【内容】${content}`,
      onFinish: ({ status }) => { if (status === 'done') toReview(task.id) }
    })
    runId = (r && r.runId) || ''
  }
  return { ok: true, taskId: task.id, sessionId: session.id, runId }
}

// 进行中卡片的追问：先回到进行中，作答成功后再落到待审核
async function sendMessage(p) {
  const S = getStore()
  const task = S.getTask(p && p.id)
  if (!task) throw new Error('卡片不存在')
  if (task.status !== 'doing') S.updateTask(task.id, { status: 'doing' })
  const r = await chat.send({
    taskId: task.id, sessionId: p.sessionId, text: p.text,
    onFinish: ({ status }) => { if (status === 'done') toReview(task.id) }
  })
  return { ok: true, runId: (r && r.runId) || '', sessionId: (r && r.sessionId) || (p.sessionId || '') }
}

function finish(p) {
  const S = getStore()
  const task = S.getTask(p && p.id)
  if (!task) throw new Error('卡片不存在')
  return S.updateTask(task.id, { status: 'done' })
}

function session(p) {
  const S = getStore()
  const task = S.getTask(p && p.id)
  if (!task) throw new Error('卡片不存在')
  return { sessionId: S.ensureSession(task.id).id }
}

module.exports = {
  getConfig: readConfig,
  saveConfig,
  list,
  create,
  update,
  start,
  send: sendMessage,
  finish,
  session,
  register(ipcMain) {
    ipcMain.handle('zz:board:config', () => readConfig())
    ipcMain.handle('zz:board:saveConfig', (_e, p) => saveConfig(p))
    ipcMain.handle('zz:board:list', () => list())
    ipcMain.handle('zz:board:create', (_e, p) => create(p))
    ipcMain.handle('zz:board:update', (_e, p) => update(p))
    ipcMain.handle('zz:board:start', (_e, p) => start(p))
    ipcMain.handle('zz:board:send', (_e, p) => sendMessage(p))
    ipcMain.handle('zz:board:finish', (_e, p) => finish(p))
    ipcMain.handle('zz:board:session', (_e, p) => session(p))
  }
}
