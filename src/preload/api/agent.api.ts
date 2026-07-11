import { ipcRenderer } from 'electron'
import type { IpcResult } from '../../renderer/types/errors'
import type { AgentRunParams } from '../../renderer/types/conversation'

export const agentApi = {
  run: (params: AgentRunParams): Promise<IpcResult<void>> =>
    ipcRenderer.invoke('agent:run', params),

  onStart: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:start', (_event, data) => cb(data))
  },
  onChunk: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:chunk', (_event, data) => cb(data))
  },
  onToolCall: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:tool_call', (_event, data) => cb(data))
  },
  onToolResult: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:tool_result', (_event, data) => cb(data))
  },
  onDone: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:done', (_event, data) => cb(data))
  },
  onError: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:error', (_event, data) => cb(data))
  },
  removeAll: () => {
    ipcRenderer.removeAllListeners('agent:start')
    ipcRenderer.removeAllListeners('agent:chunk')
    ipcRenderer.removeAllListeners('agent:tool_call')
    ipcRenderer.removeAllListeners('agent:tool_result')
    ipcRenderer.removeAllListeners('agent:done')
    ipcRenderer.removeAllListeners('agent:error')
  },
}
