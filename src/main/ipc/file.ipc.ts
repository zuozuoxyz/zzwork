import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { getProjectsDir } from '../utils/paths'
import { AppError } from '../../renderer/types/errors'

function resolvePath(projectId: string, filePath: string): string {
  const fullPath = join(getProjectsDir(), projectId, filePath)
  // Basic path traversal protection
  if (!fullPath.startsWith(join(getProjectsDir(), projectId))) {
    throw new AppError('FILE_READ_FAILED', '无效的文件路径')
  }
  return fullPath
}

export function registerFileHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.FILE_READ, wrapHandler(async (_event, params: { projectId: string; filePath: string }) => {
    const fullPath = resolvePath(params.projectId, params.filePath)
    if (!existsSync(fullPath)) {
      throw new AppError('FILE_NOT_FOUND', `文件不存在: ${params.filePath}`)
    }
    return readFileSync(fullPath, 'utf-8')
  }))

  ipcMain.handle(IPC_CHANNELS.FILE_WRITE, wrapHandler(async (_event, params: { projectId: string; filePath: string; content: string }) => {
    const fullPath = resolvePath(params.projectId, params.filePath)
    const dir = join(fullPath, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(fullPath, params.content, 'utf-8')
  }))

  ipcMain.handle(IPC_CHANNELS.FILE_LIST, wrapHandler(async (_event, projectId: string) => {
    const projectDir = join(getProjectsDir(), projectId)
    if (!existsSync(projectDir)) {
      return []
    }
    return readdirSync(projectDir, { recursive: true, encoding: 'utf-8' })
  }))

  ipcMain.handle(IPC_CHANNELS.FILE_DELETE, wrapHandler(async (_event, params: { projectId: string; filePath: string }) => {
    const fullPath = resolvePath(params.projectId, params.filePath)
    if (!existsSync(fullPath)) {
      throw new AppError('FILE_NOT_FOUND', `文件不存在: ${params.filePath}`)
    }
    unlinkSync(fullPath)
  }))

  ipcMain.handle(IPC_CHANNELS.FILE_CREATE, wrapHandler(async (_event, params: { projectId: string; filePath: string; content?: string }) => {
    const fullPath = resolvePath(params.projectId, params.filePath)
    if (existsSync(fullPath)) {
      throw new AppError('FILE_ALREADY_EXISTS', `文件已存在: ${params.filePath}`)
    }
    const dir = join(fullPath, '..')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(fullPath, params.content ?? '', 'utf-8')
  }))
}
