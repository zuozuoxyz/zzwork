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
      await app.modalFill({ name: '回归组' })
      await app.modalOk()
      assert.ok(await group(app, '回归组'))
      await app.waitFor(`document.querySelector('#projectsBody').textContent.includes('回归组')`)
      const g0 = await group(app, '回归组')
      assert.equal(g0.parent_id || '', '', '未选父组时应为顶层组')
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
      assert.ok((await app.count(`.row[data-group="${g.id}"] svg`)) >= 1, '组行应带图标')
      assert.ok((await app.count('.row[data-task].sel svg')) >= 1, '任务行应带类型图标')
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
    name: '删除任务到回收站（保留磁盘目录，可恢复）',
    async run(app, sb) {
      const dir = path.join(sb.work, 'deleteme')
      const t = await createTaskUI(app, { name: '删除我', type: 'work', path: dir })
      assert.ok(fs.existsSync(dir))
      await app.contextMenuText('.row[data-task]', '删除我', '移到回收站')
      await app.waitFor(`![...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('删除我'))`)
      assert.equal(await task(app, '删除我'), undefined, '任务列表不应包含回收站中的任务')
      const trashed = await app.store('tasks.trashed')
      assert.ok(trashed.some((x) => x.id === t.id), '任务应进入回收站')
      assert.ok(fs.existsSync(dir), '磁盘目录不应被删除')
      // 展开左侧回收站并恢复
      await app.click('.row.trash-head')
      await app.waitFor(`[...document.querySelectorAll('[data-trash-task]')].some(r=>r.textContent.includes('删除我'))`)
      await app.click('[data-trash-task] [data-trash-act="restore"]')
      await app.waitFor(`[...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('删除我'))`)
      assert.ok(await task(app, '删除我'), '恢复后应回到任务列表')
      assert.ok(!(await app.store('tasks.trashed')).some((x) => x.id === t.id))
      // 再次删除后彻底删除
      await app.contextMenuText('.row[data-task]', '删除我', '移到回收站')
      await app.waitFor(`[...document.querySelectorAll('[data-trash-task]')].some(r=>r.textContent.includes('删除我'))`)
      await app.click('[data-trash-task] [data-trash-act="purge"]')
      await app.waitFor(`![...document.querySelectorAll('[data-trash-task]')].some(r=>r.textContent.includes('删除我'))`)
      assert.ok(!(await app.store('tasks.trashed')).some((x) => x.id === t.id), '彻底删除后回收站不应包含')
      assert.ok(fs.existsSync(dir), '彻底删除任务记录也不应删除磁盘目录')
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
  },
  {
    name: '嵌套子组：在组内新建子组 + 删除父组上提',
    async run(app) {
      // 新建父组（顶层）
      await app.click('#newGroupBtn')
      await app.modalFill({ name: '集团客户' })
      await app.modalOk()
      const parent = await group(app, '集团客户')
      assert.ok(parent, '父组应创建成功')
      assert.equal(parent.parent_id || '', '', '顶层组无父级')
      await app.waitFor(`document.querySelector('.row[data-group="${parent.id}"]')`)

      // 在父组内新建子组（通过弹窗的父组下拉选择）
      await app.contextMenu(`.row[data-group="${parent.id}"]`, '在此组新建子组')
      await app.modalFill({ name: '华东区', parent: parent.id })
      await app.modalOk()
      const child = await group(app, '华东区')
      assert.ok(child, '子组应创建成功')
      assert.equal(child.parent_id, parent.id, '子组应记录父组 id')

      // 子组行渲染且比父组缩进更深
      await app.waitFor(`document.querySelector('.row[data-group="${child.id}"]')`)
      const pad = (id) => app.eval(`(() => { const n = document.querySelector('.row[data-group="${id}"]'); return n ? (parseFloat(n.style.paddingLeft) || 0) : -1 })()`)
      const pp = await pad(parent.id)
      const cp = await pad(child.id)
      assert.ok(cp > pp, `子组应缩进更深 parent=${pp} child=${cp}`)

      // 新建任务下拉应显示嵌套路径（父组 / 子组）
      await app.contextMenu(`.row[data-group="${child.id}"]`, '在此组新建任务')
      const optText = await app.eval(`(() => { const s = document.querySelector('#f_group'); if (!s) return ''; const o = [...s.options].find(x => x.value === ${JSON.stringify(child.id)}); return o ? o.textContent.trim() : '' })()`)
      assert.ok(optText.includes('集团客户') && optText.includes('华东区'), '组下拉应显示嵌套路径，实际：' + optText)
      // 在子组内创建任务
      await app.modalFill({ name: '华东任务', type: 'work', path: '' })
      await app.modalOk()
      await app.waitFor(`[...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('华东任务'))`)
      const ct = await task(app, '华东任务')
      assert.equal(ct.group_id, child.id, '子组内任务应归属子组')

      // 删除父组：子组及其任务上提为顶层
      await app.contextMenu(`.row[data-group="${parent.id}"]`, '删除组')
      await app.waitFor(`!document.querySelector('.row[data-group="${parent.id}"]')`)
      const child2 = await group(app, '华东区')
      assert.ok(child2, '删除父组后子组应保留')
      assert.equal(child2.parent_id || '', '', '子组应上提为顶层')
      const ct2 = await task(app, '华东任务')
      assert.equal(ct2.group_id, child2.id, '任务随子组保留归属，不被删除')
    }
  },
  {
    name: '拖拽换组：任务入组 / 子组挂靠 / 防环',
    async run(app, sb) {
      // 在页面内派发一组拖拽事件（依赖模块内 dragSource，无需真实鼠标）
      const drag = (srcSel, dstSel) => app.call((src, dst) => {
        const s = document.querySelector(src)
        const d = document.querySelector(dst)
        if (!s || !d) throw new Error('拖拽元素缺失 ' + src + ' / ' + dst)
        const dt = new DataTransfer()
        s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
        d.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
        d.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
        s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
        return true
      }, srcSel, dstSel)

      await app.click('#newGroupBtn'); await app.modalFill({ name: '拖拽组A' }); await app.modalOk()
      await app.click('#newGroupBtn'); await app.modalFill({ name: '拖拽组B' }); await app.modalOk()
      const a = await group(app, '拖拽组A')
      const b = await group(app, '拖拽组B')
      assert.ok(a && b, '两个顶层组应创建成功')
      const t = await createTaskUI(app, { name: '拖拽任务', type: 'work', path: path.join(sb.work, 'dragtask') })
      assert.equal(t.group_id, null, '新任务默认未分组')

      // 任务拖入组B
      await drag(`.row[data-task="${t.id}"]`, `.row[data-group="${b.id}"]`)
      await app.waitFor(`(async () => {
        const ts = await window.zzwork.invoke('store', 'tasks.list')
        const x = ts.find((v) => v.id === ${JSON.stringify(t.id)})
        return !!(x && x.group_id === ${JSON.stringify(b.id)})
      })()`, 8000, '任务应移入拖拽组B')

      // 组B 拖到组A 之下（成为子组）
      await drag(`.row[data-group="${b.id}"]`, `.row[data-group="${a.id}"]`)
      await app.waitFor(`(async () => {
        const gs = await window.zzwork.invoke('store', 'groups.list')
        const x = gs.find((v) => v.id === ${JSON.stringify(b.id)})
        return !!(x && x.parent_id === ${JSON.stringify(a.id)})
      })()`, 8000, '组B 应成为组A 的子组')

      // 防环：把组A 拖进组B（此时 B 已是 A 的后代）应被拒绝，A 仍为顶层
      await drag(`.row[data-group="${a.id}"]`, `.row[data-group="${b.id}"]`)
      const aAfter = await group(app, '拖拽组A')
      assert.equal(aAfter.parent_id || '', '', '不能把组拖进自己的后代')
    }
  }
]
