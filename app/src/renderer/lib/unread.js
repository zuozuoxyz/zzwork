// 未读标记：主进程在用户可见会话每轮 AI 回复结束时写 ui:taskReplyAt；
// 用户真正看到该任务的对话时写 ui:taskRead。未读 = replyAt > readAt。
import { store } from './api.js'
import { emit } from './state.js'

// 标记某任务的 AI 回复已读：仅当确有待清除的未读时才落库，避免频繁写
export async function markTaskRead(taskId) {
  if (!taskId) return
  try {
    const rawReply = await store('settings.get', { key: 'ui:taskReplyAt', dflt: '' })
    const rawRead = await store('settings.get', { key: 'ui:taskRead', dflt: '' })
    const reply = rawReply ? (JSON.parse(rawReply) || {}) : {}
    const read = rawRead ? (JSON.parse(rawRead) || {}) : {}
    if ((reply[taskId] || 0) <= (read[taskId] || 0)) return
    read[taskId] = Date.now()
    const keys = Object.keys(read)
    if (keys.length > 800) {
      keys.sort((a, b) => (read[a] || 0) - (read[b] || 0))
      for (const k of keys.slice(0, keys.length - 600)) delete read[k]
    }
    await store('settings.set', { key: 'ui:taskRead', value: JSON.stringify(read) })
    emit('unread-changed', taskId)
  } catch {}
}
