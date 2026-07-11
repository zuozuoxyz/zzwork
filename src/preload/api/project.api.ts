import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { Project, CreateProjectDTO, UpdateProjectDTO, ProjectGroup, CreateGroupDTO, UpdateGroupDTO } from '../../renderer/types/project'
import type { IpcResult } from '../../renderer/types/errors'

export const projectApi = {
  list: (): Promise<IpcResult<Project[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),

  get: (id: string): Promise<IpcResult<Project | null>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_GET, id),

  create: (dto: CreateProjectDTO): Promise<IpcResult<Project>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, dto),

  update: (id: string, data: UpdateProjectDTO): Promise<IpcResult<Project>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE, { id, data }),

  delete: (id: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, id),

  archive: (id: string): Promise<IpcResult<Project>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_ARCHIVE, id),

  // Groups
  listGroups: (): Promise<IpcResult<ProjectGroup[]>> =>
    ipcRenderer.invoke('group:list'),

  createGroup: (dto: CreateGroupDTO): Promise<IpcResult<ProjectGroup>> =>
    ipcRenderer.invoke('group:create', dto),

  updateGroup: (id: string, data: UpdateGroupDTO): Promise<IpcResult<ProjectGroup>> =>
    ipcRenderer.invoke('group:update', { id, data }),

  deleteGroup: (id: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke('group:delete', id),
}
