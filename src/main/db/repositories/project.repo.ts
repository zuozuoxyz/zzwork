import { v4 as uuid } from 'uuid'
import { getConnection } from '../connection'
import type { Project, CreateProjectDTO, UpdateProjectDTO } from '../../../renderer/types/project'
import { AppError } from '../../../renderer/types/errors'

export class ProjectRepo {
  list(): Project[] {
    const db = getConnection()
    return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Project[]
  }

  getById(id: string): Project | null {
    const db = getConnection()
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined
    return row ?? null
  }

  create(dto: CreateProjectDTO): Project {
    const db = getConnection()

    // Check duplicate name
    const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(dto.name)
    if (existing) {
      throw new AppError('PROJECT_NAME_DUPLICATE', `项目名称 "${dto.name}" 已存在`)
    }

    const project: Project = {
      id: uuid(),
      name: dto.name,
      path: null,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    db.prepare(
      'INSERT INTO projects (id, name, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(project.id, project.name, project.path, project.status, project.createdAt, project.updatedAt)

    return project
  }

  update(id: string, dto: UpdateProjectDTO): Project {
    const db = getConnection()
    const existing = this.getById(id)
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', '项目不存在')
    }

    // Check duplicate name (if name is being changed)
    if (dto.name !== undefined && dto.name !== existing.name) {
      const duplicate = db.prepare('SELECT id FROM projects WHERE name = ? AND id != ?').get(dto.name, id)
      if (duplicate) {
        throw new AppError('PROJECT_NAME_DUPLICATE', `项目名称 "${dto.name}" 已存在`)
      }
    }

    const updated: Project = {
      ...existing,
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.status !== undefined && { status: dto.status }),
      updatedAt: new Date().toISOString()
    }

    db.prepare(
      'UPDATE projects SET name = ?, status = ?, updated_at = ? WHERE id = ?'
    ).run(updated.name, updated.status, updated.updatedAt, id)

    return updated
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
