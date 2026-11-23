// 需求便签：工作区顶层记录 + 归类（新建/归入任务）+ 一键执行
import { invoke, store } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, ic, taskIcon, debounce, refreshIcons } from '../lib/ui.js'
import { reloadTasks } from '../lib/data.js'
import { toast } from '../components/toast.js'

let loaded = false
let busy = false
// 归类审阅进行中：{ base: 原始便签内容, confirmed: 已确认应用的行文本[] }
let review = null
// 拖拽改状态：{ id, type, scope, status }
let inboxDrag = null
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
  loadInbox()
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

// 需求便签右栏：全部任务两栏总览（未完成 / 已完成）—— 只含 work 与看板任务
export async function renderInboxBoard() {
  const el = $('#inboxBoard')
  if (!el) return
  try { await reloadTasks() } catch {}
  const tasks = state.tasks.filter((t) => t.scope === 'board' || t.type === 'work')
  const done = tasks.filter((t) => t.status === 'done')
  const open = tasks.filter((t) => t.status !== 'done')
  const card = (t) => {
    const isBoard = t.scope === 'board'
    const [name, color] = isBoard ? ['kanban-square', '#a074c4'] : ['notebook', '#2dd4bf']
    return `<div class="ibcard ${isBoard ? 'board' : 'work'}" data-task="${esc(t.id)}" draggable="true">
      <span class="ibic" style="color:${color}">${ic(name, 13)}</span>
      <span class="ibn">${esc(t.name)}</span>
      <span class="ibp">${isBoard ? '短期' : 'work'}</span></div>`
  }
  el.innerHTML = `
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
  const codes = state.tasks.filter((t) => t.type === 'code')
  const ti = taskIcon('code')
  const card = (t) => {
    const done = t.status === 'done'
    return `<div class="ibcard code${done ? ' done' : ''}" data-task="${esc(t.id)}" draggable="${done ? 'false' : 'true'}" title="${esc(t.path || '')}">
      <span class="ibic" style="color:${ti.color}">${ic(ti.name, 13)}</span>
      <span class="ibn">${esc(t.name)}</span>
      ${done ? '<span class="ibdone">已完成</span>' : '<span class="ibp">code</span>'}</div>`
  }
  const cnt = $('#codeCount')
  if (cnt) cnt.textContent = codes.length ? codes.length + ' 个' : ''
  el.innerHTML = codes.length ? codes.map(card).join('') : '<div class="hint" style="padding:8px 2px">暂无代码任务</div>'
  wireInboxCards(el)
  refreshIcons()
}

// 卡片：点击跳转；可拖拽者记录拖拽源
function wireInboxCards(el) {
  el.querySelectorAll('.ibcard[data-task]').forEach((c) => {
    const id = c.getAttribute('data-task')
    c.addEventListener('click', () => emit('select-task', id))
    if (c.getAttribute('draggable') === 'false') return
    c.addEventListener('dragstart', (e) => {
      const t = state.tasks.find((x) => x.id === id)
      if (!t) return
      inboxDrag = { id, type: t.type, scope: t.scope, status: t.status }
      try { e.dataTransfer.effectAllowed = 'move' } catch {}
      try { e.dataTransfer.setData('text/plain', id) } catch {}
      c.classList.add('dragging')
    })
    c.addEventListener('dragend', () => { c.classList.remove('dragging'); inboxDrag = null })
  })
}

// 右栏「未完成/已完成」列作为放置目标
function attachColumnDrop(b) {
  const col = b.getAttribute('data-col')
  const valid = () => {
    if (!inboxDrag) return false
    if (inboxDrag.type === 'code' && col !== 'done') return false // code 任务只能落到已完成
    const cur = inboxDrag.status === 'done' ? 'done' : 'open'
    return col !== cur // 同列无需移动
  }
  b.addEventListener('dragover', (e) => {
    if (!valid()) return
    e.preventDefault()
    try { e.dataTransfer.dropEffect = 'move' } catch {}
    b.classList.add('drop-on')
  })
  b.addEventListener('dragleave', (e) => { if (e.target === b) b.classList.remove('drop-on') })
  b.addEventListener('drop', async (e) => {
    if (!valid()) return
    e.preventDefault()
    b.classList.remove('drop-on')
    const src = inboxDrag
    inboxDrag = null
    await dropToColumn(src, col)
  })
}

async function dropToColumn(src, col) {
  if (!src) return
  const cur = src.status === 'done' ? 'done' : 'open'
  if (col === cur) return
  const status = col === 'done' ? 'done' : (src.scope === 'board' ? 'todo' : 'active')
  try {
    await store('tasks.update', { id: src.id, patch: { status } })
    await reloadTasks()
    emit('tasks-changed')
    renderInboxBoard()
    renderInboxCode()
    toast(status === 'done' ? '已标记完成' : '已恢复到未完成')
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
  if (label) label.textContent = mode === 'running' ? '运行中' : mode === 'cancel' ? '取消' : '归类并执行'
  btn.disabled = mode === 'running'
  btn.classList.toggle('running', mode === 'running')
  btn.classList.toggle('cancelling', mode === 'cancel')
}

// 用内联审阅面板就地替换输入框，逐条确认
function enterReview(items, baseContent) {
  const input = $('#inboxInput')
  const panel = $('#inboxReview')
  if (!input || !panel) return
  review = { base: baseContent, confirmed: [] }
  const rows = items.map((it, i) => {
    const action = it.action === 'attach' ? 'attach' : it.action === 'ignore' ? 'ignore' : 'new'
    const taskOpts = state.tasks.filter((t) => t.scope !== 'board')
      .map((t) => `<option value="${esc(t.id)}" ${t.id === it.taskId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
    return `<div class="ir-row" data-i="${i}" data-text="${esc(it.text)}">
      <div class="ir-text">${esc(it.text)}</div>
      <div class="ir-ctrl">
        <select class="ir-act">
          <option value="new" ${action === 'new' ? 'selected' : ''}>新建任务</option>
          <option value="attach" ${action === 'attach' ? 'selected' : ''}>归入任务</option>
          <option value="ignore" ${action === 'ignore' ? 'selected' : ''}>忽略</option>
        </select>
        <input class="ir-name" value="${esc(it.name || it.text.slice(0, 40))}" placeholder="新任务名" ${action === 'new' ? '' : 'style="display:none"'}>
        <select class="ir-task" ${action === 'attach' ? '' : 'style="display:none"'}>${taskOpts || '<option value="">（暂无任务）</option>'}</select>
        <select class="ir-scope" ${action === 'new' ? '' : 'style="display:none"'}>
          <option value="long" ${it.scope === 'short' ? '' : 'selected'}>中长期</option>
          <option value="short" ${it.scope === 'short' ? 'selected' : ''}>短期看板</option>
        </select>
        <select class="ir-type" ${action === 'ignore' ? 'style="display:none"' : ''}>
          <option value="work" ${it.type === 'code' ? '' : 'selected'}>work</option>
          <option value="code" ${it.type === 'code' ? 'selected' : ''}>code</option>
        </select>
        <button class="btn sm pri ir-confirm">${action === 'ignore' ? '保留' : '确认'}</button>
      </div>
      <div class="ir-reason"><span>${esc(it.reason || '')}</span><span>置信度 ${Math.round((Number(it.confidence) || 0) * 100)}%</span></div>
    </div>`
  }).join('')
  panel.innerHTML = `
    <div class="ir-head">归类结果 · 逐条确认（确认后该行从便签移除；右上角「取消」保留未确认内容）</div>
    <div class="ir-rows">${rows}</div>
    <div class="ir-foot">
      <label class="mf inline" style="margin:0"><input type="checkbox" id="ir-exec" checked> 立即执行</label>
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
  const task = row.querySelector('.ir-task')
  const scope = row.querySelector('.ir-scope')
  const type = row.querySelector('.ir-type')
  const cbtn = row.querySelector('.ir-confirm')
  act.addEventListener('change', () => {
    const v = act.value
    name.style.display = v === 'new' ? '' : 'none'
    task.style.display = v === 'attach' ? '' : 'none'
    scope.style.display = v === 'new' ? '' : 'none'
    type.style.display = v === 'ignore' ? 'none' : ''
    if (cbtn) cbtn.textContent = v === 'ignore' ? '保留' : '确认'
    if (v === 'attach' && !task.value) {
      const first = state.tasks.find((t) => t.scope !== 'board')
      if (first) task.value = first.id
    }
  })
  if (act.value === 'attach' && !task.value) {
    const first = state.tasks.find((t) => t.scope !== 'board')
    if (first) task.value = first.id
  }
  cbtn.addEventListener('click', () => confirmReviewRow(row))
}

function reviewRowItem(row) {
  const action = row.querySelector('.ir-act').value
  const text = row.getAttribute('data-text')
  if (action === 'ignore') return { ignore: true, text }
  if (action === 'attach') {
    const taskId = row.querySelector('.ir-task').value
    if (!taskId) return { error: '请选择目标任务' }
    const t = state.tasks.find((x) => x.id === taskId)
    return { action: 'attach', text, taskId, taskName: t ? t.name : '' }
  }
  const name = row.querySelector('.ir-name').value.trim() || text.slice(0, 40)
  const type = row.querySelector('.ir-type').value
  const scope = row.querySelector('.ir-scope').value === 'short' ? 'short' : 'long'
  return { action: 'new', text, name, type, scope }
}

async function confirmReviewRow(row) {
  const it = reviewRowItem(row)
  if (it.error) { toast(it.error); return }
  if (it.ignore) { row.remove(); updateReviewCount(); maybeFinishReview(); return }
  const cbtn = row.querySelector('.ir-confirm')
  if (cbtn) cbtn.disabled = true
  const execute = $('#ir-exec') ? $('#ir-exec').checked : true
  let r
  try {
    r = await inboxInvoke('apply', { items: [it], execute })
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
  toast('已确认：' + (ok.taskName || it.text))
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
