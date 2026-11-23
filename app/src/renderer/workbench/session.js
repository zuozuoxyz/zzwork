// 会话管理 pane：提示词（可粘贴图片+发送） + 对话记录 + 右栏（功能图 / 画板，分段切换）
import { store } from '../lib/api.js'
import { state, on } from '../lib/state.js'
import { $, esc, ic, refreshIcons, debounce, basename, fmtTok } from '../lib/ui.js'
import { toast } from '../components/toast.js'
import { initBoard, renderBoard } from './board.js'
import { initFeatureMap, renderFeatureMap } from './featureMap.js'
import { buildImageAttachment, imagesFromPaste, sendChatMessage, ATTACH_MAX } from './chat.js'
import { openImageZoom, renderMarkdown, enhanceMarkdown } from '../components/markdown.js'

let taskId = null
let savePrompt = null
let panel = 'map'
let isCode = true
// 提示词内联图片附件：id → 附件对象，编辑器里以 <span class="pe-img" data-att=id> 呈现
const promptAtts = new Map()
// 右栏（功能图 / 画板）宽度占比，可拖动分隔条调整并持久化
let rightRatio = 0.42

export function initSessionView() {
  savePrompt = debounce(persistPrompt, 500)

  const promptEl = $('#sessionPrompt')
  promptEl.addEventListener('input', () => {
    if (taskId) savePrompt(taskId, collectDoc())
  })
  promptEl.addEventListener('paste', onPromptPaste)
  promptEl.addEventListener('click', (e) => {
    const x = e.target.closest && e.target.closest('.pe-x')
    if (x) {
      const chip = x.closest('.pe-img')
      if (chip) {
        promptAtts.delete(chip.getAttribute('data-att'))
        chip.remove()
        promptEl.focus()
        if (taskId) persistPrompt(taskId, collectDoc())
      }
      return
    }
    const img = e.target.closest && e.target.closest('.pe-img img')
    if (img) {
      e.preventDefault()
      const chip = img.closest('.pe-img')
      const att = chip && promptAtts.get(chip.getAttribute('data-att'))
      openImageZoom((att && (att.dataUrl || att.thumb)) || img.src, img.alt)
    }
  })
  const sendBtn = $('#sessionPromptSend')
  if (sendBtn) sendBtn.addEventListener('click', () => sendPrompt().catch((e) => toast('发送失败：' + e.message, 'err')))

  initBoard()
  initFeatureMap()
  initSessionSplit()
  loadRightRatio().catch(() => {})

  const seg = $('#rightSeg')
  if (seg) {
    seg.querySelectorAll('[data-panel]').forEach((b) => {
      b.addEventListener('click', async () => {
        panel = b.getAttribute('data-panel')
        applyPanel()
        if (taskId) { try { await store('settings.set', { key: 'session:righttab:' + taskId, value: panel }) } catch {} }
      })
    })
  }

  on('changes-updated', renderChanges)
  // 切回会话管理时刷新对话记录（发送后回到本页也能看到最新记录）
  on('pane-changed', (name) => { if (name === 'session' && taskId) renderSessionHistory(taskId).catch(() => {}) })
}

const RATIO_MIN = 0.3
const RATIO_MAX = 0.7

function applyRightRatio(r) {
  const main = document.querySelector('.seswrap .sesmain')
  const cvs = document.querySelector('.seswrap .sescvs')
  if (!main || !cvs) return
  const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, Number(r) || rightRatio))
  cvs.style.flex = '0 0 ' + (ratio * 100).toFixed(2) + '%'
  main.style.flex = '1 1 auto'
}

async function loadRightRatio() {
  try {
    const v = await store('settings.get', { key: 'ui:sessionRightRatio', dflt: '' })
    const n = Number(v)
    if (v !== '' && Number.isFinite(n)) rightRatio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, n))
  } catch {}
  applyRightRatio(rightRatio)
}

function initSessionSplit() {
  const divider = $('#sesDivider')
  const wrap = document.querySelector('.seswrap')
  if (!divider || !wrap) return
  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    divider.setPointerCapture(e.pointerId)
    divider.classList.add('dragging')
    const rect = wrap.getBoundingClientRect()
    const move = (ev) => {
      rightRatio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, (rect.right - ev.clientX) / rect.width))
      applyRightRatio(rightRatio)
    }
    const up = async () => {
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', up)
      try { divider.releasePointerCapture(e.pointerId) } catch {}
      divider.classList.remove('dragging')
      try { await store('settings.set', { key: 'ui:sessionRightRatio', value: String(rightRatio) }) } catch {}
    }
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', up)
  })
}

// —— 提示词内联图片（粘贴即插入到光标处，所见即所在位置）——
function onPromptPaste(e) {
  const files = imagesFromPaste(e)
  if (!files.length) return
  e.preventDefault()
  const room = ATTACH_MAX - promptAtts.size
  if (room <= 0) { toast(`最多 ${ATTACH_MAX} 张图片`, 'warn'); return }
  files.slice(0, room).forEach((f) => addPromptAttachment(f))
}
async function addPromptAttachment(file) {
  if (promptAtts.size >= ATTACH_MAX) { toast(`最多 ${ATTACH_MAX} 张图片`, 'warn'); return }
  const att = await buildImageAttachment(file)
  if (!att) return
  promptAtts.set(att.id, att)
  insertPromptImage(att)
}
// 在光标处插入图片节点（contenteditable=false 的 span，带删除按钮）
function insertPromptImage(att) {
  const editor = $('#sessionPrompt')
  if (!editor) return
  const chip = document.createElement('span')
  chip.className = 'pe-img'
  chip.contentEditable = 'false'
  chip.setAttribute('data-att', att.id)
  chip.title = att.name || '图片'
  const img = document.createElement('img')
  img.src = att.thumb || att.dataUrl
  img.alt = att.name || '图片'
  const x = document.createElement('button')
  x.type = 'button'
  x.className = 'pe-x'
  x.textContent = '×'
  x.title = '移除'
  chip.appendChild(img)
  chip.appendChild(x)
  editor.focus()
  const sel = window.getSelection()
  let range = null
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0)
    if (editor.contains(r.startContainer)) range = r
  }
  if (!range) {
    range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
  }
  range.deleteContents()
  range.insertNode(chip)
  const space = document.createTextNode(' ')
  chip.parentNode.insertBefore(space, chip.nextSibling)
  range.setStartAfter(space)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  if (taskId) persistPrompt(taskId, collectDoc())
}
// 读取编辑器：按文档顺序还原文本与图片附件（图片以 [图片] 占位）
function collectPrompt() {
  const editor = $('#sessionPrompt')
  const attachments = []
  let text = ''
  const walk = (node) => {
    if (node.nodeType === 3) { text += node.nodeValue; return }
    if (node.nodeType !== 1) return
    if (node.classList && node.classList.contains('pe-img')) {
      const att = promptAtts.get(node.getAttribute('data-att'))
      if (att) { attachments.push(att); text += '[图片]' }
      return
    }
    if (node.tagName === 'BR') { text += '\n'; return }
    const block = node.tagName === 'DIV' || node.tagName === 'P' || node.tagName === 'LI'
    if (block && text && !text.endsWith('\n')) text += '\n'
    node.childNodes.forEach(walk)
  }
  if (editor) editor.childNodes.forEach(walk)
  return { text: text.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim(), attachments }
}
// 存档用：纯文本（供主进程当系统提示词）+ 编辑器 HTML 与附件（供还原内联图片）
function collectDoc() {
  const { text, attachments } = collectPrompt()
  const editor = $('#sessionPrompt')
  return { text, html: editor ? editor.innerHTML : '', atts: attachments }
}
async function persistPrompt(id, doc) {
  if (!id || !doc) return
  try {
    await store('settings.set', { key: 'session:prompt:' + id, value: doc.text })
    const payload = doc.atts && doc.atts.length ? JSON.stringify({ html: doc.html, atts: doc.atts }) : ''
    await store('settings.set', { key: 'session:promptdoc:' + id, value: payload })
  } catch {}
}
function clearPromptEditor() {
  promptAtts.clear()
  const editor = $('#sessionPrompt')
  if (editor) editor.textContent = ''
}

async function sendPrompt() {
  if (!taskId) return
  const { text, attachments } = collectPrompt()
  if (!text && !attachments.length) return
  const sendBtn = $('#sessionPromptSend')
  if (sendBtn) sendBtn.disabled = true
  clearPromptEditor()
  try {
    const ok = await sendChatMessage({ text, attachments })
    await renderSessionHistory(taskId)
    if (!ok) toast('发送失败', 'err')
  } finally { if (sendBtn) sendBtn.disabled = false }
}

function applyPanel() {
  if (!isCode) panel = 'board'
  const seg = $('#rightSeg')
  if (seg) {
    seg.classList.toggle('hidden', !isCode)
    seg.querySelectorAll('[data-panel]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-panel') === panel))
  }
  const mapHost = $('#featureMapHost')
  const boardHost = $('#boardHost')
  if (mapHost) mapHost.classList.toggle('hidden', panel !== 'map')
  if (boardHost) boardHost.classList.toggle('hidden', panel !== 'board')
  const title = $('#ctTitle')
  if (title) title.classList.toggle('hidden', isCode)
}

export async function renderSession(id) {
  taskId = id
  const promptEl = $('#sessionPrompt')
  const sendBtn = $('#sessionPromptSend')
  if (!id) {
    isCode = false
    clearPromptEditor()
    promptEl.setAttribute('contenteditable', 'false')
    if (sendBtn) sendBtn.disabled = true
    $('#sessionLabel').textContent = '未选择任务'
    renderChanges()
    applyPanel()
    renderSessionHistory(null)
    renderBoard(null)
    renderFeatureMap(null)
    return
  }
  let task = state.tasks.find((t) => t.id === id)
  try { const fresh = await store('tasks.get', { id }); if (fresh) task = fresh } catch {}
  isCode = !!(task && task.type === 'code')
  promptEl.setAttribute('contenteditable', 'true')
  if (sendBtn) sendBtn.disabled = false
  $('#sessionLabel').textContent = (task ? task.name : '') + ' · 当前会话'
  clearPromptEditor()
  // 优先从存档还原（含内联图片），无存档则回退纯文本
  try {
    const doc = await store('settings.get', { key: 'session:promptdoc:' + id, dflt: '' })
    let restored = false
    if (doc) {
      try {
        const parsed = JSON.parse(doc)
        for (const a of parsed.atts || []) { if (a && a.id) promptAtts.set(a.id, a) }
        promptEl.innerHTML = parsed.html || ''
        restored = true
      } catch {}
    }
    if (!restored) promptEl.textContent = await store('settings.get', { key: 'session:prompt:' + id, dflt: '' })
  } catch {}
  if (isCode) {
    try {
      const p = await store('settings.get', { key: 'session:righttab:' + id, dflt: 'map' })
      panel = p === 'board' ? 'board' : 'map'
    } catch { panel = 'map' }
  } else {
    panel = 'board'
  }
  applyPanel()
  renderChanges()
  if (isCode) renderFeatureMap(id)
  else renderFeatureMap(null)
  renderBoard(id)
  renderSessionHistory(id)
}

// 对话记录：按会话分组，仅展示用户发送的内容；点击查看该会话的过程与结果
// 每个会话头部显示累计 token；隐藏会话（跨任务询问）额外展示「谁来问 + 问了啥答了啥」
async function renderSessionHistory(id) {
  const host = $('#sessionHistory')
  if (!host) return
  if (!id) { host.innerHTML = '<div class="hint">选择任务后显示对话记录</div>'; return }
  let sessions = []
  try { sessions = await store('sessions.list', { taskId: id }) } catch {}
  const groups = []
  for (const s of sessions) {
    let msgs = []
    try { msgs = await store('messages.list', { taskId: id, sessionId: s.id }) } catch {}
    const users = msgs.filter((m) => m.role === 'user' && (String(m.content || '').trim() || attachmentsOf(m).length))
    if (!users.length) continue
    let tin = 0, tout = 0, tcached = 0, ttotal = 0
    try {
      const runs = await store('runs.list', { taskId: id, sessionId: s.id })
      for (const r of runs || []) {
        const ri = Number(r.input_tokens) || 0
        const ro = Number(r.output_tokens) || 0
        const rc = Number(r.cached_tokens) || 0
        if (ri || ro || rc) { tin += ri; tout += ro; tcached += rc }
        else ttotal += Number(r.tokens) || 0
      }
    } catch {}
    groups.push({ session: s, users, msgs, tin, tout, tcached, ttotal })
  }
  if (!groups.length) {
    host.innerHTML = '<div class="hint">还没有记录。在提示词中输入并点「发送」，或直接到 AI 对话。</div>'
    return
  }
  // 最近的会话排在最上面
  const tsOf = (s) => Date.parse((s && (s.updated_at || s.created_at)) || '') || 0
  groups.sort((a, b) => tsOf(b.session) - tsOf(a.session))
  host.innerHTML = groups.map((g) => {
    const isAsk = g.session.kind === 'ask'
    const title = isAsk ? '跨任务询问' : (g.session.title || '会话')
    const badge = isAsk ? '<span class="shbadge">隐藏</span>' : ''
    const bits = []
    if (g.tin || g.tout) {
      bits.push('输入 ' + fmtTok(g.tin), '输出 ' + fmtTok(g.tout))
      if (g.tcached) bits.push('缓存 ' + fmtTok(g.tcached))
    }
    const tok = bits.length
      ? `<span class="shtok" title="该会话累计 token">${bits.join(' · ')}</span>`
      : (g.ttotal ? `<span class="shtok" title="该会话累计 token">约 ${fmtTok(g.ttotal)} tokens</span>` : '')
    const rows = isAsk ? askRows(g) : userRows(g)
    return `<div class="shgroup${isAsk ? ' shask' : ''}">
      <div class="shgh">${ic(isAsk ? 'help-circle' : 'message-square', 11)}<span>${esc(title)}</span>${badge}<span class="shcount">${g.users.length}</span>${tok}</div>
      ${rows}</div>`
  }).join('')
  refreshIcons()
  host.querySelectorAll('[data-mid]').forEach((el) => {
    el.addEventListener('click', () => openSessionDetail(id, el.getAttribute('data-session'), el.getAttribute('data-mid')))
  })
}

function userRows(g) {
  // 最近的一问排在最上面
  return [...g.users].reverse().map((m) => {
    const text = String(m.content || '')
    const one = text.replace(/\s+/g, ' ').trim()
    const brief = one.length > 60 ? one.slice(0, 60) + '…' : one
    const imgs = attachmentsOf(m).length
    const imgTag = imgs ? `<span class="shimg" title="含 ${imgs} 张图片">${ic('image', 11)} ${imgs}</span>` : ''
    return `<div class="shrow-u" data-session="${esc(g.session.id)}" data-mid="${esc(m.id)}" title="${esc(text || '（图片）')}">${imgTag}<span class="shtext">${esc(brief || '（图片）')}</span></div>`
  }).join('')
}

// 隐藏会话：把「来自任务X」的问与紧随其后的回答配成一对
function askRows(g) {
  const msgs = g.msgs || []
  const one = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
  const out = []
  // 最近的一问一答排在最上面
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'user') continue
    const raw = String(m.content || '')
    const from = (/来自任务「(.+?)」/.exec(raw) || [])[1] || '其他任务'
    const q = (/(?:^|\n)问题：\s*\n?([\s\S]*)$/.exec(raw) || [])[1] || raw
    let ans = ''
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role === 'user') break
      if (msgs[j].role === 'assistant' && (msgs[j].kind || 'text') === 'text') { ans = String(msgs[j].content || ''); break }
    }
    out.push(`<div class="shqa" data-session="${esc(g.session.id)}" data-mid="${esc(m.id)}" style="cursor:pointer" title="查看该次问答详情">
      <div class="shq"><span class="shfrom" title="调用方任务">${esc(from)}</span><span class="shqtext">${esc(one(q, 160))}</span></div>
      <div class="sha">${esc(one(ans, 240) || '（无回答）')}</div>
    </div>`)
  }
  return out.join('')
}

function metaOf(m) {
  try {
    return typeof m.meta === 'string' ? JSON.parse(m.meta || '{}') : (m.meta || {})
  } catch { return {} }
}

function attachmentsOf(m) {
  const meta = metaOf(m)
  return Array.isArray(meta.attachments) ? meta.attachments : []
}

// 会话详情弹窗：只展示被点开的那一次问答（用户输入 + AI 思考过程与回复），不跳转 AI 对话
async function openSessionDetail(taskId, sessionId, msgId) {
  const host = document.getElementById('modal-host')
  if (!host || !taskId || !sessionId) return
  let msgs = []
  try { msgs = await store('messages.list', { taskId, sessionId }) } catch {}
  // 收窄到被点开的这一轮：从该用户消息起，到下一次用户消息前
  if (msgId) {
    const start = msgs.findIndex((m) => m.id === msgId)
    if (start >= 0) {
      let end = msgs.length
      for (let i = start + 1; i < msgs.length; i++) {
        if (msgs[i].role === 'user') { end = i; break }
      }
      msgs = msgs.slice(start, end)
    }
  }
  let title = '单次问答详情'
  try {
    const s = (await store('sessions.list', { taskId }) || []).find((x) => x.id === sessionId)
    if (s && s.kind === 'ask') title = '跨任务询问 · 单次问答详情'
    else if (s && s.title) title = s.title
  } catch {}

  const mask = document.createElement('div')
  mask.className = 'zz-modal-mask'
  const body = msgs.length
    ? msgs.map(renderDetailMsg).join('')
    : '<div class="hint">该会话暂无消息记录</div>'
  mask.innerHTML = `<div class="zz-modal sd-modal">
    <div class="mt">${esc(title)}</div>
    <div class="sd-body">${body}</div>
    <div class="mbtns"><button class="btn" data-act="close">关闭</button></div>
  </div>`

  const close = () => {
    document.removeEventListener('keydown', onKey, true)
    mask.remove()
  }
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close() })
  mask.querySelector('[data-act="close"]').addEventListener('click', close)
  document.addEventListener('keydown', onKey, true)
  host.appendChild(mask)

  mask.querySelectorAll('.sd-body .md').forEach((el) => enhanceMarkdown(el, {}))
  mask.querySelectorAll('.sd-img').forEach((img) => {
    img.addEventListener('click', () => openImageZoom(img.src, img.alt))
  })
  refreshIcons()
  const sc = mask.querySelector('.sd-body')
  if (sc) sc.scrollTop = 0
}

// 单条消息：用户=文本+图片；AI=可折叠思考/过程 + 正文
function renderDetailMsg(m) {
  const meta = metaOf(m)
  if (m.role === 'user') {
    const atts = Array.isArray(meta.attachments) ? meta.attachments : []
    const imgs = atts
      .filter((a) => a && (a.thumb || a.dataUrl))
      .map((a) => `<img class="sd-img" src="${esc(a.thumb || a.dataUrl)}" alt="${esc(a.name || '图片')}" title="点击放大">`)
      .join('')
    const textHtml = m.content ? `<div class="bub">${esc(m.content)}</div>` : ''
    return `<div class="sd-msg u">
      <div class="sd-role">${ic('user', 12)} 你</div>
      ${textHtml}${imgs ? `<div class="ubatt">${imgs}</div>` : ''}
    </div>`
  }
  const parts = Array.isArray(m.parts) ? m.parts : (Array.isArray(meta.parts) ? meta.parts : [])
  const think = m.thinking || meta.thinking || ''
  const tools = parts.filter((p) => p && p.t === 'tool')
  const text = m.content || parts.filter((p) => p && p.t === 'text').map((p) => p.text || '').join('')
  const thinkHtml = think
    ? `<details class="sd-fold"><summary>${ic('brain', 12)} 思考过程</summary><div class="sd-thinktext">${esc(think)}</div></details>`
    : ''
  const toolsHtml = tools.length
    ? `<details class="sd-fold"><summary>${ic('wrench', 12)} 执行过程（${tools.length}）</summary><div class="sd-thinktext">${tools.map((t) => `<div class="sd-tool">${esc(t.name || '工具')}${t.detail ? ' · ' + esc(t.detail) : ''}</div>`).join('')}</div></details>`
    : ''
  const replyHtml = text ? `<div class="abody md">${renderMarkdown(text)}</div>` : ''
  return `<div class="sd-msg a">
    <div class="sd-role">${ic('bot', 12)} AI${meta.modelName ? ' · ' + esc(meta.modelName) : ''}</div>
    ${thinkHtml}${toolsHtml}
    ${replyHtml || '<div class="sd-note">（无正文）</div>'}
  </div>`
}

function renderChanges() {
  const host = $('#sessionChanges')
  if (!host) return
  if (!state.changes.length) {
    host.innerHTML = `<div class="hint">在编辑器中修改文件后会出现在这里，随消息一起发送。</div>`
    return
  }
  host.innerHTML = state.changes.map((c) => `<div class="chg">
    ${ic('file-code', 12)}<span class="nm2">${esc(c.name || basename(c.path))}</span>
    <span class="st2">已修改</span><span class="tage">本次</span></div>`).join('')
  refreshIcons()
}
