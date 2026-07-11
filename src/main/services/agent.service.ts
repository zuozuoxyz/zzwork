import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages'
import { getApiKey } from './secrets.service'
import { AGENT_TOOLS, type ToolDefinition } from './agent-tools'
import { buildSystemPrompt } from './prompts'
import { AppError } from '../../renderer/types/errors'

export interface AgentRunParams {
  projectId: string
  conversationId: string
  projectName: string
  message: string
  capability?: string
  context?: {
    selectedText?: string
    filePath?: string
  }
  history?: { role: 'user' | 'assistant'; content: string }[]
}

export interface AgentEventCallback {
  (event: AgentEvent): void
}

export type AgentEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'chunk'; conversationId: string; content: string }
  | { type: 'tool_call'; conversationId: string; tool: string; input: Record<string, unknown> }
  | { type: 'tool_result'; conversationId: string; tool: string; summary: string }
  | { type: 'done'; conversationId: string; content: string }
  | { type: 'error'; conversationId: string; code: string; message: string }

function summarizeToolResult(tool: string, result: string): string {
  const preview = result.length > 200 ? result.substring(0, 200) + '...' : result
  return preview
}

export async function runAgent(params: AgentRunParams, onEvent: AgentEventCallback): Promise<void> {
  const { projectId, conversationId, projectName, message, capability, context, history } = params

  // 1. Read API Key
  const apiKey = await getApiKey()
  if (!apiKey) {
    onEvent({ type: 'error', conversationId, code: 'AI_API_KEY_MISSING', message: '请先在设置中配置 Anthropic API Key' })
    return
  }

  const anthropic = new Anthropic({ apiKey })

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

  // 5. Extract tool definitions for API
  const toolDefinitions: Tool[] = AGENT_TOOLS.map((t) => t.definition)
  const toolMap = new Map<string, ToolDefinition>(AGENT_TOOLS.map((t) => [t.definition.name, t]))

  onEvent({ type: 'start', conversationId })

  try {
    // 6. Agent loop: send messages, handle tool_use
    let currentMessages = messages
    let loopGuard = 0
    const MAX_LOOPS = 10

    while (loopGuard < MAX_LOOPS) {
      loopGuard++

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: currentMessages,
        tools: toolDefinitions,
      })

      // Check for tool_use
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')
      const textBlocks = response.content.filter((b) => b.type === 'text')

      if (toolUseBlocks.length === 0) {
        // Final text response — send as chunks
        const finalText = textBlocks.map((b) => (b as any).text).join('')
        // Simulate streaming by sending whole text (SDK streaming at final step possible in future)
        onEvent({ type: 'chunk', conversationId, content: finalText })
        onEvent({ type: 'done', conversationId, content: finalText })
        return
      }

      // Execute tools
      const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = []

      for (const block of toolUseBlocks) {
        const toolUse = block as any
        const toolName = toolUse.name as string
        const toolInput = toolUse.input as Record<string, unknown>

        onEvent({ type: 'tool_call', conversationId, tool: toolName, input: toolInput })

        const toolDef = toolMap.get(toolName)
        let result: string
        try {
          result = await toolDef!.execute(toolInput, projectId)
        } catch (err: any) {
          result = `工具执行错误: ${err.message}`
        }

        onEvent({ type: 'tool_result', conversationId, tool: toolName, summary: summarizeToolResult(toolName, result) })

        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: result,
        })
      }

      // Append assistant message + tool results to conversation
      currentMessages = [
        ...currentMessages,
        { role: 'assistant' as const, content: response.content as any },
        { role: 'user' as const, content: toolResults as any },
      ]
    }

    onEvent({ type: 'error', conversationId, code: 'AI_API_ERROR', message: 'Agent 循环次数超限' })
  } catch (err: any) {
    if (err.status === 429) {
      onEvent({ type: 'error', conversationId, code: 'AI_RATE_LIMITED', message: '请求过于频繁，请稍后重试' })
    } else {
      onEvent({ type: 'error', conversationId, code: 'AI_API_ERROR', message: err.message || 'AI 请求失败' })
    }
  }
}
