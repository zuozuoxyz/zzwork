// MCP 握手测试：真实 initialize + tools/list，结果写回配置的 lastTest
const { testMcp } = require('../../core/mcpTest')
const { getStore } = require('./store')

async function test(server) {
  const cfg = (typeof server.config === 'object' && server.config)
    ? { ...server.config }
    : (() => { try { return JSON.parse(server.config || '{}') } catch { return {} } })()
  const res = await testMcp({ name: server.name, type: server.type, config: cfg })
  cfg.lastTest = {
    ok: !!res.ok,
    tools: res.tools || 0,
    toolNames: res.toolNames || [],
    error: res.error || '',
    at: new Date().toISOString()
  }
  getStore().upsertMcp({
    env_id: server.env_id,
    name: server.name,
    type: server.type,
    config: cfg,
    source: server.source,
    origin_path: server.origin_path
  })
  return { ok: !!res.ok, tools: res.tools || 0, toolNames: res.toolNames || [], error: res.error || '' }
}

module.exports = {
  test,
  register(ipcMain) {
    ipcMain.handle('zz:mcp:test', (_e, p) => test(p.server))
  }
}
