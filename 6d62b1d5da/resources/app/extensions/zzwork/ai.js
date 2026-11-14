// zzwork AI 后端：纯 fetch 实现，支持 openai_compatible 与 anthropic 两种类型
async function chatStream(model, apiKey, messages, systemPrompt, onDelta) {
  if (model.type === 'anthropic') {
    return anthropicStream(model, apiKey, messages, systemPrompt, onDelta)
  }
  return openaiStream(model, apiKey, messages, systemPrompt, onDelta)
}

async function openaiStream(model, apiKey, messages, systemPrompt, onDelta) {
  const res = await fetch(model.base_url.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model.model_id,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  })
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`)
  return readSSE(res, (json) => {
    const delta = json.choices?.[0]?.delta?.content
    if (delta) onDelta(delta)
  })
}

async function anthropicStream(model, apiKey, messages, systemPrompt, onDelta) {
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
      system: systemPrompt,
      messages: messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
    }),
  })
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`)
  return readSSE(res, (json) => {
    if (json.type === 'content_block_delta' && json.delta?.text) onDelta(json.delta.text)
  })
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
