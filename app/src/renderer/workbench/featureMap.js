// 功能流程视图：两级下钻（大功能→小功能）+ 端到端流程（流程实线 / 数据流虚线 / 判断菱形）
import { featuremap } from '../lib/api.js'
import { state, on } from '../lib/state.js'
import { $, esc, ic, refreshIcons, setupFullscreen } from '../lib/ui.js'
import { toast } from '../components/toast.js'
import { prefillChat, sendChatText } from './chat.js'

const NW = 200, NH = 72, BH = 90    // 普通节点 / 含子功能的大功能
const DW = 150, DH = 96             // 判断节点（菱形）
const ACCENT = '#3994bc'
const STATUS_NAME = { todo: '待办', doing: '进行中', done: '完成' }
const TYPE = {
  frontend: { color: '#58a6ff', label: '前端' },
  backend: { color: '#3fb950', label: '后端' },
  database: { color: '#d29922', label: '数据' },
  cloud: { color: '#a371f7', label: '云服务' },
  security: { color: '#f85149', label: '安全' },
  messagebus: { color: '#db6d28', label: '消息' },
  external: { color: '#8b949e', label: '外部' },
  service: { color: '#39c5cf', label: '服务' },
  cron: { color: '#db61a2', label: '定时任务' },
  cache: { color: '#56d4dd', label: '缓存' },
  storage: { color: '#e6c07b', label: '文件存储' }
}
const typeColor = (t) => (TYPE[t] || TYPE.service).color

let inited = false
let host = null, svg = null, root = null
let taskId = null
let map = { nodes: [], edges: [] }
let byId = new Map()
let cur = { mode: 'feature', nodes: [], edges: [], byId: new Map() }   // 当前层级（功能同级 / 叶子实现逻辑）
let positions = new Map()       // nodeId -> { x, y, w, h }
let path = []                    // 下钻路径 [{ id, title, impl }]
let sel = new Set()             // 讨论多选
let focus = null                // 聚焦节点（高亮上下游）
let implLoading = null          // 正在生成实现逻辑的节点 id
let view = { scale: 1, tx: 0, ty: 0 }
let W = 640, H = 420
let drag = null

export function initFeatureMap() {
  if (inited) return
  host = $('#featureMapHost')
  if (!host) return
  inited = true
  host.innerHTML =
    `<div class="fm-toolbar">` +
    `<button class="ib hidden" id="fmBack" title="返回上一级">${ic('chevron-left', 15)}</button>` +
    `<span class="fm-title" id="fmTitle">高层功能视图</span>` +
    `<span class="sp"></span>` +
    `<button class="ib" id="fmZoomOut" title="缩小">${ic('zoom-out', 14)}</button>` +
    `<button class="ib" id="fmZoomIn" title="放大">${ic('zoom-in', 14)}</button>` +
    `<button class="ib" id="fmFit" title="适应视图">${ic('maximize', 14)}</button>` +
    `<button class="ib" id="fmFullscreen" title="全屏">${ic('maximize-2', 14)}</button>` +
    `<button class="btn sm" id="fmUpdate" title="立即更新功能流程">${ic('refresh-cw', 13)}<span>更新</span></button>` +
    `<button class="btn sm" id="fmImplAll" title="为所有叶子功能补全实现逻辑">${ic('sparkles', 13)}<span>补全全部</span></button>` +
    `<button class="btn sm" id="fmDiscuss" disabled>讨论</button>` +
    `</div>` +
    `<div class="fm-canvas"><svg class="fm-svg" id="fmSvg"><g id="fmRoot"></g></svg>` +
    `<div class="fm-loading hidden" id="fmLoading"><span class="spinner"></span><span id="fmLoadingText">正在生成实现逻辑…</span></div>` +
    `<div class="fm-empty hidden" id="fmEmpty"><div>还没有功能流程。<br>与 AI 多轮对话后会自动生成，也可以立即生成一张。</div><button class="btn sm" id="fmEmptyGen">${ic('sparkles', 13)}<span>立即生成</span></button></div>` +
    `<div class="fm-legend" id="fmLegend"></div>` +
    `<div class="fm-detail hidden" id="fmDetail"></div></div>` +
    `<div class="fm-input"><input id="fmAsk" placeholder="选择节点后可在此向 AI 提问" spellcheck="false"><button class="ib on" id="fmSend" title="发送">${ic('send', 14)}</button></div>`
  refreshIcons()
  svg = $('#fmSvg')
  root = $('#fmRoot')

  $('#fmBack').addEventListener('click', back)
  $('#fmTitle').addEventListener('click', (e) => {
    const cb = e.target.closest && e.target.closest('.cb')
    if (!cb) return
    setLevel(Number(cb.getAttribute('data-i')))
  })
  $('#fmUpdate').addEventListener('click', doUpdate)
  $('#fmImplAll').addEventListener('click', doImplAll)
  const emptyGen = $('#fmEmptyGen')
  if (emptyGen) emptyGen.addEventListener('click', doUpdate)
  $('#fmZoomIn').addEventListener('click', () => zoomBy(1.2))
  $('#fmZoomOut').addEventListener('click', () => zoomBy(1 / 1.2))
  $('#fmFit').addEventListener('click', fitView)
  setupFullscreen(host, $('#fmFullscreen'), () => fitView())
  $('#fmDiscuss').addEventListener('click', discuss)
  $('#fmSend').addEventListener('click', sendAsk)
  $('#fmAsk').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendAsk() } })

  svg.addEventListener('pointerdown', onDown)
  svg.addEventListener('pointermove', onMove)
  svg.addEventListener('pointerup', onUp)
  svg.addEventListener('pointercancel', onUp)
  svg.addEventListener('wheel', onWheel, { passive: false })
  svg.addEventListener('dblclick', (e) => {
    const v = toVirtual(e.clientX, e.clientY)
    const n = nodeAt(v.x, v.y)
    if (n) showDetail(n)
  })

  const resize = () => {
    const wrap = svg.parentElement
    if (!wrap) return
    const r = wrap.getBoundingClientRect()
    W = Math.max(60, Math.floor(r.width))
    H = Math.max(60, Math.floor(r.height))
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    if (positions && positions.size) fitView()
    else render()
  }
  new ResizeObserver(resize).observe(svg.parentElement)
  resize()

  on('featuremap-updated', ({ taskId: tid, map: m } = {}) => {
    if (state.taskId !== tid) return
    normalize(m)
    path = []
    focus = null
    resolveLayout()
  })
}

function normalize(m) {
  const o = m && typeof m === 'object' ? m : {}
  map = {
    nodes: Array.isArray(o.nodes) ? o.nodes.filter((n) => n && n.id) : [],
    edges: Array.isArray(o.edges) ? o.edges.filter((e) => e && e.from && e.to) : []
  }
  byId = new Map()
  for (const n of map.nodes) byId.set(n.id, n)
}

function taskNameOf(id) {
  const t = id ? state.tasks.find((x) => x.id === id) : null
  return t ? t.name : ''
}

function levelId() { return path.length ? path[path.length - 1].id : '' }
function inImpl() { return path.length > 0 && !!path[path.length - 1].impl }
function hasChildren(id) { return cur.mode !== 'impl' && map.nodes.some((n) => n.parent === id) }
function childCount(id) { return cur.mode === 'impl' ? 0 : map.nodes.filter((n) => n.parent === id).length }
function hasImpl(n) { return !!(n && n.impl && Array.isArray(n.impl.nodes) && n.impl.nodes.length) }
const DATA_STORE_TYPES = new Set(['database', 'cache', 'storage', 'external'])
const isDataStore = (n) => !!(n && DATA_STORE_TYPES.has(n.type))

// 依据当前下钻层级，计算画布上要渲染的节点/边（功能同级 / 叶子实现逻辑）
function recomputeLevel() {
  const last = path[path.length - 1]
  let nodes, edges
  if (last && last.impl) {
    const owner = byId.get(last.id)
    const impl = (owner && owner.impl) || { nodes: [], edges: [] }
    nodes = impl.nodes
    edges = impl.edges
  } else {
    const lv = last ? last.id : ''
    nodes = map.nodes.filter((n) => (n.parent || '') === lv)
    edges = map.edges
  }
  const bid = new Map(nodes.map((n) => [n.id, n]))
  cur = { mode: last && last.impl ? 'impl' : 'feature', nodes, edges: edges.filter((e) => bid.has(e.from) && bid.has(e.to)), byId: bid }
}

function currentNodes() { return cur.nodes }
function currentEdges() { return cur.edges }

const hasProv = (n) => (n.reads && n.reads.length) || (n.writes && n.writes.length)

function sizeOf(n) {
  if (n.kind === 'decision') return { w: DW, h: DH }
  if (hasChildren(n.id)) return { w: NW, h: BH }
  return { w: NW, h: NH + (hasProv(n) ? 20 : 0) + (hasImpl(n) ? 18 : 0) }
}

// ---------- 分层流程图布局（自上而下）----------

function layeredLayout(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n.id, []]))
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  const useEdges = edges
  for (const e of useEdges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue
    adj.get(e.from).push(e.to)
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1)
  }

  // Kahn 拓扑定序（环上结点追加到末尾）
  const order = []
  const deg = new Map(indeg)
  const queue = nodes.filter((n) => (deg.get(n.id) || 0) === 0).map((n) => n.id)
  while (queue.length) {
    const u = queue.shift()
    order.push(u)
    for (const v of adj.get(u) || []) {
      deg.set(v, (deg.get(v) || 0) - 1)
      if ((deg.get(v) || 0) === 0) queue.push(v)
    }
  }
  const placed = new Set(order)
  for (const n of nodes) if (!placed.has(n.id)) order.push(n.id)
  const rank = new Map(order.map((id, i) => [id, i]))
  const forward = (u, v) => (rank.get(u) ?? 0) < (rank.get(v) ?? 0)  // 回边（环）不参与分层，避免源点被顶到下层

  // 最长路径分层
  const layer = new Map(nodes.map((n) => [n.id, 0]))
  for (const id of order) {
    const l = layer.get(id) || 0
    for (const v of adj.get(id) || []) {
      if (forward(id, v)) layer.set(v, Math.max(layer.get(v) || 0, l + 1))
    }
  }

  const maxL = Math.max(0, ...nodes.map((n) => layer.get(n.id) || 0))
  const cols = Array.from({ length: maxL + 1 }, () => [])
  for (const n of nodes) cols[layer.get(n.id) || 0].push(n.id)

  // 重心排序减少交叉
  const posIndex = new Map()
  const resetIndex = () => cols.forEach((col) => col.forEach((id, i) => posIndex.set(id, i)))
  resetIndex()
  const preds = new Map(nodes.map((n) => [n.id, []]))
  for (const e of useEdges) if (preds.has(e.to) && forward(e.from, e.to)) preds.get(e.to).push(e.from)
  const avgPred = (id) => {
    const ps = preds.get(id) || []
    if (!ps.length) return posIndex.get(id) || 0
    let s = 0
    for (const p of ps) s += (posIndex.get(p) || 0)
    return s / ps.length
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let c = 1; c < cols.length; c++) {
      cols[c].sort((a, b) => avgPred(a) - avgPred(b))
      cols[c].forEach((id, i) => posIndex.set(id, i))
    }
  }

  // 纵向分层：层自上而下堆叠，层内节点左右并排并居中对齐（适配窄高右栏）
  const HGAP = 60, VGAP = 46
  const rowW = cols.map((col) => { let s = 0; col.forEach((id, i) => { s += sizeOf(cur.byId.get(id)).w + (i ? HGAP : 0) }); return s })
  const rowH = cols.map((col) => { let m = NH; for (const id of col) m = Math.max(m, sizeOf(cur.byId.get(id)).h); return m })
  const maxW = Math.max(0, ...rowW)

  let y = 0
  for (let r = 0; r < cols.length; r++) {
    let x = (maxW - rowW[r]) / 2
    for (const id of cols[r]) {
      const sz = sizeOf(cur.byId.get(id))
      positions.set(id, { x, y: y + (rowH[r] - sz.h) / 2, w: sz.w, h: sz.h })
      x += sz.w + HGAP
    }
    y += rowH[r] + VGAP
  }
}

function resolveLayout() {
  recomputeLevel()
  const nodes = currentNodes()
  const edges = currentEdges()
  positions = new Map()
  const allPos = nodes.length > 0 && nodes.every((n) => n.pos && isFinite(n.pos.x) && isFinite(n.pos.y))
  if (allPos) {
    for (const n of nodes) positions.set(n.id, { x: Number(n.pos.x), y: Number(n.pos.y), ...sizeOf(n) })
  } else if (nodes.length) {
    layeredLayout(nodes, edges)
  }
  fitView()
  updateDiscuss()
  updateCrumb()
}

function fitView() {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const p of positions.values()) {
    minx = Math.min(minx, p.x); miny = Math.min(miny, p.y)
    maxx = Math.max(maxx, p.x + p.w); maxy = Math.max(maxy, p.y + p.h)
  }
  if (!isFinite(minx)) { view = { scale: 1, tx: W / 2, ty: H / 2 }; render(); return }
  minx -= 40; maxx += 40; miny -= 40; maxy += 40
  const cw = Math.max(1, maxx - minx), ch = Math.max(1, maxy - miny)
  const s = Math.min(W / cw, H / ch) * 0.94
  view.scale = Math.max(0.12, Math.min(1.8, s))
  view.tx = (W - cw * view.scale) / 2 - minx * view.scale
  view.ty = (H - ch * view.scale) / 2 - miny * view.scale
  render()
}

function nodeAt(vx, vy) {
  for (const n of currentNodes()) {
    const p = positions.get(n.id)
    if (!p) continue
    if (vx >= p.x && vx <= p.x + p.w && vy >= p.y && vy <= p.y + p.h) return n
  }
  return null
}
function toVirtual(clientX, clientY) {
  const rect = svg.getBoundingClientRect()
  const sx = clientX - rect.left, sy = clientY - rect.top
  return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale }
}

function onDown(e) {
  if (e.button !== 0) return
  const v = toVirtual(e.clientX, e.clientY)
  const n = nodeAt(v.x, v.y)
  if (n) {
    if (e.shiftKey) { sel.has(n.id) ? sel.delete(n.id) : sel.add(n.id); render(); updateDiscuss(); return }
    if (hasChildren(n.id) || hasImpl(n)) { enter(n.id); return }
    if (isDataStore(n)) { focus = n.id; sel = new Set([n.id]); render(); updateDiscuss(); return }
    sel = new Set([n.id])
    drillOrImpl(n)
    return
  }
  if (!e.shiftKey) { sel = new Set(); focus = null; render(); updateDiscuss() }
  drag = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty }
  svg.setPointerCapture(e.pointerId)
}
function onMove(e) {
  if (!drag) return
  view.tx = drag.tx + (e.clientX - drag.sx)
  view.ty = drag.ty + (e.clientY - drag.sy)
  render()
}
function onUp() { drag = null }
function onWheel(e) {
  e.preventDefault()
  const rect = svg.getBoundingClientRect()
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top
  const ns = Math.max(0.12, Math.min(2.5, view.scale * (e.deltaY < 0 ? 1.1 : 0.9)))
  view.tx = sx - (sx - view.tx) * (ns / view.scale)
  view.ty = sy - (sy - view.ty) * (ns / view.scale)
  view.scale = ns
  render()
}
function zoomBy(f) {
  const ns = Math.max(0.12, Math.min(2.5, view.scale * f))
  const cx = W / 2, cy = H / 2
  view.tx = cx - (cx - view.tx) * (ns / view.scale)
  view.ty = cy - (cy - view.ty) * (ns / view.scale)
  view.scale = ns
  render()
}

// ---------- 下钻 ----------

function enter(id) {
  const n = byId.get(id)
  if (!n) return
  const impl = hasChildren(id) ? false : (hasImpl(n) ? true : null)
  if (impl === null) return
  path.push({ id, title: n.title, impl })
  focus = null; sel = new Set()
  resolveLayout()
}

function showLoading(on, text) {
  const el = $('#fmLoading')
  if (!el) return
  if (on && text) { const t = $('#fmLoadingText'); if (t) t.textContent = text }
  el.classList.toggle('hidden', !on)
}

// 叶子功能：无实现逻辑时按需懒生成，成功后下钻展示流程图
async function drillOrImpl(n, box) {
  if (implLoading || !n) return
  if (box) box.classList.add('hidden')
  implLoading = n.id
  showLoading(true, `正在生成「${n.title}」的实现逻辑…`)
  try {
    const r = await featuremap('impl', { taskId, nodeId: n.id })
    if (taskId !== state.taskId) return
    if (r && r.ok && r.impl) {
      n.impl = r.impl
      byId.set(n.id, n)
      showLoading(false)
      enter(n.id)
      return
    }
    focus = n.id; sel = new Set([n.id]); render(); updateDiscuss()
    toast((r && r.error) || '暂无实现逻辑', 'err')
  } catch (e) {
    toast('生成实现逻辑失败：' + e.message, 'err')
  } finally {
    implLoading = null
    showLoading(false)
  }
}
function back() {
  if (!path.length) return
  path.pop()
  focus = null; sel = new Set()
  resolveLayout()
}
function setLevel(i) {
  path = i < 0 ? [] : path.slice(0, i + 1)
  focus = null; sel = new Set()
  resolveLayout()
}
function updateCrumb() {
  const title = $('#fmTitle')
  if (!title) return
  const segs = [{ i: -1, label: taskNameOf(taskId) || '高层功能视图' }]
  path.forEach((p, k) => segs.push({ i: k, label: p.title }))
  title.innerHTML = segs
    .map((s, idx) => (idx ? '<span class="cb-sep">›</span>' : '') + `<span class="cb${s.i === path.length - 1 ? ' on' : ''}" data-i="${s.i}">${esc(s.label)}</span>`)
    .join('')
  const bak = $('#fmBack')
  if (bak) bak.classList.toggle('hidden', !path.length)
}

// ---------- 连线几何 ----------

const centerBox = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y)

function borderPoint(box, toward) {
  const c = centerBox(box)
  const dx = toward.x - c.x, dy = toward.y - c.y
  if (Math.abs(dx) * box.h > Math.abs(dy) * box.w) return { x: dx >= 0 ? box.x + box.w : box.x, y: c.y }
  return { x: c.x, y: dy >= 0 ? box.y + box.h : box.y }
}

function dedupe(pts) {
  const out = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue
    out.push(p)
  }
  return out
}

function routePoints(a, b) {
  const ac = centerBox(a), bc = centerBox(b)
  const dx = bc.x - ac.x, dy = bc.y - ac.y
  if (Math.abs(dy) >= Math.abs(dx)) {
    const A = { x: ac.x, y: dy >= 0 ? a.y + a.h : a.y }
    const B = { x: bc.x, y: dy >= 0 ? b.y : b.y + b.h }
    if (Math.abs(A.x - B.x) < 1) return [A, B]
    const my = (A.y + B.y) / 2
    return [A, { x: A.x, y: my }, { x: B.x, y: my }, B]
  }
  const A = { x: dx >= 0 ? a.x + a.w : a.x, y: ac.y }
  const B = { x: dx >= 0 ? b.x : b.x + b.w, y: bc.y }
  if (Math.abs(A.y - B.y) < 1) return [A, B]
  const mx = (A.x + B.x) / 2
  return [A, { x: mx, y: A.y }, { x: mx, y: B.y }, B]
}

function roundedPath(pts) {
  const p = dedupe(pts)
  if (p.length < 2) return ''
  const r = 8
  let d = `M ${p[0].x} ${p[0].y}`
  for (let i = 1; i < p.length - 1; i++) {
    const prev = p[i - 1], cur = p[i], next = p[i + 1]
    const inLen = dist(prev, cur), outLen = dist(next, cur)
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x)
    if (Math.abs(cross) < 0.5 || inLen < 1 || outLen < 1) { d += ` L ${cur.x} ${cur.y}`; continue }
    const rr = Math.min(r, inLen / 2, outLen / 2)
    const ax = cur.x - ((cur.x - prev.x) / inLen) * rr
    const ay = cur.y - ((cur.y - prev.y) / inLen) * rr
    const bx = cur.x + ((next.x - cur.x) / outLen) * rr
    const by = cur.y + ((next.y - cur.y) / outLen) * rr
    d += ` L ${ax} ${ay} Q ${cur.x} ${cur.y} ${bx} ${by}`
  }
  const last = p[p.length - 1]
  d += ` L ${last.x} ${last.y}`
  return d
}

function labelPointFraction(pts, frac) {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i])
  let target = total * frac, acc = 0
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i])
    if (acc + seg >= target && seg > 0.01) {
      const t = (target - acc) / seg
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }
    }
    acc += seg
  }
  return pts[Math.floor(pts.length / 2)] || { x: 0, y: 0 }
}

// ---------- 渲染 ----------

function reachSet() {
  if (!focus) return null
  const s = new Set([focus])
  for (const e of currentEdges()) {
    if (e.from === focus) s.add(e.to)
    if (e.to === focus) s.add(e.from)
  }
  return s
}

function markerDefs() {
  const mk = (id, fill) => `<marker id="${id}" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="${fill}"/></marker>`
  return `<defs>${mk('fmA-proc', '#6e7681')}${mk('fmA-emph', '#3fb950')}${mk('fmA-data', '#a371f7')}${mk('fmA-hl', ACCENT)}</defs>`
}

function edgeSvg(e, reach) {
  const a = positions.get(e.from), b = positions.get(e.to)
  if (!a || !b) return ''
  const pts = routePoints(a, b)
  const d = roundedPath(pts)
  if (!d) return ''
  const touches = focus && (e.from === focus || e.to === focus)
  const dim = reach ? !touches : false
  let stroke, width, dash, mk
  if (e.kind === 'data') {
    stroke = touches ? ACCENT : '#a371f7'; width = 1.5; dash = '5 4'; mk = touches ? 'fmA-hl' : 'fmA-data'
  } else if (e.variant === 'emphasis') {
    stroke = touches ? ACCENT : '#3fb950'; width = 2.2; dash = ''; mk = touches ? 'fmA-hl' : 'fmA-emph'
  } else {
    stroke = touches ? ACCENT : '#6e7681'; width = 1.6; dash = ''; mk = touches ? 'fmA-hl' : 'fmA-proc'
  }
  const cls = 'fm-edge' + (e.kind === 'data' ? ' data' : '') + (dim ? ' dim' : '')
  let out = `<path class="${cls}" d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#${mk})" vector-effect="non-scaling-stroke"/>`
  if (e.label) {
    const fromDec = (cur.byId.get(e.from) || {}).kind === 'decision'
    const lp = labelPointFraction(pts, fromDec ? 0.3 : 0.5)
    const lw = Math.min(180, Math.max(36, String(e.label).length * 11 + 16))
    out += `<foreignObject x="${lp.x - lw / 2}" y="${lp.y - 10}" width="${lw}" height="20"><div xmlns="http://www.w3.org/1999/xhtml" class="fm-elabel${e.kind === 'data' ? ' data' : ''}${dim ? ' dim' : ''}">${esc(e.label)}</div></foreignObject>`
  }
  return out
}

function decisionSvg(n, p, reach) {
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2
  const pts = `${cx},${p.y} ${p.x + p.w},${cy} ${cx},${p.y + p.h} ${p.x},${cy}`
  const isFocus = focus === n.id
  const dim = reach ? !reach.has(n.id) : false
  const cls = 'fm-dec' + (isFocus ? ' focus' : '') + (dim ? ' dim' : '')
  return `<g class="${cls}" data-id="${esc(n.id)}">` +
    `<polygon points="${pts}" fill="rgba(210,153,34,.10)" stroke="${isFocus ? ACCENT : '#d29922'}" stroke-width="${isFocus ? 2 : 1.4}" vector-effect="non-scaling-stroke"/>` +
    `<foreignObject x="${p.x + 24}" y="${p.y + 22}" width="${p.w - 48}" height="${p.h - 44}"><div xmlns="http://www.w3.org/1999/xhtml" class="fm-dec-t">${esc(n.title)}</div></foreignObject>` +
    `</g>`
}

function nodeSvg(n, reach) {
  const p = positions.get(n.id)
  if (!p) return ''
  if (n.kind === 'decision') return decisionSvg(n, p, reach)
  const c = typeColor(n.type)
  const isFocus = focus === n.id
  const dim = reach ? !reach.has(n.id) : false
  const kids = hasChildren(n.id)
  const impl = !kids && hasImpl(n)
  const dot = n.status ? `<span class="fm-dot st-${n.status}" title="${STATUS_NAME[n.status] || ''}"></span>` : ''
  const sub = kids ? `<div class="fm-sub">${childCount(n.id)} 个小功能 ›</div>`
    : impl ? `<div class="fm-sub">实现逻辑 ›</div>` : ''
  const prov = []
  if (n.reads && n.reads.length) prov.push('读 ' + n.reads.join('、'))
  if (n.writes && n.writes.length) prov.push('写 ' + n.writes.join('、'))
  const provLine = (!kids && prov.length) ? `<div class="fm-prov" title="${esc(prov.join(' · '))}">${esc(prov.join(' · '))}</div>` : ''
  return `<foreignObject x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" class="fm-node${isFocus ? ' focus' : ''}${dim ? ' dim' : ''}${sel.has(n.id) ? ' sel' : ''}${kids ? ' has-kids' : impl ? ' has-impl' : ''}" data-id="${esc(n.id)}" style="border-left-color:${c}">` +
    dot +
    `<div class="t" title="${esc(n.title)}">${esc(n.title)}</div>` +
    (n.desc ? `<div class="d" title="${esc(n.desc)}">${esc(n.desc)}</div>` : '') +
    provLine +
    sub +
    `</div></foreignObject>`
}

function buildLegend() {
  const el = $('#fmLegend')
  if (!el) return
  el.innerHTML =
    `<span><i class="lg proc"></i>流程</span>` +
    `<span><i class="lg data"></i>数据流</span>` +
    `<span><i class="lg dec"></i>判断</span>` +
    `<span><i class="lg emph"></i>主路径</span>`
}

function render() {
  if (!root) return
  const nodes = currentNodes()
  const isEmpty = !nodes.length
  const eb = $('#fmEmpty')
  if (eb) eb.classList.toggle('hidden', !isEmpty)
  buildLegend()
  if (isEmpty) {
    root.setAttribute('transform', 'translate(0 0) scale(1)')
    root.innerHTML = ''
    return
  }
  const reach = reachSet()
  const parts = [markerDefs()]
  for (const e of currentEdges()) parts.push(edgeSvg(e, reach))
  for (const n of nodes) parts.push(nodeSvg(n, reach))
  root.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.scale})`)
  root.innerHTML = parts.join('')
}

// ---------- 讨论 / 详情 ----------

function selectedNodes() {
  return currentNodes().filter((n) => sel.has(n.id))
}

function updateDiscuss() {
  const b = $('#fmDiscuss')
  if (b) {
    b.disabled = sel.size === 0
    b.textContent = sel.size ? `讨论 ${sel.size}` : '讨论'
  }
  const ask = $('#fmAsk')
  if (ask) ask.placeholder = sel.size ? `围绕已选 ${sel.size} 个节点向 AI 提问…` : '选择节点后可在此向 AI 提问'
}

function contextText() {
  const lines = selectedNodes().map((n) => `- ${n.title}${n.desc ? '（' + n.desc + '）' : ''}`)
  return '【功能流程上下文】已选节点：\n' + lines.join('\n')
}

function discuss() {
  if (!sel.size) return
  prefillChat(contextText() + '\n\n请围绕以上节点说明你的修改诉求：')
}

function sendAsk() {
  const ask = ($('#fmAsk') && $('#fmAsk').value || '').trim()
  if (!ask) return
  const ctx = sel.size ? contextText() + '\n\n' : ''
  if ($('#fmAsk')) $('#fmAsk').value = ''
  sendChatText(ctx + '用户诉求：' + ask)
}

function showDetail(n) {
  const box = $('#fmDetail')
  if (!box) return
  const tags = []
  if (n.type && TYPE[n.type]) tags.push(`<span class="fm-tag" style="color:${typeColor(n.type)};border-color:${typeColor(n.type)}55">${TYPE[n.type].label}</span>`)
  if (n.status) tags.push(`<span class="fm-tag st-${n.status}">${STATUS_NAME[n.status]}</span>`)
  if (n.kind === 'decision') tags.push('<span class="fm-tag">判断点</span>')
  const kids = hasChildren(n.id)
  const impl = !kids && hasImpl(n)
  const canImpl = !kids && !impl && !isDataStore(n)
  const provHtml =
    ((n.reads && n.reads.length) ? `<div class="dprov"><span class="k rd">数据来源</span>${n.reads.map(esc).join('、')}</div>` : '') +
    ((n.writes && n.writes.length) ? `<div class="dprov"><span class="k wr">数据存储</span>${n.writes.map(esc).join('、')}</div>` : '')
  box.innerHTML =
    `<div class="hd"><span class="t">${esc(n.title)}</span><span class="x">×</span></div>` +
    (tags.length ? `<div class="ftags">${tags.join('')}</div>` : '') +
    (n.desc ? `<div class="dc">${esc(n.desc)}</div>` : '<div class="dc">暂无功能描述</div>') +
    provHtml +
    `<div class="factions">` +
    (kids ? `<button class="btn sm" id="fmDetailEnter">${ic('corner-down-right', 12)}<span>查看 ${childCount(n.id)} 个小功能</span></button>`
      : impl ? `<button class="btn sm" id="fmDetailEnter">${ic('corner-down-right', 12)}<span>查看实现逻辑</span></button>`
        : canImpl ? `<button class="btn sm" id="fmDetailEnter">${ic('sparkles', 12)}<span>生成实现逻辑</span></button>` : '') +
    `<button class="btn sm" id="fmDetailDiscuss">${ic('message-square', 12)}<span>讨论此节点</span></button></div>`
  refreshIcons()
  box.classList.remove('hidden')
  box.querySelector('.x').addEventListener('click', () => box.classList.add('hidden'))
  const dbtn = box.querySelector('#fmDetailDiscuss')
  if (dbtn) dbtn.addEventListener('click', () => {
    sel = new Set([n.id]); updateDiscuss(); render(); discuss(); box.classList.add('hidden')
  })
  const ebtn = box.querySelector('#fmDetailEnter')
  if (ebtn) ebtn.addEventListener('click', () => {
    if (kids || impl) { box.classList.add('hidden'); enter(n.id) }
    else drillOrImpl(n, box)
  })
}

async function doUpdate() {
  if (!taskId) return
  const btn = $('#fmUpdate')
  if (btn) btn.classList.add('spin')
  toast('正在更新功能流程…')
  try {
    const r = await featuremap('updateNow', { taskId })
    if (r && r.updated) toast('功能流程已更新')
    else if (r && r.skipped === 'no-model') toast('未配置可用的模型', 'err')
    else if (r && r.skipped === 'no-material') toast('还没有对话内容，先和 AI 聊聊再生成')
    else if (r && r.skipped === 'not-code') toast('仅代码类任务维护功能流程')
    else if (r && r.error) toast('更新失败：' + r.error, 'err')
    else toast('功能流程暂无变化')
    await reload()
  } catch (e) { toast('更新失败：' + e.message, 'err') }
  finally { if (btn) btn.classList.remove('spin') }
}

async function reload() {
  let m = null
  try { m = await featuremap('get', { taskId }) } catch {}
  if (taskId !== state.taskId) return
  normalize(m)
  resolveLayout()
}

async function doImplAll() {
  if (!taskId) return
  const btn = $('#fmImplAll')
  if (btn) { btn.disabled = true; btn.classList.add('spin') }
  toast('正在为所有叶子功能补全实现逻辑…')
  try {
    const r = await featuremap('implAll', { taskId })
    if (r && r.ok) toast(r.total ? `已补全 ${r.done}/${r.total} 个实现逻辑` : '实现逻辑已齐全')
    else if (r && r.error) toast('补全失败：' + r.error, 'err')
    await reload()
  } catch (e) { toast('补全失败：' + e.message, 'err') }
  finally { if (btn) { btn.disabled = false; btn.classList.remove('spin') } }
}

export async function renderFeatureMap(id) {
  taskId = id
  path = []
  focus = null
  sel = new Set()
  if (!inited) initFeatureMap()
  const dbox = $('#fmDetail')
  if (dbox) dbox.classList.add('hidden')
  if (!id) { normalize(null); positions = new Map(); updateCrumb(); fitView(); return }
  await reload()
}
