import assert from 'node:assert/strict'
import { ensureTask, selectTask } from './_helpers.mjs'

async function openPanel(app) {
  if (!(await app.call(() => document.querySelector('.term-panel').classList.contains('on')))) {
    await app.click('#termToggle')
  }
  await app.waitFor(`document.querySelector('.term-panel').classList.contains('on')`, 8000, '终端面板打开')
}

async function ensureXterm(app) {
  if (!(await app.exists('.term-panel .xterm'))) {
    await app.call(() => {
      const b = document.querySelector('#termEmptyNew') || document.querySelector('#termNew')
      if (b) b.click()
      return !!b
    })
  }
  await app.waitFor(`!!document.querySelector('.term-panel .xterm')`, 10000, 'xterm 挂载')
}

async function terms(app) {
  return app.invoke('terminal', 'list', {})
}

export default [
  {
    name: '终端面板打开与命令往返',
    async run(app) {
      await ensureTask(app, '终端甲', { type: 'work' })
      await selectTask(app, '终端甲')
      await openPanel(app)
      await ensureXterm(app)
      await app.waitFor(`window.zzwork.invoke('terminal','list',{}).then(l => l.length > 0)`, 45000, 'PTY 创建')
      const [t] = await terms(app)
      assert.ok(t && t.title, '终端应创建成功')
      await app.invoke('terminal', 'write', { id: t.id, data: 'echo ZZTERM-T1\r' })
      await app.waitFor(
        `(() => { const el = document.querySelector('.term-panel .xterm-rows'); return !!el && el.textContent.includes('ZZTERM-T1') })()`,
        45000, '命令回显'
      )
      // 窗格宽度必须撑满面板且稳定（防止 fit() 与内容宽互相追赶导致缩圈）
      const w1 = await app.call(() => Math.round(document.querySelector('.term-panel .term-pane').getBoundingClientRect().width))
      await new Promise((r) => setTimeout(r, 800))
      const w2 = await app.call(() => Math.round(document.querySelector('.term-panel .term-pane').getBoundingClientRect().width))
      const bodyW = await app.call(() => Math.round(document.querySelector('.term-body').getBoundingClientRect().width))
      assert.ok(w1 > bodyW * 0.95 && w2 === w1, `窗格宽度异常 ${w1}->${w2}（面板 ${bodyW}）`)
    }
  },
  {
    name: '终端复制与粘贴',
    async run(app) {
      await selectTask(app, '终端甲')
      await openPanel(app)
      await ensureXterm(app)
      const [t] = await terms(app)
      await app.invoke('terminal', 'write', { id: t.id, data: 'echo ZZCLIP-SEL\r' })
      await app.waitFor(`(() => { const el = document.querySelector('.term-panel .xterm-rows'); return !!el && el.textContent.includes('ZZCLIP-SEL') })()`, 25000, '输出出现')

      // 鼠标拖选整屏 + Ctrl+C 复制
      const r = await app.call(() => {
        const el = document.querySelector('.term-panel .xterm-screen')
        const b = el.getBoundingClientRect()
        return { x: b.left, y: b.top, w: b.width, h: b.height }
      })
      const mouse = (type, x, y, buttons) => app.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0 })
      await mouse('mousePressed', r.x + 8, r.y + 6, 1)
      await mouse('mouseMoved', r.x + r.w - 12, r.y + r.h - 40, 1)
      await mouse('mouseReleased', r.x + r.w - 12, r.y + r.h - 40, 0)
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyC', key: 'c', windowsVirtualKeyCode: 67, modifiers: 2 })
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyC', key: 'c', windowsVirtualKeyCode: 67, modifiers: 2 })
      await app.waitFor(`window.zzwork.invoke('terminal','paste').then(x => (x || '').includes('ZZCLIP-SEL'))`, 8000, 'Ctrl+C 复制选区')

      // 右键菜单粘贴
      await app.invoke('terminal', 'copy', { text: 'echo ZZCLIP-OK\r' })
      await app.call(() => {
        const el = document.querySelector('.term-panel .term-pane')
        const b = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: Math.round(b.left + 20), clientY: Math.round(b.top + 20) }))
        return true
      })
      await app.waitFor(() => !!document.querySelector('#ctx-host .zz-ctx'), 3000, '右键菜单')
      await app.clickText('#ctx-host .zz-ctx button', '粘贴')
      await app.waitFor(`(() => { const el = document.querySelector('.term-panel .xterm-rows'); return !!el && el.textContent.includes('ZZCLIP-OK') })()`, 20000, '菜单粘贴执行')
    }
  },
  {
    name: '终端分屏与关闭窗格',
    async run(app) {
      await selectTask(app, '终端甲')
      await openPanel(app)
      await ensureXterm(app)
      if ((await app.call(() => document.querySelectorAll('.term-panel .term-pane').length)) < 1) {
        await app.call(() => { const b = document.querySelector('#termNew'); if (b) b.click(); return true })
        await app.waitFor(`!!document.querySelector('.term-panel .xterm')`, 10000, '首窗格')
      }
      const base = (await app.call(() => document.querySelectorAll('.term-panel .term-pane').length)) || 0
      await app.click('#termSplitH')
      await app.waitFor(`document.querySelectorAll('.term-panel .term-pane').length === ${base + 1}`, 8000, '水平分屏')
      await app.click('#termSplitV')
      await app.waitFor(`document.querySelectorAll('.term-panel .term-pane').length === ${base + 2}`, 8000, '垂直分屏')
      await app.waitFor(`window.zzwork.invoke('terminal','list',{}).then(l => l.length >= ${base + 2})`, 25000, '分屏 PTY')
      // 关闭最后一个窗格
      await app.call(() => {
        const px = document.querySelectorAll('.term-panel .term-px')
        px[px.length - 1].click()
        return true
      })
      await app.waitFor(`document.querySelectorAll('.term-panel .term-pane').length === ${base + 1}`, 8000, '窗格关闭')
      await app.waitFor(`window.zzwork.invoke('terminal','list',{}).then(l => l.length === ${base + 1})`, 10000, 'PTY 回收')
      // 分隔条需有可拖拽高度/宽度
      const box = await app.call(() => {
        const d = document.querySelector('.term-panel .term-divider')
        if (!d) return null
        const r = d.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      })
      assert.ok(box && box.w > 0 && box.h > 50, '分隔条尺寸异常: ' + JSON.stringify(box))
    }
  },
  {
    name: '终端随任务切换保留并持久化布局',
    async run(app) {
      await ensureTask(app, '终端乙', { type: 'work' })
      await selectTask(app, '终端甲')
      await openPanel(app)
      await ensureXterm(app)
      const panes0 = await app.call(() => document.querySelectorAll('.term-panel .term-pane').length)
      const tabs0 = await app.call(() => document.querySelectorAll('#termTabs .term-tab').length)
      const n0 = (await terms(app)).length
      assert.ok(panes0 >= 1 && n0 >= 1, '原任务应有终端')

      await selectTask(app, '终端乙')
      await app.waitFor(`!!document.querySelector('.term-empty')`, 8000, '新任务显示空状态')

      await selectTask(app, '终端甲')
      await app.waitFor(`document.querySelectorAll('.term-panel .term-pane').length === ${panes0}`, 10000, '切回后窗格保留')
      await app.waitFor(`document.querySelectorAll('#termTabs .term-tab').length === ${tabs0}`, 8000, '切回后标签不应重复')
      await app.waitFor(`window.zzwork.invoke('terminal','list',{}).then(l => l.length === ${n0})`, 25000, '切回后 PTY 数量不变')
      const taskId = (await app.store('tasks.list')).find((t) => t.name === '终端甲').id
      const saved = await app.store('settings.get', { key: 'terminal:layout:' + taskId, dflt: '' })
      assert.ok(saved && saved.length > 10, '布局应已持久化')
    }
  },
  {
    name: 'exit 正常退出自动关闭窗格',
    async run(app) {
      await selectTask(app, '终端甲')
      await openPanel(app)
      await ensureXterm(app)
      const base = await app.call(() => document.querySelectorAll('.term-panel .term-pane').length)
      const before = (await terms(app)).map((t) => t.id)
      await app.click('#termSplitH')
      await app.waitFor(`document.querySelectorAll('.term-panel .term-pane').length === ${base + 1}`, 8000, '分屏')
      await app.waitFor(`window.zzwork.invoke('terminal','list',{}).then(l => l.length === ${before.length + 1})`, 25000, '新 PTY')
      const fresh = (await terms(app)).find((t) => !before.includes(t.id))
      assert.ok(fresh, '应新建 PTY')
      await app.invoke('terminal', 'write', { id: fresh.id, data: 'exit\r' })
      await app.waitFor(`document.querySelectorAll('.term-panel .term-pane').length === ${base}`, 15000, 'exit 后窗格自动关闭')
      await app.waitFor(`window.zzwork.invoke('terminal','list',{}).then(l => l.length === ${before.length})`, 10000, 'PTY 回收')
    }
  },
  {
    name: '删除任务回收终端进程',
    async run(app) {
      await selectTask(app, '终端甲')
      await openPanel(app)
      await ensureXterm(app)
      await app.waitFor(`window.zzwork.invoke('terminal','list',{}).then(l => l.length > 0)`, 25000, 'PTY 存在')
      const taskId = (await app.store('tasks.list')).find((t) => t.name === '终端甲').id
      await app.contextMenuText('.row[data-task]', '终端甲', '删除任务')
      await app.waitFor(`![...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('终端甲'))`, 10000, '任务行消失')
      await app.waitFor(
        `window.zzwork.invoke('terminal','list',{ taskId: ${JSON.stringify(taskId)} }).then(l => l.length === 0)`,
        10000, '终端进程回收'
      )
    }
  }
]
