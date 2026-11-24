// AI 会话服务：按会话选择执行体/模型；内置模型流式 + CLI 执行体；变更注入、摘要、简介、子代理编排
const fs = require('fs')
const path = require('path')
const { chatStream } = require('../../core/ai')
const { runAgent, detectAgents, KNOWN_AGENTS } = require('../../core/agentRunner')
const { resolveTaskEnv, parseRemotePath, GLOBAL_ENV } = require('../../core/envs')
const { getStore } = require('./store')
const secrets = require('./secrets')
const changes = require('./changes')
const remotefs = require('./remotefs')
const sessionFiles = require('./sessionFiles')
const { taskJoin, readTextFile, writeTaskTextFile, listTaskDir } = require('./taskfiles')

const runs = new Map()
// 后台 shell（Claude run_in_background 启动的常驻命令）：按会话归集，随会话 meta 持久化
const shells = new Map() // sessionId -> Map(shellId -> shell)
const SHELL_LIMIT = 30
let seq = 0
let getWin = null

// run id 需在进程重启后仍唯一：DB 里已有历史 run，纯自增会撞主键
function nextRunId() {
  seq += 1
  return `run-${Date.now().toString(36)}-${seq.toString(36)}`
}

const HISTORY_CHARS = 24000
const MEMORY_LIMIT = 4000
const KEYINFO_LIMIT = 4000
const BRIEF_LIMIT = 4000

// 图片附件：仅接受位图，缩略图存消息 meta，全分辨率 dataUrl 只在本轮内存流转
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const IMG_MAX_BYTES = 8 * 1024 * 1024
const ATT_MAX = 30

function post(payload) {
  const win = getWin && getWin()
  if (win && !win.isDestroyed()) win.webContents.send('zz:chat:event', payload)
}

// 辅助 LLM 调用（功能网络/实现逻辑/摘要/简介）可见化：在对话里以可折叠卡片展示 start → done/error
function auxStart(taskId, sessionId, title) {
  const S = getStore()
  let sid = sessionId
  if (!sid) {
    try { const ss = S.listSessions(taskId).filter((s) => s.kind !== 'ask'); sid = ss.length ? ss[0].id : '' } catch {}
  }
  let messageId = ''
  try { messageId = S.addMessage(taskId, 'assistant', '', { sessionId: sid, kind: 'aux', meta: { title, status: 'running' } }) } catch {}
  post({ taskId, sessionId: sid, type: 'aux', messageId, title, status: 'running' })
  const finalize = (m) => {
    try { if (messageId) S.updateMessage(messageId, { meta: JSON.stringify(m) }) } catch {}
    post({ taskId, sessionId: sid, type: 'aux', messageId, title, status: m.status, summary: m.summary || '', details: m.details || '' })
  }
  return {
    messageId,
    done(summary, details) { finalize({ title, status: 'done', summary: summary || '', details: details || '' }) },
    error(msg) { finalize({ title, status: 'error', summary: msg || '失败' }) }
  }
}

function envLabelOf(env) {
  if (!env) return '本机'
  if (env.kind === 'wsl') return `WSL:${env.distro || (env.config && env.config.distro) || ''}`
  if (env.kind === 'ssh') {
    const c = env.config || {}
    const u = env.user || c.user, h = env.host || c.host
    return `SSH:${u ? u + '@' : ''}${h || ''}`
  }
  return '本机'
}

// 任务 -> 环境（含 ssh 密码）；执行体、变更检测、Skills 选择共用
function taskEnv(S, task) {
  const env = resolveTaskEnv(S, task)
  if (env.kind === 'ssh' && !env.secret) env.secret = secrets.get('zzwork.ssh.' + env.id) || ''
  return env
}

// 任务内路径拼接：ssh:// 用 POSIX 分隔符，其余用本地 path

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(String(dataUrl || ''))
  return m ? { mime: m[1].toLowerCase(), data: m[2] } : null
}

// 缩略图只用于气泡展示：限制为位图 dataURL 且体积可控
function safeThumb(t) {
  const s = String(t || '')
  return /^data:image\/(png|jpeg|webp|gif);base64,/.test(s) && s.length <= 300000 ? s : ''
}

// 把前端粘贴的图片写到任务目录 .zzwork/uploads（兼容 local/UNC/ssh），坏图跳过不中断
async function persistAttachments({ task, attachments }) {
  const out = []
  if (!task || !task.path || !Array.isArray(attachments)) return out
  const list = attachments.slice(0, ATT_MAX)
  for (let i = 0; i < list.length; i++) {
    const a = list[i] || {}
    const d = parseDataUrl(a.dataUrl)
    const ext = d && IMG_EXT[d.mime]
    if (!ext) continue
    const buf = Buffer.from(d.data, 'base64')
    if (!buf.length || buf.length > IMG_MAX_BYTES) continue
    const name = `img-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}.${ext}`
    const target = taskJoin(task.path, '.zzwork', 'uploads', name)
    try {
      if (parseRemotePath(target)) {
        const rf = parseRemotePath(target)
        await remotefs.writeBase64(rf.envId, rf.remotePath, buf.toString('base64'))
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, buf)
      }
      out.push({ name, path: target, rel: '.zzwork/uploads/' + name, mime: d.mime, size: buf.length, thumb: safeThumb(a.thumb), dataUrl: a.dataUrl })
    } catch { /* 单张失败不影响其余 */ }
  }
  return out
}

function parseMeta(s) {
  if (!s) return {}
  if (typeof s === 'object') return s
  try { return JSON.parse(s) } catch { return {} }
}

function publicSession(s) {
  if (!s) return null
  const m = parseMeta(s.meta)
  return {
    id: s.id, task_id: s.task_id, parent_session_id: s.parent_session_id || '', kind: s.kind || 'chat',
    title: s.title || '会话', agent_id: s.agent_id || '', model_id: s.model_id || '',
    summary: s.summary || '', created_at: s.created_at, updated_at: s.updated_at,
    checkpoint: m.ck ? { kind: m.ck.kind, head: m.ck.head || '', branch: m.ck.branch || '', at: m.ck.at || 0 } : null
  }
}

function providerOf(S, model) {
  if (!model) return null
  return S.listProviders().find((p) => p.id === model.provider_id) || null
}

function keyOf(S, model) {
  const p = providerOf(S, model)
  if (p) {
    const k = secrets.get('zzwork.key.provider.' + p.id)
    if (k) return k
  }
  return model ? (secrets.get('zzwork.key.' + model.id) || '') : ''
}

function modelLike(S, model) {
  if (!model) return null
  const p = providerOf(S, model)
  return p ? { ...model, type: p.type, base_url: p.base_url } : model
}

function pickDefaultModel(S) {
  const models = S.listModels()
  return models.find((m) => m.is_default) || models[0] || null
}

const KNOWN_AGENT_BY_ID = new Map(KNOWN_AGENTS.map((a) => [a.id, a]))
const FALLBACK_AGENT = { id: 'builtin', name: '内置模型聊天', kind: 'builtin', where: 'local', cmd: '' }
const DETECT_TTL = 10 * 60 * 1000

const refreshingEnvs = new Set()

function persistEnvAgents(S, env, ids) {
  if (!env || !env.id) return
  const set = new Set(ids)
  const list = [{ id: 'builtin', name: '内置模型聊天', ok: true, pkg: '' }]
  for (const a of KNOWN_AGENTS) list.push({ id: a.id, name: a.name || a.id, ok: set.has(a.id), pkg: a.pkg || '' })
  try { S.setSetting('zz:detect:' + env.id, JSON.stringify({ list, at: Date.now() })) } catch {}
}

// 后台探测并把结果写入缓存，供后续任务切换直接命中（不阻塞调用方）
async function refreshEnvAgents(S, env, hadCache) {
  if (!env) return
  const key = env.id || 'local'
  if (refreshingEnvs.has(key)) return
  refreshingEnvs.add(key)
  try {
    const ids = await Promise.race([
      detectAgents(env),
      new Promise((r) => setTimeout(() => r(undefined), env.kind === 'local' ? 12000 : 8000))
    ])
    // 探测为空且已有缓存时不覆盖，避免临时连不上导致误判为无执行体
    if (Array.isArray(ids) && (ids.length || (!hadCache && env.kind === 'local'))) persistEnvAgents(S, env, ids)
  } catch {} finally {
    refreshingEnvs.delete(key)
  }
}

// 该环境可用的执行体 id；命中缓存立即返回。
// blocking=false（任务切换/信息展示）时过期也只在后台刷新，避免 SSH/WSL 探测拖慢切换；
// blocking=true（真正开跑）时才现探测，确保执行体选择准确。
async function envAgentIds(S, env, { blocking = true } = {}) {
  if (!env) return null
  let cached = null
  try {
    const raw = S.getSetting('zz:detect:' + env.id, '')
    if (raw) {
      const d = JSON.parse(raw)
      if (d && Array.isArray(d.list)) cached = { ids: d.list.filter((a) => a.ok).map((a) => a.id), at: Number(d.at) || 0 }
    }
  } catch {}
  if (cached && Date.now() - cached.at < DETECT_TTL) return cached.ids
  if (!blocking) {
    refreshEnvAgents(S, env, !!cached).catch(() => {})
    return cached ? cached.ids : null
  }
  try {
    const ids = await Promise.race([
      detectAgents(env),
      new Promise((r) => setTimeout(() => r(undefined), env.kind === 'local' ? 12000 : 8000))
    ])
    if (Array.isArray(ids) && (ids.length || !cached)) {
      if (ids.length || env.kind === 'local') persistEnvAgents(S, env, ids)
      return ids
    }
  } catch {}
  return cached ? cached.ids : null
}

// 已知 CLI 只有确实装在目标环境里才可用；用户自定义命令（cmd 被改过）一律照常尝试
function agentUsable(agent, available) {
  if (!agent) return false
  if (agent.kind === 'builtin') return true
  if (agent.kind === 'external') return true
  const known = KNOWN_AGENT_BY_ID.get(agent.id)
  if (!known || !available) return true
  const cmd = String(agent.cmd || '').trim()
  if (cmd && cmd !== String(known.cmd || '').trim()) return true
  return available.has(agent.id)
}

// 执行体选择按任务所在环境来：会话/任务绑定优先，其次环境默认执行体，最后环境首个可用 CLI
async function pickAgentModel(S, task, session, opts = {}) {
  const agents = S.listAgents()
  const env = taskEnv(S, task)
  const ids = await envAgentIds(S, env, opts)
  const available = ids ? new Set(ids) : null
  const usableAgents = agents.filter((a) => agentUsable(a, available))
  const envDefault = env && env.config && env.config.defaultAgent
  const boundIds = [
    session && session.agent_id,
    task && task.agent_id,
    envDefault
  ].filter(Boolean)
  let agent = null
  for (const id of boundIds) {
    const a = agents.find((x) => x.id === id)
    if (agentUsable(a, available)) { agent = a; break }
  }
  if (!agent) {
    agent = usableAgents.find((a) => a.kind === 'cli')
      || usableAgents.find((a) => a.kind === 'builtin')
      || agents.find((a) => a.kind === 'builtin')
      || FALLBACK_AGENT
  }
  // 看板卡片以「看板配置」的执行体为准：卡片可能残留创建时的旧 agent_id='builtin'
  // （纯聊天模型没有 shell/工具，会把模型的工具调用标记当正文吐出来）。
  // 配置了可用执行体就用它；未配置时，若当前是 builtin 则升级到工具型 CLI。
  if (task && task.scope === 'board') {
    let boardAgentId = ''
    try { boardAgentId = (JSON.parse(S.getSetting('board.config', '') || '{}') || {}).agent_id || '' } catch {}
    const configured = boardAgentId ? agents.find((a) => a.id === boardAgentId) : null
    if (configured && agentUsable(configured, available)) {
      agent = configured
    } else if (agent.kind === 'builtin') {
      const cli = usableAgents.find((a) => a.kind === 'cli')
      if (cli) agent = cli
    }
  }
  // 绑定在目标环境不可用的执行体时，落定回退结果，避免每次会话都重新猜测
  const taskAgent = agents.find((a) => a.id === (task && task.agent_id))
  const fallbackFrom = taskAgent && !agentUsable(taskAgent, available) && taskAgent.id !== agent.id ? taskAgent : null
  if (fallbackFrom) {
    try { S.updateTask(task.id, { agent_id: agent.id }) } catch {}
    task.agent_id = agent.id
  }
  const sessionAgent = session && session.agent_id ? agents.find((a) => a.id === session.agent_id) : null
  if (sessionAgent && !agentUsable(sessionAgent, available) && sessionAgent.id !== agent.id) {
    try { S.updateSession(session.id, { agent_id: agent.id }) } catch {}
    session.agent_id = agent.id
  }
  const models = S.listModels()
  const model = models.find((m) => m.id === (session && session.model_id))
    || models.find((m) => m.id === (task && task.model_id))
    || models.find((m) => m.is_default)
    || models[0]
    || null
  return { agents, usableAgents, agent, models, model, env, fallbackFrom }
}

// 任务/会话选中的应用模型（含 provider 的 base_url 与 Key），CLI 执行体按它运行
function appModelTarget(S, task, session) {
  const models = S.listModels()
  const model = models.find((m) => m.id === (session && session.model_id))
    || models.find((m) => m.id === (task && task.model_id))
    || models.find((m) => m.is_default)
    || models[0]
    || null
  if (!model) return null
  const provider = providerOf(S, model)
  const baseUrl = String(model.base_url || (provider && provider.base_url) || '').trim()
  const apiKey = keyOf(S, model)
  if (!baseUrl || !apiKey) return null
  return {
    id: model.id,
    name: model.name,
    modelId: String(model.model_id || model.name),
    baseUrl,
    apiKey,
    provider,
    type: String((provider && provider.type) || model.type || 'openai_compatible')
  }
}

const OC_PROVIDER = 'zzwork'

// 生成 opencode 的自定义 provider 配置（OPENCODE_CONFIG_CONTENT 注入），让它走本应用配置的模型
function opencodeConfigContent(target) {
  const anthropic = /anthropic/i.test(target.type + ' ' + target.baseUrl)
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [OC_PROVIDER]: {
        npm: anthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
        name: (target.provider && target.provider.name) || OC_PROVIDER,
        options: { baseURL: target.baseUrl, apiKey: target.apiKey },
        models: { [target.modelId]: { name: target.name || target.modelId } }
      }
    },
    model: OC_PROVIDER + '/' + target.modelId
  }
  return JSON.stringify(cfg)
}

// 执行体按选中模型运行的参数：模型 id / 环境变量 / 额外启动参数
function cliProviderArgs(agent, target) {
  if (!target || !agent || agent.kind === 'builtin') return null
  if (agent.id === 'opencode') {
    return {
      model: OC_PROVIDER + '/' + target.modelId,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent(target) }
    }
  }
  if (agent.id === 'codex') {
    return {
      model: target.modelId,
      envVars: { ZZWORK_API_KEY: target.apiKey },
      extraArgs: [
        '-c', 'model_provider=' + OC_PROVIDER,
        '-c', 'model_providers.' + OC_PROVIDER + '.name=' + OC_PROVIDER,
        '-c', 'model_providers.' + OC_PROVIDER + '.base_url=' + target.baseUrl,
        '-c', 'model_providers.' + OC_PROVIDER + '.env_key=ZZWORK_API_KEY',
        '-c', 'model_providers.' + OC_PROVIDER + '.wire_api=responses'
      ]
    }
  }
  // claude-code 走 Anthropic 消息协议（<base>/v1/messages）：OpenAI 兼容网关只要支持该协议即可直接注入
  if (agent.id === 'claude-code') {
    const base = String(target.baseUrl).replace(/\/+$/, '').replace(/\/v1$/i, '')
    const native = /api\.anthropic\.com/i.test(base)
    return {
      model: target.modelId,
      envVars: {
        ANTHROPIC_BASE_URL: base,
        ...(native ? { ANTHROPIC_API_KEY: target.apiKey } : { ANTHROPIC_AUTH_TOKEN: target.apiKey }),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
      }
    }
  }
  return null
}

function resolveSession(S, taskId, sessionId) {
  if (sessionId) {
    const s = S.getSession(sessionId)
    if (s && s.task_id === taskId) return s
  }
  return S.ensureSession(taskId)
}

async function readMemory(task) {
  if (!task || !task.path) return ''
  return readTextFile(taskJoin(task.path, '.zzwork', 'memory.md'), MEMORY_LIMIT)
}

// 任务关键信息（账号、密钥、人名等）：用户手写或执行体写入 .zzwork/keyinfo.md
async function readKeyInfo(task) {
  if (!task || !task.path) return ''
  return readTextFile(taskJoin(task.path, '.zzwork', 'keyinfo.md'), KEYINFO_LIMIT)
}

async function readInfo(task) {
  if (!task || !task.path) return ''
  const next = await readTextFile(taskJoin(task.path, '.zzwork', 'info.md'), BRIEF_LIMIT)
  if (next) return next
  // 兼容旧任务：根目录 info.md 首次读取时迁入 .zzwork
  const legacy = taskJoin(task.path, 'info.md')
  const old = await readTextFile(legacy, BRIEF_LIMIT)
  if (old && !parseRemotePath(task.path)) {
    try {
      const dir = path.join(task.path, '.zzwork')
      fs.mkdirSync(dir, { recursive: true })
      fs.renameSync(path.join(task.path, 'info.md'), path.join(dir, 'info.md'))
    } catch {}
  }
  return old
}

// 画板摘要：用户可能在画板上用图形/文字表达诉求；随下一次请求携带，注入后标记已发送
function boardDigest(S, task) {
  if (!task) return { text: '', hash: '' }
  const raw = S.getSetting('session:canvas:' + task.id, '')
  if (!raw) return { text: '', hash: '' }
  let data = null
  try { data = JSON.parse(raw) } catch { return { text: '', hash: '' } }
  if (!data || typeof data !== 'object') return { text: '', hash: '' }
  const shapes = Array.isArray(data.shapes) ? data.shapes
    : (Array.isArray(data.strokes) ? data.strokes.map((s) => ({ type: 'pen', points: s && s.pts })) : [])
  const edges = Array.isArray(data.edges) ? data.edges : []
  const NAME = { rect: '矩形', roundRect: '圆角矩形', ellipse: '椭圆', diamond: '菱形', text: '文字', note: '便签', pen: '笔迹' }
  const label = (s) => {
    if (!s) return '图形'
    const t = s.text ? String(s.text).replace(/\s+/g, ' ').trim() : ''
    return (NAME[s.type] || '图形') + (t ? '「' + t.slice(0, 120) + '」' : '')
  }
  const byId = new Map(shapes.filter((s) => s && s.id).map((s) => [s.id, s]))
  const lines = []
  let penCount = 0
  for (const s of shapes) {
    if (!s) continue
    if (s.type === 'pen') { penCount++; continue }
    lines.push('- ' + label(s))
  }
  if (penCount) lines.push(`- 自由笔迹 ${penCount} 条（略）`)
  for (const e of edges) {
    const a = byId.get(e && e.from), b = byId.get(e && e.to)
    if (!a || !b) continue
    const lb = e.label ? '（' + String(e.label).slice(0, 60) + '）' : ''
    lines.push(`- ${label(a)} → ${label(b)}${lb}`)
  }
  if (!lines.length) return { text: '', hash: '' }
  return { text: '【画板（用户与你的图形交互）】\n' + lines.join('\n'), hash: raw }
}

// 生成画板摘要并在注入后标记已发送版本（未发送改动由前端角标提示）
function boardPart(S, task) {
  let r = { text: '', hash: '' }
  try { r = boardDigest(S, task) } catch { return '' }
  if (!r.text) return ''
  try {
    if (S.getSetting('session:canvasSent:' + task.id, '') !== r.hash) {
      S.setSetting('session:canvasSent:' + task.id, r.hash)
    }
    post({ taskId: task.id, type: 'board-sent' })
  } catch {}
  return r.text
}

async function appendChatFile(task, role, content, meta) {
  try {
    if (!task || !task.path) return
    const stamp = new Date().toTimeString().slice(0, 8)
    const m = meta || {}
    const tag = [m.sessionTitle ? 'session=' + m.sessionTitle : '', m.agentName ? 'agent=' + m.agentName : '',
      m.modelName ? 'model=' + m.modelName : ''].filter(Boolean).join(' · ')
    const head = `## ${role === 'user' ? '用户' : 'AI'} · ${stamp}${tag ? ' · ' + tag : ''}\n\n`
    const body = head + String(content || '').trim() + '\n\n'
    const r = parseRemotePath(task.path)
    if (r) {
      const dir = taskJoin(task.path, '.zzwork', 'chat')
      const file = taskJoin(dir, new Date().toISOString().slice(0, 10) + '.md')
      const rf = parseRemotePath(file)
      await remotefs.appendText(rf.envId, rf.remotePath, body)
      return
    }
    const dir = path.join(task.path, '.zzwork', 'chat')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, new Date().toISOString().slice(0, 10) + '.md')
    fs.appendFileSync(file, body)
  } catch {}
}

function approxTokens(text) { return Math.max(1, Math.ceil(String(text || '').length / 4)) }

// 无 usage（CLI 执行体或兼容网关不回传）时按文本量估算输入/输出，保证前端始终能显示「输入/输出」拆分
function contentText(c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' ? b.text : '')).join('')
  return ''
}
function estimateInputTokens(sys, history) {
  const sysText = typeof sys === 'string' ? sys : contentText(sys)
  const histText = (history || []).map((m) => contentText(m.content)).join('\n')
  return approxTokens(sysText + '\n' + histText)
}

// 按事件到达顺序把一轮输出记成 parts（思考/工具/正文交错），并带上各段耗时
function createTurnLog() {
  const t0 = Date.now()
  const parts = []
  let lastPart = null
  const closeThink = () => {
    if (lastPart && lastPart.t === 'think' && lastPart.ms == null) lastPart.ms = Date.now() - lastPart.t0
  }
  const api = {
    parts,
    think(text) {
      if (!text) return
      if (lastPart && lastPart.t === 'think') {
        lastPart.text += text
      } else {
        lastPart = { t: 'think', text, t0: Date.now() }
        parts.push(lastPart)
      }
    },
    text(text) {
      if (!text) return
      closeThink()
      if (lastPart && lastPart.t === 'text') lastPart.text += text
      else {
        lastPart = { t: 'text', text }
        parts.push(lastPart)
      }
    },
    step(st) {
      if (!st || !st.id) return null
      closeThink()
      let p = parts.find((x) => x.t === 'tool' && x.id === st.id)
      if (!p) {
        p = { t: 'tool', id: st.id, name: st.name || '步骤', detail: st.detail || '', status: st.status || 'running', t0: Date.now() }
        if (st.input !== undefined) p.input = st.input
        if (st.output !== undefined) p.output = st.output
        parts.push(p)
        lastPart = p
      } else {
        if (st.name) p.name = st.name
        if (st.detail != null) p.detail = st.detail
        if (st.status) p.status = st.status
        // 完整工具输入/输出只用于落盘（文件全量），渲染取 detail
        if (st.input !== undefined) p.input = st.input
        if (st.output !== undefined) p.output = st.output
      }
      if (p.status && p.status !== 'running' && p.ms == null) p.ms = Date.now() - p.t0
      return p
    },
    finish() {
      closeThink()
      for (const p of parts) if (p.t === 'tool' && p.status === 'running') {
        p.status = 'done'
        if (p.ms == null) p.ms = Date.now() - p.t0
      }
      const out = parts.map((p) => {
        if (p.t === 'text') return { t: 'text', text: p.text }
        if (p.t === 'think') return { t: 'think', text: p.text, ms: p.ms }
        const o = { t: 'tool', id: p.id, name: p.name, detail: p.detail || '', status: p.status, ms: p.ms }
        if (p.input !== undefined) o.input = p.input
        if (p.output !== undefined) o.output = p.output
        return o
      })
      return { parts: out, durationMs: Date.now() - t0 }
    }
  }
  return api
}

async function init(taskId, sessionId) {
  const S = getStore()
  const task = S.getTask(taskId)
  if (!task) return { task: null, messages: [], sessions: [] }
  // 打开任务时把 .zzwork/sessions 与 DB 缓存双向收敛（文件为准 + 旧数据惰性迁移）
  try { await sessionFiles.reconcileTask(task, S) } catch {}
  const session = resolveSession(S, taskId, sessionId)
  // 任务切换路径：不阻塞在执行体探测上，命中缓存即可，过期后后台刷新
  const { agent, model, env, fallbackFrom } = await pickAgentModel(S, task, session, { blocking: false })
  const messages = S.listMessages(taskId, session.id)
  const chars = messages.reduce((n, m) => n + String(m.content || '').length, 0)
  const sessions = S.listSessions(taskId).filter((s) => s.kind !== 'ask').map(publicSession)
  const agentNotice = fallbackFrom
    ? `执行体「${fallbackFrom.name}」在${envLabelOf(env)}不可用，已切换为「${agent.name}」`
    : ''
  return {
    task,
    session: publicSession(session),
    sessions,
    agentId: agent.id,
    agentName: agent.name,
    agentKind: agent.kind,
    agentNotice,
    modelId: model ? model.id : '',
    modelName: model ? model.name : '',
    envLabel: envLabelOf(env),
    brief: task.brief || '',
    memory: await readMemory(task),
    messages,
    // 本轮还在跑的助手消息只在内存里（收尾才落库），切回任务时用它重建气泡
    live: liveSnapshot(task.id, session.id),
    shells: shellList(session.id),
    models: S.listModels().map((m) => ({ id: m.id, name: m.name, provider_id: m.provider_id })),
    usage: { messages: messages.length, chars, tokens: Math.ceil(chars / 4) }
  }
}

function liveSnapshot(taskId, sessionId) {
  for (const [runId, entry] of runs) {
    if (!entry || entry.taskId !== taskId || entry.sessionId !== sessionId) continue
    const snap = typeof entry.snapshot === 'function' ? entry.snapshot() : {}
    return {
      runId,
      startedAt: entry.startedAt || null,
      content: snap.content || '',
      thinking: snap.thinking || '',
      parts: Array.isArray(snap.parts) ? snap.parts : [],
      plan: Array.isArray(snap.plan) ? snap.plan : [],
      asks: entry.asks ? [...entry.asks].map(([requestId, input]) => ({ requestId, input })) : []
    }
  }
  return null
}

// 正在等待用户回答 AskUserQuestion 的任务（运行未结束但被提问阻塞）
function listAwaiting() {
  const S = getStore()
  const ids = new Set()
  for (const e of runs.values()) {
    if (!e || !e.asks || e.asks.size === 0 || !e.taskId) continue
    // 仅面向用户的顶层会话（隐藏询问/子代理的提问无法在便签里回答，不计入）
    let kind = ''
    try { const sess = e.sessionId ? S.getSession(e.sessionId) : null; kind = sess ? sess.kind : '' } catch {}
    if (kind === 'chat' && !e.parentRunId) ids.add(e.taskId)
  }
  return [...ids]
}

function finishRun(runId, status, result, usage) {
  const S = getStore()
  const entry = runs.get(runId)
  const u = usage || {}
  const input = Number(u.input) || 0
  const output = Number(u.output) || 0
  const cached = Number(u.cached) || 0
  try {
    S.updateRun(runId, {
      status, result: String(result || ''), tokens: (input + output) || approxTokens(result),
      input_tokens: input, output_tokens: output, cached_tokens: cached,
      finished_at: new Date().toISOString()
    })
  } catch {}
  // 面向用户的会话（kind='chat'）在顶层轮次结束时记为「有未读的 AI 回复」；
  // 隐藏询问(ask)/子代理(subagent)与子轮次不算，避免干扰未读标记
  if (entry && status !== 'stopped') {
    let kind = ''
    try { const sess = entry.sessionId ? S.getSession(entry.sessionId) : null; kind = sess ? sess.kind : '' } catch {}
    if (kind === 'chat' && !entry.parentRunId) {
      markTaskReply(S, entry.taskId)
      post({ type: 'unread', taskId: entry.taskId })
    }
  }
  if (entry && entry.onFinish) { try { entry.onFinish({ status, result: String(result || ''), usage: usage || null }) } catch {} }
  runs.delete(runId)
}

// 记录任务「最近一次 AI 回复结束」时间，供渲染层与 ui:taskRead 比较得出未读
function markTaskReply(S, taskId) {
  if (!taskId) return
  try {
    let m = {}
    try { m = JSON.parse(S.getSetting('ui:taskReplyAt', '') || '{}') || {} } catch {}
    m[taskId] = Date.now()
    const keys = Object.keys(m)
    if (keys.length > 800) {
      keys.sort((a, b) => (m[a] || 0) - (m[b] || 0))
      for (const k of keys.slice(0, keys.length - 600)) delete m[k]
    }
    S.setSetting('ui:taskReplyAt', JSON.stringify(m))
  } catch {}
}

function sessionMetaUpdate(S, sessionId, patch) {
  const s = S.getSession(sessionId)
  if (!s) return
  const meta = { ...parseMeta(s.meta), ...patch }
  S.updateSession(sessionId, { meta: JSON.stringify(meta) })
  return meta
}

// 会话的后台 shell：首次访问从会话 meta 恢复（应用重启后仍可见）
function shellMap(S, sessionId) {
  let m = shells.get(sessionId)
  if (m) return m
  m = new Map()
  try {
    const arr = parseMeta(S.getSession(sessionId) && S.getSession(sessionId).meta).bgShells
    if (Array.isArray(arr)) for (const sh of arr) if (sh && sh.id) m.set(sh.id, sh)
  } catch {}
  shells.set(sessionId, m)
  return m
}

function shellPersist(S, sessionId, m) {
  const arr = [...m.values()].slice(-SHELL_LIMIT)
  sessionMetaUpdate(S, sessionId, { bgShells: arr })
  return arr
}

function shellList(sessionId) {
  const S = getStore()
  return [...shellMap(S, sessionId).values()].filter((s) => s && s.status === 'running')
}

function shellUpsert(S, sessionId, patch) {
  if (!patch || !patch.id) return null
  const m = shellMap(S, sessionId)
  // 只有运行中的后台 shell 需要展示；结束/失败的直接移除
  if (patch.status && patch.status !== 'running') {
    m.delete(patch.id)
    shellPersist(S, sessionId, m)
    return { id: patch.id, removed: true }
  }
  const cur = { ...(m.get(patch.id) || {}), ...patch }
  m.set(cur.id, cur)
  shellPersist(S, sessionId, m)
  return cur
}

function stopShell(p) {
  const S = getStore()
  const sessionId = p && p.sessionId
  if (!sessionId || !p.id) return false
  const m = shellMap(S, sessionId)
  const sh = m.get(p.id)
  if (!sh) return false
  m.delete(p.id)
  shellPersist(S, sessionId, m)
  // 执行体仍在运行：终止其进程树（后台命令是它的子进程）
  const entry = sh.runId ? runs.get(sh.runId) : null
  if (entry && typeof entry.kill === 'function') { try { entry.kill() } catch {} }
  post({ taskId: p.taskId || sh.taskId, sessionId, runId: sh.runId || '', type: 'shell', shell: { id: p.id, removed: true } })
  return true
}

async function send(p) {
  const S = getStore()
  const task = S.getTask(p.taskId)
  const runId = nextRunId()
  if (!task) {
    post({ taskId: p.taskId, runId, type: 'done', error: '任务不存在' })
    return { runId }
  }
  const session = resolveSession(S, p.taskId, p.sessionId)
  const { agent, model, env } = await pickAgentModel(S, task, session)
  S.createRun({
    id: runId, taskId: task.id, sessionId: session.id, parentRunId: p.parentRunId || '',
    agentId: agent.id, modelId: model ? model.id : '', prompt: p.text || ''
  })
  const entry = {
    kill: null, taskId: task.id, sessionId: session.id, childRunIds: new Set(),
    onFinish: p.onFinish || null, aborted: false, parentRunId: p.parentRunId || '',
    startedAt: Date.now(), snapshot: null, asks: null
  }
  runs.set(runId, entry)
  if (p.parentRunId && runs.has(p.parentRunId)) runs.get(p.parentRunId).childRunIds.add(runId)

  const depth = Number(p.depth) || 0
  processRun({ runId, entry, task, session, agent, model, env, prompt: p.text || '', attachments: Array.isArray(p.attachments) ? p.attachments : [], depth }).catch((e) => {
    post({ taskId: task.id, sessionId: session.id, runId, type: 'done', error: e.message })
    finishRun(runId, 'error', '')
  })
  return { runId, sessionId: session.id }
}

async function processRun({ runId, entry, task, session, agent, model, env: envIn, prompt, attachments, depth = 0 }) {
  const S = getStore()
  const post2 = (o) => post({ taskId: task.id, sessionId: session.id, runId, ...o })
  const env = envIn || taskEnv(S, task)
  post2({ type: 'phase', phase: 'changes' })
  let ch = null
  let turnStart = null
  try {
    const collectP = changes.collect({ task, agent, env, ck: parseMeta(session.meta).ck })
      .catch((e) => ({ text: '', summary: '变更检测失败：' + e.message, count: 0, detail: '', ck: null }))
    const turnP = changes.captureTurn(task, env).catch(() => null)
    ch = await collectP
    turnStart = await turnP
  } catch { ch = null }

  if (entry.aborted) {
    try {
      S.addMessage(task.id, 'user', prompt, { sessionId: session.id, runId })
      S.addMessage(task.id, 'assistant', '(已停止)', {
        sessionId: session.id, kind: 'text', runId, meta: { status: 'stopped' }
      })
    } catch {}
    post2({ type: 'done', content: '(已停止)' })
    finishRun(runId, 'stopped', '')
    return
  }

  if (ch && ch.text) {
    const mid = S.addMessage(task.id, 'assistant', ch.summary, {
      sessionId: session.id, kind: 'context', runId,
      meta: { summary: ch.summary, details: ch.detail, count: ch.count }
    })
    post2({
      type: 'context', messageId: mid,
      summary: ch.summary, details: ch.detail, count: ch.count
    })
  } else if (ch && ch.summary) {
    post2({ type: 'phase', phase: 'changes', summary: ch.summary })
  }

  // 图片附件落盘（.zzwork/uploads），全分辨率 dataUrl 仅本轮内存流转、不落 meta
  const savedFull = await persistAttachments({ task, attachments })
  const saved = savedFull.map(({ dataUrl, ...rest }) => rest)
  const userText = prompt || ''

  const mid = S.addMessage(task.id, 'user', userText, {
    sessionId: session.id, runId,
    meta: {
      agentId: agent.id, agentName: agent.name,
      modelId: model ? model.id : '', modelName: model ? model.name : '',
      ...(saved.length ? { attachments: saved } : {})
    }
  })
  const chatLog = [userText, saved.length ? '[图片] ' + saved.map((s) => s.name).join(', ') : ''].filter(Boolean).join('\n\n')
  appendChatFile(task, 'user', chatLog || '(图片)', { sessionTitle: session.title })
  post2({ type: 'user', text: userText, messageId: mid, attachments: saved })

  if (agent.kind === 'builtin') runBuiltin({ runId, task, session, agent, model, changes: ch, env, turnStart, prompt: userText, attachments: savedFull, depth })
  else if (agent.kind === 'external') runExternal({ runId, task, session, agent, prompt: userText })
  else runCli({ runId, task, session, agent, changes: ch, prompt: userText, env, turnStart, attachments: savedFull, depth })
}

// 外部执行体：把本任务的提问转发到远端被分享任务，用远端隐藏会话作答后回填到本地对话
async function runExternal({ runId, task, session, agent, prompt }) {
  const S = getStore()
  const post2 = (o) => post({ taskId: task.id, sessionId: session.id, runId, ...o })
  let answer = ''
  let err = ''
  const pl = require('../../core/shareLink').parseShareLink(agent && agent.link)
  if (!pl) err = '外部执行体链接无效'
  else {
    try {
      const r = await fetch(pl.base + '/s/' + pl.token + '/ask', {
        method: 'POST',
        headers: { 'x-zzwork-share': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ question: prompt, fromTask: task.name })
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) throw new Error(j.error || ('远端返回 HTTP ' + r.status))
      answer = String(j.answer || '（远端无内容）')
    } catch (e) { err = String((e && e.message) || e) }
  }
  if (err) {
    const content = '远程执行体调用失败：' + err
    const mid = S.addMessage(task.id, 'assistant', content, { sessionId: session.id, kind: 'error', runId, meta: { status: 'error' } })
    post2({ type: 'done', content, messageId: mid, error: err })
    finishRun(runId, 'error', '')
    return
  }
  // 远端一次性返回，这里分段回填以复用前端的增量渲染观感
  try {
    const step = Math.max(1, Math.ceil(answer.length / 40))
    for (let i = 0; i < answer.length; i += step) {
      post2({ type: 'delta', text: answer.slice(i, i + step) })
      await new Promise((res) => setTimeout(res, 15))
    }
  } catch {}
  const mid = S.addMessage(task.id, 'assistant', answer, {
    sessionId: session.id, kind: 'text', runId, meta: { agentId: agent.id, agentName: agent.name }
  })
  appendChatFile(task, 'assistant', answer, { sessionTitle: session.title })
  post2({ type: 'done', content: answer, messageId: mid })
  finishRun(runId, 'done', answer)
  scheduleAfterTurn(task.id, session.id)
}

// 回合结束后的文件差异卡片：对话后展示本次改动的文件与 diff
function scheduleTurnDiff({ task, session, runId, env, turnStart }) {
  if (!turnStart) return
  setTimeout(async () => {
    try {
      const d = await changes.turnDiff(task, env, turnStart)
      if (!d || !Array.isArray(d.files) || !d.files.length) return
      const S = getStore()
      const summary = `本次修改 ${d.files.length} 个文件`
      const meta = { files: d.files, note: d.note || '' }
      const mid = S.addMessage(task.id, 'assistant', summary, {
        sessionId: session.id, kind: 'diff', runId, meta
      })
      post({
        taskId: task.id, sessionId: session.id, runId, type: 'diff',
        messageId: mid, summary, files: d.files, note: meta.note
      })
    } catch {}
  }, 40)
}

function buildHistory(S, taskId, sessionId) {
  const session = S.getSession(sessionId)
  const meta = parseMeta(session && session.meta)
  const all = S.listMessages(taskId, sessionId).filter((m) => m.role && (m.kind || 'text') === 'text')
  let list = all
  if (meta.summaryMsgId) {
    const i = all.findIndex((m) => m.id === meta.summaryMsgId)
    if (i >= 0) list = all.slice(i + 1)
  }
  list = list.slice(-40)
  let chars = 0
  const out = []
  for (let i = list.length - 1; i >= 0; i--) {
    const c = String(list[i].content || '')
    if (chars + c.length > HISTORY_CHARS && out.length) break
    chars += c.length
    out.unshift({ role: list[i].role === 'user' ? 'user' : 'assistant', content: c })
  }
  return out
}

// 功能网络 → 紧凑文本摘要（供 system prompt 注入，实现「基于功能编程」）
function featureNetSummary(map) {
  if (!map || !Array.isArray(map.nodes) || !map.nodes.length) return ''
  const kids = new Map()
  for (const n of map.nodes) {
    const p = n.parent || ''
    if (!kids.has(p)) kids.set(p, [])
    kids.get(p).push(n)
  }
  const lines = []
  const seen = new Set()
  const walk = (pid, depth) => {
    if (depth > 6) return
    for (const n of (kids.get(pid) || [])) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      const rw = []
      if (n.reads && n.reads.length) rw.push('读 ' + n.reads.join('、'))
      if (n.writes && n.writes.length) rw.push('写 ' + n.writes.join('、'))
      const pad = depth === 0 ? '- ' : depth === 1 ? '  · ' : '      ‣ '
      lines.push(`${pad}${n.title}${n.desc ? '：' + n.desc : ''}${rw.length ? ' [' + rw.join('；') + ']' : ''}`)
      walk(n.id, depth + 1)
    }
  }
  walk('', 0)
  let text = lines.join('\n')
  if (text.length > 2500) text = text.slice(0, 2500) + '\n…（功能网络过长，已截断）'
  return text
}

// 稳定 system：只放跨轮基本不变的内容（基座/简介/功能网络/记忆/关键信息/摘要/会话提示词）。
// 易变内容（看板、工作区变更、跨任务清单）不进来，避免把 system 尾部的缓存打穿。
async function buildSystem(S, task, session) {
  // 远程分享问答会话：不注入关键信息/会话提示词/记忆，避免密钥与私密内容随远端问答外泄
  const remote = parseMeta(session && session.meta).remote === true
  const parts = [`你是 zzwork 工作助手，当前任务「${task.name}」（类型 ${task.type}）。回答简洁实用。`]
  if (task.brief) parts.push('【任务简介】\n' + task.brief)
  if (task.type === 'code') {
    try {
      const map = await require('./featuremap').readMap(task)
      const net = featureNetSummary(map)
      if (net) parts.push('【功能网络】\n' + net + '\n（改动代码时请对齐这些功能及其数据来源/存储；如需调整功能网络，直接说明即可）')
    } catch {}
  }
  if (!remote) {
    const mem = await readMemory(task)
    if (mem) parts.push('【任务记忆】\n' + mem)
    const keyinfo = await readKeyInfo(task)
    if (keyinfo) parts.push('【关键信息】\n' + keyinfo)
  }
  if (session.summary) parts.push('【会话摘要】\n' + session.summary)
  if (!remote) {
    const prompt = S.getSetting('session:prompt:' + task.id, '')
    if (prompt) parts.push('【本次会话提示词】\n' + prompt)
  }
  return parts.join('\n\n')
}

// 易变尾部：拼到最后一条用户消息末尾（而非 system），使 system+历史 作为稳定前缀命中缓存
function buildTurnTail(S, task, changesText, canAsk) {
  const parts = []
  const board = boardPart(S, task)
  if (board) parts.push(board)
  if (changesText) parts.push(changesText)
  if (canAsk) parts.push(askGuidance(S, task.id))
  return parts.join('\n\n')
}

function appendTailToLast(history, tail) {
  if (!tail) return
  const last = [...history].reverse().find((m) => m.role === 'user')
  if (!last) { history.push({ role: 'user', content: tail }); return }
  if (Array.isArray(last.content)) last.content = [...last.content, { type: 'text', text: '\n\n---\n' + tail }]
  else last.content = String(last.content || '') + '\n\n---\n' + tail
}

// 本轮用户消息 → 多模态内容块（anthropic 用 image 块，其余用 image_url）
function buildUserContent(text, attachments, type) {
  const parts = []
  const t = String(text || '')
  if (t) parts.push({ type: 'text', text: t })
  for (const a of attachments) {
    const d = parseDataUrl(a.dataUrl)
    if (!d) continue
    if (type === 'anthropic') parts.push({ type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } })
    else parts.push({ type: 'image_url', image_url: { url: a.dataUrl } })
  }
  return parts.length ? parts : String(text || '')
}

// ── 跨任务只读询问（@@ASK 协议）──
// 执行体在确实缺少信息时输出 @@ASK{"task":"<名或ID>","q":"问题"}@@，主进程在对方任务的
// 隐藏常驻会话（kind='ask'）里只读问答，再把答案接续回当前 run，继续作答。
const ASK_MAX_ROUNDS = 4
const ASK_MAX_DEPTH = 1
const ASK_MARKER_RE = /@@ASK\s*(\{[\s\S]*?\})@@/g

function parseAskMarkers(text) {
  const out = []
  const s = String(text || '')
  ASK_MARKER_RE.lastIndex = 0
  let m
  while ((m = ASK_MARKER_RE.exec(s)) !== null) {
    try {
      const o = JSON.parse(m[1])
      if (o && (o.task != null || o.q != null)) out.push({ task: String(o.task || '').trim(), q: String(o.q || '').trim() })
    } catch {}
  }
  return out
}

function stripAskMarkers(text) {
  return String(text || '').replace(/@@ASK[\s\S]*?@@/g, '')
}

// 流式安全过滤器：完整 @@ASK{...}@@ 直接移除；未完成的标记先暂存，避免半截协议泄漏到界面
function makeAskFilter() {
  let hold = ''
  const process = (buf) => {
    let out = ''
    let i = 0
    while (i < buf.length) {
      const s = buf.indexOf('@@ASK', i)
      if (s < 0) { out += buf.slice(i); i = buf.length; break }
      out += buf.slice(i, s)
      const close = buf.indexOf('}@@', s)
      if (close < 0) return { out, hold: buf.slice(s) }
      i = close + 3
    }
    return { out, hold: '' }
  }
  return {
    push(text) { const r = process(hold + text); hold = r.hold; return r.out },
    flush() { const h = hold; hold = ''; return h }
  }
}

function askTargetsLine(S, fromTaskId) {
  let tasks = [], groups = []
  try { tasks = S.listTasks().filter((t) => (t.scope || 'long') !== 'board' && t.id !== fromTaskId) } catch {}
  try { groups = S.listGroups() } catch {}
  if (!tasks.length) return ''
  let from = {}
  try { from = S.getTask(fromTaskId) || {} } catch {}
  const curGroup = from.group_id || ''
  const gMap = new Map(groups.map((g) => [g.id, g]))
  const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const kiNames = (t) => { try { const a = parseMeta(t.meta).keyinfoNames || []; return (Array.isArray(a) ? a : []).slice(0, 6) } catch { return [] } }
  const one = (t) => {
    const b = short(t.brief, 80)
    const base = b ? `${t.name}：${b}` : t.name
    const names = kiNames(t)
    return names.length ? `${base}（掌握：${names.join('、')}）` : base
  }
  const gname = (gid) => (gMap.get(gid) || {}).name || '未分组'

  const out = []
  // 本组兄弟任务：带完整简介（最相关，优先让模型判断该问谁）
  const siblings = tasks.filter((t) => (t.group_id || '') === curGroup)
  if (siblings.length) {
    out.push(`【本组 · ${gname(curGroup)}】`)
    for (const t of siblings.slice(0, 20)) out.push('- ' + one(t))
  }
  // 其他组：只给组简介（组简介已含各任务一句话说明），避免把每组的完整简介都塞进来
  const others = new Map()
  for (const t of tasks) {
    const gid = t.group_id || ''
    if (gid === curGroup) continue
    if (!others.has(gid)) others.set(gid, [])
    others.get(gid).push(t)
  }
  if (others.size) {
    out.push('【其他组】')
    let n = 0
    for (const [gid, list] of others) {
      if (n >= 30) break
      const gb = short((gMap.get(gid) || {}).brief, 400)
      out.push(`- ${gname(gid)}：${gb || ('任务：' + list.map((t) => t.name).join('、'))}`)
      n++
    }
  }
  return out.join('\n') + (tasks.length > 40 ? `\n…（共 ${tasks.length} 个可询问任务）` : '')
}

function askGuidance(S, fromTaskId) {
  const line = askTargetsLine(S, fromTaskId)
  const parts = [
    '【跨任务只读询问】若所需信息不在当前上下文/任务记忆/关键信息中，你可以询问其他任务（它们各自拥有独立上下文）。',
    '确实需要时，单独输出一行协议（可一次多条）：',
    '@@ASK{"task":"<任务名或ID>","q":"<具体问题>"}@@',
    '系统会在对方任务的隐藏常驻会话里只读问答，并把答案补给你继续；不要编造对方的信息。'
  ]
  parts.push(line ? '可询问的任务（附简介）：\n' + line : '当前没有可询问的其他任务。')
  return parts.join('\n')
}

function resolveAskTarget(S, spec) {
  const q = String(spec || '').trim()
  if (!q) return null
  const list = S.listTasks().filter((t) => (t.scope || 'long') !== 'board')
  return list.find((x) => x.id === q)
    || list.find((x) => String(x.name) === q)
    || list.find((x) => String(x.name || '').toLowerCase() === q.toLowerCase())
    || list.find((x) => String(x.name || '').includes(q))
    || null
}

// 每个被询问任务常驻一个隐藏会话，持续积累问答上下文
function ensureAskSession(S, target) {
  S.ensureSession(target.id) // 先确保主会话存在，避免隐藏会话被当成主会话
  const list = S.listSessions(target.id).filter((s) => s.kind === 'ask')
  if (list.length) return list[0]
  return S.createSession({ taskId: target.id, kind: 'ask', title: '跨任务询问', agentId: target.agent_id || '', modelId: target.model_id || '' })
}

function askReadOnlyPrompt(fromName, question) {
  return `【跨任务只读询问 · 来自任务「${fromName}」】\n请只依据你已掌握的信息简洁作答，不要修改任何文件、不要执行有副作用的操作，也不要再使用 @@ASK 协议。\n\n问题：\n${question}`
}

function formatAskAnswers(answers) {
  const blocks = (answers || []).map((a) => {
    const head = `问题：${a.q || ''}`
    return a.ok === false ? `${head}\n（无法获取：${a.error || '无结果'}）` : `${head}\n回答：${a.answer || '（对方无内容）'}`
  })
  return `【跨任务询问结果】\n${blocks.join('\n\n')}\n\n请基于以上信息继续完成原任务；如仍缺少其他任务的信息，可继续输出 @@ASK 协议。`
}

async function askTask({ fromTaskId, targetTaskId, targetName, question, depth = 1 }) {
  const S = getStore()
  const from = fromTaskId ? S.getTask(fromTaskId) : null
  const fromName = from ? from.name : '其他任务'
  const target = targetTaskId ? S.getTask(targetTaskId) : resolveAskTarget(S, targetName)
  if (!target) return { ok: false, unresolved: true, task: targetName || targetTaskId || '', q: question, error: '未找到该任务' }
  if ((target.scope || 'long') === 'board') return { ok: false, unresolved: true, task: target.name, q: question, error: '看板任务不能被询问' }
  const ask = ensureAskSession(S, target)
  const answer = await new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(String(v || '')) } }
    try {
      send({ taskId: target.id, sessionId: ask.id, text: askReadOnlyPrompt(fromName, question), depth, onFinish: (r) => done(r && r.result) })
        .then((x) => { if (!x || !x.runId) done('') })
        .catch(() => done(''))
    } catch { done('') }
  })
  return { ok: true, task: target.name, q: question, answer }
}

// 远程分享问答：始终用一个标记为 remote 的隐藏会话作答，强制 builtin（不让远端输入驱动 CLI/代码执行）
function ensureRemoteAskSession(S, target) {
  S.ensureSession(target.id)
  const list = S.listSessions(target.id).filter((s) => s.kind === 'ask' && parseMeta(s.meta).remote === true)
  if (list.length) return list[0]
  return S.createSession({ taskId: target.id, kind: 'ask', title: '远程分享问答', agentId: 'builtin', modelId: '', meta: { remote: true } })
}

// 注入被分享任务的工作区顶层文件树（仅名称），让远端模型有基本上下文
async function remoteFileTree(task) {
  if (!task || !task.path) return ''
  try {
    const list = await listTaskDir(task.path)
    if (!list.length) return ''
    const lines = list.slice(0, 80).map((x) => (x.dir ? '[目录] ' : '') + x.name)
    return '【工作区文件（顶层，仅名称）】\n' + lines.join('\n')
  } catch { return '' }
}

async function askRemote(taskId, question, fromLabel) {
  const S = getStore()
  const target = S.getTask(taskId)
  if (!target) return { ok: false, error: '任务不存在' }
  if ((target.scope || 'long') === 'board') return { ok: false, error: '该任务不支持远程问答' }
  const ask = ensureRemoteAskSession(S, target)
  const tree = await remoteFileTree(target)
  const text = `【远程只读询问 · 来自任务「${fromLabel || '外部任务'}」】\n`
    + '请只依据任务已知信息与下方工作区内容简洁作答；不要修改任何文件、不要执行有副作用的操作，也不要使用 @@ASK 协议。\n\n'
    + `问题：\n${question}` + (tree ? `\n\n${tree}` : '')
  const answer = await new Promise((resolve) => {
    let settled = false
    let timer = null
    const done = (v) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(String(v || '')) }
    timer = setTimeout(() => done('（远端作答超时）'), 120000)
    try {
      send({ taskId: target.id, sessionId: ask.id, text, depth: ASK_MAX_DEPTH, onFinish: (r) => done(r && r.result) })
        .then((x) => { if (!x || !x.runId) done('') })
        .catch(() => done(''))
    } catch { done('') }
  })
  return { ok: true, answer }
}

async function runBuiltin({ runId, task, session, agent, model, changes: ch, env, turnStart, attachments, depth = 0 }) {
  const S = getStore()
  const post2 = (o) => post({ taskId: task.id, sessionId: session.id, runId, ...o })
  if (!model) {
    post2({ type: 'done', error: '未配置模型：请先在「模型」中添加并选择模型' })
    finishRun(runId, 'error', '')
    return
  }
  const key = keyOf(S, model)
  if (!key) {
    S.addMessage(task.id, 'assistant', '(未设置 API Key，已中断)', {
      sessionId: session.id, kind: 'error', runId, meta: { status: 'error' }
    })
    post2({ type: 'needKey', modelId: model.id })
    post2({ type: 'done', error: '未设置 API Key' })
    finishRun(runId, 'error', '')
    return
  }
  const state = { aborted: false }
  const controller = new AbortController()
  const entry = runs.get(runId)
  if (entry) entry.kill = () => { state.aborted = true; controller.abort() }
  const history = buildHistory(S, task.id, session.id)
  // 仅本轮用户消息带图（多模态内容块），历史轮次保持纯文本以控 token
  if (Array.isArray(attachments) && attachments.length) {
    const last = [...history].reverse().find((m) => m.role === 'user')
    if (last) last.content = buildUserContent(last.content, attachments, modelLike(S, model).type)
  }
  const sys = await buildSystem(S, task, session)
  // 看板卡片任务不询问：没人坐等回答，问题只会卡住。看板任务把待确认的问题作为结论输出，卡片转待审核
  const canAsk = depth < ASK_MAX_DEPTH && (task.scope || 'long') !== 'board'
  // 易变的看板/工作区变更/跨任务清单拼到最后一条用户消息，system 保持稳定以命中前缀缓存
  appendTailToLast(history, buildTurnTail(S, task, ch && ch.text ? ch.text : '', canAsk))
  let acc = ''
  let think = ''
  const usage = { input: 0, output: 0, cached: 0 }   // 本轮真实用量（跨 @@ASK 多轮累加）
  const turnLog = createTurnLog()
  {
    // 任务切换回来时 init 用这份快照重建进行中的气泡（步骤只在本轮内存里）
    const runEntry = runs.get(runId)
    if (runEntry) runEntry.snapshot = () => ({ parts: turnLog.parts, content: acc, thinking: think })
  }
  try {
    const meta = {
      agentId: agent.id, agentName: agent.name, modelId: model.id, modelName: model.name, runId
    }
    for (let round = 0; ; round++) {
      const filter = makeAskFilter()
      let roundText = ''
      const u = await chatStream(modelLike(S, model), key, history, sys, (d) => {
        if (state.aborted) return
        roundText += d
        const safe = filter.push(d)
        if (safe) { acc += safe; turnLog.text(safe); post2({ type: 'delta', text: safe }) }
      }, controller.signal, (t) => {
        if (state.aborted) return
        think += t
        turnLog.think(t)
        post2({ type: 'thinking', text: t })
      })
      if (u) { usage.input += u.input || 0; usage.output += u.output || 0; usage.cached += u.cached || 0 }
      const left = filter.flush()
      if (left) { acc += left; turnLog.text(left); post2({ type: 'delta', text: left }) }
      const asks = (canAsk && !state.aborted) ? parseAskMarkers(roundText) : []
      if (!asks.length || round >= ASK_MAX_ROUNDS) break
      const answers = []
      for (const a of asks) {
        if (state.aborted) break
        const stepId = 'ask-' + round + '-' + Math.random().toString(36).slice(2, 6)
        const stepName = '询问任务：' + (a.task || '?')
        turnLog.step({ id: stepId, name: stepName, detail: a.q, status: 'running' })
        post2({ type: 'step', step: { id: stepId, name: stepName, detail: a.q, status: 'running' } })
        const r = await askTask({ fromTaskId: task.id, targetName: a.task, question: a.q, depth: depth + 1 })
        const status = r.ok === false ? 'error' : 'done'
        turnLog.step({ id: stepId, name: stepName, detail: a.q, status })
        post2({ type: 'step', step: { id: stepId, name: stepName, detail: a.q, status } })
        // 无法解析到真实任务（含协议示例占位符）时不追加、不续轮，避免误触发的空转
        if (!r.unresolved) answers.push({ q: a.q, ok: r.ok, answer: r.answer, error: r.error })
      }
      if (state.aborted || !answers.length) break
      history.push({ role: 'assistant', content: stripAskMarkers(roundText) })
      history.push({ role: 'user', content: formatAskAnswers(answers) })
    }
    const fin = turnLog.finish()
    const inputTok = usage.input || estimateInputTokens(sys, history)
    const outputTok = usage.output || approxTokens(acc)
    const fullMeta = {
      ...meta, thinking: think, parts: fin.parts, durationMs: fin.durationMs,
      inputTokens: inputTok, outputTokens: outputTok, cachedTokens: usage.cached
    }
    const cacheMeta = sessionFiles.slimMeta(fullMeta)
    const mid = S.addMessage(task.id, 'assistant', acc, {
      sessionId: session.id, kind: 'text', runId, meta: cacheMeta, fileMeta: fullMeta
    })
    appendChatFile(task, 'assistant', acc, { ...meta, sessionTitle: session.title })
    await changes.saveBaseline(S, session.id, task, env, ch && ch.ck && ch.ck.kind)
    post2({
      type: 'done', content: acc, messageId: mid, tokens: inputTok + outputTok,
      inputTokens: inputTok, outputTokens: outputTok, cachedTokens: usage.cached,
      durationMs: fin.durationMs, parts: cacheMeta.parts
    })
    finishRun(runId, 'done', acc, { input: inputTok, output: outputTok, cached: usage.cached })
    scheduleAfterTurn(task.id, session.id)
    scheduleTurnDiff({ task, session, runId, env, turnStart })
  } catch (e) {
    if (state.aborted) {
      const content = acc + '\n(已停止)'
      const fin = turnLog.finish()
      const fullMeta = { status: 'stopped', thinking: think, parts: fin.parts, durationMs: fin.durationMs }
      const cacheMeta = sessionFiles.slimMeta(fullMeta)
      S.addMessage(task.id, 'assistant', content, {
        sessionId: session.id, kind: 'text', runId, meta: cacheMeta, fileMeta: fullMeta
      })
      post2({ type: 'done', content, durationMs: fin.durationMs, parts: cacheMeta.parts })
      await changes.saveBaseline(S, session.id, task, env, ch && ch.ck && ch.ck.kind)
      finishRun(runId, 'stopped', content)
      scheduleTurnDiff({ task, session, runId, env, turnStart })
    } else {
      post2({ type: 'done', error: e.message })
      try { S.updateRun(runId, { error: e.message, finished_at: new Date().toISOString() }) } catch {}
      finishRun(runId, 'error', '')
    }
  }
}

// CLI 把模型/鉴权错误当普通输出（退出码仍为 0）时，转成明确的错误提示
const CLI_FAIL_RE = /Error:\s*(This model is not available in your country|身份验证失败)|Not logged in|Please run \/login/i
function cliFailureHint(agent, content, model) {
  if (!content || !CLI_FAIL_RE.test(content)) return ''
  const m = model ? `模型「${model}」` : '默认模型'
  if (/Not logged in|Please run \/login/i.test(content)) {
    return `${agent.name} 未获得登录态：请确认「模型」页选中的 provider 网关支持 Anthropic 协议（POST /v1/messages），或先在该环境登录执行体。`
  }
  if (/身份验证失败/.test(content)) {
    return `${agent.name} 的${m}认证失败：请在该环境重新登录执行体（如 opencode auth login）或更换模型。`
  }
  return `${agent.name} 的${m}在当前地区不可用：请在「环境」页为 ${agent.name} 选择其他模型。`
}

async function runCli({ runId, task, session, agent, changes: ch, prompt, env, turnStart, attachments, depth = 0 }) {
  const S = getStore()
  const post2 = (o) => post({ taskId: task.id, sessionId: session.id, runId, ...o })
  const meta = { ...parseMeta(task.meta), ...parseMeta(session.meta) }
  const canAsk = depth < ASK_MAX_DEPTH && (task.scope || 'long') !== 'board'
  let selection = { skills: [], mcps: [] }
  try {
    const tenv = env || resolveTaskEnv(S, task)
    const exS = S.taskExcludedSkills(task.id)
    const exM = S.taskExcludedMcp(task.id)
    // 本机 skills 入库在 global 名下，远端 skills 按环境 id 入库
    const skillEnv = tenv.kind === 'local' ? GLOBAL_ENV : tenv.id
    selection.skills = S.listSkills(skillEnv).filter((s) => !exS.includes(s.id))
    const mcpList = [...S.listMcp(GLOBAL_ENV), ...(tenv.id !== GLOBAL_ENV && tenv.kind !== 'local' ? S.listMcp(tenv.id) : [])]
    selection.mcps = mcpList.filter((m) => !exM.includes(m.id))
  } catch {}

  const extraParts = []
  if (task.brief) extraParts.push('【任务简介】\n' + task.brief.slice(0, 2000))
  // 看板任务：无人实时坐等，禁止交互式提问；待确认的问题作为结论输出，回合结束后卡片转待审核
  if ((task.scope || 'long') === 'board') {
    extraParts.push('【看板任务约束】这是看板自动执行的任务，没有用户实时坐等回答，不要使用任何交互式提问工具。若遇到必须由用户确认/决策的问题，直接把问题本身与你的建议结论写清楚作为回复输出，然后结束本轮；系统会把卡片转「待审核」，由用户在卡片上处理。')
  }
  const mem = await readMemory(task)
  if (mem) extraParts.push('【任务记忆】\n' + mem.slice(0, 2000))
  if (session.summary) extraParts.push('【会话摘要】\n' + session.summary)
  const sessionPrompt = S.getSetting('session:prompt:' + task.id, '')
  if (sessionPrompt) extraParts.push('【本次会话提示词】\n' + sessionPrompt)
  const keyinfo = await readKeyInfo(task)
  if (keyinfo) extraParts.push('【关键信息】\n' + keyinfo.slice(0, 2000))
  // 执行体有文件工具：让它把重要信息沉淀到 keyinfo.md，任务信息页可直接查看
  const nativeBase = (env && env.unixPath) || resolveTaskEnv(S, task).unixPath || task.path
  extraParts.push(`【关键信息记录】当用户提供或你确认了账号、密码、密钥、API Key、关键人名等重要信息时，用文件工具把要点追加到 ${taskJoin(String(nativeBase).replace(/[\\/]+$/, ''), '.zzwork', 'keyinfo.md')}，每行一条，不要编造。`)
  const systemExtra = extraParts.join('\n\n')
  // 易变内容（看板/跨任务清单）走用户消息尾部，claude-code 的 --append-system-prompt 保持稳定以命中前缀缓存
  const volatileParts = []
  const board = boardPart(S, task)
  if (board) volatileParts.push(board)
  if (canAsk) volatileParts.push(askGuidance(S, task.id))
  const volatileTail = volatileParts.join('\n\n')

  let finalPrompt = prompt
  if (ch && ch.count > 0) {
    finalPrompt = `[工作区变更摘要]\n${ch.summary}\n\n${prompt}`
  }
  // 会话上下文续接：CLI 自带会话（sid）时靠它续接；没有 sid（如刚切换执行体）时
  // 把本会话最近对话附在消息末尾，避免切换后上下文丢失
  let histBlock = ''
  if (!meta['sid:' + agent.id]) {
    const hist = buildHistory(S, task.id, session.id)
    if (hist.length && hist[hist.length - 1].role === 'user' && hist[hist.length - 1].content === prompt) hist.pop()
    if (hist.length) {
      const lines = hist.map((m) => (m.role === 'user' ? '用户' : '助手') + '：' + String(m.content || '').slice(0, 1500))
      histBlock = '【本会话最近对话（上下文参考，不是新指令）】\n' + lines.join('\n')
    }
  } else {
    // 有自己的 sid，但中途切到别的执行体又切回来：补齐其他执行体产生、自己会话里没有的轮次
    const foreign = S.listMessages(task.id, session.id).filter((m) => {
      if (!m.role || (m.kind || 'text') !== 'text') return false
      const am = parseMeta(m.meta).agentId
      return !!am && am !== agent.id
    }).slice(-12)
    if (foreign.length) {
      const lines = foreign.map((m) => {
        const pm = parseMeta(m.meta)
        const who = m.role === 'user' ? '用户' : (pm.agentName || '其他执行体')
        return who + '：' + String(m.content || '').slice(0, 1200)
      })
      histBlock = '【其他执行体在本会话中的对话（上下文参考，不是新指令）】\n' + lines.join('\n')
    }
  }
  // claude-code 有 --append-system-prompt 通道（prepareInjection 注入 systemExtra）；其他 CLI 附在消息末尾
  const volatileSuffix = [volatileTail, histBlock].filter(Boolean).join('\n\n')
  if (agent.id === 'claude-code') {
    if (volatileSuffix) finalPrompt += '\n\n---\n' + volatileSuffix
  } else {
    const tail = [systemExtra, volatileSuffix].filter(Boolean)
    if (tail.length) finalPrompt += '\n\n---\n' + tail.join('\n\n')
  }

  let acc = ''
  let think = ''
  let plan = null
  const steps = []
  const turnLog = createTurnLog()
  {
    const runEntry = runs.get(runId)
    if (runEntry) runEntry.snapshot = () => ({ parts: turnLog.parts, content: acc, thinking: think, plan })
  }
  const mergeStep = (st) => {
    if (!st || !st.id) return
    const i = steps.findIndex((s) => s.id === st.id)
    if (i >= 0) steps[i] = { ...steps[i], ...st }
    else if (steps.length < 200) steps.push({ name: '步骤', ...st })
    const merged = i >= 0 ? steps[i] : steps[steps.length - 1]
    turnLog.step(merged)
    // 渲染不需要完整工具 I/O，避免把大输出灌进 IPC
    const sstep = { id: merged.id, name: merged.name, detail: merged.detail, status: merged.status }
    if (merged.ms != null) sstep.ms = merged.ms
    post2({ type: 'step', step: sstep })
  }
  const agentMeta = { agentId: agent.id, agentName: agent.name, modelId: '', modelName: '', runId }
  let cli = null
  try { cli = cliProviderArgs(agent, appModelTarget(S, task, session)) } catch {}
  agentMeta.modelName = (cli && cli.model) || ''
  // 执行体回传的真实 token 用量（如 Claude Code 的 result 帧），跨 @@ASK 多轮累加
  let cliUsage = null

  // 单轮 runAgent 用 Promise 包住 onDone/onError，便于 @@ASK 多轮接续（同一次 run）
  const runRound = (promptText, useAtts) => new Promise((resolve, reject) => {
    const filter = makeAskFilter()
    let roundText = ''
    let settled = false
    const okv = (v) => { if (!settled) { settled = true; resolve(v) } }
    const fail = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))) } }
    runAgent({
      task, agent, env, prompt: promptText, meta, selection, systemExtra,
      attachments: useAtts ? (attachments || []) : [],
      model: cli && cli.model, envVars: cli && cli.envVars, extraArgs: cli && cli.extraArgs,
      onMeta: (k, v) => {
        meta[k] = v
        sessionMetaUpdate(S, session.id, { [k]: v })
      },
      onShell: (sh) => {
        const cur = shellUpsert(S, session.id, {
          ...sh, taskId: task.id, sessionId: session.id, runId
        })
        if (cur) post2({ type: 'shell', shell: cur })
      },
      onDelta: (s) => {
        roundText += s
        const safe = filter.push(s)
        if (safe) { acc += safe; turnLog.text(safe); post2({ type: 'delta', text: safe }) }
      },
      onThinking: (t) => { think += t; turnLog.think(t); post2({ type: 'thinking', text: t }) },
      onStep: mergeStep,
      onPlan: (items) => {
        plan = items
        post2({ type: 'plan', plan: items })
      },
      onDone: (result, usage) => {
        if (usage) {
          cliUsage = cliUsage || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
          cliUsage.input_tokens += Number(usage.input_tokens) || 0
          cliUsage.output_tokens += Number(usage.output_tokens) || 0
          cliUsage.cache_read_input_tokens += Number(usage.cache_read_input_tokens) || 0
          cliUsage.cache_creation_input_tokens += Number(usage.cache_creation_input_tokens) || 0
        }
        const left = filter.flush()
        if (left) { acc += left; turnLog.text(left); post2({ type: 'delta', text: left }) }
        okv({ content: stripAskMarkers((result && result.trim()) ? result : roundText), roundText })
      },
      onError: (err) => fail(err),
      onAsk: ({ requestId, input }) => {
        const e = runs.get(runId)
        if (e) { if (!e.asks) e.asks = new Map(); e.asks.set(requestId, input || {}) }
        post2({ type: 'ask', requestId, input })
      }
    }).then((runner) => {
      const entry = runs.get(runId)
      if (entry) {
        entry.kill = () => { try { runner.kill() } catch {} }
        if (typeof runner.answer === 'function') entry.answer = (requestId, answers) => runner.answer(requestId, answers)
      }
    }).catch((e) => fail(e))
  })

  try {
    let nextPrompt = finalPrompt
    let content = ''
    for (let round = 0; ; round++) {
      const r = await runRound(nextPrompt, round === 0)
      content = acc.trim() ? acc : r.content
      const asks = canAsk ? parseAskMarkers(r.roundText) : []
      if (!asks.length || round >= ASK_MAX_ROUNDS) break
      const ans = []
      for (const a of asks) {
        const cur = runs.get(runId)
        if (cur && cur.aborted) break
        const stepId = 'ask-' + round + '-' + Math.random().toString(36).slice(2, 6)
        const stepName = '询问任务：' + (a.task || '?')
        mergeStep({ id: stepId, name: stepName, detail: a.q, status: 'running' })
        const rr = await askTask({ fromTaskId: task.id, targetName: a.task, question: a.q, depth: depth + 1 })
        mergeStep({ id: stepId, name: stepName, detail: a.q, status: rr.ok === false ? 'error' : 'done' })
        // 无法解析到真实任务（含协议示例占位符）时不追加、不续轮
        if (!rr.unresolved) ans.push({ q: a.q, ok: rr.ok, answer: rr.answer, error: rr.error })
      }
      if (!ans.length) break
      nextPrompt = formatAskAnswers(ans)
    }
    const fin = turnLog.finish()
    const failHint = cliFailureHint(agent, content, cli && cli.model)
    if (failHint) {
      const fullMeta = { ...agentMeta, thinking: think, status: 'error', parts: fin.parts, durationMs: fin.durationMs, plan: plan || undefined }
      const cacheMeta = sessionFiles.slimMeta(fullMeta)
      S.addMessage(task.id, 'assistant', content, {
        sessionId: session.id, kind: 'text', runId, meta: cacheMeta, fileMeta: fullMeta
      })
      appendChatFile(task, 'assistant', content, { ...agentMeta, sessionTitle: session.title })
      post2({ type: 'done', error: failHint })
      finishRun(runId, 'error', content)
      return
    }
    // 优先用执行体回传的真实用量；拿不到时退回文本量估算
    const realIn = cliUsage
      ? (Number(cliUsage.input_tokens) || 0) + (Number(cliUsage.cache_read_input_tokens) || 0) + (Number(cliUsage.cache_creation_input_tokens) || 0)
      : 0
    const inputTok = realIn || estimateInputTokens(finalPrompt, [])
    const outputTok = (cliUsage && Number(cliUsage.output_tokens)) || approxTokens(content)
    const cachedTok = cliUsage ? (Number(cliUsage.cache_read_input_tokens) || 0) : 0
    const fullMeta = {
      ...agentMeta, thinking: think,
      steps: steps.length ? steps : undefined,
      parts: fin.parts, durationMs: fin.durationMs,
      plan: plan || undefined,
      inputTokens: inputTok, outputTokens: outputTok, cachedTokens: cachedTok
    }
    const cacheMeta = sessionFiles.slimMeta(fullMeta)
    const mid = S.addMessage(task.id, 'assistant', content, {
      sessionId: session.id, kind: 'text', runId, meta: cacheMeta, fileMeta: fullMeta
    })
    appendChatFile(task, 'assistant', content, { ...agentMeta, sessionTitle: session.title })
    await changes.saveBaseline(S, session.id, task, env, ch && ch.ck && ch.ck.kind)
    post2({
      type: 'done', content, messageId: mid, tokens: inputTok + outputTok,
      inputTokens: inputTok, outputTokens: outputTok, cachedTokens: cachedTok,
      durationMs: fin.durationMs, parts: cacheMeta.parts, plan: plan || undefined
    })
    finishRun(runId, 'done', content, { input: inputTok, output: outputTok, cached: cachedTok })
    scheduleAfterTurn(task.id, session.id)
    scheduleTurnDiff({ task, session, runId, env, turnStart })
  } catch (e) {
    post2({ type: 'done', error: e.message })
    try { S.updateRun(runId, { error: e.message, finished_at: new Date().toISOString() }) } catch {}
    finishRun(runId, 'error', '')
  }
}

function stop(runId) {
  const entry = runs.get(runId)
  if (entry) {
    entry.aborted = true
    try { entry.kill && entry.kill() } catch {}
    for (const child of entry.childRunIds) {
      try { stop(child) } catch {}
    }
    try { getStore().updateRun(runId, { status: 'stopped', finished_at: new Date().toISOString() }) } catch {}
  }
  return true
}

// ---------- 摘要 / 任务简介 ----------

function heuristicSummary(prev, msgs) {
  const bits = []
  for (const m of msgs.slice(-8)) {
    const text = String(m.content || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    bits.push(`${m.role === 'user' ? '需求' : '结论'}：${text.slice(0, 180)}`)
  }
  const joined = [prev || '', ...bits].filter(Boolean).join('\n')
  return joined.length > 900 ? joined.slice(joined.length - 900) : joined
}

async function summarizeSession(taskId, sessionId) {
  const S = getStore()
  const task = S.getTask(taskId)
  const session = S.getSession(sessionId)
  if (!task || !session) return { ok: false, error: '会话不存在' }
  const all = S.listMessages(taskId, sessionId).filter((m) => m.role && (m.kind || 'text') === 'text')
  const meta = parseMeta(session.meta)
  let slice = all
  if (meta.summaryMsgId) {
    const i = all.findIndex((m) => m.id === meta.summaryMsgId)
    if (i >= 0) slice = all.slice(i + 1)
  }
  if (!slice.length) return { ok: true, summary: session.summary || '' }
  const transcript = slice.map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content).slice(0, 1200)}`).join('\n')
  const model = pickDefaultModel(S)
  const key = keyOf(S, model)
  let summary = ''
  if (model && key) {
    const aux = auxStart(taskId, sessionId, '会话摘要')
    try {
      let acc = ''
      await chatStream(modelLike(S, model), key, [{
        role: 'user',
        content: `已有摘要：\n${session.summary || '（无）'}\n\n新增对话：\n${transcript}`
      }], '你是会话摘要器。用不超过 300 字的中文更新会话摘要，保留目标、关键决定、结论和未完成事项；不要寒暄，不要编造。', (d) => { acc += d })
      summary = acc.trim()
      aux.done(summary ? '已更新会话摘要' : '摘要为空，已回退', summary)
    } catch (e) { aux.error(e && e.message) }
  }
  if (!summary) summary = heuristicSummary(session.summary, slice)
  if (!summary) return { ok: true, summary: session.summary || '' }
  const lastId = all.length ? all[all.length - 1].id : ''
  S.updateSession(sessionId, {
    summary,
    meta: JSON.stringify({ ...meta, summaryMsgId: lastId, summaryAt: new Date().toISOString() })
  })
  post({ taskId, sessionId, type: 'summary', summary })
  refreshBrief(taskId).catch(() => {})
  return { ok: true, summary }
}

function scheduleAfterTurn(taskId, sessionId) {
  setTimeout(() => {
    ;(async () => {
      try { await maybeSummarize(taskId, sessionId) } catch {}
      try { await autoSyncTaskInfo(taskId) } catch {}
      try { await require('./featuremap').maintainVisible(taskId, sessionId) } catch {}
    })()
  }, 800)
}

// 回合结束后自动同步任务简介与关键信息（无需手动刷新）
const keyinfoCache = new Map()   // taskId -> 上次推送给前端的 keyinfo
const autoBriefAt = new Map()    // taskId -> 上次自动刷新简介的时间戳
const AUTO_BRIEF_GAP = 15000

async function autoSyncTaskInfo(taskId) {
  const S = getStore()
  const task = S.getTask(taskId)
  if (!task) return
  // 关键信息：执行体可能在回合中改写了 .zzwork/keyinfo.md
  try {
    const content = await readKeyInfo(task)
    if (keyinfoCache.get(taskId) !== content) {
      keyinfoCache.set(taskId, content)
      post({ taskId, type: 'keyinfo', content })
    }
  } catch {}
  // 简介：有新消息、且距上次自动刷新足够久才重建（避免与摘要刷新重复）
  const msgs = S.listMessages(taskId).filter((m) => (m.kind || 'text') === 'text')
  const last = msgs[msgs.length - 1]
  if (!last) return
  const briefAt = task.brief_at ? Date.parse(task.brief_at) : 0
  if (briefAt && Date.parse(last.created_at || '') <= briefAt) return
  const now = Date.now()
  if (now - (autoBriefAt.get(taskId) || 0) < AUTO_BRIEF_GAP) return
  autoBriefAt.set(taskId, now)
  await refreshBrief(taskId).catch(() => {})
}

async function maybeSummarize(taskId, sessionId) {
  const S = getStore()
  const session = S.getSession(sessionId)
  if (!session) return
  const all = S.listMessages(taskId, sessionId).filter((m) => m.role && (m.kind || 'text') === 'text')
  const meta = parseMeta(session.meta)
  let slice = all
  if (meta.summaryMsgId) {
    const i = all.findIndex((m) => m.id === meta.summaryMsgId)
    if (i >= 0) slice = all.slice(i + 1)
  }
  const chars = slice.reduce((n, m) => n + String(m.content || '').length, 0)
  if (slice.length < 6 && chars < 6000) return
  await summarizeSession(taskId, sessionId)
}

const briefJobs = new Map()   // taskId -> 进行中的刷新，避免并发重复调用

function refreshBrief(taskId, opts) {
  const running = briefJobs.get(taskId)
  if (running) return running
  const p = doRefreshBrief(taskId, opts).finally(() => briefJobs.delete(taskId))
  briefJobs.set(taskId, p)
  return p
}

async function doRefreshBrief(taskId) {
  const S = getStore()
  const task = S.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  const isCode = task.type === 'code'
  const sessions = S.listSessions(taskId).filter((s) => s.kind !== 'ask')
  const summaries = sessions.filter((s) => s.summary).map((s) => `- ${s.title}${s.kind === 'subagent' ? '（子代理）' : ''}: ${s.summary}`)
  const info = await readInfo(task)
  const mem = await readMemory(task)
  const keyinfo = await readKeyInfo(task)
  // code 任务：附带项目文件树 / 关键文件 / 源码抽样，用于梳理全部功能与技术栈
  let digest = ''
  if (isCode) { try { digest = await require('./featuremap').projectDigest(task) } catch {} }
  // 最近几轮对话：摘要尚未生成时，简介也要跟上最新进展
  const recent = S.listMessages(taskId).filter((m) => (m.kind || 'text') === 'text').slice(-8)
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content).slice(0, 600)}`).join('\n')
  const source = [
    `任务：${task.name}（${task.type}）`,
    `路径：${task.path}`,
    digest ? `项目摘要：\n${digest}` : '',
    info ? `.zzwork/info.md 节选：\n${info}` : '',
    summaries.length ? `会话摘要：\n${summaries.join('\n')}` : '',
    recent ? `最近对话：\n${recent}` : '',
    mem ? `任务记忆：\n${mem}` : '',
    keyinfo ? `已有【关键信息】：\n${keyinfo}` : ''
  ].filter(Boolean).join('\n\n')

  const model = pickDefaultModel(S)
  const key = keyOf(S, model)
  let acc = ''
  if (model && key) {
    const aux = auxStart(taskId, '', '任务简介')
    const rule1 = isCode
      ? '1）用不超过 240 字的中文概括该代码项目的**全部功能模块**与**技术栈**（语言、框架、关键依赖、架构分层、数据存储、运行/构建方式）；'
      : '1）用不超过 200 字的中文概括该任务**当前涉及的信息**：做了什么、目标、当前进展、关键决定、涉及的系统/数据与下一步；'
    try {
      await chatStream(modelLike(S, model), key, [{ role: 'user', content: source.slice(0, 14000) }],
        '你是任务简介生成器兼信息提取器。根据材料完成两件事：\n' + rule1 + '\n' +
        '2）仅当材料中出现账号、密码、密钥、API Key、关键人名、联系方式等重要信息时，逐行原样列出（已有的不要重复，不要编造）。\n' +
        '严格按以下格式输出：\n【简介】\n（简介内容）\n【关键信息】\n（每行一条，没有则留空）',
        (d) => { acc += d })
      aux.done('已刷新任务简介', acc.trim())
    } catch (e) { aux.error(e && e.message) }
  }
  let brief = acc.trim()
  let keyLines = []
  const mark = brief.indexOf('【关键信息】')
  if (mark >= 0) {
    keyLines = brief.slice(mark + '【关键信息】'.length).split('\n').map((l) => l.trim()).filter(Boolean)
    brief = brief.slice(0, mark)
  }
  brief = brief.replace(/^【简介】\s*/, '').trim()
  if (!brief) {
    const parts = []
    if (info) parts.push(info.replace(/\s+/g, ' ').slice(0, 600))
    if (summaries.length) parts.push(summaries.join(' '))
    brief = parts.join(' ').slice(0, 800) || '（暂无足够信息生成简介）'
  }
  // 新提取到的关键信息并入 keyinfo.md，并推送给信息页
  if (keyLines.length) {
    try {
      const cur = await readKeyInfo(task)
      const lines = cur.split('\n').map((l) => l.trim()).filter(Boolean)
      const seen = new Set(lines)
      let added = false
      for (const line of keyLines) { if (!seen.has(line)) { seen.add(line); lines.push(line); added = true } }
      if (added) {
        const merged = lines.join('\n')
        await writeTaskTextFile(taskJoin(task.path, '.zzwork', 'keyinfo.md'), merged + '\n')
        keyinfoCache.set(taskId, merged)
        post({ taskId, type: 'keyinfo', content: merged })
      }
    } catch {}
  }
  const at = new Date().toISOString()
  S.updateTask(taskId, { brief, brief_at: at })
  post({ taskId, type: 'brief', brief, briefAt: at })
  // 提取关键信息“名称”（分隔符前的标签，仅名称不含数据），供跨任务询问清单判断该问谁
  try {
    const finalKi = await readKeyInfo(task)
    const names = [...new Set(finalKi.split('\n').map((l) => l.trim())
      .map((l) => { const parts = l.split(/[:：=]/); return parts.length > 1 ? parts[0].trim() : '' })
      .filter((s) => s && s.length <= 24))].slice(0, 10)
    const meta = parseMeta(S.getTask(taskId).meta)
    if (JSON.stringify(meta.keyinfoNames || []) !== JSON.stringify(names)) {
      S.updateTask(taskId, { meta: JSON.stringify({ ...meta, keyinfoNames: names }) })
    }
  } catch {}
  // 组简介：组内任务有更新时按间隔自动重建（组简介含各任务一句话说明）
  if (task.group_id) {
    const now = Date.now()
    if (now - (autoGroupBriefAt.get(task.group_id) || 0) >= AUTO_GROUP_BRIEF_GAP) {
      autoGroupBriefAt.set(task.group_id, now)
      refreshGroupBrief(task.group_id).catch(() => {})
    }
  }
  return { ok: true, brief, brief_at: at }
}

// 组简介：一句话概括组职责 + 组内各任务一句话说明，供跨任务询问时快速定位
const AUTO_GROUP_BRIEF_GAP = 15000
const autoGroupBriefAt = new Map()
const groupBriefJobs = new Map()

function refreshGroupBrief(groupId) {
  if (!groupId) return Promise.resolve({ ok: false })
  const running = groupBriefJobs.get(groupId)
  if (running) return running
  const p = doRefreshGroupBrief(groupId).finally(() => groupBriefJobs.delete(groupId))
  groupBriefJobs.set(groupId, p)
  return p
}

async function doRefreshGroupBrief(groupId) {
  const S = getStore()
  const group = (S.listGroups() || []).find((g) => g.id === groupId)
  if (!group) return { ok: false, error: '分组不存在' }
  const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const tasks = S.listTasks().filter((t) => (t.group_id || '') === groupId && (t.scope || 'long') !== 'board')
  const at = new Date().toISOString()
  if (!tasks.length) {
    S.updateGroup(groupId, { brief: '', brief_at: at })
    return { ok: true, brief: '' }
  }
  const source = [
    `组名：${group.name}`,
    ...tasks.map((t) => `- ${t.name}（${t.type}）：${short(t.brief, 120) || '（暂无简介）'}`)
  ].join('\n')
  const model = pickDefaultModel(S)
  const key = keyOf(S, model)
  let acc = ''
  if (model && key) {
    try {
      await chatStream(modelLike(S, model), key, [{ role: 'user', content: source.slice(0, 12000) }],
        '你是分组简介生成器。根据组内任务列表，先一句话概括该组的整体职责（不超过 60 字），' +
        '再逐行列出每个任务的一句话说明（≤25 字，用于判断该问组里哪个任务）。严格按以下格式输出：\n' +
        '【组简介】\n（一句整体职责）\n【任务】\n- 任务名：一句话说明',
        (d) => { acc += d })
    } catch {}
  }
  let brief = acc.trim()
  brief = brief.replace(/^【组简介】\s*/, '').replace(/\n?【任务】\s*/, '\n').trim()
  if (!brief) brief = `组整体：${group.name}\n` + tasks.map((t) => `- ${t.name}：${short(t.brief, 24) || '暂无简介'}`).join('\n')
  S.updateGroup(groupId, { brief, brief_at: at })
  post({ taskId: '', type: 'groupBrief', groupId, brief, briefAt: at })
  return { ok: true, brief, brief_at: at }
}

// ---------- 子代理 / 编排 ----------

async function spawnSubagent(p) {
  const S = getStore()
  const task = S.getTask(p.taskId)
  if (!task) return { error: '任务不存在' }
  const parent = resolveSession(S, p.taskId, p.parentSessionId)
  const { usableAgents, model: dfltModel } = await pickAgentModel(S, task, parent)
  const agent = usableAgents.find((a) => a.id === p.agentId) || usableAgents[0] || FALLBACK_AGENT
  let model = null
  if (p.modelId) model = S.listModels().find((m) => m.id === p.modelId) || null
  if (!model) model = dfltModel
  const title = String(p.title || '').trim() || ('子代理 · ' + agent.name)
  const child = S.createSession({
    taskId: task.id, parentSessionId: parent.id, kind: 'subagent', title,
    agentId: agent.id, modelId: model ? model.id : ''
  })
  const initial = {
    childSessionId: child.id, title, agentId: agent.id, agentName: agent.name,
    modelId: model ? model.id : '', modelName: model ? model.name : '',
    status: p.execute === false ? 'draft' : 'pending', prompt: p.prompt || '', result: ''
  }
  const messageId = S.addMessage(task.id, 'assistant', '', {
    sessionId: parent.id, kind: 'subagent', meta: initial
  })
  post({
    taskId: task.id, sessionId: parent.id, type: 'child', messageId, childSessionId: child.id,
    status: initial.status, title, agentName: agent.name
  })
  if (p.execute === false) return { sessionId: child.id, messageId, runId: null }

  let childRunId = ''
  const childRun = await send({
    taskId: task.id, text: p.prompt || p.title || '', sessionId: child.id,
    parentRunId: p.parentRunId || '',
    onFinish: (r) => {
      const status = r.status || 'done'
      const result = String(r.result || '')
      const meta = {
        ...initial, status: status === 'stopped' ? 'stopped' : status === 'error' ? 'error' : 'done',
        result: result.slice(0, 1200), runId: childRunId
      }
      try { S.updateMessage(messageId, { meta: JSON.stringify(meta) }) } catch {}
      post({
        taskId: task.id, sessionId: parent.id, type: 'child', messageId, childSessionId: child.id,
        status: meta.status, title, result: meta.result, agentName: agent.name
      })
      if (p.onFinish) { try { p.onFinish(r) } catch {} }
    }
  })
  childRunId = childRun.runId
  try {
    const runNow = S.getRun(childRunId)
    if (runNow && runNow.status === 'running') {
      S.updateMessage(messageId, { meta: JSON.stringify({ ...initial, status: 'running', runId: childRunId }) })
    }
  } catch {}
  return { sessionId: child.id, messageId, runId: childRunId }
}

function extractJson(text) {
  const s = String(text || '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

function normalizePlan(plan, goal, agents, fallbackAgentId) {
  const list = []
  const arr = plan && Array.isArray(plan.subtasks) ? plan.subtasks : []
  for (const it of arr) {
    const idOrName = String(it.agent || it.agentId || '').trim()
    const agent = agents.find((a) => a.id === idOrName) || agents.find((a) => a.name === idOrName)
    const title = String(it.title || it.name || '').trim()
    if (!title && !it.prompt) continue
    list.push({
      title: title || String(it.prompt).slice(0, 30),
      agent: agent ? agent.id : fallbackAgentId,
      modelId: it.modelId || '',
      prompt: String(it.prompt || title || goal)
    })
    if (list.length >= 5) break
  }
  if (!list.length) list.push({ title: '执行目标', agent: fallbackAgentId, modelId: '', prompt: goal })
  return list
}

async function orchestrate(p) {
  const S = getStore()
  const task = S.getTask(p.taskId)
  if (!task) return { error: '任务不存在' }
  const session = resolveSession(S, p.taskId, p.sessionId)
  const { usableAgents, agent } = await pickAgentModel(S, task, session)
  const goal = String(p.goal || '').trim()
  if (!goal) return { error: '请提供编排目标' }
  const model = pickDefaultModel(S)
  const key = keyOf(S, model)
  const runId = nextRunId()
  S.createRun({
    id: runId, taskId: task.id, sessionId: session.id, agentId: 'orchestrator',
    modelId: model ? model.id : '', prompt: goal, meta: { kind: 'orchestrate' }
  })
  const entry = { kill: null, taskId: task.id, sessionId: session.id, childRunIds: new Set(), aborted: false }
  runs.set(runId, entry)
  const post2 = (o) => post({ taskId: task.id, sessionId: session.id, runId, ...o })
  if (!model || !key) {
    post2({ type: 'done', error: '编排需要可用的内置模型与 Key' })
    finishRun(runId, 'error', '')
    return { error: '编排需要可用的内置模型与 Key' }
  }
  const controller = new AbortController()
  entry.kill = () => { entry.aborted = true; controller.abort() }

  const agentList = usableAgents.map((a) => ({ id: a.id, name: a.name, kind: a.kind }))
  const plannerSys = '你是多代理编排器。根据目标把工作拆成 1-4 个子任务，每个子任务指派一个执行体。' +
    '只输出 JSON，格式：{"subtasks":[{"title":"...","agent":"执行体id","prompt":"给子代理的完整指令"}]}。' +
    '可用执行体：' + agentList.map((a) => `${a.id}(${a.name},${a.kind})`).join('、')
  let planText = ''
  try {
    await chatStream(modelLike(S, model), key, [{
      role: 'user',
      content: JSON.stringify({ goal, task: { name: task.name, type: task.type, brief: (task.brief || '').slice(0, 1500) } })
    }], plannerSys, (d) => { planText += d; post2({ type: 'delta', text: d }) }, controller.signal)
  } catch (e) {
    post2({ type: 'done', error: '编排计划失败：' + e.message })
    finishRun(runId, 'error', '')
    return { error: e.message }
  }
  if (entry.aborted) {
    post2({ type: 'done', content: '(已停止)' })
    finishRun(runId, 'stopped', '')
    return { runId, stopped: true }
  }
  const subtasks = normalizePlan(extractJson(planText), goal, usableAgents, agent.id)
  const max = Math.max(1, Math.min(5, Number(p.maxChildren) || 3))
  const chosen = subtasks.slice(0, max)
  const planMsg = S.addMessage(task.id, 'assistant',
    '编排计划：\n' + chosen.map((s, i) => `${i + 1}. ${s.title} → ${s.agent}`).join('\n'),
    { sessionId: session.id, kind: 'plan', runId, meta: { subtasks: chosen } })
  post2({ type: 'orchestrate', stage: 'plan', subtasks: chosen, messageId: planMsg })

  const results = []
  for (let i = 0; i < chosen.length; i++) {
    if (entry.aborted) break
    const st = chosen[i]
    post2({ type: 'orchestrate', stage: 'child', index: i, total: chosen.length, title: st.title, agent: st.agent })
    const result = await new Promise((resolve) => {
      let settled = false
      const done = (r) => { if (!settled) { settled = true; resolve(r) } }
      spawnSubagent({
        taskId: task.id, parentSessionId: session.id, agentId: st.agent, modelId: st.modelId,
        title: st.title, prompt: st.prompt, execute: true, parentRunId: runId,
        onFinish: done
      }).then((child) => {
        if (!child || !child.runId) done({ status: 'error', result: child && child.error || '未启动' })
        else entry.childRunIds.add(child.runId)
      }).catch((e) => done({ status: 'error', result: e.message }))
    })
    results.push({ title: st.title, status: result.status, result: result.result })
  }

  let final = ''
  if (!entry.aborted && results.length) {
    const digest = results.map((r, i) => `## ${i + 1}. ${r.title}（${r.status}）\n${String(r.result || '').slice(0, 3000)}`).join('\n\n')
    try {
      let acc = ''
      await chatStream(modelLike(S, model), key, [{
        role: 'user',
        content: `目标：${goal}\n\n子代理结果：\n${digest}`
      }], '你是编排器。用中文汇总子代理结果，给出最终结论与后续建议，不要重复过程细节。', (d) => {
        acc += d
        post2({ type: 'delta', text: d })
      }, controller.signal)
      final = acc
    } catch (e) { final = '汇总失败：' + e.message }
    const mid = S.addMessage(task.id, 'assistant', final, {
      sessionId: session.id, kind: 'text', runId,
      meta: { agentId: 'orchestrator', agentName: '编排器', modelId: model.id, modelName: model.name, runId }
    })
    appendChatFile(task, 'assistant', final, { agentName: '编排器', modelName: model.name, sessionTitle: session.title })
    post2({ type: 'done', content: final, messageId: mid })
  } else {
    post2({ type: 'done', content: entry.aborted ? '(已停止)' : '' })
  }
  finishRun(runId, entry.aborted ? 'stopped' : 'done', final)
  scheduleAfterTurn(task.id, session.id)
  return { runId, results, final }
}

module.exports = {
  init,
  send,
  stop,
  summarizeSession,
  refreshBrief,
  refreshGroupBrief,
  spawnSubagent,
  orchestrate,
  askRemote,
  listAwaiting,
  // 供 featuremap 等辅助服务复用（避免重复实现模型/事件逻辑）
  post,
  auxStart,
  keyOf,
  modelLike,
  pickDefaultModel,
  extractJson,
  register(ipcMain, winGetter) {
    getWin = winGetter
    ipcMain.handle('zz:chat:init', (_e, p) => init(p.taskId, p.sessionId))
    ipcMain.handle('zz:chat:send', (_e, p) => send(p))
    ipcMain.handle('zz:chat:stop', (_e, p) => stop(p.runId))
    ipcMain.handle('zz:chat:answer', (_e, p) => {
      const entry = runs.get(p.runId)
      if (entry && typeof entry.answer === 'function') {
        if (entry.asks) entry.asks.delete(p.requestId)
        entry.answer(p.requestId, p.answers ?? null)
        return true
      }
      return false
    })
    ipcMain.handle('zz:chat:summarize', (_e, p) => summarizeSession(p.taskId, p.sessionId))
    ipcMain.handle('zz:chat:brief', (_e, p) => refreshBrief(p.taskId, p))
    ipcMain.handle('zz:chat:groupBrief', (_e, p) => refreshGroupBrief(p.groupId))
    ipcMain.handle('zz:chat:spawn', (_e, p) => spawnSubagent(p))
    ipcMain.handle('zz:chat:askTask', (_e, p) => askTask({
      fromTaskId: p.fromTaskId, targetTaskId: p.targetTaskId, targetName: p.targetName, question: p.question, depth: p.depth
    }))
    ipcMain.handle('zz:chat:orchestrate', (_e, p) => orchestrate(p))
    ipcMain.handle('zz:chat:shells', (_e, p) => shellList(p.sessionId))
    ipcMain.handle('zz:chat:shellStop', (_e, p) => stopShell(p))
    ipcMain.handle('zz:chat:awaiting', () => listAwaiting())
  }
}
