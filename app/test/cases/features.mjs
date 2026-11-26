import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startFakeAI, sleep } from '../harness.mjs'
import { selectTask, setView, ensureTask } from './_helpers.mjs'

let server = null

async function ensureServer(app) {
  if (server) return server
  server = await startFakeAI({
    delay: 40,
    respond(body) {
      const msgs = (body && body.messages) || []
      const sys = String((msgs[0] && msgs[0].content) || '')
      const joined = msgs.map((m) => String(m.content || '')).join('\n')
      if (sys.includes('需求归类器')) {
        return JSON.stringify({
          items: [
            { index: 0, action: 'ignore', kind: '', name: '', reason: '已有相关任务', confidence: 0.92 },
            { index: 1, action: 'new', kind: 'task', name: '做一个全新的功能界面', reason: '独立需求', confidence: 0.85 }
          ]
        })
      }
      if (sys.includes('会话摘要器')) return '摘要：已完成多会话与变更注入验证，下一步补充编排。'
      if (sys.includes('任务简介生成器')) return '【简介】\n简介：测试任务，已验证多会话、变更感知与子代理。\n【关键信息】\n联系人：张三'
      if (sys.includes('多代理编排器')) {
        return JSON.stringify({
          subtasks: [
            { title: '子任务一', agent: 'builtin', prompt: '执行子任务一' },
            { title: '子任务二', agent: 'builtin', prompt: '执行子任务二' }
          ]
        })
      }
      if (sys.includes('你是编排器')) return '汇总：所有子任务均已完成。'
      if (joined.includes('慢速子任务')) return Array.from({ length: 40 }, () => '慢片段 ')
      return ['执行结果：', '已完成。']
    }
  })
  const pid = await app.store('providers.upsert', { provider: { name: '特性提供方', type: 'openai_compatible', base_url: server.url } })
  await app.store('models.upsert', { model: { name: '特性模型', model_id: 'feat-1', type: 'openai_compatible', base_url: server.url, provider_id: pid, is_default: 1 } })
  await app.invoke('secrets', 'set', { key: 'zzwork.key.provider.' + pid, value: 'sk-feat' })
  return server
}

async function bindTask(app, name, patch) {
  await ensureServer(app)
  await ensureTask(app, name)
  const t = (await app.store('tasks.list')).find((x) => x.name === name)
  await app.store('tasks.update', { id: t.id, patch: { agent_id: 'builtin', model_id: '', ...patch } })
  return (await app.store('tasks.list')).find((x) => x.id === t.id)
}

async function initChat(app, taskId, sessionId) {
  return app.invoke('chat', 'init', { taskId, sessionId: sessionId || '' })
}

async function sendChat(app, taskId, text, sessionId) {
  return app.invoke('chat', 'send', { taskId, text, sessionId: sessionId || '' })
}

async function waitRun(app, runId, timeout = 20000) {
  await app.waitFor(`(async () => {
    const r = await window.zzwork.invoke('store', 'runs.get', { id: ${JSON.stringify(runId)} })
    return !!(r && r.status !== 'running')
  })()`, timeout, '运行结束 ' + runId)
  return app.store('runs.get', { id: runId })
}

async function openAiTab(app) {
  await app.waitFor(() => !!document.querySelector('.tab[data-pane="ai"]'), 10000, 'AI 标签出现')
  await app.click('.tab[data-pane="ai"]')
  await app.waitFor(`document.querySelector('#pane-ai').classList.contains('on')`)
}

export default [
  {
    name: '多会话隔离与切换',
    async run(app) {
      const t = await bindTask(app, '多会话任务', {})
      const info = await initChat(app, t.id)
      const a = info.session.id
      const b = (await app.store('sessions.create', { dto: { taskId: t.id, title: '第二会话' } })).id
      const sent = await sendChat(app, t.id, '会话B的第一条消息', b)
      await waitRun(app, sent.runId)

      const msgsA = await app.store('messages.list', { taskId: t.id, sessionId: a })
      const msgsB = await app.store('messages.list', { taskId: t.id, sessionId: b })
      assert.equal(msgsA.length, 0, '主会话不应出现 B 的消息')
      assert.ok(msgsB.length >= 2, 'B 会话应有用户与回复')
      const userB = msgsB.find((m) => m.role === 'user')
      assert.equal(userB.content, '会话B的第一条消息')

      await selectTask(app, '多会话任务')
      await app.click('.tab[data-pane="info"]')
      await app.waitFor(`!!document.querySelector('#infoBody .sessrow[data-session="${b}"]')`, 8000, '会话行出现')
      await app.click(`#infoBody .sessrow[data-session="${b}"]`)
      await app.waitFor(`document.querySelector('#pane-ai').classList.contains('on')`, 8000, '点击会话行切到 AI')
      await app.waitFor(`document.querySelector('#chatInner').textContent.includes('会话B的第一条消息')`, 8000, '切换到 B 会话')
      await app.click('.tab[data-pane="info"]')
      await app.click(`#infoBody .sessrow[data-session="${a}"]`)
      await app.waitFor(`!document.querySelector('#chatInner').textContent.includes('会话B的第一条消息')`, 8000, '切回 A 会话')

      // AI 头部会话标签：列出当前任务全部会话并可切换
      await selectTask(app, '多会话任务')
      await openAiTab(app)
      const sessions = await app.store('sessions.list', { taskId: t.id })
      await app.waitFor(`document.querySelectorAll('#aiSessionList .chsess-item').length === ${sessions.length}`, 8000, '会话标签数量')
      await app.click(`#aiSessionList .chsess-item[data-session="${b}"]`)
      await app.waitFor(`document.querySelector('#chatInner').textContent.includes('会话B的第一条消息')`, 8000, '标签切到 B 会话')
      assert.ok(await app.exists(`#aiSessionList .chsess-item.on[data-session="${b}"]`), 'B 会话标签应高亮')
      await app.click(`#aiSessionList .chsess-item[data-session="${a}"]`)
      await app.waitFor(`!document.querySelector('#chatInner').textContent.includes('会话B的第一条消息')`, 8000, '标签切回 A 会话')
    }
  },
  {
    name: '变更自动注入下一次请求',
    async run(app) {
      const t = await bindTask(app, '变更任务', {})
      const info = await initChat(app, t.id)
      const sid = info.session.id

      const first = await sendChat(app, t.id, '建立基线', sid)
      await waitRun(app, first.runId)

      fs.writeFileSync(path.join(t.path, 'note.txt'), '这是用户手动创建的变更文件\n', 'utf8')

      const before = server.requests.length
      const second = await sendChat(app, t.id, '看看工作区有什么变化', sid)
      await waitRun(app, second.runId)

      const msgs = await app.store('messages.list', { taskId: t.id, sessionId: sid })
      const ctxMsg = msgs.find((m) => m.kind === 'context')
      assert.ok(ctxMsg, '应出现变更上下文消息')
      assert.ok(ctxMsg.content.includes('非 Git 工作区'), ctxMsg.content)
      assert.ok(String(ctxMsg.meta).includes('note.txt'), '变更详情应包含 note.txt')

      const req = server.requests.slice(before).find((r) => {
        const all = ((r.messages) || []).map((m) => String(m.content || '')).join('\n')
        return all.includes('note.txt')
      })
      assert.ok(req, '下一次请求应带入 note.txt 变更（拼在用户消息尾部）')

      await selectTask(app, '变更任务')
      await openAiTab(app)
      await app.waitFor(`!!document.querySelector('#chatInner .ctxchg')`, 8000, '变更卡片渲染')
      const sum = await app.text('#chatInner .ctxchg summary')
      assert.ok(sum.includes('非 Git 工作区'), sum)
    }
  },
  {
    name: '会话摘要与任务简介',
    async run(app) {
      const t = await bindTask(app, '简介任务', {})
      const keyinfoPath = path.join(t.path, '.zzwork', 'keyinfo.md')
      const info = await initChat(app, t.id)
      const sid = info.session.id
      const sent = await sendChat(app, t.id, '完成第一轮工作', sid)
      await waitRun(app, sent.runId)

      // 回合结束后自动生成简介、自动提取关键信息（无需手动刷新）
      await app.waitFor(
        `window.zzwork.invoke('store','tasks.list',{}).then(l => { const x = l.find(t => t.id === ${JSON.stringify(t.id)}); return !!(x && x.brief && x.brief.includes('简介')) })`,
        15000, '自动生成任务简介'
      )
      await app.waitFor(
        `window.zzwork.invoke('fs','readFile',{ path: ${JSON.stringify(keyinfoPath)} }).then(c => String(c || '').includes('张三'))`,
        15000, '自动提取关键信息落盘'
      )

      const sum = await app.invoke('chat', 'summarize', { taskId: t.id, sessionId: sid })
      assert.ok(sum.summary && sum.summary.includes('摘要'), '会话摘要应生成')
      const sessions = await app.store('sessions.list', { taskId: t.id })
      const s = sessions.find((x) => x.id === sid)
      assert.ok(s.summary.includes('摘要'), '摘要应落库')

      const brief = await app.invoke('chat', 'brief', { taskId: t.id })
      assert.ok(brief.ok && brief.brief.includes('简介'), '任务简介应生成')
      let task = (await app.store('tasks.list')).find((x) => x.id === t.id)
      assert.ok(task.brief.includes('简介'), '简介应写入任务')

      await selectTask(app, '简介任务')
      await app.click('.tab[data-pane="info"]')
      await app.waitFor(`document.querySelector('#infoBody').textContent.includes('已验证多会话')`, 8000, '简介显示在信息页')
      await app.waitFor(`document.querySelector('#keyinfoBox').value.includes('张三')`, 8000, '自动提取的关键信息出现在信息页')
      await app.click('#refreshBriefBtn')
      await app.waitFor(`document.querySelector('#infoBody').textContent.includes('简介：测试任务')`, 8000, '刷新简介按钮生效')

      // 关键信息：UI 编辑落盘到 .zzwork/keyinfo.md，并随下一次请求注入
      assert.equal(await app.exists('#memoryBox'), false, '任务记忆 UI 应已移除')
      await app.setValue('#keyinfoBox', '测试账号：admin\nAPI Key：sk-test-keyinfo')
      await sleep(1000)
      assert.ok(fs.existsSync(keyinfoPath), '关键信息应写入 .zzwork/keyinfo.md')
      assert.ok(fs.readFileSync(keyinfoPath, 'utf8').includes('sk-test-keyinfo'))

      // 任务记忆仍从 .zzwork/memory.md 注入（仅隐藏 UI）
      const memPath = path.join(t.path, '.zzwork', 'memory.md')
      fs.writeFileSync(memPath, '约定：使用中文回答；接口返回 JSON。', 'utf8')
      const before = server.requests.length
      const sent2 = await sendChat(app, t.id, '读取关键信息', sid)
      await waitRun(app, sent2.runId)
      const req = server.requests.slice(before).find((r) => {
        const sys = String((r.messages && r.messages[0] && r.messages[0].content) || '')
        return sys.includes('sk-test-keyinfo') && sys.includes('接口返回 JSON')
      })
      assert.ok(req, '关键信息与任务记忆都应随请求注入系统提示')
    }
  },
  {
    name: '需求便签归类与执行',
    async run(app) {
      await bindTask(app, '便签已有任务', {})
      const workdir = await app.store('workdir.get')
      await selectTask(app, '便签已有任务')
      await app.click('.abi[data-view="projects"]')
      await app.waitFor(() => !!document.querySelector('#inboxInput'), 5000, '便签输入框出现')
      await app.click('#openInboxBtn')
      await app.waitFor(`document.querySelector('#pane-inbox').classList.contains('on')`, 5000, '便签 tab 打开')
      assert.equal(await app.count('.tab[data-pane="inbox"]'), 1, '便签 tab 唯一')
      assert.equal(await app.count('#tabbar .tab'), 1, '便签激活时编辑区只显示唯一 tab')
      assert.equal(await app.count('.tab[data-pane="inbox"] .x'), 0, '便签 tab 不能关闭（无 ×）')
      assert.equal(await app.call(() => getComputedStyle(document.querySelector('.side')).display), 'none', '便签激活时隐藏左侧栏，编辑区更宽')
      await app.click('#openInboxBtn')
      assert.equal(await app.count('.tab[data-pane="inbox"]'), 1, '再次点击不应重复打开')

      const text = '便签已有任务 请补充日志\n做一个全新的功能界面'
      await app.setValue('#inboxInput', text)
      await sleep(900)
      const inboxFile = path.join(workdir, '.zzwork', 'inbox.md')
      assert.ok(fs.existsSync(inboxFile), '便签应自动保存')
      assert.ok(fs.readFileSync(inboxFile, 'utf8').includes('做一个全新的功能界面'))

      await app.click('#triageBtn')
      await app.waitFor(() => { const r = document.querySelector('#inboxReview'); return !!r && !r.hidden }, 8000, '内联审阅出现')
      await app.waitFor(`document.querySelectorAll('#inboxReview .ir-row').length === 2`, 8000, '两行归类')
      // 输入框被审阅面板替换
      assert.equal(await app.call(() => document.querySelector('#inboxInput').style.display), 'none', '输入框被审阅面板替换')
      const acts = await app.call(() => [...document.querySelectorAll('#inboxReview .ir-row .ir-act')].map((s) => s.value))
      assert.deepEqual(acts, ['ignore', 'new'])
      await app.call(() => { const c = document.querySelector('#ir-exec'); if (c) c.checked = false; return true })
      // 逐条确认：第一条（忽略，已有相关任务）
      await app.click('#inboxReview .ir-row .ir-confirm')
      await app.waitFor(`document.querySelectorAll('#inboxReview .ir-row').length === 1`, 10000, '确认一条后剩一条')
      // 第二条（新建任务）→ 全部确认后自动回到输入框
      await app.click('#inboxReview .ir-row .ir-confirm')
      await app.waitFor(`document.querySelector('#inboxReview').hidden === true`, 10000, '全部确认后回到输入框')
      await app.waitFor(`document.querySelector('#inboxInput').style.display !== 'none'`, 5000, '输入框恢复')

      await app.waitFor(`(async () => {
        const ts = await window.zzwork.invoke('store', 'tasks.list')
        return ts.some((x) => x.name.includes('做一个全新的功能界面'))
      })()`, 10000, '新任务创建')
      await app.waitFor(`!!document.querySelector('#inboxBoard .ibcard .ibic svg')`, 8000, '便签任务卡片带类型图标')

      const tasks = await app.store('tasks.list')
      const created = tasks.find((x) => x.name.includes('做一个全新的功能界面'))
      assert.ok(created, '新任务应存在')
      assert.equal(created.type, 'work')
      const ses = await app.store('sessions.list', { taskId: created.id })
      assert.equal(ses.length, 1, '新任务应有默认会话')
      assert.equal(fs.readFileSync(inboxFile, 'utf8'), '', '应用后便签应清空')

      // 便签无关闭按钮：点活动栏「项目」离开
      await app.click('.abi[data-view="projects"]')
      await app.waitFor(`!document.querySelector('.tab[data-pane="inbox"]')`, 5000, '离开便签页')
    }
  },
  {
    name: '便签归类逐条确认：确认一条后取消，已确认行删除、未确认保留',
    async run(app) {
      await ensureServer(app)
      const workdir = await app.store('workdir.get')
      const inboxFile = path.join(workdir, '.zzwork', 'inbox.md')
      await bindTask(app, '便签取消目标任务', {})
      await selectTask(app, '便签取消目标任务')
      await app.click('.abi[data-view="projects"]')
      await app.waitFor(() => !!document.querySelector('#inboxInput'), 5000, '便签输入框出现')
      await app.click('#openInboxBtn')
      await app.waitFor(`document.querySelector('#pane-inbox').classList.contains('on')`, 5000, '便签打开')

      const lines = ['取消甲需求qx', '取消乙需求bv', '取消丙需求cc']
      await app.setValue('#inboxInput', lines.join('\n'))
      await sleep(900)

      await app.click('#triageBtn')
      await app.waitFor(`document.querySelectorAll('#inboxReview .ir-row').length === 3`, 8000, '三行归类')
      await app.call(() => { const c = document.querySelector('#ir-exec'); if (c) c.checked = false; return true })

      // 确认第一条（应用并从便签移除）
      await app.click('#inboxReview .ir-row .ir-confirm')
      await app.waitFor(`document.querySelectorAll('#inboxReview .ir-row').length === 2`, 10000, '确认一条后剩两条')

      // 审阅中右上角按钮变为「取消」，点击回到输入框
      const lbl = await app.call(() => (document.querySelector('#triageBtnLabel') || {}).textContent)
      assert.equal(lbl, '取消', '审阅中按钮应显示取消')
      await app.click('#triageBtn')
      await app.waitFor(`document.querySelector('#inboxReview').hidden === true`, 8000, '取消后回到输入框')

      const remaining = await app.call(() => document.querySelector('#inboxInput').value)
      assert.ok(!remaining.includes(lines[0]), '已确认的甲需求应从便签删除')
      assert.ok(remaining.includes(lines[1]) && remaining.includes(lines[2]), '未确认的乙丙需求应保留')
      await sleep(500)
      assert.equal(fs.readFileSync(inboxFile, 'utf8'), lines[1] + '\n' + lines[2], '便签文件同步保留剩余行')

      // 清理
      await app.setValue('#inboxInput', '')
      await sleep(700)
      await app.click('.abi[data-view="projects"]')
      await app.waitFor(`!document.querySelector('.tab[data-pane="inbox"]')`, 5000, '离开便签页')
    }
  },
  {
    name: '需求便签分栏：代码任务/全部任务分流 + 拖拽改状态',
    async run(app) {
      const workdir = await app.store('workdir.get')
      const codeDir = path.join(workdir, 'inbox-code')
      fs.mkdirSync(codeDir, { recursive: true })
      const code = await app.store('tasks.create', { dto: { name: '便签代码任务', type: 'code', status: 'active', scope: 'long', path: codeDir } })
      const work = await app.store('tasks.create', { dto: { name: '便签工作任务', type: 'work', status: 'active', scope: 'long', path: path.join(workdir, 'inbox-work') } })
      const board = await app.store('tasks.create', { dto: { name: '便签看板任务', type: 'work', status: 'todo', scope: 'board', path: path.join(workdir, 'inbox-board') } })

      await setView(app, 'projects')
      await app.click('#openInboxBtn')
      await app.waitFor(`document.querySelector('#pane-inbox').classList.contains('on')`, 5000, '便签 tab 打开')

      // 结构：左(上下) + 分隔条 + 右
      assert.ok(await app.exists('#inboxCodeTasks'), '左侧代码任务容器存在')
      assert.ok(await app.exists('#inboxVDiv'), '上下分隔条存在')
      assert.ok(await app.exists('#inboxHDiv'), '左右分隔条存在')

      // 左下只列 code，右上/右下只含 work 与看板
      await app.waitFor(`!!document.querySelector('#inboxCodeTasks .ibcard[data-task="${code.id}"]')`, 8000, '代码任务出现在左下')
      const codeHasWork = await app.call((wid) => !!document.querySelector(`#inboxCodeTasks .ibcard[data-task="${wid}"]`), work.id)
      assert.equal(codeHasWork, false, '左下不应含 work 任务')
      await app.waitFor(`(() => {
        const hasWork = !!document.querySelector('#inboxBoard .ibcard[data-task="${work.id}"]')
        const hasBoard = !!document.querySelector('#inboxBoard .ibcard[data-task="${board.id}"]')
        const hasCode = !!document.querySelector('#inboxBoard .ibcard[data-task="${code.id}"]')
        return hasWork && hasBoard && !hasCode
      })()`, 8000, '右栏含 work 与看板、不含 code')

      const drag = (srcSel, dstSel) => app.call((s0, d0) => {
        const s = document.querySelector(s0), d = document.querySelector(d0)
        if (!s || !d) throw new Error('拖拽元素缺失 ' + s0 + ' / ' + d0)
        const dt = new DataTransfer()
        s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
        d.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
        d.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
        s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
        return true
      }, srcSel, dstSel)

      // 代码任务拖到右栏「已完成」→ 状态变 done，左侧卡片置灰
      await drag(`#inboxCodeTasks .ibcard[data-task="${code.id}"]`, '#inboxBoard .ibcolb[data-col="done"]')
      await app.waitFor(`(async () => {
        const ts = await window.zzwork.invoke('store', 'tasks.list')
        const x = ts.find((v) => v.id === ${JSON.stringify(code.id)})
        return !!(x && x.status === 'done')
      })()`, 8000, '代码任务状态改为 done')
      await app.waitFor(`!!document.querySelector('#inboxCodeTasks .ibcard.done[data-task="${code.id}"]')`, 8000, '代码任务卡片置灰')

      // work 卡片：未完成 → 已完成 → 未完成（双向）
      await drag(`#inboxBoard .ibcolb[data-col="open"] .ibcard[data-task="${work.id}"]`, '#inboxBoard .ibcolb[data-col="done"]')
      await app.waitFor(`(async () => {
        const ts = await window.zzwork.invoke('store', 'tasks.list')
        const x = ts.find((v) => v.id === ${JSON.stringify(work.id)})
        return !!(x && x.status === 'done')
      })()`, 8000, 'work 卡片标记完成')
      await drag(`#inboxBoard .ibcolb[data-col="done"] .ibcard[data-task="${work.id}"]`, '#inboxBoard .ibcolb[data-col="open"]')
      await app.waitFor(`(async () => {
        const ts = await window.zzwork.invoke('store', 'tasks.list')
        const x = ts.find((v) => v.id === ${JSON.stringify(work.id)})
        return !!(x && x.status !== 'done')
      })()`, 8000, 'work 卡片恢复到未完成')

      await app.click('.abi[data-view="projects"]')
      await app.waitFor(`!document.querySelector('.tab[data-pane="inbox"]')`, 5000, '离开便签页')
    }
  },
  {
    name: '便签全部任务：未开始单列 + 点击看板任务打开看板卡片',
    async run(app) {
      const workdir = await app.store('workdir.get')
      const board = await app.invoke('board', 'create', { title: '便签看板未开始', content: '待开始' })
      const work = await app.store('tasks.create', { dto: { name: '便签工作未完成', type: 'work', status: 'active', scope: 'long', path: path.join(workdir, 'inbox-work2') } })

      await setView(app, 'projects')
      await app.click('#openInboxBtn')
      await app.waitFor(`document.querySelector('#pane-inbox').classList.contains('on')`, 5000, '便签打开')

      // 未开始列只含 status=todo 的看板任务；work 任务在未完成列
      await app.waitFor(`(() => {
        const t = document.querySelector('#inboxBoard .ibcolb[data-col="todo"] .ibcard[data-task="${board.id}"]')
        const o = document.querySelector('#inboxBoard .ibcolb[data-col="open"] .ibcard[data-task="${work.id}"]')
        const boardInOpen = document.querySelector('#inboxBoard .ibcolb[data-col="open"] .ibcard[data-task="${board.id}"]')
        return !!t && !!o && !boardInOpen
      })()`, 8000, '未开始单列、未完成任务在未完成列')

      // 点击看板任务：切到看板页并打开该卡片，而非项目任务信息页
      await app.click(`#inboxBoard .ibcolb[data-col="todo"] .ibcard[data-task="${board.id}"]`)
      await app.waitFor(`(() => {
        const nav = document.querySelector('.abi[data-view="board"]')
        const card = document.querySelector('#pane-card.on .cardchat-t')
        const infoPane = document.querySelector('#pane-info.on')
        return !!nav && nav.classList.contains('on') && !!card && card.textContent.includes('便签看板未开始') && !infoPane
      })()`, 8000, '点击看板任务进入看板卡片')

      // 收尾：关闭卡片
      await app.call(() => { const x = document.querySelector('.tab[data-card] .x'); if (x) x.click(); return true })
    }
  },
  {
    name: '便签未完成列支持拖拽排序并持久化',
    async run(app) {
      const workdir = await app.store('workdir.get')
      for (const n of ['排序A', '排序B', '排序C']) {
        await app.store('tasks.create', { dto: { name: n, type: 'work', status: 'active', scope: 'long', path: path.join(workdir, 'inbox-sort-' + n) } })
      }

      await setView(app, 'projects')
      await app.click('#openInboxBtn')
      await app.waitFor(`document.querySelector('#pane-inbox').classList.contains('on')`, 5000, '便签打开')
      await app.waitFor(`document.querySelectorAll('#inboxBoard .ibcolb[data-col="open"] .ibcard[data-task]').length >= 3`, 8000, '未完成列至少三张卡片')

      const before = await app.call(() => [...document.querySelectorAll('#inboxBoard .ibcolb[data-col="open"] .ibcard[data-task]')].map((c) => c.getAttribute('data-task')))
      const movedId = before[before.length - 1]
      assert.ok(movedId && before[0] !== movedId, '存在可移动的末位卡片')

      // 把末位卡片拖到列表最上方（插入到首张之前）
      await app.call((mid) => {
        const col = document.querySelector('#inboxBoard .ibcolb[data-col="open"]')
        const cards = [...col.querySelectorAll('.ibcard[data-task]')]
        const src = cards.find((c) => c.getAttribute('data-task') === mid)
        const first = cards[0]
        const r = first.getBoundingClientRect()
        const dt = new DataTransfer()
        const opt = { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 1, clientX: r.left + 5 }
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
        col.dispatchEvent(new DragEvent('dragover', opt))
        col.dispatchEvent(new DragEvent('drop', opt))
        src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
        return true
      }, movedId)

      await app.waitFor(`(() => { const c = document.querySelector('#inboxBoard .ibcolb[data-col="open"] .ibcard[data-task]'); return !!c && c.getAttribute('data-task') === ${JSON.stringify(movedId)} })()`, 6000, '拖拽后该卡片置顶')

      const raw = await app.store('settings.get', { key: 'ui:inboxOrder', dflt: '' })
      const om = raw ? JSON.parse(raw) : {}
      assert.ok(Array.isArray(om.open) && om.open[0] === movedId, '排序已持久化到设置：' + raw)

      await app.click('.abi[data-view="projects"]')
      await app.waitFor(`!document.querySelector('.tab[data-pane="inbox"]')`, 5000, '离开便签页')
    }
  },
  {
    name: '需求便签：AI 回复结束后显示未读标志，查看后消失',
    async run(app) {
      const t = await bindTask(app, '未读标记任务', {})
      const info = await initChat(app, t.id)
      const sent = await sendChat(app, t.id, '你好', info.session.id)
      await waitRun(app, sent.runId)

      // 主进程应在用户可见会话结束时记录该任务的回复结束时间
      const replyRaw = await app.store('settings.get', { key: 'ui:taskReplyAt', dflt: '' })
      const reply = replyRaw ? JSON.parse(replyRaw) : {}
      assert.ok(reply[t.id] > 0, '应记录该任务的回复结束时间')

      // 标题栏「需求便签」入口应出现醒目的未读数量徽标（无需打开便签页）
      await app.waitFor(`(() => {
        const b = document.querySelector('#openInboxBadge')
        return b && !b.hidden && Number(b.textContent) >= 1
      })()`, 8000, '入口徽标显示未读数量')

      // 确保未读（清掉可能残留的已读时间）
      await app.store('settings.set', { key: 'ui:taskRead', value: '{}' })

      await setView(app, 'projects')
      await app.click('#openInboxBtn')
      await app.waitFor(`document.querySelector('#pane-inbox').classList.contains('on')`, 5000, '便签打开')
      await app.waitFor(`(() => {
        const c = document.querySelector('#inboxBoard .ibcard[data-task="${t.id}"]')
        return !!c && !!c.querySelector('.ibunread')
      })()`, 8000, '该任务显示未读标志')

      // 模拟全部已读：所有已回复任务的已读时间都晚于回复结束时间
      const replyAllRaw = await app.store('settings.get', { key: 'ui:taskReplyAt', dflt: '' })
      const replyAll = replyAllRaw ? JSON.parse(replyAllRaw) : {}
      const readAll = {}
      for (const k of Object.keys(replyAll)) readAll[k] = Date.now() + 100000
      readAll[t.id] = Date.now() + 100000
      await app.store('settings.set', { key: 'ui:taskRead', value: JSON.stringify(readAll) })
      await app.click('.abi[data-view="projects"]')
      await app.waitFor(`!document.querySelector('.tab[data-pane="inbox"]')`, 5000, '离开便签页')
      await app.click('#openInboxBtn')
      await app.waitFor(`document.querySelector('#pane-inbox').classList.contains('on')`, 5000, '便签再次打开')
      await app.waitFor(`(() => {
        const c = document.querySelector('#inboxBoard .ibcard[data-task="${t.id}"]')
        return !!c && !c.querySelector('.ibunread')
      })()`, 8000, '已读后未读标志消失')
      // 已读后入口徽标也应隐藏（打开便签会重算未读）
      await app.waitFor(`(() => {
        const b = document.querySelector('#openInboxBadge')
        return b && b.hidden
      })()`, 8000, '已读后入口徽标隐藏')
      await app.click('.abi[data-view="projects"]')
    }
  },
  {
    name: '便签归档：看板任务落到未开始 / 短期任务归入分组',
    async run(app) {
      await ensureServer(app)
      const g = await app.store('groups.create', { name: '归档分组', parentId: '' })
      const gid = g && g.id || ''
      assert.ok(gid, '分组应创建成功')

      const r = await app.invoke('inbox', 'apply', {
        execute: false,
        items: [
          { action: 'new', kind: 'board', text: '看板小需求', name: '看板小需求' },
          { action: 'new', kind: 'task', text: '分组短期任务', name: '分组短期任务', groupId: gid },
          { action: 'ignore', text: '忽略的需求' }
        ]
      })
      const okr = (r.results || []).filter((x) => x.ok)
      assert.equal(okr.length, 2, '忽略项不产生结果：' + JSON.stringify(r))

      const tasks = await app.store('tasks.list')
      const card = tasks.find((x) => x.name === '看板小需求')
      assert.ok(card, '看板任务应创建')
      assert.equal(card.scope, 'board')
      assert.equal(card.status, 'todo')
      assert.equal(await app.store('sessions.list', { taskId: card.id }).then((s) => s.length), 0, '看板卡片不建会话')

      const short = tasks.find((x) => x.name === '分组短期任务')
      assert.ok(short, '短期任务应创建')
      assert.equal(short.scope, 'long')
      assert.equal(short.group_id, gid, '短期任务应归入所选分组')
      assert.equal(await app.store('sessions.list', { taskId: short.id }).then((s) => s.length), 1, '短期任务应有默认会话')
      assert.ok(!tasks.some((x) => x.name === '忽略的需求'), '忽略项不应创建任务')
    }
  },
  {
    name: '子代理派生与结果回填',
    async run(app) {
      const t = await bindTask(app, '子代理任务', {})
      const info = await initChat(app, t.id)
      const sid = info.session.id
      const r = await app.invoke('chat', 'spawn', {
        taskId: t.id, parentSessionId: sid, agentId: 'builtin', title: '调研子任务', prompt: '执行调研', execute: true
      })
      assert.ok(r.sessionId && r.runId, '派回应返回子会话与运行号')
      await waitRun(app, r.runId)

      await app.waitFor(`(async () => {
        const msgs = await window.zzwork.invoke('store', 'messages.list', { taskId: ${JSON.stringify(t.id)}, sessionId: ${JSON.stringify(sid)} })
        const m = msgs.find((x) => x.kind === 'subagent')
        return !!(m && String(m.meta).includes('"status":"done"'))
      })()`, 15000, '子代理结果回填')

      const sessions = await app.store('sessions.list', { taskId: t.id })
      const child = sessions.find((x) => x.id === r.sessionId)
      assert.equal(child.kind, 'subagent')
      assert.equal(child.parent_session_id, sid)
      const childMsgs = await app.store('messages.list', { taskId: t.id, sessionId: r.sessionId })
      assert.ok(childMsgs.some((m) => m.role === 'assistant' && m.content.includes('执行结果')))

      await selectTask(app, '子代理任务')
      await openAiTab(app)
      await app.waitFor(`!!document.querySelector('#chatInner .subcard')`, 8000, '子代理卡片渲染')
      const card = await app.text('#chatInner .subcard')
      assert.ok(card.includes('调研子任务'), card)
      assert.ok(card.includes('已完成'), card)
    }
  },
  {
    name: '编排拆解与汇总',
    async run(app) {
      const t = await bindTask(app, '编排任务', {})
      const info = await initChat(app, t.id)
      const sid = info.session.id
      const r = await app.invoke('chat', 'orchestrate', { taskId: t.id, sessionId: sid, goal: '搭建演示工程', maxChildren: 2 })
      assert.ok(Array.isArray(r.results) && r.results.length === 2, JSON.stringify(r))
      assert.ok(r.final.includes('汇总'), '应有汇总结果')

      const msgs = await app.store('messages.list', { taskId: t.id, sessionId: sid })
      assert.ok(msgs.some((m) => m.kind === 'plan'), '应有计划消息')
      const sessions = await app.store('sessions.list', { taskId: t.id })
      const subs = sessions.filter((x) => x.kind === 'subagent')
      assert.equal(subs.length, 2, '应派发两个子会话')
      assert.ok(msgs.some((m) => m.kind === 'text' && String(m.content || '').includes('汇总')), '汇总应落库')

      await selectTask(app, '编排任务')
      await openAiTab(app)
      await app.waitFor(`!!document.querySelector('#chatInner .planbox')`, 8000, '计划卡片渲染')
      const plan = await app.text('#chatInner .planbox')
      assert.ok(plan.includes('子任务一') && plan.includes('子任务二'), plan)
    }
  },
  {
    name: '子代理停止',
    async run(app) {
      const t = await bindTask(app, '停止子代理任务', {})
      const info = await initChat(app, t.id)
      const r = await app.invoke('chat', 'spawn', {
        taskId: t.id, parentSessionId: info.session.id, agentId: 'builtin', title: '慢速子任务', prompt: '慢速子任务 执行', execute: true
      })
      await sleep(500)
      await app.invoke('chat', 'stop', { runId: r.runId })
      const run = await waitRun(app, r.runId)
      assert.equal(run.status, 'stopped')
      const msgs = await app.store('messages.list', { taskId: t.id, sessionId: r.sessionId })
      const last = msgs[msgs.length - 1]
      assert.ok(last && String(last.content).includes('(已停止)'), '停止后应落盘中断消息')
    }
  },
  {
    name: '新版本提示与升级按钮',
    async run(app) {
      const current = await app.invoke('update', 'version')
      assert.ok(/^\d+\.\d+/.test(current || ''), '应返回应用版本：' + current)
      // 状态栏显示真实版本
      await app.waitFor(`document.querySelector('#stVersion').textContent.includes(${JSON.stringify(current)})`, 5000, '状态栏版本')

      // 注入一个更高的版本：主进程比对后广播，按钮出现在终端按钮左侧
      const newer = await app.invoke('update', 'check', { latest: 'v9.9.9' })
      assert.equal(newer.hasUpdate, true)
      assert.equal(newer.latest, 'v9.9.9')
      await app.waitFor(`(() => {
        const b = document.querySelector('#updateBtn')
        if (!b) return false
        const r = b.getBoundingClientRect()
        return !b.hidden && r.width > 0 && getComputedStyle(b).display !== 'none'
      })()`, 5000, '升级按钮出现')
      const title = await app.call(() => document.querySelector('#updateBtn').getAttribute('title') || '')
      assert.ok(title.includes('9.9.9'), title)
      const leftOfTerm = await app.call(() => {
        const u = document.querySelector('#updateBtn')
        const t = document.querySelector('#termToggle')
        return !!(u && t && (u.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING))
      })
      assert.ok(leftOfTerm, '升级按钮应位于终端按钮左侧')

      // 开发模式（未打包）点击只提示，不真正安装
      await app.click('#updateBtn')
      await app.waitFor(`[...document.querySelectorAll('.zz-toast')].some((t) => t.textContent.includes('开发模式'))`, 5000, '开发模式提示')

      // 已是当前版本：按钮隐藏
      const same = await app.invoke('update', 'check', { latest: 'v' + current })
      assert.equal(same.hasUpdate, false)
      await app.waitFor(() => { const b = document.querySelector('#updateBtn'); return !!b && b.hidden }, 5000, '无新版本时隐藏')

      // 非法版本串：视作无更新，不崩溃
      const bad = await app.invoke('update', 'check', { latest: 'garbage' })
      assert.equal(bad.hasUpdate, false)
      assert.equal(bad.latest, '')
    }
  }
]
