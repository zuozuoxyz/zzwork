import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages'
import { getModelKey } from '../secrets.service'
import type { ModelConfig } from '../../../renderer/types/model'
import { AppError } from '../../../renderer/types/errors'
import type { AIBackend, AgentEventCallback } from './backend.interface'

export class AnthropicBackend implements AIBackend {
  constructor(private model: ModelConfig) {}

  async chat(
    messages: MessageParam[],
    tools: Tool[],
    systemPrompt: string,
    onEvent: AgentEventCallback
  ): Promise<string> {
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

    // Process response: extract tool_use blocks and text
    const toolUses = response.content.filter((b) => b.type === 'tool_use')
    const texts = response.content.filter((b) => b.type === 'text')

    for (const tu of toolUses) {
      const block = tu as any
      onEvent({
        type: 'tool_call',
        conversationId: '',
        tool: block.name,
        input: block.input,
      })
    }

    const finalText = texts.map((t: any) => t.text).join('')
    return finalText
  }
}
