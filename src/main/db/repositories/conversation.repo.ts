import { v4 as uuid } from 'uuid'
import { getConnection } from '../connection'
import type { Conversation, ConversationMessage } from '../../../renderer/types/conversation'
import { AppError } from '../../../renderer/types/errors'

interface ConversationRow {
  id: string
  project_id: string
  messages: string
  summary: string | null
  created_at: string
}

export class ConversationRepo {
  listByProject(projectId: string): Conversation[] {
    const db = getConnection()
    const rows = db.prepare(
      'SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC'
    ).all(projectId) as ConversationRow[]
    return rows.map(rowToConversation)
  }

  getById(id: string): Conversation | null {
    const db = getConnection()
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined
    return row ? rowToConversation(row) : null
  }

  create(projectId: string): Conversation {
    const db = getConnection()
    const id = uuid()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO conversations (id, project_id, messages, summary, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, projectId, '[]', null, now)
    return this.getById(id)!
  }

  appendMessage(convId: string, message: ConversationMessage): void {
    const db = getConnection()
    const existing = this.getById(convId)
    if (!existing) throw new AppError('PROJECT_NOT_FOUND', '对话不存在')

    const messages = [...existing.messages, message]
    db.prepare('UPDATE conversations SET messages = ? WHERE id = ?').run(JSON.stringify(messages), convId)
  }

  appendMessages(convId: string, newMessages: ConversationMessage[]): void {
    const db = getConnection()
    const existing = this.getById(convId)
    if (!existing) throw new AppError('PROJECT_NOT_FOUND', '对话不存在')

    const messages = [...existing.messages, ...newMessages]
    db.prepare('UPDATE conversations SET messages = ? WHERE id = ?').run(JSON.stringify(messages), convId)
  }

  delete(id: string): void {
    const db = getConnection()
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    messages: JSON.parse(row.messages || '[]'),
    summary: row.summary,
    createdAt: row.created_at,
  }
}

export const conversationRepo = new ConversationRepo()
