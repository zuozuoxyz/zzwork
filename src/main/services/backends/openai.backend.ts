import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import { getModelKey } from '../secrets.service'
import type { ModelConfig } from '../../../renderer/types/model'
import { AppError } from '../../../renderer/types/errors'
import type { AIBackend, AgentEventCallback } from './backend.interface'
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages'

export class OpenAICompatibleBackend implements AIBackend {
  constructor(private model: ModelConfig) {}

  async chat(
    messages: any[],
    tools: any[],
    systemPrompt: string,
    onEvent: AgentEventCallback
  ): Promise<string> {
    const apiKey = await getModelKey(this.model.id)
    if (!apiKey) throw new AppError('AI_API_KEY_MISSING', `模型 "${this.model.name}" 未配置 API Key`)

    const client = new OpenAI({
      apiKey,
      baseURL: this.model.baseUrl,
    })

    // Convert tools to OpenAI format
    const openaiTools: ChatCompletionTool[] = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))

    // Build OpenAI messages with system prompt
    const openaiMessages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string'
          ? m.content
          : (m.content as any[])?.map((b: any) =>
              b.type === 'text' ? { type: 'text' as const, text: b.text }
              : b.type === 'tool_use'
                ? { type: 'function_call' as const, id: b.id, function: { name: b.name, arguments: JSON.stringify(b.input) } }
                : { type: 'text' as const, text: JSON.stringify(b) }
            ),
      })),
    ]

    const response = await client.chat.completions.create({
      model: this.model.modelId,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: 4096,
    })

    const choice = response.choices[0]
    const msg = choice.message

    // Emit tool calls
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function') continue

        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(tc.function.arguments)
        } catch { /* ignore parse errors */ }

        onEvent({
          type: 'tool_call',
          conversationId: '',
          tool: tc.function.name,
          input,
        })
      }
    }

    return msg.content || ''
  }
}
