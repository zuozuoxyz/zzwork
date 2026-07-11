import { getConnection } from '../connection'

export class SettingsRepo {
  get(key: string): string | null {
    const db = getConnection()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    const db = getConnection()
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
    ).run(key, value, value)
  }

  getAll(): Record<string, string> {
    const db = getConnection()
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    return result
  }
}

export const settingsRepo = new SettingsRepo()
