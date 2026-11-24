// 需求收件箱：工作区顶层便签 + 归类（LLM/关键词）+ 新建任务/归入任务并执行
const fs = require('fs')
const path = require('path')
const os = require('os')
const { chatStream } = require('../../core/ai')
const { getStore } = require('./store')
const secrets = require('./secrets')
const chat = require('./chat')

function workRoot() {
  const S = getStore()
  return S.workdir || path.join(os.homedir(), 'zzwork-tasks')
}

function inboxPath() {
  return path.join(workRoot(), '.zzwork', 'inbox.md')
}

function logPath() {
  return path.join(workRoot(), '.zzwork', 'inbox-log.md')
}

function readInbox() {
  const file = inboxPath()
  try { return { path: file, content: fs.readFileSync(file, 'utf8') } } catch { return { path: file, content: '' } }
}

function saveInbox(content) {
  const file = inboxPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, String(content || ''), 'utf8')
  return { path: file, ok: true }
}

function parseItems(text) {
  return String(text || '').split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]\s*|\[[ xX]\]\s*|\d+[.)]\s*)/, '').trim())
    .filter((line) => line && !line.startsWith('#'))
    .slice(0, 30)
}

function providerOf(S, model) {
  return model ? (S.listProviders().find((p) => p.id === model.provider_id) || null) : null
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
  const p = providerOf(S, model)
  return p ? { ...model, type: p.type, base_url: p.base_url } : model
}
function defaultModel(S) {
  const models = S.listModels()
  return models.find((m) => m.is_default) || models[0] || null
}

function tokenize(s) {
  const lower = String(s || '').toLowerCase()
  const out = new Set()
  for (const w of lower.match(/[a-z0-9_]{2,}/g) || []) out.add(w)
  const cjk = lower.match(/[一-龥]{2,}/g) || []
  for (const seg of cjk) for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
  return out
}

function keywordTriage(items, tasks) {
  return items.map((text) => {
    const tk = tokenize(text)
    let best = null, bestScore = 0
    for (const t of tasks) {
      const cat = tokenize(t.name + ' ' + (t.brief || ''))
      let hit = 0
      for (const w of tk) if (cat.has(w)) hit++
      const score = hit / Math.max(3, tk.size)
      if (score > bestScore) { bestScore = score; best = t }
    }
    const named = tasks.find((t) => t.name && text.includes(t.name))
    if (named) return { text, action: 'ignore', kind: '', taskName: named.name, name: '', reason: '文本包含已有任务名', confidence: 0.9 }
    if (best && bestScore >= 0.34) {
      return { text, action: 'ignore', kind: '', taskName: best.name, name: '', reason: `关键词匹配已有任务（${Math.round(bestScore * 100)}%）`, confidence: bestScore }
    }
    return { text, action: 'new', kind: 'task', taskName: '', name: text.slice(0, 40), reason: '未匹配到已有任务', confidence: 0.5 }
  })
}

async function triage(content) {
  const S = getStore()
  const items = parseItems(content)
  if (!items.length) return { items: [], mode: 'empty' }
  const tasks = S.listTasks().map((t) => ({
    id: t.id, name: t.name, type: t.type, path: t.path, group_id: t.group_id,
    brief: String(t.brief || '').slice(0, 300)
  }))
  let proposals = null
  const model = defaultModel(S)
  const key = keyOf(S, model)
  if (model && key) {
    try {
      let acc = ''
      const user = JSON.stringify({ items, tasks })
      await chatStream(modelLike(S, model), key, [{ role: 'user', content: user }],
        '你是需求归类器。逐条判断：若已有相关任务则标记忽略（已有相关任务，不再新建）；否则新建任务，并判断是「看板任务」还是「短期任务」。只输出 JSON：' +
        '{"items":[{"index":0,"action":"new|ignore","kind":"board|task","name":"新任务名(≤20字)","reason":"简短理由","confidence":0.8}]}。' +
        'kind 仅在 action 为 new 时有效：用看板卡片跟踪的一次性小需求为 board；需要进入项目分组持续跟进的为 task。' +
        '只有明显已有相关任务时才 ignore；含糊需求输出 new。不要编造任务 id。',
        (d) => { acc += d })
      const a = acc.indexOf('{'), b = acc.lastIndexOf('}')
      if (a >= 0 && b > a) {
        const parsed = JSON.parse(acc.slice(a, b + 1))
        if (parsed && Array.isArray(parsed.items)) proposals = parsed.items
      }
    } catch {}
  }
  const fallback = keywordTriage(items, tasks)
  const byIndex = new Map(fallback.map((f, i) => [i, f]))
  const merged = items.map((text, i) => {
    const base = byIndex.get(i)
    const p = proposals && proposals.find((x) => Number(x.index) === i)
    if (!p) return base
    let action = ['new', 'ignore', 'attach'].includes(p.action) ? p.action : base.action
    // 旧模型的 attach（归入已有任务）统一视为 ignore（已有相关任务）
    if (action === 'attach') action = 'ignore'
    const kind = (p.kind === 'board' || p.kind === 'task') ? p.kind : (base.kind || 'task')
    return {
      text,
      action,
      kind: action === 'ignore' ? '' : kind,
      taskName: action === 'ignore' ? (base.taskName || '') : '',
      name: String(p.name || base.name || text.slice(0, 40)).slice(0, 40),
      reason: String(p.reason || base.reason || ''),
      confidence: Math.max(0, Math.min(1, Number(p.confidence) || base.confidence || 0.5))
    }
  })
  return { items: merged, mode: proposals ? 'llm' : 'keyword' }
}

function safeName(name) {
  return String(name || 'task').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'task'
}

function uniquePath(base, S) {
  let p = base
  let i = 2
  const used = new Set(S.listTasks().map((t) => path.resolve(t.path || '').toLowerCase()))
  while (used.has(path.resolve(p).toLowerCase()) || fs.existsSync(p)) {
    p = base + '-' + i++
  }
  return p
}

function infoFile(task) {
  return path.join(task.path, '.zzwork', 'info.md')
}

// 旧任务根目录 info.md → .zzwork/info.md
function migrateLegacyInfo(task) {
  const next = infoFile(task)
  try {
    const legacy = path.join(task.path, 'info.md')
    if (fs.existsSync(legacy) && !fs.existsSync(next)) {
      fs.mkdirSync(path.dirname(next), { recursive: true })
      fs.renameSync(legacy, next)
    }
  } catch {}
  return next
}

function writeInfo(task, type) {
  const file = migrateLegacyInfo(task)
  try {
    if (fs.existsSync(file)) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const body = `# ${task.name}\n\n- 类型：${type || task.type}\n- 创建时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n\n## 目标\n\n（在这里补充任务目标）\n`
    fs.writeFileSync(file, body, 'utf8')
  } catch {}
}

function logApplied(results) {
  try {
    const file = logPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const stamp = new Date().toISOString()
    const lines = results.map((r) => `- ${stamp} · ${r.action} · ${r.taskName || ''} · ${r.text || ''}${r.error ? ' · 错误: ' + r.error : ''}`)
    fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8')
  } catch {}
}

async function apply(payload) {
  const S = getStore()
  const items = Array.isArray(payload.items) ? payload.items : []
  const execute = payload.execute !== false
  const results = []
  const affected = new Set()
  for (const it of items) {
    if (!it || it.action === 'ignore') continue
    try {
      if (it.kind === 'board') {
        // 看板任务：落到看板卡片（未开始），不立即执行
        const title = String(it.name || it.text || '').trim().slice(0, 40) || '未命名卡片'
        const target = String(it.path || '').trim() || uniquePath(path.join(workRoot(), '.zzwork', 'board', safeName(title)), S)
        const card = S.createTask({ name: title, type: 'work', scope: 'board', status: 'todo', path: target, agentId: 'builtin', meta: { content: String(it.text || '') } })
        try { fs.mkdirSync(card.path, { recursive: true }) } catch {}
        results.push({ ok: true, action: 'new', kind: 'board', text: it.text, taskId: card.id, taskName: card.name, sessionId: '', runId: '' })
      } else {
        // 短期任务：常规项目任务，可归入分组，并立即执行
        const name = String(it.name || it.text || '').trim().slice(0, 40) || '新任务'
        const target = String(it.path || '').trim() || uniquePath(path.join(workRoot(), safeName(name)), S)
        const task = S.createTask({ name, type: 'work', groupId: it.groupId || null, path: target, agentId: 'builtin' })
        fs.mkdirSync(task.path, { recursive: true })
        writeInfo(task, 'work')
        affected.add(task.id)
        const session = S.createSession({
          taskId: task.id, kind: 'chat', title: String(it.title || it.text || '需求').slice(0, 36), agentId: '', modelId: ''
        })
        let runId = ''
        if (execute) {
          const r = await chat.send({ taskId: task.id, text: it.text, sessionId: session.id })
          runId = r && r.runId || ''
        }
        results.push({ ok: true, action: 'new', kind: 'task', text: it.text, taskId: task.id, taskName: task.name, sessionId: session.id, runId })
      }
    } catch (e) {
      results.push({
        ok: false, action: it.action, text: it.text,
        taskId: it.taskId || '', taskName: it.taskName || '', error: e.message
      })
    }
  }
  logApplied(results)
  for (const tid of affected) chat.refreshBrief(tid).catch(() => {})
  return { results, affectedTaskIds: [...affected] }
}

module.exports = {
  get: readInbox,
  save: saveInbox,
  triage,
  apply,
  register(ipcMain) {
    ipcMain.handle('zz:inbox:get', () => readInbox())
    ipcMain.handle('zz:inbox:save', (_e, p) => saveInbox(p.content))
    ipcMain.handle('zz:inbox:triage', (_e, p) => triage(p.content))
    ipcMain.handle('zz:inbox:apply', (_e, p) => apply(p))
  }
}
