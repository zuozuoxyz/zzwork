import { ipcRenderer } from 'electron'
import type { IpcResult } from '../../renderer/types/errors'
import type { Conversation, ConversationMessage } from '../../renderer/types/conversation'

export const conversationApi = {
  list: (projectId: string): Promise<IpcResult<Conversation[]>> =>
    ipcRenderer.invoke('conversation:list', projectId),

  get: (id: string): Promise<IpcResult<Conversation | null>> =>
    ipcRenderer.invoke('conversation:get', id),

  create: (projectId: string): Promise<IpcResult<Conversation>> =>
    ipcRenderer.invoke('conversation:create', projectId),

  append: (convId: string, message: ConversationMessage): Promise<IpcResult<void>> =>
    ipcRenderer.invoke('conversation:append', { convId, message }),

  delete: (id: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke('conversation:delete', id),
}
