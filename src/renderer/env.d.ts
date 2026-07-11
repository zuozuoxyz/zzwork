/// <reference types="vite/client" />

import type { IpcResult } from './types/errors'
import type { Project, CreateProjectDTO, UpdateProjectDTO } from './types/project'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO } from './types/progress'
import type { ModelConfig, CreateModelDTO, UpdateModelDTO } from './types/model'

interface FileParams {
  projectId: string
  filePath: string
  content?: string
}

interface WindowApi {
  project: {
    list: () => Promise<IpcResult<Project[]>>
    get: (id: string) => Promise<IpcResult<Project | null>>
    create: (dto: CreateProjectDTO) => Promise<IpcResult<Project>>
    update: (id: string, data: UpdateProjectDTO) => Promise<IpcResult<Project>>
    delete: (id: string) => Promise<IpcResult<void>>
    archive: (id: string) => Promise<IpcResult<Project>>
  }
  progress: {
    list: (projectId: string) => Promise<IpcResult<ProgressItem[]>>
    create: (dto: CreateProgressDTO) => Promise<IpcResult<ProgressItem>>
    update: (id: string, data: UpdateProgressDTO) => Promise<IpcResult<ProgressItem>>
    delete: (id: string) => Promise<IpcResult<void>>
  }
  file: {
    read: (params: { projectId: string; filePath: string }) => Promise<IpcResult<string>>
    write: (params: { projectId: string; filePath: string; content: string }) => Promise<IpcResult<void>>
    list: (projectId: string) => Promise<IpcResult<string[]>>
    delete: (params: { projectId: string; filePath: string }) => Promise<IpcResult<void>>
    create: (params: { projectId: string; filePath: string; content?: string }) => Promise<IpcResult<void>>
  }
  settings: {
    get: (key: string) => Promise<IpcResult<string | null>>
    set: (key: string, value: string) => Promise<IpcResult<void>>
    getAll: () => Promise<IpcResult<Record<string, string>>>
  }
  agent: {
    run: (params: import('./types/conversation').AgentRunParams) => Promise<IpcResult<void>>
    onStart: (cb: (data: import('./types/conversation').AgentStartData) => void) => void
    onChunk: (cb: (data: import('./types/conversation').AgentChunkData) => void) => void
    onToolCall: (cb: (data: import('./types/conversation').AgentToolCallData) => void) => void
    onToolResult: (cb: (data: import('./types/conversation').AgentToolResultData) => void) => void
    onDone: (cb: (data: import('./types/conversation').AgentDoneData) => void) => void
    onError: (cb: (data: import('./types/conversation').AgentErrorData) => void) => void
    removeAll: () => void
  }
  conversation: {
    list: (projectId: string) => Promise<IpcResult<import('./types/conversation').Conversation[]>>
    get: (id: string) => Promise<IpcResult<import('./types/conversation').Conversation | null>>
    create: (projectId: string) => Promise<IpcResult<import('./types/conversation').Conversation>>
    append: (convId: string, message: import('./types/conversation').ConversationMessage) => Promise<IpcResult<void>>
    delete: (id: string) => Promise<IpcResult<void>>
  }
  model: {
    list: () => Promise<IpcResult<ModelConfig[]>>
    get: (id: string) => Promise<IpcResult<ModelConfig | null>>
    create: (dto: CreateModelDTO) => Promise<IpcResult<ModelConfig>>
    update: (id: string, data: UpdateModelDTO) => Promise<IpcResult<ModelConfig>>
    delete: (id: string) => Promise<IpcResult<void>>
    setDefault: (id: string) => Promise<IpcResult<ModelConfig>>
  }
}

declare global {
  interface Window {
    api: WindowApi
  }
}
