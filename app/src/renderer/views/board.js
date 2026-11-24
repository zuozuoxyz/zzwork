// 短期任务看板：卡片复用 tasks(scope='board')，进行中卡片内嵌 AI 会话
import { invoke, store, env as envApi, chat as chatApi, onChatEvent, fsapi } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, ic, refreshIcons } from '../lib/ui.js'
import { reloadBoard } from '../lib/data.js'
import { renderMarkdown, openImageZoom, bindMarkdownClicks } from '../components/markdown.js'
import { buildImageAttachment, imagesFromPaste, ATTACH_MAX } from '../workbench/chat.js'
import { toast } from '../components/toast.js'

const boardInvoke = (m, p) => invoke('board', m, p || {})

// 允许拖动的列 → 允许的目标列：未开始→进行中（开始，AI 自动作答）或直接→已完成（归档），待审核→已完成（归档），已完成→待审核（打回）
const DRAG_TARGET = { todo: ['doing', 'done'], review: ['done'], done: ['review'] }
let dragId = null
// 正在启动作答的卡片：期间禁止再次拖动/重复触发，避免连拖两次跑出重复对话
const pendingStart = new Set()

export function initBoardView() {
  const nb = $('#boardNewBtn')
  if (nb) nb.addEventListener('click', () => newCard().catch((e) => toast(e.message, 'err')))
  const rb = $('#boardRefreshBtn')
  if (rb) rb.addEventListener('click', () => renderBoard().catch((e) => toast(e.message, 'err')))
  const body = $('#boardBody')
  if (body) {
    body.addEventListener('click', (e) => {
      if (e.target.closest('[data-newcard]')) { newCard().catch((err) => toast(err.message, 'err')); return }
      const stopEl = e.target.closest('[data-stop]')
      if (stopEl) {
        const c = state.boardCards.find((x) => x.id === stopEl.getAttribute('data-stop'))
        if (c) stopCard(c).catch((err) => toast(err.message, 'err'))
        return
      }
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
  if (!card || !DRAG_TARGET[card.status] || pendingStart.has(card.id)) { e.preventDefault(); return }
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
  const allowed = card && DRAG_TARGET[card.status]
  if (!card || !col || !allowed || !allowed.includes(col.getAttribute('data-col'))) { clearDropHl(); return }
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
  const allowed = card && DRAG_TARGET[card.status]
  clearDrag()
  if (!card || !target || !allowed || !allowed.includes(target)) return
  e.preventDefault()
  if (target === 'doing') {
    // 只允许「未开始 → 进行中」；已在启动中则忽略重复拖动
    if (card.status !== 'todo' || pendingStart.has(card.id)) return
    pendingStart.add(card.id)
    // 乐观移动：立刻挪进「进行中」，避免“拖了没反应”再拖一次导致重复作答
    card.status = 'doing'
    const body = $('#boardBody')
    if (body) { renderKanban(body); refreshIcons() }
    startCard(card, { openChat: false })
      .catch((err) => { card.status = 'todo'; toast(err.message, 'err'); renderBoard().catch(() => {}) })
      .finally(() => pendingStart.delete(card.id))
  } else if (target === 'done') finishCard(card).catch((err) => toast(err.message, 'err'))
  else if (target === 'review') reopenCard(card).catch((err) => toast(err.message, 'err'))
}

export async function renderBoard() {
  try { await reloadBoard() } catch {}
  await renderSide()
  const body = $('#boardBody')
  if (!body) return
  renderKanban(body)
  refreshIcons()
}

// 本机环境里已安装可用的执行体 id 集合（含 builtin）；无识别结果返回 null（不过滤）
async function localAvailableAgentIds() {
  const localEnv = state.envs.find((e) => e.kind === 'local') || { id: 'local', kind: 'local', config: {} }
  let det = state.detected[localEnv.id]
  if (!det) {
    try {
      const r = await envApi('detect', { id: localEnv.id, kind: 'local' })
      if (r && Array.isArray(r.list)) { det = { list: r.list, at: Date.now() }; state.detected[localEnv.id] = det }
    } catch {}
  }
  return det ? new Set(det.list.filter((a) => a.ok).map((a) => a.id)) : null
}

// 侧栏：基本信息配置（统一作用于看板所有卡片）
async function renderSide() {
  const el = $('#boardSideBody')
  if (!el) return
  let cfg = { model_id: '', agent_id: '', skillExclude: [], mcpExclude: [] }
  try { cfg = await boardInvoke('config') } catch {}
  const dflt = state.models.find((m) => m.is_default) || state.models[0] || null
  const allAgents = state.agents.length ? state.agents : [{ id: 'builtin', name: '内置模型聊天', kind: 'builtin' }]
  const okIds = await localAvailableAgentIds()
  const availAgents = okIds ? allAgents.filter((a) => a.kind === 'external' || okIds.has(a.id)) : allAgents
  const agents = availAgents.length ? availAgents : allAgents
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
      <option value="" ${cfg.agent_id ? '' : 'selected'}>（自动：本机 CLI 优先）</option>
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
    const stop = c.status === 'doing'
      ? `<button class="bstop" data-stop="${esc(c.id)}" title="停止并转入待审核">${ic('square', 10)}</button>`
      : ''
    return `<div class="bcard ${esc(c.status)}${draggable ? ' draggable' : ''}" data-card="${esc(c.id)}"${draggable ? ' draggable="true"' : ''}>
      <div class="bct">${esc(c.name)}${stop}</div>
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
    await boardInvoke('create', { title: r.title, content: r.content, attachments: r.attachments || [] })
    await renderBoard()
  } catch (e) { toast('创建失败：' + e.message, 'err') }
}

async function startCard(card, opts = {}) {
  const open = opts.openChat !== false
  const r = await boardInvoke('start', { id: card.id })
  await renderBoard()
  if (open) {
    emit('open-card-tab', { card: { ...card, status: 'doing' }, sessionId: r && r.sessionId })
  } else if (r && r.runId) {
    // 后台执行：等运行结束后刷新看板（作答完成会自动进入待审核），不弹任何框
    await waitRun(r.runId)
    await renderBoard().catch(() => {})
  }
}

async function finishCard(card) {
  try { await boardInvoke('finish', { id: card.id }); await renderBoard() } catch (e) { toast(e.message, 'err') }
}

// 已完成打回待审核：直接改状态，不重新作答
async function reopenCard(card) {
  try { await store('tasks.update', { id: card.id, patch: { status: 'review' } }); await renderBoard() } catch (e) { toast(e.message, 'err') }
}

// 手动停止进行中的卡片：终止运行并转入待审核
async function stopCard(card) {
  try {
    await boardInvoke('stop', { id: card.id })
    await renderBoard()
    toast('已停止，转入待审核')
  } catch (e) { toast('停止失败：' + e.message, 'err') }
}

async function openCard(card) {
  if (!card) return
  // 未开始的临时任务点开是「编辑」，不打开 AI 对话标签；进行中/待审核/已完成进入对话标签
  if (card.status === 'todo') { await editCard(card); return }
  emit('open-card-tab', { card })
}

async function editCard(card) {
  if (card && card.status && card.status !== 'todo') { toast('只有未开始的临时任务才能编辑', 'err'); return }
  const r = await openEditor(card, true)
  if (!r || r.cancel) return
  try {
    await boardInvoke('update', { id: card.id, title: r.title, content: r.content, attachments: r.attachments || [] })
    // 仅保存：不打开对话标签，停留在看板
    await renderBoard()
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
        <textarea class="bta" id="bcContent" placeholder="描述要做的事，AI 会据此作答（可粘贴图片）">${esc(content)}</textarea>
        <div class="attstrip" id="bcAttachEd"></div>
      </div>
      <div class="bfoot">
        <span class="sp"></span>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn pri" data-act="save">保存</button>
      </div>`)
    let editAtt = (card.meta && Array.isArray(card.meta.attachments))
      ? card.meta.attachments.filter((a) => a && a.dataUrl).map((a) => ({ ...a, id: a.id || ('att-' + Math.random().toString(36).slice(2)) }))
      : []
    const edStrip = mask.querySelector('#bcAttachEd')
    const edContent = mask.querySelector('#bcContent')
    const renderEdAtt = () => {
      edStrip.classList.toggle('on', editAtt.length > 0)
      edStrip.innerHTML = editAtt.map((a) =>
        `<div class="attchip" title="${esc(a.name)}"><img src="${esc(a.thumb || a.dataUrl)}" alt="">
           <button class="attx" data-rm="${esc(a.id)}" title="移除">×</button></div>`).join('')
    }
    renderEdAtt()
    edContent.addEventListener('paste', (e) => {
      const files = imagesFromPaste(e)
      if (!files.length) return
      e.preventDefault()
      const room = ATTACH_MAX - editAtt.length
      if (room <= 0) { toast(`最多 ${ATTACH_MAX} 张图片`, 'warn'); return }
      files.slice(0, room).forEach(async (f) => {
        const a = await buildImageAttachment(f)
        if (a) { editAtt.push(a); renderEdAtt() }
      })
    })
    edStrip.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-rm]')
      if (!btn) return
      editAtt = editAtt.filter((a) => a.id !== btn.getAttribute('data-rm'))
      renderEdAtt()
    })
    const finish = (v) => { close(); resolve(v) }
    const collect = () => ({
      title: mask.querySelector('#bcTitle').value.trim() || '未命名任务',
      content: mask.querySelector('#bcContent').value,
      attachments: editAtt.map(({ name, mime, dataUrl, thumb, size }) => ({ name, mime, dataUrl, thumb, size }))
    })
    mask.querySelector('[data-act="cancel"]').addEventListener('click', () => finish({ cancel: true }))
    mask.querySelector('[data-act="save"]').addEventListener('click', () => finish({ save: true, ...collect() }))
    // 回车保存、Esc 取消，避免只能靠点按钮关闭
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish({ cancel: true }) }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish({ save: true, ...collect() }) }
    })
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
// 文件改动卡片：与任务里的 AI 对话保持一致（可展开的文件 diff）
const CARD_DIFF_LIMIT = 8000
function cardDiffPre(text) {
  return String(text || '').replace(/\n$/, '').split(/\r?\n/).map((line) => {
    let cls = 'dl'
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) cls += ' meta'
    else if (line.startsWith('@@')) cls += ' hunk'
    else if (line.startsWith('+')) cls += ' in'
    else if (line.startsWith('-')) cls += ' out'
    return `<span class="${cls}">${esc(line) || ' '}</span>`
  }).join('')
}
function cardDiffFileHtml(f) {
  const file = f || {}
  const st = file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'
  const cls = file.status === 'added' ? 'add' : file.status === 'deleted' ? 'del' : 'mod'
  let body = ''
  if (file.binary) body = `<div class="dtag">二进制文件</div>`
  else if (file.patch) {
    const full = String(file.patch)
    const shown = full.length > CARD_DIFF_LIMIT ? full.slice(0, CARD_DIFF_LIMIT) + '\n…（已截断）' : full
    body = `<pre>${cardDiffPre(shown)}</pre>`
  }
  return `<details class="drow"><summary><span class="dst ${cls}">${st}</span>
    <span class="dp">${esc(file.path || '')}</span>
    <span class="dn"><span class="plus">+${Number(file.adds) || 0}</span><span class="minus">−${Number(file.dels) || 0}</span></span></summary>${body}</details>`
}
function cardDiffHtml(m) {
  const meta = m.meta || {}
  const files = Array.isArray(meta.files) ? meta.files : []
  const rows = files.map(cardDiffFileHtml).join('')
  const note = meta.note ? `<span class="dnote">${esc(meta.note)}</span>` : ''
  const adds = files.reduce((n, f) => n + (Number(f.adds) || 0), 0)
  const dels = files.reduce((n, f) => n + (Number(f.dels) || 0), 0)
  const open = files.length > 5 ? '' : ' open'
  return `<details class="diffbox"${open} data-mid="${esc(m.id)}"><summary class="dhead">
    <span class="dbchev">${ic('chevron-right', 12)}</span>${ic('git-compare', 13)}
    <span class="dtitle">${esc(m.content || '本次修改')}</span>
    <span class="dfiles">${files.length} 个文件</span>
    <span class="dstat"><span class="plus">+${adds}</span><span class="minus">−${dels}</span></span>
    ${note}</summary>
    <div class="dbody">${rows}</div></details>`
}
function cardMsgHtml(m) {
  if (m.kind === 'diff') return `<div class="carddiff">${cardDiffHtml(m)}</div>`
  if (m.role === 'user') {
    const atts = (m.meta && Array.isArray(m.meta.attachments)) ? m.meta.attachments : []
    const imgs = atts.filter((a) => a && (a.thumb || a.dataUrl))
      .map((a) => `<img class="uimg" src="${esc(a.thumb || a.dataUrl)}"${a.path ? ` data-path="${esc(a.path)}"` : ''} alt="${esc(a.name || '图片')}" title="点击放大">`).join('')
    const textHtml = m.content ? `<span>${esc(m.content)}</span>` : ''
    return `<div class="bmsg u">${textHtml}${imgs ? `<div class="ubatt">${imgs}</div>` : ''}</div>`
  }
  if (m.kind === 'error') return `<div class="err">${esc(m.content || '')}</div>`
  if (m.pending) return `<div class="bmsg a"><div class="bpend"><span class="tspin"></span><span>思考中…</span></div></div>`
  return `<div class="bmsg a">${cardPartsHtml(cardPartsOf(m), !!m.stream)}</div>`
}

function chatHtml(card) {
  return `
    <div class="cardchat-h">
      <span class="cardchat-t" title="${esc(card.name || '')}">${esc(card.name || '')}</span>
      <span class="bsub" id="bcStatus">进行中</span>
      <span class="sp"></span>
      <button class="btn sm" data-cardedit title="编辑名称与详情">${ic('pencil', 12)}<span>编辑</span></button>
      <button class="btn sm" data-act="stop" style="display:none">停止</button>
    </div>
    <div class="bchat" id="bcMsgs"><div class="hint">加载中…</div></div>
    <div class="bchat-in" id="bcInWrap">
      <div class="attstrip" id="bcAttach"></div>
      <textarea class="bta" id="bcInput" rows="2" placeholder="继续追问…（Enter 发送，Shift+Enter 换行，可粘贴图片）"></textarea>
      <div class="bchat-act">
        <button class="btn pri" data-act="send">发送</button>
      </div>
    </div>`
}

// 把看板卡片的 AI 对话挂载到常驻宿主（#cardChat），数据走 board 管线；返回 cleanup
export function mountCardChat(hostEl, card, preset) {
  const pre = preset && typeof preset === 'object' ? preset : { sessionId: preset || '' }
  hostEl.innerHTML = chatHtml(card)
  const box = hostEl.querySelector('#bcMsgs')
  // 对话/详情里的链接：交给系统浏览器或忽略，绝不让主窗口跳转（否则会覆盖整个应用）
  bindMarkdownClicks(box)
  const statusEl = hostEl.querySelector('#bcStatus')
  const sendBtn = hostEl.querySelector('[data-act="send"]')
  const stopBtn = hostEl.querySelector('[data-act="stop"]')
  const inputWrap = hostEl.querySelector('#bcInWrap')
  const input = hostEl.querySelector('#bcInput')
  const editBtn = hostEl.querySelector('[data-cardedit]')
  const attStrip = hostEl.querySelector('#bcAttach')
  let pendingAtt = []
  const renderAtt = () => {
    if (!attStrip) return
    attStrip.classList.toggle('on', pendingAtt.length > 0)
    attStrip.innerHTML = pendingAtt.map((a) =>
      `<div class="attchip" title="${esc(a.name)}"><img src="${esc(a.thumb || a.dataUrl)}" alt="">
         <button class="attx" data-rm="${esc(a.id)}" title="移除">×</button></div>`).join('')
  }
  const addAttFiles = async (files) => {
    const room = ATTACH_MAX - pendingAtt.length
    if (room <= 0) { toast(`最多 ${ATTACH_MAX} 张图片`, 'warn'); return }
    for (const f of files.slice(0, room)) {
      const a = await buildImageAttachment(f)
      if (a) { pendingAtt.push(a); renderAtt() }
    }
  }

  const LABEL = { todo: '未开始', doing: '进行中', review: '待审核', done: '已完成' }
  const content = String((card.meta && card.meta.content) || '')
  const detailAtts = (() => {
    const atts = (card.meta && Array.isArray(card.meta.attachments)) ? card.meta.attachments : []
    const imgs = atts.filter((a) => a && (a.thumb || a.dataUrl))
      .map((a) => `<img class="uimg" src="${esc(a.thumb || a.dataUrl)}" alt="${esc(a.name || '图片')}" title="点击放大">`).join('')
    return imgs ? `<div class="ubatt">${imgs}</div>` : ''
  })()
  let sessionId = pre.sessionId || ''
  let running = false
  let msgs = []
  let unsub = () => {}
  let rafFrame = 0
  let status = card.status || 'todo'

  const syncRunning = () => { if (stopBtn) stopBtn.style.display = running ? '' : 'none' }
  const setStatus = (s) => {
    status = s
    statusEl.textContent = LABEL[s] || s
    statusEl.className = 'bsub ' + s
    // 未开始先展示详情 + 开始作答；已完成只读，均隐藏输入区
    if (inputWrap) inputWrap.style.display = (s === 'todo' || s === 'done') ? 'none' : ''
    // 只有未开始的任务才允许编辑
    if (editBtn) editBtn.style.display = s === 'todo' ? '' : 'none'
    syncRunning()
  }
  setStatus(status)

  const cleanup = () => {
    try { unsub() } catch {}
    if (rafFrame) cancelAnimationFrame(rafFrame)
    rafFrame = 0
  }

  const renderTodo = () => {
    const body = content
      ? `<div class="cardbrief-l">任务详情</div><div class="cardbrief">${renderMarkdown(content)}${detailAtts}</div>`
      : `<div class="hint">这个任务还没有详情，点「编辑」补充后再开始作答。</div>`
    box.innerHTML = `${body}<div class="bstartwrap"><button class="btn pri" data-act="startRun">${ic('play', 12)}<span>开始作答</span></button></div>`
    refreshIcons()
  }
  const render = () => {
    if (!msgs.length) {
      if (status === 'todo') { renderTodo(); return }
      const detail = content ? `<div class="cardbrief-l">任务详情</div><div class="cardbrief">${renderMarkdown(content)}${detailAtts}</div>` : ''
      if (status === 'done') { box.innerHTML = `${detail}<div class="hint">该任务已完成，仅供查看。</div>`; refreshIcons(); return }
      // 进行中/待审核但暂无历史消息：展示任务详情，避免空白
      box.innerHTML = detail || `<div class="hint">AI 正在根据标题与内容作答…</div>`
      refreshIcons()
      return
    }
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
      if (c) { card.status = c.status; setStatus(c.status) }
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
    if (type === 'diff') {
      msgs.push({
        id: ev.messageId || ('diff-' + Date.now()), role: 'assistant', kind: 'diff', content: ev.summary || '',
        meta: { files: ev.files || [], note: ev.note || '' }
      })
      render(); return
    }
    if (type === 'done') {
      running = false
      syncRunning()
      const last = msgs[msgs.length - 1]
      if (last && last.stream && last.pending && !(last.parts && last.parts.length) && !last.content) msgs.pop()
      else if (last && last.stream) { last.stream = false; last.pending = false }
      if (ev.error) msgs.push({ role: 'assistant', kind: 'error', content: '出错：' + ev.error })
      render()
      refreshStatus()
      return
    }
  }

  const loadInit = async () => {
    try {
      const info = await chatApi('init', { taskId: card.id, sessionId })
      sessionId = (info && info.session && info.session.id) || sessionId
      msgs = (info && info.messages || []).map((m) => ({ ...m, meta: cardMeta(m.meta) }))
      const live = info && info.live
      if (live && live.runId) {
        running = true
        const parts = (Array.isArray(live.parts) ? live.parts : []).map((p) => ({ ...p }))
        msgs.push({ role: 'assistant', content: live.content || '', parts, stream: true, pending: !parts.length, meta: {} })
      } else {
        running = false
      }
      render()
      syncRunning()
    } catch (e) { box.innerHTML = `<div class="err">加载会话失败：${esc(e.message)}</div>` }
  }

  const startRun = async () => {
    if (running) return
    running = true
    syncRunning()
    try {
      const s = await boardInvoke('start', { id: card.id })
      if (s && s.sessionId) sessionId = s.sessionId
      setStatus('doing')
      renderBoard().catch(() => {})
      await loadInit()
    } catch (e) {
      running = false
      syncRunning()
      toast('开始失败：' + e.message, 'err')
    }
  }

  const send = async () => {
    if (status === 'done') return
    const text = input.value.trim()
    const atts = pendingAtt.map(({ name, mime, dataUrl, thumb, size }) => ({ name, mime, dataUrl, thumb, size }))
    if ((!text && !atts.length) || running || sendBtn.disabled) return
    input.value = ''
    pendingAtt = []
    renderAtt()
    running = true
    syncRunning()
    try {
      const r = await boardInvoke('send', { id: card.id, sessionId, text, attachments: atts })
      if (r && r.sessionId) sessionId = r.sessionId
      setStatus('doing')
      renderBoard().catch(() => {})
    } catch (e) {
      running = false
      syncRunning()
      if (atts.length) { pendingAtt = atts.map((a) => ({ ...a, id: 'att-' + Math.random().toString(36).slice(2) })); renderAtt() }
      if (text && !input.value.trim()) input.value = text
      toast('发送失败：' + e.message, 'err')
    }
  }
  const stopRun = async () => {
    if (!running || stopBtn.disabled) return
    stopBtn.disabled = true
    try { await boardInvoke('stop', { id: card.id }) } catch (e) { toast('停止失败：' + e.message, 'err') }
    stopBtn.disabled = false
    running = false
    syncRunning()
    setStatus('review')
    refreshStatus()
  }

  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="startRun"]')) { startRun(); return }
    const img = e.target.closest && e.target.closest('img.uimg')
    if (img) {
      const p = img.getAttribute('data-path')
      const fallback = img.getAttribute('src') || ''
      if (p) fsapi('readBase64', { path: p }).then((d) => openImageZoom((d && d.dataUrl) || fallback, img.alt)).catch(() => openImageZoom(fallback, img.alt))
      else openImageZoom(fallback, img.alt)
    }
  })
  sendBtn.addEventListener('click', send)
  stopBtn.addEventListener('click', stopRun)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() } })
  input.addEventListener('paste', (e) => {
    const files = imagesFromPaste(e)
    if (!files.length) return
    e.preventDefault()
    addAttFiles(files)
  })
  if (attStrip) attStrip.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-rm]')
    if (!btn) return
    pendingAtt = pendingAtt.filter((a) => a.id !== btn.getAttribute('data-rm'))
    renderAtt()
  })
  if (editBtn) editBtn.addEventListener('click', () => editCard(card).catch((err) => toast(err.message, 'err')))

  unsub = onChatEvent(onEvent)
  if (status === 'todo') { render(); refreshStatus() }
  else { loadInit(); refreshStatus() }
  setTimeout(() => { try { if (status !== 'todo' && status !== 'done') input.focus() } catch {} }, 60)
  return cleanup
}

