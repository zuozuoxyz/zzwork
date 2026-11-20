// 测试用 codex：模拟 codex exec --json 的事件流（含思考、命令噪音与最终答复）
// 兼容两种组装：cmd 含 {prompt}（prompt 是唯一参数）与 agentTmpl（前置 exec/resume 等旗标）
const prompt = process.argv.slice(-1)[0] || ''
const resumed = process.argv.includes('resume')
const hasImg = process.argv.includes('-i')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
out({ type: 'thread.started', thread_id: 'fake-codex-thread' })
out({ type: 'turn.started' })
out({
  type: 'item.completed',
  item: { id: 'item_cmd', type: 'command_execution', command: 'ls', aggregated_output: 'CODEX-NOISE 命令输出', exit_code: 0, status: 'completed' }
})
out({ type: 'item.completed', item: { id: 'item_think', type: 'reasoning', text: 'CODEX-THINK 先看问题再回答' } })
out({ type: 'item.completed', item: { id: 'item_msg', type: 'agent_message', text: (resumed ? 'CODEX-RESUMED ' : 'CODEX-FAKE ') + (hasImg ? '[IMG] ' : '') + '收到：' + prompt } })
out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
