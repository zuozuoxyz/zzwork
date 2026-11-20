import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setView, waitToast, ensureTask } from './_helpers.mjs'

const MCP_FIXTURE = fileURLToPath(new URL('../fixtures/mcp-server.cjs', import.meta.url))

const skills = async (app) => app.store('skills.list')
const skillByName = async (app, name) => (await skills(app)).find((s) => s.name === name)
const mcpList = async (app) => app.store('mcp.list')
const mcpByName = async (app, name) => (await mcpList(app)).find((m) => m.name === name)
const mcpConfig = (m) => (typeof m.config === 'string' ? JSON.parse(m.config || '{}') : (m.config || {}))

async function rescan(app) {
  await ensureTask(app, '主任务改名')
  await setView(app, 'envs')
  await app.click('#scanEnvBtn')
  await waitToast(app, '环境扫描完成', 20000)
}

export default [
  {
    name: '扫描 Skills（识别种子）',
    async run(app) {
      await rescan(app)
      await setView(app, 'skills')
      await app.waitFor(() => !!document.querySelector('.item[data-skill]'))
      const s = await skillByName(app, 'demo-skill')
      assert.ok(s, '应扫描到 demo-skill')
      assert.equal(s.description, '回归测试用 Skill')
      await app.waitFor(`document.querySelector('#skillsBody').textContent.includes('demo-skill')`)
    }
  },
  {
    name: 'Skill 详情与内容预览',
    async run(app) {
      await app.clickText('.item[data-skill]', 'demo-skill')
      await app.waitFor(`document.querySelector('#itemBody').textContent.includes('回归测试用 Skill')`)
      await app.waitFor(`document.querySelector('#skillPreview').textContent.includes('种子 Skill 的正文')`)
      const path = await app.text('#itemBody .pth')
      assert.ok(String(path).includes('demo-skill'))
    }
  },
  {
    name: '通过文件选择添加 Skill',
    async run(app, sb) {
      await app.click('#addSkillBtn')
      await app.waitFor(`document.querySelector('#skillsBody').textContent.includes('picked-skill')`, 10000)
      const s = await skillByName(app, 'picked-skill')
      assert.ok(s)
      assert.equal(s.path, sb.pickFile)
      assert.ok(fs.existsSync(s.path))
    }
  },
  {
    name: '删除 Skill 记录（保留文件）',
    async run(app, sb) {
      await app.clickText('.item[data-skill]', 'picked-skill')
      await app.waitFor(() => !!document.querySelector('#delSkill'))
      await app.click('#delSkill')
      await app.waitFor(`!document.querySelector('#skillsBody').textContent.includes('picked-skill')`)
      assert.equal(await skillByName(app, 'picked-skill'), undefined)
      assert.ok(fs.existsSync(sb.pickFile), 'Skill 文件本身不应被删除')
    }
  },
  {
    name: '扫描全局 MCP 配置',
    async run(app) {
      await setView(app, 'mcp')
      await app.waitFor(`document.querySelector('#mcpBody').textContent.includes('seeded')`, 10000)
      const m = await mcpByName(app, 'seeded')
      assert.ok(m)
      assert.equal(m.type, 'stdio')
      assert.equal(m.origin_path, '~/.zzwork/mcp.json')
    }
  },
  {
    name: '添加 MCP 服务并完成真实握手',
    async run(app) {
      await app.click('#addMcpBtn')
      await app.modalFill({ name: '回归MCP', type: 'stdio', command: `node "${MCP_FIXTURE}"` })
      await app.modalOk()
      await app.waitFor(`document.querySelector('#mcpBody').textContent.includes('回归MCP')`)
      await app.clickText('.item[data-mcp]', '回归MCP')
      await app.click('#testMcpBtn')
      await app.waitFor(`document.querySelector('#itemBody .hd').textContent.includes('已连接')`, 20000, 'MCP 握手成功')
      assert.ok((await app.text('#itemBody')).includes('echo'))
      assert.ok((await app.text('#itemBody')).includes('add'))
      const m = await mcpByName(app, '回归MCP')
      assert.equal(mcpConfig(m).lastTest.ok, true)
      assert.equal(mcpConfig(m).lastTest.tools, 2)
    }
  },
  {
    name: 'MCP 连接失败提示',
    async run(app) {
      await app.click('#addMcpBtn')
      await app.modalFill({ name: '坏MCP', type: 'stdio', command: 'zzwork-missing-command-xyz' })
      await app.modalOk()
      await app.clickText('.item[data-mcp]', '坏MCP')
      await app.click('#testMcpBtn')
      await app.waitFor(`document.querySelector('#itemBody .hd').textContent.includes('连接失败')`, 20000, 'MCP 握手失败')
      const m = await mcpByName(app, '坏MCP')
      assert.equal(mcpConfig(m).lastTest.ok, false)
      assert.ok(mcpConfig(m).lastTest.error)
    }
  },
  {
    name: '删除 MCP 服务',
    async run(app) {
      await app.clickText('.item[data-mcp]', '坏MCP')
      await app.waitFor(() => !!document.querySelector('#delMcp'))
      await app.click('#delMcp')
      await app.waitFor(`!document.querySelector('#mcpBody').textContent.includes('坏MCP')`)
      assert.equal(await mcpByName(app, '坏MCP'), undefined)
    }
  }
]
