import { ipcMain, IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../../renderer/types/errors'
import { AppError } from '../../renderer/types/errors'
import { registerProjectHandlers } from './project.ipc'
import { registerProgressHandlers } from './progress.ipc'
import { registerFileHandlers } from './file.ipc'
import { registerSettingsHandlers } from './settings.ipc'
import { registerConversationHandlers } from './conversation.ipc'
import { registerAgentHandlers } from './agent.ipc'
import { registerModelHandlers } from './model.ipc'

type IpcHandlerFn = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>

export function wrapHandler(fn: IpcHandlerFn): IpcHandlerFn {
  return async (event: IpcMainInvokeEvent, ...args: any[]) => {
    try {
      const data = await fn(event, ...args)
      return { ok: true, data } as IpcResult<typeof data>
    } catch (err) {
      if (err instanceof AppError) {
        return {
          ok: false,
          error: { code: err.code, message: err.message, detail: err.detail }
        } as IpcResult<never>
      }
      console.error('Unhandled IPC error:', err)
      return {
        ok: false,
        error: { code: 'INTERNAL', message: '内部错误，请查看日志' }
      } as IpcResult<never>
    }
  }
}

export function registerAllIpcHandlers(): void {
  registerProjectHandlers()
  registerProgressHandlers()
  registerFileHandlers()
  registerSettingsHandlers()
  registerConversationHandlers()
  registerAgentHandlers()
  registerModelHandlers()
}
