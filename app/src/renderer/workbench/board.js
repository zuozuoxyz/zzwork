// 画板：结构化白板（矩形/圆角/椭圆/菱形/文本/便签/箭头/画笔），SVG 编辑，v2 JSON 自动保存
// 交互对齐飞书白板：悬停图形出现连接锚点，直接从锚点拖到另一个图形连线；双击图形编辑文字；
// 连线自动直角路由、端点可拖动改接；左侧竖向工具栏 + 选中后浮动工具条（改色/复制/置顶/删除）。
import { store, dialog } from '../lib/api.js'
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
  ['note', 'sticky-note', '便签']
]
const COLORS = ['#3994bc', '#3fb950', '#d29922', '#f85149', '#a371f7', '#8b949e']
const MIN_SIZE = 0.02
const MIN_PX = 0.02
const STUB = 20              // 连线直角出口的短直线长度（画布像素）
const SNAP_SCREEN = 26       // 连线释放吸附容差（屏幕像素）
const EDGE_HIT_SCREEN = 8    // 连线命中容差（屏幕像素）
const ANCHOR_HIT_SCREEN = 11 // 锚点命中半径（屏幕像素）
const HANDLE_HIT_SCREEN = 7
const HANDLE_SIZE = 7         // 缩放手柄绘制尺寸（画布像素）

let inited = false
let host = null, svg = null, root = null
let taskId = null
let data = { v: 2, shapes: [], edges: [] }
let tool = 'select'
let sel = new Set()        // 选中的图形 id
let selEdges = new Set()   // 选中的连线 id
let view = { scale: 1, tx: 0, ty: 0 }
let W = 640, H = 420
let drag = null
let sentHash = ''
let saveTimer = null
let editor = null
let editorCommit = null
let space = false
let seq = 0
let hoverId = null
let hoverAnchor = null     // { id, side } 悬停时高亮的锚点

const uid = () => 'b' + (++seq).toString(36) + '-' + Math.random().toString(36).slice(2, 6)
const shapeById = (id) => data.shapes.find((s) => s.id === id) || null
const edgeById = (id) => data.edges.find((e) => e.id === id) || null
function taskNameOf(id) {
  const t = id ? state.tasks.find((x) => x.id === id) : null
  return t ? t.name : ''
}
const tolScreen = (s) => s / (view.scale || 1)
function tint(hex, a) {
  const h = String(hex).replace('#', '')
  if (h.length < 6) return 'rgba(56,139,253,' + a + ')'
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${a})`
}

export function initBoard() {
  if (inited) return
  host = $('#boardHost')
  if (!host) return
  inited = true
  const toolBtns = TOOLS.map(([t, icon, label]) =>
    `<button class="ib${t === 'select' ? ' on' : ''}" data-tool="${t}" title="${label}">${ic(icon, 16)}</button>`).join('')
  host.innerHTML =
    `<div class="bd-canvas">` +
    `<svg class="bd-svg" id="bdSvg"><g id="bdRoot"></g></svg>` +
    `<div class="bd-empty" id="bdEmpty">拖拽图形边上的蓝点即可连线 · 双击图形输入文字 · 滚轮缩放 · 空格拖动平移 · 选中后可拖角缩放，或用上方工具条改颜色</div>` +
    `<div class="bd-titlechip" id="bdTitle">画板</div>` +
    `<div class="bd-rail"><div class="bd-tools">${toolBtns}</div></div>` +
    `<div class="bd-zoom">` +
    `<button class="ib" id="bdFit" title="适应画板">${ic('maximize', 14)}</button>` +
    `<button class="ib" id="bdFullscreen" title="全屏">${ic('maximize-2', 14)}</button>` +
    `<button class="ib danger" id="bdClear" title="清空画板">${ic('trash-2', 14)}</button>` +
    `</div>` +
    `<div class="bd-float hidden" id="bdFloat"></div>` +
    `</div>` +
    `<div class="fm-input bd-input"><input id="bdAsk" placeholder="补充描述，和画板一起发给 AI…" spellcheck="false"><button class="ib on" id="bdSend" title="连同画板一起发送给 AI">${ic('send', 14)}</button></div>`
  refreshIcons()
  svg = $('#bdSvg')
  root = $('#bdRoot')

  host.querySelectorAll('.bd-tools [data-tool]').forEach((b) => {
    b.addEventListener('click', () => setTool(b.getAttribute('data-tool')))
  })
  $('#bdFit').addEventListener('click', fitView)
  setupFullscreen(host, $('#bdFullscreen'), () => fitView())
  $('#bdClear').addEventListener('click', async () => {
    if (!taskId) return
    const empty = !(data.shapes && data.shapes.length) && !(data.edges && data.edges.length)
    if (!empty) {
      const ok = await dialog('confirm', { message: '清空整个画板？', detail: '画板上的所有图形与连线都会被清除，且不可撤销。' })
      if (!ok) return
    }
    closeEditor()
    data = { v: 2, shapes: [], edges: [] }
    sel = new Set(); selEdges = new Set(); hoverId = null; hoverAnchor = null
    view = { scale: 1, tx: 0, ty: 0 }
    render(); scheduleSave()
  })
  const bdSend = $('#bdSend')
  if (bdSend) bdSend.addEventListener('click', sendBoardAsk)
  const bdAsk = $('#bdAsk')
  if (bdAsk) bdAsk.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendBoardAsk() }
  })
  $('#bdFloat').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]')
    if (b) doFloatAct(b.getAttribute('data-act'), b)
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
  svg.addEventListener('pointerleave', () => { if (!drag && (hoverId || hoverAnchor)) { hoverId = null; hoverAnchor = null; render() } })
  svg.addEventListener('wheel', onWheel, { passive: false })
  svg.addEventListener('dblclick', (e) => {
    if (tool !== 'select') return
    const p = pointerPx(e)
    const hit = shapeAtPx(p.x, p.y)
    if (hit && hit.type !== 'pen') { openEditor(hit); return }
    const eg = edgeAtPx(p.x, p.y)
    if (eg) openEdgeLabel(eg)
  })
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
}

function setTool(t) {
  tool = t
  host.querySelectorAll('.bd-tools [data-tool]').forEach((x) => x.classList.toggle('on', x.getAttribute('data-tool') === tool))
  if (tool !== 'select' && tool !== 'arrow') { hoverId = null; hoverAnchor = null }
  updateCursor()
  render()
}

function updateCursor() {
  if (!svg) return
  if (space) { svg.style.cursor = 'grab'; return }
  svg.style.cursor = tool === 'select' ? 'default' : 'crosshair'
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
  if (e.code === 'Space') { space = true; updateCursor(); e.preventDefault(); return }
  if (e.key === 'Escape') {
    if (drag) { drag = null; render() }
    else if (sel.size || selEdges.size) { sel = new Set(); selEdges = new Set(); render() }
    else if (tool !== 'select') setTool('select')
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && (sel.size || selEdges.size)) { deleteSelected(); e.preventDefault(); return }
  if ((e.key === 'Enter' || e.key === 'F2') && sel.size === 1 && !selEdges.size) {
    const s = shapeById([...sel][0])
    if (s && s.type !== 'pen') { e.preventDefault(); openEditor(s); return }
  }
  // 选中单个图形后直接键入即可编辑文字（Excalidraw 习惯，保留）
  if (sel.size === 1 && !selEdges.size && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const s = shapeById([...sel][0])
    if (s && s.type !== 'pen') { e.preventDefault(); openEditor(s, e.key); return }
  }
}
function onKeyUp(e) { if (e.code === 'Space') { space = false; updateCursor() } }

// ---------- 坐标 ----------
function pointerPx(e) {
  const r = svg.getBoundingClientRect()
  return { x: (e.clientX - r.left - view.tx) / view.scale, y: (e.clientY - r.top - view.ty) / view.scale }
}
function px(s) {
  const w = Math.abs(s.w) * W, h = Math.abs(s.h) * H
  return { x: Math.min(s.x, s.x + s.w) * W, y: Math.min(s.y, s.y + s.h) * H, w, h }
}
function centerPx(s) { const q = px(s); return { x: q.x + q.w / 2, y: q.y + q.h / 2 } }
function shapePxBox(s) { const q = px(s); return { x1: q.x, y1: q.y, x2: q.x + q.w, y2: q.y + q.h } }

function sideAnchor(q, side) {
  switch (side) {
    case 't': return { x: q.x + q.w / 2, y: q.y }
    case 'b': return { x: q.x + q.w / 2, y: q.y + q.h }
    case 'l': return { x: q.x, y: q.y + q.h / 2 }
    case 'r': return { x: q.x + q.w, y: q.y + q.h / 2 }
    default: return { x: q.x + q.w / 2, y: q.y + q.h / 2 }
  }
}
function sideDir(side) {
  switch (side) {
    case 'r': return [1, 0]
    case 'l': return [-1, 0]
    case 't': return [0, -1]
    case 'b': return [0, 1]
    default: return [0, 0]
  }
}
function nearestSide(s, target) {
  const c = centerPx(s)
  const dx = target.x - c.x, dy = target.y - c.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'r' : 'l'
  return dy >= 0 ? 'b' : 't'
}

function distSeg(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  if (!l2) return Math.hypot(x - x1, y - y1)
  let t = ((x - x1) * dx + (y - y1) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

// 连线几何：八字直角路由（带出口短直线），返回端点与折线点集
function edgeSides(e) {
  const a = shapeById(e.from), b = shapeById(e.to)
  if (!a || !b) return null
  const fs = e.fromSide || nearestSide(a, centerPx(b))
  const ts = e.toSide || nearestSide(b, centerPx(a))
  return { a, b, fs, ts }
}
function buildEdgePts(a, fs, b, ts) {
  const A = sideAnchor(px(a), fs), B = sideAnchor(px(b), ts)
  const [ax, ay] = sideDir(fs), [bx, by] = sideDir(ts)
  const A2 = { x: A.x + ax * STUB, y: A.y + ay * STUB }
  const B2 = { x: B.x + bx * STUB, y: B.y + by * STUB }
  const pts = [A]
  const hf = fs === 'l' || fs === 'r', ht = ts === 'l' || ts === 'r'
  if (hf && ht) {
    const mx = (A2.x + B2.x) / 2
    pts.push(A2, { x: mx, y: A2.y }, { x: mx, y: B2.y }, B2)
  } else if (!hf && !ht) {
    const my = (A2.y + B2.y) / 2
    pts.push(A2, { x: A2.x, y: my }, { x: B2.x, y: my }, B2)
  } else if (hf && !ht) {
    pts.push(A2, { x: B2.x, y: A2.y }, B2)
  } else {
    pts.push(A2, { x: A2.x, y: B2.y }, B2)
  }
  pts.push(B)
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i], q = out[out.length - 1]
    if (Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5) out.push(p)
  }
  return { A, B, pts: out }
}
function edgeGeom(e) {
  const g = edgeSides(e)
  if (!g) return null
  return buildEdgePts(g.a, g.fs, g.b, g.ts)
}
function edgePathD(pts) { return 'M' + pts.map((p) => `${p.x} ${p.y}`).join(' L ') }

function shapeAtPx(x, y) {
  for (let i = data.shapes.length - 1; i >= 0; i--) {
    const s = data.shapes[i]
    if (s.type === 'pen') {
      const pts = s.points || []
      if (pts.some(([nx, ny]) => Math.hypot(nx * W - x, ny * H - y) < tolScreen(6))) return s
      continue
    }
    const b = shapePxBox(s)
    if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) return s
  }
  return null
}

function edgeAtPx(x, y) {
  for (let i = data.edges.length - 1; i >= 0; i--) {
    const g = edgeGeom(data.edges[i])
    if (!g) continue
    for (let j = 1; j < g.pts.length; j++) {
      const a = g.pts[j - 1], b = g.pts[j]
      if (distSeg(x, y, a.x, a.y, b.x, b.y) <= tolScreen(EDGE_HIT_SCREEN)) return data.edges[i]
    }
  }
  return null
}

// 悬停时命中的连接锚点（边中点），用于「悬停→拖拽连线」
function anchorForPoint(x, y) {
  const tol = tolScreen(ANCHOR_HIT_SCREEN)
  for (let i = data.shapes.length - 1; i >= 0; i--) {
    const s = data.shapes[i]
    if (s.type === 'pen') continue
    const q = px(s)
    for (const side of ['t', 'r', 'b', 'l']) {
      const a = sideAnchor(q, side)
      if (Math.hypot(a.x - x, a.y - y) <= tol) return { id: s.id, side }
    }
  }
  return null
}

function nearestShapePx(x, y, excludeIds) {
  let best = null, bd = tolScreen(SNAP_SCREEN)
  for (const s of data.shapes) {
    if (excludeIds && excludeIds.has(s.id)) continue
    if (s.type === 'pen') continue
    const b = shapePxBox(s)
    const dx = Math.max(b.x1 - x, 0, x - b.x2)
    const dy = Math.max(b.y1 - y, 0, y - b.y2)
    const d = Math.hypot(dx, dy)
    if (d <= bd) { bd = d; best = s }
  }
  return best
}

function handleAt(s, x, y) {
  const q = px(s)
  const corners = [['nw', q.x, q.y], ['ne', q.x + q.w, q.y], ['se', q.x + q.w, q.y + q.h], ['sw', q.x, q.y + q.h]]
  const tol = tolScreen(HANDLE_HIT_SCREEN)
  for (const [name, hx, hy] of corners) if (Math.hypot(hx - x, hy - y) <= tol) return name
  return null
}

// 选中连线的端点手柄命中
function edgeHandleAt(x, y) {
  if (selEdges.size !== 1) return null
  const e = edgeById([...selEdges][0])
  const g = e && edgeGeom(e)
  if (!g) return null
  const tol = tolScreen(HANDLE_HIT_SCREEN + 3)
  if (Math.hypot(g.A.x - x, g.A.y - y) <= tol) return { id: e.id, which: 'from' }
  if (Math.hypot(g.B.x - x, g.B.y - y) <= tol) return { id: e.id, which: 'to' }
  return null
}

// ---------- 指针交互 ----------
function onPointerDown(e) {
  if (!taskId) return
  flushEditor()
  if (e.button === 1 || space) {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty }
    if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId)
    return
  }
  if (e.button !== 0) return
  const p = pointerPx(e)

  if (tool === 'select') {
    // 1) 选中连线端点：拖动改接
    const eh = edgeHandleAt(p.x, p.y)
    if (eh) {
      const e2 = edgeById(eh.id)
      const other = eh.which === 'from' ? e2.to : e2.from
      drag = { mode: 'edge-end', id: eh.id, which: eh.which, other, cand: null }
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId)
      return
    }
    // 2) 悬停到连接锚点：直接拖出连线（无需切换工具）
    const anc = anchorForPoint(p.x, p.y)
    if (anc) {
      drag = { mode: 'arrow', from: anc.id, fromSide: anc.side, to: null, toSide: null, b: { x: p.x, y: p.y } }
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId)
      return
    }
    // 3) 缩放手柄（单选）
    if (sel.size === 1 && !selEdges.size) {
      const s = shapeById([...sel][0])
      if (s && s.type !== 'pen') {
        const h = handleAt(s, p.x, p.y)
        if (h) {
          drag = { mode: 'resize', id: s.id, handle: h, orig: { x: s.x, y: s.y, w: s.w, h: s.h } }
          if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId)
          return
        }
      }
    }
    // 4) 命中图形：选择/移动
    const hit = shapeAtPx(p.x, p.y)
    if (hit) {
      if (e.shiftKey) { sel.has(hit.id) ? sel.delete(hit.id) : sel.add(hit.id); selEdges.clear() }
      else if (!sel.has(hit.id)) { sel = new Set([hit.id]); selEdges.clear() }
      drag = {
        mode: 'move', startPx: { x: p.x, y: p.y },
        orig: data.shapes.filter((s) => sel.has(s.id)).map((s) => ({ id: s.id, x: s.x, y: s.y }))
      }
      if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId)
      render(); return
    }
    // 5) 命中连线：选择
    const eg = edgeAtPx(p.x, p.y)
    if (eg) {
      if (e.shiftKey && selEdges.has(eg.id)) selEdges.delete(eg.id)
      else { selEdges = new Set([eg.id]); if (!e.shiftKey) sel = new Set() }
      render(); return
    }
    // 6) 空白处：框选
    if (!e.shiftKey) { sel = new Set(); selEdges = new Set() }
    drag = { mode: 'marquee', a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y } }
    if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId)
    render(); return
  }

  if (tool === 'arrow') {
    const hit = shapeAtPx(p.x, p.y)
    if (!hit || hit.type === 'pen') return
    drag = { mode: 'arrow', from: hit.id, fromSide: nearestSide(hit, p), to: null, toSide: null, b: { x: p.x, y: p.y } }
    if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId)
    render(); return
  }

  if (tool === 'pen') {
    const n = { x: p.x / W, y: p.y / H }
    const s = { id: uid(), type: 'pen', x: 0, y: 0, w: 0, h: 0, points: [[n.x, n.y]], color: '#7dd3fc' }
    data.shapes.push(s)
    drag = { mode: 'pen', shape: s }
    if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId)
    render(); return
  }

  // 新建图形（rect/roundRect/ellipse/diamond/text/note）
  const n = { x: p.x / W, y: p.y / H }
  const s = { id: uid(), type: tool, x: n.x, y: n.y, w: 0, h: 0, text: '' }
  data.shapes.push(s)
  drag = { mode: 'create', shape: s, start: n }
  if (svg.setPointerCapture) svg.setPointerCapture(e.pointerId)
  render()
}

function onPointerMove(e) {
  const p = pointerPx(e)
  if (!drag) {
    if (tool === 'select' || tool === 'arrow') {
      const anc = tool === 'select' ? anchorForPoint(p.x, p.y) : null
      const hit = shapeAtPx(p.x, p.y)
      const nid = hit && hit.type !== 'pen' ? hit.id : null
      const na = anc || null
      const changed = nid !== hoverId ||
        (na && na.id) !== (hoverAnchor && hoverAnchor.id) ||
        (na && na.side) !== (hoverAnchor && hoverAnchor.side)
      if (changed) { hoverId = na ? na.id : nid; hoverAnchor = na; render() }
      svg.style.cursor = anc ? 'crosshair' : (nid ? 'move' : 'default')
    }
    return
  }
  if (drag.mode === 'pan') { view.tx = drag.tx + (e.clientX - drag.sx); view.ty = drag.ty + (e.clientY - drag.sy); render(); return }

  const n = { x: p.x / W, y: p.y / H }
  if (drag.mode === 'move') {
    const dx = (p.x - drag.startPx.x) / W, dy = (p.y - drag.startPx.y) / H
    for (const o of drag.orig) { const s = shapeById(o.id); if (s) { s.x = o.x + dx; s.y = o.y + dy } }
    render(); return
  }
  if (drag.mode === 'resize') {
    const o = drag.orig, h = drag.handle
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h
    if (h.includes('w')) x1 = n.x
    if (h.includes('e')) x2 = n.x
    if (h.includes('n')) y1 = n.y
    if (h.includes('s')) y2 = n.y
    const s = shapeById(drag.id)
    if (s) { s.x = Math.min(x1, x2); s.y = Math.min(y1, y2); s.w = Math.max(MIN_PX, Math.abs(x2 - x1)); s.h = Math.max(MIN_PX, Math.abs(y2 - y1)) }
    render(); return
  }
  if (drag.mode === 'marquee') { drag.b = { x: p.x, y: p.y }; render(); return }
  if (drag.mode === 'arrow') {
    drag.b = { x: p.x, y: p.y }
    const hit = shapeAtPx(p.x, p.y)
    const over = hit && hit.id !== drag.from && hit.type !== 'pen' ? hit : null
    drag.to = over ? over.id : null
    drag.toSide = over ? nearestSide(over, p) : null
    render(); return
  }
  if (drag.mode === 'edge-end') {
    const hit = shapeAtPx(p.x, p.y)
    const over = hit && hit.id !== drag.other && hit.type !== 'pen' ? hit : null
    drag.cand = over ? { id: over.id, side: nearestSide(over, p) } : null
    render(); return
  }
  if (drag.mode === 'pen') { drag.shape.points.push([n.x, n.y]); render(); return }
  if (drag.mode === 'create') {
    const s = drag.shape, a = drag.start
    s.x = Math.min(a.x, n.x); s.y = Math.min(a.y, n.y)
    s.w = Math.abs(n.x - a.x); s.h = Math.abs(n.y - a.y)
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
      const b = shapePxBox(s)
      if (b.x2 >= x1 && b.x1 <= x2 && b.y2 >= y1 && b.y1 <= y2) sel.add(s.id)
    }
    selEdges = new Set()
  } else if (d.mode === 'create') {
    const s = d.shape
    if (s.type === 'text') {
      if (s.w < MIN_SIZE || s.h < MIN_SIZE) { s.w = 0.16; s.h = 0.06 }
      sel = new Set([s.id]); selEdges = new Set()
      scheduleSave(); render(); openEditor(s)
      return
    }
    if (s.w < MIN_SIZE && s.h < MIN_SIZE) { s.w = s.type === 'note' ? 0.2 : 0.16; s.h = 0.12 }
    sel = new Set([s.id]); selEdges = new Set()
    scheduleSave()
  } else if (d.mode === 'pen') {
    if ((d.shape.points || []).length < 2) data.shapes = data.shapes.filter((x) => x !== d.shape)
    scheduleSave()
  } else if (d.mode === 'arrow') {
    let target = d.to, toSide = d.toSide
    if (!target) { const near = nearestShapePx(d.b.x, d.b.y, new Set([d.from])); if (near) { target = near.id; toSide = nearestSide(near, d.b) } }
    if (target && target !== d.from && !data.edges.some((x) => x.from === d.from && x.to === target)) {
      data.edges.push({ id: uid(), from: d.from, to: target, fromSide: d.fromSide, toSide: toSide })
    }
    scheduleSave()
  } else if (d.mode === 'edge-end') {
    const e2 = edgeById(d.id)
    if (e2 && d.cand && d.cand.id !== d.other) {
      if (d.which === 'from') { e2.from = d.cand.id; e2.fromSide = d.cand.side }
      else { e2.to = d.cand.id; e2.toSide = d.cand.side }
      scheduleSave()
    }
  } else if (d.mode === 'move' || d.mode === 'resize') {
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
  if (sel.size) {
    data.shapes = data.shapes.filter((s) => !sel.has(s.id))
    data.edges = data.edges.filter((e) => !sel.has(e.from) && !sel.has(e.to))
  }
  if (selEdges.size) data.edges = data.edges.filter((e) => !selEdges.has(e.id))
  sel = new Set(); selEdges = new Set(); hoverId = null; hoverAnchor = null
  render(); scheduleSave()
}

function duplicateSelected() {
  const map = {}, add = []
  for (const s of data.shapes) {
    if (!sel.has(s.id)) continue
    const ns = { ...s, id: uid(), x: s.x + 0.03, y: s.y + 0.03 }
    if (s.points) ns.points = s.points.map(([a, b]) => [a + 0.03, b + 0.03])
    map[s.id] = ns.id; add.push(ns)
  }
  data.shapes.push(...add)
  for (const e of data.edges) if (map[e.from] && map[e.to]) data.edges.push({ ...e, id: uid(), from: map[e.from], to: map[e.to] })
  sel = new Set(add.map((s) => s.id)); selEdges = new Set()
  render(); scheduleSave()
}

function bringToFront() {
  const picked = data.shapes.filter((s) => sel.has(s.id))
  data.shapes = data.shapes.filter((s) => !sel.has(s.id)).concat(picked)
  render(); scheduleSave()
}

function doFloatAct(act, btn) {
  if (act === 'color') {
    const c = btn.getAttribute('data-c')
    for (const id of sel) { const s = shapeById(id); if (s) s.color = c }
    render(); scheduleSave()
  } else if (act === 'edit') {
    if (sel.size === 1) { const s = shapeById([...sel][0]); if (s) openEditor(s) }
  } else if (act === 'copy') {
    duplicateSelected()
  } else if (act === 'front') {
    bringToFront()
  } else if (act === 'del') {
    deleteSelected()
  } else if (act === 'label') {
    if (selEdges.size === 1) { const e = edgeById([...selEdges][0]); if (e) openEdgeLabel(e) }
  }
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

// ---------- 渲染 ----------
function shapeSvg(s) {
  const q = px(s)
  const isSel = sel.has(s.id)
  const col = s.color || null
  const stroke = isSel ? 'var(--accent)' : (col || (s.type === 'note' ? 'rgba(250,204,21,.45)' : '#3b434d'))
  const sw = isSel ? 2 : 1.2
  const fill = s.type === 'text' ? 'transparent' : (col ? tint(col, 0.14) : (s.type === 'note' ? 'rgba(250,204,21,.14)' : 'rgba(56,139,253,.10)'))
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
    case 'note':
      return `<rect class="bd-shape" x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" rx="5" ${common}/>` + label()
    case 'pen': {
      const pts = (s.points || []).map(([nx, ny]) => `${nx * W},${ny * H}`).join(' ')
      return `<polyline class="bd-pen" points="${pts}" fill="none" stroke="${isSel ? 'var(--accent)' : (s.color || '#7dd3fc')}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`
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
    const g = edgeGeom(e)
    if (!g) continue
    const active = selEdges.has(e.id)
    const hl = active || sel.has(e.from) || sel.has(e.to)
    const color = active ? 'var(--accent)' : (hl ? '#9aa4b0' : '#8b949e')
    parts.push(`<path class="bd-edge${active ? ' edsel' : hl ? ' hl' : ''}" d="${edgePathD(g.pts)}" fill="none" stroke="${color}" stroke-width="${active ? 2.2 : 1.6}" marker-end="url(#bdArrow)" vector-effect="non-scaling-stroke"/>`)
    if (e.label) {
      const m = g.pts[Math.floor(g.pts.length / 2)]
      parts.push(`<foreignObject x="${m.x - 60}" y="${m.y - 11}" width="120" height="22"><div xmlns="http://www.w3.org/1999/xhtml" class="bd-elabel">${esc(e.label)}</div></foreignObject>`)
    }
  }

  for (const s of data.shapes) parts.push(shapeSvg(s))

  // 悬停锚点：选择/箭头工具下，悬停图形展示四边连接点，光标附近的那个高亮
  if (hoverId && (tool === 'select' || tool === 'arrow') && !drag) {
    const s = shapeById(hoverId)
    if (s && s.type !== 'pen') {
      const q = px(s)
      for (const side of ['t', 'r', 'b', 'l']) {
        const a = sideAnchor(q, side)
        const act = hoverAnchor && hoverAnchor.id === s.id && hoverAnchor.side === side
        parts.push(`<circle class="bd-anchor${act ? ' act' : ''}" cx="${a.x}" cy="${a.y}" r="${act ? 6 : 4}"/>`)
      }
    }
  }

  // 选中单个图形：四角缩放手柄
  if (sel.size === 1 && !selEdges.size) {
    const s = shapeById([...sel][0])
    if (s && s.type !== 'pen') {
      const q = px(s), h = HANDLE_SIZE
      for (const [cx, cy] of [[q.x, q.y], [q.x + q.w, q.y], [q.x + q.w, q.y + q.h], [q.x, q.y + q.h]]) {
        parts.push(`<rect class="bd-handle" x="${cx - h / 2}" y="${cy - h / 2}" width="${h}" height="${h}" rx="1.5"/>`)
      }
    }
  }

  // 选中连线：两端可拖动改接的手柄
  if (selEdges.size === 1) {
    const e = edgeById([...selEdges][0])
    const g = e && edgeGeom(e)
    if (g) for (const p of [g.A, g.B]) parts.push(`<circle class="bd-ehandle" cx="${p.x}" cy="${p.y}" r="5"/>`)
  }

  if (drag && drag.mode === 'marquee') {
    const x = Math.min(drag.a.x, drag.b.x), y = Math.min(drag.a.y, drag.b.y)
    const w = Math.abs(drag.a.x - drag.b.x), h = Math.abs(drag.a.y - drag.b.y)
    parts.push(`<rect class="bd-marquee" x="${x}" y="${y}" width="${w}" height="${h}" vector-effect="non-scaling-stroke"/>`)
  }
  if (drag && drag.mode === 'arrow') {
    const a = shapeById(drag.from)
    if (a) {
      const A = sideAnchor(px(a), drag.fromSide || 'r')
      let B = { x: drag.b.x, y: drag.b.y }
      if (drag.to) { const t = shapeById(drag.to); if (t) B = sideAnchor(px(t), drag.toSide || 'l') }
      parts.push(`<line class="bd-arrow-preview" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}" marker-end="url(#bdArrow)" vector-effect="non-scaling-stroke"/>`)
      if (drag.to) { const t = shapeById(drag.to); if (t) { const q = px(t); parts.push(`<rect x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" fill="none" stroke="var(--accent)" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`) } }
    }
  }
  if (drag && drag.mode === 'edge-end' && drag.cand) {
    const s = shapeById(drag.cand.id)
    if (s) { const q = px(s); parts.push(`<rect x="${q.x}" y="${q.y}" width="${q.w}" height="${q.h}" fill="none" stroke="var(--accent)" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`) }
  }

  root.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.scale})`)
  root.innerHTML = parts.join('')
  updateFloat()
}

// 选中浮动工具条
function selectionBBox() {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, any = false
  if (sel.size) {
    for (const id of sel) {
      const s = shapeById(id); if (!s) continue
      const q = px(s)
      x1 = Math.min(x1, q.x); y1 = Math.min(y1, q.y); x2 = Math.max(x2, q.x + q.w); y2 = Math.max(y2, q.y + q.h); any = true
    }
  } else if (selEdges.size === 1) {
    const g = edgeGeom(edgeById([...selEdges][0]))
    if (g) { for (const p of g.pts) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y) } any = true }
  }
  return any ? { x1, y1, x2, y2 } : null
}

function updateFloat() {
  const el = $('#bdFloat')
  if (!el) return
  const bb = selectionBBox()
  if (!bb) { el.classList.add('hidden'); return }
  let html = ''
  if (sel.size) {
    html += `<div class="bd-sw">${COLORS.map((c) => `<button class="bd-dot" data-act="color" data-c="${c}" style="background:${c}"></button>`).join('')}</div>`
    if (sel.size === 1) { const s = shapeById([...sel][0]); if (s && s.type !== 'pen') html += `<button class="ib" data-act="edit" title="编辑文字">${ic('type', 13)}</button>` }
    html += `<button class="ib" data-act="copy" title="复制">${ic('copy', 13)}</button>`
    html += `<button class="ib" data-act="front" title="置顶">${ic('arrow-up', 13)}</button>`
    html += `<button class="ib danger" data-act="del" title="删除">${ic('trash-2', 13)}</button>`
  } else if (selEdges.size) {
    if (selEdges.size === 1) html += `<button class="ib" data-act="label" title="连线标签">${ic('type', 13)}</button>`
    html += `<button class="ib danger" data-act="del" title="删除连线">${ic('trash-2', 13)}</button>`
  }
  if (el.__sig !== html) { el.innerHTML = html; el.__sig = html; refreshIcons() }
  const cx = (bb.x1 + bb.x2) / 2 * view.scale + view.tx
  const top = bb.y1 * view.scale + view.ty - 44
  el.classList.remove('hidden')
  el.style.left = Math.max(70, cx) + 'px'
  el.style.top = Math.max(8, top) + 'px'
}

// ---------- 文字编辑 ----------
function mountOverlay({ left, top, width, height, value, multiline, onCommit }) {
  closeEditor()
  const wrap = svg.parentElement
  const ta = document.createElement('textarea')
  ta.className = 'bd-textarea' + (multiline ? ' ml' : '')
  ta.value = value || ''
  ta.style.left = left + 'px'
  ta.style.top = top + 'px'
  ta.style.width = width + 'px'
  if (height) ta.style.height = height + 'px'
  let done = false
  const commit = () => { if (done) return; done = true; const v = ta.value; closeEditor(); onCommit(v) }
  const cancel = () => { if (done) return; done = true; closeEditor() }
  ta.addEventListener('blur', commit)
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
    else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); commit() }
  })
  wrap.appendChild(ta)
  editor = ta
  editorCommit = commit
  setTimeout(() => { ta.focus(); ta.select() }, 0)
}

function openEditor(shape, seed) {
  const left = shape.x * W * view.scale + view.tx
  const top = shape.y * H * view.scale + view.ty
  const width = Math.max(90, Math.abs(shape.w) * W * view.scale)
  const height = Math.max(34, Math.abs(shape.h) * H * view.scale)
  mountOverlay({
    left, top, width, height,
    value: seed != null ? seed : (shape.text || ''),
    multiline: true,
    onCommit: (v) => {
      const t = v.replace(/[ \t]+$/gm, '')
      if (shape.type === 'text' && !t.trim()) {
        data.shapes = data.shapes.filter((x) => x.id !== shape.id)
        data.edges = data.edges.filter((e) => e.from !== shape.id && e.to !== shape.id)
        sel.delete(shape.id)
      } else {
        shape.text = t
      }
      render(); scheduleSave()
    }
  })
}

function openEdgeLabel(edge) {
  const g = edgeGeom(edge)
  if (!g) return
  const m = g.pts[Math.floor(g.pts.length / 2)]
  mountOverlay({
    left: m.x * view.scale + view.tx - 60, top: m.y * view.scale + view.ty - 14, width: 120, multiline: false,
    value: edge.label || '',
    onCommit: (v) => { const t = v.trim(); if (t) edge.label = t; else delete edge.label; render(); scheduleSave() }
  })
}

function closeEditor() {
  if (editor) { const el = editor; editor = null; editorCommit = null; el.remove() }
}
// 提交当前正在编辑的文字（点击空白/切换前调用，避免误丢内容）
function flushEditor() {
  if (editorCommit) { const c = editorCommit; editorCommit = null; c() }
}

// ---------- 保存 ----------
function scheduleSave() {
  clearTimeout(saveTimer)
  const forId = taskId
  saveTimer = setTimeout(() => doSave(forId), 700)
}

async function doSave(forId) {
  const id = forId || taskId
  if (!id) return
  try { await store('settings.set', { key: 'session:canvas:' + id, value: JSON.stringify(data) }) } catch {}
  updateBadge()
}

function updateBadge() {
  const b = $('#boardBadge')
  if (!b) return
  const hasContent = (data.shapes && data.shapes.length) || (data.edges && data.edges.length)
  const dirty = hasContent && JSON.stringify(data) !== sentHash
  b.classList.toggle('hidden', !dirty)
}

// 画板补充描述：连同当前画板内容一起发给 AI（画板摘要由主进程在发送时注入）
async function sendBoardAsk() {
  if (!taskId) return
  flushEditor()
  const el = $('#bdAsk')
  const text = (el && el.value || '').trim()
  // 先落地画板，确保主进程注入的是最新内容（否则会拿到 700ms 防抖前的旧版本）
  clearTimeout(saveTimer)
  try { await doSave(taskId) } catch {}
  sentHash = JSON.stringify(data)
  updateBadge()
  if (el) el.value = ''
  const base = '【画板】我已更新画板，请查看画板内容并据此回应或执行。'
  sendChatText(text ? base + '\n\n我的补充说明：' + text : base)
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
  flushEditor()
  const prev = taskId
  taskId = id
  if (id !== prev) { const a = $('#bdAsk'); if (a) a.value = '' }
  sel = new Set(); selEdges = new Set(); drag = null; hoverId = null; hoverAnchor = null; closeEditor()
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
