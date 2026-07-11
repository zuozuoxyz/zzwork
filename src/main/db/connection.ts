import Database from 'better-sqlite3'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { getDbPath, getProjectsDir } from '../utils/paths'

let db: Database.Database | null = null

export function getConnection(): Database.Database {
  if (db) return db

  const dbPath = getDbPath()
  const projectsDir = getProjectsDir()

  // Ensure directories exist
  if (!existsSync(dirname(dbPath))) {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  if (!existsSync(projectsDir)) {
    mkdirSync(projectsDir, { recursive: true })
  }

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)

  return db
}

function runMigrations(db: Database.Database): void {
  const migrationPath = join(__dirname, '../db/migrations/001-init.sql')
  // In production, __dirname points to out/main; in dev with electron-vite, resolve accordingly
  const migrationPaths = [
    migrationPath,
    join(__dirname, '../../main/db/migrations/001-init.sql'),
    join(__dirname, '../../../src/main/db/migrations/001-init.sql'),
  ]

  let sql: string | null = null
  for (const p of migrationPaths) {
    if (existsSync(p)) {
      sql = readFileSync(p, 'utf-8')
      break
    }
  }

  if (!sql) {
    throw new Error('Migration file 001-init.sql not found')
  }

  db.exec(sql)
}

export function closeConnection(): void {
  if (db) {
    db.close()
    db = null
  }
}
