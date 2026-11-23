import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeAI, sleep } from '../harness.mjs'
import { selectTask, setView, ensureTask, createTaskUI } from './_helpers.mjs'

const AGENT_FIXTURE = fileURLToPath(new URL('../fixtures/fake-agent.cjs', import.meta.url))
const CODEX_FIXTURE = fileURLToPath(new URL('../fixtures/fake-codex.cjs', import.meta.url))
const ZCODE_FIXTURE = fileURLToPath(new URL('../fixtures/fake-zcode.cjs', import.meta.url))
const EDIT_FIXTURE = fileURLToPath(new URL('../fixtures/fake-edit-agent.cjs', import.meta.url))
const RICH_FIXTURE = fileURLToPath(new URL('../fixtures/fake-rich-agent.cjs', import.meta.url))

async function taskByName(app, name) {
  return (await app.store('tasks.list')).find((t) => t.name === name)
}

async function messagesOf(app, taskId) {
  return app.store('messages.list', { taskId })
}

async function setupProviderModel(app, { url, name, keyed = true }) {
  const pid = await app.store('providers.upsert', {
    provider: { name, type: 'openai_compatible', base_url: url }
  })
  await app.store('models.upsert', {
    model: { name: name + '-模型', model_id: 'fake-1', type: 'openai_compatible', base_url: url, provider_id: pid, is_default: 1 }
  })
  const m = (await app.store('models.list')).find((x) => x.provider_id === pid)
  if (keyed) await app.invoke('secrets', 'set', { key: 'zzwork.key.provider.' + pid, value: 'sk-fake' })
  return { pid, mid: m.id }
}

async function bindTask(app, taskName, patch) {
  await ensureTask(app, taskName)
  const t = await taskByName(app, taskName)
  await app.store('tasks.update', { id: t.id, patch })
  return t
}

async function openAiTab(app) {
  await app.waitFor(() => !!document.querySelector('.tab[data-pane="ai"]'), 10000, 'AI 标签出现')
  await app.click('.tab[data-pane="ai"]')
  await app.waitFor(`document.querySelector('#pane-ai').classList.contains('on')`)
}

async function sendChat(app, text) {
  await app.setValue('#chatInput', text)
  await app.click('#chatSend')
}

export default [
  {
    name: '会话头部信息',
    async run(app) {
      const t = await bindTask(app, '主任务改名', { agent_id: 'builtin' })
      await selectTask(app, '主任务改名')
      await openAiTab(app)
      assert.ok(await app.visible('#newSessionBtn'), '应有新建会话按钮')
      assert.ok(await app.exists('#aiSessionList'), '应有会话标签区')
      assert.ok(!(await app.exists('#aiAgent')), '不应再显示执行体选择')
      assert.ok(!(await app.exists('#aiModel')), '不应再显示模型选择')
      assert.ok(!(await app.exists('#aiEnv')), '不应再显示环境标签')
      assert.ok(!(await app.exists('#aiType')), '不应再显示任务类型')
      const n = (await app.store('sessions.list', { taskId: t.id })).length
      await app.waitFor(`document.querySelectorAll('#aiSessionList .chsess-item').length === ${n}`, 8000, '会话标签数量')
      await app.click('#newSessionBtn')
      await app.waitFor(`document.querySelectorAll('#aiSessionList .chsess-item').length === ${n + 1}`, 8000, '新建会话后标签增加')
      assert.ok(await app.exists('#aiSessionList .chsess-item.on'), '当前会话标签应高亮')
    }
  },
  {
    name: 'CLI 命令不存在时给出友好提示',
    async run(app) {
      const agents = JSON.parse(await app.store('settings.get', { key: 'agents', dflt: '[]' }))
      const bad = { id: 'missing-test', name: '缺失执行体', kind: 'cli', where: 'auto', cmd: 'zzwork-no-such-cmd {prompt}' }
      await app.store('agents.save', { list: [...agents.filter((a) => a.id !== 'missing-test'), bad] })
      try {
        const t = await bindTask(app, '主任务改名', { agent_id: 'missing-test', model_id: '' })
        await selectTask(app, '主任务改名')
        await openAiTab(app)
        await sendChat(app, '触发命令缺失')
        await app.waitFor(`document.querySelector('#chatInner').textContent.includes('未找到命令')`, 15000, '友好提示渲染')
        await app.waitFor(`document.querySelector('#chatSend').style.display !== 'none'`, 10000, '失败后按钮恢复')
        const runs = await app.store('runs.list', { taskId: t.id })
        const last = runs[runs.length - 1]
        assert.equal(last.status, 'error')
        assert.ok(String(last.error || '').includes('未找到命令'), last.error)
      } finally {
        await app.store('agents.save', { list: agents })
        await bindTask(app, '主任务改名', { agent_id: 'builtin' })
      }
    }
  },
  {
    name: '未设置 Key 的错误路径',
    async run(app) {
      const setup = await setupProviderModel(app, { url: 'http://127.0.0.1:1/v1', name: '无Key提供方', keyed: false })
      const t = await bindTask(app, '主任务改名', { agent_id: 'builtin', model_id: setup.mid })
      await selectTask(app, '主任务改名')
      await openAiTab(app)
      await sendChat(app, '你好无Key')
      await app.waitFor(`document.querySelector('#chatInner').textContent.includes('未设置 API Key')`, 15000, '未设置 Key 提示')
      const msgs = await messagesOf(app, t.id)
      assert.equal(msgs[msgs.length - 2].content, '你好无Key')
      assert.equal(msgs[msgs.length - 1].content, '(未设置 API Key，已中断)')
      await app.store('providers.delete', { id: setup.pid })
      await bindTask(app, '主任务改名', { model_id: '' })
    }
  },
  {
    name: '内置模型流式回复并落盘',
    async run(app) {
      const server = await startFakeAI({ chunks: ['你好', '，我是', '测试模型。'], delay: 150 })
      try {
        const setup = await setupProviderModel(app, { url: server.url, name: '流式提供方' })
        const t = await bindTask(app, '主任务改名', { agent_id: 'builtin', model_id: setup.mid })
        await selectTask(app, '主任务改名')
        await openAiTab(app)
        await sendChat(app, '流式测试')
        await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('你好，我是测试模型。'))`, 20000, '流式回复渲染')
        await app.waitFor(`document.querySelector('#chatStop').style.display === 'none'`, 15000, '回合结束（停止按钮隐藏）')
        const msgs = await messagesOf(app, t.id)
        const last = msgs[msgs.length - 1]
        assert.equal(last.role, 'assistant')
        assert.equal(last.content, '你好，我是测试模型。')
        const chatFile = path.join(t.path, '.zzwork', 'chat', new Date().toISOString().slice(0, 10) + '.md')
        assert.ok(fs.existsSync(chatFile), '对话应落盘: ' + chatFile)
        const md = fs.readFileSync(chatFile, 'utf8')
        assert.ok(md.includes('流式测试'))
        assert.ok(md.includes('你好，我是测试模型。'))
      } finally {
        await server.close()
      }
    }
  },
  {
    name: '停止生成（中断流式输出）',
    async run(app) {
      const chunks = Array.from({ length: 12 }, (_, i) => `片段${i + 1} `)
      const server = await startFakeAI({ chunks, delay: 250 })
      try {
        const setup = await setupProviderModel(app, { url: server.url, name: '慢速提供方' })
        const t = await bindTask(app, '主任务改名', { agent_id: 'builtin', model_id: setup.mid })
        await selectTask(app, '主任务改名')
        await openAiTab(app)
        await sendChat(app, '停止测试')
        await app.waitFor(`document.querySelector('#chatStop').style.display !== 'none'`, 10000, '停止按钮出现')
        await sleep(400)
        await app.click('#chatStop')
        await app.waitFor(`(async () => {
          const msgs = await window.zzwork.invoke('store', 'messages.list', { taskId: ${JSON.stringify(t.id)} })
          const last = msgs[msgs.length - 1]
          return !!(last && last.role === 'assistant' && last.content.includes('(已停止)'))
        })()`, 15000, '已停止消息落库')
        await app.waitFor(`document.querySelector('#chatSend').style.display !== 'none'`, 10000, '停止后按钮恢复')
        const msgs = await messagesOf(app, t.id)
        const last = msgs[msgs.length - 1]
        assert.ok(last.content.includes('(已停止)'))
        assert.ok(last.content.length < chunks.join('').length + 20, '停止后不应输出全部内容')
      } finally {
        await server.close()
      }
    }
  },
  {
    name: 'CLI 执行体流式输出',
    async run(app) {
      const agents = JSON.parse(await app.store('settings.get', { key: 'agents', dflt: '[]' }))
      const fake = { id: 'fake-test', name: '假执行体', kind: 'cli', where: 'auto', cmd: `node "${AGENT_FIXTURE}" {prompt}` }
      await app.store('agents.save', { list: [...agents.filter((a) => a.id !== 'fake-test'), fake] })
      try {
        const t = await bindTask(app, '主任务改名', { agent_id: 'fake-test', model_id: '' })
        await selectTask(app, '主任务改名')
        await openAiTab(app)
        await sendChat(app, '命令行测试')
        await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('FAKE-AGENT 收到：命令行测试'))`, 20000, 'CLI 输出渲染')
        await app.waitFor(`(async () => {
          const msgs = await window.zzwork.invoke('store', 'messages.list', { taskId: ${JSON.stringify(t.id)} })
          const last = msgs[msgs.length - 1]
          return !!(last && last.role === 'assistant' && last.content.includes('FAKE-AGENT 收到：命令行测试'))
        })()`, 10000, 'CLI 回复落库')
        const msgs = await messagesOf(app, t.id)
        const last = msgs[msgs.length - 1]
        assert.equal(last.role, 'assistant')
        assert.ok(last.content.includes('FAKE-AGENT 收到：命令行测试'))
      } finally {
        await app.store('agents.save', { list: agents })
        await bindTask(app, '主任务改名', { agent_id: 'builtin' })
      }
    }
  },
  {
    name: '内置模型展示思考过程（可折叠回看）',
    async run(app) {
      const server = await startFakeAI({ thinking: ['先拆解问题，', '再给出结论。'], chunks: ['答案是 221。'], delay: 20 })
      try {
        const setup = await setupProviderModel(app, { url: server.url, name: '思考提供方' })
        const t = await bindTask(app, '主任务改名', { agent_id: 'builtin', model_id: setup.mid })
        await selectTask(app, '主任务改名')
        await openAiTab(app)
        await sendChat(app, '思考测试')
        await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('答案是 221。'))`, 20000, '内置回复渲染')
        await app.waitFor(`[...document.querySelectorAll('.workbox .thinktext')].some(e=>e.textContent.includes('先拆解问题'))`, 10000, '思考过程渲染')
        await app.waitFor(`(async () => {
          const msgs = await window.zzwork.invoke('store', 'messages.list', { taskId: ${JSON.stringify(t.id)} })
          const last = msgs[msgs.length - 1]
          return !!(last && String(last.meta || '').includes('先拆解问题'))
        })()`, 10000, '思考过程落库')
        const msgs = await messagesOf(app, t.id)
        assert.equal(msgs[msgs.length - 1].content, '答案是 221。', '思考过程不应混入正文')
      } finally {
        await server.close()
        await bindTask(app, '主任务改名', { model_id: '' })
      }
    }
  },
  {
    name: 'codex 执行体只展示思考与答复（过滤命令噪音）',
    async run(app) {
      const agents = JSON.parse(await app.store('settings.get', { key: 'agents', dflt: '[]' }))
      const fake = { id: 'codex', name: 'OpenAI Codex', kind: 'cli', where: 'auto', cmd: `node "${CODEX_FIXTURE}" {prompt}` }
      await app.store('agents.save', { list: [...agents.filter((a) => a.id !== 'codex'), fake] })
      try {
        const t = await bindTask(app, '主任务改名', { agent_id: 'codex', model_id: '' })
        await selectTask(app, '主任务改名')
        await openAiTab(app)
        await sendChat(app, 'codex你好')
        await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('CODEX-FAKE 收到：codex你好'))`, 20000, 'codex 答复渲染')
        await app.waitFor(`[...document.querySelectorAll('.workbox .thinktext')].some(e=>e.textContent.includes('CODEX-THINK'))`, 10000, 'codex 思考过程渲染')
        await app.waitFor(`[...document.querySelectorAll('.workbox .strow')].some(r=>r.textContent.includes('命令') && r.textContent.includes('ls'))`, 10000, 'codex 运行过程渲染')
        // 定位本条 codex 答复（而非最后一条气泡），并等到工作框与正文同处一个 parts
        const replySel = `[...document.querySelectorAll('#chatInner .msg.a')].find((m) => m.querySelector('.abody') && m.querySelector('.abody').textContent.includes('CODEX-FAKE 收到：codex你好'))`
        await app.waitFor(`(() => {
          const el = ${replySel}
          if (!el) return false
          const parts = el.querySelector('.parts')
          if (!parts) return false
          const cls = [...parts.children].map((c) => String(c.className).split(' ')[0])
          return cls.includes('workbox') && cls.includes('abody')
        })()`, 10000, 'codex 答复含工作框与正文')
        const order = await app.call(() => {
          const msgs = [...document.querySelectorAll('#chatInner .msg.a')]
          const el = msgs.find((m) => m.querySelector('.abody') && m.querySelector('.abody').textContent.includes('CODEX-FAKE 收到：codex你好'))
          const parts = el && el.querySelector('.parts')
          return parts ? Array.from(parts.children).map((c) => String(c.className).split(' ')[0]) : []
        })
        assert.ok(order.includes('workbox') && order.includes('abody'), '合并工作框与正文应同时存在: ' + order)
        assert.ok(order.indexOf('workbox') < order.indexOf('abody'), '工作框应在正文之前: ' + order)
        const txt = await app.call(() => document.querySelector('#chatInner').textContent)
        assert.ok(!txt.includes('CODEX-NOISE'), '命令输出等噪音不应出现在对话里')
        // 流式正文先于落库出现，等最终消息写入后再断言，避免读库竞态
        await app.waitFor(`(async () => {
          const l = await window.zzwork.invoke('store','messages.list',{ taskId: ${JSON.stringify(t.id)} })
          return l.some(m => m.role==='assistant' && String(m.content||'').includes('CODEX-FAKE 收到：codex你好'))
        })()`, 15000, 'codex 答复落库')
        const msgs = await messagesOf(app, t.id)
        const reply = msgs.filter((m) => m.role === 'assistant' && String(m.content || '').includes('CODEX-FAKE 收到：codex你好')).pop()
        assert.ok(reply, 'codex 答复应落库')
        assert.ok(!String(reply.content || '').includes('CODEX-NOISE'))
        assert.ok(String(reply.meta || '').includes('CODEX-THINK'), '思考过程应随消息落库')
        assert.ok(String(reply.meta || '').includes('ls'), '运行步骤应随消息落库')
      } finally {
        await app.store('agents.save', { list: agents })
        await bindTask(app, '主任务改名', { agent_id: 'builtin' })
      }
    }
  },
  {
    name: 'codex 执行体原生续接（resume）',
    async run(app) {
      const agents = JSON.parse(await app.store('settings.get', { key: 'agents', dflt: '[]' }))
      // 无 {prompt}：走 agentTmpl，才会注入 exec/resume 与沙箱参数
      const fake = { id: 'codex', name: 'OpenAI Codex', kind: 'cli', where: 'auto', cmd: `node "${CODEX_FIXTURE}"` }
      await app.store('agents.save', { list: [...agents.filter((a) => a.id !== 'codex'), fake] })
      const name = 'codex续接任务'
      try {
        const t = await bindTask(app, name, { agent_id: 'codex', model_id: '' })
        await selectTask(app, name)
        await openAiTab(app)
        await sendChat(app, '第一轮')
        await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('CODEX-FAKE 收到：第一轮'))`, 20000, 'codex 首轮回复')
        // sid 已落库
        await app.waitFor(`(async () => {
          const init = await window.zzwork.invoke('chat','init',{ taskId: ${JSON.stringify(t.id)} })
          if (!init || !init.session) return false
          const s = await window.zzwork.invoke('store','sessions.get',{ id: init.session.id })
          return !!(s && String(s.meta || '').includes('sid:codex'))
        })()`, 10000, 'sid:codex 落库')
        await sendChat(app, '第二轮')
        await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('CODEX-RESUMED 收到：第二轮'))`, 20000, 'codex 续接回复')
        const txt = await app.call(() => document.querySelector('#chatInner').textContent)
        assert.ok(!txt.includes('【本会话最近对话'), '有 sid 时不应再附纯文本历史')
      } finally {
        await app.store('agents.save', { list: agents })
        await bindTask(app, name, { agent_id: 'builtin' })
      }
    }
  },
  {
    name: 'zcode 执行体多行提示词不被截断（切换执行体带上下文）',
    async run(app) {
      const agents = JSON.parse(await app.store('settings.get', { key: 'agents', dflt: '[]' }))
      const fake = { id: 'zcode', name: 'zcode', kind: 'cli', where: 'auto', cmd: `node "${ZCODE_FIXTURE}"` }
      await app.store('agents.save', { list: [...agents.filter((a) => a.id !== 'zcode'), fake] })
      const name = 'zcode截断任务'
      try {
        const t = await bindTask(app, name, { agent_id: 'zcode', model_id: '' })
        await selectTask(app, name)
        await openAiTab(app)
        const init = await app.invoke('chat', 'init', { taskId: t.id })
        // 第二行含标记：cmd.exe 若在首个换行处截断，第二行会丢失
        await app.invoke('chat', 'send', {
          taskId: t.id, sessionId: init.session.id, text: '第一行内容\n第二行秘密标记ZZTOP'
        })
        await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('第二行秘密标记ZZTOP'))`, 20000, '多行提示词应完整送达执行体')
      } finally {
        await app.store('agents.save', { list: agents })
        await bindTask(app, name, { agent_id: 'builtin' })
      }
    }
  },
  {
    name: '聊天输入草稿按任务隔离（切换任务不串台）',
    async run(app) {
      await bindTask(app, '草稿任务甲', { agent_id: 'builtin' })
      await bindTask(app, '草稿任务乙', { agent_id: 'builtin' })
      await selectTask(app, '草稿任务甲')
      await openAiTab(app)
      await app.setValue('#chatInput', '这是甲任务的草稿XYZ')
      await selectTask(app, '草稿任务乙')
      await app.waitFor(`document.querySelector('#chatInput').value === ''`, 8000, '乙任务输入框不应显示甲的草稿')
      await selectTask(app, '草稿任务甲')
      await app.waitFor(`document.querySelector('#chatInput').value === '这是甲任务的草稿XYZ'`, 8000, '切回甲任务应恢复其草稿')
      await app.setValue('#chatInput', '')
    }
  },
  {
    name: '聊天框图片附件：落盘 + 气泡缩略图 + codex -i',
    async run(app) {
      const agents = JSON.parse(await app.store('settings.get', { key: 'agents', dflt: '[]' }))
      const fake = { id: 'codex', name: 'OpenAI Codex', kind: 'cli', where: 'auto', cmd: `node "${CODEX_FIXTURE}"` }
      await app.store('agents.save', { list: [...agents.filter((a) => a.id !== 'codex'), fake] })
      const name = '图片附件任务'
      const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
      try {
        const t = await bindTask(app, name, { agent_id: 'codex', model_id: '' })
        await selectTask(app, name)
        await openAiTab(app)
        const init = await app.invoke('chat', 'init', { taskId: t.id })
        const sid = init.session.id
        await app.invoke('chat', 'send', {
          taskId: t.id, sessionId: sid, text: '看图',
          attachments: [{ name: 'a.png', mime: 'image/png', dataUrl: PNG, thumb: PNG }]
        })
        await app.waitFor(`[...document.querySelectorAll('.msg.u .ubatt img')].length >= 1`, 20000, '用户气泡缩略图')
        await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('CODEX-FAKE [IMG]'))`, 20000, 'codex 收到 -i 图片参数')
        // 附件元数据 + 落盘
        const msgs = await messagesOf(app, t.id)
        const um = msgs.filter((m) => m.role === 'user' && m.meta).pop()
        const meta = typeof um.meta === 'string' ? JSON.parse(um.meta) : um.meta
        assert.ok(meta.attachments && meta.attachments.length === 1, '用户消息应带附件元数据')
        const att = meta.attachments[0]
        assert.ok(att.path && att.path.includes('.zzwork'), '附件应写往 .zzwork/uploads')
        const exists = await app.invoke('fs', 'exists', { path: att.path })
        assert.ok(exists, '附件应已落盘: ' + att.path)
        // 越界写盘应被拒绝
        let rejected = false
        try { await app.invoke('fs', 'writeBase64', { path: 'C:/Windows/evil.png', dataUrl: PNG }) } catch { rejected = true }
        assert.ok(rejected, '越界路径应被拒绝')
      } finally {
        await app.store('agents.save', { list: agents })
        await bindTask(app, name, { agent_id: 'builtin' })
      }
    }
  },
  {
    name: '粘贴图片：芯片 + 发送给 Claude + 点击放大',
    async run(app) {
      const name = '粘贴图片任务'
      const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
      const b64 = PNG.split(',')[1]
      const t = await bindTask(app, name, { agent_id: 'claude-code', model_id: '' })
      await selectTask(app, name)
      await openAiTab(app)
      // 模拟在输入框粘贴剪贴板图片
      await app.call((data) => {
        const bin = atob(data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], 'clip.png', { type: 'image/png' }))
        const ev = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(ev, 'clipboardData', { value: dt })
        document.querySelector('#chatInput').dispatchEvent(ev)
      }, b64)
      await app.waitFor(`document.querySelectorAll('#chatAttach.on .attchip img').length >= 1`, 5000, '附件芯片出现')
      await app.click('#chatSend')
      await app.waitFor(`document.querySelectorAll('.msg.u .ubatt img.uimg').length >= 1`, 20000, '用户气泡缩略图')
      await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('[IMG:1]'))`, 20000, 'Claude 收到图片内容块')
      // 点击缩略图应放大
      await app.click('.msg.u .ubatt img.uimg')
      await app.waitFor(`!!document.querySelector('#zzImgZoom.on img')`, 5000, '图片放大浮层')
      await app.call(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
      await app.waitFor(`!document.querySelector('#zzImgZoom.on')`, 3000, 'Esc 关闭放大')
      const msgs = await messagesOf(app, t.id)
      const um = msgs.filter((m) => m.role === 'user' && m.meta).pop()
      const meta = typeof um.meta === 'string' ? JSON.parse(um.meta) : um.meta
      assert.ok(meta.attachments && meta.attachments.length === 1, '用户消息应带附件元数据')
      assert.ok(!String(um.content || '').includes('请查看附图'), '不应注入“请查看附图。”占位文字')
      const hasBub = await app.call(() => {
        const u = [...document.querySelectorAll('.msg.u')].pop()
        return !!(u && u.querySelector('.bub'))
      })
      assert.ok(!hasBub, '纯图片消息不应渲染空文本气泡')
      // 复制到系统剪贴板：合法图片返回 true，非图片返回 false
      const COPYABLE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      const copied = await app.invoke('app', 'copyImage', { dataUrl: COPYABLE })
      assert.ok(copied === true, 'copyImage 合法 data URL 应成功')
      const notCopied = await app.invoke('app', 'copyImage', { dataUrl: 'not-an-image' })
      assert.ok(notCopied === false, 'copyImage 非图片应失败')
    }
  },
  {
    name: '后台 Shell 面板：每会话展示、查看与停止',
    async run(app) {
      const name = '后台Shell任务'
      const t = await bindTask(app, name, { agent_id: 'claude-code', model_id: '' })
      await selectTask(app, name)
      await openAiTab(app)
      await sendChat(app, '[[BG]] 起个服务')
      await app.waitFor(`document.querySelectorAll('#chatShells.on .shrow').length >= 1`, 15000, '后台面板出现')
      await app.waitFor(`[...document.querySelectorAll('#chatShells .shcmd')].some(e=>e.textContent.includes('npm run dev'))`, 5000, '后台命令显示')
      await app.waitFor(`!!document.querySelector('#chatShells .shview')`, 5000, '查看详情入口')
      await app.waitFor(`!!document.querySelector('#chatShells [data-shell-stop]')`, 5000, '停止按钮')
      await app.click('#chatShells [data-shell-stop]')
      await app.waitFor(`!document.querySelector('#chatShells.on')`, 8000, '停止后条目移除、面板隐藏')
      const sess = (await app.store('sessions.list', { taskId: t.id }))[0]
      const meta = String(sess.meta || '')
      assert.ok(!meta.includes('npm run dev'), '停止后的后台 shell 不应再保留: ' + meta)
    }
  },
  {
    name: 'Claude 执行体流式输出（stream-json）',
    async run(app) {
      const t = await bindTask(app, '主任务改名', { agent_id: 'claude-code', model_id: '' })
      await selectTask(app, '主任务改名')
      await openAiTab(app)
      await sendChat(app, 'claude你好')
      await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('CLAUDE-FAKE 收到：claude你好'))`, 20000, 'Claude 流式输出渲染')
      await app.waitFor(`[...document.querySelectorAll('.workbox .thinktext')].some(e=>e.textContent.includes('CLAUDE-THINK'))`, 10000, 'Claude 思考过程渲染')
      await app.waitFor(`[...document.querySelectorAll('.workbox .strow')].some(r=>r.textContent.includes('Bash') && r.textContent.includes('echo hi'))`, 10000, 'Claude 运行过程渲染')
      await app.waitFor(`[...document.querySelectorAll('.planlist .plitem')].length >= 3`, 10000, '待办计划渲染')
      await app.waitFor(`(() => { const i=document.querySelector('.planlist .plitem.in_progress .pltext'); return !!i && i.textContent.includes('执行命令') })()`, 5000, '进行中待办高亮')
      await app.waitFor(`(() => { const c=document.querySelector('.planlist .plitem.completed'); return !!c && String(c.className).includes('completed') })()`, 5000, '已完成待办标记')
      await app.waitFor(`(() => { const n=document.querySelector('.planlist .pln'); return !!n && n.textContent.trim()==='1/3' })()`, 5000, '待办完成计数')
      const lay = await app.call(() => {
        const msgs = document.querySelectorAll('#chatInner .msg.a')
        const el = msgs[msgs.length - 1]
        const parts = el && el.querySelector('.parts')
        return parts ? Array.from(parts.children).map((c) => String(c.className).split(' ')[0]) : []
      })
      assert.ok(lay.includes('abody') && lay.includes('planlist'), '正文与待办应同时存在: ' + lay)
      assert.ok(lay.lastIndexOf('abody') < lay.indexOf('planlist'), '待办应固定在正文下方: ' + lay)
      await app.waitFor(`(async () => {
        const msgs = await window.zzwork.invoke('store', 'messages.list', { taskId: ${JSON.stringify(t.id)} })
        const last = msgs[msgs.length - 1]
        return !!(last && last.role === 'assistant' && last.content.includes('CLAUDE-FAKE 收到：claude你好'))
      })()`, 10000, 'Claude 回复落库')
      const claudeMsgs = await messagesOf(app, t.id)
      const claudeLast = claudeMsgs[claudeMsgs.length - 1]
      assert.ok(claudeLast.content.includes('CLAUDE-FAKE 收到：claude你好'), '增量流应输出回复')
      assert.equal(claudeLast.content.split('CLAUDE-FAKE 收到：').length - 1, 1, '增量流不应重复输出')
      assert.ok(String(claudeLast.meta || '').includes('CLAUDE-THINK'), 'Claude 思考过程应落库')
      assert.ok(String(claudeLast.meta || '').includes('echo hi'), 'Claude 运行步骤应落库')
      assert.ok(String(claudeLast.meta || '').includes('执行命令'), '待办计划应落库')
      // 真实用量：input=12+500(读缓存)+100(写缓存)=612，output=34，cached=500
      const cMeta = JSON.parse(claudeLast.meta || '{}')
      assert.equal(Number(cMeta.inputTokens), 612, 'Claude 输入 token 应取真实用量（含缓存读/写）')
      assert.equal(Number(cMeta.outputTokens), 34, 'Claude 输出 token 应取真实用量')
      assert.equal(Number(cMeta.cachedTokens), 500, 'Claude 缓存 token 应取 cache_read')
      const cRuns = await app.store('runs.list', { taskId: t.id, sessionId: claudeLast.session_id })
      const cLastRun = cRuns[cRuns.length - 1]
      assert.equal(Number(cLastRun.input_tokens), 612, 'runs 应落盘真实输入 token')
      assert.equal(Number(cLastRun.output_tokens), 34, 'runs 应落盘真实输出 token')
      assert.equal(Number(cLastRun.cached_tokens), 500, 'runs 应落盘真实缓存 token')
      const sessions = await app.store('sessions.list', { taskId: t.id })
      assert.ok(sessions.some((s) => String(s.meta || '').includes('fake-claude-session')), '应记录 claude 会话 id')
      await bindTask(app, '主任务改名', { agent_id: 'builtin' })
    }
  },
  {
    name: '运行中切换任务再切回，执行步骤不丢',
    async run(app) {
      await ensureTask(app, '切换目标任务')
      const t = await bindTask(app, '主任务改名', { agent_id: 'claude-code', model_id: '' })
      await selectTask(app, '主任务改名')
      await openAiTab(app)
      await sendChat(app, '[[SLOW]]慢慢来')
      await app.waitFor(`[...document.querySelectorAll('#chatInner .workbox .strow')].some(r => r.textContent.includes('echo hi'))`, 20000, '运行中步骤渲染')
      await app.waitFor(`(() => { const b = document.querySelector('#chatStop'); return !!b && getComputedStyle(b).display !== 'none' })()`, 5000, '运行中显示停止按钮')
      await selectTask(app, '切换目标任务')
      await selectTask(app, '主任务改名')
      await app.waitFor(`document.querySelector('#pane-ai').classList.contains('on')`, 8000, '切回后显示 AI 面板')
      await app.waitFor(`[...document.querySelectorAll('#chatInner .workbox .strow')].some(r => r.textContent.includes('echo hi'))`, 10000, '切回后执行步骤仍在')
      await app.waitFor(`(() => { const b = document.querySelector('#chatStop'); return !!b && getComputedStyle(b).display !== 'none' })()`, 5000, '切回后仍为运行中')
      await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b => b.textContent.includes('CLAUDE-FAKE') && b.textContent.includes('[[SLOW]]慢慢来'))`, 20000, '切回后继续输出并完成')
      const msgs = await messagesOf(app, t.id)
      const last = msgs[msgs.length - 1]
      assert.ok(last && last.role === 'assistant' && last.content.includes('CLAUDE-FAKE'), '收尾消息应落库')
      await bindTask(app, '主任务改名', { agent_id: 'builtin' })
    }
  },
  {
    name: 'Claude AskUserQuestion 弹框与回答',
    async run(app) {
      const t = await bindTask(app, '主任务改名', { agent_id: 'claude-code', model_id: '' })
      await selectTask(app, '主任务改名')
      await openAiTab(app)
      await sendChat(app, '[[ASK]]帮我确认一件事')
      await app.waitFor(`!!document.querySelector('.askcard')`, 20000, '提问卡片出现')
      await app.waitFor(`(() => { const c=document.querySelector('.askcard'); return !!c && c.textContent.includes('选哪个？') && c.textContent.includes('A 选项') })()`, 8000, '提问内容渲染')
      // 选择第一个选项并提交
      await app.call(() => { const b = [...document.querySelectorAll('.askcard .qopt')].find((x) => x.textContent.includes('A 选项')); if (b) b.click() })
      await app.call(() => { const b = document.querySelector('.askcard [data-ask-submit]'); if (b) b.click() })
      await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('已回答：A 选项'))`, 20000, '回答后继续输出')
      await app.waitFor(`(() => { const c=document.querySelector('.askcard'); return !!c && c.textContent.includes('已回答') })()`, 8000, '卡片进入已回答状态')
      // 流式正文先于落库出现，等最终消息写入后再断言，避免读库竞态
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('store','messages.list',{ taskId: ${JSON.stringify(t.id)} })
        return l.some(m => m.role==='assistant' && String(m.content||'').includes('已回答：A 选项'))
      })()`, 15000, '回答反馈落库')
      const msgs = await messagesOf(app, t.id)
      assert.ok(msgs.some((m) => m.content.includes('已回答：A 选项')), '回答应反馈给模型并落库')
      await bindTask(app, '主任务改名', { agent_id: 'builtin' })
    }
  },
  {
    name: '会话提示词自动保存',
    async run(app) {
      const t = await taskByName(app, '主任务改名')
      await selectTask(app, '主任务改名')
      await app.click('.tab[data-pane="session"]')
      await app.waitFor(`(() => { const l=document.querySelector('#sessionLabel'); return !!l && l.textContent.includes('当前会话') })()`, 8000, '会话面板加载')
      await app.call(() => {
        const ed = document.querySelector('#sessionPrompt')
        ed.textContent = '请使用简洁的中文回答'
        ed.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })
      await app.waitFor(`(async () => {
        const v = await window.zzwork.invoke('store', 'settings.get', { key: ${JSON.stringify('session:prompt:' + t.id)}, dflt: '' })
        return v === '请使用简洁的中文回答'
      })()`, 8000, '提示词自动保存')
      const saved = await app.store('settings.get', { key: 'session:prompt:' + t.id, dflt: '' })
      assert.equal(saved, '请使用简洁的中文回答')
    }
  },
  {
    name: '画板绘制保存与清空',
    async run(app) {
      const t = await taskByName(app, '主任务改名')
      await selectTask(app, '主任务改名')
      await app.click('.tab[data-pane="session"]')
      await app.waitFor(`(() => { const b = document.querySelector('#boardHost'); return !!b && !b.classList.contains('hidden') })()`, 5000, '画板面板显示')
      await app.click('#boardHost [data-tool="rect"]')
      await app.call(() => {
        const c = document.querySelector('#bdSvg')
        c.setPointerCapture = () => {}
        const r = c.getBoundingClientRect()
        const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }))
        ev('pointerdown', r.left + 30, r.top + 30)
        ev('pointermove', r.left + 120, r.top + 90)
        ev('pointerup', r.left + 120, r.top + 90)
        return true
      })
      await app.waitFor(`(async () => {
        const raw = await window.zzwork.invoke('store', 'settings.get', { key: ${JSON.stringify('session:canvas:' + t.id)}, dflt: '' })
        if (!raw) return false
        try {
          const d = JSON.parse(raw)
          return d.v === 2 && Array.isArray(d.shapes) && d.shapes.length >= 1
        } catch { return false }
      })()`, 6000, '画板 v2 数据保存')
      await app.click('#bdClear')
      await app.waitFor(`(async () => {
        const raw = await window.zzwork.invoke('store', 'settings.get', { key: ${JSON.stringify('session:canvas:' + t.id)}, dflt: '' })
        const d = raw ? JSON.parse(raw) : { shapes: [] }
        return !d.shapes || d.shapes.length === 0
      })()`, 6000, '画板清空')
    }
  },
  {
    name: '对话后显示本次修改与 diff',
    async run(app) {
      const agents = JSON.parse(await app.store('settings.get', { key: 'agents', dflt: '[]' }))
      const fake = { id: 'edit-test', name: '改文件执行体', kind: 'cli', where: 'auto', cmd: `node "${EDIT_FIXTURE}" {prompt}` }
      await app.store('agents.save', { list: [...agents.filter((a) => a.id !== 'edit-test'), fake] })
      try {
        const t = await bindTask(app, '主任务改名', { agent_id: 'edit-test', model_id: '' })
        try { fs.rmSync(path.join(t.path, 'ai-note.md'), { force: true }) } catch {}
        await selectTask(app, '主任务改名')
        await openAiTab(app)
        await sendChat(app, '请修改代码')
        await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('EDIT-AGENT 完成：请修改代码'))`, 20000, '改文件执行体输出')
        await app.waitFor(`!!document.querySelector('#chatInner .diffbox')`, 15000, 'diff 卡片出现')
        await app.waitFor(`(() => { const d=document.querySelector('#chatInner .diffbox'); return !!d && d.textContent.includes('ai-note.md') })()`, 10000, 'diff 卡片包含改动文件')
        const box = await app.call(() => {
          const d = document.querySelector('#chatInner .diffbox')
          if (!d) return null
          const row = d.querySelector('.drow')
          return { text: d.textContent, status: row && row.querySelector('.dst') ? row.querySelector('.dst').textContent : '' }
        })
        assert.ok(box && box.text.includes('本次修改'), 'diff 卡片应显示改动摘要')
        assert.equal(box.status, 'A', '新增文件应标记为 A')
        const toggled = await app.call(() => {
          const d = document.querySelector('#chatInner .diffbox')
          d.querySelector('summary').click()
          const closed = !d.open
          d.querySelector('summary').click()
          return { closed, reopened: d.open }
        })
        assert.ok(toggled.closed && toggled.reopened, 'diff 卡片应可点击收起/展开: ' + JSON.stringify(toggled))
        // 在编辑区标签页打开完整 diff
        await app.call(() => {
          const d = document.querySelector('#chatInner .diffbox')
          const row = d && d.querySelector('.drow')
          if (row && !row.open) row.querySelector('summary').click()
          const btn = row && row.querySelector('.dopen [data-open-diff]')
          if (btn) btn.click()
        })
        await app.waitFor(`[...document.querySelectorAll('#tabbar .tab[data-pane="file"]')].some(t => (t.getAttribute('data-file') || '').indexOf('zzdiff://') === 0)`, 10000, 'diff 标签页出现')
        const tabInfo = await app.call(() => {
          const tab = [...document.querySelectorAll('#tabbar .tab[data-pane="file"]')].find((t) => (t.getAttribute('data-file') || '').indexOf('zzdiff://') === 0)
          const pane = document.querySelector('#pane-file')
          return { name: tab ? (tab.querySelector('span') || {}).textContent || '' : '', active: !!pane && pane.classList.contains('on') }
        })
        assert.ok(tabInfo.name.includes('.diff'), '标签页名称应含 .diff: ' + tabInfo.name)
        assert.ok(tabInfo.active, '打开 diff 后编辑区文件面板应激活')
        const msgs = await messagesOf(app, t.id)
        const diffMsg = msgs.find((m) => m.kind === 'diff')
        assert.ok(diffMsg, 'diff 应作为消息落盘')
        assert.ok(String(diffMsg.meta).includes('ai-note.md'), 'diff 元数据应含文件路径: ' + diffMsg.meta)
        assert.ok(fs.existsSync(path.join(t.path, 'ai-note.md')), '执行体应已在任务目录写入文件')
      } finally {
        await app.store('agents.save', { list: agents })
        await bindTask(app, '主任务改名', { agent_id: 'builtin' })
      }
    }
  },
  {
    name: '对话富内容：表格/代码块/本地文件链接/图片',
    async run(app) {
      const agents = JSON.parse(await app.store('settings.get', { key: 'agents', dflt: '[]' }))
      const fake = { id: 'rich-test', name: '富内容执行体', kind: 'cli', where: 'auto', cmd: `node "${RICH_FIXTURE}" {prompt}` }
      await app.store('agents.save', { list: [...agents.filter((a) => a.id !== 'rich-test'), fake] })
      try {
        await bindTask(app, '主任务改名', { agent_id: 'rich-test', model_id: '' })
        await selectTask(app, '主任务改名')
        await openAiTab(app)
        await sendChat(app, '富内容测试')
        await app.waitFor(`document.querySelectorAll('.msg.a .md table').length > 0`, 20000, '表格渲染')
        await app.waitFor(`!!document.querySelector('.msg.a .codewrap .codebar .lang')`, 10000, '代码块工具条')
        await app.waitFor(`[...document.querySelectorAll('.msg.a .md pre code')].some(c=>c.textContent.includes('rich-code'))`, 10000, '代码内容渲染')
        await app.waitFor(`[...document.querySelectorAll('.msg.a a.filelink')].some(a=>a.textContent.includes('rich-note.md'))`, 12000, '本地文件链接可点击')
        await app.waitFor(`[...document.querySelectorAll('.msg.a img.mdimg')].some(i=>String(i.src).startsWith('data:image/'))`, 12000, '本地图片内联显示')
        await app.waitFor(`(() => { const f=document.querySelector('.msg.a .turnfoot'); return !!f && f.textContent.includes('工作耗时') })()`, 8000, '回合工作耗时')
        await app.call(() => {
          const a = [...document.querySelectorAll('.msg.a a.filelink')].find((x) => x.textContent.includes('rich-note.md'))
          if (a) a.click()
        })
        await app.waitFor(`[...document.querySelectorAll('.tab')].some((t)=>t.textContent.includes('rich-note.md'))`, 8000, '点击链接打开文件')
      } finally {
        await app.store('agents.save', { list: agents })
        await bindTask(app, '主任务改名', { agent_id: 'builtin' })
      }
    }
  },
  {
    name: '输入 @ 选择文件路径',
    async run(app) {
      const t = await bindTask(app, '主任务改名', { agent_id: 'builtin', model_id: '' })
      await app.invoke('fs', 'writeFile', { path: path.join(t.path, 'mentionpick.md'), content: '# pick' })
      await selectTask(app, '主任务改名')
      await openAiTab(app)
      await app.waitFor(`(() => { const el=document.querySelector('#chatInput'); return !!el && !el.disabled })()`, 8000, '输入框可用')
      await app.setValue('#chatInput', '')
      await app.clickEl('#chatInput')
      await app.insertText('@mentionpick')
      await app.waitFor(`(() => {
        const m = document.querySelector('#chatMention')
        return !!m && m.style.display === 'block' && m.textContent.includes('mentionpick.md')
      })()`, 8000, '@ 选择器列出匹配文件')
      await app.pressKey({ key: 'Enter', code: 'Enter', keyCode: 13 })
      await app.waitFor(`(() => {
        const v = document.querySelector('#chatInput').value
        return v.trim() === '@mentionpick.md'
      })()`, 5000, '选中文件后填入路径')
      const hidden = await app.call(() => {
        const m = document.querySelector('#chatMention')
        return !m || m.style.display === 'none'
      })
      assert.ok(hidden, '选择后选择器应收起')
    }
  },
  {
    name: '输入 @ 引用文件夹',
    async run(app) {
      const t = await bindTask(app, '主任务改名', { agent_id: 'builtin', model_id: '' })
      await app.invoke('fs', 'mkdir', { path: path.join(t.path, 'folderdir') })
      await selectTask(app, '主任务改名')
      await openAiTab(app)
      await app.waitFor(`(() => { const el=document.querySelector('#chatInput'); return !!el && !el.disabled })()`, 8000, '输入框可用')
      await app.setValue('#chatInput', '')
      await app.clickEl('#chatInput')
      await app.insertText('@folderdir')
      await app.waitFor(`(() => {
        const m = document.querySelector('#chatMention')
        return !!m && m.style.display === 'block' &&
          [...m.querySelectorAll('.mi.dir')].some((r) => r.textContent.includes('folderdir'))
      })()`, 8000, '@ 选择器列出匹配文件夹')
      await app.pressKey({ key: 'Enter', code: 'Enter', keyCode: 13 })
      await app.waitFor(`document.querySelector('#chatInput').value.trim() === '@folderdir/'`, 5000, '引用文件夹路径（结尾带斜杠）')
    }
  },
  {
    name: '输入 @ 用 Tab 进入目录并继续选择',
    async run(app) {
      const t = await bindTask(app, '主任务改名', { agent_id: 'builtin', model_id: '' })
      await app.invoke('fs', 'mkdir', { path: path.join(t.path, 'navdir') })
      await app.invoke('fs', 'writeFile', { path: path.join(t.path, 'navdir', 'inner.md'), content: '# inner' })
      await selectTask(app, '主任务改名')
      await openAiTab(app)
      await app.waitFor(`(() => { const el=document.querySelector('#chatInput'); return !!el && !el.disabled })()`, 8000, '输入框可用')
      await app.setValue('#chatInput', '')
      await app.clickEl('#chatInput')
      await app.insertText('@navdir')
      await app.waitFor(`[...document.querySelectorAll('#chatMention .mi.dir .mn')].some((x)=>x.textContent==='navdir')`, 8000, '文件夹条目出现')
      // Tab 进入文件夹：不应插入引用，而应停在 navdir/ 并展示其中内容（无需再删字符）
      await app.pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 })
      await app.waitFor(`document.querySelector('#chatInput').value === '@navdir/'`, 5000, 'Tab 进入后停在目录路径')
      await app.waitFor(`(() => {
        const m = document.querySelector('#chatMention')
        if (!m || m.style.display !== 'block') return false
        const names = [...m.querySelectorAll('.mi .mn')].map((x) => x.textContent)
        return names.includes('..（上层）') && names.includes('inner.md')
      })()`, 5000, '无需退格即展示子目录内容与 .. 上层')
      // 越过 .. 选中 inner.md 并确认
      await app.pressKey({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 })
      await app.pressKey({ key: 'Enter', code: 'Enter', keyCode: 13 })
      await app.waitFor(`document.querySelector('#chatInput').value.trim() === '@navdir/inner.md'`, 5000, '确认后填入子文件路径')
    }
  },
  {
    name: '运行中发送进入队列，AI 结束后自动接力',
    async run(app) {
      const first = Array.from({ length: 10 }, (_, i) => `慢${i + 1}`)
      const server = await startFakeAI({
        delay: 200,
        respond: (parsed, index) => {
          const msgs = parsed.messages || []
          const last = msgs[msgs.length - 1]
          const txt = (last && last.content) || ''
          if (index === 1) return first
          return ['回声：' + txt]
        }
      })
      try {
        const setup = await setupProviderModel(app, { url: server.url, name: '队列提供方' })
        const t = await bindTask(app, '主任务改名', { agent_id: 'builtin', model_id: setup.mid })
        await selectTask(app, '主任务改名')
        await openAiTab(app)
        await sendChat(app, '队列第一条')
        await app.waitFor(`document.querySelector('#chatStop').style.display !== 'none'`, 10000, '运行中显示停止')
        // 运行中继续发送 → 进入队列、显示在输入框上方
        await app.setValue('#chatInput', '排队的第二条')
        await app.click('#chatSend')
        await app.waitFor(`!!document.querySelector('#chatQueue.on')`, 5000, '队列面板出现')
        await app.waitFor(`[...document.querySelectorAll('#chatQueue .qrow .qt')].some(e=>e.textContent.includes('排队的第二条'))`, 5000, '队列显示排队的消息')
        // 第一轮结束后自动接力发出队列消息
        await app.waitFor(`[...document.querySelectorAll('.msg.u .bub')].some(b=>b.textContent.includes('排队的第二条'))`, 20000, '排队消息作为新一轮发出')
        await app.waitFor(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('回声：排队的第二条'))`, 20000, '排队消息得到回复')
        await app.waitFor(`!document.querySelector('#chatQueue.on')`, 8000, '队列耗尽后隐藏')
        const msgs = await messagesOf(app, t.id)
        assert.ok(msgs.some((m) => m.role === 'user' && String(m.content).includes('排队的第二条')), '排队消息应落库')
      } finally {
        await server.close()
        await bindTask(app, '主任务改名', { model_id: '' })
      }
    }
  },
  {
    name: '排队消息可取消；停止时队列回写到输入框',
    async run(app) {
      const first = Array.from({ length: 12 }, (_, i) => `慢${i + 1}`)
      const server = await startFakeAI({ delay: 200, respond: (parsed, index) => (index === 1 ? first : ['回声']) })
      try {
        const setup = await setupProviderModel(app, { url: server.url, name: '队列停止提供方' })
        await bindTask(app, '主任务改名', { agent_id: 'builtin', model_id: setup.mid })
        await selectTask(app, '主任务改名')
        await openAiTab(app)
        await sendChat(app, '停止队列第一条')
        await app.waitFor(`document.querySelector('#chatStop').style.display !== 'none'`, 10000, '运行中')
        await app.setValue('#chatInput', '排队甲')
        await app.click('#chatSend')
        await app.setValue('#chatInput', '排队乙')
        await app.click('#chatSend')
        await app.waitFor(`document.querySelectorAll('#chatQueue .qrow').length === 2`, 5000, '两条排队')
        // 取消「排队乙」
        await app.call(() => {
          const row = [...document.querySelectorAll('#chatQueue .qrow')].find((r) => r.textContent.includes('排队乙'))
          const btn = row && row.querySelector('[data-qrm]')
          if (btn) btn.click()
        })
        await app.waitFor(`document.querySelectorAll('#chatQueue .qrow').length === 1`, 5000, '取消后剩一条')
        await app.waitFor(`[...document.querySelectorAll('#chatQueue .qt')].some(e=>e.textContent.includes('排队甲'))`, 5000, '剩余为排队甲')
        // 停止：队列回写到输入框并清空
        await app.click('#chatStop')
        await app.waitFor(`document.querySelector('#chatInput').value.includes('排队甲')`, 5000, '停止后队列回写输入框')
        await app.waitFor(`!document.querySelector('#chatQueue.on')`, 5000, '停止后队列清空')
      } finally {
        await server.close()
        await bindTask(app, '主任务改名', { model_id: '' })
      }
    }
  },
  {
    name: '跨任务询问：@@ASK 协议作答，标记不外泄',
    async run(app) {
      const server = await startFakeAI({
        delay: 20,
        respond(parsed) {
          const msgs = (parsed && parsed.messages) || []
          const sys = String((msgs[0] && msgs[0].content) || '')
          const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
          const lu = lastUser ? String(lastUser.content || '') : ''
          if (sys.includes('当前任务「资料库B」')) return ['关键配置：答案是42。']
          if (lu.includes('跨任务询问结果')) return ['根据资料库B，答案是42。']
          return ['我需要确认一下：@@ASK{"task":"资料库B","q":"关键配置是什么"}@@']
        }
      })
      const setup = await setupProviderModel(app, { url: server.url, name: '跨任务提供方' })
      let a = null
      let b = null
      try {
        a = await createTaskUI(app, { name: '问询方A', type: 'work' })
        b = await createTaskUI(app, { name: '资料库B', type: 'work' })
        await app.store('tasks.update', { id: a.id, patch: { agent_id: 'builtin', model_id: setup.mid } })
        await app.store('tasks.update', { id: b.id, patch: { agent_id: 'builtin', model_id: setup.mid } })
        const init = await app.invoke('chat', 'init', { taskId: a.id })
        const sent = await app.invoke('chat', 'send', { taskId: a.id, sessionId: init.session.id, text: '请告诉我关键配置' })
        await app.waitFor(`(async () => {
          const r = await window.zzwork.invoke('store', 'runs.get', { id: ${JSON.stringify(sent.runId)} })
          return !!(r && r.status !== 'running')
        })()`, 30000, '问询方运行结束')
        const msgs = await app.store('messages.list', { taskId: a.id })
        const last = [...msgs].reverse().find((m) => m.role === 'assistant')
        assert.ok(last, '应有助手回复')
        assert.ok(String(last.content).includes('答案是42'), '应使用对方答复继续作答：' + last.content)
        assert.ok(!String(last.content).includes('@@ASK'), '协议标记不应进入对话内容：' + last.content)
        // 目标任务拿到一个隐藏的 ask 会话；init 列表不暴露该会话
        const bSessions = await app.store('sessions.list', { taskId: b.id })
        assert.ok(bSessions.some((s) => s.kind === 'ask'), '目标任务应创建隐藏 ask 会话')
        const initB = await app.invoke('chat', 'init', { taskId: b.id })
        assert.ok((initB.sessions || []).every((s) => s.kind !== 'ask'), 'init 不应暴露 ask 会话')
      } finally {
        await server.close()
        try { if (a) await app.store('tasks.delete', { id: a.id }) } catch {}
        try { if (b) await app.store('tasks.delete', { id: b.id }) } catch {}
        try { await app.store('providers.delete', { id: setup.pid }) } catch {}
      }
    }
  },
  {
    name: '看板任务不能被跨任务询问',
    async run(app) {
      const board = await app.invoke('board', 'create', { title: '看板不可问', content: 'x' })
      let a = null
      try {
        a = await createTaskUI(app, { name: '发问者C', type: 'work' })
        const r = await app.invoke('chat', 'askTask', { fromTaskId: a.id, targetTaskId: board.id, question: '在吗' })
        assert.equal(r.ok, false, '看板任务不应被询问')
        assert.ok(String(r.error || '').includes('看板'), '应提示看板任务不可询问：' + r.error)
      } finally {
        try { if (a) await app.store('tasks.delete', { id: a.id }) } catch {}
        try { await app.store('tasks.delete', { id: board.id }) } catch {}
      }
    }
  },
  {
    name: '分层询问清单：本组带完整简介+关键信息名称，其他组带组简介（含各任务一句话说明）',
    async run(app) {
      let reqSeen = ''
      const server = await startFakeAI({
        delay: 10,
        respond(parsed) {
          const msgs = (parsed && parsed.messages) || []
          const sys = String((msgs[0] && msgs[0].content) || '')
          if (sys.includes('分组简介生成器')) {
            return ['【组简介】\nB组负责集中存放资料\n【任务】\n- 资料库B：存放关键配置与账号']
          }
          // 跨任务清单现在拼在最后一条用户消息里（而非 system），抓全量请求文本断言
          reqSeen = msgs.map((m) => String(m.content || '')).join('\n')
          return ['收到。']
        }
      })
      const setup = await setupProviderModel(app, { url: server.url, name: '分层提供方' })
      let gA = null
      let gB = null
      let cur = null
      let sib = null
      let tB = null
      try {
        gA = await app.store('groups.create', { name: 'A组' })
        gB = await app.store('groups.create', { name: 'B组' })
        cur = await createTaskUI(app, { name: '当前任务', type: 'code' })
        sib = await createTaskUI(app, { name: 'A组兄弟', type: 'work' })
        tB = await createTaskUI(app, { name: '资料库B', type: 'work' })
        await app.store('tasks.update', { id: cur.id, patch: { group_id: gA.id, agent_id: 'builtin', model_id: setup.mid } })
        await app.store('tasks.update', {
          id: sib.id,
          patch: { group_id: gA.id, brief: '负责A组兄弟的完整简介内容', meta: JSON.stringify({ keyinfoNames: ['数据库账号', '接口密钥'] }) }
        })
        await app.store('tasks.update', { id: tB.id, patch: { group_id: gB.id, brief: '存放B组资料' } })
        // 生成 B 组简介（fake AI 返回整体职责 + 各任务一句话说明）
        const gb = await app.invoke('chat', 'groupBrief', { groupId: gB.id })
        assert.ok(gb && gb.ok, '组简介应生成成功')
        const gbRow = await app.store('groups.get', { id: gB.id })
        assert.ok(String(gbRow.brief || '').includes('资料库B：存放关键配置'), '组简介应含各任务一句话说明：' + gbRow.brief)

        const init = await app.invoke('chat', 'init', { taskId: cur.id })
        const sent = await app.invoke('chat', 'send', { taskId: cur.id, sessionId: init.session.id, text: '开始' })
        await app.waitFor(`(async () => {
          const r = await window.zzwork.invoke('store', 'runs.get', { id: ${JSON.stringify(sent.runId)} })
          return !!(r && r.status !== 'running')
        })()`, 30000, '当前任务运行结束')

        assert.ok(reqSeen.includes('【本组'), '应含本组分区：' + reqSeen)
        assert.ok(reqSeen.includes('A组兄弟：负责A组兄弟的完整简介内容'), '本组兄弟应带完整简介')
        assert.ok(reqSeen.includes('掌握：数据库账号、接口密钥'), '本组兄弟应带关键信息名称（仅名称）')
        assert.ok(reqSeen.includes('【其他组】'), '应含其他组分区')
        assert.ok(reqSeen.includes('资料库B：存放关键配置'), '其他组应带组简介含各任务一句话说明')
      } finally {
        await server.close()
        try { if (cur) await app.store('tasks.delete', { id: cur.id }) } catch {}
        try { if (sib) await app.store('tasks.delete', { id: sib.id }) } catch {}
        try { if (tB) await app.store('tasks.delete', { id: tB.id }) } catch {}
        try { if (gA) await app.store('groups.delete', { id: gA.id }) } catch {}
        try { if (gB) await app.store('groups.delete', { id: gB.id }) } catch {}
        try { await app.store('providers.delete', { id: setup.pid }) } catch {}
      }
    }
  },
  {
    name: '回合结束记录输入/输出/缓存 token 统计并落盘',
    async run(app) {
      const server = await startFakeAI({
        delay: 10,
        chunks: ['答复内容'],
        usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540, prompt_tokens_details: { cached_tokens: 900 } }
      })
      const setup = await setupProviderModel(app, { url: server.url, name: '统计提供方' })
      let t = null
      try {
        t = await createTaskUI(app, { name: '统计任务', type: 'work' })
        await app.store('tasks.update', { id: t.id, patch: { agent_id: 'builtin', model_id: setup.mid } })
        const init = await app.invoke('chat', 'init', { taskId: t.id })
        const sent = await app.invoke('chat', 'send', { taskId: t.id, sessionId: init.session.id, text: '你好' })
        await app.waitFor(`(async () => {
          const r = await window.zzwork.invoke('store', 'runs.get', { id: ${JSON.stringify(sent.runId)} })
          return !!(r && r.status !== 'running')
        })()`, 30000, '运行结束')
        const run = await app.store('runs.get', { id: sent.runId })
        assert.equal(Number(run.input_tokens), 1200, '输入 token')
        assert.equal(Number(run.output_tokens), 340, '输出 token')
        assert.equal(Number(run.cached_tokens), 900, '缓存 token')
        // 会话累计：input+output 应可在 runs.list 聚合
        const runs = await app.store('runs.list', { taskId: t.id, sessionId: init.session.id })
        const total = (runs || []).reduce((n, r) => n + ((r.input_tokens || 0) + (r.output_tokens || 0) || (r.tokens || 0)), 0)
        assert.equal(total, 1540, '会话累计 token')
        // 助手消息 meta 落盘，刷新后仍可显示
        const msgs = await app.store('messages.list', { taskId: t.id })
        const last = [...msgs].reverse().find((m) => m.role === 'assistant')
        const meta = typeof last.meta === 'string' ? JSON.parse(last.meta) : last.meta
        assert.equal(Number(meta.inputTokens), 1200, '消息输入 token')
        assert.equal(Number(meta.outputTokens), 340, '消息输出 token')
        assert.equal(Number(meta.cachedTokens), 900, '消息缓存 token')
      } finally {
        await server.close()
        try { if (t) await app.store('tasks.delete', { id: t.id }) } catch {}
        try { await app.store('providers.delete', { id: setup.pid }) } catch {}
      }
    }
  }
]
