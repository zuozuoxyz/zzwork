// 需求便签：工作区顶层记录 + 归类（新建/归入任务）+ 一键执行
import { invoke, store } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, ic, taskIcon, debounce, refreshIcons } from '../lib/ui.js'
import { reloadTasks } from '../lib/data.js'
import { toast } from '../components/toast.js'

let loaded = false
let busy = false
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
  $('#triageBtn').addEventListener('click', () => runTriage().catch((e) => toast(e.message, 'err')))
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
  const content = input.value.trim()
  if (!content) { toast('便签是空的，先记录几条需求'); return }
  busy = true
  setHint('正在归类…')
  let result
  try {
    result = await inboxInvoke('triage', { content })
  } finally {
    busy = false
  }
  const items = (result && result.items) || []
  if (!items.length) { toast('没有可归类的需求行'); setHint('自动保存到工作区 .zzwork/inbox.md'); return }
  setHint(`归类完成（${result.mode === 'llm' ? 'AI' : '关键词'}），请确认`)
  const applied = await showTriageModal(items, result.mode)
  if (!applied) { setHint('自动保存到工作区 .zzwork/inbox.md'); return }
  await applyTriage(applied, content)
}

function showTriageModal(items, mode) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-host')
    const mask = document.createElement('div')
    mask.className = 'zz-modal-mask'

    const rows = items.map((it, i) => {
      const action = it.action === 'attach' ? 'attach' : it.action === 'ignore' ? 'ignore' : 'new'
      const taskOpts = state.tasks.filter((t) => t.scope !== 'board').map((t) => `<option value="${esc(t.id)}" ${t.id === it.taskId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
      return `<div class="tri-row" data-i="${i}" data-text="${esc(it.text)}"
          data-reason="${esc(it.reason || '')}">
        <div class="txt">${esc(it.text)}</div>
        <select class="tri-act">
          <option value="new" ${action === 'new' ? 'selected' : ''}>新建任务</option>
          <option value="attach" ${action === 'attach' ? 'selected' : ''}>归入任务</option>
          <option value="ignore" ${action === 'ignore' ? 'selected' : ''}>忽略</option>
        </select>
        <div class="tri-target">
          <input class="tri-name" value="${esc(it.name || it.text.slice(0, 40))}" placeholder="新任务名" ${action === 'new' ? '' : 'style="display:none"'}>
          <select class="tri-task" ${action === 'attach' ? '' : 'style="display:none"'}>
            ${taskOpts || '<option value="">（暂无任务）</option>'}
          </select>
        </div>
        <div class="sub">
          <span class="tri-reason">${esc(it.reason || '')}</span>
          <span>置信度 ${Math.round((Number(it.confidence) || 0) * 100)}%</span>
          <select class="tri-scope" style="margin-left:auto;width:120px;${action === 'new' ? '' : 'display:none'}">
            <option value="long" ${it.scope === 'short' ? '' : 'selected'}>中长期</option>
            <option value="short" ${it.scope === 'short' ? 'selected' : ''}>短期·看板</option>
          </select>
          <select class="tri-type" style="width:100px">
            <option value="work" ${it.type === 'code' ? '' : 'selected'}>work</option>
            <option value="code" ${it.type === 'code' ? 'selected' : ''}>code</option>
          </select>
          <button class="btn sm tri-only" data-only="${i}" title="只应用这一条">仅应用</button>
        </div>
      </div>`
    }).join('')

    mask.innerHTML = `<div class="zz-modal tr">
      <div class="mt">需求归类（${mode === 'llm' ? 'AI' : '关键词'}）</div>
      <div class="mn">新建可设为中长期任务或短期看板卡片，或归入已有任务；可逐条「仅应用」或底部「全部确认」。确认后的行会从便签删除。</div>
      <div class="tri-rows">${rows}</div>
      <div class="tri-foot">
        <label class="mf inline" style="margin:0"><input type="checkbox" id="tri-exec" checked> 立即执行</label>
        <span class="sp"></span>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn pri" data-act="ok">归类并执行</button>
      </div>
    </div>`

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true)
      mask.remove()
      resolve(val)
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null) } }

    mask.querySelectorAll('.tri-row').forEach((row) => {
      const act = row.querySelector('.tri-act')
      const name = row.querySelector('.tri-name')
      const task = row.querySelector('.tri-task')
      const scope = row.querySelector('.tri-scope')
      act.addEventListener('change', () => {
        const v = act.value
        name.style.display = v === 'new' ? '' : 'none'
        task.style.display = v === 'attach' ? '' : 'none'
        scope.style.display = v === 'new' ? '' : 'none'
      })
      if (act.value === 'attach' && !task.value) {
        const first = state.tasks.find((t) => t.scope !== 'board')
        if (first) task.value = first.id
      }
    })

    const rowItem = (row) => {
      const action = row.querySelector('.tri-act').value
      if (action === 'ignore') return null
      const text = row.getAttribute('data-text')
      if (action === 'attach') {
        const taskId = row.querySelector('.tri-task').value
        if (!taskId) return null
        const t = state.tasks.find((x) => x.id === taskId)
        return { action: 'attach', text, taskId, taskName: t ? t.name : '' }
      }
      const name = row.querySelector('.tri-name').value.trim() || text.slice(0, 40)
      const type = row.querySelector('.tri-type').value
      const scope = row.querySelector('.tri-scope').value === 'short' ? 'short' : 'long'
      return { action: 'new', text, name, type, scope }
    }

    mask.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null))
    mask.querySelectorAll('.tri-only').forEach((btn) => btn.addEventListener('click', () => {
      const row = btn.closest('.tri-row')
      const it = rowItem(row)
      if (!it) { toast('请先选择目标任务或填写名称'); return }
      close({ items: [it], execute: mask.querySelector('#tri-exec').checked, confirmedTexts: [it.text] })
    }))
    mask.querySelector('[data-act="ok"]').addEventListener('click', () => {
      const out = []
      mask.querySelectorAll('.tri-row').forEach((row) => {
        const it = rowItem(row)
        if (it) out.push(it)
      })
      if (!out.length) { toast('没有需要应用的需求'); return }
      close({ items: out, execute: mask.querySelector('#tri-exec').checked, confirmedTexts: out.map((x) => x.text) })
    })

    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null) })
    document.addEventListener('keydown', onKey, true)
    host.appendChild(mask)
    refreshIcons()
  })
}

async function applyTriage(payload, content) {
  const btn = $('#triageBtn')
  if (btn) btn.disabled = true
  setHint('正在应用…')
  try {
    const r = await inboxInvoke('apply', { items: payload.items, execute: payload.execute !== false })
    const ok = (r.results || []).filter((x) => x.ok)
    const fail = (r.results || []).filter((x) => !x.ok)
    await reloadTasks()
    emit('tasks-changed')
    const created = ok.filter((x) => x.action === 'new' && x.scope !== 'short').length
    const short = ok.filter((x) => x.scope === 'short').length
    const attached = ok.filter((x) => x.action === 'attach').length
    toast(`已处理 ${ok.length} 条：新建 ${created}${short ? ' · 看板 ' + short : ''} · 归入 ${attached}${fail.length ? ' · 失败 ' + fail.length : ''}`, fail.length ? 'err' : 'info', 4000)
    if (fail.length) console.warn('[inbox] 失败项', fail)
    // 只删除已确认应用的行，未确认的保留在便签里
    const input = $('#inboxInput')
    const removed = payload.confirmedTexts || []
    const remaining = removeConfirmedLines(input ? input.value : content, removed)
    if (input) input.value = remaining
    await inboxInvoke('save', { content: remaining })
    setHint(remaining.trim() ? `已应用，便签移除 ${removed.length} 条` : '已应用，便签已清空')
    renderInboxBoard()
    renderInboxCode()
    const first = ok.find((x) => x.taskId && x.sessionId)
    if (first) emit('open-session', { taskId: first.taskId, sessionId: first.sessionId || '' })
  } catch (e) {
    toast('应用失败：' + e.message, 'err', 4000)
    setHint('应用失败：' + e.message)
  } finally {
    if (btn) btn.disabled = false
  }
}
