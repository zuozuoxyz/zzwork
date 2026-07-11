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

function runSqlFile(db: Database.Database, fileName: string): void {
  const paths = [
    join(__dirname, `../db/migrations/${fileName}`),
    join(__dirname, `../../main/db/migrations/${fileName}`),
    join(__dirname, `../../../src/main/db/migrations/${fileName}`),
  ]

  let sql: string | null = null
  for (const p of paths) {
    if (existsSync(p)) {
      sql = readFileSync(p, 'utf-8')
      break
    }
  }

  if (!sql) {
    throw new Error(`Migration file ${fileName} not found`)
  }

  db.exec(sql)
}

function runMigrations(db: Database.Database): void {
  runSqlFile(db, '001-init.sql')
  runSqlFile(db, '002-models.sql')
}

export function closeConnection(): void {
  if (db) {
    db.close()
    db = null
  }
}
