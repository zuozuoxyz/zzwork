import { v4 as uuid } from 'uuid'
import { getConnection } from '../connection'
import { mkdirSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getProjectsDir } from '../../utils/paths'
import type { Project, CreateProjectDTO, UpdateProjectDTO } from '../../../renderer/types/project'
import { AppError } from '../../../renderer/types/errors'

interface ProjectRow {
  id: string
  name: string
  group_id: string | null
  path: string | null
  status: string
  description: string
  start_date: string | null
  end_date: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    groupId: row.group_id,
    path: row.path,
    status: row.status as Project['status'],
    description: row.description || '',
    startDate: row.start_date,
    endDate: row.end_date,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class ProjectRepo {
  list(): Project[] {
    const db = getConnection()
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[]
    return rows.map(rowToProject)
  }

  listByGroup(groupId: string | null): Project[] {
    const db = getConnection()
    const rows = groupId
      ? db.prepare('SELECT * FROM projects WHERE group_id = ? ORDER BY updated_at DESC').all(groupId)
      : db.prepare('SELECT * FROM projects WHERE group_id IS NULL ORDER BY updated_at DESC').all()
    return (rows as ProjectRow[]).map(rowToProject)
  }

  getById(id: string): Project | null {
    const db = getConnection()
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    return row ? rowToProject(row) : null
  }

  create(dto: CreateProjectDTO): Project {
    const db = getConnection()

    const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(dto.name)
    if (existing) {
      throw new AppError('PROJECT_NAME_DUPLICATE', `项目名称 "${dto.name}" 已存在`)
    }

    const id = uuid()
    const now = new Date().toISOString()

    db.prepare(
      `INSERT INTO projects (id, name, group_id, path, status, description, start_date, end_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, dto.name, dto.groupId || null, null, 'active',
      dto.description || '', dto.startDate || null, dto.endDate || null, now, now)

    // Auto-create project directory and info file
    const projectDir = join(getProjectsDir(), id)
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true })
    }
    const infoContent = `# ${dto.name}

- 状态: 进行中
- 开始时间: ${dto.startDate || '未设置'}
- 截止时间: ${dto.endDate || '未设置'}
- 描述: ${dto.description || '暂无'}
`
    writeFileSync(join(projectDir, 'info.md'), infoContent, 'utf-8')

    return this.getById(id)!
  }

  update(id: string, dto: UpdateProjectDTO): Project {
    const db = getConnection()
    const existing = this.getById(id)
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', '项目不存在')
    }

    if (dto.name !== undefined && dto.name !== existing.name) {
      const duplicate = db.prepare('SELECT id FROM projects WHERE name = ? AND id != ?').get(dto.name, id)
      if (duplicate) {
        throw new AppError('PROJECT_NAME_DUPLICATE', `项目名称 "${dto.name}" 已存在`)
      }
    }

    const fields: string[] = []
    const values: any[] = []

    if (dto.name !== undefined) { fields.push('name = ?'); values.push(dto.name) }
    if (dto.groupId !== undefined) { fields.push('group_id = ?'); values.push(dto.groupId) }
    if (dto.status !== undefined) { fields.push('status = ?'); values.push(dto.status) }
    if (dto.description !== undefined) { fields.push('description = ?'); values.push(dto.description) }
    if (dto.startDate !== undefined) { fields.push('start_date = ?'); values.push(dto.startDate) }
    if (dto.endDate !== undefined) { fields.push('end_date = ?'); values.push(dto.endDate) }
    if (dto.completedAt !== undefined) { fields.push('completed_at = ?'); values.push(dto.completedAt) }

    if (fields.length > 0) {
      fields.push('updated_at = ?')
      values.push(new Date().toISOString())
      values.push(id)
      db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }

    return this.getById(id)!
  }

  delete(id: string): void {
    const db = getConnection()
    const existing = this.getById(id)
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', '项目不存在')
    }
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  archive(id: string): Project {
    return this.update(id, { status: 'archived' })
  }
}

export const projectRepo = new ProjectRepo()
