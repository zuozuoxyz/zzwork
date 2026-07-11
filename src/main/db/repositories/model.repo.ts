import { v4 as uuid } from 'uuid'
import { getConnection } from '../connection'
import type { ModelConfig, CreateModelDTO, UpdateModelDTO } from '../../../renderer/types/model'
import { AppError } from '../../../renderer/types/errors'

interface ModelRow {
  id: string
  name: string
  type: string
  base_url: string
  model_id: string
  is_default: number
  created_at: string
}

function rowToModel(row: ModelRow): ModelConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ModelConfig['type'],
    baseUrl: row.base_url,
    modelId: row.model_id,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  }
}

const PRESETS: CreateModelDTO[] = [
  {
    name: 'Claude Sonnet',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    modelId: 'claude-sonnet-4-20250514',
    apiKey: '',
    isDefault: true,
  },
  {
    name: 'GPT-4o',
    type: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4o',
    apiKey: '',
    isDefault: false,
  },
]

export class ModelRepo {
  list(): ModelConfig[] {
    const db = getConnection()
    const rows = db.prepare('SELECT * FROM models ORDER BY created_at ASC').all() as ModelRow[]
    return rows.map(rowToModel)
  }

  getById(id: string): ModelConfig | null {
    const db = getConnection()
    const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined
    return row ? rowToModel(row) : null
  }

  getDefault(): ModelConfig | null {
    const db = getConnection()
    const row = db.prepare('SELECT * FROM models WHERE is_default = 1 LIMIT 1').get() as ModelRow | undefined
    return row ? rowToModel(row) : null
  }

  create(dto: CreateModelDTO): ModelConfig {
    const db = getConnection()
    const id = uuid()
    const now = new Date().toISOString()
    const isDefault = dto.isDefault ?? false

    if (isDefault) {
      db.prepare('UPDATE models SET is_default = 0').run()
    }

    db.prepare(
      'INSERT INTO models (id, name, type, base_url, model_id, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, dto.name, dto.type, dto.baseUrl, dto.modelId, isDefault ? 1 : 0, now)

    return this.getById(id)!
  }

  update(id: string, dto: UpdateModelDTO): ModelConfig {
    const db = getConnection()
    const existing = this.getById(id)
    if (!existing) throw new AppError('PROJECT_NOT_FOUND', '模型不存在')

    if (dto.isDefault) {
      db.prepare('UPDATE models SET is_default = 0').run()
    }

    const fields: string[] = []
    const values: any[] = []
    if (dto.name !== undefined) { fields.push('name = ?'); values.push(dto.name) }
    if (dto.type !== undefined) { fields.push('type = ?'); values.push(dto.type) }
    if (dto.baseUrl !== undefined) { fields.push('base_url = ?'); values.push(dto.baseUrl) }
    if (dto.modelId !== undefined) { fields.push('model_id = ?'); values.push(dto.modelId) }
    if (dto.isDefault !== undefined) { fields.push('is_default = ?'); values.push(dto.isDefault ? 1 : 0) }

    if (fields.length > 0) {
      values.push(id)
      db.prepare(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }

    return this.getById(id)!
  }

  delete(id: string): void {
    const db = getConnection()
    const models = this.list()
    if (models.length <= 1) throw new AppError('PROJECT_NOT_FOUND', '至少保留一个模型')
    db.prepare('DELETE FROM models WHERE id = ?').run(id)
    // If deleted model was default, set first remaining as default
    const remaining = this.list()
    if (!remaining.some((m) => m.isDefault)) {
      db.prepare('UPDATE models SET is_default = 1 WHERE id = ?').run(remaining[0].id)
    }
  }

  setDefault(id: string): ModelConfig {
    const db = getConnection()
    db.prepare('UPDATE models SET is_default = 0').run()
    db.prepare('UPDATE models SET is_default = 1 WHERE id = ?').run(id)
    return this.getById(id)!
  }

  seedIfEmpty(): void {
    const db = getConnection()
    const count = db.prepare('SELECT COUNT(*) as c FROM models').get() as { c: number }
    if (count.c === 0) {
      for (const preset of PRESETS) {
        const id = uuid()
        const now = new Date().toISOString()
        db.prepare(
          'INSERT INTO models (id, name, type, base_url, model_id, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, preset.name, preset.type, preset.baseUrl, preset.modelId, preset.isDefault ? 1 : 0, now)
      }
    }
  }
}

export const modelRepo = new ModelRepo()
