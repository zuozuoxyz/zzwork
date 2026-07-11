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
  // Try multiple paths for dev vs production compatibility
  const appPath = require('electron').app.getAppPath()
  const paths = [
    join(appPath, 'src/main/db/migrations', fileName),
    join(appPath, 'out/main/db/migrations', fileName),
    join(appPath, '../src/main/db/migrations', fileName),
    join(__dirname, `../db/migrations/${fileName}`),
    join(__dirname, `../../main/db/migrations/${fileName}`),
    join(__dirname, `../../../src/main/db/migrations/${fileName}`),
    join(__dirname, `../../../../src/main/db/migrations/${fileName}`),
  ]

  let sql: string | null = null
  for (const p of paths) {
    if (existsSync(p)) {
      sql = readFileSync(p, 'utf-8')
      break
    }
  }

  if (!sql) {
    console.warn(`Migration file ${fileName} not found, skipping`)
    return
  }

  // Split by semicolons and execute each statement individually
  // This allows ALTER TABLE failures to be non-fatal
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0)
  for (const stmt of statements) {
    try {
      db.exec(stmt + ';')
    } catch (err: any) {
      // Ignore "duplicate column" errors from ALTER TABLE ADD COLUMN
      if (err.message?.includes('duplicate column name') || err.message?.includes('already exists')) {
        console.warn(`Migration skip (already applied): ${stmt.substring(0, 60)}...`)
      } else {
        throw err
      }
    }
  }
}

function runMigrations(db: Database.Database): void {
  runSqlFile(db, '001-init.sql')
  runSqlFile(db, '002-models.sql')
  runSqlFile(db, '003-add-conversations-models.sql')
  runSqlFile(db, '004-project-attributes.sql')
}

export function closeConnection(): void {
  if (db) {
    db.close()
    db = null
  }
}
