import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startFakeAI, sleep } from '../harness.mjs'
import { selectTask, ensureTask } from './_helpers.mjs'

let server = null

// 基础功能网络（首次全量生成内容，pay 内联实现逻辑）
const FM_NODES = [
  { id: 'login', parent: '', title: '登录', desc: '建立会话', type: 'security', status: 'done', kind: 'step', reads: ['Redis 会话缓存', 'user 表'], writes: ['Redis 会话缓存'] },
  { id: 'has-login', parent: '', title: '是否已登录？', type: 'service', status: 'done', kind: 'decision' },
  { id: 'order', parent: '', title: '下单', desc: '创建订单', type: 'backend', status: 'doing', kind: 'step' },
  { id: 'pay', parent: '', title: '支付', desc: '收单', type: 'backend', status: 'done', kind: 'step', reads: ['order 表'], writes: ['pay_record 表'], impl: {
    nodes: [
      { id: 'p1', title: '接收支付请求', type: 'backend', kind: 'step', reads: ['order 表'] },
      { id: 'p2', title: '支付是否成功？', type: 'service', kind: 'decision' },
      { id: 'p3', title: '写支付流水', type: 'backend', kind: 'step', writes: ['pay_record 表'] }
    ],
    edges: [
      { from: 'p1', to: 'p2', label: '发起支付', kind: 'process' },
      { from: 'p2', to: 'p3', label: '是', kind: 'process', variant: 'emphasis' },
      { from: 'p3', to: 'p2', label: '流水', kind: 'data' }
    ]
  } },
  { id: 'home', parent: '', title: '首页', desc: '浏览', type: 'frontend', status: 'done', kind: 'step' },
  { id: 'cart', parent: 'order', title: '加入购物车', type: 'frontend', status: 'done', kind: 'step' },
  { id: 'checkout', parent: 'order', title: '结算', type: 'backend', status: 'doing', kind: 'step', reads: ['Redis 购物车'], writes: ['order 表'] },
  { id: 'has-stock', parent: 'order', title: '库存充足？', type: 'service', status: 'done', kind: 'decision' },
  { id: 'book', parent: 'order', title: '锁定库存', type: 'backend', status: 'todo', kind: 'step' },
  { id: 'reconcile', parent: 'order', title: '每日对账', type: 'cron', status: 'done', kind: 'step', reads: ['order 表', 'pay_record 表'], writes: ['对账结果文件'] },
  { id: 'book-reserve', parent: 'book', title: '预占库存', type: 'backend', status: 'doing', kind: 'step', reads: ['stock 表'], writes: ['stock 表'] }
]
const FM_EDGES = [
  { from: 'login', to: 'has-login', label: '', kind: 'process' },
  { from: 'has-login', to: 'order', label: '是', kind: 'process', variant: 'emphasis' },
  { from: 'has-login', to: 'home', label: '否', kind: 'process' },
  { from: 'order', to: 'pay', label: '', kind: 'process' },
  { from: 'order', to: 'pay', label: '订单数据', kind: 'data' },
  { from: 'cart', to: 'checkout', label: '', kind: 'process' },
  { from: 'checkout', to: 'has-stock', label: '', kind: 'process' },
  { from: 'has-stock', to: 'book', label: '是', kind: 'process' },
  { from: 'book', to: 'reconcile', label: '扣减结果', kind: 'data' }
]

// 首次全量生成 → 一组 add 补丁
function fullOps() {
  return {
    update: true,
    reason: '生成登录到下单的端到端流程',
    ops: [
      ...FM_NODES.map((node) => ({ op: 'add', node })),
      ...FM_EDGES.map((edge) => ({ op: 'add', edge }))
    ]
  }
}
// 网络已存在时的增量补丁：新增导出、把「下单」标记完成
const PATCH_OPS = {
  update: true,
  reason: '新增导出订单、下单已落库',
  ops: [
    { op: 'add', node: { id: 'export', parent: 'order', title: '导出订单', type: 'backend', status: 'todo', kind: 'step', reads: ['order 表'], writes: ['对象存储 bucket'] } },
    { op: 'update', id: 'order', patch: { status: 'done', desc: '创建订单并落库' } },
    { op: 'add', edge: { from: 'order', to: 'export', label: '导出', kind: 'process' } }
  ]
}
const IMPL_RESULT = {
  update: true,
  impl: {
    nodes: [
      { id: 'p1', title: '接收支付请求', type: 'backend', kind: 'step' },
      { id: 'p2', title: '支付是否成功？', type: 'service', kind: 'decision' },
      { id: 'p3', title: '写支付流水', type: 'backend', kind: 'step' }
    ],
    edges: [
      { from: 'p1', to: 'p2', kind: 'process' },
      { from: 'p2', to: 'p3', label: '是', kind: 'process' },
      { from: 'p3', to: 'p2', label: '流水', kind: 'data' }
    ]
  }
}

async function ensureServer(app) {
  if (server) return server
  server = await startFakeAI({
    respond(body) {
      const msgs = (body && body.messages) || []
      const sys = String((msgs[0] && msgs[0].content) || '')
      const all = msgs.map((m) => String(m.content || '')).join('\n')
      if (sys.includes('功能网络」维护器')) {
        return JSON.stringify(all.includes('当前功能网络：（空') ? fullOps() : PATCH_OPS)
      }
      if (sys.includes('实现逻辑流程图')) return JSON.stringify(IMPL_RESULT)
      return ['执行结果：', '已完成。']
    }
  })
  const pid = await app.store('providers.upsert', { provider: { name: 'FM提供方', type: 'openai_compatible', base_url: server.url } })
  await app.store('models.upsert', { model: { name: 'FM模型', model_id: 'fm-1', type: 'openai_compatible', base_url: server.url, provider_id: pid, is_default: 1 } })
  await app.invoke('secrets', 'set', { key: 'zzwork.key.provider.' + pid, value: 'sk-fm' })
  return server
}

async function codeTask(app, name) {
  await ensureServer(app)
  await ensureTask(app, name)
  const cur = (await app.store('tasks.list')).find((x) => x.name === name)
  await app.store('tasks.update', { id: cur.id, patch: { type: 'code', agent_id: 'builtin', model_id: '' } })
  const t = (await app.store('tasks.list')).find((x) => x.id === cur.id)
  return { t, mapPath: path.join(t.path, '.zzwork', 'feature-map.json') }
}

async function waitRun(app, runId, timeout = 20000) {
  await app.waitFor(`(async () => {
    const r = await window.zzwork.invoke('store', 'runs.get', { id: ${JSON.stringify(runId)} })
    return !!(r && r.status !== 'running')
  })()`, timeout, '运行结束 ' + runId)
  return app.store('runs.get', { id: runId })
}

// SVG 命中点击：测量与派发之间有多次 CDP 往返，全量负载下 ResizeObserver 触发的
// fitView 可能在此期间重排导致点空；重试直到面包屑命中目标文案。
async function drillInto(app, selector, needle, tries = 6) {
  for (let i = 0; i < tries; i++) {
    await app.clickEl(selector)
    const hit = await app.eval(`document.getElementById('fmTitle').textContent.includes(${JSON.stringify(needle)})`)
    if (hit) return true
    await sleep(200)
  }
  return false
}

export default [
  {
    name: '功能图生成、读取与清空',
    async run(app) {
      const { t, mapPath } = await codeTask(app, '功能图任务')

      // 功能图依据最近对话维护：先产生一轮对话
      const info = await app.invoke('chat', 'init', { taskId: t.id, sessionId: '' })
      const sent = await app.invoke('chat', 'send', { taskId: t.id, text: '实现登录页与鉴权服务', sessionId: info.session.id })
      await waitRun(app, sent.runId)

      const r = await app.invoke('featuremap', 'updateNow', { taskId: t.id })
      assert.ok(r && r.ok && r.updated, JSON.stringify(r))
      assert.ok(fs.existsSync(mapPath), '功能图应写入 .zzwork/feature-map.json')

      const map = await app.invoke('featuremap', 'get', { taskId: t.id })
      assert.equal(map.nodes.length, 11, '应有 11 个节点')
      assert.ok(map.nodes.some((n) => n.parent === 'order'), '应有下钻子功能')
      assert.ok(map.nodes.some((n) => n.kind === 'decision'), '应有判断节点')
      assert.ok(map.nodes.some((n) => n.type === 'cron'), '应有定时任务节点')
      assert.ok(map.nodes.some((n) => n.parent === 'book'), '应有第三层子功能')
      assert.ok(map.edges.some((e) => e.kind === 'data'), '应有数据流边')
      const login = map.nodes.find((n) => n.id === 'login')
      assert.ok(login && Array.isArray(login.reads) && login.reads.includes('Redis 会话缓存'), '节点应带数据来源 reads')
      assert.ok(login && Array.isArray(login.writes) && login.writes.includes('Redis 会话缓存'), '节点应带数据存储 writes')
      const pay = map.nodes.find((n) => n.id === 'pay')
      assert.ok(pay && pay.impl && pay.impl.nodes.length === 3, '叶子功能应带实现逻辑子图 impl')

      // 辅助调用应在对话里以 aux 卡片呈现
      const auxMsgs = await app.store('messages.list', { taskId: t.id })
      assert.ok(auxMsgs.some((m) => m.kind === 'aux' && String(m.meta || '').includes('功能网络')), '应有功能网络更新卡片')

      await selectTask(app, '功能图任务')
      await app.click('.tab[data-pane="session"]')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-node').length === 4`, 8000, '顶层节点渲染')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-dec').length === 1`, 8000, '判断节点渲染')
      await app.waitFor(`document.querySelectorAll('#fmRoot path.fm-edge.data').length >= 1`, 8000, '数据流边渲染')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-prov').length >= 1`, 8000, '数据来源/存储渲染')

      // 下钻「下单」看小功能与内部流程（含定时任务）
      await app.clickEl('#fmRoot .fm-node[data-id="order"]')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-node').length === 4`, 8000, '子功能渲染')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-dec').length === 1`, 8000, '子流程判断渲染')
      await app.waitFor(`(() => { const b = document.querySelector('#fmBack'); return !!b && !b.classList.contains('hidden') })()`, 4000, '返回按钮出现')

      // 再下钻「锁定库存」看第三层（一层一层展开）
      await app.clickEl('#fmRoot .fm-node[data-id="book"]')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-node').length === 1`, 8000, '第三层子功能渲染')
      await app.waitFor(`document.getElementById('fmTitle').textContent.includes('锁定库存')`, 4000, '面包屑显示第三层')

      // 返回：逐层回退
      await app.clickEl('#fmBack')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-node').length === 4`, 8000, '回到下单层')
      await app.clickEl('#fmBack')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-node').length === 4`, 8000, '返回顶层')

      // 点击叶子功能「支付」→ 下钻展示其实现逻辑流程图
      await app.clickEl('#fmRoot .fm-node[data-id="pay"]')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-node').length === 2`, 8000, '实现逻辑步骤渲染')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-dec').length === 1`, 8000, '实现逻辑判断渲染')
      await app.waitFor(`document.getElementById('fmTitle').textContent.includes('支付')`, 4000, '面包屑显示支付实现逻辑')
      await app.clickEl('#fmBack')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-node').length === 4`, 8000, '从实现逻辑返回顶层')

      const cleared = await app.invoke('featuremap', 'clear', { taskId: t.id })
      assert.ok(cleared && cleared.ok)
      const empty = await app.invoke('featuremap', 'get', { taskId: t.id })
      assert.equal(empty.nodes.length, 0, '清空后无节点')
    }
  },
  {
    name: 'v1 旧图按 group 升级为大功能域',
    async run(app) {
      const { t, mapPath } = await codeTask(app, '功能图旧版任务')
      fs.mkdirSync(path.join(t.path, '.zzwork'), { recursive: true })
      fs.writeFileSync(mapPath, JSON.stringify({
        v: 1,
        task: t.name,
        nodes: [
          { id: 'a', title: '模块A', group: '域一' },
          { id: 'b', title: '模块B', group: '域一' },
          { id: 'c', title: '模块C', group: '域二' }
        ],
        edges: [{ from: 'a', to: 'c', label: '依赖' }]
      }))

      // 迁移：group 升级为顶层大功能域，成员挂到域下
      const map = await app.invoke('featuremap', 'get', { taskId: t.id })
      assert.equal(map.nodes.length, 5, '应合成 2 个域 + 3 个成员')
      assert.equal(map.nodes.filter((n) => !n.parent).length, 2, '应有 2 个顶层域')
      assert.ok(map.nodes.some((n) => n.parent === '域一'), '成员应挂到大功能域下')

      await selectTask(app, '功能图旧版任务')
      await app.click('.tab[data-pane="session"]')
      // 根层：两个大功能域 + 域间流程
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-node').length === 2`, 8000, '旧图域名渲染')
      const w = await app.eval(`(() => { const n = document.querySelector('#fmRoot .fm-node'); return n ? n.getBoundingClientRect().width : 0 })()`)
      assert.ok(w > 0, '兜底布局节点应有可见宽度，实际 ' + w)
      await app.waitFor(`document.querySelectorAll('#fmRoot path.fm-edge').length >= 1`, 8000, '域间连线渲染')

      // 下钻域一：看到成员 a、b
      const drilled = await drillInto(app, '#fmRoot .fm-node[data-id="域一"]', '域一')
      assert.ok(drilled, '面包屑显示域一')
      await app.waitFor(`document.querySelectorAll('#featureMapHost .fm-node').length === 2`, 8000, '域一成员渲染')
      await app.waitFor(`document.getElementById('fmTitle').textContent.includes('域一')`, 4000, '面包屑显示域一')
    }
  },
  {
    name: '画板摘要随下一次消息注入',
    async run(app) {
      const { t } = await codeTask(app, '画板注入任务')
      const info = await app.invoke('chat', 'init', { taskId: t.id, sessionId: '' })
      const sid = info.session.id

      // 画板有内容（v2 结构化），且未发送（canvasSent 为空）
      const canvas = {
        v: 2,
        shapes: [
          { id: 's1', type: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.14, text: '登录页' },
          { id: 's2', type: 'note', x: 0.4, y: 0.1, w: 0.2, h: 0.12, text: '需要重试机制' }
        ],
        edges: [{ id: 'e1', from: 's1', to: 's2', label: '调用' }]
      }
      await app.store('settings.set', { key: 'session:canvas:' + t.id, value: JSON.stringify(canvas) })

      const before = server.requests.length
      const sent = await app.invoke('chat', 'send', { taskId: t.id, text: '看看画板', sessionId: sid })
      await waitRun(app, sent.runId)

      // 画板摘要作为「易变尾部」拼到最后一条用户消息（而非 system，保 system 稳定命中缓存）
      const textOf = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))
      const req = server.requests.slice(before).find((r) => {
        const msgs = (r && r.messages) || []
        return msgs.some((m) => textOf(m).includes('【画板'))
      })
      assert.ok(req, '请求应携带画板摘要')
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
      const tail = textOf(lastUser)
      assert.ok(tail.includes('登录页') && tail.includes('需要重试机制'), tail)
    }
  },
  {
    name: '空状态点「立即生成」可用',
    async run(app) {
      const { t } = await codeTask(app, '功能图空任务')
      const info = await app.invoke('chat', 'init', { taskId: t.id, sessionId: '' })
      const sent = await app.invoke('chat', 'send', { taskId: t.id, text: '实现登录页', sessionId: info.session.id })
      await waitRun(app, sent.runId)
      await app.invoke('featuremap', 'clear', { taskId: t.id })

      await selectTask(app, '功能图空任务')
      await app.click('.tab[data-pane="session"]')
      await app.waitFor(`(() => { const e = document.querySelector('#fmEmpty'); return !!e && !e.classList.contains('hidden') })()`, 8000, '空状态出现')
      await app.clickEl('#fmEmptyGen')
      await app.waitFor(`(async () => {
        const m = await window.zzwork.invoke('featuremap', 'get', { taskId: ${JSON.stringify(t.id)} })
        return !!(m && m.nodes && m.nodes.length >= 2)
      })()`, 20000, '点击后生成功能图')
    }
  },
  {
    name: '功能图基于整个代码项目（无需对话）',
    async run(app) {
      const { t } = await codeTask(app, '功能图项目任务')
      // 在工作区写入若干源码文件，模拟真实代码项目
      const srcDir = path.join(t.path, 'src', 'auth')
      fs.mkdirSync(srcDir, { recursive: true })
      fs.writeFileSync(path.join(srcDir, 'login.js'), 'export function login() { /* 登录鉴权 */ }\n')
      fs.writeFileSync(path.join(t.path, 'README.md'), '# 演示项目\n负责登录与鉴权。\n')

      // 不产生任何对话，直接依据代码项目生成
      const before = server.requests.length
      const r = await app.invoke('featuremap', 'updateNow', { taskId: t.id })
      assert.ok(r && r.ok && r.updated, JSON.stringify(r))

      const req = server.requests.slice(before).find((x) =>
        ((x.messages || []).some((m) => String(m.content || '').includes('项目文件树')))
      )
      assert.ok(req, '请求应携带代码项目摘要')
      const all = (req.messages || []).map((m) => String(m.content || '')).join('\n')
      assert.ok(all.includes('src/auth/login.js'), '项目摘要应包含源码文件树')
      assert.ok(all.includes('README.md'), '项目摘要应包含关键文件')
    }
  },
  {
    name: '功能图与画板可全屏',
    async run(app) {
      await codeTask(app, '全屏任务')
      await selectTask(app, '全屏任务')
      await app.click('.tab[data-pane="session"]')

      // 功能图全屏切换
      await app.waitFor(`!!document.querySelector('#fmFullscreen')`, 8000, '功能图全屏按钮存在')
      await app.waitFor(`document.getElementById('fmTitle').textContent.includes('全屏任务')`, 8000, '功能图顶部显示任务名')
      await app.clickEl('#fmFullscreen')
      await app.waitFor(`document.getElementById('featureMapHost').classList.contains('zz-fullscreen')`, 8000, '功能图进入全屏')
      await app.clickEl('#fmFullscreen')
      await app.waitFor(`!document.getElementById('featureMapHost').classList.contains('zz-fullscreen')`, 8000, '功能图退出全屏')

      // 画板全屏切换
      await app.click('#rightSeg [data-panel="board"]')
      await app.waitFor(`!!document.querySelector('#bdFullscreen')`, 8000, '画板全屏按钮存在')
      await app.waitFor(`document.getElementById('bdTitle').textContent.includes('全屏任务')`, 8000, '画板顶部显示任务名')
      await app.clickEl('#bdFullscreen')
      await app.waitFor(`document.getElementById('boardHost').classList.contains('zz-fullscreen')`, 8000, '画板进入全屏')
      await app.clickEl('#bdFullscreen')
      await app.waitFor(`!document.getElementById('boardHost').classList.contains('zz-fullscreen')`, 8000, '画板退出全屏')
    }
  },
  {
    name: '增量补丁更新功能网络（可见卡片 + 系统注入）',
    async run(app) {
      const { t } = await codeTask(app, '补丁任务')
      fs.mkdirSync(path.join(t.path, 'src'), { recursive: true })
      fs.writeFileSync(path.join(t.path, 'src', 'order.js'), 'export function order() { /* 下单 */ }\n')
      await app.invoke('featuremap', 'clear', { taskId: t.id })

      // 首次全量生成
      const r1 = await app.invoke('featuremap', 'updateNow', { taskId: t.id })
      assert.ok(r1 && r1.updated, JSON.stringify(r1))
      let map = await app.invoke('featuremap', 'get', { taskId: t.id })
      assert.ok(map.nodes.some((n) => n.id === 'login'), '首次应生成基础网络')
      assert.ok(!map.nodes.some((n) => n.id === 'export'), '首次不应有 export')

      // 增量补丁：新增 export、更新 order
      const r2 = await app.invoke('featuremap', 'updateNow', { taskId: t.id })
      assert.ok(r2 && r2.updated, JSON.stringify(r2))
      map = await app.invoke('featuremap', 'get', { taskId: t.id })
      assert.ok(map.nodes.some((n) => n.id === 'export'), '补丁应新增 export 节点')
      const order = map.nodes.find((n) => n.id === 'order')
      assert.equal(order.status, 'done', '补丁应把下单标记为 done')
      assert.ok(String(order.desc).includes('落库'), '补丁应更新下单描述')
      assert.ok(map.edges.some((e) => e.from === 'order' && e.to === 'export'), '补丁应新增落库→导出边')

      // 维护过程应以 aux 卡片出现在对话里
      const msgs = await app.store('messages.list', { taskId: t.id })
      assert.ok(msgs.some((m) => m.kind === 'aux' && String(m.meta || '').includes('功能网络')), '应有功能网络更新卡片')

      // 功能网络摘要应注入对话 system prompt（基于功能编程）
      const info = await app.invoke('chat', 'init', { taskId: t.id, sessionId: '' })
      const before = server.requests.length
      const sent = await app.invoke('chat', 'send', { taskId: t.id, text: '看看功能网络', sessionId: info.session.id })
      await waitRun(app, sent.runId)
      const chatReq = server.requests.slice(before).find((x) =>
        String((x.messages && x.messages[0] && x.messages[0].content) || '').includes('zzwork 工作助手')
      )
      assert.ok(chatReq, '应有对话请求')
      assert.ok(String(chatReq.messages[0].content).includes('【功能网络】'), 'system prompt 应注入功能网络')
    }
  },
  {
    name: '一键补全全部实现逻辑',
    async run(app) {
      const { t } = await codeTask(app, '补全任务')
      fs.mkdirSync(path.join(t.path, 'src'), { recursive: true })
      fs.writeFileSync(path.join(t.path, 'src', 'a.js'), 'export const a = 1\n')
      await app.invoke('featuremap', 'clear', { taskId: t.id })
      await app.invoke('featuremap', 'updateNow', { taskId: t.id })

      const r = await app.invoke('featuremap', 'implAll', { taskId: t.id })
      assert.ok(r && r.ok, JSON.stringify(r))
      assert.ok(r.total >= 1, '应有待补全的叶子功能')
      assert.ok(r.done >= 1, '应至少补全一个实现逻辑')

      const map = await app.invoke('featuremap', 'get', { taskId: t.id })
      const withImpl = map.nodes.filter((n) => n.impl && Array.isArray(n.impl.nodes) && n.impl.nodes.length)
      assert.ok(withImpl.length >= 2, '补全后应有多个叶子具备实现逻辑')
    }
  }
]
