import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { IpcResult } from '../../renderer/types/errors'

export const settingsApi = {
  get: (key: string): Promise<IpcResult<string | null>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key),

  set: (key: string, value: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, { key, value }),

  getAll: (): Promise<IpcResult<Record<string, string>>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_ALL),
}
