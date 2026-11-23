import assert from 'node:assert/strict'
import { startFakeAI, sleep } from '../harness.mjs'
import { selectTask, ensureTask } from './_helpers.mjs'

const ctx = { ready: false, modelId: '', server: null }

async function ensureAI(app) {
  if (ctx.ready) return
  ctx.server = await startFakeAI({
    delay: 40,
    respond(body) {
      const msgs = (body && body.messages) || []
      const joined = msgs.map((m) => String(m.content || '')).join('\n')
      if (joined.includes('发送测试')) return ['收到提示词：', '已按提示词执行。']
      return ['好的。']
    }
  })
  const pid = await app.store('providers.upsert', {
    provider: { name: '会话提示词提供方', type: 'openai_compatible', base_url: ctx.server.url }
  })
  await app.store('models.upsert', {
    model: { name: '会话提示词模型', model_id: 'sp-1', type: 'openai_compatible', base_url: ctx.server.url, provider_id: pid, is_default: 1 }
  })
  const m = (await app.store('models.list')).find((x) => x.name === '会话提示词模型')
  ctx.modelId = m && m.id
  await app.invoke('secrets', 'set', { key: 'zzwork.key.provider.' + pid, value: 'sk-sp' })
  ctx.ready = true
}

async function ensureTaskWithModel(app, name) {
  const t = await ensureTask(app, name)
  await app.store('tasks.update', { id: t.id, patch: { agent_id: 'builtin', model_id: ctx.modelId } })
  return t
}

async function openSessionTab(app) {
  await app.waitFor(() => !!document.querySelector('.tab[data-pane="session"]'), 10000, '会话 tab')
  await app.click('.tab[data-pane="session"]')
  await app.waitFor(`document.querySelector('#pane-session').classList.contains('on')`, 8000, '会话 pane 打开')
}

// 提示词是可编辑富文本框（contenteditable），用 textContent + input 事件写入
async function setEditor(app, sel, text) {
  await app.call((s, t) => {
    const ed = document.querySelector(s)
    ed.textContent = t
    ed.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }, sel, text)
}

export default [
  {
    name: '提示词发送：作为用户消息进入 AI 对话并落库',
    async run(app) {
      await ensureAI(app)
      const t = await ensureTaskWithModel(app, '会话提示词任务')
      await selectTask(app, '会话提示词任务')
      await openSessionTab(app)
      // 提示词旁有可点击的发送按钮
      assert.ok(await app.exists('#sessionPromptSend'), '提示词旁应有发送按钮')
      await setEditor(app, '#sessionPrompt', '发送测试：请按提示词执行')
      // 提示词仍自动保存为本任务的系统提示词
      await app.waitFor(`(async () => {
        const v = await window.zzwork.invoke('store','settings.get',{ key: ${JSON.stringify('session:prompt:' + t.id)}, dflt: '' })
        return v === '发送测试：请按提示词执行'
      })()`, 8000, '提示词自动保存')
      await app.click('#sessionPromptSend')
      // 点击发送后切到 AI 对话
      await app.waitFor(`document.querySelector('#pane-ai').classList.contains('on')`, 8000, '切到 AI 对话')
      // 用户消息显示在 AI 对话中
      await app.waitFor(`[...document.querySelectorAll('#chatInner .msg.u .bub')].some(b=>b.textContent.includes('发送测试'))`, 15000, '用户消息出现在 AI 对话')
      // 落库：存在 user 消息
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('store','messages.list',{ taskId: ${JSON.stringify(t.id)} })
        return l.some(m => m.role==='user' && String(m.content).includes('发送测试'))
      })()`, 15000, '用户消息落库')
      // AI 回复出现（过程与结果）
      await app.waitFor(`[...document.querySelectorAll('#chatInner .msg.a .abody')].some(b=>b.textContent.includes('已按提示词执行'))`, 20000, 'AI 回复出现')
    }
  },
  {
    name: '对话记录：仅显示用户内容，点击查看过程与结果',
    async run(app) {
      await ensureAI(app)
      await selectTask(app, '会话提示词任务')
      await openSessionTab(app)
      // 记录里展示用户发送的内容
      await app.waitFor(`[...document.querySelectorAll('#sessionHistory .shrow-u .shtext')].some(e=>e.textContent.includes('发送测试'))`, 10000, '对话记录显示用户内容')
      // 只显示用户内容：助手回复不应出现在记录里
      const histText = await app.call(() => (document.querySelector('#sessionHistory') || {}).textContent || '')
      assert.ok(!histText.includes('已按提示词执行'), '对话记录仅显示用户内容')
      // 长文本悬停显示完整内容
      const tip = await app.call(() => {
        const row = [...document.querySelectorAll('#sessionHistory .shrow-u')].find((e) => e.textContent.includes('发送测试'))
        return row ? row.getAttribute('title') : ''
      })
      assert.ok(String(tip).includes('发送测试'), '记录行 title 提供完整内容悬停')
      // 点击该记录 → 弹出该轮问答详情（用户输入 + AI 过程与结果），不跳转 AI 对话
      await app.call(() => {
        const row = [...document.querySelectorAll('#sessionHistory .shrow-u')].find((e) => e.textContent.includes('发送测试'))
        if (row) row.click()
        return true
      })
      await app.waitFor(`!!document.querySelector('.zz-modal.sd-modal')`, 8000, '点击记录弹出问答详情')
      await app.waitFor(`(() => {
        const b = document.querySelector('.zz-modal.sd-modal .sd-body')
        return !!b && b.textContent.includes('发送测试') && b.textContent.includes('已按提示词执行')
      })()`, 8000, '详情含用户输入与过程结果')
      await app.click('.zz-modal.sd-modal [data-act="close"]')
      await app.waitGone('.zz-modal.sd-modal', 8000)
    }
  },
  {
    name: '提示词粘贴图片：生成附件并随发送进入 AI 对话',
    async run(app) {
      await ensureAI(app)
      const t = await ensureTaskWithModel(app, '会话提示词图片任务')
      await selectTask(app, '会话提示词图片任务')
      await openSessionTab(app)
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
      await app.call((data) => {
        const bin = atob(data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], 'paste.png', { type: 'image/png' }))
        const ev = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(ev, 'clipboardData', { value: dt })
        document.querySelector('#sessionPrompt').dispatchEvent(ev)
      }, b64)
      await app.waitFor(`document.querySelectorAll('#sessionPrompt .pe-img img').length >= 1`, 8000, '提示词内联图片出现')
      // 在图片前插入文字（保持图片存在），验证内联顺序与文本
      await app.call(() => {
        const ed = document.querySelector('#sessionPrompt')
        ed.focus()
        const sel = window.getSelection()
        const r = document.createRange()
        r.selectNodeContents(ed)
        r.collapse(true)
        sel.removeAllRanges()
        sel.addRange(r)
        document.execCommand('insertText', false, '发送测试：看这张图 ')
        return true
      })
      await app.click('#sessionPromptSend')
      // 用户消息气泡应显示缩略图，且附件元数据落库
      await app.waitFor(`document.querySelectorAll('#chatInner .msg.u .ubatt img.uimg').length >= 1`, 20000, '用户气泡显示图片缩略图')
      await app.waitFor(`(async () => {
        const l = await window.zzwork.invoke('store','messages.list',{ taskId: ${JSON.stringify(t.id)} })
        const um = l.filter(m => m.role==='user' && m.meta).pop()
        const meta = um ? (typeof um.meta === 'string' ? JSON.parse(um.meta) : um.meta) : null
        return !!(meta && Array.isArray(meta.attachments) && meta.attachments.length === 1)
      })()`, 15000, '附件元数据落库')
    }
  },
  {
    name: '提示词空格键可正常输入（画板激活时不被空格平移拦截）',
    async run(app) {
      await ensureAI(app)
      const t = await ensureTaskWithModel(app, '会话提示词空格任务')
      await selectTask(app, '会话提示词空格任务')
      await openSessionTab(app)
      // work 任务默认右栏为画板，画板的「空格平移」监听处于激活态
      await app.waitFor(`!document.querySelector('#boardHost').classList.contains('hidden')`, 5000, '画板激活')
      const prevented = await app.call(() => {
        const ed = document.querySelector('#sessionPrompt')
        ed.focus()
        const ev = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
        ed.dispatchEvent(ev)
        return ev.defaultPrevented
      })
      assert.equal(prevented, false, '提示词内空格不应被画板拦截')
      await app.call(() => {
        const ed = document.querySelector('#sessionPrompt')
        ed.textContent = '你好 世界'
        ed.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })
      await app.waitFor(`(async () => {
        const v = await window.zzwork.invoke('store','settings.get',{ key: ${JSON.stringify('session:prompt:' + t.id)}, dflt: '' })
        return v === '你好 世界'
      })()`, 8000, '含空格提示词保存')
    }
  },
  {
    name: '内联图片在任务切换后仍保留（不会退化为 [图片] 文字）',
    async run(app) {
      await ensureAI(app)
      const t = await ensureTaskWithModel(app, '会话提示词持久任务')
      await selectTask(app, '会话提示词持久任务')
      await openSessionTab(app)
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
      await app.call((data) => {
        const bin = atob(data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], 'keep.png', { type: 'image/png' }))
        const ev = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(ev, 'clipboardData', { value: dt })
        document.querySelector('#sessionPrompt').dispatchEvent(ev)
      }, b64)
      await app.waitFor(`document.querySelectorAll('#sessionPrompt .pe-img img').length >= 1`, 8000, '内联图片出现')
      // 等待存档写入（含内联图片 HTML）
      await app.waitFor(`(async () => {
        const v = await window.zzwork.invoke('store','settings.get',{ key: ${JSON.stringify('session:promptdoc:' + t.id)}, dflt: '' })
        return !!v && v.includes('pe-img')
      })()`, 8000, '图片存档写入')
      // 切到另一个任务再切回
      await ensureTaskWithModel(app, '临时切换的其他任务')
      await selectTask(app, '临时切换的其他任务')
      await selectTask(app, '会话提示词持久任务')
      await openSessionTab(app)
      // 切回后仍是图片，而不是退化为 [图片] 文字
      await app.waitFor(`document.querySelectorAll('#sessionPrompt .pe-img img').length >= 1`, 8000, '切回后图片仍在')
      const txt = await app.call(() => document.querySelector('#sessionPrompt').innerText)
      assert.ok(!String(txt).includes('[图片]'), '不应退化为 [图片] 文字')
    }
  },
  {
    name: '提示词内联图片可点击放大查看',
    async run(app) {
      await ensureAI(app)
      await ensureTaskWithModel(app, '会话提示词放大任务')
      await selectTask(app, '会话提示词放大任务')
      await openSessionTab(app)
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
      await app.call((data) => {
        const bin = atob(data)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], 'zoom.png', { type: 'image/png' }))
        const ev = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(ev, 'clipboardData', { value: dt })
        document.querySelector('#sessionPrompt').dispatchEvent(ev)
      }, b64)
      await app.waitFor(`document.querySelectorAll('#sessionPrompt .pe-img img').length >= 1`, 8000, '内联图片出现')
      await app.click('#sessionPrompt .pe-img img')
      await app.waitFor(`(() => {
        const z = document.querySelector('#zzImgZoom')
        if (!z || !z.classList.contains('on')) return false
        const im = z.querySelector('img')
        return !!im && String(im.getAttribute('src') || '').startsWith('data:image')
      })()`, 5000, '点击图片打开放大浮层')
      await app.call(() => { const z = document.querySelector('#zzImgZoom'); if (z) z.click(); return true })
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
