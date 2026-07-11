import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { getProjectsDir } from '../utils/paths'
import { progressRepo } from '../db/repositories/progress.repo'
import { getConnection } from '../db/connection'
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages'

export interface ToolDefinition {
  definition: Tool
  execute: (input: Record<string, unknown>, projectId: string) => Promise<string> | string
}

function resolvePath(projectId: string, filePath: string): string {
  const baseDir = join(getProjectsDir(), projectId)
  const fullPath = join(baseDir, filePath)
  if (!fullPath.startsWith(baseDir)) {
    throw new Error('无效的文件路径')
  }
  return fullPath
}

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    definition: {
      name: 'read_file',
      description: '读取项目中的文件内容（Markdown、代码、文档等）',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          file_path: { type: 'string', description: '相对于项目根目录的文件路径' },
        },
        required: ['project_id', 'file_path'],
      },
    },
    execute: (input) => {
      const fullPath = resolvePath(input.project_id as string, input.file_path as string)
      if (!existsSync(fullPath)) return `文件不存在: ${input.file_path}`
      return readFileSync(fullPath, 'utf-8')
    },
  },
  {
    definition: {
      name: 'list_files',
      description: '列出项目目录下的所有文件',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          pattern: { type: 'string', description: '可选的文件名过滤，如 *.md' },
        },
        required: ['project_id'],
      },
    },
    execute: (input) => {
      const projectDir = join(getProjectsDir(), input.project_id as string)
      if (!existsSync(projectDir)) return '项目目录不存在'
      const files = readdirSync(projectDir, { recursive: true, encoding: 'utf-8' })
      const pattern = input.pattern as string | undefined
      if (pattern) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'))
        return files.filter((f) => regex.test(f)).join('\n') || '无匹配文件'
      }
      return files.join('\n') || '目录为空'
    },
  },
  {
    definition: {
      name: 'query_progress',
      description: '查询项目的进度数据，支持按状态筛选，支持查找 N 天未更新的停滞条目',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'], description: '按状态筛选' },
          days_stale: { type: 'number', description: '筛选超过 N 天未更新的条目' },
        },
        required: ['project_id'],
      },
    },
    execute: (input) => {
      const items = progressRepo.listByProject(input.project_id as string)
      let filtered = items

      if (input.status) {
        filtered = filtered.filter((i) => i.status === input.status)
      }
      if (input.days_stale) {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - (input.days_stale as number))
        filtered = filtered.filter((i) => new Date(i.updatedAt) < cutoff)
      }

      if (filtered.length === 0) return '暂无匹配的进度条目'

      return filtered.map((i) =>
        `[${i.status}] ${i.title} | 优先级: ${i.priority} | 更新: ${i.updatedAt}${i.estimatedHours ? ` | 预估: ${i.estimatedHours}h` : ''}`
      ).join('\n')
    },
  },
  {
    definition: {
      name: 'search_code',
      description: '在项目文件中搜索特定关键词或正则表达式',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          query: { type: 'string', description: '搜索关键词或正则' },
          file_pattern: { type: 'string', description: '文件过滤，如 *.ts' },
        },
        required: ['project_id', 'query'],
      },
    },
    execute: (input) => {
      const projectDir = join(getProjectsDir(), input.project_id as string)
      if (!existsSync(projectDir)) return '项目目录不存在'

      const files = readdirSync(projectDir, { recursive: true, encoding: 'utf-8' })
      const pattern = input.file_pattern as string | undefined
      const targetFiles = pattern
        ? files.filter((f) => new RegExp(pattern.replace(/\*/g, '.*')).test(f))
        : files

      const results: string[] = []
      const query = input.query as string
      for (const file of targetFiles) {
        try {
          const content = readFileSync(join(projectDir, file), 'utf-8')
          const lines = content.split('\n')
          lines.forEach((line, idx) => {
            if (line.includes(query)) {
              results.push(`${file}:${idx + 1}: ${line.trim().substring(0, 120)}`)
            }
          })
        } catch { /* skip binary/unreadable files */ }
      }

      return results.length > 0
        ? results.slice(0, 30).join('\n')
        : `未找到包含 "${query}" 的文件`
    },
  },
  {
    definition: {
      name: 'read_conversation',
      description: '读取最近的对话记录，用于回顾之前的讨论上下文',
      input_schema: {
        type: 'object' as const,
        properties: {
          conversation_id: { type: 'string', description: '对话 ID' },
          limit: { type: 'number', description: '读取最近 N 条消息，默认 20', default: 20 },
        },
        required: ['conversation_id'],
      },
    },
    execute: (input) => {
      const db = getConnection()
      const row = db.prepare('SELECT messages FROM conversations WHERE id = ?').get(input.conversation_id as string) as { messages: string } | undefined
      if (!row) return '对话不存在'

      const messages = JSON.parse(row.messages)
      const limit = (input.limit as number) || 20
      const recent = messages.slice(-limit)
      return JSON.stringify(recent, null, 2)
    },
  },
  {
    definition: {
      name: 'save_note',
      description: '在项目中创建一个笔记或报告文件',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_id: { type: 'string', description: '项目 ID' },
          filename: { type: 'string', description: '文件名，如 report-2026-07-11.md' },
          content: { type: 'string', description: '文件内容（Markdown 格式）' },
        },
        required: ['project_id', 'filename', 'content'],
      },
    },
    execute: (input) => {
      const fullPath = resolvePath(input.project_id as string, input.filename as string)
      const dir = dirname(fullPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(fullPath, input.content as string, 'utf-8')
      return `文件已保存: ${input.filename}`
    },
  },
  {
    definition: {
      name: 'update_progress',
      description: '更新进度条目的状态、备注等信息',
      input_schema: {
        type: 'object' as const,
        properties: {
          progress_id: { type: 'string', description: '进度条目 ID' },
          status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] },
          notes: { type: 'string', description: '更新的备注内容' },
        },
        required: ['progress_id'],
      },
    },
    execute: (input) => {
      const updateData: Record<string, unknown> = {}
      if (input.status) updateData.status = input.status
      if (input.notes) updateData.notes = input.notes
      if (Object.keys(updateData).length === 0) return '没有需要更新的字段'
      progressRepo.update(input.progress_id as string, updateData as any)
      return `进度条目 ${input.progress_id} 已更新`
    },
  },
]
