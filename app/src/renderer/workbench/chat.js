// AI 对话 pane：多会话切换、执行体/模型选择、变更卡片、子代理与编排
import { chat as chatApi, store, onChatEvent, fsapi, invoke } from '../lib/api.js'
import { $, esc, ic, refreshIcons, joinPath, fmtTok } from '../lib/ui.js'
import { renderMarkdown, highlightIn, enhanceMarkdown, bindMarkdownClicks, openImageZoom } from '../components/markdown.js'
import { toast } from '../components/toast.js'
import { showContextMenu } from '../components/contextMenu.js'
import { openDiffTab } from './editor.js'
import { showPane } from './tabs.js'
import { emit, on } from '../lib/state.js'

let taskId = null
let sessionId = null
let info = null
let messages = []
let running = false
let runId = null
let orchestrateActive = false
let allowDelta = true
let frame = 0
let mention = { open: false, items: [], idx: 0, start: 0, end: 0, dir: '', currentKey: '' }

// 待发送的图片附件：dataUrl 全分辨率，thumb 为 ~320px 缩略图（气泡/发送用）
let pendingAttachments = []
// 当前会话的后台 shell（Claude run_in_background 启动的常驻命令）
let shells = []
// 每个任务各自保留未发送的输入草稿，切换任务时互不串台
const drafts = new Map()
// 运行中排队待发送的消息：按会话隔离，AI 一轮结束后自动逐条发出
const queues = new Map()
const ATT_MAX = 30
const ATT_MAX_BYTES = 8 * 1024 * 1024
const ATT_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
// 聊天内联 diff 只展示前这么多字符，完整内容可在编辑区标签页打开
const DIFF_INLINE_LIMIT = 2400

const STATUS_TEXT = { pending: '等待中', running: '运行中', done: '已完成', stopped: '已停止', error: '失败', draft: '草稿' }
const MENTION_SKIP = new Set(['node_modules', 'out', 'release', 'dist', 'build', '.zzwork', '.next',
  'target', '.venv', 'venv', '__pycache__', '.idea', '.vs', '.cache', 'coverage'])

function parseMeta(m) {
  if (!m) return {}
  if (typeof m === 'object') return m
  try { return JSON.parse(m) } catch { return {} }
}

function copyToClipboard(text) {
  const t = String(text || '')
  if (!t) return
  try {
    navigator.clipboard.writeText(t).then(() => toast('已复制')).catch(() => { invoke('terminal', 'copy', { text: t }); toast('已复制') })
  } catch {
    invoke('terminal', 'copy', { text: t })
    toast('已复制')
  }
}

// 把图片写进系统剪贴板：优先按 data-path 读原图，回退到元素上的 data: URL
async function copyImageToClipboard(img) {
  if (!img) return
  let dataUrl = ''
  const path = img.getAttribute('data-path')
  const src = img.getAttribute('src') || ''
  if (path) {
    try {
      const d = await fsapi('readBase64', { path })
      dataUrl = (d && d.dataUrl) || ''
    } catch {}
  }
  if (!dataUrl && /^data:image\//.test(src)) dataUrl = src
  if (!dataUrl) { toast('无法读取图片', 'err'); return }
  try {
    const ok = await invoke('app', 'copyImage', { dataUrl })
    if (ok) toast('已复制图片')
    else toast('复制失败', 'err')
  } catch (e) {
    toast('复制失败：' + e.message, 'err')
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result || ''))
    fr.onerror = () => reject(fr.error || new Error('读取失败'))
    fr.readAsDataURL(file)
  })
}
// 缩略图：等比缩到不超过 max 边长，JPEG 压缩；失败回退原图
function makeThumb(dataUrl, max) {
  return new Promise((resolve) => {
    try {
      const img = new Image()
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height || 1))
          const w = Math.max(1, Math.round(img.width * scale))
          const h = Math.max(1, Math.round((img.height || img.width) * scale))
          const c = document.createElement('canvas')
          c.width = w; c.height = h
          c.getContext('2d').drawImage(img, 0, 0, w, h)
          resolve(c.toDataURL('image/jpeg', 0.82))
        } catch { resolve(dataUrl) }
      }
      img.onerror = () => resolve(dataUrl)
      img.src = dataUrl
    } catch { resolve(dataUrl) }
  })
}
// 把粘贴/拖入的文件构建为附件对象（校验类型与大小）；失败返回 null
export async function buildImageAttachment(file) {
  if (!ATT_MIMES.has(file.type)) { toast('仅支持 png/jpeg/webp/gif', 'warn'); return null }
  if (file.size > ATT_MAX_BYTES) { toast('单张图片不能超过 8MB', 'warn'); return null }
  let dataUrl = ''
  try { dataUrl = await readAsDataUrl(file) } catch { toast('读取图片失败', 'err'); return null }
  const thumb = await makeThumb(dataUrl, 320)
  return {
    id: 'att-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    name: file.name || '粘贴图片', mime: file.type, dataUrl, thumb: thumb || dataUrl, size: file.size
  }
}
// 从剪贴板事件里取出图片文件（兼容仅 files、没有 items 的来源）
export function imagesFromPaste(e) {
  const cd = e.clipboardData
  const fromItems = [...((cd && cd.items) || [])]
    .filter((it) => it.kind === 'file' && /^image\//.test(it.type))
    .map((it) => it.getAsFile()).filter(Boolean)
  const fromFiles = [...((cd && cd.files) || [])].filter((f) => /^image\//.test(f.type))
  return fromItems.length ? fromItems : fromFiles
}
async function addAttachment(file) {
  if (pendingAttachments.length >= ATT_MAX) { toast(`最多 ${ATT_MAX} 张图片`, 'warn'); return }
  const att = await buildImageAttachment(file)
  if (!att) return
  pendingAttachments.push(att)
  renderAttachments()
}
function onPaste(e) {
  const files = imagesFromPaste(e)
  if (!files.length) return
  e.preventDefault()
  const room = ATT_MAX - pendingAttachments.length
  if (room <= 0) { toast(`最多 ${ATT_MAX} 张图片`, 'warn'); return }
  files.slice(0, room).forEach((f) => addAttachment(f))
}
export const ATTACH_MAX = ATT_MAX
function renderAttachments() {
  const el = $('#chatAttach')
  if (!el) return
  el.classList.toggle('on', pendingAttachments.length > 0)
  el.innerHTML = pendingAttachments.map((a) =>
    `<div class="attchip" title="${esc(a.name)}"><img src="${esc(a.thumb || a.dataUrl)}" alt="">
       <button class="attx" data-rm="${esc(a.id)}" title="移除">×</button></div>`).join('')
}
function clearAttachments() {
  if (!pendingAttachments.length) return
  pendingAttachments = []
  renderAttachments()
}

// —— 运行中消息队列 ——
function queueKey() { return sessionId || ('task:' + taskId) || '' }
function currentQueue() {
  const k = queueKey()
  if (!k) return []
  if (!queues.has(k)) queues.set(k, [])
  return queues.get(k)
}
// 首轮运行时 sessionId 尚未确定，队列暂存在 task 键下；拿到 sessionId 后迁移过去，避免漏发
function adoptTaskQueue() {
  if (!taskId || !sessionId) return
  const from = 'task:' + taskId
  const orphan = queues.get(from)
  if (!orphan) return
  if (orphan.length) currentQueue().unshift(...orphan)
  queues.delete(from)
}
function renderQueue() {
  const el = $('#chatQueue')
  if (!el) return
  const q = currentQueue()
  el.classList.toggle('on', q.length > 0)
  if (!q.length) { el.innerHTML = ''; return }
  el.innerHTML = q.map((it, i) => {
    const imgs = it.atts && it.atts.length
    const label = it.text ? esc(it.text.replace(/\s+/g, ' ').slice(0, 200)) : '（图片）'
    return `<div class="qrow">
      <span class="qhb">${i + 1}</span>
      <span class="qt" title="${esc(it.text || '')}">${label}</span>
      ${imgs ? `<span class="qimg">${ic('image', 12)} ${it.atts.length}</span>` : ''}
      <button class="qx" data-qrm="${esc(it.id)}" title="取消此条">×</button>
    </div>`
  }).join('')
  refreshIcons()
}
function enqueue(text, atts) {
  const q = currentQueue()
  q.push({ id: 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), text: text || '', atts: atts || [] })
  renderQueue()
}
function removeQueueItem(id) {
  const q = currentQueue()
  const i = q.findIndex((x) => x.id === id)
  if (i >= 0) q.splice(i, 1)
  renderQueue()
}
// AI 一轮正常结束后，把队列头当作独立一轮发出
function drainIfQueued() {
  const q = currentQueue()
  if (!q.length || !taskId) return
  const it = q.shift()
  renderQueue()
  dispatchSend(it.text, it.atts)
}
// 停止时把尚未发出的队列内容回写到输入框，供用户重新编辑
function flushQueueToInput() {
  const q = currentQueue()
  if (!q.length) return
  const el = $('#chatInput')
  if (el) {
    const texts = q.map((x) => x.text).filter(Boolean)
    const joined = (el.value ? el.value + '\n' : '') + texts.join('\n')
    el.value = joined
    autosize()
  }
  const atts = q.flatMap((x) => (x.atts || []).map((a) => ({ ...a, id: a.id || ('att-' + Math.random().toString(36).slice(2)) })))
  if (atts.length) {
    const room = ATT_MAX - pendingAttachments.length
    if (room > 0) { pendingAttachments = pendingAttachments.concat(atts.slice(0, room)); renderAttachments() }
  }
  q.length = 0
  renderQueue()
}

function upsertShell(sh) {
  if (!sh || !sh.id) return
  const i = shells.findIndex((s) => s.id === sh.id)
  // 停止/结束的后台 shell 不再展示
  if (sh.removed || (sh.status && sh.status !== 'running')) {
    if (i >= 0) shells.splice(i, 1)
    return
  }
  if (i >= 0) shells[i] = { ...shells[i], ...sh }
  else shells.push(sh)
}
function shellRow(s) {
  const running = s.status === 'running'
  const cmd = s.command || s.shellId || '后台命令'
  const dur = s.at ? fmtDur(Date.now() - s.at) : ''
  const det = [s.cwd ? '目录：' + s.cwd : '', s.shellId ? 'ID：' + s.shellId : '', s.output ? '输出：\n' + s.output : '']
    .filter(Boolean).join('\n')
  const stateTxt = running ? '' : (s.status === 'stopped' ? '已停止' : s.status === 'error' ? '失败' : '已结束')
  return `<div class="shellitem">
    <div class="shrow ${running ? 'run' : esc(s.status || '')}">
      ${running ? '<span class="tspin"></span>' : '<span class="shdot"></span>'}
      <span class="shcmd" title="${esc(cmd)}">${esc(cmd)}</span>
      ${dur ? `<span class="shdur" data-at="${Number(s.at) || 0}">${esc(dur)}</span>` : ''}
      ${stateTxt ? `<span class="shstate">${esc(stateTxt)}</span>` : ''}
      ${running ? `<button class="shstop" data-shell-stop="${esc(s.id)}">停止</button>` : ''}
    </div>
    ${det ? `<details class="shview"><summary>查看</summary><pre>${esc(det)}</pre></details>` : ''}
  </div>`
}
function renderShells() {
  const el = $('#chatShells')
  if (!el) return
  el.classList.toggle('on', shells.length > 0)
  if (!shells.length) { el.innerHTML = ''; return }
  const live = shells.filter((s) => s.status === 'running').length
  const rows = shells.slice(-8).reverse().map(shellRow).join('')
  el.innerHTML = `<div class="shhead">${ic('terminal', 13)}<span class="sht">后台 Shell</span>
    <span class="shn">${live} 运行中${shells.length > live ? ' · 共 ' + shells.length + ' 条' : ''}</span></div>
    <div class="shlist">${rows}</div>`
  refreshIcons()
}

export function initChatView() {
  $('#chatSend').addEventListener('click', send)
  $('#chatStop').addEventListener('click', stop)
  const input = $('#chatInput')
  input.addEventListener('keydown', (e) => {
    if (mentionKey(e)) return
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  })
  input.addEventListener('input', () => { autosize(); updateMention() })
  input.addEventListener('paste', onPaste)
  const att = $('#chatAttach')
  if (att) att.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-rm]')
    if (!btn) return
    pendingAttachments = pendingAttachments.filter((a) => a.id !== btn.getAttribute('data-rm'))
    renderAttachments()
  })
  const qEl = $('#chatQueue')
  if (qEl) qEl.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-qrm]')
    if (!btn) return
    removeQueueItem(btn.getAttribute('data-qrm'))
  })
  const shEl = $('#chatShells')
  if (shEl) shEl.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('[data-shell-stop]')
    if (!btn) return
    const id = btn.getAttribute('data-shell-stop')
    btn.disabled = true
    try {
      await invoke('chat', 'shellStop', { taskId, sessionId, id })
      shells = shells.filter((s) => s.id !== id)
      renderShells()
      toast('已停止后台 shell')
    } catch (er) {
      btn.disabled = false
      toast('停止失败：' + er.message, 'err')
    }
  })
  // 运行中 shell 的耗时常驻刷新
  setInterval(() => {
    document.querySelectorAll('#chatShells .shdur[data-at]').forEach((n) => {
      const at = Number(n.getAttribute('data-at')) || 0
      if (at) n.textContent = fmtDur(Date.now() - at)
    })
  }, 1000)
  $('#chatInner').addEventListener('contextmenu', (e) => {
    const sel = String(window.getSelection() || '')
    const msg = e.target.closest && e.target.closest('.msg')
    const img = e.target.closest && e.target.closest('img.uimg, img.mdimg')
    const items = []
    if (img) items.push({ label: '复制图片', icon: 'copy', action: () => copyImageToClipboard(img) })
    if (sel.trim()) items.push({ label: '复制所选', icon: 'copy', action: () => copyToClipboard(sel) })
    if (msg) items.push({ label: '复制本条', icon: 'clipboard-copy', action: () => copyToClipboard(msg.innerText) })
    if (!items.length) return
    e.preventDefault()
    e.stopPropagation()
    showContextMenu(e.clientX, e.clientY, items)
  })
  document.addEventListener('mousedown', (e) => {
    if (!mention.open) return
    if (e.target.closest && (e.target.closest('#chatMention') || e.target.closest('#chatInput'))) return
    hideMention()
  })

  $('#newSessionBtn').addEventListener('click', newSession)
  $('#aiSessionList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-session]')
    if (!btn || !taskId) return
    const sid = btn.getAttribute('data-session')
    if (sid && sid !== sessionId) renderChat(taskId, sid)
  })

  $('#chatInner').addEventListener('click', (e) => {
    const ob = e.target.closest('[data-open-diff]')
    if (ob) {
      e.preventDefault()
      e.stopPropagation()
      const box = ob.closest('.diffbox')
      const mid = box && box.getAttribute('data-mid')
      const m = messages.find((x) => x.id === mid)
      const files = (m && m.meta && Array.isArray(m.meta.files)) ? m.meta.files : []
      const v = ob.getAttribute('data-open-diff')
      if (v === 'all') openDiffTab(files, '本次修改')
      else { const f = files[Number(v)]; if (f) openDiffTab([f], f.path || 'diff') }
      return
    }
    const uimg = e.target.closest && e.target.closest('img.uimg')
    if (uimg) {
      e.preventDefault()
      const path = uimg.getAttribute('data-path')
      const fallback = uimg.getAttribute('src') || ''
      if (path) {
        fsapi('readBase64', { path }).then((d) => openImageZoom((d && d.dataUrl) || fallback, uimg.alt))
          .catch(() => openImageZoom(fallback, uimg.alt))
      } else openImageZoom(fallback, uimg.alt)
      return
    }
    const sess = e.target.closest('[data-open-session]')
    if (sess) {
      const sid = sess.getAttribute('data-open-session')
      if (taskId && sid) renderChat(taskId, sid)
      return
    }
    const opt = e.target.closest('[data-qopt]')
    if (opt) { handleAskOption(opt); return }
    const sub = e.target.closest('[data-ask-submit]')
    if (sub) { submitAsk(sub); return }
  })
  bindMarkdownClicks($('#chatInner'))

  // 切到 AI 对话时滚到最新一条（首次打开任务时 pane 尚未可见，renderChat 里滚动无效）
  on('pane-changed', (name) => {
    if (name === 'ai' && taskId) requestAnimationFrame(() => scrollBottom(true))
  })

  onChatEvent(handleEvent)
}

function handleAskOption(opt) {
  const aq = opt.closest('.aq')
  if (!aq) return
  if (aq.getAttribute('data-multi') === '1') opt.classList.toggle('on')
  else aq.querySelectorAll('[data-qopt]').forEach((b) => b.classList.toggle('on', b === opt))
}

async function submitAsk(btn) {
  const card = btn.closest('.askcard')
  if (!card) return
  const requestId = card.getAttribute('data-ask')
  const run = card.getAttribute('data-run') || runId
  const answers = {}
  card.querySelectorAll('.aq').forEach((aq) => {
    const qtext = aq.getAttribute('data-qtext') || ''
    const other = aq.querySelector('.qother')
    const text = other ? other.value.trim() : ''
    const labels = [...aq.querySelectorAll('[data-qopt].on')].map((b) => b.getAttribute('data-o'))
    if (text) answers[qtext] = text
    else if (labels.length) answers[qtext] = labels.join(', ')
    else answers[qtext] = ''
  })
  btn.disabled = true
  try {
    const ok = await invoke('chat', 'answer', { runId: run, requestId, answers })
    if (!ok) { toast('该提问已失效', 'warn'); btn.disabled = false; return }
    const m = messages.find((x) => x.kind === 'ask' && (x.meta || {}).requestId === requestId)
    if (m) m.answered = answers
    renderAll()
    scrollBottom(false)
  } catch (e) { btn.disabled = false; toast('提交失败：' + e.message, 'err') }
}

function autosize() {
  const el = $('#chatInput')
  el.style.height = 'auto'
  el.style.height = Math.min(180, el.scrollHeight) + 'px'
}

// 保存/恢复按任务隔离的输入草稿：切换任务时各自保留自己的未发送内容
function saveDraft() {
  const el = $('#chatInput')
  if (!el || !taskId) return
  const v = el.value
  if (v) drafts.set(taskId, v)
  else drafts.delete(taskId)
}
function restoreDraft(id) {
  const el = $('#chatInput')
  if (!el) return
  el.value = (id && drafts.get(id)) || ''
  autosize()
}

function resetHeader() {
  info = null
  messages = []
  running = false
  runId = null
  orchestrateActive = false
  allowDelta = true
  hideMention()
  clearAttachments()
  shells = []
  renderShells()
}

export async function renderChat(id, sid) {
  if (id && id === taskId && running && !sid) return
  const switched = id !== taskId
  if (switched) {
    saveDraft() // 先存下当前任务的草稿
    resetHeader()
  }
  if (sid && sid !== sessionId) clearAttachments()
  taskId = id
  if (!id) {
    resetHeader()
    sessionId = null
    $('#chatInner').innerHTML = `<div class="empty">选择一个任务后在此与 AI 对话。</div>`
    const list = $('#aiSessionList')
    if (list) list.innerHTML = ''
    const ci = $('#chatInput')
    if (ci) { ci.value = ''; autosize() }
    $('#chatInput').disabled = true
    $('#chatSend').disabled = true
    renderQueue()
    return
  }
  $('#chatInput').disabled = false
  $('#chatSend').disabled = false
  if (switched) restoreDraft(id) // 恢复目标任务自己的草稿（不显示其他任务的内容）
  try {
    const next = await chatApi('init', { taskId: id, sessionId: sid || sessionId || '' })
    info = next
    if (!next || !next.task) {
      $('#chatInner').innerHTML = `<div class="empty">任务不存在。</div>`
      return
    }
    sessionId = next.session ? next.session.id : null
    adoptTaskQueue()
    messages = (next.messages || []).map((m) => ({ ...m, meta: parseMeta(m.meta) }))
    // 本轮仍在跑：主进程给出快照（步骤/计划/待回答提问只在本轮内存里），重建进行中的气泡
    const live = next.live
    if (live && live.runId) {
      running = true
      runId = live.runId
      const parts = (Array.isArray(live.parts) ? live.parts : []).map((p) =>
        (p.t === 'think' || p.t === 'tool') ? { ...p, at: p.at || p.t0 } : p)
      const asks = Array.isArray(live.asks) ? live.asks : []
      messages.push({
        role: 'assistant', kind: 'text', content: '', thinking: live.thinking || '', steps: [],
        parts, plan: Array.isArray(live.plan) ? live.plan : [],
        stream: !asks.length, pending: !asks.length && !parts.length,
        startedAt: live.startedAt || Date.now(), meta: {}
      })
      for (const a of asks) {
        messages.push({
          role: 'assistant', kind: 'ask', content: '',
          meta: { requestId: a.requestId, input: a.input || {}, runId: live.runId }
        })
      }
    } else {
      running = false
      runId = null
    }
    shells = Array.isArray(next.shells) ? next.shells.slice() : []
    if (next.agentNotice) toast(next.agentNotice, 'warn', 6000)
    refreshChatHeader()
    renderShells()
    renderQueue()
    renderAll()
    scrollBottom(true)
    // 回到本任务时若还有未发出的排队消息（中途切走导致没能接力），在此恢复发送
    if (!running) requestAnimationFrame(() => { if (!running) drainIfQueued() })
  } catch (e) {
    $('#chatInner').innerHTML = `<div class="err">初始化会话失败：${esc(e.message)}</div>`
  }
}

export function refreshChatHeader() {
  if (!info || !info.task) return
  const list = $('#aiSessionList')
  if (list) {
    list.innerHTML = (info.sessions || []).map((s) => {
      const label = (s.kind === 'subagent' ? '子 · ' : '') + (s.title || '会话')
      return `<button class="chsess-item${s.id === sessionId ? ' on' : ''}" data-session="${esc(s.id)}" title="${esc(label)}">${esc(label)}</button>`
    }).join('')
  }
  updateButtons()
}

function updateButtons() {
  // 发送按钮常驻（运行中点击即入队）；运行中额外显示停止
  $('#chatSend').style.display = ''
  $('#chatStop').style.display = running ? 'inline-block' : 'none'
}

function taskRoot() {
  return (info && info.task && info.task.path) || ''
}

function fmtDur(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n < 1000) return Math.max(1, Math.round(n)) + ' 毫秒'
  const s = n / 1000
  if (s < 60) return (s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s))) + ' 秒'
  const m = Math.floor(s / 60)
  return m + ' 分 ' + Math.round(s % 60) + ' 秒'
}

// 一轮输出的有序片段：思考 / 工具 / 正文，按事件到达顺序交错展示
function partsOf(m) {
  const src = m.parts || (m.meta && m.meta.parts)
  if (Array.isArray(src) && src.length) return src
  const out = []
  const think = m.thinking || (m.meta && m.meta.thinking) || ''
  const steps = m.steps || (m.meta && m.meta.steps) || []
  if (think) out.push({ t: 'think', text: think })
  for (const s of steps) out.push({ t: 'tool', id: s.id, name: s.name, detail: s.detail, status: s.status, ms: s.ms })
  if (m.content) out.push({ t: 'text', text: m.content })
  return out
}

const TOOL_CATS = {
  run: { icon: 'terminal', name: '命令' },
  explore: { icon: 'search', name: '查阅' },
  change: { icon: 'file-pen-line', name: '修改' },
  agent: { icon: 'bot', name: '子代理' },
  todo: { icon: 'list-checks', name: '计划' },
  other: { icon: 'wrench', name: '工具' }
}
const GROUP_LABEL = { run: '已执行', explore: '已查阅', change: '已修改', agent: '子代理', todo: '计划', other: '工具' }
const GROUP_UNIT = { run: ' 条命令', explore: ' 项', change: ' 个文件', agent: ' 个', todo: ' 项', other: ' 项' }

function toolCategory(s) {
  const n = String((s && s.name) || '')
  if (/bash|shell|terminal|command|execute|run|命令|执行|终端/i.test(n)) return 'run'
  if (/read|glob|grep|^ls$|list|search|fetch|web|查阅|搜索|查看|读取|列出|打开/i.test(n)) return 'explore'
  if (/task|agent|子代理|子会话/i.test(n)) return 'agent'
  if (/todo|plan|计划/i.test(n)) return 'todo'
  if (/edit|write|patch|apply|文件变更|notebook|修改|写入|更新/i.test(n)) return 'change'
  return 'other'
}

function groupSummary(group) {
  const counts = {}
  for (const s of group) { const c = toolCategory(s); counts[c] = (counts[c] || 0) + 1 }
  const bits = []
  for (const c of ['run', 'explore', 'change', 'agent', 'todo', 'other']) {
    if (!counts[c]) continue
    bits.push(GROUP_LABEL[c] + ' ' + counts[c] + GROUP_UNIT[c])
  }
  return bits.join('，') || '运行过程'
}

// —— 待办计划（TodoWrite / todo_list）——
function planRowHtml(it) {
  const st = it.status || 'pending'
  const icon = st === 'completed'
    ? `<span class="plic ok">${ic('circle-check', 13)}</span>`
    : st === 'in_progress'
      ? '<span class="plic run"><span class="tspin"></span></span>'
      : `<span class="plic">${ic('circle', 12)}</span>`
  return `<li class="plitem ${esc(st)}">${icon}<span class="pltext">${esc(it.text || '')}</span></li>`
}

function planHtml(plan) {
  const items = Array.isArray(plan) ? plan.filter((x) => x && x.text) : []
  if (!items.length) return ''
  const done = items.filter((x) => x.status === 'completed').length
  let body = ''
  if (items.length > 6) {
    // 参照 zcode：折叠时只保留进行中附近的 3 项，前后各折成一行
    let focus = items.findIndex((x) => x.status === 'in_progress')
    if (focus < 0) focus = items.findIndex((x) => x.status !== 'completed')
    if (focus < 0) focus = Math.max(0, items.length - 3)
    const start = Math.max(0, Math.min(focus, items.length - 3))
    const pre = items.slice(0, start)
    const mid = items.slice(start, start + 3)
    const post = items.slice(start + 3)
    body = (pre.length ? `<li class="plfold">前面 ${pre.length} 项</li>` : '')
      + mid.map(planRowHtml).join('')
      + (post.length ? `<li class="plfold">后面 ${post.length} 项</li>` : '')
  } else {
    body = items.map(planRowHtml).join('')
  }
  return `<div class="planlist">
    <div class="plhead">${ic('list-checks', 13)}<span class="plt">待办</span><span class="pln${done === items.length ? ' done' : ''}">${done}/${items.length}</span></div>
    <ul>${body}</ul></div>`
}

// —— 思考 + 执行合并为一个可折叠工作框 ——
function stepRow(s) {
  const cat = toolCategory(s)
  const status = s.status || 'running'
  const dur = s.ms != null ? fmtDur(s.ms) : ''
  return `<div class="strow ${esc(status)}"><span class="stic">${ic(TOOL_CATS[cat].icon, 13)}</span>
    <span class="stnm">${esc(s.name || TOOL_CATS[cat].name)}</span>
    ${s.detail ? `<span class="stdet">${esc(s.detail)}</span>` : '<span class="stdet"></span>'}
    <span class="stst"></span>${dur ? `<span class="stdur">${esc(dur)}</span>` : ''}</div>`
}

function thinkRow(p, live) {
  const ms = p.ms != null ? p.ms : (live && p.at ? Date.now() - p.at : null)
  return `<div class="wbthink"><div class="wbh"><span class="tk">思考</span>${ms != null ? `<span class="tdur">· ${esc(fmtDur(ms))}</span>` : ''}</div>
    <div class="thinktext">${esc(p.text || '')}</div></div>`
}

function workboxHtml(group, live) {
  const running = live && group.some((p) => (p.t === 'think' && p.ms == null) || (p.t === 'tool' && (p.status || 'running') === 'running'))
  const thinkMs = group.reduce((n, p) => n + (p.t === 'think' ? (p.ms != null ? p.ms : (live && p.at ? Date.now() - p.at : 0)) : 0), 0)
  const tools = group.filter((p) => p.t === 'tool')
  const counts = tools.length ? groupSummary(tools) : ''
  const total = group.reduce((n, p) => n + (Number(p.ms) || 0), 0)
  const stats = [thinkMs ? '思考 ' + fmtDur(thinkMs) : '', counts].filter(Boolean).join('，') || '运行过程'
  // 运行中：头部只显示当前动作（参照 zcode），不使用统计文案
  let head = stats
  if (running) {
    const last = group[group.length - 1]
    const t = [...group].reverse().find((p) => p.t === 'tool' && (p.status || 'running') === 'running')
    head = last && last.t === 'think' ? '正在思考…' : t ? '正在执行 ' + (t.detail || t.name || '') : '正在处理…'
  }
  const icon = running ? '<span class="tspin"></span>' : `<span class="wbic">${ic('check-check', 13)}</span>`
  const rows = group.map((p) => (p.t === 'think' ? thinkRow(p, live) : p.t === 'tool' ? stepRow(p) : '')).join('')
  return `<details class="workbox"${running ? ' data-running="1"' : ''}><summary>${icon}
    <span class="gbsum${running ? ' run' : ''}" title="${esc(head)}">${esc(head)}</span>
    ${total && !running ? `<span class="tdur">· ${esc(fmtDur(total))}</span>` : ''}
    <span class="wbchev">${ic('chevron-right', 12)}</span></summary>
    <div class="wbtl">${rows}</div></details>`
}

function renderParts(parts, streaming, plan) {
  const out = []
  let i = 0
  while (i < parts.length) {
    const p = parts[i]
    if (p.t === 'think' || p.t === 'tool') {
      const group = []
      while (i < parts.length && (parts[i].t === 'think' || parts[i].t === 'tool')) { group.push(parts[i]); i++ }
      out.push(workboxHtml(group, streaming && i === parts.length))
    } else if (p.t === 'text') {
      const buf = []
      while (i < parts.length && parts[i].t === 'text') { buf.push(parts[i].text || ''); i++ }
      const cursor = streaming && i === parts.length ? '<span class="cursor"></span>' : ''
      out.push(`<div class="abody md">${renderMarkdown(buf.join(''))}${cursor}</div>`)
    } else i++
  }
  // 待办与运行状态始终钉在正文最下方（参照 Claude Code 底部 shell 指示）
  const planBlock = planHtml(plan)
  if (planBlock) out.push(planBlock)
  const statusBlock = streaming ? runStatusHtml(parts) : ''
  if (statusBlock) out.push(statusBlock)
  return out.join('')
}

// 底部常驻：后台仍运行的命令数（相当于 Claude Code 的“x shell”）
function runStatusHtml(parts) {
  const running = (parts || []).filter((p) => p.t === 'tool' && (p.status || 'running') === 'running')
  if (!running.length) return ''
  const last = running[running.length - 1]
  const detail = last.detail || last.name || ''
  const label = running.length > 1
    ? `${running.length} 个命令运行中`
    : (detail ? '正在运行 ' + detail : '正在运行命令')
  return `<div class="runstatus"><span class="tspin"></span><span class="rst" title="${esc(label)}">${esc(label)}</span></div>`
}

function tokenBits(meta) {
  const i = Number(meta.inputTokens) || 0
  const o = Number(meta.outputTokens) || 0
  const c = Number(meta.cachedTokens) || 0
  if (i || o || c) {
    const parts = ['输入 ' + fmtTok(i), '输出 ' + fmtTok(o)]
    if (c) parts.push('缓存 ' + fmtTok(c))
    return parts.join(' · ')
  }
  if (meta.tokens) return '约 ' + fmtTok(meta.tokens) + ' tokens'
  return ''
}

function footHtml(m, streaming) {
  const meta = m.meta || {}
  const bits = []
  if (streaming) {
    if (m.startedAt) bits.push('工作中 · ' + fmtDur(Date.now() - m.startedAt))
  } else if (meta.durationMs) bits.push('工作耗时 ' + fmtDur(meta.durationMs))
  const tok = tokenBits(meta)
  if (tok) bits.push(tok)
  const agent = meta.agentName || (info && info.agentName) || ''
  const model = meta.modelName || ''
  if (agent) bits.push(model && model !== agent ? agent + ' · ' + model : agent)
  return bits.map(esc).join(' · ')
}

function askCardHtml(m) {
  const meta = m.meta || {}
  const qs = (meta.input && Array.isArray(meta.input.questions)) ? meta.input.questions : []
  const answered = m.answered || null
  const body = qs.map((q, qi) => {
    const opts = Array.isArray(q.options) ? q.options : []
    const multi = !!q.multiSelect
    const ans = answered ? answered[q.question] : undefined
    const ansArr = Array.isArray(ans) ? ans : (typeof ans === 'string' ? ans.split(/\s*,\s*/) : [])
    const optHtml = opts.map((o) => {
      const label = String(o.label || '')
      const desc = String(o.description || '')
      const on = answered && ansArr.includes(label)
      return `<button class="qopt${on ? ' on' : ''}" data-qopt data-o="${esc(label)}"${answered ? ' disabled' : ''}>
        <span class="olabel">${esc(label)}</span>${desc ? `<span class="odesc">${esc(desc)}</span>` : ''}</button>`
    }).join('')
    return `<div class="aq" data-qi="${qi}" data-qtext="${esc(q.question || '')}" data-multi="${multi ? '1' : ''}">
      <div class="qq">${esc(q.question || '')}${multi ? '<span class="qmulti">可多选</span>' : ''}</div>
      <div class="qopts">${optHtml}</div>
      ${answered ? '' : '<input class="qother" type="text" placeholder="其他（可输入自定义回答）">'}
    </div>`
  }).join('')
  const foot = answered
    ? `<span class="fdone">${ic('check', 12)} 已回答</span>`
    : '<button class="btn sm primary" data-ask-submit>提交</button>'
  return `<div class="msg a"><div class="askcard" data-ask="${esc(meta.requestId || '')}" data-run="${esc(meta.runId || '')}">
    <div class="ahead">${ic('help-circle', 13)} AI 想向你确认</div>
    ${body}
    <div class="afoot">${foot}</div>
  </div></div>`
}

function messageHtml(m) {
  const kind = m.kind || 'text'
  if (kind === 'context') {
    const meta = m.meta || {}
    return `<details class="ctxchg"><summary>${esc(meta.summary || m.content || '工作区变更')}</summary>
      <pre>${esc(meta.details || '')}</pre></details>`
  }
  if (kind === 'aux') {
    const meta = m.meta || {}
    const st = meta.status || 'done'
    const stateHtml = st === 'running'
      ? '<span class="tspin"></span>'
      : st === 'error'
        ? '<span class="aux-dot error"></span>'
        : '<span class="aux-dot done"></span>'
    const summary = meta.summary ? `<span class="aux-sum">${esc(meta.summary)}</span>` : ''
    const body = meta.details ? `<div class="aux-body"><pre>${esc(meta.details)}</pre></div>` : ''
    return `<div class="msg a"><details class="auxcard${st === 'error' ? ' err' : ''}"${st === 'error' ? ' open' : ''}>
      <summary><span class="aux-ico">${ic('sparkles', 13)}</span><span class="aux-title">${esc(meta.title || '辅助处理')}</span>${summary}<span class="aux-state">${stateHtml}</span></summary>
      ${body}</details></div>`
  }
  if (kind === 'subagent') {
    const meta = m.meta || {}
    const st = meta.status || 'pending'
    return `<div class="subcard" data-sub="${esc(meta.childSessionId || '')}">
      <div class="shead">${ic('bot', 13)}<span class="stt">${esc(meta.title || '子代理')}</span>
        <span class="sst">${esc(meta.agentName || '')}${meta.agentName ? ' · ' : ''}${esc(STATUS_TEXT[st] || st)}</span></div>
      ${meta.result ? `<div class="sres">${esc(meta.result)}</div>` : ''}
      ${meta.childSessionId ? `<button class="btn sm open" data-open-session="${esc(meta.childSessionId)}">打开子会话</button>` : ''}
    </div>`
  }
  if (kind === 'plan') {
    const meta = m.meta || {}
    const subs = Array.isArray(meta.subtasks) ? meta.subtasks : []
    const body = subs.map((s, i) => `${i + 1}. ${esc(s.title || '')} → ${esc(s.agent || '')}`).join('<br>')
    return `<div class="planbox"><b>编排计划</b>${body ? '<br>' + body : ''}</div>`
  }
  if (kind === 'error') {
    return `<div class="err">${esc(m.content)}</div>`
  }
  if (kind === 'diff') {
    const meta = m.meta || {}
    const files = Array.isArray(meta.files) ? meta.files : []
    const rows = files.map(diffFileHtml).join('')
    const note = meta.note ? `<span class="dnote">${esc(meta.note)}</span>` : ''
    const adds = files.reduce((n, f) => n + (Number(f.adds) || 0), 0)
    const dels = files.reduce((n, f) => n + (Number(f.dels) || 0), 0)
    // 文件多时默认收起，点标题行展开/收起
    const open = files.length > 5 ? '' : ' open'
    const allBtn = files.length > 1 ? `<button class="dall" data-open-diff="all">全部</button>` : ''
    return `<details class="diffbox"${open} data-mid="${esc(m.id)}"><summary class="dhead">
      <span class="dbchev">${ic('chevron-right', 12)}</span>${ic('git-compare', 13)}
      <span class="dtitle">${esc(m.content || '本次修改')}</span>
      <span class="dfiles">${files.length} 个文件</span>
      <span class="dstat"><span class="plus">+${adds}</span><span class="minus">−${dels}</span></span>${allBtn}
      ${note}</summary>
      <div class="dbody">${rows}</div></details>`
  }
  if (kind === 'ask') return askCardHtml(m)
  if (m.role === 'user') {
    const meta = m.meta || {}
    const atts = Array.isArray(meta.attachments) ? meta.attachments : []
    const imgs = atts
      .filter((a) => a && (a.thumb || a.dataUrl))
      .map((a) => `<img class="uimg" src="${esc(a.thumb || a.dataUrl)}"${a.path ? ` data-path="${esc(a.path)}"` : ''} alt="${esc(a.name || '图片')}" title="点击放大">`)
      .join('')
    const textHtml = m.content ? `<div class="bub">${esc(m.content)}</div>` : ''
    return `<div class="msg u">${textHtml}${imgs ? `<div class="ubatt">${imgs}</div>` : ''}</div>`
  }
  if (m.pending) {
    return `<div class="msg a"><div class="pendthink"><span class="tspin"></span><span>思考中…</span></div></div>`
  }
  const streaming = !!m.stream
  const plan = m.plan || (m.meta && m.meta.plan) || []
  const foot = footHtml(m, streaming)
  return `<div class="msg a"><div class="parts">${renderParts(partsOf(m), streaming, plan)}</div>${foot ? `<div class="turnfoot">${foot}</div>` : ''}</div>`
}

function diffFileHtml(f, i) {
  const file = f || {}
  const st = file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'
  const cls = file.status === 'added' ? 'add' : file.status === 'deleted' ? 'del' : 'mod'
  let body
  if (file.binary) {
    body = `<div class="dtag">二进制文件</div>`
  } else if (file.patch) {
    const full = String(file.patch)
    const shown = full.length > DIFF_INLINE_LIMIT ? full.slice(0, DIFF_INLINE_LIMIT) + '\n…（已截断）' : full
    body = `<pre>${diffPre(shown)}</pre><div class="dopen"><button data-open-diff="${i}">在标签页打开完整 diff</button></div>`
  } else {
    body = ''
  }
  return `<details class="drow"><summary><span class="dst ${cls}">${st}</span>
    <span class="dp">${esc(file.path || '')}</span>
    <span class="dn"><span class="plus">+${Number(file.adds) || 0}</span><span class="minus">−${Number(file.dels) || 0}</span></span></summary>${body}</details>`
}

function diffPre(text) {
  return String(text || '').replace(/\n$/, '').split(/\r?\n/).map((line) => {
    let cls = 'dl'
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) cls += ' meta'
    else if (line.startsWith('@@')) cls += ' hunk'
    else if (line.startsWith('+')) cls += ' in'
    else if (line.startsWith('-')) cls += ' out'
    return `<span class="${cls}">${esc(line) || ' '}</span>`
  }).join('')
}

function renderAll() {
  const inner = $('#chatInner')
  if (!messages.length) {
    inner.innerHTML = `<div class="empty">还没有对话。在下方输入需求，Enter 发送。</div>`
    return
  }
  inner.innerHTML = messages.map(messageHtml).join('')
  inner.querySelectorAll('.abody').forEach((b) => {
    highlightIn(b)
    enhanceMarkdown(b, { root: taskRoot() })
  })
  refreshIcons()
}

function scrollBottom(force) {
  const sc = $('#chatScroll')
  if (!sc) return
  if (force || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight
}

async function send() {
  const input = $('#chatInput')
  const text = input.value.trim()
  const atts = pendingAttachments.map(({ name, mime, dataUrl, thumb, size }) => ({ name, mime, dataUrl, thumb, size }))
  if ((!text && !atts.length) || !taskId) return
  input.value = ''
  autosize()
  clearAttachments()
  drafts.delete(taskId) // 已发送，清掉该任务的草稿，切回时不再回填
  // 统一入队：AI 正在回复时只排队、不打断；空闲时立即发出队首（含之前因出错暂停的队列）
  enqueue(text, atts)
  if (!running) drainIfQueued()
}

function dispatchSend(text, atts) {
  running = true
  updateButtons()
  chatApi('send', { taskId, sessionId, text, attachments: atts || [] }).then((r) => {
    runId = r && r.runId
  }).catch((e) => {
    pendingAttachments = (atts || []).map((a) => ({ ...a, id: a.id || ('att-' + Math.random().toString(36).slice(2)) }))
    renderAttachments()
    const input = $('#chatInput')
    if (input) { input.value = text || ''; autosize() }
    if (text) drafts.set(taskId, text)
    running = false
    updateButtons()
    toast('发送失败：' + e.message, 'err', 4000)
  })
}

// 供功能图/画板把上下文预填或直接发送到 AI 对话
export function prefillChat(text) {
  if (!taskId) return
  showPane('ai')
  const el = $('#chatInput')
  if (!el) return
  el.value = text || ''
  autosize()
  el.focus()
  try { el.setSelectionRange(el.value.length, el.value.length) } catch {}
}

export async function sendChatText(text) {
  if (!taskId) return
  showPane('ai')
  const el = $('#chatInput')
  if (!el) return
  el.value = text || ''
  autosize()
  await send()
}

// 会话管理「发送」：把提示词（含粘贴的图片）作为一条消息发到当前任务的会话
export async function sendChatMessage(payload = {}) {
  if (!taskId) return false
  showPane('ai')
  const extra = Array.isArray(payload.attachments) ? payload.attachments : []
  if (extra.length) {
    const room = ATT_MAX - pendingAttachments.length
    if (room > 0) { pendingAttachments = pendingAttachments.concat(extra.slice(0, room)); renderAttachments() }
  }
  const el = $('#chatInput')
  if (el) { el.value = String(payload.text || ''); autosize() }
  await send()
  return true
}

export function currentChatSession() {
  return { taskId, sessionId }
}

async function stop() {
  // 停止前把尚未发出的队列内容回写到输入框，并清空队列
  flushQueueToInput()
  if (!runId) return
  try { await chatApi('stop', { runId }) } catch {}}

async function newSession() {
  if (!taskId) return
  try {
    const s = await store('sessions.create', { dto: { taskId, title: '会话 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) } })
    await renderChat(taskId, s.id)
    toast('已新建会话')
  } catch (e) { toast('新建会话失败：' + e.message, 'err') }
}

export function handleEvent(ev) {
  if (!ev || ev.taskId !== taskId) return
  if (ev.sessionId && sessionId && ev.sessionId !== sessionId) return
  if (ev.runId && !runId) runId = ev.runId
  const type = ev.type
  if (type === 'featuremap') { emit('featuremap-updated', { taskId: ev.taskId, map: ev.map }); return }
  if (type === 'aux') {
    const meta = { title: ev.title || '辅助处理', status: ev.status || 'done', summary: ev.summary || '', details: ev.details || '' }
    const existing = ev.messageId ? messages.find((m) => m.id === ev.messageId) : null
    if (existing) { existing.kind = 'aux'; existing.role = 'assistant'; existing.meta = meta; existing.pending = false; existing.stream = false }
    else messages.push({ id: ev.messageId || ('aux-' + Date.now()), role: 'assistant', kind: 'aux', content: '', meta })
    renderAll()
    scrollBottom(true)
    return
  }
  if (type === 'board-sent') { emit('board-sent', ev.taskId); return }
  if (type === 'context') {
    messages.push({
      id: ev.messageId, role: 'assistant', kind: 'context', content: ev.summary || '',
      meta: { summary: ev.summary, details: ev.details, count: ev.count }
    })
    renderAll()
    scrollBottom(true)
    return
  }
  if (type === 'diff') {
    messages.push({
      id: ev.messageId, role: 'assistant', kind: 'diff', content: ev.summary || '',
      meta: { files: ev.files || [], note: ev.note || '' }
    })
    renderAll()
    scrollBottom(true)
    return
  }
  if (type === 'ask') {
    // 问到用户：清掉空的“思考中”占位，把已产出的流式内容定格，插入提问卡片
    messages = messages.filter((m) => !(m.stream && m.pending && !m.content && !(m.parts || []).length))
    messages.forEach((m) => { if (m.stream) { m.stream = false; m.pending = false } })
    messages.push({
      id: ev.messageId, role: 'assistant', kind: 'ask', content: '',
      meta: { requestId: ev.requestId, input: ev.input || {}, runId: ev.runId || runId }
    })
    renderAll()
    scrollBottom(true)
    return
  }
  if (type === 'user') {
    messages.push({ id: ev.messageId, role: 'user', kind: 'text', content: ev.text, meta: { attachments: ev.attachments || [] } })
    // 立即给出“思考中…”占位，避免执行体启动的几秒空白
    if (running && !messages.some((m) => m.stream)) {
      messages.push({
        role: 'assistant', kind: 'text', content: '', thinking: '', steps: [], parts: [], plan: [],
        stream: true, pending: true, startedAt: Date.now(), meta: {}
      })
    }
    renderAll()
    scrollBottom(true)
    return
  }
  if (type === 'shell') {
    upsertShell(ev.shell)
    renderShells()
    return
  }
  if (type === 'step') {
    if (orchestrateActive && !allowDelta) return
    if (!running) { running = true; updateButtons() }
    const last = ensureStreamMsg()
    last.pending = false
    if (!last.steps) last.steps = []
    const st = ev.step || {}
    if (st.id) {
      const i = last.steps.findIndex((s) => s.id === st.id)
      if (i >= 0) last.steps[i] = { ...last.steps[i], ...st }
      else last.steps.push({ name: '步骤', ...st })
    }
    upsertTool(last, st)
    scheduleStreamRender(last)
    return
  }
  if (type === 'plan') {
    if (orchestrateActive && !allowDelta) return
    if (!running) { running = true; updateButtons() }
    const last = ensureStreamMsg()
    last.pending = false
    last.plan = Array.isArray(ev.plan) ? ev.plan : []
    scheduleStreamRender(last)
    return
  }
  if (type === 'thinking') {
    if (orchestrateActive && !allowDelta) return
    if (!running) { running = true; updateButtons() }
    const last = ensureStreamMsg()
    last.pending = false
    last.thinking = (last.thinking || '') + ev.text
    pushThink(last, ev.text)
    scheduleStreamRender(last)
    return
  }
  if (type === 'delta') {
    if (orchestrateActive && !allowDelta) return
    if (!running) { running = true; updateButtons() }
    const last = ensureStreamMsg()
    last.pending = false
    last.content += ev.text
    pushText(last, ev.text)
    scheduleStreamRender(last)
    return
  }
  if (type === 'done') {
    const wasOrchestrate = orchestrateActive
    running = false
    runId = null
    orchestrateActive = false
    allowDelta = true
    updateButtons()
    // 空占位（未产生任何内容）直接移除，避免留下空的助手气泡
    if (messages.length && messages[messages.length - 1].stream && messages[messages.length - 1].pending
      && !messages[messages.length - 1].content && !(messages[messages.length - 1].parts || []).length) {
      messages.pop()
    }
    const last = messages[messages.length - 1]
    if (ev.error) {
      messages.push({ role: 'assistant', kind: 'error', content: '出错：' + ev.error, meta: {} })
      renderAll()
      scrollBottom(true)
      return
    }
    if (last && last.stream) {
      last.stream = false
      closeStreamMsg(last, ev)
      renderAll()
    } else if (ev.content) {
      messages.push({
        role: 'assistant', kind: 'text', content: ev.content,
        meta: {
          tokens: ev.tokens, parts: ev.parts, durationMs: ev.durationMs, plan: ev.plan || undefined,
          inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, cachedTokens: ev.cachedTokens
        }
      })
      renderAll()
    }
    scrollBottom(true)
    if (!wasOrchestrate) refreshChatHeader()
    // 本轮正常结束：若有排队消息，自动发出下一条（顺序接力，一条一轮）
    drainIfQueued()
    return
  }
  if (type === 'child') {
    const idx = messages.findIndex((m) => m.kind === 'subagent' && m.id && m.id === ev.messageId)
    const meta = {
      childSessionId: ev.childSessionId, title: ev.title, agentName: ev.agentName,
      status: ev.status, result: ev.result || ''
    }
    if (idx >= 0) {
      messages[idx] = { ...messages[idx], meta: { ...(messages[idx].meta || {}), ...meta } }
    } else {
      messages.push({ id: ev.messageId, role: 'assistant', kind: 'subagent', content: '', meta })
    }
    renderAll()
    scrollBottom(false)
    return
  }
  if (type === 'orchestrate') {
    orchestrateActive = true
    if (ev.stage === 'plan') {
      allowDelta = false
      // 编排开始：去掉“思考中…”占位，用计划卡片代替
      const pi = messages.findIndex((m) => m.stream && m.pending && !m.content && !(m.parts || []).length)
      if (pi >= 0) messages.splice(pi, 1)
      messages.push({
        id: ev.messageId, role: 'assistant', kind: 'plan', content: '编排计划',
        meta: { subtasks: ev.subtasks || [] }
      })
      renderAll()
      scrollBottom(true)
    } else if (ev.stage === 'child') {
      if (!running) { running = true; updateButtons() }
      if (Number(ev.index) === Number(ev.total) - 1) allowDelta = true
    }
    return
  }
  if (type === 'summary') {
    if (info && info.session) info.session.summary = ev.summary
    toast('会话摘要已更新')
    return
  }
  if (type === 'brief') {
    if (info && info.task) info.task.brief = ev.brief
    emit('brief-updated', { taskId: ev.taskId, brief: ev.brief })
    return
  }
  if (type === 'keyinfo') {
    emit('keyinfo-updated', { taskId: ev.taskId, content: ev.content })
    return
  }
  if (type === 'needKey') {
    toast('未设置 API Key：请在「模型」中为内置聊天配置 Key', 'err', 5000)
  }
}

function ensureStreamMsg() {
  let last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant' || last.kind !== 'text' || !last.stream) {
    last = {
      role: 'assistant', kind: 'text', content: '', thinking: '', steps: [], parts: [], plan: [],
      stream: true, startedAt: Date.now(), meta: {}
    }
    messages.push(last)
    renderAll()
    scrollBottom(true)
  }
  return last
}

function lastPartOf(msg) {
  return msg.parts && msg.parts.length ? msg.parts[msg.parts.length - 1] : null
}

function pushThink(msg, text) {
  if (!text) return
  if (!msg.parts) msg.parts = []
  const last = lastPartOf(msg)
  if (last && last.t === 'think' && last.ms == null) last.text += text
  else msg.parts.push({ t: 'think', text, at: Date.now() })
}

function closeThinkPart(msg) {
  const last = lastPartOf(msg)
  if (last && last.t === 'think' && last.ms == null) last.ms = Date.now() - (last.at || Date.now())
}

function pushText(msg, text) {
  if (!text) return
  if (!msg.parts) msg.parts = []
  closeThinkPart(msg)
  const last = lastPartOf(msg)
  if (last && last.t === 'text') last.text += text
  else msg.parts.push({ t: 'text', text })
}

function upsertTool(msg, st) {
  if (!st || !st.id) return
  if (!msg.parts) msg.parts = []
  closeThinkPart(msg)
  let p = msg.parts.find((x) => x.t === 'tool' && x.id === st.id)
  if (!p) {
    p = {
      t: 'tool', id: st.id, name: st.name || '步骤', detail: st.detail || '',
      status: st.status || 'running', at: Date.now()
    }
    msg.parts.push(p)
  } else {
    if (st.name) p.name = st.name
    if (st.detail != null) p.detail = st.detail
    if (st.status) p.status = st.status
  }
  if (p.status !== 'running' && p.ms == null) p.ms = Date.now() - (p.at || Date.now())
}

function closeStreamMsg(msg, ev) {
  closeThinkPart(msg)
  for (const p of msg.parts || []) {
    if (p.t === 'tool' && p.status === 'running') {
      p.status = 'done'
      if (p.ms == null) p.ms = Date.now() - (p.at || Date.now())
    }
  }
  if (Array.isArray(ev && ev.parts) && ev.parts.length) msg.parts = ev.parts
  if (ev && Array.isArray(ev.plan) && ev.plan.length) msg.plan = ev.plan
  const meta = { ...(msg.meta || {}), parts: msg.parts || [] }
  if (msg.thinking) meta.thinking = msg.thinking
  if (msg.steps && msg.steps.length) meta.steps = msg.steps
  if (msg.plan && msg.plan.length) meta.plan = msg.plan
  if (ev && ev.tokens) meta.tokens = ev.tokens
  if (ev && ev.inputTokens != null) meta.inputTokens = ev.inputTokens
  if (ev && ev.outputTokens != null) meta.outputTokens = ev.outputTokens
  if (ev && ev.cachedTokens != null) meta.cachedTokens = ev.cachedTokens
  meta.durationMs = (ev && ev.durationMs) || (msg.startedAt ? Date.now() - msg.startedAt : 0)
  msg.meta = meta
  if (ev && ev.content != null && ev.content !== '') msg.content = ev.content
}

function partsSig(parts, plan) {
  let s = ''
  for (const p of parts || []) {
    if (p.t === 'text') s += 'x' + String(p.text || '').length
    else if (p.t === 'think') s += 'k' + String(p.text || '').length + (p.ms != null ? 'm' : '')
    else s += 't' + (p.id || '') + ':' + (p.status || '') + ':' + String(p.detail || '').length + (p.ms != null ? 'm' : '')
  }
  return s + '|p' + (plan || []).map((x) => (x.status || '') + String(x.text || '').length).join(',')
}

function scheduleStreamRender(msg) {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const els = document.querySelectorAll('#chatInner .msg.a')
    const el = els[els.length - 1]
    if (!el) { renderAll(); return }
    const container = el.querySelector('.parts')
    if (!container) { renderAll(); return }
    const sig = partsSig(msg.parts, msg.plan)
    if (container.dataset.sig !== sig) {
      // 结构变化才整体重排；保留用户手动展开的 details 状态
      const open = []
      container.querySelectorAll(':scope > details').forEach((d, i) => { open[i] = d.open })
      container.innerHTML = renderParts(msg.parts, true, msg.plan)
      container.querySelectorAll(':scope > details').forEach((d, i) => { if (open[i] != null) d.open = open[i] })
      container.dataset.sig = sig
      refreshIcons()
      container.querySelectorAll('.abody').forEach((b) => {
        highlightIn(b)
        enhanceMarkdown(b, { root: taskRoot() })
      })
    }
    let foot = el.querySelector('.turnfoot')
    if (!foot) {
      foot = document.createElement('div')
      foot.className = 'turnfoot'
      el.appendChild(foot)
    }
    foot.innerHTML = footHtml(msg, true)
    scrollBottom(false)
  })
}

// ---------- @ 文件/文件夹引用选择器（按目录逐层浏览） ----------

function relJoin(dir, name) { return dir ? dir + '/' + name : name }

// 只读取当前层，逐层浏览；目录不可读返回 null
async function listDirEntries(relDir) {
  const root = info && info.task && info.task.path
  if (!root) return null
  // 超出任务目录的相对路径（如手输 @../）直接收起，避免主进程报错
  if (relDir.split('/').some((seg) => seg === '..')) return null
  let list
  try { list = await fsapi('readDir', { path: relDir ? joinPath(root, relDir) : root }) } catch { return null }
  const out = []
  for (const it of list) {
    if (it.name.startsWith('.')) continue
    if (it.dir) {
      if (MENTION_SKIP.has(it.name)) continue
      out.push({ name: it.name, path: relJoin(relDir, it.name), dir: true })
    } else {
      out.push({ name: it.name, path: relJoin(relDir, it.name), dir: false })
    }
  }
  out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)))
  return out
}

function mentionEl() {
  let el = document.getElementById('chatMention')
  if (el) return el
  const comp = document.querySelector('#pane-ai .comp')
  if (!comp) return null
  el = document.createElement('div')
  el.id = 'chatMention'
  comp.appendChild(el)
  return el
}

async function updateMention() {
  const el = $('#chatInput')
  if (!el || !taskId) { hideMention(); return }
  const m = el.value.slice(0, el.selectionStart).match(/(^|[\s(])@([^\s@]*)$/)
  if (!m) { hideMention(); return }
  const query = m[2]
  const start = el.selectionStart - query.length - 1
  const end = el.selectionStart
  const slash = query.lastIndexOf('/')
  const relDir = slash >= 0 ? query.slice(0, slash) : ''
  const filter = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase()
  const entries = await listDirEntries(relDir)
  if (!entries) { hideMention(); return }
  let items = entries.filter((e) => e.name.toLowerCase().includes(filter))
  // 子目录顶部提供「..」返回上一层（不入 items 过滤，始终可退）
  if (relDir) {
    const parts = relDir.split('/')
    parts.pop()
    items = [{ name: '..', path: parts.join('/'), dir: true, up: true }, ...items]
  }
  // 根目录下无匹配则收起；进入子目录后即使无匹配也保留，便于「引用此目录」
  if (!items.length && !relDir) { hideMention(); return }
  const prevKey = mention.currentKey
  mention.open = true
  mention.items = items
  mention.dir = relDir
  mention.start = start
  mention.end = end
  const found = items.findIndex((e) => e.path === prevKey)
  mention.idx = found >= 0 ? found : 0
  renderMention()
}

function renderMention() {
  const el = mentionEl()
  if (!el) return
  const crumbs = mention.dir ? mention.dir.split('/') : []
  let bc = `<div class="mbc"><a class="mcrumb" data-act="jump" data-path="">根目录</a>`
  crumbs.forEach((c, i) => {
    const p = crumbs.slice(0, i + 1).join('/')
    bc += `<span class="msep">/</span><a class="mcrumb" data-act="jump" data-path="${esc(p)}">${esc(c)}</a>`
  })
  if (mention.dir) {
    bc += `<span class="sp"></span><a class="mrefdir" data-act="refdir" data-path="${esc(mention.dir)}">引用此目录</a>`
  }
  bc += '</div>'
  const rows = mention.items.map((e, i) => {
    const on = i === mention.idx ? ' on' : ''
    if (e.up) {
      return `<div class="mi dir up${on}" data-act="up" data-i="${i}">
        <i data-lucide="corner-up-left" style="width:13px;height:13px;color:#dcb67a"></i>
        <span class="mn">..（上层）</span></div>`
    }
    if (e.dir) {
      return `<div class="mi dir${on}" data-act="enter" data-i="${i}">
        <i data-lucide="folder" style="width:13px;height:13px;color:#dcb67a"></i>
        <span class="mn">${esc(e.name)}</span>
        <span class="mref" data-act="ref" data-path="${esc(e.path)}">引用</span></div>`
    }
    return `<div class="mi${on}" data-act="pick" data-i="${i}">
      <i data-lucide="file" style="width:13px;height:13px"></i>
      <span class="mn">${esc(e.name)}</span></div>`
  }).join('')
  el.innerHTML = bc + rows
  el.style.display = 'block'
  refreshIcons()
  el.onmousedown = (ev) => {
    const t = ev.target.closest('[data-act]')
    if (!t) return
    ev.preventDefault()
    const act = t.getAttribute('data-act')
    if (act === 'pick') confirmEntry(Number(t.getAttribute('data-i')))
    else if (act === 'enter') chooseEntry(Number(t.getAttribute('data-i')))
    else if (act === 'up') goUp()
    else if (act === 'ref' || act === 'refdir') insertRef(t.getAttribute('data-path') || '', true)
    else if (act === 'jump') jumpTo(t.getAttribute('data-path') || '')
  }
  const on = el.querySelector('.mi.on')
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' })
}

function hideMention() {
  mention.open = false
  mention.items = []
  mention.idx = 0
  mention.currentKey = ''
  const el = document.getElementById('chatMention')
  if (el) el.style.display = 'none'
}

// 用 insert 替换输入框里的 @查询 片段，返回新光标位置
function replaceMention(insert) {
  const el = $('#chatInput')
  const val = el.value
  el.value = val.slice(0, mention.start) + insert + val.slice(mention.end)
  const caret = mention.start + insert.length
  el.setSelectionRange(caret, caret)
  autosize()
  return caret
}

// Tab/→：选择（文件夹进入、文件即引用）
function chooseEntry(i) {
  const e = mention.items[i]
  if (!e) return
  if (e.up) { goUp(); return }
  if (e.dir) { mention.currentKey = ''; replaceMention('@' + e.path + '/'); updateMention(); return }
  insertRef(e.path, false)
}

// Enter：确认引用当前项（文件用路径，文件夹带结尾 /）
function confirmEntry(i) {
  const e = mention.items[i]
  if (!e) return
  if (e.up) { goUp(); return }
  insertRef(e.path, e.dir)
}

// 引用目标（文件或文件夹）并收起选择器
function insertRef(path, folder) {
  if (!path) return
  replaceMention('@' + path + (folder ? '/' : '') + ' ')
  hideMention()
  $('#chatInput').focus()
}

function jumpTo(path) {
  mention.currentKey = ''
  replaceMention(path ? '@' + path + '/' : '@')
  updateMention()
}

function goUp() {
  if (!mention.dir) return
  const parts = mention.dir.split('/')
  parts.pop()
  jumpTo(parts.join('/'))
}

function mentionKey(e) {
  if (!mention.open) return false
  const n = Math.max(1, mention.items.length)
  if (e.key === 'Escape') { e.preventDefault(); hideMention(); return true }
  if (e.key === 'ArrowDown') {
    e.preventDefault(); mention.idx = (mention.idx + 1) % n; syncKey(); renderMention(); return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault(); mention.idx = (mention.idx - 1 + n) % n; syncKey(); renderMention(); return true
  }
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault(); mention.idx = (mention.idx - 1 + n) % n; syncKey(); renderMention(); return true
  }
  if (e.key === 'ArrowRight' || e.key === 'Tab') { e.preventDefault(); chooseEntry(mention.idx); return true }
  if (e.key === 'ArrowLeft') { e.preventDefault(); goUp(); return true }
  if (e.key === 'Enter') { e.preventDefault(); confirmEntry(mention.idx); return true }
  return false
}

function syncKey() {
  const e = mention.items[mention.idx]
  mention.currentKey = e ? e.path : ''
}
