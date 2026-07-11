import { create } from 'zustand'
import type {
  Conversation,
  ConversationMessage,
  AgentToolCallData,
  AgentToolResultData,
} from '../types/conversation'

export interface ThinkingStep {
  tool: string
  input: Record<string, unknown>
  status: 'running' | 'done'
  result?: string
}

interface ConversationStore {
  conversations: Conversation[]
  currentConvId: string | null
  messages: ConversationMessage[]
  isStreaming: boolean
  thinkingSteps: ThinkingStep[]
  streamingText: string

  loadByProject: (projectId: string) => Promise<void>
  createConversation: (projectId: string) => Promise<void>
  setCurrentConv: (id: string) => Promise<void>
  sendMessage: (projectId: string, content: string, capability?: string, selectedText?: string) => Promise<void>
  appendChunk: (content: string) => void
  addThinkingStep: (step: ThinkingStep) => void
  updateThinkingStep: (tool: string, result: string) => void
  finishStreaming: (finalContent: string) => void
  setError: (code: string, message: string) => void
  resetStreaming: () => void
}

export const useConversationStore = create<ConversationStore>((set, get) => ({
  conversations: [],
  currentConvId: null,
  messages: [],
  isStreaming: false,
  thinkingSteps: [],
  streamingText: '',

  loadByProject: async (projectId) => {
    const result = await window.api.conversation.list(projectId)
    if (result.ok) {
      set({ conversations: result.data })
    }
  },

  createConversation: async (projectId) => {
    const result = await window.api.conversation.create(projectId)
    if (result.ok) {
      const conv = result.data
      set((s) => ({
        conversations: [conv, ...s.conversations],
        currentConvId: conv.id,
        messages: [],
        thinkingSteps: [],
        streamingText: '',
      }))
    }
  },

  setCurrentConv: async (id) => {
    const result = await window.api.conversation.get(id)
    if (result.ok && result.data) {
      set({
        currentConvId: id,
        messages: result.data.messages ?? [],
        thinkingSteps: [],
        streamingText: '',
      })
    }
  },

  sendMessage: async (projectId, content, capability, selectedText) => {
    const state = get()
    let convId = state.currentConvId

    // Auto-create conversation if none active
    if (!convId) {
      const result = await window.api.conversation.create(projectId)
      if (!result.ok) return
      convId = result.data.id
      set({ currentConvId: convId, conversations: [result.data, ...state.conversations] })
    }

    // Add user message locally
    const userMsg: ConversationMessage = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }
    set((s) => ({ messages: [...s.messages, userMsg], isStreaming: true, streamingText: '', thinkingSteps: [] }))

    // Save user message to DB
    await window.api.conversation.append(convId!, userMsg)

    // Register event listeners
    window.api.agent.onChunk((data: AgentToolCallData | { conversationId: string; content: string }) => {
      if (data.conversationId === convId) {
        get().appendChunk((data as { content: string }).content)
      }
    })
    window.api.agent.onToolCall((data: AgentToolCallData) => {
      if (data.conversationId === convId) {
        get().addThinkingStep({ tool: data.tool, input: data.input, status: 'running' })
      }
    })
    window.api.agent.onToolResult((data: AgentToolResultData) => {
      if (data.conversationId === convId) {
        get().updateThinkingStep(data.tool, data.summary)
      }
    })
    window.api.agent.onDone((data: { conversationId: string; content: string }) => {
      if (data.conversationId === convId) {
        get().finishStreaming(data.content)
      }
    })
    window.api.agent.onError((data: { conversationId: string; code: string; message: string }) => {
      if (data.conversationId === convId) {
        get().setError(data.code, data.message)
      }
    })

    // Build history (last 20 messages)
    const history = get()
      .messages.slice(-20)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

    // Start agent
    await window.api.agent.run({
      projectId,
      conversationId: convId!,
      message: content,
      capability: capability as 'default' | 'analyze' | 'report' | 'review' | 'decompose' | undefined,
      context: selectedText ? { selectedText } : undefined,
      history,
    } as import('../types/conversation').AgentRunParams & { history: { role: 'user' | 'assistant'; content: string }[] })
  },

  appendChunk: (content) => {
    set((s) => ({ streamingText: s.streamingText + content }))
  },

  addThinkingStep: (step) => {
    set((s) => ({ thinkingSteps: [...s.thinkingSteps, step] }))
  },

  updateThinkingStep: (tool, result) => {
    set((s) => ({
      thinkingSteps: s.thinkingSteps.map((st) =>
        st.tool === tool && st.status === 'running' ? { ...st, status: 'done' as const, result } : st,
      ),
    }))
  },

  finishStreaming: async (finalContent) => {
    const state = get()
    const assistantMsg: ConversationMessage = {
      role: 'assistant',
      content: finalContent,
      toolCalls: state.thinkingSteps.map((s) => ({
        tool: s.tool,
        input: s.input,
        result: s.result ?? '',
      })),
      timestamp: new Date().toISOString(),
    }

    set((s) => ({
      messages: [...s.messages, assistantMsg],
      isStreaming: false,
      streamingText: '',
    }))

    // Save to DB
    if (state.currentConvId) {
      await window.api.conversation.append(state.currentConvId, assistantMsg)
    }
  },

  setError: (_code, _message) => {
    set({ isStreaming: false, streamingText: '' })
  },

  resetStreaming: () => {
    window.api.agent.removeAll()
    set({ isStreaming: false, streamingText: '', thinkingSteps: [] })
  },
}))
