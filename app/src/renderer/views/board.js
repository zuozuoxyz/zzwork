// 短期任务看板：卡片复用 tasks(scope='board')，进行中卡片内嵌 AI 会话
import { invoke, store, chat as chatApi, onChatEvent } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, ic, refreshIcons } from '../lib/ui.js'
import { reloadBoard } from '../lib/data.js'
import { renderMarkdown } from '../components/markdown.js'
import { toast } from '../components/toast.js'

const boardInvoke = (m, p) => invoke('board', m, p || {})

// 允许拖动的列 → 目标列：未开始→进行中（开始，AI 自动作答），待审核→已完成（归档）
const DRAG_TARGET = { todo: 'doing', review: 'done' }
let dragId = null

export function initBoardView() {
  const nb = $('#boardNewBtn')
  if (nb) nb.addEventListener('click', () => newCard().catch((e) => toast(e.message, 'err')))
  const rb = $('#boardRefreshBtn')
  if (rb) rb.addEventListener('click', () => renderBoard().catch((e) => toast(e.message, 'err')))
  const body = $('#boardBody')
  if (body) {
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-newcard]')) { newCard().catch((err) => toast(err.message, 'err')); return }
      const cardEl = e.target.closest('.bcard[data-card]')
      if (!cardEl) return
      const card = state.boardCards.find((c) => c.id === cardEl.getAttribute('data-card'))
      if (!card) return
      openCard(card).catch((err) => toast(err.message, 'err'))
    })
    body.addEventListener('dragstart', onDragStart)
    body.addEventListener('dragend', clearDrag)
    body.addEventListener('dragover', onDragOver)
    body.addEventListener('dragleave', onDragLeave)
    body.addEventListener('drop', onDrop)
  }
}

function clearDropHl() {
  document.querySelectorAll('#boardBody .bcolb.drop-hl').forEach((el) => el.classList.remove('drop-hl'))
}
function clearDrag() {
  dragId = null
  clearDropHl()
  document.querySelectorAll('#boardBody .bcard.dragging').forEach((el) => el.classList.remove('dragging'))
}
function onDragStart(e) {
  const cardEl = e.target.closest && e.target.closest('.bcard[data-card]')
  if (!cardEl) return
  const card = state.boardCards.find((c) => c.id === cardEl.getAttribute('data-card'))
  if (!card || !DRAG_TARGET[card.status]) { e.preventDefault(); return }
  dragId = card.id
  cardEl.classList.add('dragging')
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', card.id) } catch {}
  }
}
function onDragOver(e) {
  if (!dragId) return
  const card = state.boardCards.find((c) => c.id === dragId)
  const col = e.target.closest && e.target.closest('.bcol[data-col]')
  if (!card || !col || DRAG_TARGET[card.status] !== col.getAttribute('data-col')) { clearDropHl(); return }
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const bodyEl = col.querySelector('.bcolb')
  if (bodyEl && !bodyEl.classList.contains('drop-hl')) { clearDropHl(); bodyEl.classList.add('drop-hl') }
}
function onDragLeave(e) {
  const col = e.target.closest && e.target.closest('.bcol[data-col]')
  const bodyEl = col && col.querySelector('.bcolb')
  if (bodyEl && !bodyEl.contains(e.relatedTarget)) bodyEl.classList.remove('drop-hl')
}
function onDrop(e) {
  if (!dragId) return
  const card = state.boardCards.find((c) => c.id === dragId)
  const col = e.target.closest && e.target.closest('.bcol[data-col]')
  const target = col && col.getAttribute('data-col')
  clearDrag()
  if (!card || !target || DRAG_TARGET[card.status] !== target) return
  e.preventDefault()
  if (target === 'doing') startCard(card, { openChat: false }).catch((err) => toast(err.message, 'err'))
  else if (target === 'done') finishCard(card).catch((err) => toast(err.message, 'err'))
}

export async function renderBoard() {
  try { await reloadBoard() } catch {}
  await renderSide()
  const body = $('#boardBody')
  if (!body) return
  renderKanban(body)
  refreshIcons()
}

// 侧栏：基本信息配置（统一作用于看板所有卡片）
async function renderSide() {
  const el = $('#boardSideBody')
  if (!el) return
  let cfg = { model_id: '', agent_id: '', skillExclude: [], mcpExclude: [] }
  try { cfg = await boardInvoke('config') } catch {}
  const dflt = state.models.find((m) => m.is_default) || state.models[0] || null
  const agents = state.agents.length ? state.agents : [{ id: 'builtin', name: '内置模型聊天', kind: 'builtin' }]
  const skills = state.skills.filter((s) => s.env_id === 'global')
  const mcps = state.mcp.filter((m) => m.env_id === 'global')
  const exS = cfg.skillExclude || []
  const exM = cfg.mcpExclude || []
  const skillRows = skills.length ? skills.map((s) => `<label class="chkchip${exS.includes(s.id) ? ' off' : ''}" title="${esc(s.description || s.name)}">
      <input type="checkbox" data-skill="${esc(s.id)}" ${exS.includes(s.id) ? '' : 'checked'}><span>${esc(s.name)}</span></label>`).join('')
    : `<div class="hint">未发现 Skills，可在 Skills 视图扫描</div>`
  const mcpRows = mcps.length ? mcps.map((m) => `<label class="chkrow">
      <input type="checkbox" data-mcp="${esc(m.id)}" ${exM.includes(m.id) ? '' : 'checked'}>
      <span class="nm">${esc(m.name)}</span><span class="ds">${esc(m.type || 'stdio')}</span></label>`).join('')
    : `<div class="hint">未发现 MCP 服务</div>`

  el.innerHTML = `<div class="bside-cfg">
    <div class="bsc-sub">统一作用于看板内所有卡片</div>
    <label class="bsc-k">模型（内置聊天）</label>
    <select class="sel2" id="boardModelSel">
      <option value="" ${cfg.model_id ? '' : 'selected'}>（默认：${dflt ? esc(dflt.name) : '未配置'}）</option>
      ${modelGroupsHtml(cfg.model_id)}
    </select>
    <label class="bsc-k">执行体</label>
    <select class="sel2" id="boardAgentSel">
      ${agents.map((a) => `<option value="${esc(a.id)}" ${a.id === cfg.agent_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
    </select>
    <div class="bsc-sec">Skills<span>取消勾选即禁用</span></div>
    <div class="chklist chips" id="boardSkillToggles">${skillRows}</div>
    <div class="bsc-sec">MCP<span>取消勾选即禁用</span></div>
    <div class="chklist" id="boardMcpToggles">${mcpRows}</div>
  </div>`
  refreshIcons()

  const save = async () => {
    const next = {
      model_id: $('#boardModelSel').value,
      agent_id: $('#boardAgentSel').value,
      skillExclude: [...el.querySelectorAll('#boardSkillToggles input[data-skill]')].filter((i) => !i.checked).map((i) => i.getAttribute('data-skill')),
      mcpExclude: [...el.querySelectorAll('#boardMcpToggles input[data-mcp]')].filter((i) => !i.checked).map((i) => i.getAttribute('data-mcp'))
    }
    try { await boardInvoke('saveConfig', next); toast('看板配置已保存') } catch (e) { toast('保存失败：' + e.message, 'err') }
  }
  $('#boardModelSel').addEventListener('change', save)
  $('#boardAgentSel').addEventListener('change', save)
  el.querySelectorAll('#boardSkillToggles input, #boardMcpToggles input').forEach((i) => i.addEventListener('change', () => {
    const chip = i.closest('.chkchip')
    if (chip) chip.classList.toggle('off', !i.checked)
    save()
  }))
}

function modelGroupsHtml(selectedId) {
  const groups = []
  const used = new Set()
  for (const p of state.providers) {
    const ms = state.models.filter((m) => m.provider_id === p.id)
    if (!ms.length) continue
    ms.forEach((m) => used.add(m.id))
    groups.push(`<optgroup label="${esc(p.name)}">${ms.map((m) => `<option value="${esc(m.id)}" ${m.id === selectedId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`)
  }
  const rest = state.models.filter((m) => !used.has(m.id))
  if (rest.length) groups.push(`<optgroup label="未分组">${rest.map((m) => `<option value="${esc(m.id)}" ${m.id === selectedId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`)
  return groups.join('')
}

function renderKanban(body) {
  const cols = [
    { key: 'todo', label: '未开始' },
    { key: 'doing', label: '进行中' },
    { key: 'review', label: '待审核' },
    { key: 'done', label: '已完成' }
  ]
  const by = (k) => state.boardCards.filter((c) => c.status === k)
  const cardHtml = (c) => {
    const content = String((c.meta && c.meta.content) || '')
    const brief = content.length > 120 ? content.slice(0, 120) + '…' : content
    const draggable = !!DRAG_TARGET[c.status]
    return `<div class="bcard ${esc(c.status)}${draggable ? ' draggable' : ''}" data-card="${esc(c.id)}"${draggable ? ' draggable="true"' : ''}>
      <div class="bct">${esc(c.name)}</div>
      ${brief ? `<div class="bcc">${esc(brief)}</div>` : '<div class="bcc empty">（无内容）</div>'}
    </div>`
  }
  const colBody = (k) => {
    const cards = by(k).map(cardHtml).join('')
    if (k === 'todo') {
      return `${cards}<button class="baddcard" data-newcard="1"><i data-lucide="plus" style="width:12px;height:12px"></i> 新建任务</button>`
    }
    return cards || '<div class="hint">暂无卡片</div>'
  }
  body.innerHTML = `<div class="boardcols">
    ${cols.map((col) => `<div class="bcol" data-col="${col.key}">
      <div class="bcolh"><span>${col.label}</span><span class="bn">${by(col.key).length}</span></div>
      <div class="bcolb">${colBody(col.key)}</div>
    </div>`).join('')}
  </div>`
  refreshIcons()
}

async function newCard() {
  const r = await openEditor({ name: '', meta: {} }, false)
  if (!r || !r.save) return
  try {
    await boardInvoke('create', { title: r.title, content: r.content })
    await renderBoard()
  } catch (e) { toast('创建失败：' + e.message, 'err') }
}

async function startCard(card, opts = {}) {
  const open = opts.openChat !== false
  const r = await boardInvoke('start', { id: card.id })
  await renderBoard()
  if (open) {
    await openChat({ ...card, status: 'doing' }, { sessionId: r && r.sessionId, runId: r && r.runId })
  } else if (r && r.runId) {
    // 后台执行：等运行结束后刷新看板（作答完成会自动进入待审核），不弹任何框
    await waitRun(r.runId)
    await renderBoard().catch(() => {})
  }
}

async function finishCard(card) {
  try { await boardInvoke('finish', { id: card.id }); await renderBoard() } catch (e) { toast(e.message, 'err') }
}

async function openCard(card) {
  if (card.status === 'todo' || card.status === 'done') await editCard(card)
  else await openChat(card)
}

async function editCard(card) {
  const r = await openEditor(card, true)
  if (!r || r.cancel) return
  try {
    await boardInvoke('update', { id: card.id, title: r.title, content: r.content })
    if (r.start) {
      const s = await boardInvoke('start', { id: card.id })
      await renderBoard()
      await openChat({ ...card, name: r.title, status: 'doing' }, { sessionId: s && s.sessionId, runId: s && s.runId })
    } else {
      await renderBoard()
    }
  } catch (e) { toast('保存失败：' + e.message, 'err') }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function waitRun(runId) {
  if (!runId) return
  for (let i = 0; i < 900; i++) {
    let r = null
    try { r = await store('runs.get', { id: runId }) } catch { return }
    if (!r || r.status !== 'running') return
    await sleep(400)
  }
}

function showModal(inner) {
  const host = document.getElementById('modal-host')
  const mask = document.createElement('div')
  mask.className = 'zz-modal-mask'
  mask.innerHTML = `<div class="zz-modal bmodal">${inner}</div>`
  host.appendChild(mask)
  refreshIcons()
  return { mask, close: () => mask.remove() }
}

function openEditor(card, existing) {
  return new Promise((resolve) => {
    const content = String((card.meta && card.meta.content) || '')
    const { mask, close } = showModal(`
      <div class="mt">${existing ? '编辑任务' : '新建任务'}</div>
      <div class="bform">
        <label class="blab">任务名称</label>
        <input class="binput" id="bcTitle" placeholder="给这个任务起个名字" value="${esc(card.name || '')}">
        <label class="blab">任务详情</label>
        <textarea class="bta" id="bcContent" placeholder="描述要做的事，AI 会据此作答">${esc(content)}</textarea>
      </div>
      <div class="bfoot">
        <span class="sp"></span>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn" data-act="save">保存</button>
        <button class="btn pri" data-act="start">保存并对话</button>
      </div>`)
    const finish = (v) => { close(); resolve(v) }
    const collect = () => ({
      title: mask.querySelector('#bcTitle').value.trim() || '未命名任务',
      content: mask.querySelector('#bcContent').value
    })
    mask.querySelector('[data-act="cancel"]').addEventListener('click', () => finish({ cancel: true }))
    mask.querySelector('[data-act="save"]').addEventListener('click', () => finish({ save: true, ...collect() }))
    mask.querySelector('[data-act="start"]').addEventListener('click', () => finish({ save: true, start: true, ...collect() }))
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) finish({ cancel: true }) })
    setTimeout(() => { const t = mask.querySelector('#bcTitle'); if (t) t.focus() }, 30)
  })
}

function cardMeta(m) {
  if (!m) return {}
  if (typeof m === 'object') return m
  try { return JSON.parse(m) } catch { return {} }
}
// 一条助手消息的有序片段：思考 / 工具 / 正文
function cardPartsOf(m) {
  const src = m.parts || (m.meta && m.meta.parts)
  if (Array.isArray(src) && src.length) return src
  return m.content ? [{ t: 'text', text: m.content }] : []
}
function cardToolHtml(p) {
  const running = (p.status || 'running') === 'running'
  const done = p.status === 'done' || p.status === 'completed'
  const ico = running ? '<span class="tspin"></span>' : ic(done ? 'check' : 'wrench', 12)
  return `<div class="btool ${running ? 'running' : 'done'}"><span class="btool-ic">${ico}</span><span class="btool-n">${esc(p.name || '步骤')}</span>${p.detail ? `<span class="btool-d">${esc(p.detail)}</span>` : ''}</div>`
}
// 思考 + 工具合并为一个可折叠工作框（默认折叠，与任务里的 AI 对话一致）
function cardWorkboxHtml(group, streaming) {
  const last = group[group.length - 1]
  const running = streaming && group.some((p) => (p.t === 'think' && !p.done) || (p.t === 'tool' && (p.status || 'running') === 'running'))
  const hasThink = group.some((p) => p.t === 'think')
  const head = running ? (last.t === 'think' ? '正在思考…' : '正在执行…') : (hasThink ? '思考过程' : '执行过程')
  const icon = running ? '<span class="tspin"></span>' : ic('check-check', 12)
  const rows = group.map((p) => p.t === 'think'
    ? `<div class="bthink-t">${esc(p.text || '')}</div>`
    : cardToolHtml(p)).join('')
  return `<details class="bthink"><summary class="bthink-h">${icon}<span class="bthink-label">${esc(head)}</span><span class="wbchev">${ic('chevron-right', 12)}</span></summary><div class="bthink-body">${rows}</div></details>`
}
function cardPartsHtml(parts, streaming) {
  const out = []
  let i = 0
  while (i < parts.length) {
    const p = parts[i]
    if (p.t === 'think' || p.t === 'tool') {
      const group = []
      while (i < parts.length && (parts[i].t === 'think' || parts[i].t === 'tool')) { group.push(parts[i]); i++ }
      out.push(cardWorkboxHtml(group, streaming && i === parts.length))
    } else if (p.t === 'text') {
      const buf = []
      while (i < parts.length && parts[i].t === 'text') { buf.push(parts[i].text || ''); i++ }
      const cursor = streaming && i === parts.length ? '<span class="cursor"></span>' : ''
      out.push(`<div class="md">${renderMarkdown(buf.join(''))}${cursor}</div>`)
    } else i++
  }
  return out.join('')
}
function cardMsgHtml(m) {
  if (m.role === 'user') return `<div class="bmsg u">${esc(m.content || '')}</div>`
  if (m.kind === 'error') return `<div class="err">${esc(m.content || '')}</div>`
  if (m.pending) return `<div class="bmsg a"><div class="bpend"><span class="tspin"></span><span>思考中…</span></div></div>`
  return `<div class="bmsg a">${cardPartsHtml(cardPartsOf(m), !!m.stream)}</div>`
}

async function openChat(card, preset) {
  const pre = preset && typeof preset === 'object' ? preset : { sessionId: preset || '' }
  const { mask, close } = showModal(`
    <div class="mt">${esc(card.name)} <span class="bsub" id="bcStatus">进行中</span></div>
    <div class="bchat" id="bcMsgs"><div class="hint">加载中…</div></div>
    <div class="bchat-in">
      <textarea class="bta" id="bcInput" rows="2" placeholder="继续追问…（Enter 发送，Shift+Enter 换行）"></textarea>
      <div class="bchat-act">
        <button class="btn pri" data-act="send">发送</button>
      </div>
    </div>`)
  const box = mask.querySelector('#bcMsgs')
  const statusEl = mask.querySelector('#bcStatus')
  const sendBtn = mask.querySelector('[data-act="send"]')
  const input = mask.querySelector('#bcInput')
  const LABEL = { todo: '未开始', doing: '进行中', review: '待审核', done: '已完成' }
  const setStatus = (s) => { card.status = s; statusEl.textContent = LABEL[s] || s; statusEl.className = 'bsub ' + s }
  setStatus(card.status || 'doing')
  let sessionId = pre.sessionId || ''
  let running = false
  let msgs = []
  let unsub = () => {}
  let rafFrame = 0
  const closeChat = () => { try { unsub() } catch {}; if (rafFrame) cancelAnimationFrame(rafFrame); close() }

  const render = () => {
    if (!msgs.length) { box.innerHTML = `<div class="hint">AI 正在根据标题与内容作答…</div>`; return }
    box.innerHTML = msgs.map(cardMsgHtml).join('')
    box.scrollTop = box.scrollHeight
    refreshIcons()
  }
  // 流式事件按帧合并，避免每个增量都整表重排
  const scheduleRender = () => {
    if (rafFrame) return
    rafFrame = requestAnimationFrame(() => { rafFrame = 0; render() })
  }
  const ensureStream = () => {
    let last = msgs[msgs.length - 1]
    if (!last || last.role !== 'assistant' || !last.stream) {
      last = { role: 'assistant', content: '', parts: [], stream: true, pending: true, meta: {} }
      msgs.push(last)
    }
    return last
  }
  const lastPart = (m) => (m.parts && m.parts.length ? m.parts[m.parts.length - 1] : null)
  const pushThink = (m, t) => {
    if (!t) return
    if (!m.parts) m.parts = []
    const lp = lastPart(m)
    if (lp && lp.t === 'think') lp.text += t
    else m.parts.push({ t: 'think', text: t })
  }
  const closeThink = (m) => { const lp = lastPart(m); if (lp && lp.t === 'think') lp.done = true }
  const pushText = (m, t) => {
    if (!t) return
    if (!m.parts) m.parts = []
    closeThink(m)
    const lp = lastPart(m)
    if (lp && lp.t === 'text') lp.text += t
    else m.parts.push({ t: 'text', text: t })
  }
  const upsertTool = (m, s) => {
    if (!s || !s.id) return
    if (!m.parts) m.parts = []
    closeThink(m)
    let p = m.parts.find((x) => x.t === 'tool' && x.id === s.id)
    if (!p) { p = { t: 'tool', id: s.id, name: s.name || '步骤', detail: s.detail || '', status: s.status || 'running' }; m.parts.push(p) }
    else { if (s.name) p.name = s.name; if (s.detail != null) p.detail = s.detail; if (s.status) p.status = s.status }
  }

  const refreshStatus = async () => {
    try {
      const list = await boardInvoke('list')
      const c = list.find((x) => x.id === card.id)
      if (c) setStatus(c.status)
    } catch {}
    renderBoard().catch(() => {})
  }

  // 实时订阅本卡片任务的聊天事件，跟任务里的 AI 对话一致
  const onEvent = (ev) => {
    if (!ev || ev.taskId !== card.id) return
    if (ev.sessionId && sessionId && ev.sessionId !== sessionId) return
    if (ev.sessionId && !sessionId) sessionId = ev.sessionId
    const type = ev.type
    if (type === 'user') {
      msgs.push({ role: 'user', content: ev.text, meta: { attachments: ev.attachments || [] } })
      const s = ensureStream(); s.pending = true
      render(); return
    }
    if (type === 'thinking') { const m = ensureStream(); m.pending = false; pushThink(m, ev.text); scheduleRender(); return }
    if (type === 'delta') { const m = ensureStream(); m.pending = false; pushText(m, ev.text); scheduleRender(); return }
    if (type === 'step') { const m = ensureStream(); m.pending = false; upsertTool(m, ev.step || {}); scheduleRender(); return }
    if (type === 'done') {
      running = false
      const last = msgs[msgs.length - 1]
      if (last && last.stream && last.pending && !(last.parts && last.parts.length) && !last.content) msgs.pop()
      else if (last && last.stream) { last.stream = false; last.pending = false }
      if (ev.error) msgs.push({ role: 'assistant', kind: 'error', content: '出错：' + ev.error })
      render()
      refreshStatus()
      return
    }
  }

  try {
    const info = await chatApi('init', { taskId: card.id, sessionId })
    sessionId = (info && info.session && info.session.id) || sessionId
    msgs = (info && info.messages || []).map((m) => ({ ...m, meta: cardMeta(m.meta) }))
    const live = info && info.live
    if (live && live.runId) {
      running = true
      runId = live.runId
      const parts = (Array.isArray(live.parts) ? live.parts : []).map((p) => ({ ...p }))
      msgs.push({ role: 'assistant', content: live.content || '', parts, stream: true, pending: !parts.length, meta: {} })
    }
    render()
  } catch (e) { box.innerHTML = `<div class="err">加载会话失败：${esc(e.message)}</div>` }

  unsub = onChatEvent(onEvent)
  refreshStatus()

  const send = async () => {
    const text = input.value.trim()
    if (!text || running || sendBtn.disabled) return
    input.value = ''
    running = true
    try {
      const r = await boardInvoke('send', { id: card.id, sessionId, text })
      if (r && r.sessionId) sessionId = r.sessionId
      setStatus('doing')
      renderBoard().catch(() => {})
    } catch (e) {
      running = false
      toast('发送失败：' + e.message, 'err')
    }
  }
  sendBtn.addEventListener('click', send)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() } })
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) closeChat() })
  setTimeout(() => input.focus(), 60)
}
