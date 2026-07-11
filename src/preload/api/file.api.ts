import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { IpcResult } from '../../renderer/types/errors'

interface FileReadParams { projectId: string; filePath: string }
interface FileWriteParams { projectId: string; filePath: string; content: string }
interface FileCreateParams { projectId: string; filePath: string; content?: string }
interface FileDeleteParams { projectId: string; filePath: string }

export const fileApi = {
  read: (params: FileReadParams): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, params),

  write: (params: FileWriteParams): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE, params),

  list: (projectId: string): Promise<IpcResult<string[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST, projectId),

  delete: (params: FileDeleteParams): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, params),

  create: (params: FileCreateParams): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_CREATE, params),
}
