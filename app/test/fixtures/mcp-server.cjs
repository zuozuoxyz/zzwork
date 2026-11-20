// 测试用 MCP stdio 服务：实现 initialize + tools/list 最小握手
process.stdin.setEncoding('utf8')
let buf = ''
const TOOLS = [
  { name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }
]
const reply = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id == null) continue // 通知不回复
    if (msg.method === 'initialize') {
      reply({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'zzwork-test-mcp', version: '1.0.0' }
        }
      })
    } else if (msg.method === 'tools/list') {
      reply({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    } else {
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
    }
  }
})
