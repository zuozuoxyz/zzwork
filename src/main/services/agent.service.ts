import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages'
import { modelRepo } from '../db/repositories/model.repo'
import { AGENT_TOOLS } from './agent-tools'
import { buildSystemPrompt } from './prompts'
import { AnthropicBackend } from './backends/anthropic.backend'
import { OpenAICompatibleBackend } from './backends/openai.backend'
import type { AIBackend, AgentEvent, AgentEventCallback } from './backends/backend.interface'
import { AppError } from '../../renderer/types/errors'

export type { AgentEvent, AgentEventCallback }

export interface AgentRunParams {
  projectId: string
  conversationId: string
  modelId: string
  projectName: string
  message: string
  capability?: string
  context?: { selectedText?: string; filePath?: string }
  history?: { role: 'user' | 'assistant'; content: string }[]
}

function getBackend(model: import('../../renderer/types/model').ModelConfig): AIBackend {
  if (model.type === 'anthropic') return new AnthropicBackend(model)
  return new OpenAICompatibleBackend(model)
}

function summarizeToolResult(result: string): string {
  return result.length > 200 ? result.substring(0, 200) + '...' : result
}

export async function runAgent(params: AgentRunParams, onEvent: AgentEventCallback): Promise<void> {
  const { projectId, conversationId, modelId, projectName, message, capability, context, history } = params

  // 1. Load model config
  const model = modelRepo.getById(modelId)
  if (!model) {
    onEvent({ type: 'error', conversationId, code: 'PROJECT_NOT_FOUND', message: '模型不存在' })
    return
  }

  const backend = getBackend(model)

  // 2. Build system prompt
  const systemPrompt = buildSystemPrompt(capability, projectName)

  // 3. Build user message with optional context
  let userContent = message
  if (context?.selectedText) {
    userContent = `关于以下选中的内容:\n\`\`\`\n${context.selectedText}\n\`\`\`\n\n${message}`
  }
  if (context?.filePath) {
    userContent = `当前文件: ${context.filePath}\n\n${userContent}`
  }

  // 4. Build message history
  const messages: MessageParam[] = [
    ...(history ?? []).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: userContent },
  ]

  // 5. Extract tool definitions
  const toolDefinitions: Tool[] = AGENT_TOOLS.map((t) => t.definition)
  const toolMap = new Map(AGENT_TOOLS.map((t) => [t.definition.name, t]))

  onEvent({ type: 'start', conversationId })

  try {
    // 6. Agent loop
    let currentMessages = messages
    let loopGuard = 0
    const MAX_LOOPS = 10

    while (loopGuard < MAX_LOOPS) {
      loopGuard++

      const { text, toolUses } = await backend.chat(currentMessages, toolDefinitions, systemPrompt, onEvent)

      if (toolUses.length === 0) {
        // Final response
        onEvent({ type: 'chunk', conversationId, content: text })
        onEvent({ type: 'done', conversationId, content: text })
        return
      }

      // Execute tools
      const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = []
      for (const tu of toolUses) {
        const toolDef = toolMap.get(tu.name)
        let result: string
        try {
          result = await toolDef!.execute(tu.input, projectId)
        } catch (err: any) {
          result = `工具执行错误: ${err.message}`
        }
        onEvent({ type: 'tool_result', conversationId, tool: tu.name, summary: summarizeToolResult(result) })
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result })
      }

      // Build next messages: assistant response with tool_use blocks + tool results
      const assistantContent = toolUses.map((tu) => ({
        type: 'tool_use' as const,
        id: tu.id,
        name: tu.name,
        input: tu.input,
      }))

      currentMessages = [
        ...currentMessages,
        { role: 'assistant' as const, content: assistantContent as any },
        { role: 'user' as const, content: toolResults as any },
      ]
    }

    if (loopGuard >= MAX_LOOPS) {
      onEvent({ type: 'error', conversationId, code: 'AI_API_ERROR', message: 'Agent 循环次数超限' })
    }
  } catch (err: any) {
    if (err instanceof AppError) {
      onEvent({ type: 'error', conversationId, code: err.code, message: err.message })
    } else if (err.status === 429) {
      onEvent({ type: 'error', conversationId, code: 'AI_RATE_LIMITED', message: '请求过于频繁，请稍后重试' })
    } else {
      onEvent({ type: 'error', conversationId, code: 'AI_API_ERROR', message: err.message || 'AI 请求失败' })
    }
  }
}
