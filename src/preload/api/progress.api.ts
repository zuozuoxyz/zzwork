import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO } from '../../renderer/types/progress'
import type { IpcResult } from '../../renderer/types/errors'

export const progressApi = {
  list: (projectId: string): Promise<IpcResult<ProgressItem[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROGRESS_LIST, projectId),

  create: (dto: CreateProgressDTO): Promise<IpcResult<ProgressItem>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROGRESS_CREATE, dto),

  update: (id: string, data: UpdateProgressDTO): Promise<IpcResult<ProgressItem>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROGRESS_UPDATE, { id, data }),

  delete: (id: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROGRESS_DELETE, id),
}
