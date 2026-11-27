// 功能图服务：code 类型任务维护 .zzwork/feature-map.json，每回合由模型判断是否增量更新
const fs = require('fs')
const path = require('path')
const { chatStream } = require('../../core/ai')
const { parseRemotePath } = require('../../core/envs')
const { getStore } = require('./store')
const remotefs = require('./remotefs')
const { taskJoin, readTextFile, writeTaskTextFile } = require('./taskfiles')
const { pickDefaultModel, keyOf, modelLike, extractJson, post, auxStart } = require('./chat')

const MAP_FILE = 'feature-map.json'
const MAP_READ_LIMIT = 2 * 1024 * 1024
const MAX_NODES = 160
const MAX_EDGES = 260
const MAX_IMPL_NODES = 40       // 单个叶子功能实现逻辑图的节点上限
const MAX_IMPL_EDGES = 60       // 单个叶子功能实现逻辑图的边上限
const STATUS = new Set(['todo', 'doing', 'done'])
const NODE_TYPES = new Set(['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external', 'service', 'cron', 'cache', 'storage'])
const NODE_KINDS = new Set(['step', 'decision'])
const EDGE_KINDS = new Set(['process', 'data'])
const EDGE_VARIANTS = new Set(['default', 'emphasis', 'security', 'dashed'])
const AUTO_GAP = 15000          // 自动维护节流
const LLM_TIMEOUT = 180000      // 单次维护超时（整图生成含推理常需 1~2 分钟）
const IMPL_TIMEOUT = 120000     // 单个功能实现逻辑生成超时

// 代码项目分析：忽略依赖/构建/缓存目录，跳过二进制与压缩产物
const IGNORE_DIRS = new Set([
  'node_modules', 'bower_components', '.git', '.zzwork', '.zztask', 'dist', 'build', 'out',
  'coverage', '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', 'env', 'target',
  'vendor', '.idea', '.vscode', '.gradle', 'Pods', 'bin', 'obj', 'tmp', 'temp', 'logs'
])
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'mp3', 'wav', 'pdf', 'zip', 'gz', 'tar', 'rar', '7z', 'exe', 'dll', 'so', 'dylib',
  'node', 'wasm', 'map', 'lock'
])
const SOURCE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'go', 'rs', 'java', 'kt', 'kts',
  'rb', 'php', 'cs', 'c', 'cc', 'cpp', 'h', 'hpp', 'swift', 'scala', 'sh', 'ps1', 'sql', 'css',
  'scss', 'less', 'html', 'htm', 'lua', 'dart', 'ex', 'exs', 'clj', 'groovy'
])
const KEY_FILES = [
  'README.md', 'readme.md', 'README', 'README.txt', 'package.json', 'pyproject.toml', 'requirements.txt',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'settings.gradle', 'composer.json', 'Gemfile',
  'tsconfig.json', 'vite.config.js', 'vite.config.ts', 'electron.vite.config.js', 'electron.vite.config.ts',
  'next.config.js', 'nuxt.config.ts', 'Makefile', 'Dockerfile'
]
const TREE_MAX = 400            // 文件树最多列这么多项
const TREE_DEPTH = 5            // 目录递归深度
const PROJ_LIMIT = 20000        // 项目摘要总字符上限

function extOf(name) { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase() }
function isSource(name) {
  if (/\.min\.(js|css)$/i.test(name)) return false
  if (/\.(test|spec)\.[^.]+$/i.test(name)) return false
  return SOURCE_EXT.has(extOf(name))
}
function isBinary(name) {
  if (/\.min\.(js|css)$/i.test(name)) return true
  return BINARY_EXT.has(extOf(name))
}

// 统一列目录（本地 / WSL / SSH），返回 { name, path, dir }
async function listDir(dir) {
  const r = parseRemotePath(dir)
  if (r) {
    try { return (await remotefs.readDir(r.envId, r.remotePath)).map((d) => ({ name: d.name, path: d.path, dir: !!d.dir })) }
    catch { return [] }
  }
  try {
    return (await fs.promises.readdir(dir, { withFileTypes: true })).map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
  } catch { return [] }
}

// 遍历项目生成相对路径文件树（仅路径，不含内容），跳过依赖/构建/二进制
async function walkTree(root) {
  const out = []
  async function walk(dir, rel, depth) {
    if (out.length >= TREE_MAX || depth > TREE_DEPTH) return
    const items = (await listDir(dir)).slice().sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
    for (const it of items) {
      if (out.length >= TREE_MAX) return
      const childRel = rel ? rel + '/' + it.name : it.name
      if (it.dir) {
        if (IGNORE_DIRS.has(it.name) || it.name.startsWith('.')) continue
        out.push(childRel + '/')
        await walk(it.path, childRel, depth + 1)
      } else {
        if (it.name.startsWith('.') || isBinary(it.name)) continue
        out.push(childRel)
      }
    }
  }
  await walk(root, '', 0)
  return out
}

// 项目摘要：文件树 + 关键文件 + 源码抽样，供模型据此梳理高层功能
async function projectDigest(task) {
  if (!task || !task.path) return ''
  const tree = await walkTree(task.path)
  if (!tree.length) return ''
  const parts = [`项目文件树（共 ${tree.length} 项，已省略依赖与构建产物）：`, ...tree]

  const snippets = []
  let snipLen = 0
  for (const name of KEY_FILES) {
    if (snipLen > 5000) break
    const raw = await readTextFile(taskJoin(task.path, name), 2500)
    if (!raw) continue
    const body = raw.trim().slice(0, 2500)
    snippets.push(`--- ${name} ---\n${body}`)
    snipLen += body.length
  }
  if (snippets.length) parts.push('', '关键文件：', ...snippets)

  const srcFiles = tree.filter((p) => !p.endsWith('/') && isSource(p.split('/').pop())).slice(0, 12)
  const bodies = []
  let bodyLen = 0
  for (const rel of srcFiles) {
    if (bodyLen > 9000) break
    const raw = await readTextFile(taskJoin(task.path, ...rel.split('/')), 1400)
    if (!raw) continue
    const body = raw.trim().slice(0, 1400)
    bodies.push(`--- ${rel} ---\n${body}`)
    bodyLen += body.length
  }
  if (bodies.length) parts.push('', '源码抽样：', ...bodies)

  return parts.join('\n').slice(0, PROJ_LIMIT)
}

const fmAt = new Map()          // taskId -> 上次自动维护时间
const fmJobs = new Map()        // taskId -> 进行中的维护 promise
const fmHash = new Map()        // taskId -> 上次广播的 map JSON，避免重复推送

function emptyMap(task) {
  return { v: 3, task: task ? task.name : '', diagramType: 'flow-architecture', nodes: [], edges: [], updatedAt: '' }
}

// 由领域名推断节点类型（v1 迁移时给顶层域上色）
function inferDomainType(title) {
  const t = String(title || '')
  if (/权限|安全|认证|鉴权|锁|审批|风控/.test(t)) return 'security'
  if (/通知|消息|告警|推送/.test(t)) return 'messagebus'
  if (/看板|数据|统计|报表|指标|分析/.test(t)) return 'database'
  if (/集成|仓库|对接|第三方|外部|GitLab|Jenkins/i.test(t)) return 'external'
  if (/流水线|CI|CD|构建|部署|发布/.test(t)) return 'backend'
  if (/前端|页面|界面|交互/.test(t)) return 'frontend'
  return 'service'
}

function uniqueId(base, used) {
  const clean = String(base).trim().replace(/\s+/g, '-').slice(0, 60) || 'grp'
  let id = clean, i = 2
  while (used.has(id)) id = clean.slice(0, 56) + '-' + (i++)
  used.add(id)
  return id
}

// 单个节点：白名单字段 + 上限，返回净化后的节点（id 唯一性由 ids 保证）
function sanitizeNode(n, ids) {
  if (!n || typeof n !== 'object') return null
  const id = String(n.id || '').trim().slice(0, 80)
  const title = String(n.title || '').trim().slice(0, 120)
  if (!id || !title || ids.has(id)) return null
  ids.add(id)
  const node = { id, title, parent: String(n.parent || '').trim().slice(0, 80) }
  if (n.desc) node.desc = String(n.desc).slice(0, 400)
  if (STATUS.has(n.status)) node.status = n.status
  node.type = NODE_TYPES.has(n.type) ? n.type : 'service'
  node.kind = NODE_KINDS.has(n.kind) ? n.kind : 'step'
  const strs = (v) => Array.isArray(v) ? v.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 8) : []
  const reads = strs(n.reads), writes = strs(n.writes)
  if (reads.length) node.reads = reads
  if (writes.length) node.writes = writes
  if (n.pos && typeof n.pos === 'object' && isFinite(n.pos.x) && isFinite(n.pos.y)) {
    node.pos = { x: Number(n.pos.x), y: Number(n.pos.y) }
  }
  const impl = sanitizeImpl(n.impl)
  if (impl) node.impl = impl
  return node
}

function sanitizeEdge(e, ids, seen) {
  if (!e || typeof e !== 'object') return null
  const from = String(e.from || '').trim()
  const to = String(e.to || '').trim()
  if (!ids.has(from) || !ids.has(to) || from === to) return null
  const kind = EDGE_KINDS.has(e.kind) ? e.kind : 'process'
  const key = kind + ':' + from + '->' + to
  if (seen.has(key)) return null
  seen.add(key)
  const edge = { from, to, kind }
  if (e.label) edge.label = String(e.label).slice(0, 120)
  edge.variant = EDGE_VARIANTS.has(e.variant) ? e.variant : 'default'
  return edge
}

// 叶子功能的「实现逻辑」子流程图：独立节点/边集合，扁平展开
function sanitizeImpl(raw) {
  if (!raw || typeof raw !== 'object') return null
  const ids = new Set()
  const nodes = []
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const node = sanitizeNode(n, ids)
    if (!node) continue
    node.parent = ''
    nodes.push(node)
    if (nodes.length >= MAX_IMPL_NODES) break
  }
  if (!nodes.length) return null
  const edges = []
  const seen = new Set()
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    const edge = sanitizeEdge(e, ids, seen)
    if (!edge) continue
    edges.push(edge)
    if (edges.length >= MAX_IMPL_EDGES) break
  }
  return { nodes, edges }
}

// 白名单 + 上限：两级层级（parent）+ 流程/数据边，杜绝模型输出污染
// 兼容旧版 v1（只有 group 没有 parent）：把 group 升级为顶层「大功能域」，成员作为子功能
function sanitizeMap(raw, task) {
  const src = raw && typeof raw === 'object' ? raw : {}

  const memberNodes = []
  const groupOf = new Map()          // nodeId -> 原始 group 名
  const ids = new Set()
  const list = Array.isArray(src.nodes) ? src.nodes : []
  for (const n of list) {
    const node = sanitizeNode(n, ids)
    if (!node) continue
    if (n.group) groupOf.set(node.id, String(n.group).trim().slice(0, 80))
    memberNodes.push(node)
    if (memberNodes.length >= MAX_NODES) break
  }

  // 二次校验 parent：必须是已存在且不同级的节点 id，否则视为顶层
  for (const node of memberNodes) {
    if (!node.parent || !ids.has(node.parent) || node.parent === node.id) node.parent = ''
  }

  // 处理边
  const memberEdges = []
  const seen = new Set()
  const elist = Array.isArray(src.edges) ? src.edges : []
  for (const e of elist) {
    const edge = sanitizeEdge(e, ids, seen)
    if (!edge) continue
    memberEdges.push(edge)
    if (memberEdges.length >= MAX_EDGES) break
  }

  // v1 迁移：没有任何 parent、但有 group → 将 group 升级为顶层大功能域
  const hasParent = memberNodes.some((n) => n.parent)
  const hasGroup = [...groupOf.values()].some(Boolean)
  let nodes, edges
  if (!hasParent && hasGroup) {
    const domByGroup = new Map()
    const domains = []
    for (const node of memberNodes) {
      const g = groupOf.get(node.id) || '其他'
      let d = domByGroup.get(g)
      if (!d) {
        d = { id: uniqueId(g, ids), title: g, parent: '', type: inferDomainType(g), kind: 'step', desc: '' }
        domByGroup.set(g, d)
        domains.push(d)
      }
      node.parent = d.id
    }
    // 组内边保留下钻用；跨组边派生为域间流程
    const domEdges = []
    const dseen = new Set()
    for (const e of memberEdges) {
      const ga = groupOf.get(e.from) || '其他'
      const gb = groupOf.get(e.to) || '其他'
      if (ga === gb) continue
      const a = domByGroup.get(ga).id, b = domByGroup.get(gb).id
      const key = e.kind + ':' + a + '->' + b
      if (a === b || dseen.has(key)) continue
      dseen.add(key)
      domEdges.push({ from: a, to: b, kind: e.kind, variant: 'default' })
    }
    edges = [...domEdges, ...memberEdges.filter((e) => (groupOf.get(e.from) || '其他') === (groupOf.get(e.to) || '其他'))]
    nodes = [...domains, ...memberNodes]
  } else {
    nodes = memberNodes
    edges = memberEdges
  }

  return { v: 3, task: task ? task.name : '', diagramType: 'flow-architecture', nodes, edges, updatedAt: src.updatedAt || '' }
}

async function readMap(task) {
  if (!task || !task.path) return null
  const raw = await readTextFile(taskJoin(task.path, '.zzwork', MAP_FILE), MAP_READ_LIMIT)
  if (!raw) return null
  try { return sanitizeMap(JSON.parse(raw), task) } catch { return null }
}

async function writeMap(task, map) {
  const out = sanitizeMap(map, task)
  out.updatedAt = new Date().toISOString()
  await writeTaskTextFile(taskJoin(task.path, '.zzwork', MAP_FILE), JSON.stringify(out, null, 2))
  return out
}

// 把当前网络压成紧凑 JSON（给模型看，不含坐标/impl，避免上下文膨胀）
function compactMap(map) {
  if (!map || !Array.isArray(map.nodes) || !map.nodes.length) return ''
  return JSON.stringify({
    nodes: map.nodes.map((n) => ({ id: n.id, parent: n.parent, title: n.title, desc: n.desc, type: n.type, status: n.status, kind: n.kind, reads: n.reads, writes: n.writes })),
    edges: map.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, kind: e.kind, variant: e.variant }))
  })
}

// 补丁操作 → 人读说明（卡片展示用）
function describeOps(ops) {
  const lines = []
  for (const op of (Array.isArray(ops) ? ops : [])) {
    if (!op || typeof op !== 'object') continue
    if (op.op === 'add' && op.node) lines.push('+ ' + (op.node.title || op.node.id || '?'))
    else if (op.op === 'add' && op.edge) lines.push('+ 关系 ' + (op.edge.from || '?') + '→' + (op.edge.to || '?') + (op.edge.label ? '（' + op.edge.label + '）' : ''))
    else if (op.op === 'update') lines.push('~ ' + op.id + (op.patch && typeof op.patch === 'object' ? '（' + Object.keys(op.patch).join('、') + '）' : ''))
    else if (op.op === 'remove') lines.push('- ' + op.id)
  }
  return lines
}

// 补丁应用到现有网络（纯函数，返回待净化的原始 map；add/update/remove + 级联删子节点与相关边）
function applyOps(base, ops) {
  const src = base && Array.isArray(base.nodes) ? base : { nodes: [], edges: [] }
  let nodes = src.nodes.map((n) => {
    const c = { ...n }
    if (n.pos) c.pos = { ...n.pos }
    if (n.reads) c.reads = [...n.reads]
    if (n.writes) c.writes = [...n.writes]
    return c
  })
  let edges = (Array.isArray(src.edges) ? src.edges : []).map((e) => ({ ...e }))
  for (const op of (Array.isArray(ops) ? ops : [])) {
    if (!op || typeof op !== 'object') continue
    if (op.op === 'add') {
      if (op.node && typeof op.node === 'object') nodes.push({ ...op.node })
      else if (op.edge && typeof op.edge === 'object') edges.push({ ...op.edge })
      else if (op.from && op.to && !op.title && !op.id) { const { op: _o, ...e } = op; edges.push(e) }
      else if (op.id || op.title) { const { op: _o, ...n } = op; nodes.push(n) }
    } else if (op.op === 'update' && op.id) {
      const n = nodes.find((x) => x.id === String(op.id))
      if (n && op.patch && typeof op.patch === 'object') {
        const patch = { ...op.patch }
        delete patch.id
        Object.assign(n, patch)
      }
    } else if (op.op === 'remove' && op.id) {
      const rm = new Set([String(op.id)])
      let grew = true
      while (grew) {
        grew = false
        for (const n of nodes) {
          if (!rm.has(n.id) && n.parent && rm.has(n.parent)) { rm.add(n.id); grew = true }
        }
      }
      nodes = nodes.filter((n) => !rm.has(n.id))
      edges = edges.filter((e) => !rm.has(e.from) && !rm.has(e.to))
    }
  }
  return { nodes, edges }
}

// 可见的自动维护：每回合后调用，把一次维护以对话卡片呈现（run → done/error）
async function maintainVisible(taskId, sessionId, opts = {}) {
  const S = getStore()
  const task = S.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  if (task.type !== 'code') return { ok: false, skipped: 'not-code' }

  const now = Date.now()
  if (!opts.force && now - (fmAt.get(taskId) || 0) < AUTO_GAP) return { ok: false, skipped: 'throttled' }
  const running = fmJobs.get(taskId)
  if (running) return running

  const p = (async () => {
    const aux = auxStart(taskId, sessionId, '功能网络更新')
    try {
      const r = await doMaintain(task, { ...opts, sessionId })
      if (r && r.updated) aux.done(r.reason || `更新了 ${(r.ops || []).length} 处`, r.details || '')
      else if (r && r.skipped) aux.done('跳过：' + r.skipped, r.details || '')
      else aux.done('功能网络无需变更', (r && r.details) || '')
      return r
    } catch (e) {
      aux.error((e && e.message) || '维护失败')
      return { ok: false, error: (e && e.message) || 'llm-failed' }
    }
  })().finally(() => fmJobs.delete(taskId))
  fmJobs.set(taskId, p)
  return p
}

// 兼容旧调用点：对外主路径统一走 maintainVisible
function maintain(taskId, opts = {}) {
  return maintainVisible(taskId, opts.sessionId || '', opts)
}

async function doMaintain(task, opts = {}) {
  const S = getStore()
  const taskId = task.id
  fmAt.set(taskId, Date.now())

  const cur = await readMap(task)
  const project = await projectDigest(task)
  const hasCur = !!(cur && cur.nodes && cur.nodes.length)

  // 会话上下文：会话摘要 + 本会话完整对话（按字符预算保留，摘要优先）
  const sessionId = opts.sessionId || ''
  const session = sessionId ? S.getSession(sessionId) : null
  const msgs = S.listMessages(taskId, sessionId || undefined).filter((m) => (m.kind || 'text') === 'text')
  let recent = ''
  {
    let budget = 10000
    const parts = []
    for (let i = msgs.length - 1; i >= 0 && budget > 0; i--) {
      const t = `${msgs[i].role === 'user' ? '用户' : 'AI'}：${String(msgs[i].content || '').slice(0, 1200)}`
      parts.unshift(t)
      budget -= t.length
    }
    recent = parts.join('\n')
  }
  const sessSummary = session && session.summary ? session.summary : ''
  const brief = task.brief || ''
  if (!hasCur && !project && !recent) return { ok: false, skipped: 'no-material' }

  // 优先用任务选中的模型（与对话一致），回退到全局默认
  const models = S.listModels()
  const model = (task.model_id && models.find((m) => m.id === task.model_id)) || pickDefaultModel(S)
  const key = keyOf(S, model)
  if (!model || !key) return { ok: false, skipped: 'no-model' }

  const source = [
    project ? `代码项目：\n${project}` : '代码项目：（未读取到项目文件）',
    hasCur ? `当前功能网络：\n${compactMap(cur)}` : '当前功能网络：（空，请依据代码项目完整生成）',
    brief ? `任务简介：\n${brief}` : '',
    sessSummary ? `会话摘要：\n${sessSummary}` : '',
    recent ? `本会话对话：\n${recent}` : ''
  ].filter(Boolean).join('\n\n')

  const rules =
    '规则：\n' +
    '- 以用户/产品视角组织，而不是代码模块视角；宁可更全，不要遗漏、不要过度合并。\n' +
    '- 必须覆盖：用户功能、数据源与存储（数据库表/缓存/外部系统 API/文件对象存储）、定时与后台任务（cron、消息消费、异步 worker，如「每日对账」「超时关单」「清理过期数据」）、外部集成。\n' +
    '层级（用 parent 表达，逐层展开）：顶层 8–14 个「大功能域」（parent 为 ""）串成端到端主业务流；每个大功能下 3–8 个子功能（parent=大功能 id），可含 decision；可多层。\n' +
    '- 必须有一个顶层「数据源与存储」域（parent 为 ""），其下用真实名字列出具体存储节点，type 取 database/cache/storage/external。\n' +
    '- 定时任务的 type 用 "cron"，title 写具体作业名，desc 写频率与作用。\n' +
    '数据来源与存储（每个叶子功能节点都要声明，这是核心价值）：reads=从哪些存储/接口取数（console 具体名，1–4 项）；writes=写到哪（表/缓存/文件/外部接口，0–3 项）；名字要与「数据源与存储」域下的存储节点 title 一致，不要写泛称。\n' +
    '连线两种：kind:"process"（流程，实线；decision 的分支在 label 写条件，主路径可 variant:"emphasis"）；kind:"data"（数据流，虚线；label 写数据名）。只画真实依赖，不要两两相连。\n' +
    '字段定义：\n' +
    '- node: {"id":"稳定唯一id","parent":"","title":"中文功能名","desc":"一句话说明","type":"frontend|backend|database|cloud|security|messagebus|external|service|cron|cache|storage","status":"todo|doing|done","kind":"step|decision","reads":["pipeline_run 表"],"writes":["静态报告文件"]}\n' +
    '- edge: {"from":"id","to":"id","label":"条件或数据名","kind":"process|data","variant":"default|emphasis"}\n' +
    '不需要给坐标，渲染器会自动布局。\n'

  const tail = hasCur
    ? '当前已有功能网络（见上文「当前功能网络」）。请**只维护差异**：\n' +
      '- 代码/对话里新增或改动的能力，用 add/update 补上（节点 id 稳定，能复用就复用）。\n' +
      '- 已被删除/不再存在的能力，用 remove 删除（会级联删除其子节点与相关边）。\n' +
      '- 保持不变的部分**不要重复输出**。若无需改动，输出 {"update":false}。\n'
    : '当前功能网络为空，请依据代码项目**完整生成**整张网络（全部用 add）。\n'
  const outputSpec =
    '严格只输出一个 JSON 对象，不要任何多余文字：\n' +
    '- 无需改动：{"update":false}\n' +
    '- 需要改动：{"update":true,"reason":"一句话说明改了什么","ops":[操作...]}\n' +
    'ops 操作（只写变化的部分）：\n' +
    '  {"op":"add","node":{节点对象}}\n' +
    '  {"op":"add","edge":{"from":"id","to":"id","label":"条件或数据名","kind":"process|data","variant":"default|emphasis"}}\n' +
    '  {"op":"update","id":"已有id","patch":{"desc":"...","status":"doing","reads":["..."]}}\n' +
    '  {"op":"remove","id":"要删除的id"}\n'

  const sys =
    `你是软件产品「功能网络」维护器。任务「${task.name}」是一份软件产品。请依据代码项目与对话上下文，维护一张功能网络：用户能感知的全部功能/能力 + 支撑它们的数据源与存储 + 后台定时任务 + 端到端流程。\n` +
    rules + tail + outputSpec

  const ctxHints = []
  if (project) ctxHints.push(`项目摘要 ${project.length} 字`)
  if (brief) ctxHints.push('任务简介')
  if (sessSummary) ctxHints.push('会话摘要')
  if (msgs.length) ctxHints.push(`本会话 ${msgs.length} 条对话`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT)
  let acc = ''
  try {
    await chatStream(modelLike(S, model), key, [{ role: 'user', content: source.slice(0, 32000) }], sys,
      (d) => { acc += d }, controller.signal)
  } catch (e) {
    console.error('[featuremap] 维护失败：', e)
    const timeout = e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))
    throw new Error(timeout ? '生成超时，请稍后重试' : ((e && e.message) || 'llm-failed'))
  } finally { clearTimeout(timer) }

  const parsed = extractJson(acc)
  if (!parsed || parsed.update !== true) {
    return { ok: true, updated: false, reason: (parsed && parsed.reason) || '', details: '上下文：' + ctxHints.join(' · ') + '\n判断：无需变更' }
  }

  let nextRaw
  if (Array.isArray(parsed.ops)) nextRaw = applyOps(cur, parsed.ops)
  else if (parsed.map && typeof parsed.map === 'object') nextRaw = parsed.map
  else return { ok: true, updated: false, details: '上下文：' + ctxHints.join(' · ') + '\n未解析到有效补丁' }

  const map = await writeMap(task, nextRaw)
  const hash = JSON.stringify({ nodes: map.nodes, edges: map.edges })
  if (fmHash.get(taskId) !== hash) {
    fmHash.set(taskId, hash)
    post({ taskId, type: 'featuremap', map })
  }
  const opLines = describeOps(parsed.ops || [])
  const details = [
    '上下文：' + ctxHints.join(' · '),
    parsed.reason ? '判断：' + parsed.reason : '',
    opLines.length ? `补丁（${opLines.length} 项）：\n` + opLines.join('\n') : '补丁：已更新网络'
  ].filter(Boolean).join('\n')
  return { ok: true, updated: true, map, reason: parsed.reason || '', ops: parsed.ops || [], details }
}

// 叶子功能的「实现逻辑」：按需懒生成并缓存到 feature-map.json
const implJobs = new Map()       // taskId:nodeId -> 进行中的生成 promise
const DATA_STORE_TYPES = new Set(['database', 'cache', 'storage', 'external'])

function ensureImpl(task, nodeId, sessionId) {
  const key = task.id + ':' + nodeId
  const running = implJobs.get(key)
  if (running) return running
  const p = doImpl(task, nodeId, sessionId).finally(() => implJobs.delete(key))
  implJobs.set(key, p)
  return p
}

async function doImpl(task, nodeId, sessionId) {
  const map = await readMap(task)
  if (!map) return { ok: false, error: '功能图不存在，请先更新' }
  const node = map.nodes.find((n) => n.id === nodeId)
  if (!node) return { ok: false, error: '节点不存在' }
  if (node.impl && Array.isArray(node.impl.nodes) && node.impl.nodes.length) return { ok: true, impl: node.impl, cached: true }
  if (DATA_STORE_TYPES.has(node.type)) return { ok: false, error: '该节点是数据存储，没有实现逻辑' }

  const S = getStore()
  const models = S.listModels()
  const model = (task.model_id && models.find((m) => m.id === task.model_id)) || pickDefaultModel(S)
  const key = keyOf(S, model)
  if (!model || !key) return { ok: false, skipped: 'no-model' }

  const project = await projectDigest(task)
  const info = [
    `功能：${node.title}`,
    node.desc ? `说明：${node.desc}` : '',
    `类型：${node.type}`,
    (node.reads && node.reads.length) ? `数据来源：${node.reads.join('、')}` : '',
    (node.writes && node.writes.length) ? `数据存储：${node.writes.join('、')}` : ''
  ].filter(Boolean).join('\n')
  const source = [project ? `代码项目：\n${project}` : '', info].filter(Boolean).join('\n\n')

  const sys =
    `你是软件工程师，负责梳理「${node.title}」这个功能的**实现逻辑**。请产出一张实现逻辑流程图：从接收/校验入参开始，经过取数（从哪读）、处理与关键判断、写库/缓存/文件，到返回/通知，3–8 个步骤。\n` +
    '每步用 type 区分（frontend/backend/database/cache/storage/external/service/security/messagebus/cron），关键判断用 kind:"decision"；用 kind:"process" 连流程（从 decision 出发的分支必须在 label 写条件，如「是」「否」），用 kind:"data" 连数据流（label 写数据名）。步骤可声明 reads（从哪些表/接口取数）/writes（写到哪），用具体名字。\n' +
    '只输出一个 JSON 对象，不要多余文字：{"update":true,"impl":{"nodes":[{"id":"s1","title":"校验入参","type":"backend","kind":"step","reads":["user 表"]},{"id":"s2","title":"是否有效？","type":"service","kind":"decision"}],"edges":[{"from":"s1","to":"s2","label":"","kind":"process"}]}}\n' +
    '必须贴近代码项目的真实实现，不要臆造不存在的存储。'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMPL_TIMEOUT)
  const aux = auxStart(task.id, sessionId, '实现逻辑 · ' + node.title)
  let acc = ''
  try {
    await chatStream(modelLike(S, model), key, [{ role: 'user', content: source.slice(0, 24000) }], sys,
      (d) => { acc += d }, controller.signal)
  } catch (e) {
    console.error('[featuremap] 实现逻辑生成失败：', e)
    const timeout = e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))
    const msg = timeout ? '生成实现逻辑超时，请重试' : ((e && e.message) || 'llm-failed')
    aux.error(msg)
    return { ok: false, error: msg }
  } finally { clearTimeout(timer) }

  const parsed = extractJson(acc)
  const impl = sanitizeImpl(parsed && parsed.impl)
  if (!impl || !impl.nodes.length) { aux.error('未生成有效的实现逻辑'); return { ok: false, error: '未生成有效的实现逻辑' } }

  node.impl = impl
  await writeMap(task, map)
  const steps = impl.nodes.map((n) => (n.kind === 'decision' ? '◇ ' : '· ') + n.title).join('\n')
  aux.done(`已生成 ${impl.nodes.length} 个步骤`, `上下文：项目摘要 + 「${node.title}」功能\n步骤：\n${steps}`)
  return { ok: true, impl }
}

// 「补全全部」：为所有叶子功能（排除数据存储）补齐实现逻辑，逐个生成并各出一张卡片
async function ensureAllImpl(task, sessionId) {
  const map = await readMap(task)
  if (!map) return { ok: false, error: '功能图不存在，请先更新' }
  const hasKids = new Set(map.nodes.filter((n) => n.parent).map((n) => n.parent))
  const leaves = map.nodes.filter((n) => !hasKids.has(n.id) && !DATA_STORE_TYPES.has(n.type))
  const todo = leaves.filter((n) => !(n.impl && Array.isArray(n.impl.nodes) && n.impl.nodes.length))
  let done = 0, failed = 0
  for (const n of todo) {
    try {
      const r = await ensureImpl(task, n.id, sessionId)
      if (r && r.ok) done++; else failed++
    } catch { failed++ }
  }
  return { ok: true, total: todo.length, done, failed }
}

function register(ipcMain) {
  ipcMain.handle('zz:featuremap:get', async (_e, p) => {
    const S = getStore()
    const task = S.getTask(p.taskId)
    if (!task) return emptyMap(null)
    return (await readMap(task)) || emptyMap(task)
  })
  ipcMain.handle('zz:featuremap:updateNow', (_e, p) => maintainVisible(p.taskId, p.sessionId || '', { force: true }))
  ipcMain.handle('zz:featuremap:impl', (_e, p) => {
    const S = getStore()
    const task = S.getTask(p.taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    return ensureImpl(task, p.nodeId, p.sessionId || '')
  })
  ipcMain.handle('zz:featuremap:implAll', async (_e, p) => {
    const S = getStore()
    const task = S.getTask(p.taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    return ensureAllImpl(task, p.sessionId || '')
  })
  ipcMain.handle('zz:featuremap:clear', async (_e, p) => {
    const S = getStore()
    const task = S.getTask(p.taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const map = emptyMap(task)
    map.updatedAt = new Date().toISOString()
    await writeTaskTextFile(taskJoin(task.path, '.zzwork', MAP_FILE), JSON.stringify(map, null, 2))
    fmHash.set(p.taskId, JSON.stringify({ nodes: [], edges: [] }))
    post({ taskId: p.taskId, type: 'featuremap', map })
    return { ok: true }
  })
}

module.exports = { register, maintain, maintainVisible, applyOps, readMap, writeMap, ensureImpl, ensureAllImpl, projectDigest }
