import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startFakeAI, sleep } from '../harness.mjs'
import { selectTask, ensureTask } from './_helpers.mjs'

const ctx = { attachTaskId: '' }
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
            { index: 0, action: 'attach', taskId: ctx.attachTaskId, name: '', type: 'work', reason: '与已有任务相关', confidence: 0.92 },
            { index: 1, action: 'new', name: '做一个全新的功能界面', type: 'work', reason: '独立需求', confidence: 0.85 }
          ]
        })
      }
      if (sys.includes('会话摘要器')) return '摘要：已完成多会话与变更注入验证，下一步补充编排。'
      if (sys.includes('任务简介生成器')) return '简介：测试任务，已验证多会话、变更感知与子代理。'
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
        const sys = String((r.messages && r.messages[0] && r.messages[0].content) || '')
        return sys.includes('note.txt')
      })
      assert.ok(req, '下一次请求的系统提示应带入 note.txt 变更')

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
      const info = await initChat(app, t.id)
      const sid = info.session.id
      const sent = await sendChat(app, t.id, '完成第一轮工作', sid)
      await waitRun(app, sent.runId)

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
      await app.click('#refreshBriefBtn')
      await app.waitFor(`document.querySelector('#infoBody').textContent.includes('简介：测试任务')`, 8000, '刷新简介按钮生效')
      const memPath = path.join(t.path, '.zzwork', 'memory.md')
      await app.setValue('#memoryBox', '约定：使用中文回答；接口返回 JSON。')
      await sleep(1000)
      assert.ok(fs.existsSync(memPath), '任务记忆应写入 .zzwork/memory.md')
      assert.ok(fs.readFileSync(memPath, 'utf8').includes('接口返回 JSON'))
    }
  },
  {
    name: '需求便签归类与执行',
    async run(app) {
      const attach = await bindTask(app, '便签已有任务', {})
      ctx.attachTaskId = attach.id
      const workdir = await app.store('workdir.get')
      await selectTask(app, '便签已有任务')
      await app.click('.abi[data-view="projects"]')
      await app.waitFor(() => !!document.querySelector('#inboxInput'), 5000, '便签输入框出现')
      await app.click('#openInboxBtn')
      await app.waitFor(`document.querySelector('#pane-inbox').classList.contains('on')`, 5000, '便签 tab 打开')
      assert.equal(await app.count('.tab[data-pane="inbox"]'), 1, '便签 tab 唯一')
      assert.equal(await app.count('#tabbar .tab'), 1, '便签激活时编辑区只显示唯一 tab')
      await app.click('#openInboxBtn')
      assert.equal(await app.count('.tab[data-pane="inbox"]'), 1, '再次点击不应重复打开')

      const text = '便签已有任务 请补充日志\n做一个全新的功能界面'
      await app.setValue('#inboxInput', text)
      await sleep(900)
      const inboxFile = path.join(workdir, '.zzwork', 'inbox.md')
      assert.ok(fs.existsSync(inboxFile), '便签应自动保存')
      assert.ok(fs.readFileSync(inboxFile, 'utf8').includes('做一个全新的功能界面'))

      await app.click('#triageBtn')
      await app.waitFor(() => !!document.querySelector('.zz-modal.tr'), 8000, '归类弹窗出现')
      await app.waitFor(`document.querySelectorAll('.tri-row').length === 2`, 8000, '两行归类')
      const acts = await app.call(() => [...document.querySelectorAll('.tri-row .tri-act')].map((s) => s.value))
      assert.deepEqual(acts, ['attach', 'new'])
      const attachSel = await app.call(() => document.querySelector('.tri-row .tri-task').value)
      assert.equal(attachSel, ctx.attachTaskId, '归入任务应选中已有任务')
      await app.call(() => { document.querySelector('#tri-exec').checked = false; return true })
      await app.click('.zz-modal.tr [data-act="ok"]')
      await app.waitGone('.zz-modal.tr', 8000)

      await app.waitFor(`(async () => {
        const ts = await window.zzwork.invoke('store', 'tasks.list')
        return ts.some((x) => x.name.includes('做一个全新的功能界面'))
      })()`, 10000, '新任务创建')

      const tasks = await app.store('tasks.list')
      const created = tasks.find((x) => x.name.includes('做一个全新的功能界面'))
      assert.ok(created, '新任务应存在')
      assert.equal(created.type, 'work')
      const ses = await app.store('sessions.list', { taskId: created.id })
      assert.equal(ses.length, 1, '新任务应有默认会话')
      const info = fs.readFileSync(path.join(attach.path, '.zzwork', 'info.md'), 'utf8')
      assert.ok(info.includes('便签已有任务 请补充日志'), '归入任务应追加需求')
      assert.equal(fs.readFileSync(inboxFile, 'utf8'), '', '应用后便签应清空')

      await app.call(() => { const x = document.querySelector('.tab[data-pane="inbox"] .x'); if (x) x.click(); return true })
      await app.waitFor(`!document.querySelector('.tab[data-pane="inbox"]')`, 5000, '便签 tab 关闭')
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
  }
]
