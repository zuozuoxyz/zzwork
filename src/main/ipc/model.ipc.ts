import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { modelRepo } from '../db/repositories/model.repo'
import { getModelKey, setModelKey, deleteModelKey } from '../services/secrets.service'
import type { CreateModelDTO, UpdateModelDTO } from '../../renderer/types/model'

export function registerModelHandlers(): void {
  ipcMain.handle('model:list', wrapHandler(async () => {
    return modelRepo.list()
  }))

  ipcMain.handle('model:get', wrapHandler(async (_event, id: string) => {
    return modelRepo.getById(id)
  }))

  ipcMain.handle('model:create', wrapHandler(async (_event, dto: CreateModelDTO) => {
    const apiKey = dto.apiKey
    const model = modelRepo.create(dto)
    if (apiKey) await setModelKey(model.id, apiKey)
    return model
  }))

  ipcMain.handle('model:update', wrapHandler(async (_event, params: { id: string; data: UpdateModelDTO }) => {
    const { id, data } = params
    if (data.apiKey !== undefined) {
      if (data.apiKey) await setModelKey(id, data.apiKey)
      else await deleteModelKey(id)
    }
    return modelRepo.update(id, data)
  }))

  ipcMain.handle('model:delete', wrapHandler(async (_event, id: string) => {
    await deleteModelKey(id)
    return modelRepo.delete(id)
  }))

  ipcMain.handle('model:set-default', wrapHandler(async (_event, id: string) => {
    return modelRepo.setDefault(id)
  }))
}
