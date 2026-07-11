import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { settingsRepo } from '../db/repositories/settings.repo'
import { setApiKey, getApiKey } from '../services/secrets.service'
import { IPC_CHANNELS } from '../../renderer/types/ipc'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, wrapHandler(async (_event, key: string) => {
    if (key === 'has_api_key') {
      const k = await getApiKey()
      return k ? 'true' : 'false'
    }
    return settingsRepo.get(key)
  }))

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, wrapHandler(async (_event, params: { key: string; value: string }) => {
    if (params.key === 'anthropic_api_key') {
      if (params.value) {
        await setApiKey(params.value)
      }
      // Store a flag in SQLite so renderer can check existence without keychain access
      settingsRepo.set('has_api_key', params.value ? 'true' : 'false')
      return
    }
    return settingsRepo.set(params.key, params.value)
  }))

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, wrapHandler(async () => {
    return settingsRepo.getAll()
  }))
}
