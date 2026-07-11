import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { settingsRepo } from '../db/repositories/settings.repo'
import { IPC_CHANNELS } from '../../renderer/types/ipc'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, wrapHandler(async (_event, key: string) => {
    return settingsRepo.get(key)
  }))

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, wrapHandler(async (_event, params: { key: string; value: string }) => {
    return settingsRepo.set(params.key, params.value)
  }))

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, wrapHandler(async () => {
    return settingsRepo.getAll()
  }))
}
