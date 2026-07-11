import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { projectRepo } from '../db/repositories/project.repo'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { CreateProjectDTO, UpdateProjectDTO } from '../../renderer/types/project'

export function registerProjectHandlers(): void {
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
}
