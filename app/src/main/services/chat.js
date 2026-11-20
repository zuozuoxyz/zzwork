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
const BRIEF_LIMIT = 4000

// 图片附件：仅接受位图，缩略图存消息 meta，全分辨率 dataUrl 只在本轮内存流转
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const IMG_MAX_BYTES = 8 * 1024 * 1024
const ATT_MAX = 6

function post(payload) {
  const win = getWin && getWin()
  if (win && !win.isDestroyed()) win.webContents.send('zz:chat:event', payload)
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
function taskJoin(base, ...segs) {
  const r = parseRemotePath(base)
  if (r) return 'ssh://' + r.envId + '/' + [r.remotePath.replace(/^\/+|\/+$/g, ''), ...segs].filter(Boolean).join('/')
  return path.join(base, ...segs)
}

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
    agent = usableAgents.find((a) => a.kind !== 'builtin')
      || usableAgents.find((a) => a.kind === 'builtin')
      || agents.find((a) => a.kind === 'builtin')
      || FALLBACK_AGENT
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

async function readTextFile(file, limit) {
  const r = parseRemotePath(file)
  if (r) {
    const raw = await remotefs.readFile(r.envId, r.remotePath).catch(() => '')
    return raw.length > limit ? raw.slice(0, limit) : raw
  }
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return ''
    const raw = fs.readFileSync(file, 'utf8')
    return raw.length > limit ? raw.slice(0, limit) : raw
  } catch { return '' }
}

async function readMemory(task) {
  if (!task || !task.path) return ''
  return readTextFile(taskJoin(task.path, '.zzwork', 'memory.md'), MEMORY_LIMIT)
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
  const sessions = S.listSessions(taskId).map(publicSession)
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

function finishRun(runId, status, result) {
  const S = getStore()
  const entry = runs.get(runId)
  try {
    S.updateRun(runId, {
      status, result: String(result || ''), tokens: approxTokens(result),
      finished_at: new Date().toISOString()
    })
  } catch {}
  if (entry && entry.onFinish) { try { entry.onFinish({ status, result: String(result || '') }) } catch {} }
  runs.delete(runId)
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
    onFinish: p.onFinish || null, aborted: false,
    startedAt: Date.now(), snapshot: null, asks: null
  }
  runs.set(runId, entry)
  if (p.parentRunId && runs.has(p.parentRunId)) runs.get(p.parentRunId).childRunIds.add(runId)

  processRun({ runId, entry, task, session, agent, model, env, prompt: p.text || '', attachments: Array.isArray(p.attachments) ? p.attachments : [] }).catch((e) => {
    post({ taskId: task.id, sessionId: session.id, runId, type: 'done', error: e.message })
    finishRun(runId, 'error', '')
  })
  return { runId, sessionId: session.id }
}

async function processRun({ runId, entry, task, session, agent, model, env: envIn, prompt, attachments }) {
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

  if (agent.kind === 'builtin') runBuiltin({ runId, task, session, agent, model, changes: ch, env, turnStart, prompt: userText, attachments: savedFull })
  else runCli({ runId, task, session, agent, changes: ch, prompt: userText, env, turnStart, attachments: savedFull })
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

async function buildSystem(S, task, session, extra) {
  const parts = [`你是 zzwork 工作助手，当前任务「${task.name}」（类型 ${task.type}）。回答简洁实用。`]
  if (task.brief) parts.push('【任务简介】\n' + task.brief)
  const mem = await readMemory(task)
  if (mem) parts.push('【任务记忆】\n' + mem)
  if (session.summary) parts.push('【会话摘要】\n' + session.summary)
  const prompt = S.getSetting('session:prompt:' + task.id, '')
  if (prompt) parts.push('【本次会话提示词】\n' + prompt)
  if (extra) parts.push(extra)
  return parts.join('\n\n')
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

async function runBuiltin({ runId, task, session, agent, model, changes: ch, env, turnStart, attachments }) {
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
  const sys = await buildSystem(S, task, session, ch && ch.text ? ch.text : '')
  let acc = ''
  let think = ''
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
    await chatStream(modelLike(S, model), key, history, sys, (d) => {
      if (state.aborted) return
      acc += d
      turnLog.text(d)
      post2({ type: 'delta', text: d })
    }, controller.signal, (t) => {
      if (state.aborted) return
      think += t
      turnLog.think(t)
      post2({ type: 'thinking', text: t })
    })
    const fin = turnLog.finish()
    const fullMeta = { ...meta, thinking: think, parts: fin.parts, durationMs: fin.durationMs }
    const cacheMeta = sessionFiles.slimMeta(fullMeta)
    const mid = S.addMessage(task.id, 'assistant', acc, {
      sessionId: session.id, kind: 'text', runId, meta: cacheMeta, fileMeta: fullMeta
    })
    appendChatFile(task, 'assistant', acc, { ...meta, sessionTitle: session.title })
    changes.saveBaseline(S, session.id, task, env, ch && ch.ck && ch.ck.kind)
    post2({ type: 'done', content: acc, messageId: mid, tokens: approxTokens(acc), durationMs: fin.durationMs, parts: cacheMeta.parts })
    finishRun(runId, 'done', acc)
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
      changes.saveBaseline(S, session.id, task, env, ch && ch.ck && ch.ck.kind)
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

async function runCli({ runId, task, session, agent, changes: ch, prompt, env, turnStart, attachments }) {
  const S = getStore()
  const post2 = (o) => post({ taskId: task.id, sessionId: session.id, runId, ...o })
  const meta = { ...parseMeta(task.meta), ...parseMeta(session.meta) }
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
  const mem = await readMemory(task)
  if (mem) extraParts.push('【任务记忆】\n' + mem.slice(0, 2000))
  if (session.summary) extraParts.push('【会话摘要】\n' + session.summary)
  const sessionPrompt = S.getSetting('session:prompt:' + task.id, '')
  if (sessionPrompt) extraParts.push('【本次会话提示词】\n' + sessionPrompt)
  const systemExtra = extraParts.join('\n\n')

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
  if (agent.id === 'claude-code') {
    if (histBlock) finalPrompt += '\n\n---\n' + histBlock
  } else {
    const tail = [systemExtra, histBlock].filter(Boolean)
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
  try {
    let cli = null
    try { cli = cliProviderArgs(agent, appModelTarget(S, task, session)) } catch {}
    agentMeta.modelName = (cli && cli.model) || ''
    const runner = await runAgent({
      task, agent, env, prompt: finalPrompt, meta, selection, systemExtra, attachments,
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
      onDelta: (s) => { acc += s; turnLog.text(s); post2({ type: 'delta', text: s }) },
      onThinking: (t) => { think += t; turnLog.think(t); post2({ type: 'thinking', text: t }) },
      onStep: mergeStep,
      onPlan: (items) => {
        plan = items
        post2({ type: 'plan', plan: items })
      },
      onDone: (result) => {
        const content = (result && result.trim()) ? result : acc
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
        const fullMeta = {
          ...agentMeta, thinking: think,
          steps: steps.length ? steps : undefined,
          parts: fin.parts, durationMs: fin.durationMs,
          plan: plan || undefined
        }
        const cacheMeta = sessionFiles.slimMeta(fullMeta)
        const mid = S.addMessage(task.id, 'assistant', content, {
          sessionId: session.id, kind: 'text', runId, meta: cacheMeta, fileMeta: fullMeta
        })
        appendChatFile(task, 'assistant', content, { ...agentMeta, sessionTitle: session.title })
        changes.saveBaseline(S, session.id, task, env, ch && ch.ck && ch.ck.kind)
        post2({
          type: 'done', content, messageId: mid, tokens: approxTokens(content),
          durationMs: fin.durationMs, parts: cacheMeta.parts, plan: plan || undefined
        })
        finishRun(runId, 'done', content)
        scheduleAfterTurn(task.id, session.id)
        scheduleTurnDiff({ task, session, runId, env, turnStart })
      },
      onError: (err) => {
        post2({ type: 'done', error: err })
        try { S.updateRun(runId, { error: String(err), finished_at: new Date().toISOString() }) } catch {}
        finishRun(runId, 'error', '')
      },
      onAsk: ({ requestId, input }) => {
        const e = runs.get(runId)
        if (e) { if (!e.asks) e.asks = new Map(); e.asks.set(requestId, input || {}) }
        post2({ type: 'ask', requestId, input })
      }
    })
    const entry = runs.get(runId)
    if (entry) {
      entry.kill = () => { try { runner.kill() } catch {} }
      if (typeof runner.answer === 'function') entry.answer = (requestId, answers) => runner.answer(requestId, answers)
    }
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
    try {
      let acc = ''
      await chatStream(modelLike(S, model), key, [{
        role: 'user',
        content: `已有摘要：\n${session.summary || '（无）'}\n\n新增对话：\n${transcript}`
      }], '你是会话摘要器。用不超过 300 字的中文更新会话摘要，保留目标、关键决定、结论和未完成事项；不要寒暄，不要编造。', (d) => { acc += d })
      summary = acc.trim()
    } catch {}
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
  setTimeout(() => { maybeSummarize(taskId, sessionId).catch(() => {}) }, 800)
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

async function refreshBrief(taskId, opts) {
  const S = getStore()
  const task = S.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  const sessions = S.listSessions(taskId)
  const summaries = sessions.filter((s) => s.summary).map((s) => `- ${s.title}${s.kind === 'subagent' ? '（子代理）' : ''}: ${s.summary}`)
  const info = await readInfo(task)
  const mem = await readMemory(task)
  const source = [
    `任务：${task.name}（${task.type}）`,
    `路径：${task.path}`,
    info ? `.zzwork/info.md 节选：\n${info}` : '',
    summaries.length ? `会话摘要：\n${summaries.join('\n')}` : '',
    mem ? `任务记忆：\n${mem}` : ''
  ].filter(Boolean).join('\n\n')

  const model = pickDefaultModel(S)
  const key = keyOf(S, model)
  let brief = ''
  if (model && key) {
    try {
      let acc = ''
      await chatStream(modelLike(S, model), key, [{ role: 'user', content: source.slice(0, 12000) }],
        '你是任务简介生成器。用不超过 200 字的中文概括该任务的目标、当前进展、关键决定与下一步；只陈述材料中的事实，不要编造。',
        (d) => { acc += d })
      brief = acc.trim()
    } catch {}
  }
  if (!brief) {
    const parts = []
    if (info) parts.push(info.replace(/\s+/g, ' ').slice(0, 600))
    if (summaries.length) parts.push(summaries.join(' '))
    brief = parts.join(' ').slice(0, 800) || '（暂无足够信息生成简介）'
  }
  const at = new Date().toISOString()
  S.updateTask(taskId, { brief, brief_at: at })
  post({ taskId, type: 'brief', brief, briefAt: at })
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
  spawnSubagent,
  orchestrate,
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
    ipcMain.handle('zz:chat:spawn', (_e, p) => spawnSubagent(p))
    ipcMain.handle('zz:chat:orchestrate', (_e, p) => orchestrate(p))
    ipcMain.handle('zz:chat:shells', (_e, p) => shellList(p.sessionId))
    ipcMain.handle('zz:chat:shellStop', (_e, p) => stopShell(p))
  }
}
