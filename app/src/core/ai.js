// zzwork AI 后端：纯 fetch 实现，支持 openai_compatible 与 anthropic 两种类型
// onDelta: 正文增量；onThinking: 思考过程增量（推理模型可能没有）
async function chatStream(model, apiKey, messages, systemPrompt, onDelta, signal, onThinking) {
  if (model.type === 'anthropic') {
    return anthropicStream(model, apiKey, messages, systemPrompt, onDelta, signal, onThinking)
  }
  return openaiStream(model, apiKey, messages, systemPrompt, onDelta, signal, onThinking)
}

async function openaiStream(model, apiKey, messages, systemPrompt, onDelta, signal, onThinking) {
  const url = model.base_url.replace(/\/$/, '') + '/chat/completions'
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
  const full = [{ role: 'system', content: systemPrompt }, ...messages]
  const body = (withUsage) => JSON.stringify({
    model: model.model_id,
    stream: true,
    ...(withUsage ? { stream_options: { include_usage: true } } : {}),
    messages: full,
  })
  // 先请求 usage 统计；少数兼容网关不认 stream_options（400/422），退回不带 usage 的请求
  let res = await fetch(url, { method: 'POST', headers, body: body(true), signal })
  if (!res.ok && (res.status === 400 || res.status === 422)) {
    res = await fetch(url, { method: 'POST', headers, body: body(false), signal })
  }
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`)
  let usage = null
  await readSSE(res, (json) => {
    const d = json.choices?.[0]?.delta || {}
    const think = d.reasoning_content || d.reasoning
    if (think && onThinking) onThinking(think)
    if (d.content) onDelta(d.content)
    if (json.usage) usage = json.usage
  })
  if (!usage) return null
  return {
    input: Number(usage.prompt_tokens) || 0,
    output: Number(usage.completion_tokens) || 0,
    cached: Number((usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || usage.cached_tokens) || 0
  }
}

async function anthropicStream(model, apiKey, messages, systemPrompt, onDelta, signal, onThinking) {
  // 缓存命中：system 作为独立块并打 cache_control（断点1），
  // 再在「新用户消息」之前的最后一条历史消息上打断点（断点2），
  // 使「system + 整段历史」作为稳定前缀被缓存，每轮只增量计费。
  const sysBlocks = systemPrompt
    ? [{ type: 'text', text: String(systemPrompt), cache_control: { type: 'ephemeral' } }]
    : undefined
  const msgs = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ ...m }))
  if (msgs.length >= 2) {
    const last = msgs[msgs.length - 2]
    if (Array.isArray(last.content)) {
      if (last.content.length) {
        const k = last.content.length - 1
        last.content = last.content.map((b, j) => (j === k ? { ...b, cache_control: { type: 'ephemeral' } } : b))
      }
    } else if (last.content) {
      last.content = [{ type: 'text', text: String(last.content), cache_control: { type: 'ephemeral' } }]
    }
  }
  const res = await fetch(model.base_url.replace(/\/$/, '') + '/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model.model_id,
      stream: true,
      max_tokens: 4096,
      system: sysBlocks,
      messages: msgs,
    }),
    signal
  })
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`)
  const usage = { input: 0, output: 0, cached: 0 }
  let got = false
  await readSSE(res, (json) => {
    if (json.type === 'message_start' && json.message && json.message.usage) {
      const u = json.message.usage
      usage.input = Number(u.input_tokens) || 0
      usage.cached = Number(u.cache_read_input_tokens) || 0
      got = true
    } else if (json.type === 'message_delta' && json.usage) {
      const u = json.usage
      if (u.output_tokens != null) usage.output = Number(u.output_tokens) || 0
      if (u.input_tokens != null) usage.input = Number(u.input_tokens) || 0
      if (u.cache_read_input_tokens != null) usage.cached = Number(u.cache_read_input_tokens) || 0
      got = true
    }
    if (json.type !== 'content_block_delta') return
    const d = json.delta || {}
    if (d.type === 'thinking_delta' && d.thinking && onThinking) onThinking(d.thinking)
    else if (d.type === 'text_delta' && d.text) onDelta(d.text)
    else if (d.text) onDelta(d.text)
  })
  return got ? usage : null
}

async function readSSE(res, onJson) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try { onJson(JSON.parse(payload)) } catch { /* 忽略非 JSON 行 */ }
    }
  }
}

module.exports = { chatStream }
