import { app } from 'electron'
import { join } from 'path'

export function getDataDir(): string {
  return join(app.getPath('userData'), 'data')
}

export function getDbPath(): string {
  return join(getDataDir(), 'zzwork.db')
}

export function getProjectsDir(): string {
  return join(getDataDir(), 'projects')
}
