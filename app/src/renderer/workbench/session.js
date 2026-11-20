// 会话管理 pane：提示词 + 画板 + 改动
import { store } from '../lib/api.js'
import { state, on } from '../lib/state.js'
import { $, esc, ic, refreshIcons, debounce, basename } from '../lib/ui.js'
import { toast } from '../components/toast.js'

let strokes = []
let taskId = null
let ctx = null
let drawing = null
let savePrompt = null
let saveCanvas = null
let canvasInited = false

export function initSessionView() {
  savePrompt = debounce(async (id, value) => {
    try { await store('settings.set', { key: 'session:prompt:' + id, value }) } catch {}
  }, 500)
  saveCanvas = debounce(async (id) => {
    try { await store('settings.set', { key: 'session:canvas:' + id, value: JSON.stringify({ strokes }) }) } catch {}
  }, 600)

  $('#sessionPrompt').addEventListener('input', (e) => {
    if (taskId) savePrompt(taskId, e.target.value)
  })

  const canvas = $('#cvsCanvas')
  const resize = () => {
    const wrap = canvas.parentElement
    if (!wrap) return
    const dpr = window.devicePixelRatio || 1
    const r = wrap.getBoundingClientRect()
    canvas.width = Math.max(10, Math.floor(r.width * dpr))
    canvas.height = Math.max(10, Math.floor(r.height * dpr))
    redraw()
  }
  new ResizeObserver(resize).observe(canvas.parentElement)
  resize()
  canvasInited = true

  const point = (e) => {
    const r = canvas.getBoundingClientRect()
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!taskId) return
    canvas.setPointerCapture(e.pointerId)
    drawing = { color: '#7dd3fc', pts: [point(e)] }
    strokes.push(drawing)
    redraw()
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return
    drawing.pts.push(point(e))
    redraw()
  })
  const end = () => {
    if (!drawing) return
    drawing = null
    saveCanvas(taskId)
  }
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', end)
  canvas.addEventListener('pointerleave', end)

  $('#cvsClear').addEventListener('click', () => {
    strokes = []
    redraw()
    if (taskId) saveCanvas(taskId)
  })

  on('changes-updated', renderChanges)
}

export async function renderSession(id) {
  taskId = id
  const promptEl = $('#sessionPrompt')
  if (!id) {
    promptEl.value = ''
    promptEl.disabled = true
    $('#sessionLabel').textContent = '未选择任务'
    strokes = []
    redraw()
    renderChanges()
    return
  }
  promptEl.disabled = false
  const task = state.tasks.find((t) => t.id === id)
  $('#sessionLabel').textContent = (task ? task.name : '') + ' · 当前会话'
  try {
    promptEl.value = await store('settings.get', { key: 'session:prompt:' + id, dflt: '' })
  } catch { promptEl.value = '' }
  try {
    const raw = await store('settings.get', { key: 'session:canvas:' + id, dflt: '' })
    const data = raw ? JSON.parse(raw) : null
    strokes = data && Array.isArray(data.strokes) ? data.strokes : []
  } catch { strokes = [] }
  redraw()
  renderChanges()
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

function redraw() {
  const canvas = $('#cvsCanvas')
  if (!canvas) return
  ctx = ctx || canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.scale(dpr, dpr)
  const w = canvas.width / dpr
  const h = canvas.height / dpr
  for (const s of strokes) {
    if (!s.pts || s.pts.length < 2) continue
    ctx.beginPath()
    ctx.strokeStyle = s.color || '#7dd3fc'
    ctx.lineWidth = 1.6
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    s.pts.forEach(([x, y], i) => {
      const px = x * w, py = y * h
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    })
    ctx.stroke()
  }
}
