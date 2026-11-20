import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { selectTask, setView, waitToast, ensureTask } from './_helpers.mjs'

async function openSettings(app) {
  await app.click('#abSet')
  await app.waitFor(`document.querySelector('#pane-settings').classList.contains('on')`)
  await app.waitFor(`(() => { const b=document.querySelector('#settingsBody'); return !!b && b.textContent.includes('SQLite') })()`, 8000, '设置内容渲染')
}

export default [
  {
    name: '设置页渲染（数据存储信息）',
    async run(app) {
      await openSettings(app)
      const txt = await app.text('#settingsBody')
      assert.ok(txt.includes('SQLite'), txt.slice(0, 120))
      assert.ok(txt.includes('工作目录'))
      assert.ok(await app.exists('#changeWorkdir'))
      assert.ok(await app.exists('#toggleAutoAi'))
      assert.ok(txt.includes('Electron'))
    }
  },
  {
    name: '切换新任务默认类型',
    async run(app) {
      await openSettings(app)
      const before = await app.store('settings.get', { key: 'newTask:type', dflt: 'work' })
      await app.click('#toggleDefType')
      await app.waitFor(`document.querySelector('#defTypeVal').textContent !== ${JSON.stringify(before)}`)
      const after = await app.store('settings.get', { key: 'newTask:type', dflt: 'work' })
      assert.notEqual(after, before)
      await app.click('#toggleDefType')
      await app.waitFor(`document.querySelector('#defTypeVal').textContent === ${JSON.stringify(before)}`)
    }
  },
  {
    name: '自动打开 AI 对话开关',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await ensureTask(app, '路径任务', { type: 'code' })
      await openSettings(app)
      const cur = await app.store('settings.get', { key: 'ui:autoOpenAi', dflt: '1' })
      if (cur !== '0') await app.click('#toggleAutoAi')
      await app.waitFor(`true`)
      assert.equal(await app.store('settings.get', { key: 'ui:autoOpenAi', dflt: '1' }), '0')
      await selectTask(app, '路径任务')
      await app.waitFor(`document.querySelector('#pane-info').classList.contains('on')`)
      assert.equal(await app.call(() => document.querySelector('#pane-ai').classList.contains('on')), false)

      await openSettings(app)
      await app.click('#toggleAutoAi')
      await app.waitFor(`true`)
      assert.equal(await app.store('settings.get', { key: 'ui:autoOpenAi', dflt: '1' }), '1')
      await selectTask(app, '主任务改名')
      await app.waitFor(`document.querySelector('#pane-ai').classList.contains('on')`, 8000, '自动打开 AI 面板')
    }
  },
  {
    name: '更换工作目录',
    async run(app, sb) {
      const before = await app.store('settings.get', { key: 'workdir', dflt: '' })
      // 先把工作目录指到一个没有任务的位置，避免这里触发任务迁移
      await app.store('settings.set', { key: 'workdir', value: path.join(sb.work, 'nowork') })
      await openSettings(app)
      await app.waitFor(`document.querySelector('#settingsBody').textContent.includes('nowork')`, 8000)
      await app.click('#changeWorkdir')
      await app.waitFor(`document.querySelector('#settingsBody').textContent.includes(${JSON.stringify(sb.pick)})`, 8000)
      assert.equal(await app.store('settings.get', { key: 'workdir', dflt: '' }), sb.pick)
      await app.store('settings.set', { key: 'workdir', value: before })
    }
  },
  {
    name: '更换工作目录时迁移旧目录下的任务文件夹',
    async run(app, sb) {
      const before = await app.store('settings.get', { key: 'workdir', dflt: '' })
      const oldRoot = path.join(sb.work, 'mig-old')
      const oldPath = path.join(oldRoot, 'migx')
      fs.mkdirSync(oldPath, { recursive: true })
      fs.writeFileSync(path.join(oldPath, 'keep.txt'), 'k')
      const task = await app.store('tasks.create', { dto: { name: '迁移任务X', type: 'work', path: oldPath } })
      await app.store('settings.set', { key: 'workdir', value: oldRoot })
      await openSettings(app)
      await app.waitFor(`document.querySelector('#settingsBody').textContent.includes(${JSON.stringify(oldRoot)})`, 8000)
      await app.click('#changeWorkdir')
      const newPath = path.join(sb.pick, 'migx')
      let moved = null
      for (let i = 0; i < 40; i++) {
        const t = (await app.store('tasks.list')).find((x) => x.id === task.id)
        if (t && t.path === newPath) { moved = t; break }
        await new Promise((r) => setTimeout(r, 200))
      }
      assert.ok(moved, '任务路径未迁移')
      assert.ok(fs.existsSync(path.join(newPath, 'keep.txt')), '文件夹未移动')
      assert.ok(!fs.existsSync(oldPath), '旧文件夹应已移走')
      await app.store('settings.set', { key: 'workdir', value: before })
      fs.rmSync(newPath, { recursive: true, force: true })
      await app.store('tasks.delete', { id: task.id })
    }
  }
]
