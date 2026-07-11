import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { settingsRepo } from '../db/repositories/settings.repo'
import { getModelKey, setModelKey, deleteModelKey } from '../services/secrets.service'
import { modelRepo } from '../db/repositories/model.repo'
import { IPC_CHANNELS } from '../../renderer/types/ipc'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, wrapHandler(async (_event, key: string) => {
    if (key === 'has_api_key') {
      // Check if the default model has a key
      const defaultModel = modelRepo.getDefault()
      if (defaultModel) {
        const k = await getModelKey(defaultModel.id)
        return k ? 'true' : 'false'
      }
      return 'false'
    }
    return settingsRepo.get(key)
  }))

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, wrapHandler(async (_event, params: { key: string; value: string }) => {
    if (params.key === 'anthropic_api_key') {
      // Store key against the default model
      const defaultModel = modelRepo.getDefault()
      const modelId = defaultModel?.id
      if (modelId) {
        if (params.value) {
          await setModelKey(modelId, params.value)
        } else {
          await deleteModelKey(modelId)
        }
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
