import { ipcMain, IpcMainInvokeEvent } from 'electron'
import { runAgent, type AgentEvent, type AgentRunParams } from '../services/agent.service'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { IpcResult } from '../../renderer/types/errors'

const AGENT_RUN_CHANNEL = 'agent:run'

export function registerAgentHandlers(): void {
  ipcMain.handle(AGENT_RUN_CHANNEL, async (event: IpcMainInvokeEvent, params: AgentRunParams) => {
    // Start agent run in background; events streamed back to renderer
    const sender = event.sender

    const onEvent = (evt: AgentEvent) => {
      sender.send(`agent:${evt.type}`, evt)
    }

    runAgent(params, onEvent).catch((err) => {
      sender.send('agent:error', {
        conversationId: params.conversationId,
        code: 'INTERNAL',
        message: err.message || 'Agent 运行异常',
      })
    })

    // Return immediately; actual response goes via events
    return { ok: true, data: undefined } as IpcResult<void>
  })
}
