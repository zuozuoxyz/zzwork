import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { ConversationMessage } from '../../renderer/types/conversation'

export function registerConversationHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST, wrapHandler(async (_event, projectId: string) => {
    return conversationRepo.listByProject(projectId)
  }))

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET, wrapHandler(async (_event, id: string) => {
    return conversationRepo.getById(id)
  }))

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_CREATE, wrapHandler(async (_event, projectId: string) => {
    return conversationRepo.create(projectId)
  }))

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_APPEND, wrapHandler(async (_event, params: { convId: string; message: ConversationMessage }) => {
    return conversationRepo.appendMessage(params.convId, params.message)
  }))

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_DELETE, wrapHandler(async (_event, id: string) => {
    return conversationRepo.delete(id)
  }))
}
