export interface Conversation {
  id: string
  projectId: string
  messages: ConversationMessage[]
  summary: string | null
  createdAt: string
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: ToolCallRecord[]
  timestamp: string
}

export interface ToolCallRecord {
  tool: string
  input: Record<string, unknown>
  result: string
}

export interface ChatContext {
  selectedText?: string
  filePath?: string
}

export interface AgentEvent {
  type: 'start' | 'chunk' | 'tool_call' | 'tool_result' | 'done' | 'error'
  data:
    | AgentStartData
    | AgentChunkData
    | AgentToolCallData
    | AgentToolResultData
    | AgentDoneData
    | AgentErrorData
}

export interface AgentStartData {
  conversationId: string
}
export interface AgentChunkData {
  conversationId: string
  content: string
}
export interface AgentToolCallData {
  conversationId: string
  tool: string
  input: Record<string, unknown>
}
export interface AgentToolResultData {
  conversationId: string
  tool: string
  summary: string
}
export interface AgentDoneData {
  conversationId: string
  content: string
}
export interface AgentErrorData {
  conversationId: string
  code: string
  message: string
}

export interface AgentRunParams {
  projectId: string
  conversationId: string
  modelId: string
  message: string
  capability?: 'default' | 'analyze' | 'report' | 'review' | 'decompose'
  context?: ChatContext
}
