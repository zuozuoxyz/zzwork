import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTaskUI, selectTask, waitToast } from './_helpers.mjs'

const group = async (app, name) => (await app.store('groups.list')).find((g) => g.name === name)
const task = async (app, name) => (await app.store('tasks.list')).find((t) => t.name === name)

export default [
  {
    name: '新建组',
    async run(app) {
      await app.click('#newGroupBtn')
      await app.modalFill({ value: '回归组' })
      await app.modalOk()
      assert.ok(await group(app, '回归组'))
      await app.waitFor(`document.querySelector('#projectsBody').textContent.includes('回归组')`)
    }
  },
  {
    name: '在组内新建任务（目录 + info.md）',
    async run(app) {
      const g = await group(app, '回归组')
      await app.contextMenu(`.row[data-group="${g.id}"]`, '在此组新建任务')
      await app.modalFill({ name: '主任务', type: 'work', path: '' })
      await app.modalOk()
      await app.waitFor(`[...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('主任务'))`)
      const t = await task(app, '主任务')
      assert.ok(t)
      assert.equal(t.group_id, g.id)
      assert.equal(t.type, 'work')
      assert.ok(fs.existsSync(t.path), '任务目录应存在: ' + t.path)
      assert.ok(fs.existsSync(path.join(t.path, '.zzwork', 'info.md')), '.zzwork/info.md 应自动创建')
      await app.waitFor(`document.querySelector('#infoBody').textContent.includes('主任务')`)
      await app.waitFor(`document.querySelector('#stTask').textContent.includes('主任务')`)
    }
  },
  {
    name: '任务树分组计数与选中态',
    async run(app) {
      const g = await group(app, '回归组')
      assert.equal(await app.text(`.row[data-group="${g.id}"] .ds`), '1')
      assert.equal(await app.count('.row[data-task].sel'), 1)
    }
  },
  {
    name: '组折叠与展开',
    async run(app) {
      const g = await group(app, '回归组')
      await app.click(`.row[data-group="${g.id}"]`)
      await app.waitFor(`![...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('主任务'))`)
      await app.click(`.row[data-group="${g.id}"]`)
      await app.waitFor(`[...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('主任务'))`)
    }
  },
  {
    name: '侧栏过滤任务',
    async run(app) {
      await app.setValue('#cmdInput', '主任务')
      await app.waitFor(`document.querySelectorAll('.row[data-task]').length === 1`)
      await app.setValue('#cmdInput', '不存在的任务xyz')
      await app.waitFor(`document.querySelector('#projectsBody').textContent.includes('没有匹配的任务')`)
      await app.setValue('#cmdInput', '')
      await app.waitFor(`[...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('主任务'))`)
    }
  },
  {
    name: '重命名任务',
    async run(app) {
      await app.contextMenuText('.row[data-task]', '主任务', '重命名…')
      await app.modalFill({ value: '主任务改名' })
      await app.modalOk()
      await app.waitFor(`[...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('主任务改名'))`)
      assert.ok(await task(app, '主任务改名'))
    }
  },
  {
    name: '编辑任务路径',
    async run(app, sb) {
      const t = await createTaskUI(app, { name: '路径任务', type: 'code', path: path.join(sb.work, 'pathtask') })
      await app.contextMenuText('.row[data-task]', '路径任务', '编辑路径…')
      const target = path.join(sb.work, 'pathtask2')
      await app.modalFill({ value: target })
      await app.modalOk()
      await app.waitFor(`document.querySelector('#infoBody').textContent.includes('路径任务')`)
      const after = await task(app, '路径任务')
      assert.ok(after.path.toLowerCase().endsWith('pathtask2'), after.path)
      assert.ok(t.path.toLowerCase().endsWith('pathtask'), t.path)
      // 有组时，未分组任务应有独立分区标识，且不会被并入组
      assert.equal(after.group_id, null)
      await app.waitFor(`document.querySelector('#projectsBody').textContent.includes('未分组')`)
      const rows = await app.call(() => [...document.querySelectorAll('#projectsBody .row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()))
      const shIdx = rows.findIndex((r) => r.includes('未分组'))
      const taskIdx = rows.findIndex((r) => r.includes('路径任务'))
      assert.ok(shIdx >= 0 && taskIdx > shIdx, JSON.stringify(rows))
    }
  },
  {
    name: '删除任务（保留磁盘目录）',
    async run(app, sb) {
      const dir = path.join(sb.work, 'deleteme')
      const t = await createTaskUI(app, { name: '删除我', type: 'work', path: dir })
      assert.ok(fs.existsSync(dir))
      await app.contextMenuText('.row[data-task]', '删除我', '删除任务')
      await app.waitFor(`![...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('删除我'))`)
      assert.equal(await task(app, '删除我'), undefined, '任务记录应已删除')
      assert.ok(fs.existsSync(dir), '磁盘目录不应被删除')
      assert.ok(t)
    }
  },
  {
    name: '删除组后任务变为未分组',
    async run(app) {
      const g = await group(app, '回归组')
      await app.contextMenu(`.row[data-group="${g.id}"]`, '删除组')
      await app.waitFor(`!document.querySelector('.row[data-group]')`)
      assert.equal(await group(app, '回归组'), undefined)
      const t = await task(app, '主任务改名')
      assert.equal(t.group_id, null)
      await app.waitFor(`[...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('主任务改名'))`)
      await waitToast(app, '已删除组')
    }
  },
  {
    name: '新建任务绑定已有目录',
    async run(app, sb) {
      const t = await createTaskUI(app, { name: '已有目录任务', type: 'code', path: sb.pick })
      assert.ok(t)
      assert.equal(path.resolve(t.path).toLowerCase(), path.resolve(sb.pick).toLowerCase())
      assert.ok(fs.existsSync(path.join(sb.pick, '.zzwork', 'info.md')), '已有目录也应写入 .zzwork/info.md')
    }
  }
]
