import { v4 as uuid } from 'uuid'
import { getConnection } from '../connection'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO } from '../../../renderer/types/progress'
import { AppError } from '../../../renderer/types/errors'

interface ProgressRow {
  id: string
  project_id: string
  title: string
  status: string
  priority: string
  notes: string
  tags: string
  estimated_hours: number | null
  actual_hours: number | null
  created_at: string
  updated_at: string
}

function rowToItem(row: ProgressRow): ProgressItem {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status as ProgressItem['status'],
    priority: row.priority as ProgressItem['priority'],
    notes: row.notes,
    tags: JSON.parse(row.tags || '[]'),
    estimatedHours: row.estimated_hours,
    actualHours: row.actual_hours,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class ProgressRepo {
  listByProject(projectId: string): ProgressItem[] {
    const db = getConnection()
    const rows = db.prepare(
      'SELECT * FROM progress WHERE project_id = ? ORDER BY updated_at ASC'
    ).all(projectId) as ProgressRow[]
    return rows.map(rowToItem)
  }

  create(dto: CreateProgressDTO): ProgressItem {
    const db = getConnection()
    const id = uuid()
    const now = new Date().toISOString()

    const tags = JSON.stringify(dto.tags ?? [])
    const status = dto.status ?? 'todo'
    const priority = dto.priority ?? 'medium'
    const notes = dto.notes ?? ''
    const estimatedHours = dto.estimatedHours ?? null

    db.prepare(
      `INSERT INTO progress (id, project_id, title, status, priority, notes, tags, estimated_hours, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, dto.projectId, dto.title, status, priority, notes, tags, estimatedHours, now, now)

    return this.getById(id)!
  }

  getById(id: string): ProgressItem | null {
    const db = getConnection()
    const row = db.prepare('SELECT * FROM progress WHERE id = ?').get(id) as ProgressRow | undefined
    return row ? rowToItem(row) : null
  }

  update(id: string, dto: UpdateProgressDTO): ProgressItem {
    const db = getConnection()
    const existing = this.getById(id)
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', '进度条目不存在')
    }

    const now = new Date().toISOString()
    const tags = dto.tags !== undefined ? JSON.stringify(dto.tags) : undefined

    const fields: string[] = []
    const values: any[] = []

    if (dto.title !== undefined) { fields.push('title = ?'); values.push(dto.title) }
    if (dto.status !== undefined) { fields.push('status = ?'); values.push(dto.status) }
    if (dto.priority !== undefined) { fields.push('priority = ?'); values.push(dto.priority) }
    if (dto.notes !== undefined) { fields.push('notes = ?'); values.push(dto.notes) }
    if (tags !== undefined) { fields.push('tags = ?'); values.push(tags) }
    if (dto.estimatedHours !== undefined) { fields.push('estimated_hours = ?'); values.push(dto.estimatedHours) }
    if (dto.actualHours !== undefined) { fields.push('actual_hours = ?'); values.push(dto.actualHours) }

    if (fields.length > 0) {
      fields.push('updated_at = ?')
      values.push(now)
      values.push(id)
      db.prepare(`UPDATE progress SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }

    return this.getById(id)!
  }

  delete(id: string): void {
    const db = getConnection()
    const existing = this.getById(id)
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', '进度条目不存在')
    }
    db.prepare('DELETE FROM progress WHERE id = ?').run(id)
  }

  reorder(projectId: string, itemIds: string[]): void {
    const db = getConnection()
    const updateStmt = db.prepare(
      'UPDATE progress SET updated_at = ? WHERE id = ? AND project_id = ?'
    )
    const now = Date.now()
    const tx = db.transaction(() => {
      itemIds.forEach((id, index) => {
        updateStmt.run(new Date(now + index).toISOString(), id, projectId)
      })
    })
    tx()
  }
}

export const progressRepo = new ProgressRepo()
