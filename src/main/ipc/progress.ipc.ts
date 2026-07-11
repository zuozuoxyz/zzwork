import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { progressRepo } from '../db/repositories/progress.repo'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { CreateProgressDTO, UpdateProgressDTO } from '../../renderer/types/progress'

export function registerProgressHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROGRESS_LIST, wrapHandler(async (_event, projectId: string) => {
    return progressRepo.listByProject(projectId)
  }))

  ipcMain.handle(IPC_CHANNELS.PROGRESS_CREATE, wrapHandler(async (_event, dto: CreateProgressDTO) => {
    return progressRepo.create(dto)
  }))

  ipcMain.handle(IPC_CHANNELS.PROGRESS_UPDATE, wrapHandler(async (_event, params: { id: string; data: UpdateProgressDTO }) => {
    return progressRepo.update(params.id, params.data)
  }))

  ipcMain.handle(IPC_CHANNELS.PROGRESS_DELETE, wrapHandler(async (_event, id: string) => {
    return progressRepo.delete(id)
  }))
}
