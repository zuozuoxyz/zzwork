/// <reference types="vite/client" />

import type { IpcResult } from './types/errors'
import type { Project, CreateProjectDTO, UpdateProjectDTO } from './types/project'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO } from './types/progress'

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
}

declare global {
  interface Window {
    api: WindowApi
  }
}
