import assert from 'node:assert/strict'
import { startFakeAI, sleep } from '../harness.mjs'

const ctx = { ready: false, modelId: '', server: null }

async function ensureAI(app) {
  if (ctx.ready) return
  ctx.server = await startFakeAI({
    delay: 150,
    respond(body) {
      const msgs = (body && body.messages) || []
      const joined = msgs.map((m) => String(m.content || '')).join('\n')
      if (joined.includes('追问题目')) return ['这是对追问的回答：', '可以这样继续推进。']
      return ['已根据标题与内容作答：', '建议先拆解为三步。']
    }
  })
  const pid = await app.store('providers.upsert', {
    provider: { name: '看板测试提供方', type: 'openai_compatible', base_url: ctx.server.url }
  })
  await app.store('models.upsert', {
    model: { name: '看板测试模型', model_id: 'board-1', type: 'openai_compatible', base_url: ctx.server.url, provider_id: pid, is_default: 0 }
  })
  const m = (await app.store('models.list')).find((x) => x.name === '看板测试模型')
  ctx.modelId = m && m.id
  await app.invoke('secrets', 'set', { key: 'zzwork.key.provider.' + pid, value: 'sk-board' })
  await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: '', skillExclude: [], mcpExclude: [] })
  ctx.ready = true
}

async function waitRun(app, runId, timeout = 20000) {
  await app.waitFor(`(async () => {
    const r = await window.zzwork.invoke('store', 'runs.get', { id: ${JSON.stringify(runId)} })
    return !!(r && r.status !== 'running')
  })()`, timeout, '运行结束 ' + runId)
  return app.store('runs.get', { id: runId })
}

const boardList = (app) => app.invoke('board', 'list')

// 模拟 HTML5 拖拽：dragstart(卡片) → dragover(目标列) → drop(目标列)
async function dragCard(app, id, col) {
  return app.call((cid, target) => {
    const cardEl = document.querySelector(`.bcard[data-card="${cid}"]`)
    const colEl = document.querySelector(`.bcol[data-col="${target}"]`)
    if (!cardEl || !colEl) return false
    const bodyEl = colEl.querySelector('.bcolb')
    const dt = new DataTransfer()
    const fire = (type, el) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    fire('dragstart', cardEl)
    fire('dragover', bodyEl)
    fire('drop', bodyEl)
    fire('dragend', cardEl)
    return true
  }, id, col)
}

export default [
  {
    name: '看板入口位于项目与环境之间',
    async run(app) {
      await app.click('.abi[data-view="projects"]')
      const order = await app.call(() => [...document.querySelectorAll('.abi[data-view]')].map((b) => b.getAttribute('data-view')))
      const p = order.indexOf('projects')
      const b = order.indexOf('board')
      const e = order.indexOf('envs')
      assert.ok(p >= 0 && b > p && e > b, '看板应位于项目与环境之间：' + JSON.stringify(order))
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => document.querySelector('#pane-board').classList.contains('on'), 5000, '看板 pane 打开')
    }
  },
  {
    name: '看板配置：模型/执行体/Skills/MCP 可保存',
    async run(app) {
      await ensureAI(app)
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => document.querySelector('#pane-board').classList.contains('on'))
      // 基本信息配置常驻侧栏（不再有独立的配置 tab）
      await app.waitFor(() => !!document.querySelector('#boardModelSel'), 5000, '模型下拉出现')
      assert.ok(await app.exists('#boardAgentSel'), '执行体下拉')
      assert.ok(await app.exists('#boardSkillToggles'), 'Skills 区')
      assert.ok(await app.exists('#boardMcpToggles'), 'MCP 区')
      // 通过 IPC 保存并回读
      await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: 'builtin', skillExclude: ['s1'], mcpExclude: ['m1'] })
      const cfg = await app.invoke('board', 'config')
      assert.equal(cfg.model_id, ctx.modelId)
      assert.equal(cfg.agent_id, 'builtin')
      assert.deepEqual(cfg.skillExclude, ['s1'])
      assert.deepEqual(cfg.mcpExclude, ['m1'])
      // 复位为不裁剪，避免影响后续用例
      await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: '', skillExclude: [], mcpExclude: [] })
    }
  },
  {
    name: '新建卡片(未开始) 可编辑标题与内容',
    async run(app) {
      await ensureAI(app)
      const card = await app.invoke('board', 'create', { title: '写周报', content: '整理本周进展与风险' })
      assert.equal(card.scope, 'board', '卡片 scope 应为 board')
      assert.equal(card.status, 'todo', '新卡片应为未开始')
      const list = await boardList(app)
      assert.ok(list.some((c) => c.id === card.id && c.name === '写周报'), '看板列表应包含卡片')

      // 打开看板，卡片渲染在“未开始”列
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      await app.waitFor(`[...document.querySelectorAll('.bcol[data-col="todo"] .bcard')].some(e=>e.textContent.includes('写周报'))`, 8000, '卡片渲染在未开始列')
      // 卡片不应出现在项目树
      assert.equal(await app.call(() => [...document.querySelectorAll('.row[data-task]')].some((r) => r.textContent.includes('写周报'))), false, '看板卡片不应出现在项目树')

      // 点击卡片修改标题与内容（卡片无按钮，整卡可点）
      await app.call(() => {
        const card = [...document.querySelectorAll('.bcard')].find((e) => e.textContent.includes('写周报'))
        if (card) card.click()
        return true
      })
      await app.waitFor(() => !!document.querySelector('#bcTitle'), 5000, '编辑弹窗出现')
      await app.setValue('#bcTitle', '写月报')
      await app.setValue('#bcContent', '汇总本月目标完成度')
      await app.click('.bmodal [data-act="save"]')
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('board', 'list')
        const c = l.find((x) => x.id === ${JSON.stringify(card.id)})
        return !!(c && c.name === '写月报' && c.meta && c.meta.content.includes('本月目标'))
      })()`, 8000, '卡片编辑已保存')
    }
  },
  {
    name: '未开始列内可直接新建临时任务（名称+详情）',
    async run(app) {
      await ensureAI(app)
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      // 未开始列底部有「新建任务」入口
      await app.waitFor(() => !!document.querySelector('.bcol[data-col="todo"] .baddcard[data-newcard]'), 5000, '未开始列新建入口')
      await app.click('.bcol[data-col="todo"] .baddcard[data-newcard]')
      await app.waitFor(() => !!document.querySelector('#bcTitle'), 5000, '新建任务弹窗')
      // 弹窗内应有任务名称/任务详情字段标签
      const labels = await app.call(() => [...document.querySelectorAll('.bmodal .blab')].map((e) => e.textContent.trim()))
      assert.ok(labels.includes('任务名称') && labels.includes('任务详情'), '应显示任务名称与任务详情：' + JSON.stringify(labels))
      await app.setValue('#bcTitle', '临时任务：校验登录')
      await app.setValue('#bcContent', '验证登录流程在弱网下是否正常')
      await app.click('.bmodal [data-act="save"]')
      // 新卡片出现在未开始列
      await app.waitFor(`[...document.querySelectorAll('.bcol[data-col="todo"] .bcard')].some(e=>e.textContent.includes('临时任务：校验登录'))`, 8000, '新卡片出现在未开始列')
      // 落库：scope=board、status=todo、含详情
      const l = await boardList(app)
      const c = l.find((x) => x.name === '临时任务：校验登录')
      assert.ok(c, '看板列表应包含新任务')
      assert.equal(c.scope, 'board', '新任务 scope 应为 board')
      assert.equal(c.status, 'todo', '新任务应为未开始')
      assert.ok(c.meta && String(c.meta.content).includes('弱网'), '任务详情应保存')
    }
  },
  {
    name: '拖动：未开始→进行中（开始作答）→待审核→已完成',
    async run(app) {
      await ensureAI(app)
      await app.call(() => { document.querySelectorAll('.zz-modal-mask').forEach((m) => m.remove()); return true })
      const card = await app.invoke('board', 'create', { title: '拖拽任务', content: '拖到进行中开始作答' })
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      await app.waitFor(`[...document.querySelectorAll('.bcol[data-col="todo"] .bcard')].some(e=>e.textContent.includes('拖拽任务'))`, 8000, '卡片在未开始列')
      // 未开始 → 进行中：触发开始（AI 作答）
      await dragCard(app, card.id, 'doing')
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('board', 'list')
        const c = l.find((x) => x.id === ${JSON.stringify(card.id)})
        return !!(c && c.status === 'review')
      })()`, 20000, '拖到进行中后 AI 作答完成进入待审核')
      // 关闭拖拽开始弹出的会话弹窗，等待卡片渲染到待审核列
      await app.call(() => { document.querySelectorAll('.zz-modal-mask').forEach((m) => m.remove()); return true })
      await app.waitFor(`[...document.querySelectorAll('.bcol[data-col="review"] .bcard')].some(e=>e.textContent.includes('拖拽任务'))`, 8000, '卡片在待审核列')
      // 待审核 → 已完成
      await dragCard(app, card.id, 'done')
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('board', 'list')
        const c = l.find((x) => x.id === ${JSON.stringify(card.id)})
        return !!(c && c.status === 'done')
      })()`, 8000, '待审核拖到已完成')
      await app.waitFor(`[...document.querySelectorAll('.bcol[data-col="done"] .bcard')].some(e=>e.textContent.includes('拖拽任务'))`, 8000, '卡片在已完成列')
    }
  },
  {
    name: '开始卡片→进行中 AI 作答→待审核→追问→已完成',
    async run(app) {
      await ensureAI(app)
      const card = await app.invoke('board', 'create', { title: '方案评审', content: '帮我梳理评审要点' })
      const started = await app.invoke('board', 'start', { id: card.id })
      assert.ok(started.sessionId, '应创建会话')
      // 开始后立即处于进行中（AI 作答中）
      const startedCard = (await boardList(app)).find((c) => c.id === card.id)
      assert.equal(startedCard.status, 'doing', '开始后应为进行中')
      if (started.runId) await waitRun(app, started.runId)
      // AI 作答完成 → 自动进入待审核
      const reviewed = (await boardList(app)).find((c) => c.id === card.id)
      assert.equal(reviewed.status, 'review', 'AI 作答完成后应进入待审核')

      // UI：卡片渲染在「待审核」列
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      await app.waitFor(`[...document.querySelectorAll('.bcol[data-col="review"] .bcard')].some((e) => e.textContent.includes('方案评审'))`, 8000, '卡片渲染在待审核列')

      let msgs = await app.store('messages.list', { taskId: card.id, sessionId: started.sessionId })
      assert.ok(msgs.some((m) => m.role === 'assistant' && String(m.content).includes('作答')), 'AI 应作答')
      const before = msgs.length

      // 追问：立刻回到进行中，作答完成后再次回到待审核
      const follow = await app.invoke('board', 'send', { id: card.id, sessionId: started.sessionId, text: '追问题目：下一步怎么做' })
      const backDoing = (await boardList(app)).find((c) => c.id === card.id)
      assert.equal(backDoing.status, 'doing', '追问后应回到进行中')
      if (follow && follow.runId) await waitRun(app, follow.runId)
      const reviewed2 = (await boardList(app)).find((c) => c.id === card.id)
      assert.equal(reviewed2.status, 'review', '追问作答完成后应回到待审核')
      msgs = await app.store('messages.list', { taskId: card.id, sessionId: started.sessionId })
      assert.ok(msgs.length > before, '追问应新增消息')
      assert.ok(msgs.some((m) => String(m.content).includes('追问的回答')), '追问应得到回答')

      // 审核通过 → 已完成
      await app.invoke('board', 'finish', { id: card.id })
      const done = (await boardList(app)).find((c) => c.id === card.id)
      assert.equal(done.status, 'done', '完成后应为已完成')
    }
  },
  {
    name: '便签归类“短期”落到看板卡片',
    async run(app) {
      await ensureAI(app)
      const before = (await boardList(app)).length
      const r = await app.invoke('inbox', 'apply', {
        items: [{ action: 'new', scope: 'short', name: '临时查个接口', type: 'work', text: '临时查个接口返回格式' }],
        execute: true
      })
      const ok = r.results.find((x) => x.ok)
      assert.ok(ok && ok.scope === 'short', JSON.stringify(r.results))
      assert.equal(ok.sessionId, '', '短期卡片不立即开会话/执行')
      const list = await boardList(app)
      assert.equal(list.length, before + 1, '看板应新增卡片')
      const card = list.find((c) => c.id === ok.taskId)
      assert.equal(card.scope, 'board')
      assert.equal(card.status, 'todo')
      assert.ok(String(card.meta.content).includes('返回格式'))
    }
  },
  {
    name: '打开卡片：实时显示思考过程（与 AI 对话一致）',
    async run(app) {
      await ensureAI(app)
      // 专用慢速假 AI：先输出思考，再流式作答
      const server = await startFakeAI({ thinking: ['先分析需求'], chunks: ['这是', '最终答复'], delay: 300 })
      const pid = await app.store('providers.upsert', {
        provider: { name: '思考提供方', type: 'openai_compatible', base_url: server.url }
      })
      await app.store('models.upsert', {
        model: { name: '思考模型', model_id: 'think-1', type: 'openai_compatible', base_url: server.url, provider_id: pid, is_default: 0 }
      })
      const m = (await app.store('models.list')).find((x) => x.name === '思考模型')
      await app.invoke('secrets', 'set', { key: 'zzwork.key.provider.' + pid, value: 'sk-think' })
      await app.invoke('board', 'saveConfig', { model_id: m.id, agent_id: '', skillExclude: [], mcpExclude: [] })

      const card = await app.invoke('board', 'create', { title: '思考任务', content: '需要先思考' })
      await app.invoke('board', 'start', { id: card.id })
      // 打开卡片弹窗（进行中，实时订阅）
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      await app.waitFor(`[...document.querySelectorAll('.bcard')].some(e=>e.textContent.includes('思考任务'))`, 8000, '卡片出现')
      await app.call(() => {
        const c = [...document.querySelectorAll('.bcard')].find((e) => e.textContent.includes('思考任务'))
        if (c) c.click()
        return true
      })
      // 弹窗内出现思考块（实时/快照），并流式显示作答内容
      await app.waitFor(`[...document.querySelectorAll('#bcMsgs .bthink .bthink-t')].some(e=>e.textContent.includes('先分析需求'))`, 15000, '思考过程显示')
      await app.waitFor(`[...document.querySelectorAll('#bcMsgs .bmsg.a .md')].some(e=>e.textContent.includes('最终答复'))`, 15000, '作答内容实时显示')
      // 收尾：关闭弹窗、恢复看板配置
      await app.call(() => { document.querySelectorAll('.zz-modal-mask').forEach((x) => x.remove()); return true })
      await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: '', skillExclude: [], mcpExclude: [] })
      try { await server.close() } catch {}
    }
  },
  {
    name: '收尾：回到项目视图',
    async run(app) {
      await app.call(() => {
        document.querySelectorAll('.zz-modal-mask').forEach((m) => m.remove())
        return true
      })
      await app.click('.abi[data-view="projects"]')
      await app.call(() => {
        const row = document.querySelector('.row[data-task]')
        if (row) row.click()
        return true
      })
      await sleep(150)
    }
  }
]
