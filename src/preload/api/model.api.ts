import { ipcRenderer } from 'electron'
import type { IpcResult } from '../../renderer/types/errors'
import type { ModelConfig, CreateModelDTO, UpdateModelDTO } from '../../renderer/types/model'

export const modelApi = {
  list: (): Promise<IpcResult<ModelConfig[]>> =>
    ipcRenderer.invoke('model:list'),
  get: (id: string): Promise<IpcResult<ModelConfig | null>> =>
    ipcRenderer.invoke('model:get', id),
  create: (dto: CreateModelDTO): Promise<IpcResult<ModelConfig>> =>
    ipcRenderer.invoke('model:create', dto),
  update: (id: string, data: UpdateModelDTO): Promise<IpcResult<ModelConfig>> =>
    ipcRenderer.invoke('model:update', { id, data }),
  delete: (id: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke('model:delete', id),
  setDefault: (id: string): Promise<IpcResult<ModelConfig>> =>
    ipcRenderer.invoke('model:set-default', id),
}
