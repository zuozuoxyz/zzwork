import { v4 as uuid } from 'uuid'
import { getConnection } from '../connection'
import type { ProjectGroup, CreateGroupDTO, UpdateGroupDTO } from '../../../renderer/types/project'
import { AppError } from '../../../renderer/types/errors'

interface GroupRow {
  id: string
  name: string
  created_at: string
  updated_at: string
}

function rowToGroup(row: GroupRow): ProjectGroup {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class GroupRepo {
  list(): ProjectGroup[] {
    const db = getConnection()
    const rows = db.prepare('SELECT * FROM groups ORDER BY created_at ASC').all() as GroupRow[]
    return rows.map(rowToGroup)
  }

  create(dto: CreateGroupDTO): ProjectGroup {
    const db = getConnection()
    const id = uuid()
    const now = new Date().toISOString()

    const existing = db.prepare('SELECT id FROM groups WHERE name = ?').get(dto.name)
    if (existing) {
      throw new AppError('PROJECT_NAME_DUPLICATE', `组名 "${dto.name}" 已存在`)
    }

    db.prepare('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, dto.name, now, now)

    return { id, name: dto.name, createdAt: now, updatedAt: now }
  }

  update(id: string, dto: UpdateGroupDTO): ProjectGroup {
    const db = getConnection()
    const now = new Date().toISOString()
    db.prepare('UPDATE groups SET name = ?, updated_at = ? WHERE id = ?').run(dto.name, now, id)
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow
    return rowToGroup(row)
  }

  delete(id: string): void {
    const db = getConnection()
    // Move projects in this group to ungrouped
    db.prepare('UPDATE projects SET group_id = NULL WHERE group_id = ?').run(id)
    db.prepare('DELETE FROM groups WHERE id = ?').run(id)
  }
}

export const groupRepo = new GroupRepo()
