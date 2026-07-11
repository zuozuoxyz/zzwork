import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages'
import { getModelKey } from '../secrets.service'
import type { ModelConfig } from '../../../renderer/types/model'
import { AppError } from '../../../renderer/types/errors'
import type { AIBackend, AgentEventCallback, ChatResponse, ToolUseBlock } from './backend.interface'

export class AnthropicBackend implements AIBackend {
  constructor(private model: ModelConfig) {}

  async chat(
    messages: MessageParam[],
    tools: Tool[],
    systemPrompt: string,
    onEvent: AgentEventCallback
  ): Promise<ChatResponse> {
    const apiKey = await getModelKey(this.model.id)
    if (!apiKey) throw new AppError('AI_API_KEY_MISSING', `模型 "${this.model.name}" 未配置 API Key`)

    const anthropic = new Anthropic({ apiKey, baseURL: this.model.baseUrl })

    const response = await anthropic.messages.create({
      model: this.model.modelId,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools,
    })

    const toolUses: ToolUseBlock[] = []
    const texts: string[] = []

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const tu = block as any
        toolUses.push({ id: tu.id, name: tu.name, input: tu.input as Record<string, unknown> })
        onEvent({
          type: 'tool_call',
          conversationId: '',
          tool: tu.name,
          input: tu.input,
        })
      } else if (block.type === 'text') {
        texts.push((block as any).text)
      }
    }

    return { text: texts.join(''), toolUses }
  }
}
