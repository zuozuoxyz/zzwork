// 需求便签：工作区顶层记录 + 归类（新建/归入任务）+ 一键执行
import { invoke, store, onChatEvent } from '../lib/api.js'
import { state, emit, on } from '../lib/state.js'
import { $, esc, ic, taskIcon, debounce, refreshIcons } from '../lib/ui.js'
import { reloadTasks } from '../lib/data.js'
import { toast } from '../components/toast.js'

let loaded = false
let busy = false
// 归类审阅进行中：{ base: 原始便签内容, confirmed: 已确认应用的行文本[] }
let review = null
// 拖拽改状态：{ id, type, scope, status, col }
let inboxDrag = null
// 手动排序：各未完成分区（todo/open/code）的卡片 id 顺序，持久化到 settings
let orderMap = { todo: [], open: [], code: [] }
const REORDER_COLS = new Set(['todo', 'open', 'code'])
// 分栏比例（相对容器）：左右宽、左上高
let leftRatio = 0.46
let topRatio = 0.56
const LR_MIN = 0.25, LR_MAX = 0.75, TR_MIN = 0.2, TR_MAX = 0.85

const inboxInvoke = (method, payload) => invoke('inbox', method, payload || {})

export function initInboxView() {
  const openBtn = $('#openInboxBtn')
  if (openBtn) openBtn.addEventListener('click', () => emit('open-inbox'))
  const input = $('#inboxInput')
  if (!input) return
  const save = debounce(async () => {
    try {
      await inboxInvoke('save', { content: input.value })
      setHint('已自动保存到工作区 .zzwork/inbox.md')
    } catch (e) { setHint('保存失败：' + e.message) }
  }, 500)
  input.addEventListener('input', save)
  $('#triageBtn').addEventListener('click', () => {
    if (review) { finishReview({ cancelled: true }); return }
    runTriage().catch((e) => toast(e.message, 'err'))
  })
  initInboxSplit()
  loadInboxRatios().catch(() => {})
  ensureOrder()
  loadInbox()
  // 有任务 AI 回复结束/发起提问时实时刷新入口徽标与未读/待回答标志
  onChatEvent((ev) => {
    if (!ev) return
    if (ev.type !== 'unread' && ev.type !== 'ask' && ev.type !== 'done') return
    updateInboxBadge().catch(() => {})
    if (state.pane === 'inbox') renderInboxBoard().then(() => renderInboxCode()).catch(() => {})
  })
  // 已读状态变化（用户查看对话 / 回答提问）时刷新入口徽标
  on('unread-changed', () => { updateInboxBadge().catch(() => {}) })
}

let orderPromise = null
function ensureOrder() {
  if (!orderPromise) orderPromise = loadInboxOrder().catch(() => {})
  return orderPromise
}

async function loadInboxOrder() {
  try {
    const raw = await store('settings.get', { key: 'ui:inboxOrder', dflt: '' })
    if (raw) {
      const o = JSON.parse(raw)
      if (o && typeof o === 'object') {
        orderMap = { todo: [], open: [], code: [], ...o }
        return
      }
    }
  } catch {}
}

async function persistColOrder(col, ids) {
  orderMap[col] = ids
  try { await store('settings.set', { key: 'ui:inboxOrder', value: JSON.stringify(orderMap) }) } catch {}
}

// 按已保存顺序排列；未登记的任务保持自然顺序排在后面
function applyOrder(list, col) {
  const arr = orderMap[col]
  if (!arr || !arr.length) return list
  const rank = new Map(arr.map((id, i) => [id, i]))
  return list.slice().sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity
    return ra === rb ? 0 : ra - rb
  })
}

// 未读：主进程记录的最近一次 AI 回复结束时间晚于用户已读时间
let replyAt = {}, readAt = {}
async function refreshUnreadMaps() {
  try {
    const r = await store('settings.get', { key: 'ui:taskReplyAt', dflt: '' })
    replyAt = r ? (JSON.parse(r) || {}) : {}
  } catch { replyAt = {} }
  try {
    const d = await store('settings.get', { key: 'ui:taskRead', dflt: '' })
    readAt = d ? (JSON.parse(d) || {}) : {}
  } catch { readAt = {} }
}
const isUnread = (id) => (replyAt[id] || 0) > (readAt[id] || 0)

// 正在等待用户回答（AskUserQuestion 工具阻塞）的任务
let awaitingSet = new Set()
async function refreshAwaiting() {
  try {
    const list = await invoke('chat', 'awaiting')
    awaitingSet = new Set(Array.isArray(list) ? list : [])
  } catch { awaitingSet = new Set() }
}
const isAwaiting = (id) => awaitingSet.has(id)
// 有未回答的提问时优先显示「待回答」；否则显示未读
const unreadBadge = (id) => isAwaiting(id)
  ? '<span class="ibunread ask" title="正在等待你的回答">待回答</span>'
  : isUnread(id) ? '<span class="ibunread" title="有未读的 AI 回复">未读</span>' : ''

// 标题栏「需求便签」入口上的醒目提醒：需处理（待回答）+ 未读任务数，跨 pane 常驻更新
export async function updateInboxBadge() {
  const btn = $('#openInboxBtn')
  const badge = $('#openInboxBadge')
  if (!btn || !badge) return
  const visible = new Set(state.tasks
    .filter((t) => t.scope === 'board' || t.type === 'work' || t.type === 'code')
    .map((t) => t.id))
  await refreshUnreadMaps()
  await refreshAwaiting()
  let awaiting = 0, unread = 0
  for (const id of visible) {
    if (isAwaiting(id)) awaiting++
    else if (isUnread(id)) unread++
  }
  const total = awaiting + unread
  badge.hidden = total === 0
  badge.textContent = total === 0 ? '' : (total > 99 ? '99+' : String(total))
  badge.classList.toggle('ask', awaiting > 0)
  const parts = []
  if (awaiting) parts.push(`${awaiting} 个任务待回答`)
  if (unread) parts.push(`${unread} 个任务有未读回复`)
  btn.title = total ? `需求便签 · ${parts.join('，')}` : '需求便签 · 记录并归类需求'
}

// —— 分栏拖拽：左右宽（水平分隔条）+ 左上高（垂直分隔条），比例持久化 ——
function applyInboxRatios() {
  const left = document.querySelector('#pane-inbox .inboxleft')
  const top = document.querySelector('#pane-inbox .inboxpane')
  if (left) left.style.flex = `0 0 ${(leftRatio * 100).toFixed(2)}%`
  if (top) top.style.flex = `0 0 ${(topRatio * 100).toFixed(2)}%`
}

async function loadInboxRatios() {
  try {
    const l = Number(await store('settings.get', { key: 'ui:inboxLeftRatio', dflt: '' }))
    if (Number.isFinite(l) && l > 0) leftRatio = Math.min(LR_MAX, Math.max(LR_MIN, l))
  } catch {}
  try {
    const t = Number(await store('settings.get', { key: 'ui:inboxTopRatio', dflt: '' }))
    if (Number.isFinite(t) && t > 0) topRatio = Math.min(TR_MAX, Math.max(TR_MIN, t))
  } catch {}
  applyInboxRatios()
}

function initInboxSplit() {
  const h = $('#inboxHDiv')
  const wrap = document.querySelector('#pane-inbox .inboxsplit')
  if (h && wrap) {
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      h.setPointerCapture(e.pointerId)
      h.classList.add('dragging')
      const rect = wrap.getBoundingClientRect()
      const move = (ev) => {
        leftRatio = Math.min(LR_MAX, Math.max(LR_MIN, (ev.clientX - rect.left) / rect.width))
        applyInboxRatios()
      }
      const up = async () => {
        h.removeEventListener('pointermove', move)
        h.removeEventListener('pointerup', up)
        try { h.releasePointerCapture(e.pointerId) } catch {}
        h.classList.remove('dragging')
        try { await store('settings.set', { key: 'ui:inboxLeftRatio', value: String(leftRatio) }) } catch {}
      }
      h.addEventListener('pointermove', move)
      h.addEventListener('pointerup', up)
    })
  }
  const v = $('#inboxVDiv')
  const leftEl = document.querySelector('#pane-inbox .inboxleft')
  if (v && leftEl) {
    v.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      v.setPointerCapture(e.pointerId)
      v.classList.add('dragging')
      const rect = leftEl.getBoundingClientRect()
      const move = (ev) => {
        topRatio = Math.min(TR_MAX, Math.max(TR_MIN, (ev.clientY - rect.top) / rect.height))
        applyInboxRatios()
      }
      const up = async () => {
        v.removeEventListener('pointermove', move)
        v.removeEventListener('pointerup', up)
        try { v.releasePointerCapture(e.pointerId) } catch {}
        v.classList.remove('dragging')
        try { await store('settings.set', { key: 'ui:inboxTopRatio', value: String(topRatio) }) } catch {}
      }
      v.addEventListener('pointermove', move)
      v.addEventListener('pointerup', up)
    })
  }
}

async function loadInbox() {
  if (loaded) return
  loaded = true
  try {
    const r = await inboxInvoke('get')
    const input = $('#inboxInput')
    if (input && r && r.content) input.value = r.content
    setHint('自动保存到工作区 .zzwork/inbox.md')
  } catch (e) { setHint('读取失败：' + e.message) }
}

function setHint(text) {
  const el = $('#inboxHint')
  if (el) el.textContent = text
}

// 去掉行首的列表/编号/待办标记，便于按内容匹配原始便签行
function stripLine(line) {
  return String(line || '').replace(/^\s*(?:[-*+]\s*|\[[ xX]\]\s*|\d+[.)]\s*)/, '').trim()
}

// 只删除已确认应用的行，保留其余未确认内容
function removeConfirmedLines(content, confirmedTexts) {
  const set = new Set((confirmedTexts || []).map((t) => String(t || '').trim()).filter(Boolean))
  if (!set.size) return String(content || '')
  return String(content || '').split(/\r?\n/).filter((line) => {
    const bare = stripLine(line)
    if (!bare || bare.startsWith('#')) return true
    return !set.has(bare)
  }).join('\n')
}

// 需求便签右栏：全部任务三栏总览（未开始 / 未完成 / 已完成）—— 只含 work 与看板任务
export async function renderInboxBoard() {
  const el = $('#inboxBoard')
  if (!el) return
  try { await reloadTasks() } catch {}
  await ensureOrder()
  await refreshUnreadMaps()
  await refreshAwaiting()
  const tasks = state.tasks.filter((t) => t.scope === 'board' || t.type === 'work')
  const done = tasks.filter((t) => t.status === 'done')
  const todo = applyOrder(tasks.filter((t) => t.status === 'todo'), 'todo')
  const open = applyOrder(tasks.filter((t) => t.status !== 'done' && t.status !== 'todo'), 'open')
  const card = (t) => {
    const isBoard = t.scope === 'board'
    const [name, color] = isBoard ? ['kanban-square', '#a074c4'] : ['notebook', '#2dd4bf']
    return `<div class="ibcard ${isBoard ? 'board' : 'work'}" data-task="${esc(t.id)}" draggable="true">
      <span class="ibic" style="color:${color}">${ic(name, 13)}</span>
      <span class="ibn">${esc(t.name)}</span>
      ${unreadBadge(t.id)}
      <span class="ibp">${isBoard ? '短期' : 'work'}</span></div>`
  }
  el.innerHTML = `
    <div class="ibcol"><div class="ibcolh">未开始 <span class="bn">${todo.length}</span></div>
      <div class="ibcolb" data-col="todo">${todo.map(card).join('') || '<div class="hint">没有未开始任务</div>'}</div></div>
    <div class="ibcol"><div class="ibcolh">未完成 <span class="bn">${open.length}</span></div>
      <div class="ibcolb" data-col="open">${open.map(card).join('') || '<div class="hint">没有未完成任务</div>'}</div></div>
    <div class="ibcol"><div class="ibcolh">已完成 <span class="bn">${done.length}</span></div>
      <div class="ibcolb" data-col="done">${done.map(card).join('') || '<div class="hint">暂无已完成任务</div>'}</div></div>`
  wireInboxCards(el)
  el.querySelectorAll('.ibcolb[data-col]').forEach((b) => attachColumnDrop(b))
  refreshIcons()
}

// 需求便签左下：全部 code 类型任务（点击跳转；未完成的可拖到右栏「已完成」）
export function renderInboxCode() {
  const el = $('#inboxCodeTasks')
  if (!el) return
  const codes = applyOrder(state.tasks.filter((t) => t.type === 'code'), 'code')
  const ti = taskIcon('code')
  const card = (t) => {
    const done = t.status === 'done'
    return `<div class="ibcard code${done ? ' done' : ''}" data-task="${esc(t.id)}" draggable="${done ? 'false' : 'true'}" title="${esc(t.path || '')}">
      <span class="ibic" style="color:${ti.color}">${ic(ti.name, 13)}</span>
      <span class="ibn">${esc(t.name)}</span>
      ${unreadBadge(t.id)}
      ${done ? '<span class="ibdone">已完成</span>' : '<span class="ibp">code</span>'}</div>`
  }
  const cnt = $('#codeCount')
  if (cnt) cnt.textContent = codes.length ? codes.length + ' 个' : ''
  el.innerHTML = codes.length ? codes.map(card).join('') : '<div class="hint" style="padding:8px 2px">暂无代码任务</div>'
  wireInboxCards(el)
  attachCodeReorder(el)
  refreshIcons()
}

// 卡片：点击跳转；可拖拽者记录拖拽源
function wireInboxCards(el) {
  el.querySelectorAll('.ibcard[data-task]').forEach((c) => {
    const id = c.getAttribute('data-task')
    c.addEventListener('click', () => {
      const t = state.tasks.find((x) => x.id === id)
      // 看板任务跳到看板页并打开该卡片，而非落到常规任务信息页
      if (t && t.scope === 'board') { emit('open-card-tab', { card: t }); return }
      emit('select-task', id)
    })
    if (c.getAttribute('draggable') === 'false') return
    c.addEventListener('dragstart', (e) => {
      const t = state.tasks.find((x) => x.id === id)
      if (!t) return
      const colEl = c.closest('.ibcolb')
      const col = colEl ? colEl.getAttribute('data-col') : 'code'
      inboxDrag = { id, type: t.type, scope: t.scope, status: t.status, col }
      try { e.dataTransfer.effectAllowed = 'move' } catch {}
      try { e.dataTransfer.setData('text/plain', id) } catch {}
      c.classList.add('dragging')
    })
    c.addEventListener('dragend', () => { c.classList.remove('dragging'); clearDropMarks(); inboxDrag = null })
  })
}

// —— 同列拖拽排序 ——
function clearDropMarks() {
  document.querySelectorAll('#pane-inbox .ibcard.drop-before').forEach((c) => c.classList.remove('drop-before'))
  document.querySelectorAll('#pane-inbox .drop-end').forEach((c) => c.classList.remove('drop-end'))
  document.querySelectorAll('#pane-inbox .ibcolb.drop-on').forEach((c) => c.classList.remove('drop-on'))
}

function reorderCards(container) {
  return [...container.querySelectorAll('.ibcard[data-task]')].filter((c) => !c.classList.contains('dragging'))
}

// 依据指针 y 求插入目标：返回应被「挤下去」的卡片 id，null=追加到末尾
function reorderTargetId(container, y) {
  for (const c of reorderCards(container)) {
    const r = c.getBoundingClientRect()
    if (y < r.top + r.height / 2) return c.getAttribute('data-task')
  }
  return null
}

function markInsert(container, y) {
  clearDropMarks()
  const tid = reorderTargetId(container, y)
  if (tid) {
    const target = reorderCards(container).find((c) => c.getAttribute('data-task') === tid)
    if (target) target.classList.add('drop-before')
  } else {
    container.classList.add('drop-end')
  }
}

function computeReordered(container, movingId, y) {
  const ids = [...container.querySelectorAll('.ibcard[data-task]')]
    .map((c) => c.getAttribute('data-task')).filter((id) => id !== movingId)
  const tid = reorderTargetId(container, y)
  let idx = ids.length
  if (tid) { const i = ids.indexOf(tid); if (i >= 0) idx = i }
  ids.splice(idx, 0, movingId)
  return ids
}

// 代码任务单一列表内拖拽排序
function attachCodeReorder(el) {
  el.addEventListener('dragover', (e) => {
    if (!inboxDrag || inboxDrag.col !== 'code') return
    e.preventDefault()
    try { e.dataTransfer.dropEffect = 'move' } catch {}
    markInsert(el, e.clientY)
  })
  el.addEventListener('drop', async (e) => {
    if (!inboxDrag || inboxDrag.col !== 'code') return
    e.preventDefault()
    const ids = computeReordered(el, inboxDrag.id, e.clientY)
    inboxDrag = null
    clearDropMarks()
    await persistColOrder('code', ids)
    renderInboxCode()
  })
}

// 右栏「未开始/未完成/已完成」列作为放置目标：同列=拖拽排序，跨列=改状态
function attachColumnDrop(b) {
  const col = b.getAttribute('data-col')
  const sameColReorder = () => inboxDrag && inboxDrag.col === col && REORDER_COLS.has(col)
  const validCross = () => {
    if (!inboxDrag) return false
    if (inboxDrag.col === col) return false // 同列走排序分支
    if (inboxDrag.type === 'code' && col !== 'done') return false // code 任务只能落到已完成
    if (col === 'todo' && inboxDrag.scope !== 'board') return false // 仅看板任务有「未开始」
    const cur = inboxDrag.status === 'done' ? 'done' : inboxDrag.status === 'todo' ? 'todo' : 'open'
    return col !== cur
  }
  b.addEventListener('dragover', (e) => {
    if (sameColReorder()) {
      e.preventDefault()
      try { e.dataTransfer.dropEffect = 'move' } catch {}
      markInsert(b, e.clientY)
      return
    }
    if (!validCross()) return
    e.preventDefault()
    try { e.dataTransfer.dropEffect = 'move' } catch {}
    b.classList.add('drop-on')
  })
  b.addEventListener('dragleave', (e) => { if (e.target === b) b.classList.remove('drop-on') })
  b.addEventListener('drop', async (e) => {
    if (sameColReorder()) {
      e.preventDefault()
      const ids = computeReordered(b, inboxDrag.id, e.clientY)
      inboxDrag = null
      clearDropMarks()
      await persistColOrder(col, ids)
      renderInboxBoard()
      return
    }
    if (!validCross()) return
    e.preventDefault()
    b.classList.remove('drop-on')
    const src = inboxDrag
    inboxDrag = null
    await dropToColumn(src, col)
  })
}

async function dropToColumn(src, col) {
  if (!src) return
  const cur = src.status === 'done' ? 'done' : src.status === 'todo' ? 'todo' : 'open'
  if (col === cur) return
  const status = col === 'done' ? 'done'
    : col === 'todo' ? 'todo'
    : (src.scope === 'board' ? 'review' : 'active')
  try {
    await store('tasks.update', { id: src.id, patch: { status } })
    await reloadTasks()
    emit('tasks-changed')
    renderInboxBoard()
    renderInboxCode()
    toast(col === 'done' ? '已标记完成' : col === 'todo' ? '已移至未开始' : '已恢复到未完成')
  } catch (e) {
    toast('更新失败：' + e.message, 'err', 4000)
  }
}

async function runTriage() {
  if (busy) return
  const input = $('#inboxInput')
  if (!input) return
  const content = input.value.trim()
  if (!content) { toast('便签是空的，先记录几条需求'); return }
  busy = true
  setTriageButton('running')
  setHint('正在归类…')
  input.readOnly = true
  input.classList.add('busy')
  let result
  try {
    result = await inboxInvoke('triage', { content })
  } catch (e) {
    busy = false
    setTriageButton('idle')
    input.readOnly = false
    input.classList.remove('busy')
    setHint('自动保存到工作区 .zzwork/inbox.md')
    toast('归类失败：' + e.message, 'err', 4000)
    return
  }
  const items = (result && result.items) || []
  if (!items.length) {
    busy = false
    setTriageButton('idle')
    input.readOnly = false
    input.classList.remove('busy')
    toast('没有可归类的需求行')
    setHint('自动保存到工作区 .zzwork/inbox.md')
    return
  }
  try { await reloadTasks() } catch {}
  setHint(`归类完成（${result.mode === 'llm' ? 'AI' : '关键词'}），请逐条确认`)
  enterReview(items, input.value)
}

// 按钮三态：idle=归类并执行 / running=运行中(不可点) / cancel=取消(审阅中)
function setTriageButton(mode) {
  const btn = $('#triageBtn')
  const label = $('#triageBtnLabel')
  if (!btn) return
  if (label) label.textContent = mode === 'running' ? '归类中' : mode === 'cancel' ? '取消' : '归类'
  btn.disabled = mode === 'running'
  btn.classList.toggle('running', mode === 'running')
  btn.classList.toggle('cancelling', mode === 'cancel')
}

// 分组下拉选项：与新建任务弹框一致（不分组 + 各组路径）
function groupOptionsHTML() {
  const groupById = new Map(state.groups.map((g) => [g.id, g]))
  const label = (g) => {
    const parts = []
    let cur = g, guard = 0
    while (cur && guard++ < 50) { parts.unshift(cur.name); cur = cur.parent_id ? groupById.get(cur.parent_id) : null }
    return parts.join(' / ')
  }
  const opts = [['', '（不分组）'], ...state.groups.map((g) => [g.id, label(g)])]
  return opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')
}

// 用内联审阅面板就地替换输入框，逐条确认
function enterReview(items, baseContent) {
  const input = $('#inboxInput')
  const panel = $('#inboxReview')
  if (!input || !panel) return
  review = { base: baseContent, confirmed: [] }
  const groupOpts = groupOptionsHTML()
  const rows = items.map((it, i) => {
    const action = it.action === 'ignore' ? 'ignore' : 'new'
    const kind = it.kind === 'board' ? 'board' : 'task'
    const isNew = action === 'new'
    return `<div class="ir-row" data-i="${i}" data-text="${esc(it.text)}">
      <div class="ir-text">${esc(it.text)}</div>
      <div class="ir-ctrl">
        <select class="ir-act">
          <option value="new" ${isNew ? 'selected' : ''}>新建任务</option>
          <option value="ignore" ${action === 'ignore' ? 'selected' : ''}>忽略（已有相关任务）</option>
        </select>
        <input class="ir-name" value="${esc(it.name || it.text.slice(0, 40))}" placeholder="新任务名" ${isNew ? '' : 'style="display:none"'}>
        <select class="ir-kind" ${isNew ? '' : 'style="display:none"'}>
          <option value="task" ${kind === 'task' ? 'selected' : ''}>短期任务</option>
          <option value="board" ${kind === 'board' ? 'selected' : ''}>看板任务</option>
        </select>
        <select class="ir-group" ${isNew && kind === 'task' ? '' : 'style="display:none"'}>${groupOpts}</select>
        <button class="btn sm pri ir-confirm">${action === 'ignore' ? '忽略' : '确认'}</button>
      </div>
      <div class="ir-reason"><span>${esc(it.reason || '')}</span><span>置信度 ${Math.round((Number(it.confidence) || 0) * 100)}%</span></div>
    </div>`
  }).join('')
  panel.innerHTML = `
    <div class="ir-head">归类结果 · 新建任务（看板 / 短期）或忽略（已有相关任务）；确认后把需求写入该任务的「会话管理」提示词，并从便签移除</div>
    <div class="ir-rows">${rows}</div>
    <div class="ir-foot">
      <span class="sp"></span>
      <span id="irCount" class="hint"></span>
    </div>`
  panel.querySelectorAll('.ir-row').forEach((row) => wireReviewRow(row))
  updateReviewCount()
  input.style.display = 'none'
  panel.hidden = false
  setTriageButton('cancel')
  refreshIcons()
}

function wireReviewRow(row) {
  const act = row.querySelector('.ir-act')
  const name = row.querySelector('.ir-name')
  const kind = row.querySelector('.ir-kind')
  const group = row.querySelector('.ir-group')
  const cbtn = row.querySelector('.ir-confirm')
  const sync = () => {
    const isNew = act.value === 'new'
    name.style.display = isNew ? '' : 'none'
    kind.style.display = isNew ? '' : 'none'
    group.style.display = (isNew && kind.value === 'task') ? '' : 'none'
    if (cbtn) cbtn.textContent = act.value === 'ignore' ? '忽略' : '确认'
  }
  act.addEventListener('change', sync)
  kind.addEventListener('change', sync)
  sync()
  cbtn.addEventListener('click', () => confirmReviewRow(row))
}

function reviewRowItem(row) {
  const action = row.querySelector('.ir-act').value
  const text = row.getAttribute('data-text')
  if (action === 'ignore') return { ignore: true, text }
  const name = row.querySelector('.ir-name').value.trim() || text.slice(0, 40)
  const kind = row.querySelector('.ir-kind').value === 'board' ? 'board' : 'task'
  const groupId = kind === 'task' ? row.querySelector('.ir-group').value : ''
  return { action: 'new', text, name, kind, groupId }
}

async function confirmReviewRow(row) {
  const it = reviewRowItem(row)
  if (it.error) { toast(it.error); return }
  if (it.ignore) {
    // 忽略（已有相关任务）：不新建、不执行，仅将已处理的行从便签移除
    review.confirmed.push(it.text)
    row.remove(); updateReviewCount(); maybeFinishReview(); return
  }
  const cbtn = row.querySelector('.ir-confirm')
  if (cbtn) cbtn.disabled = true
  let r
  try {
    r = await inboxInvoke('apply', { items: [it] })
  } catch (e) {
    toast('应用失败：' + e.message, 'err', 4000)
    if (cbtn) cbtn.disabled = false
    return
  }
  const ok = (r.results || []).find((x) => x.ok)
  const fail = (r.results || []).find((x) => !x.ok)
  if (!ok || fail) {
    toast('应用失败' + (fail && fail.error ? '：' + fail.error : ''), 'err', 4000)
    if (cbtn) cbtn.disabled = false
    return
  }
  review.confirmed.push(it.text)
  try { await reloadTasks() } catch {}
  emit('tasks-changed')
  renderInboxBoard()
  renderInboxCode()
  toast('已归类：' + (ok.taskName || it.text))
  row.remove()
  updateReviewCount()
  maybeFinishReview()
}

function updateReviewCount() {
  const el = $('#irCount')
  const panel = $('#inboxReview')
  if (!el || !panel) return
  const n = panel.querySelectorAll('.ir-row').length
  el.textContent = n ? `剩余 ${n} 条待确认` : ''
}

function maybeFinishReview() {
  const panel = $('#inboxReview')
  if (!panel || panel.hidden) return
  if (panel.querySelectorAll('.ir-row').length === 0) finishReview({ cancelled: false })
}

// 回到输入框：已确认的行从便签删除，未确认的保留
function finishReview({ cancelled } = {}) {
  const input = $('#inboxInput')
  const panel = $('#inboxReview')
  const base = review ? review.base : (input ? input.value : '')
  const confirmed = review ? review.confirmed : []
  const remaining = removeConfirmedLines(base, confirmed)
  if (input) { input.value = remaining; input.style.display = ''; input.readOnly = false; input.classList.remove('busy') }
  if (panel) { panel.hidden = true; panel.innerHTML = '' }
  review = null
  busy = false
  setTriageButton('idle')
  inboxInvoke('save', { content: remaining }).catch(() => {})
  const left = remaining.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length
  if (left) setHint(`便签保留 ${left} 条待处理`)
  else setHint(cancelled ? '已取消，便签已无待处理项' : '便签已清空，可继续记录新需求')
}
