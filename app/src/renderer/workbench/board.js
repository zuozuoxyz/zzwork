// 画板：结构化白板（矩形/圆角/椭圆/菱形/文本/便签/箭头/画笔），SVG 编辑，v2 JSON 自动保存
import { store } from '../lib/api.js'
import { $, esc, ic, refreshIcons, setupFullscreen } from '../lib/ui.js'
import { state, on } from '../lib/state.js'
import { sendChatText } from './chat.js'

const TOOLS = [
  ['select', 'mouse-pointer-2', '选择'],
  ['pen', 'pencil', '画笔'],
  ['rect', 'square', '矩形'],
  ['roundRect', 'rectangle-horizontal', '圆角矩形'],
  ['ellipse', 'circle', '椭圆'],
  ['diamond', 'diamond', '菱形'],
  ['text', 'type', '文本'],
  ['note', 'sticky-note', '便签'],
  ['arrow', 'move-up-right', '箭头']
]
const MIN_SIZE = 0.02

let inited = false
let host = null, svg = null, root = null
let taskId = null
let data = { v: 2, shapes: [], edges: [] }
let tool = 'select'
let sel = new Set()
let view = { scale: 1, tx: 0, ty: 0 }
let W = 640, H = 420
let drag = null
let sentHash = ''
let saveTimer = null
let editor = null
let space = false
let seq = 0

const uid = () => 'b' + (++seq).toString(36) + '-' + Math.random().toString(36).slice(2, 6)
const shapeById = (id) => data.shapes.find((s) => s.id === id) || null
function taskNameOf(id) {
  const t = id ? state.tasks.find((x) => x.id === id) : null
  return t ? t.name : ''
}

export function initBoard() {
  if (inited) return
  host = $('#boardHost')
  if (!host) return
  inited = true
  const toolBtns = TOOLS.map(([t, icon, label]) => {
    const sep = (t === 'pen' || t === 'text') ? '<span class="bd-sep"></span>' : ''
    return sep + `<button class="ib${t === 'select' ? ' on' : ''}" data-tool="${t}" title="${label}">${ic(icon, 14)}</button>`
  }).join('')
  host.innerHTML =
    `<div class="bd-tools">` +
    `<span class="bd-title" id="bdTitle">画板</span>` +
    `<span class="bd-sep"></span>` +
    toolBtns +
    `<span class="sp"></span>` +
    `<button class="ib" id="bdFit" title="适应画板">${ic('maximize', 14)}</button>` +
    `<button class="ib" id="bdFullscreen" title="全屏">${ic('maximize-2', 14)}</button>` +
    `<button class="ib danger" id="bdClear" title="清空画板">${ic('trash-2', 14)}</button>` +
    `</div>` +
    `<div class="bd-canvas"><svg class="bd-svg" id="bdSvg"><g id="bdRoot"></g></svg>` +
    `<div class="bd-empty" id="bdEmpty">选择上方工具在画板上绘制 · 双击图形编辑文字 · 拖动空白处平移 · 滚轮缩放</div></div>`
  refreshIcons()
  svg = $('#bdSvg')
  root = $('#bdRoot')

  host.querySelectorAll('.bd-tools [data-tool]').forEach((b) => {
    b.addEventListener('click', () => {
      tool = b.getAttribute('data-tool')
      host.querySelectorAll('.bd-tools [data-tool]').forEach((x) => x.classList.toggle('on', x.getAttribute('data-tool') === tool))
      svg.style.cursor = tool === 'select' ? 'default' : 'crosshair'
    })
  })
  $('#bdFit').addEventListener('click', fitView)
  setupFullscreen(host, $('#bdFullscreen'), () => fitView())
  $('#bdClear').addEventListener('click', () => {
    if (!taskId) return
    data = { v: 2, shapes: [], edges: [] }
    sel = new Set()
    view = { scale: 1, tx: 0, ty: 0 }
    render(); scheduleSave()
  })
  const badge = $('#boardBadge')
  if (badge) badge.addEventListener('click', () => {
    sentHash = JSON.stringify(data)
    updateBadge()
    sendChatText('【画板】我已更新画板，请查看画板内容并据此回应或执行。')
  })

  on('board-sent', async (tid) => {
    if (tid !== taskId) return
    try { sentHash = await store('settings.get', { key: 'session:canvasSent:' + tid, dflt: '' }) } catch {}
    updateBadge()
  })

  const resize = () => {
    const wrap = svg.parentElement
    if (!wrap) return
    const r = wrap.getBoundingClientRect()
    W = Math.max(60, Math.floor(r.width))
    H = Math.max(60, Math.floor(r.height))
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    render()
  }
  new ResizeObserver(resize).observe(svg.parentElement)
  resize()

  svg.addEventListener('pointerdown', onPointerDown)
  svg.addEventListener('pointermove', onPointerMove)
  svg.addEventListener('pointerup', onPointerUp)
  svg.addEventListener('pointercancel', onPointerUp)
  svg.addEventListener('wheel', onWheel, { passive: false })
  svg.addEventListener('dblclick', (e) => {
    const p = getNorm(e.clientX, e.clientY)
    const hit = shapeAt(p.x, p.y)
    if (hit) openEditor(hit)
  })
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
}

function isActive() {
  if (!host || !taskId) return false
  const pane = document.getElementById('pane-session')
  return !!(pane && pane.classList.contains('on') && !host.classList.contains('hidden'))
}

function onKeyDown(e) {
  if (!isActive() || editor) return
  const ae = document.activeElement
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable)) return
  if (e.code === 'Space') { space = true; e.preventDefault() }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { deleteSelected(); e.preventDefault() }
}
function onKeyUp(e) { if (e.code === 'Space') space = false }

function getNorm(clientX, clientY) {
  const rect = svg.getBoundingClientRect()
  const sx = clientX - rect.left
  const sy = clientY - rect.top
  const ux = (sx - view.tx) / view.scale
  const uy = (sy - view.ty) / view.scale
  return { x: ux / W, y: uy / H }
}

function px(s) {
  const w = Math.abs(s.w) * W, h = Math.abs(s.h) * H
  return { x: s.x * W, y: s.y * H, w, h }
}
function centerPx(s) { const q = px(s); return { x: q.x + q.w / 2, y: q.y + q.h / 2 } }

// 从图形中心朝目标点方向，取与图形包围盒的交点作为连线端点
function edgeEnd(s, target) {
  const c = centerPx(s)
  const dx = target.x - c.x, dy = target.y - c.y
  const hw = Math.abs(s.w) * W / 2, hh = Math.abs(s.h) * H / 2
  if (!hw || !hh || (!dx && !dy)) return c
  const tx = dx ? hw / Math.abs(dx) : Infinity
  const ty = dy ? hh / Math.abs(dy) : Infinity
  const t = Math.min(tx, ty)
  return { x: c.x + dx * t, y: c.y + dy * t }
}

function shapeAt(nx, ny) {
  for (let i = data.shapes.length - 1; i >= 0; i--) {
    const s = data.shapes[i]
    if (s.type === 'pen') {
      const pts = s.points || []
      if (pts.some(([x, y]) => Math.abs(x - nx) < 0.02 && Math.abs(y - ny) < 0.02)) return s
      continue
    }
    const x1 = Math.min(s.x, s.x + s.w), x2 = Math.max(s.x, s.x + s.w)
    const y1 = Math.min(s.y, s.y + s.h), y2 = Math.max(s.y, s.y + s.h)
    if (nx >= x1 && nx <= x2 && ny >= y1 && ny <= y2) return s
  }
  return null
}

function onPointerDown(e) {
  if (!taskId) return
  if (e.button === 1 || space) {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty }
    svg.setPointerCapture(e.pointerId)
    return
  }
  if (e.button !== 0) return
  const p = getNorm(e.clientX, e.clientY)
  if (tool === 'select') {
    const hit = shapeAt(p.x, p.y)
    if (hit) {
      if (e.shiftKey) { sel.has(hit.id) ? sel.delete(hit.id) : sel.add(hit.id) }
      else if (!sel.has(hit.id)) sel = new Set([hit.id])
      drag = { mode: 'move', start: p, orig: data.shapes.filter((s) => sel.has(s.id)).map((s) => ({ id: s.id, x: s.x, y: s.y })) }
    } else {
      if (!e.shiftKey) sel = new Set()
      drag = { mode: 'marquee', a: p, b: p }
    }
    svg.setPointerCapture(e.pointerId); render(); return
  }
  if (tool === 'arrow') {
    const hit = shapeAt(p.x, p.y)
    if (!hit) return
    drag = { mode: 'arrow', from: hit.id, b: p }
    svg.setPointerCapture(e.pointerId); render(); return
  }
  if (tool === 'pen') {
    const s = { id: uid(), type: 'pen', x: 0, y: 0, w: 0, h: 0, points: [[p.x, p.y]], color: '#7dd3fc' }
    data.shapes.push(s)
    drag = { mode: 'pen', shape: s }
    svg.setPointerCapture(e.pointerId); render(); return
  }
  const s = { id: uid(), type: tool, x: p.x, y: p.y, w: 0, h: 0, text: '' }
  data.shapes.push(s)
  drag = { mode: 'create', shape: s, start: p }
  svg.setPointerCapture(e.pointerId); render()
}

function onPointerMove(e) {
  if (!drag) return
  if (drag.mode === 'pan') { view.tx = drag.tx + (e.clientX - drag.sx); view.ty = drag.ty + (e.clientY - drag.sy); render(); return }
  const p = getNorm(e.clientX, e.clientY)
  if (drag.mode === 'move') {
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y
    for (const o of drag.orig) { const s = shapeById(o.id); if (s) { s.x = o.x + dx; s.y = o.y + dy } }
    render(); return
  }
  if (drag.mode === 'marquee') { drag.b = p; render(); return }
  if (drag.mode === 'arrow') { drag.b = p; render(); return }
  if (drag.mode === 'pen') { drag.shape.points.push([p.x, p.y]); render(); return }
  if (drag.mode === 'create') {
    const s = drag.shape, a = drag.start
    s.x = Math.min(a.x, p.x); s.y = Math.min(a.y, p.y)
    s.w = Math.abs(p.x - a.x); s.h = Math.abs(p.y - a.y)
    render()
  }
}

function onPointerUp(e) {
  if (!drag) return
  const d = drag
  drag = null
  if (d.mode === 'marquee') {
    const x1 = Math.min(d.a.x, d.b.x), x2 = Math.max(d.a.x, d.b.x)
    const y1 = Math.min(d.a.y, d.b.y), y2 = Math.max(d.a.y, d.b.y)
    for (const s of data.shapes) {
      if (s.type === 'pen') continue
      const bx1 = Math.min(s.x, s.x + s.w), bx2 = Math.max(s.x, s.x + s.w)
      const by1 = Math.min(s.y, s.y + s.h), by2 = Math.max(s.y, s.y + s.h)
      if (bx2 >= x1 && bx1 <= x2 && by2 >= y1 && by1 <= y2) sel.add(s.id)
    }
  } else if (d.mode === 'create') {
    const s = d.shape
    if (s.w < MIN_SIZE && s.h < MIN_SIZE) { s.w = s.type === 'note' ? 0.2 : 0.16; s.h = 0.12 }
    if (s.type === 'text' || s.type === 'note') openEditor(s)
    scheduleSave()
  } else if (d.mode === 'pen') {
    if ((d.shape.points || []).length < 2) data.shapes = data.shapes.filter((x) => x !== d.shape)
    scheduleSave()
  } else if (d.mode === 'arrow') {
    const p = getNorm(e.clientX, e.clientY)
    const hit = shapeAt(p.x, p.y)
    if (hit && hit.id !== d.from && !data.edges.some((x) => x.from === d.from && x.to === hit.id)) {
      data.edges.push({ id: uid(), from: d.from, to: hit.id })
    }
    scheduleSave()
  } else if (d.mode === 'move') {
    scheduleSave()
  }
  render()
}

function onWheel(e) {
  if (!taskId) return
  e.preventDefault()
  const rect = svg.getBoundingClientRect()
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top
  const ns = Math.max(0.2, Math.min(4, view.scale * (e.deltaY < 0 ? 1.1 : 0.9)))
  view.tx = sx - (sx - view.tx) * (ns / view.scale)
  view.ty = sy - (sy - view.ty) * (ns / view.scale)
  view.scale = ns
  render()
}

function deleteSelected() {
  data.shapes = data.shapes.filter((s) => !sel.has(s.id))
  data.edges = data.edges.filter((e) => !sel.has(e.from) && !sel.has(e.to))
  sel = new Set()
  render(); scheduleSave()
}

function fitView() {
  if (!data.shapes.length) { view = { scale: 1, tx: 0, ty: 0 }; render(); return }
  let minx = 1, miny = 1, maxx = 0, maxy = 0
  for (const s of data.shapes) {
    if (s.type === 'pen') { for (const [x, y] of s.points || []) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y) } continue }
    minx = Math.min(minx, s.x); miny = Math.min(miny, s.y); maxx = Math.max(maxx, s.x + s.w); maxy = Math.max(maxy, s.y + s.h)
  }
  const bw = Math.max(0.02, maxx - minx), bh = Math.max(0.02, maxy - miny)
  const s = Math.min(1 / bw, 1 / bh) * 0.9
  view.scale = Math.max(0.2, Math.min(3, s))
  view.tx = (W - bw * W * view.scale) / 2 - minx * W * view.scale
  view.ty = (H - bh * H * view.scale) / 2 - miny * H * view.scale
  render()
}

function shapeSvg(s) {
  const q = px(s)
  const isSel = sel.has(s.id)
  const stroke = isSel ? 'var(--acc)' : '#3b434d'
  const sw = isSel ? 2 : 1.2
  const fill = s.type === 'note' ? 'rgba(250,204,21,.14)' : (s.type === 'text' ? 'transparent' : 'rgba(56,139,253,.10)')
  const common = `vector-effect="non-scaling-stroke" stroke="${stroke}" stroke-width="${sw}" fill="${fill}"`
  const label = () => (s.text
    ? `<foreignObject x="${q.x}" y="${q.y}" width="${Math.max(q.w, 16)}" height="${Math.max(q.h, 14)}"><div xmlns="http://www.w3.org/1999/xhtml" class="bd-fo center${s.type === 'note' ? ' note' : ''}${isSel ? ' sel' : ''}">${esc(s.text)}</div></foreignObject>`
    : '')
  switch (s.type) {
    case 'rect':
      return `<rect class="bd-shape" x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" ${common}/>` + label()
    case 'roundRect':
      return `<rect class="bd-shape" x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" rx="10" ${common}/>` + label()
    case 'ellipse':
      return `<ellipse class="bd-shape" cx="${q.x + q.w / 2}" cy="${q.y + q.h / 2}" rx="${q.w / 2}" ry="${q.h / 2}" ${common}/>` + label()
    case 'diamond': {
      const pts = `${q.x + q.w / 2},${q.y} ${q.x + q.w},${q.y + q.h / 2} ${q.x + q.w / 2},${q.y + q.h} ${q.x},${q.y + q.h / 2}`
      return `<polygon class="bd-shape" points="${pts}" ${common}/>` + label()
    }
    case 'note': {
      const ns = isSel ? 'var(--acc)' : 'rgba(250,204,21,.4)'
      return `<rect class="bd-shape" x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" rx="5" vector-effect="non-scaling-stroke" stroke="${ns}" stroke-width="${isSel ? 2 : 1.2}" fill="rgba(250,204,21,.14)"/>` + label()
    }
    case 'pen': {
      const pts = (s.points || []).map(([nx, ny]) => `${nx * W},${ny * H}`).join(' ')
      return `<polyline class="bd-pen" points="${pts}" fill="none" stroke="${isSel ? 'var(--acc)' : (s.color || '#7dd3fc')}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`
    }
    default: {
      const cls = 'bd-fo text' + (isSel ? ' sel' : '')
      return `<foreignObject x="${q.x}" y="${q.y}" width="${Math.max(q.w, 16)}" height="${Math.max(q.h, 14)}"><div xmlns="http://www.w3.org/1999/xhtml" class="${cls}">${esc(s.text || '')}</div></foreignObject>`
    }
  }
}

function render() {
  if (!root) return
  const hint = $('#bdEmpty')
  if (hint) hint.classList.toggle('hidden', data.shapes.length > 0 || data.edges.length > 0)
  const parts = ['<defs><marker id="bdArrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#8b949e"/></marker></defs>']
  for (const e of data.edges) {
    const a = shapeById(e.from), b = shapeById(e.to)
    if (!a || !b) continue
    const ca = centerPx(a), cb = centerPx(b)
    const A = edgeEnd(a, cb), B = edgeEnd(b, ca)
    const hl = sel.has(e.from) || sel.has(e.to)
    parts.push(`<line class="bd-edge${hl ? ' hl' : ''}" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}" stroke="${hl ? 'var(--acc)' : '#8b949e'}" stroke-width="1.6" marker-end="url(#bdArrow)" vector-effect="non-scaling-stroke"/>`)
    if (e.label) parts.push(`<foreignObject x="${(A.x + B.x) / 2 - 60}" y="${(A.y + B.y) / 2 - 11}" width="120" height="22"><div xmlns="http://www.w3.org/1999/xhtml" class="bd-elabel">${esc(e.label)}</div></foreignObject>`)
  }
  for (const s of data.shapes) parts.push(shapeSvg(s))
  if (drag && drag.mode === 'marquee') {
    const x = Math.min(drag.a.x, drag.b.x) * W, y = Math.min(drag.a.y, drag.b.y) * H
    const w = Math.abs(drag.a.x - drag.b.x) * W, h = Math.abs(drag.a.y - drag.b.y) * H
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(56,139,253,.08)" stroke="var(--acc)" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`)
  }
  if (drag && drag.mode === 'arrow') {
    const a = shapeById(drag.from)
    if (a) {
      const A = centerPx(a)
      parts.push(`<line x1="${A.x}" y1="${A.y}" x2="${drag.b.x * W}" y2="${drag.b.y * H}" stroke="var(--acc)" stroke-dasharray="4 3" marker-end="url(#bdArrow)" vector-effect="non-scaling-stroke"/>`)
    }
  }
  root.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.scale})`)
  root.innerHTML = parts.join('')
}

function openEditor(shape) {
  closeEditor()
  const wrap = svg.parentElement
  const left = shape.x * W * view.scale + view.tx
  const top = shape.y * H * view.scale + view.ty
  const width = Math.max(120, Math.abs(shape.w) * W * view.scale)
  const ta = document.createElement('textarea')
  ta.className = 'bd-textarea'
  ta.value = shape.text || ''
  ta.style.left = left + 'px'
  ta.style.top = top + 'px'
  ta.style.width = width + 'px'
  const commit = () => { if (!editor) return; shape.text = ta.value.trim(); closeEditor(); render(); scheduleSave() }
  const cancel = () => closeEditor()
  ta.addEventListener('blur', commit)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
    e.stopPropagation()
  })
  wrap.appendChild(ta)
  editor = ta
  setTimeout(() => { ta.focus(); ta.select() }, 0)
}

function closeEditor() {
  if (editor) { const el = editor; editor = null; el.remove() }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(doSave, 700)
}

async function doSave() {
  if (!taskId) return
  try { await store('settings.set', { key: 'session:canvas:' + taskId, value: JSON.stringify(data) }) } catch {}
  updateBadge()
}

function updateBadge() {
  const b = $('#boardBadge')
  if (!b) return
  const hasContent = (data.shapes && data.shapes.length) || (data.edges && data.edges.length)
  const dirty = hasContent && JSON.stringify(data) !== sentHash
  b.classList.toggle('hidden', !dirty)
}

function parseCanvas(raw) {
  if (!raw) return { v: 2, shapes: [], edges: [] }
  let d = null
  try { d = JSON.parse(raw) } catch { return { v: 2, shapes: [], edges: [] } }
  if (d && Array.isArray(d.shapes)) return { v: 2, shapes: d.shapes, edges: Array.isArray(d.edges) ? d.edges : [] }
  if (d && Array.isArray(d.strokes)) {
    const shapes = d.strokes.map((st) => ({ id: uid(), type: 'pen', x: 0, y: 0, w: 0, h: 0, points: (st.pts || []).map(([x, y]) => [x, y]), color: st.color || '#7dd3fc' }))
    return { v: 2, shapes, edges: [] }
  }
  return { v: 2, shapes: [], edges: [] }
}

export async function renderBoard(id) {
  taskId = id
  sel = new Set(); drag = null; closeEditor()
  if (!inited) initBoard()
  const bt = $('#bdTitle')
  if (bt) bt.textContent = taskNameOf(id) || '画板'
  if (!id) { data = { v: 2, shapes: [], edges: [] }; sentHash = ''; render(); updateBadge(); return }
  let raw = ''
  try { raw = await store('settings.get', { key: 'session:canvas:' + id, dflt: '' }) } catch {}
  data = parseCanvas(raw)
  try { sentHash = await store('settings.get', { key: 'session:canvasSent:' + id, dflt: '' }) } catch { sentHash = '' }
  if (taskId !== id) return
  view = { scale: 1, tx: 0, ty: 0 }
  render(); updateBadge()
}
