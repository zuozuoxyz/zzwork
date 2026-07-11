import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { projectRepo } from '../db/repositories/project.repo'
import { groupRepo } from '../db/repositories/group.repo'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { CreateProjectDTO, UpdateProjectDTO, CreateGroupDTO, UpdateGroupDTO } from '../../renderer/types/project'

export function registerProjectHandlers(): void {
  // Projects
  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, wrapHandler(async () => {
    return projectRepo.list()
  }))

  ipcMain.handle(IPC_CHANNELS.PROJECT_GET, wrapHandler(async (_event, id: string) => {
    return projectRepo.getById(id)
  }))

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, wrapHandler(async (_event, dto: CreateProjectDTO) => {
    return projectRepo.create(dto)
  }))

  ipcMain.handle(IPC_CHANNELS.PROJECT_UPDATE, wrapHandler(async (_event, params: { id: string; data: UpdateProjectDTO }) => {
    return projectRepo.update(params.id, params.data)
  }))

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, wrapHandler(async (_event, id: string) => {
    return projectRepo.delete(id)
  }))

  ipcMain.handle(IPC_CHANNELS.PROJECT_ARCHIVE, wrapHandler(async (_event, id: string) => {
    return projectRepo.archive(id)
  }))

  // Groups
  ipcMain.handle('group:list', wrapHandler(async () => {
    return groupRepo.list()
  }))

  ipcMain.handle('group:create', wrapHandler(async (_event, dto: CreateGroupDTO) => {
    return groupRepo.create(dto)
  }))

  ipcMain.handle('group:update', wrapHandler(async (_event, params: { id: string; data: UpdateGroupDTO }) => {
    return groupRepo.update(params.id, params.data)
  }))

  ipcMain.handle('group:delete', wrapHandler(async (_event, id: string) => {
    return groupRepo.delete(id)
  }))
}
