import assert from 'node:assert/strict'
import { selectTask, setView, ensureTask } from './_helpers.mjs'

const infoText = async (app) => app.text('#infoBody')

export default [
  {
    name: '任务信息页渲染',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await selectTask(app, '主任务改名')
      const txt = await infoText(app)
      assert.ok(txt.includes('主任务改名'))
      assert.ok(txt.includes('所属组'))
      assert.ok(txt.includes('执行体'))
      assert.ok(txt.includes('模型'))
      assert.ok(await app.exists('#groupSel'))
      assert.ok(await app.exists('#agentSel'))
      assert.ok(await app.exists('#modelSel'))
      assert.ok(await app.exists('#filesTree .treebar'))
      const pth = await app.text('#infoBody .pth')
      assert.ok(pth && pth.length > 3)
    }
  },
  {
    name: 'TODO 添加 / 完成 / 删除',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await selectTask(app, '主任务改名')
      const addTodo = (text) => app.call((v) => {
        const el = document.querySelector('#todoInput')
        if (!el) throw new Error('todoInput 不存在')
        el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        return el.value
      }, text)
      await addTodo('待办一')
      await app.waitFor(`document.querySelectorAll('#todoList .todo').length === 1`)
      await addTodo('待办二')
      await app.waitFor(`document.querySelectorAll('#todoList .todo').length === 2`)
      const counter = await app.call(() => [...document.querySelectorAll('#infoBody .sec')].find((s) => s.textContent.includes('TODO')).textContent)
      assert.ok(counter.includes('0 / 2'), counter)
      await app.click('#todoList .todo .bx')
      await app.waitFor(`document.querySelectorAll('#todoList .todo.done').length === 1`)
      const t = (await app.store('tasks.list')).find((x) => x.name === '主任务改名')
      let todos = await app.store('todos.list', { taskId: t.id })
      assert.equal(todos.filter((x) => x.status === 'done').length, 1)
      await app.click('#todoList .todo:nth-child(2) .rm')
      await app.waitFor(`document.querySelectorAll('#todoList .todo').length === 1`)
      todos = await app.store('todos.list', { taskId: t.id })
      assert.equal(todos.length, 1)
    }
  },
  {
    name: '切换所属组',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await setView(app, 'projects')
      await app.contextMenu('#projectsBody', '新建组')
      await app.modalFill({ value: '信息组' })
      await app.modalOk()
      const g = (await app.store('groups.list')).find((x) => x.name === '信息组')
      await selectTask(app, '主任务改名')
      await app.selectValue('#groupSel', g.id)
      await app.waitFor(`(async () => {
        const ts = await window.zzwork.invoke('store', 'tasks.list')
        const x = ts.find((v) => v.name === '主任务改名')
        return !!(x && x.group_id === ${JSON.stringify(g.id)})
      })()`, 8000, '所属组已保存')
      const t = (await app.store('tasks.list')).find((x) => x.name === '主任务改名')
      assert.equal(t.group_id, g.id)
      await app.waitFor(`document.querySelector('#projectsBody').textContent.includes('信息组')`)
    }
  },
  {
    name: '切换执行体',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await selectTask(app, '主任务改名')
      const waitAgent = (id) => app.waitFor(`(async () => {
        const ts = await window.zzwork.invoke('store', 'tasks.list')
        const x = ts.find((v) => v.name === '主任务改名')
        return !!(x && x.agent_id === ${JSON.stringify(id)})
      })()`, 8000, '执行体已保存 ' + id)
      await app.waitFor(`(() => {
        const hasClaude = [...document.querySelectorAll('#agentSel option')].some((o) => o.value === 'claude-code')
        const recognized = [...document.querySelectorAll('#infoBody .cell .v span')].some((s) => s.textContent.includes('按环境识别'))
        return hasClaude && recognized
      })()`, 30000, '环境识别执行体完成')
      const values = await app.call(() => [...document.querySelectorAll('#agentSel option')].map((o) => o.value))
      assert.ok(values.includes('codex'), 'PATH 之外安装的 codex 应被识别')
      assert.ok(values.includes('zcode'), 'GUI 应用随附的 zcode 应被识别')
      assert.ok(!values.includes('crush'), '未安装的 crush 不应出现在执行体列表')
      await app.selectValue('#agentSel', 'claude-code')
      await waitAgent('claude-code')
      let t = (await app.store('tasks.list')).find((x) => x.name === '主任务改名')
      assert.equal(t.agent_id, 'claude-code')
      await selectTask(app, '主任务改名')
      await app.selectValue('#agentSel', 'builtin')
      await waitAgent('builtin')
      t = (await app.store('tasks.list')).find((x) => x.name === '主任务改名')
      assert.equal(t.agent_id, 'builtin')
    }
  },
  {
    name: '按任务裁剪 Skills / MCP',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await selectTask(app, '主任务改名')
      const t = (await app.store('tasks.list')).find((x) => x.name === '主任务改名')
      const skill = (await app.store('skills.list')).find((s) => s.name === 'demo-skill')
      assert.ok(skill)
      await app.waitFor(() => !!document.querySelector('#skillToggles input[data-skill]'))
      await app.click(`#skillToggles input[data-skill="${skill.id}"]`)
      await app.waitFor(`true`)
      let ex = await app.store('taskSkills.excluded', { taskId: t.id })
      assert.deepEqual(ex, [skill.id])
      const mcpTotal = (await app.store('mcp.list')).length
      await app.waitFor(`(() => {
        const c = [...document.querySelectorAll('#infoBody .cell')].find((x) => x.textContent.includes('启用 Skills'))
        return c && c.textContent.includes(${JSON.stringify('0 / ' + mcpTotal)})
      })()`, 8000, '启用计数更新')
      const cell = await app.call(() => [...document.querySelectorAll('#infoBody .cell')].find((c) => c.textContent.includes('启用 Skills')).textContent)
      assert.ok(cell.includes(`0 / ${mcpTotal}`), cell)
      await app.waitFor(`!!document.querySelector('#skillToggles input[data-skill=${JSON.stringify(skill.id)}]')`)
      await app.click(`#skillToggles input[data-skill="${skill.id}"]`)
      await app.waitFor(`true`)
      ex = await app.store('taskSkills.excluded', { taskId: t.id })
      assert.deepEqual(ex, [])

      const mcp = (await app.store('mcp.list')).find((m) => m.name === '回归MCP')
      assert.ok(mcp)
      await app.waitFor(() => !!document.querySelector('#mcpToggles input[data-mcp]'))
      await app.click(`#mcpToggles input[data-mcp="${mcp.id}"]`)
      await app.waitFor(`true`)
      let exM = await app.store('taskMcp.excluded', { taskId: t.id })
      assert.deepEqual(exM, [mcp.id])
      await app.waitFor(`!!document.querySelector('#mcpToggles input[data-mcp=${JSON.stringify(mcp.id)}]')`)
      await app.click(`#mcpToggles input[data-mcp="${mcp.id}"]`)
      await app.waitFor(`true`)
      exM = await app.store('taskMcp.excluded', { taskId: t.id })
      assert.deepEqual(exM, [])
    }
  },
  {
    name: '状态栏任务与 TODO 进度',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await selectTask(app, '主任务改名')
      const st = await app.text('#stTask')
      assert.ok(st.includes('主任务改名'), st)
      assert.ok(/\d+\/\d+/.test(st), st)
      const right = await app.text('#stRight')
      assert.ok(right.includes('环境'), right)
    }
  }
]
