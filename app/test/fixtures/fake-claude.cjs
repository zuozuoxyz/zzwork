// 测试用假 claude CLI：实现双向 stream-json + permission control 协议
if (process.argv.includes('--version')) { console.log('fake-claude 1.2.3'); process.exit(0) }

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

function textOf(frame) {
  const c = frame && frame.message && frame.message.content
  if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text).join('')
  return String((frame && frame.message && frame.message.content) || '')
}

function imgOf(frame) {
  const c = frame && frame.message && frame.message.content
  if (!Array.isArray(c)) return 0
  return c.filter((x) => x.type === 'image' && x.source && x.source.data).length
}

function emitReply(input) {
  const text = 'CLAUDE-FAKE 收到：' + input
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'CLAUDE-FAKE 收到：' } } })
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: input } } })
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  out({ type: 'result', result: text, session_id: 'fake-claude-session',
    usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 } })
}

function emitMain(raw, imgs) {
  const rawText = String(raw || '').trim()
  const input = (imgs ? `[IMG:${imgs}] ` : '') + rawText
  out({ type: 'system', subtype: 'init', session_id: 'fake-claude-session' })
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'CLAUDE-THINK 先理解输入' } } })
  out({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'CLAUDE-THINK 先理解输入' }] } })
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_todo', name: 'TodoWrite', input: {} } } })
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool_todo', name: 'TodoWrite', input: { todos: [{ content: '理解需求', status: 'completed' }, { content: '执行命令', status: 'in_progress' }, { content: '整理答案', status: 'pending' }] } }] } })
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} } } })
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'echo hi' } }] } })
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1' }] } })
  if (rawText.indexOf('[[BG]]') >= 0) {
    // 模拟 run_in_background：后台常驻命令 + 立即返回的 shell id
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool_bg', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } })
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_bg', content: 'Command running in background with ID: bash_1' }] } })
  }
  if (rawText.indexOf('[[SLOW]]') >= 0) {
    // 延迟收尾：给测试留出「运行中切换任务」的窗口
    setTimeout(() => emitReply(input), 3500)
    return
  }
  if (rawText.indexOf('[[ASK]]') >= 0) {
    // 触发一次 AskUserQuestion：等宿主回应 control_response 后再出结果
    out({
      type: 'control_request', request_id: 'req-ask-1',
      request: {
        subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion',
        tool_use_id: 'tool_ask',
        input: {
          questions: [{
            question: '选哪个？', header: '选择', multiSelect: false,
            options: [{ label: 'A 选项', description: '第一个' }, { label: 'B 选项', description: '第二个' }]
          }]
        }
      }
    })
    return
  }
  emitReply(input)
}

let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let frame = null
    try { frame = JSON.parse(line) } catch {}
    if (frame && frame.type === 'user') emitMain(textOf(frame), imgOf(frame))
    else if (frame && frame.type === 'control_response') {
      const r = frame.response && frame.response.response
      const answers = (r && r.updatedInput && r.updatedInput.answers) || {}
      const first = Object.values(answers)[0] || ''
      emitReply('已回答：' + first)
    } else if (!frame) emitMain(line)
  }
})
process.stdin.on('end', () => process.exit(0))
setTimeout(() => process.exit(0), 12000)
