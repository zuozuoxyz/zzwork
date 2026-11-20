import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeAI, sleep } from '../harness.mjs'
import { selectTask, setView, ensureTask } from './_helpers.mjs'

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
        await app.waitFor(`document.querySelector('#chatSend').style.display !== 'none'`, 15000, '发送按钮恢复')
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
        const order = await app.call(() => {
          const msgs = document.querySelectorAll('#chatInner .msg.a')
          const el = msgs[msgs.length - 1]
          const parts = el && el.querySelector('.parts')
          return parts ? Array.from(parts.children).map((c) => String(c.className).split(' ')[0]) : []
        })
        assert.ok(order.includes('workbox') && order.includes('abody'), '合并工作框与正文应同时存在: ' + order)
        assert.ok(order.indexOf('workbox') < order.indexOf('abody'), '工作框应在正文之前: ' + order)
        const txt = await app.call(() => document.querySelector('#chatInner').textContent)
        assert.ok(!txt.includes('CODEX-NOISE'), '命令输出等噪音不应出现在对话里')
        const msgs = await messagesOf(app, t.id)
        const last = msgs[msgs.length - 1]
        assert.ok(last.content.includes('CODEX-FAKE 收到：codex你好'))
        assert.ok(!last.content.includes('CODEX-NOISE'))
        assert.ok(String(last.meta || '').includes('CODEX-THINK'), '思考过程应随消息落库')
        assert.ok(String(last.meta || '').includes('ls'), '运行步骤应随消息落库')
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
      const msgs = await messagesOf(app, t.id)
      const last = msgs[msgs.length - 1]
      assert.ok(last.content.includes('已回答：A 选项'), '回答应反馈给模型并落库')
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
      await app.setValue('#sessionPrompt', '请使用简洁的中文回答')
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
      await app.call(() => {
        const c = document.querySelector('#cvsCanvas')
        c.setPointerCapture = () => {}
        const r = c.getBoundingClientRect()
        const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }))
        ev('pointerdown', r.left + 20, r.top + 20)
        ev('pointermove', r.left + 50, r.top + 60)
        ev('pointerup', r.left + 50, r.top + 60)
        return true
      })
      await app.waitFor(`(async () => {
        const raw = await window.zzwork.invoke('store', 'settings.get', { key: ${JSON.stringify('session:canvas:' + t.id)}, dflt: '' })
        if (!raw) return false
        try {
          const d = JSON.parse(raw)
          return Array.isArray(d.strokes) && d.strokes.length >= 1
        } catch { return false }
      })()`, 5000, '画板数据保存')
      await app.click('#cvsClear')
      await app.waitFor(`(async () => {
        const raw = await window.zzwork.invoke('store', 'settings.get', { key: ${JSON.stringify('session:canvas:' + t.id)}, dflt: '' })
        const d = raw ? JSON.parse(raw) : { strokes: [] }
        return !d.strokes || d.strokes.length === 0
      })()`, 5000, '画板清空')
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
  }
]
