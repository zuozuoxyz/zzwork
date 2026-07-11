import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages'
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages'

export interface AgentEvent {
  type: 'start' | 'chunk' | 'tool_call' | 'tool_result' | 'done' | 'error'
  conversationId: string
  content?: string
  tool?: string
  input?: Record<string, unknown>
  summary?: string
  code?: string
  message?: string
}

export type AgentEventCallback = (event: AgentEvent) => void

export interface ToolUseBlock {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ChatResponse {
  text: string
  toolUses: ToolUseBlock[]
}

export interface AIBackend {
  chat(
    messages: MessageParam[],
    tools: Tool[],
    systemPrompt: string,
    onEvent: AgentEventCallback
  ): Promise<ChatResponse>
}
