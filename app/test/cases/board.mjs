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
  await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: 'builtin', skillExclude: [], mcpExclude: [] })
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
    name: '从看板切到项目：右栏大块同步切走，不残留看板（回归）',
    async run(app) {
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => document.querySelector('#pane-board').classList.contains('on'), 5000, '看板 pane 打开')
      await app.click('.abi[data-view="projects"]')
      await app.waitFor(() => !document.querySelector('#pane-board').classList.contains('on'), 5000, '离开看板后 pane-board 应关闭')
      const tabs = await app.call(() => document.querySelector('#tabbar').textContent)
      assert.ok(!tabs.includes('看板'), '离开看板后 tab 条不应残留看板：' + tabs)
      const anyTaskPane = await app.call(() => ['info', 'session', 'ai', 'file'].some((p) => {
        const el = document.getElementById('pane-' + p)
        return !!el && el.classList.contains('on')
      }))
      assert.ok(anyTaskPane, '离开看板后右栏应切回任务工作区')
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
      // 执行体下拉只列本机环境里可用的执行体（外加「自动」空选项）
      const det = await app.invoke('env', 'detect', { id: 'local', kind: 'local' })
      const okIds = new Set((det.list || []).filter((a) => a.ok).map((a) => a.id))
      const opts = await app.call(() => [...document.querySelectorAll('#boardAgentSel option')].map((o) => o.value))
      assert.ok(opts.includes(''), '执行体应有「自动」选项：' + JSON.stringify(opts))
      for (const v of opts.filter(Boolean)) assert.ok(okIds.has(v), '执行体选项应为本机可用执行体，发现不可用项：' + v)
      // 通过 IPC 保存并回读
      await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: 'builtin', skillExclude: ['s1'], mcpExclude: ['m1'] })
      const cfg = await app.invoke('board', 'config')
      assert.equal(cfg.model_id, ctx.modelId)
      assert.equal(cfg.agent_id, 'builtin')
      assert.deepEqual(cfg.skillExclude, ['s1'])
      assert.deepEqual(cfg.mcpExclude, ['m1'])
      // 复位为不裁剪，避免影响后续用例
      await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: 'builtin', skillExclude: [], mcpExclude: [] })
    }
  },
  {
    name: '看板卡片以看板配置执行体为准（残留 builtin 也切到配置的 CLI）',
    async run(app) {
      await ensureAI(app)
      // 看板执行体配置为 claude-code
      await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: 'claude-code', skillExclude: [], mcpExclude: [] })
      // 造一张残留 agent_id='builtin' 的卡片
      const card = await app.invoke('board', 'create', { title: '执行体覆盖', content: '应以 claude-code 作答' })
      const c0 = (await boardList(app)).find((x) => x.id === card.id)
      assert.equal(c0.agent_id, 'builtin', '新建卡片默认落 builtin')
      // 打开任务时解析到的执行体应为配置的 claude-code，而非残留的 builtin
      const info = await app.invoke('chat', 'init', { taskId: card.id })
      assert.equal(info.agentId, 'claude-code', '看板卡片应使用配置的 claude-code，而非残留 builtin')
      // 收尾：复位为 builtin（假 AI 路径）
      await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: 'builtin', skillExclude: [], mcpExclude: [] })
    }
  },
  {
    name: '看板任务禁用交互式提问：不弹 AskUserQuestion，直接完成进待审核（回归）',
    async run(app) {
      // 执行体配成 claude-code（走真实 CLI，假 claude 会在内容含 [[ASK]] 时发起提问请求）
      await app.invoke('board', 'saveConfig', { model_id: '', agent_id: 'claude-code', skillExclude: [], mcpExclude: [] })
      const card = await app.invoke('board', 'create', { title: '看板禁问', content: '[[ASK]]是否删除旧数据，请确认后继续' })
      await app.invoke('board', 'start', { id: card.id })
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      // 关键：看板任务不得卡在提问，应直接完成并进入待审核
      // （若无禁区，[[ASK]] 会触发提问卡片并一直等待回答，status 会停在 doing，下面的 waitFor 会超时）
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('board', 'list')
        const c = l.find((x) => x.id === ${JSON.stringify(card.id)})
        return !!(c && c.status === 'review')
      })()`, 25000, '看板任务应直接完成并进入待审核，而非卡在 AskUserQuestion')
      await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: 'builtin', skillExclude: [], mcpExclude: [] })
    }
  },
  {
    name: '手动停止进行中卡片：终止运行并转入待审核（回归）',
    async run(app) {
      const slow = await startFakeAI({ delay: 5000, respond: () => ['慢速作答不应阻塞停止'] })
      try {
        const pid = await app.store('providers.upsert', { provider: { name: '慢速看板提供方', type: 'openai_compatible', base_url: slow.url } })
        await app.store('models.upsert', { model: { name: '慢速看板模型', model_id: 'board-slow', type: 'openai_compatible', base_url: slow.url, provider_id: pid, is_default: 0 } })
        const slowModel = ((await app.store('models.list')).find((x) => x.name === '慢速看板模型') || {}).id
        await app.invoke('secrets', 'set', { key: 'zzwork.key.provider.' + pid, value: 'sk-slow' })
        await app.invoke('board', 'saveConfig', { model_id: slowModel, agent_id: 'builtin', skillExclude: [], mcpExclude: [] })
        const card = await app.invoke('board', 'create', { title: '可停止任务', content: '这是一个可以手动停止的慢任务' })
        const started = await app.invoke('board', 'start', { id: card.id })
        assert.ok(started.runId, '应启动一个运行')
        await app.waitFor(`(async () => {
          const r = await window.zzwork.invoke('store', 'runs.get', { id: ${JSON.stringify(started.runId)} })
          return !!(r && r.status === 'running')
        })()`, 8000, '运行进入 running')
        const res = await app.invoke('board', 'stop', { id: card.id })
        assert.ok(res && res.ok, '停止应成功')
        const run = await app.store('runs.get', { id: started.runId })
        assert.notEqual(run.status, 'running', '停止后运行不应仍在进行')
        const c = (await boardList(app)).find((x) => x.id === card.id)
        assert.equal(c.status, 'review', '停止后卡片应转入待审核')
      } finally {
        try { await slow.close() } catch {}
        await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: 'builtin', skillExclude: [], mcpExclude: [] })
      }
    }
  },
  {
    name: '应用重启后自动续跑进行中的看板卡片（回归）',
    async run(app) {
      await ensureAI(app)
      const card = await app.invoke('board', 'create', { title: '续跑任务', content: '中断后应自动继续完成' })
      // 模拟被强制退出：状态停在 doing，且已有部分历史
      await app.store('tasks.update', { id: card.id, patch: { status: 'doing' } })
      const sess = await app.invoke('board', 'session', { id: card.id })
      await app.store('messages.add', { taskId: card.id, role: 'user', content: '【任务】续跑任务', opts: { sessionId: sess.sessionId } })
      // 启动时调用的续跑入口
      const n = await app.invoke('board', 'resumeAll')
      assert.ok(n >= 1, '应至少续跑一张进行中卡片：' + n)
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('board', 'list')
        const c = l.find((x) => x.id === ${JSON.stringify(card.id)})
        return !!(c && c.status === 'review')
      })()`, 25000, '续跑完成后自动进入待审核')
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

      // 点击未开始卡片 → 直接打开编辑弹窗（未开始任务不打开 AI 对话标签）
      await app.call(() => {
        const card = [...document.querySelectorAll('.bcard')].find((e) => e.textContent.includes('写周报'))
        if (card) card.click()
        return true
      })
      await app.waitFor(() => !!document.querySelector('#bcTitle'), 5000, '编辑弹窗出现')
      assert.equal(await app.exists('#tabbar .tab[data-pane="card"]'), false, '未开始卡片不打开对话标签')
      await app.setValue('#bcTitle', '写月报')
      await app.setValue('#bcContent', '汇总本月目标完成度')
      await app.click('.bmodal [data-act="save"]')
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('board', 'list')
        const c = l.find((x) => x.id === ${JSON.stringify(card.id)})
        return !!(c && c.name === '写月报' && c.meta && c.meta.content.includes('本月目标'))
      })()`, 8000, '卡片编辑已保存')
      // 仅保存后仍停留在看板，不打开对话标签
      assert.equal(await app.exists('#tabbar .tab[data-pane="card"]'), false, '仅保存不打开对话标签')
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
    name: '打开卡片多开标签：左工作目录 + 右对话，可切换/关闭',
    async run(app) {
      // 复位：离开看板再回来，清空可能残留的卡片标签
      await app.click('.abi[data-view="projects"]')
      const a = await app.invoke('board', 'create', { title: '多开甲', content: '甲的内容' })
      const b = await app.invoke('board', 'create', { title: '多开乙', content: '乙的内容' })
      // 未开始卡片点击是「编辑」而非对话，置为待审核以便验证多开对话标签
      await app.store('tasks.update', { id: a.id, patch: { status: 'review' } })
      await app.store('tasks.update', { id: b.id, patch: { status: 'review' } })
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      await app.waitFor(`!!document.querySelector('.bcard[data-card="${a.id}"]')`, 8000, '甲卡片渲染')
      // 看板页面：左侧栏显示看板配置（模型/执行体），不显示工作目录树
      assert.equal(await app.visible('#boardModelSel'), true, '看板页面左侧显示模型/执行体配置')
      assert.equal(await app.visible('#boardSideFiles'), false, '看板页面不显示卡片工作目录树')
      // 打开甲 → 生成卡片标签 + 左侧栏切换为工作目录树
      await app.call((id) => { const e = document.querySelector(`.bcard[data-card="${id}"]`); if (e) e.click(); return true }, a.id)
      await app.waitFor(() => !!document.querySelector('#tabbar .tab[data-card]'), 5000, '甲标签出现')
      // 打开乙（看板 pane 已隐藏，但节点仍在，程序化点击仍触发）
      await app.call((id) => { const e = document.querySelector(`.bcard[data-card="${id}"]`); if (e) e.click(); return true }, b.id)
      await app.waitFor(`document.querySelectorAll('#tabbar .tab[data-pane="card"]').length === 2`, 5000, '两个卡片标签')
      // 右侧对话区显示乙内容
      await app.waitFor(`(() => { const m = document.querySelector('#bcMsgs'); return !!m && m.textContent.includes('乙的内容') })()`, 5000, '乙对话显示内容')
      // 左侧栏切换为工作目录树：树存在、根名非空；看板配置隐藏
      await app.waitFor(() => !!document.querySelector('#boardSideFiles .treebar'), 5000, '左侧栏工作目录树出现')
      assert.equal(await app.visible('#boardModelSel'), false, '打开卡片后看板配置隐藏')
      const rootName = await app.call(() => { const r = document.querySelector('#boardSideFiles .treebar .root'); return r ? r.textContent.trim() : '' })
      assert.ok(rootName, '左侧工作目录根名非空')
      // 回归：切到标签条「看板」→ 左侧栏应切回模型/执行体配置（而非停留工作目录树）
      await app.call(() => { const t = document.querySelector('#tabbar .tab[data-pane="board"]'); if (t) t.click(); return true })
      await app.waitFor(() => document.querySelector('#pane-board').classList.contains('on'), 5000, '切到看板 pane')
      assert.equal(await app.visible('#boardModelSel'), true, '切回看板标签后左侧恢复配置')
      assert.equal(await app.visible('#boardSideFiles'), false, '切回看板标签后隐藏工作目录树')
      // 再点回卡片标签 → 左侧栏重新显示工作目录树
      await app.call((id) => { const t = document.querySelector(`#tabbar .tab[data-card="${id}"]`); if (t) t.click(); return true }, b.id)
      await app.waitFor(() => !!document.querySelector('#boardSideFiles .treebar'), 5000, '点回卡片后工作目录树重现')
      assert.equal(await app.visible('#boardModelSel'), false, '点回卡片后配置隐藏')
      // 切换到甲 → 对话区显示甲内容
      await app.call((id) => { const t = document.querySelector(`#tabbar .tab[data-card="${id}"]`); if (t) t.click(); return true }, a.id)
      await app.waitFor(`(() => { const m = document.querySelector('#bcMsgs'); return !!m && m.textContent.includes('甲的内容') })()`, 5000, '切回甲显示其内容')
      // 关闭乙 → 剩一个标签
      await app.call((id) => { const t = document.querySelector(`#tabbar .tab[data-card="${id}"] .x`); if (t) t.click(); return true }, b.id)
      await app.waitFor(`document.querySelectorAll('#tabbar .tab[data-pane="card"]').length === 1`, 5000, '关闭乙后剩一个标签')
      // 关闭最后一个 → 回看板
      await app.call((id) => { const t = document.querySelector(`#tabbar .tab[data-card="${id}"] .x`); if (t) t.click(); return true }, a.id)
      await app.waitFor(() => document.querySelector('#pane-board').classList.contains('on'), 5000, '关闭全部后回看板')
      const left = await app.call(() => document.querySelectorAll('#tabbar .tab[data-pane="card"]').length)
      assert.equal(left, 0, '不应残留卡片标签')
      // 回到看板 → 左侧栏恢复看板配置
      assert.equal(await app.visible('#boardModelSel'), true, '回到看板后左侧恢复模型/执行体配置')
      assert.equal(await app.visible('#boardSideFiles'), false, '回到看板后隐藏工作目录树')
    }
  },
  {
    name: '已完成卡片只读：不可编辑、不可再和 AI 对话',
    async run(app) {
      const c = await app.invoke('board', 'create', { title: '已完成任务', content: '已经做完的事' })
      await app.store('tasks.update', { id: c.id, patch: { status: 'done' } })
      await app.click('.abi[data-view="projects"]')
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      await app.waitFor(`!!document.querySelector('.bcol[data-col="done"] .bcard[data-card="${c.id}"]')`, 8000, '已完成卡片渲染')
      await app.call((id) => { const e = document.querySelector(`.bcard[data-card="${id}"]`); if (e) e.click(); return true }, c.id)
      await app.waitFor(() => { const p = document.querySelector('#pane-card'); return !!p && p.classList.contains('on') }, 5000, '卡片对话标签打开')
      // 已完成：编辑按钮不可见、输入区不可见、状态显示已完成
      assert.equal(await app.visible('[data-cardedit]'), false, '已完成卡片不显示编辑按钮')
      assert.equal(await app.visible('#bcInWrap'), false, '已完成卡片不显示对话输入区')
      const st = await app.text('#bcStatus')
      assert.ok(st && st.includes('已完成'), '状态显示已完成：' + st)
      // 关闭标签回看板，避免残留影响后续用例
      await app.call((id) => { const t = document.querySelector(`#tabbar .tab[data-card="${id}"] .x`); if (t) t.click(); return true }, c.id)
      await app.waitFor(() => document.querySelector('#pane-board').classList.contains('on'), 5000, '关闭后回看板')
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
    name: '拖动：未开始可直接拖到已完成',
    async run(app) {
      await ensureAI(app)
      await app.call(() => { document.querySelectorAll('.zz-modal-mask').forEach((m) => m.remove()); return true })
      const card = await app.invoke('board', 'create', { title: '直接归档任务', content: '无需作答，直接完成' })
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      await app.waitFor(`[...document.querySelectorAll('.bcol[data-col="todo"] .bcard')].some(e=>e.textContent.includes('直接归档任务'))`, 8000, '卡片在未开始列')
      // 未开始 → 已完成：直接归档，不触发 AI 作答
      const ok = await dragCard(app, card.id, 'done')
      assert.ok(ok, '拖拽应被处理')
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('board', 'list')
        const c = l.find((x) => x.id === ${JSON.stringify(card.id)})
        return !!(c && c.status === 'done')
      })()`, 8000, '未开始拖到已完成')
      await app.waitFor(`[...document.querySelectorAll('.bcol[data-col="done"] .bcard')].some(e=>e.textContent.includes('直接归档任务'))`, 8000, '卡片在已完成列')
      const l = await boardList(app)
      const c = l.find((x) => x.id === card.id)
      assert.equal(c.status, 'done', '卡片应为已完成')
    }
  },
  {
    name: '拖动：已完成可拖回待审核',
    async run(app) {
      await ensureAI(app)
      await app.call(() => { document.querySelectorAll('.zz-modal-mask').forEach((m) => m.remove()); return true })
      const card = await app.invoke('board', 'create', { title: '打回任务', content: '完成后又能打回待审核' })
      await app.invoke('board', 'finish', { id: card.id })
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      await app.waitFor(`[...document.querySelectorAll('.bcol[data-col="done"] .bcard')].some(e=>e.textContent.includes('打回任务'))`, 8000, '卡片在已完成列')
      // 已完成 → 待审核：直接改状态，不重新作答
      const ok = await dragCard(app, card.id, 'review')
      assert.ok(ok, '拖拽应被处理')
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('board', 'list')
        const c = l.find((x) => x.id === ${JSON.stringify(card.id)})
        return !!(c && c.status === 'review')
      })()`, 8000, '已完成拖回待审核')
      await app.waitFor(`[...document.querySelectorAll('.bcol[data-col="review"] .bcard')].some(e=>e.textContent.includes('打回任务'))`, 8000, '卡片在待审核列')
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
      await app.invoke('board', 'saveConfig', { model_id: m.id, agent_id: 'builtin', skillExclude: [], mcpExclude: [] })

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
      await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: 'builtin', skillExclude: [], mcpExclude: [] })
      try { await server.close() } catch {}
    }
  },
  {
    name: '打开进行中的卡片：应显示已流式生成的作答且无加载错误（回归）',
    async run(app) {
      // 慢速作答：首段先流出，之后长时间静默，保证打开弹窗时 run 仍在进行中
      const server = await startFakeAI({ chunks: ['第一段已作答', '第二段'], delay: 4000 })
      const pid = await app.store('providers.upsert', {
        provider: { name: '进行中提供方', type: 'openai_compatible', base_url: server.url }
      })
      await app.store('models.upsert', {
        model: { name: '进行中模型', model_id: 'doing-1', type: 'openai_compatible', base_url: server.url, provider_id: pid, is_default: 0 }
      })
      const m = (await app.store('models.list')).find((x) => x.name === '进行中模型')
      await app.invoke('secrets', 'set', { key: 'zzwork.key.provider.' + pid, value: 'sk-doing' })
      await app.invoke('board', 'saveConfig', { model_id: m.id, agent_id: 'builtin', skillExclude: [], mcpExclude: [] })

      const card = await app.invoke('board', 'create', { title: '进行中卡片', content: '慢速作答' })
      const started = await app.invoke('board', 'start', { id: card.id })
      const sid = started.sessionId
      // 等到 run 已流出首段内容（此刻 live 快照非空、run 仍在进行中）
      await app.waitFor(`(async () => {
        const info = await window.zzwork.invoke('chat', 'init', { taskId: ${JSON.stringify(card.id)}, sessionId: ${JSON.stringify(sid)} })
        return !!(info && info.live && String(info.live.content || '').includes('第一段'))
      })()`, 15000, 'run 已流出首段内容')

      // 打开看板并点击卡片（进行中）
      await app.click('.abi[data-view="board"]')
      await app.waitFor(() => !!document.querySelector('.boardcols'), 8000, '看板网格')
      await app.call((t) => {
        const c = [...document.querySelectorAll('.bcard')].find((e) => e.textContent.includes(t))
        if (c) c.click()
        return true
      }, '进行中卡片')

      // 关键断言：弹窗应立即显示已生成的作答内容（快照预载），且无加载错误
      await app.waitFor(`[...document.querySelectorAll('#bcMsgs .bmsg.a .md')].some((e) => e.textContent.includes('第一段'))`, 5000, '应显示已流式生成的作答')
      const err = await app.call(() => { const e = document.querySelector('#bcMsgs .err'); return e ? e.textContent : '' })
      assert.equal(err, '', '打开进行中卡片不应出现加载错误：' + err)

      // 收尾：关闭弹窗、恢复看板配置
      await app.call(() => { document.querySelectorAll('.zz-modal-mask').forEach((x) => x.remove()); return true })
      await app.invoke('board', 'saveConfig', { model_id: ctx.modelId, agent_id: 'builtin', skillExclude: [], mcpExclude: [] })
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
