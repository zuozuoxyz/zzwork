# zzwork Phase 1 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VS Code-style desktop work management tool with three-panel layout (project tree + editor + AI panel placeholder), project CRUD, progress CRUD, Monaco Editor, and local SQLite storage.

**Architecture:** Electron main process manages SQLite via better-sqlite3 and exposes IPC handlers. Preload scripts bridge via contextBridge. React renderer uses Zustand stores for state, Ant Design for UI components, and Monaco Editor for file editing.

**Tech Stack:** Electron 33+, electron-vite 3+, React 18, TypeScript 5, Ant Design 5, Zustand 4, Monaco Editor, better-sqlite3, uuid

## Global Constraints

- No tests (deferred per design decision)
- Electron >= 33, React 18, TypeScript 5
- SQLite via better-sqlite3 (native module, must rebuild for Electron)
- IPC response format: `{ ok: true, data: T }` | `{ ok: false, error: { code, message, detail? } }`
- IPC channel naming: `domain:action` (e.g., `project:list`)
- API Key never exposed to renderer; Phase 1 uses placeholder settings IPC only
- VS Code dark theme via Ant Design theme tokens

---

## File Map

```
zzwork/
├── electron.vite.config.ts          [Task 1]
├── electron-builder.yml             [Task 1]
├── package.json                     [Task 1]
├── tsconfig.json                    [Task 1]
├── tsconfig.node.json               [Task 1]
├── tsconfig.web.json                [Task 1]
│
├── resources/                       [Task 1 - placeholder]
│
├── src/
│   ├── main/
│   │   ├── index.ts                 [Task 1, updated throughout]
│   │   ├── ipc/
│   │   │   ├── index.ts             [Task 4]
│   │   │   ├── project.ipc.ts       [Task 4]
│   │   │   ├── progress.ipc.ts      [Task 4]
│   │   │   ├── file.ipc.ts          [Task 4]
│   │   │   └── settings.ipc.ts      [Task 4]
│   │   ├── db/
│   │   │   ├── connection.ts        [Task 3]
│   │   │   ├── migrations/
│   │   │   │   └── 001-init.sql     [Task 3]
│   │   │   └── repositories/
│   │   │       ├── project.repo.ts  [Task 3]
│   │   │       ├── progress.repo.ts [Task 3]
│   │   │       └── settings.repo.ts [Task 3]
│   │   └── utils/
│   │       └── paths.ts             [Task 3]
│   │
│   ├── preload/
│   │   ├── index.ts                 [Task 5]
│   │   └── api/
│   │       ├── project.api.ts       [Task 5]
│   │       ├── progress.api.ts      [Task 5]
│   │       ├── file.api.ts          [Task 5]
│   │       └── settings.api.ts      [Task 5]
│   │
│   └── renderer/
│       ├── index.html               [Task 1]
│       ├── main.tsx                 [Task 1]
│       ├── App.tsx                  [Task 14]
│       ├── env.d.ts                 [Task 5]
│       ├── stores/
│       │   ├── project.store.ts     [Task 6]
│       │   ├── progress.store.ts    [Task 6]
│       │   ├── editor.store.ts      [Task 6]
│       │   └── ui.store.ts          [Task 6]
│       ├── components/
│       │   ├── layout/
│       │   │   ├── AppShell.tsx      [Task 8]
│       │   │   ├── Sidebar.tsx       [Task 8]
│       │   │   ├── EditorArea.tsx    [Task 8]
│       │   │   ├── AIPanel.tsx       [Task 13]
│       │   │   └── StatusBar.tsx     [Task 12]
│       │   ├── project/
│       │   │   ├── ProjectTree.tsx   [Task 9]
│       │   │   └── ProjectCreateModal.tsx [Task 9]
│       │   ├── progress/
│       │   │   ├── ProgressPanel.tsx   [Task 11]
│       │   │   ├── ProgressKanban.tsx  [Task 11]
│       │   │   └── ProgressFormModal.tsx [Task 11]
│       │   ├── editor/
│       │   │   ├── EditorTabs.tsx    [Task 10]
│       │   │   └── MonacoEditor.tsx  [Task 10]
│       │   └── shared/
│       │       └── ResizeHandle.tsx  [Task 8]
│       ├── styles/
│       │   ├── theme.ts             [Task 7]
│       │   └── global.css           [Task 7]
│       └── types/
│           ├── project.ts           [Task 2]
│           ├── progress.ts          [Task 2]
│           ├── ipc.ts               [Task 2]
│           └── errors.ts            [Task 2]
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `electron-builder.yml`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `resources/icon.png`

**Produces:**
- Runnable Electron window with React rendering
- `npm run dev` starts dev mode with HMR
- Empty App component showing "zzwork" text

- [ ] **Step 1: Create package.json**

```json
{
  "name": "zzwork",
  "version": "0.1.0",
  "description": "VS Code-style work management tool",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "postinstall": "electron-builder install-app-deps"
  },
  "dependencies": {
    "antd": "^5.22.0",
    "@ant-design/icons": "^5.5.0",
    "zustand": "^4.5.0",
    "better-sqlite3": "^11.6.0",
    "uuid": "^10.0.0",
    "monaco-editor": "^0.52.0",
    "@monaco-editor/react": "^4.6.0",
    "@electron-toolkit/utils": "^3.0.0"
  },
  "devDependencies": {
    "electron": "^33.2.0",
    "electron-vite": "^3.0.0",
    "electron-builder": "^25.1.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/uuid": "^10.0.0",
    "typescript": "^5.6.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd /home/zuozuo/sf/zzwork && npm install
```

Expected: Installs all packages. May show better-sqlite3 rebuild warnings (handled by postinstall).

- [ ] **Step 3: Create electron.vite.config.ts**

```typescript
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['better-sqlite3']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer')
      }
    },
    plugins: [react()]
  }
})
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

- [ ] **Step 5: Create tsconfig.node.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./out",
    "declaration": true,
    "resolveJsonModule": true,
    "composite": true
  },
  "include": ["src/main/**/*", "src/preload/**/*", "electron.vite.config.ts"]
}
```

- [ ] **Step 6: Create tsconfig.web.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
    "outDir": "./out",
    "declaration": true,
    "composite": true,
    "paths": {
      "@/*": ["./src/renderer/*"]
    }
  },
  "include": ["src/renderer/**/*"]
}
```

- [ ] **Step 7: Create electron-builder.yml**

```yaml
appId: com.zzwork.app
productName: zzwork
directories:
  buildResources: resources
  output: dist
files:
  - out/**/*
  - "!node_modules/**/*"
linux:
  target: AppImage
mac:
  target: dmg
win:
  target: nsis
extraResources:
  - resources/**
```

- [ ] **Step 8: Create src/main/index.ts**

```typescript
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'zzwork',
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
```

- [ ] **Step 9: Create src/preload/index.ts (initial placeholder)**

```typescript
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('api', {})
```

- [ ] **Step 10: Create src/renderer/index.html**

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>zzwork</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 11: Create src/renderer/main.tsx**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **Step 12: Create src/renderer/App.tsx (placeholder)**

```tsx
function App(): JSX.Element {
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#1e1e1e',
      color: '#cccccc',
      fontFamily: 'sans-serif',
      fontSize: '24px'
    }}>
      zzwork
    </div>
  )
}

export default App
```

- [ ] **Step 13: Create placeholder icon**

```bash
mkdir -p /home/zuozuo/sf/zzwork/resources
# Create a minimal 1x1 PNG placeholder
python3 -c "
import base64, struct, zlib
def create_png():
    raw = b''
    for y in range(1):
        raw += b'\\x00' + b'\\x00\\x00\\xff' * 1
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
    return b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
with open('/home/zuozuo/sf/zzwork/resources/icon.png', 'wb') as f:
    f.write(create_png())
" 2>/dev/null || touch /home/zuozuo/sf/zzwork/resources/icon.png
```

Expected: Creates a placeholder icon file.

- [ ] **Step 14: Verify dev mode starts**

```bash
cd /home/zuozuo/sf/zzwork && timeout 10 npx electron-vite dev 2>&1 || true
```

Expected: Build succeeds, no TypeScript errors. Electron window may not open in headless, but build output should be clean.

- [ ] **Step 15: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git init && git add -A && git commit -m "feat: scaffold project with electron-vite + React + TypeScript"
```

---

### Task 2: Shared Types

**Files:**
- Create: `src/renderer/types/project.ts`, `src/renderer/types/progress.ts`, `src/renderer/types/ipc.ts`, `src/renderer/types/errors.ts`

**Produces:**
- Type definitions used by main, preload, and renderer
- IPC channel constants
- Error code union type

- [ ] **Step 1: Create src/renderer/types/project.ts**

```typescript
export interface Project {
  id: string
  name: string
  path: string | null
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export interface CreateProjectDTO {
  name: string
}

export interface UpdateProjectDTO {
  name?: string
  status?: 'active' | 'archived'
}
```

- [ ] **Step 2: Create src/renderer/types/progress.ts**

```typescript
export type ProgressStatus = 'todo' | 'doing' | 'done' | 'blocked'
export type ProgressPriority = 'low' | 'medium' | 'high'

export interface ProgressItem {
  id: string
  projectId: string
  title: string
  status: ProgressStatus
  priority: ProgressPriority
  notes: string
  tags: string[]
  estimatedHours: number | null
  actualHours: number | null
  createdAt: string
  updatedAt: string
}

export interface CreateProgressDTO {
  projectId: string
  title: string
  status?: ProgressStatus
  priority?: ProgressPriority
  notes?: string
  tags?: string[]
  estimatedHours?: number
}

export interface UpdateProgressDTO {
  title?: string
  status?: ProgressStatus
  priority?: ProgressPriority
  notes?: string
  tags?: string[]
  estimatedHours?: number
  actualHours?: number
}
```

- [ ] **Step 3: Create src/renderer/types/errors.ts**

```typescript
export type ErrorCode =
  | 'DB_CONNECTION_FAILED'
  | 'DB_MIGRATION_FAILED'
  | 'DB_QUERY_FAILED'
  | 'FILE_NOT_FOUND'
  | 'FILE_READ_FAILED'
  | 'FILE_WRITE_FAILED'
  | 'FILE_ALREADY_EXISTS'
  | 'AI_API_KEY_MISSING'
  | 'AI_API_ERROR'
  | 'AI_TIMEOUT'
  | 'AI_RATE_LIMITED'
  | 'AI_INVALID_RESPONSE'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_NAME_DUPLICATE'
  | 'IPC_TIMEOUT'
  | 'IPC_UNKNOWN_CHANNEL'
  | 'INTERNAL'

export class AppError extends Error {
  public readonly code: ErrorCode
  public readonly detail?: string

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message)
    this.code = code
    this.detail = detail
    this.name = 'AppError'
  }
}

export interface IpcSuccess<T> {
  ok: true
  data: T
}

export interface IpcError {
  ok: false
  error: {
    code: ErrorCode
    message: string
    detail?: string
  }
}

export type IpcResult<T> = IpcSuccess<T> | IpcError
```

- [ ] **Step 4: Create src/renderer/types/ipc.ts**

```typescript
import type { Project, CreateProjectDTO, UpdateProjectDTO } from './project'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO } from './progress'

export const IPC_CHANNELS = {
  PROJECT_LIST:    'project:list',
  PROJECT_GET:     'project:get',
  PROJECT_CREATE:  'project:create',
  PROJECT_UPDATE:  'project:update',
  PROJECT_DELETE:  'project:delete',
  PROJECT_ARCHIVE: 'project:archive',

  PROGRESS_LIST:   'progress:list',
  PROGRESS_CREATE: 'progress:create',
  PROGRESS_UPDATE: 'progress:update',
  PROGRESS_DELETE: 'progress:delete',
  PROGRESS_REORDER:'progress:reorder',

  FILE_READ:       'file:read',
  FILE_WRITE:      'file:write',
  FILE_LIST:       'file:list',
  FILE_DELETE:     'file:delete',
  FILE_CREATE:     'file:create',

  SETTINGS_GET:    'settings:get',
  SETTINGS_SET:    'settings:set',
  SETTINGS_GET_ALL:'settings:get-all',
} as const

export type IpcChannelMap = {
  [IPC_CHANNELS.PROJECT_LIST]:    { request: void;                    response: Project[] }
  [IPC_CHANNELS.PROJECT_GET]:     { request: string;                  response: Project | null }
  [IPC_CHANNELS.PROJECT_CREATE]:  { request: CreateProjectDTO;        response: Project }
  [IPC_CHANNELS.PROJECT_UPDATE]:  { request: { id: string; data: UpdateProjectDTO }; response: Project }
  [IPC_CHANNELS.PROJECT_DELETE]:  { request: string;                  response: void }
  [IPC_CHANNELS.PROJECT_ARCHIVE]: { request: string;                  response: Project }

  [IPC_CHANNELS.PROGRESS_LIST]:   { request: string;                  response: ProgressItem[] }
  [IPC_CHANNELS.PROGRESS_CREATE]: { request: CreateProgressDTO;       response: ProgressItem }
  [IPC_CHANNELS.PROGRESS_UPDATE]: { request: { id: string; data: UpdateProgressDTO }; response: ProgressItem }
  [IPC_CHANNELS.PROGRESS_DELETE]: { request: string;                  response: void }
  [IPC_CHANNELS.PROGRESS_REORDER]:{ request: { projectId: string; itemIds: string[] }; response: void }

  [IPC_CHANNELS.FILE_READ]:       { request: { projectId: string; filePath: string }; response: string }
  [IPC_CHANNELS.FILE_WRITE]:      { request: { projectId: string; filePath: string; content: string }; response: void }
  [IPC_CHANNELS.FILE_LIST]:       { request: string;                  response: string[] }
  [IPC_CHANNELS.FILE_DELETE]:     { request: { projectId: string; filePath: string }; response: void }
  [IPC_CHANNELS.FILE_CREATE]:     { request: { projectId: string; filePath: string; content?: string }; response: void }

  [IPC_CHANNELS.SETTINGS_GET]:    { request: string;                  response: string | null }
  [IPC_CHANNELS.SETTINGS_SET]:    { request: { key: string; value: string }; response: void }
  [IPC_CHANNELS.SETTINGS_GET_ALL]:{ request: void;                    response: Record<string, string> }
}
```

- [ ] **Step 5: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add shared TypeScript types for project, progress, IPC, and errors"
```

---

### Task 3: Database Layer

**Files:**
- Create: `src/main/utils/paths.ts`, `src/main/db/connection.ts`, `src/main/db/migrations/001-init.sql`, `src/main/db/repositories/project.repo.ts`, `src/main/db/repositories/progress.repo.ts`, `src/main/db/repositories/settings.repo.ts`

**Interfaces:**
- Produces: `getConnection()` (returns `Database`), `ProjectRepo`, `ProgressRepo`, `SettingsRepo` with methods listed below

- [ ] **Step 1: Create src/main/utils/paths.ts**

```typescript
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
```

- [ ] **Step 2: Create src/main/db/migrations/001-init.sql**

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS progress (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'todo',
  priority TEXT DEFAULT 'medium',
  notes TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  estimated_hours REAL,
  actual_hours REAL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 3: Create src/main/db/connection.ts**

```typescript
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
  const fs = require('fs')
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
```

- [ ] **Step 4: Create src/main/db/repositories/project.repo.ts**

```typescript
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
```

- [ ] **Step 5: Create src/main/db/repositories/progress.repo.ts**

```typescript
import { v4 as uuid } from 'uuid'
import { getConnection } from '../connection'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO } from '../../../renderer/types/progress'
import { AppError } from '../../../renderer/types/errors'

interface ProgressRow {
  id: string
  project_id: string
  title: string
  status: string
  priority: string
  notes: string
  tags: string
  estimated_hours: number | null
  actual_hours: number | null
  created_at: string
  updated_at: string
}

function rowToItem(row: ProgressRow): ProgressItem {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status as ProgressItem['status'],
    priority: row.priority as ProgressItem['priority'],
    notes: row.notes,
    tags: JSON.parse(row.tags || '[]'),
    estimatedHours: row.estimated_hours,
    actualHours: row.actual_hours,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class ProgressRepo {
  listByProject(projectId: string): ProgressItem[] {
    const db = getConnection()
    const rows = db.prepare(
      'SELECT * FROM progress WHERE project_id = ? ORDER BY created_at ASC'
    ).all(projectId) as ProgressRow[]
    return rows.map(rowToItem)
  }

  create(dto: CreateProgressDTO): ProgressItem {
    const db = getConnection()
    const id = uuid()
    const now = new Date().toISOString()

    const tags = JSON.stringify(dto.tags ?? [])
    const status = dto.status ?? 'todo'
    const priority = dto.priority ?? 'medium'
    const notes = dto.notes ?? ''
    const estimatedHours = dto.estimatedHours ?? null

    db.prepare(
      `INSERT INTO progress (id, project_id, title, status, priority, notes, tags, estimated_hours, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, dto.projectId, dto.title, status, priority, notes, tags, estimatedHours, now, now)

    return this.getById(id)!
  }

  getById(id: string): ProgressItem | null {
    const db = getConnection()
    const row = db.prepare('SELECT * FROM progress WHERE id = ?').get(id) as ProgressRow | undefined
    return row ? rowToItem(row) : null
  }

  update(id: string, dto: UpdateProgressDTO): ProgressItem {
    const db = getConnection()
    const existing = this.getById(id)
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', '进度条目不存在')
    }

    const now = new Date().toISOString()
    const tags = dto.tags !== undefined ? JSON.stringify(dto.tags) : undefined

    const fields: string[] = []
    const values: any[] = []

    if (dto.title !== undefined) { fields.push('title = ?'); values.push(dto.title) }
    if (dto.status !== undefined) { fields.push('status = ?'); values.push(dto.status) }
    if (dto.priority !== undefined) { fields.push('priority = ?'); values.push(dto.priority) }
    if (dto.notes !== undefined) { fields.push('notes = ?'); values.push(dto.notes) }
    if (tags !== undefined) { fields.push('tags = ?'); values.push(tags) }
    if (dto.estimatedHours !== undefined) { fields.push('estimated_hours = ?'); values.push(dto.estimatedHours) }
    if (dto.actualHours !== undefined) { fields.push('actual_hours = ?'); values.push(dto.actualHours) }

    if (fields.length > 0) {
      fields.push('updated_at = ?')
      values.push(now)
      values.push(id)
      db.prepare(`UPDATE progress SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }

    return this.getById(id)!
  }

  delete(id: string): void {
    const db = getConnection()
    const existing = this.getById(id)
    if (!existing) {
      throw new AppError('PROJECT_NOT_FOUND', '进度条目不存在')
    }
    db.prepare('DELETE FROM progress WHERE id = ?').run(id)
  }
}

export const progressRepo = new ProgressRepo()
```

- [ ] **Step 6: Create src/main/db/repositories/settings.repo.ts**

```typescript
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
```

- [ ] **Step 7: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add SQLite database layer with migrations and repositories"
```

---

### Task 4: IPC Infrastructure + Handlers

**Files:**
- Create: `src/main/ipc/index.ts`, `src/main/ipc/project.ipc.ts`, `src/main/ipc/progress.ipc.ts`, `src/main/ipc/file.ipc.ts`, `src/main/ipc/settings.ipc.ts`
- Modify: `src/main/index.ts` (register IPC handlers after window creation)

**Interfaces:**
- Consumes: `projectRepo`, `progressRepo`, `settingsRepo` from Task 3
- Produces: `registerAllIpcHandlers()` called from `main/index.ts`

- [ ] **Step 1: Create src/main/ipc/index.ts**

```typescript
import { ipcMain, IpcMainInvokeEvent } from 'electron'
import type { IpcResult } from '../../renderer/types/errors'
import { AppError } from '../../renderer/types/errors'

type IpcHandlerFn = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any>

export function wrapHandler(fn: IpcHandlerFn): IpcHandlerFn {
  return async (event: IpcMainInvokeEvent, ...args: any[]) => {
    try {
      const data = await fn(event, ...args)
      return { ok: true, data } as IpcResult<typeof data>
    } catch (err) {
      if (err instanceof AppError) {
        return {
          ok: false,
          error: { code: err.code, message: err.message, detail: err.detail }
        } as IpcResult<never>
      }
      console.error('Unhandled IPC error:', err)
      return {
        ok: false,
        error: { code: 'INTERNAL', message: '内部错误，请查看日志' }
      } as IpcResult<never>
    }
  }
}

export function registerAllIpcHandlers(): void {
  // Import and register each domain's handlers
  const { registerProjectHandlers } = require('./project.ipc')
  const { registerProgressHandlers } = require('./progress.ipc')
  const { registerFileHandlers } = require('./file.ipc')
  const { registerSettingsHandlers } = require('./settings.ipc')

  registerProjectHandlers()
  registerProgressHandlers()
  registerFileHandlers()
  registerSettingsHandlers()
}
```

- [ ] **Step 2: Create src/main/ipc/project.ipc.ts**

```typescript
import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { projectRepo } from '../db/repositories/project.repo'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { CreateProjectDTO, UpdateProjectDTO } from '../../renderer/types/project'

export function registerProjectHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, wrapHandler(async () => {
    return projectRepo.list()
  }))

  ipcMain.handle(IPC_CHANNELS.PROJECT_GET, wrapHandler(async (_event, id: string) => {
    return projectRepo.getById(id)
  }))

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, wrapHandler(async (_event, dto: CreateProjectDTO) => {
    return projectRepo.create(dto)
  }))

  ipcMain.handle(IPC_CHANNELS.PROJECT_UPDATE, wrapHandler(async (_event, params: { id: string; data: UpdateProjectDTO }) => {
    return projectRepo.update(params.id, params.data)
  }))

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, wrapHandler(async (_event, id: string) => {
    return projectRepo.delete(id)
  }))

  ipcMain.handle(IPC_CHANNELS.PROJECT_ARCHIVE, wrapHandler(async (_event, id: string) => {
    return projectRepo.archive(id)
  }))
}
```

- [ ] **Step 3: Create src/main/ipc/progress.ipc.ts**

```typescript
import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { progressRepo } from '../db/repositories/progress.repo'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { CreateProgressDTO, UpdateProgressDTO } from '../../renderer/types/progress'

export function registerProgressHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PROGRESS_LIST, wrapHandler(async (_event, projectId: string) => {
    return progressRepo.listByProject(projectId)
  }))

  ipcMain.handle(IPC_CHANNELS.PROGRESS_CREATE, wrapHandler(async (_event, dto: CreateProgressDTO) => {
    return progressRepo.create(dto)
  }))

  ipcMain.handle(IPC_CHANNELS.PROGRESS_UPDATE, wrapHandler(async (_event, params: { id: string; data: UpdateProgressDTO }) => {
    return progressRepo.update(params.id, params.data)
  }))

  ipcMain.handle(IPC_CHANNELS.PROGRESS_DELETE, wrapHandler(async (_event, id: string) => {
    return progressRepo.delete(id)
  }))
}
```

- [ ] **Step 4: Create src/main/ipc/file.ipc.ts**

```typescript
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
```

- [ ] **Step 5: Create src/main/ipc/settings.ipc.ts**

```typescript
import { ipcMain } from 'electron'
import { wrapHandler } from './index'
import { settingsRepo } from '../db/repositories/settings.repo'
import { IPC_CHANNELS } from '../../renderer/types/ipc'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, wrapHandler(async (_event, key: string) => {
    return settingsRepo.get(key)
  }))

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, wrapHandler(async (_event, params: { key: string; value: string }) => {
    return settingsRepo.set(params.key, params.value)
  }))

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, wrapHandler(async () => {
    return settingsRepo.getAll()
  }))
}
```

- [ ] **Step 6: Update src/main/index.ts to register handlers**

Open `src/main/index.ts` and add after `createWindow()` call inside `app.whenReady()`:

```typescript
import { registerAllIpcHandlers } from './ipc'

// Inside app.whenReady().then(() => { ... }), add after createWindow():
app.whenReady().then(() => {
  registerAllIpcHandlers()
  createWindow()
  // ... rest
})
```

The updated `src/main/index.ts`:

```typescript
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerAllIpcHandlers } from './ipc'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'zzwork',
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerAllIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
```

- [ ] **Step 7: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add IPC handlers with wrapHandler error boundary for project, progress, file, and settings"
```

---

### Task 5: Preload API Layer

**Files:**
- Create: `src/preload/api/project.api.ts`, `src/preload/api/progress.api.ts`, `src/preload/api/file.api.ts`, `src/preload/api/settings.api.ts`
- Modify: `src/preload/index.ts` (expose full API)
- Create: `src/renderer/env.d.ts` (type declarations for `window.api`)

**Interfaces:**
- Consumes: IPC_CHANNELS from Task 2
- Produces: `window.api` with typed methods for each domain

- [ ] **Step 1: Create src/preload/api/project.api.ts**

```typescript
import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { Project, CreateProjectDTO, UpdateProjectDTO } from '../../renderer/types/project'
import type { IpcResult } from '../../renderer/types/errors'

export const projectApi = {
  list: (): Promise<IpcResult<Project[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),

  get: (id: string): Promise<IpcResult<Project | null>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_GET, id),

  create: (dto: CreateProjectDTO): Promise<IpcResult<Project>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, dto),

  update: (id: string, data: UpdateProjectDTO): Promise<IpcResult<Project>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE, { id, data }),

  delete: (id: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, id),

  archive: (id: string): Promise<IpcResult<Project>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_ARCHIVE, id),
}
```

- [ ] **Step 2: Create src/preload/api/progress.api.ts**

```typescript
import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO } from '../../renderer/types/progress'
import type { IpcResult } from '../../renderer/types/errors'

export const progressApi = {
  list: (projectId: string): Promise<IpcResult<ProgressItem[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROGRESS_LIST, projectId),

  create: (dto: CreateProgressDTO): Promise<IpcResult<ProgressItem>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROGRESS_CREATE, dto),

  update: (id: string, data: UpdateProgressDTO): Promise<IpcResult<ProgressItem>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROGRESS_UPDATE, { id, data }),

  delete: (id: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROGRESS_DELETE, id),
}
```

- [ ] **Step 3: Create src/preload/api/file.api.ts**

```typescript
import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { IpcResult } from '../../renderer/types/errors'

interface FileReadParams { projectId: string; filePath: string }
interface FileWriteParams { projectId: string; filePath: string; content: string }
interface FileCreateParams { projectId: string; filePath: string; content?: string }
interface FileDeleteParams { projectId: string; filePath: string }

export const fileApi = {
  read: (params: FileReadParams): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, params),

  write: (params: FileWriteParams): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE, params),

  list: (projectId: string): Promise<IpcResult<string[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST, projectId),

  delete: (params: FileDeleteParams): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, params),

  create: (params: FileCreateParams): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_CREATE, params),
}
```

- [ ] **Step 4: Create src/preload/api/settings.api.ts**

```typescript
import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../../renderer/types/ipc'
import type { IpcResult } from '../../renderer/types/errors'

export const settingsApi = {
  get: (key: string): Promise<IpcResult<string | null>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key),

  set: (key: string, value: string): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, { key, value }),

  getAll: (): Promise<IpcResult<Record<string, string>>> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_ALL),
}
```

- [ ] **Step 5: Update src/preload/index.ts**

```typescript
import { contextBridge } from 'electron'
import { projectApi } from './api/project.api'
import { progressApi } from './api/progress.api'
import { fileApi } from './api/file.api'
import { settingsApi } from './api/settings.api'

contextBridge.exposeInMainWorld('api', {
  project: projectApi,
  progress: progressApi,
  file: fileApi,
  settings: settingsApi,
})
```

- [ ] **Step 6: Create src/renderer/env.d.ts**

```typescript
/// <reference types="vite/client" />

import type { IpcResult } from './types/errors'
import type { Project, CreateProjectDTO, UpdateProjectDTO } from './types/project'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO } from './types/progress'

interface FileParams {
  projectId: string
  filePath: string
  content?: string
}

interface WindowApi {
  project: {
    list: () => Promise<IpcResult<Project[]>>
    get: (id: string) => Promise<IpcResult<Project | null>>
    create: (dto: CreateProjectDTO) => Promise<IpcResult<Project>>
    update: (id: string, data: UpdateProjectDTO) => Promise<IpcResult<Project>>
    delete: (id: string) => Promise<IpcResult<void>>
    archive: (id: string) => Promise<IpcResult<Project>>
  }
  progress: {
    list: (projectId: string) => Promise<IpcResult<ProgressItem[]>>
    create: (dto: CreateProgressDTO) => Promise<IpcResult<ProgressItem>>
    update: (id: string, data: UpdateProgressDTO) => Promise<IpcResult<ProgressItem>>
    delete: (id: string) => Promise<IpcResult<void>>
  }
  file: {
    read: (params: { projectId: string; filePath: string }) => Promise<IpcResult<string>>
    write: (params: { projectId: string; filePath: string; content: string }) => Promise<IpcResult<void>>
    list: (projectId: string) => Promise<IpcResult<string[]>>
    delete: (params: { projectId: string; filePath: string }) => Promise<IpcResult<void>>
    create: (params: { projectId: string; filePath: string; content?: string }) => Promise<IpcResult<void>>
  }
  settings: {
    get: (key: string) => Promise<IpcResult<string | null>>
    set: (key: string, value: string) => Promise<IpcResult<void>>
    getAll: () => Promise<IpcResult<Record<string, string>>>
  }
}

declare global {
  interface Window {
    api: WindowApi
  }
}
```

- [ ] **Step 7: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add preload API layer with typed window.api exposure"
```

---

### Task 6: Zustand Stores

**Files:**
- Create: `src/renderer/stores/project.store.ts`, `src/renderer/stores/progress.store.ts`, `src/renderer/stores/editor.store.ts`, `src/renderer/stores/ui.store.ts`

**Interfaces:**
- Consumes: `window.api` from Task 5
- Produces: `useProjectStore`, `useProgressStore`, `useEditorStore`, `useUIStore` hooks

- [ ] **Step 1: Create src/renderer/stores/project.store.ts**

```typescript
import { create } from 'zustand'
import type { Project, CreateProjectDTO, UpdateProjectDTO } from '../types/project'

interface ProjectStore {
  projects: Project[]
  currentProjectId: string | null
  loading: boolean

  loadProjects: () => Promise<void>
  createProject: (dto: CreateProjectDTO) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  setCurrentProject: (id: string | null) => void
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProjectId: null,
  loading: false,

  loadProjects: async () => {
    set({ loading: true })
    const result = await window.api.project.list()
    if (result.ok) {
      set({ projects: result.data })
    }
    set({ loading: false })
  },

  createProject: async (dto) => {
    const result = await window.api.project.create(dto)
    if (result.ok) {
      await get().loadProjects()
      set({ currentProjectId: result.data.id })
    }
  },

  deleteProject: async (id) => {
    const result = await window.api.project.delete(id)
    if (result.ok) {
      const state = get()
      if (state.currentProjectId === id) {
        set({ currentProjectId: null })
      }
      await state.loadProjects()
    }
  },

  setCurrentProject: (id) => {
    set({ currentProjectId: id })
  }
}))
```

- [ ] **Step 2: Create src/renderer/stores/progress.store.ts**

```typescript
import { create } from 'zustand'
import type { ProgressItem, CreateProgressDTO, UpdateProgressDTO, ProgressStatus } from '../types/progress'

interface ProgressStore {
  items: ProgressItem[]
  filter: { status: ProgressStatus | 'all'; projectId: string | null }
  loading: boolean

  loadByProject: (projectId: string) => Promise<void>
  add: (dto: CreateProgressDTO) => Promise<void>
  update: (id: string, data: UpdateProgressDTO) => Promise<void>
  remove: (id: string) => Promise<void>
  setFilter: (filter: Partial<ProgressStore['filter']>) => void
}

export const useProgressStore = create<ProgressStore>((set, get) => ({
  items: [],
  filter: { status: 'all', projectId: null },
  loading: false,

  loadByProject: async (projectId) => {
    set({ loading: true, filter: { ...get().filter, projectId } })
    const result = await window.api.progress.list(projectId)
    if (result.ok) {
      set({ items: result.data })
    }
    set({ loading: false })
  },

  add: async (dto) => {
    const result = await window.api.progress.create(dto)
    if (result.ok) {
      const state = get()
      if (state.filter.projectId === dto.projectId) {
        await state.loadByProject(dto.projectId)
      }
    }
  },

  update: async (id, data) => {
    const result = await window.api.progress.update(id, data)
    if (result.ok) {
      const state = get()
      if (state.filter.projectId) {
        await state.loadByProject(state.filter.projectId)
      }
    }
  },

  remove: async (id) => {
    const result = await window.api.progress.delete(id)
    if (result.ok) {
      const state = get()
      if (state.filter.projectId) {
        await state.loadByProject(state.filter.projectId)
      }
    }
  },

  setFilter: (filter) => {
    set({ filter: { ...get().filter, ...filter } })
  }
}))
```

- [ ] **Step 3: Create src/renderer/stores/editor.store.ts**

```typescript
import { create } from 'zustand'

export interface Tab {
  id: string
  path: string
  title: string
  dirty: boolean
}

interface EditorStore {
  openTabs: Tab[]
  activeTabId: string | null
  fileContent: string

  openFile: (path: string, title: string, content: string) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  setFileContent: (content: string) => void
  markDirty: (id: string) => void
  markClean: (id: string) => void
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  openTabs: [],
  activeTabId: null,
  fileContent: '',

  openFile: (path, title, content) => {
    const state = get()
    const existing = state.openTabs.find((t) => t.path === path)
    if (existing) {
      set({ activeTabId: existing.id, fileContent: content })
      return
    }
    const tab: Tab = {
      id: `${path}-${Date.now()}`,
      path,
      title,
      dirty: false
    }
    set({
      openTabs: [...state.openTabs, tab],
      activeTabId: tab.id,
      fileContent: content
    })
  },

  closeTab: (id) => {
    const state = get()
    const idx = state.openTabs.findIndex((t) => t.id === id)
    const newTabs = state.openTabs.filter((t) => t.id !== id)
    let newActiveId = state.activeTabId
    if (state.activeTabId === id) {
      if (newTabs.length === 0) {
        newActiveId = null
      } else {
        const newIdx = Math.min(idx, newTabs.length - 1)
        newActiveId = newTabs[newIdx].id
      }
    }
    set({ openTabs: newTabs, activeTabId: newActiveId })
  },

  setActiveTab: (id) => {
    set({ activeTabId: id })
  },

  setFileContent: (content) => {
    set({ fileContent: content })
  },

  markDirty: (id) => {
    set({
      openTabs: get().openTabs.map((t) =>
        t.id === id ? { ...t, dirty: true } : t
      )
    })
  },

  markClean: (id) => {
    set({
      openTabs: get().openTabs.map((t) =>
        t.id === id ? { ...t, dirty: false } : t
      )
    })
  }
}))
```

- [ ] **Step 4: Create src/renderer/stores/ui.store.ts**

```typescript
import { create } from 'zustand'

interface UIStore {
  sidebarWidth: number
  aiPanelWidth: number
  aiPanelVisible: boolean
  theme: 'vs-dark' | 'light'

  resizeSidebar: (width: number) => void
  resizeAIPanel: (width: number) => void
  toggleAIPanel: () => void
  setTheme: (theme: 'vs-dark' | 'light') => void
}

const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 400
const AI_PANEL_MIN = 250
const AI_PANEL_MAX = 500

export const useUIStore = create<UIStore>((set) => ({
  sidebarWidth: parseInt(localStorage.getItem('sidebarWidth') || '280', 10),
  aiPanelWidth: parseInt(localStorage.getItem('aiPanelWidth') || '350', 10),
  aiPanelVisible: localStorage.getItem('aiPanelVisible') !== 'false',
  theme: 'vs-dark',

  resizeSidebar: (width) => {
    const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width))
    localStorage.setItem('sidebarWidth', String(clamped))
    set({ sidebarWidth: clamped })
  },

  resizeAIPanel: (width) => {
    const clamped = Math.min(AI_PANEL_MAX, Math.max(AI_PANEL_MIN, width))
    localStorage.setItem('aiPanelWidth', String(clamped))
    set({ aiPanelWidth: clamped })
  },

  toggleAIPanel: () => {
    set((s) => {
      const next = !s.aiPanelVisible
      localStorage.setItem('aiPanelVisible', String(next))
      return { aiPanelVisible: next }
    })
  },

  setTheme: (theme) => {
    set({ theme })
  }
}))
```

- [ ] **Step 5: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add Zustand stores for project, progress, editor, and UI state"
```

---

### Task 7: Ant Design Theme + Global Styles

**Files:**
- Create: `src/renderer/styles/theme.ts`, `src/renderer/styles/global.css`

**Produces:**
- VS Code dark theme via Ant Design ConfigProvider tokens
- Global CSS reset and layout utilities

- [ ] **Step 1: Create src/renderer/styles/theme.ts**

```typescript
import type { ThemeConfig } from 'antd'

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: '#007acc',
    colorBgBase: '#1e1e1e',
    colorBgContainer: '#252526',
    colorBgElevated: '#2d2d2d',
    colorBgLayout: '#1e1e1e',
    colorText: '#cccccc',
    colorTextSecondary: '#999999',
    colorBorder: '#3e3e3e',
    colorBorderSecondary: '#2d2d2d',
    borderRadius: 4,
    borderRadiusLG: 6,
    borderRadiusSM: 2,
    fontSize: 13,
    fontSizeLG: 14,
    fontSizeSM: 12,
    controlHeight: 28,
    controlHeightLG: 32,
    controlHeightSM: 24,
    lineHeight: 1.5,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    paddingContentHorizontal: 12,
    paddingContentVertical: 8,
    marginXS: 4,
    marginSM: 8,
    marginMD: 12,
    marginLG: 16,
    sizeXXS: 2,
    sizeXS: 4,
    sizeSM: 6,
    sizeMD: 8,
    sizeLG: 12,
  },
  components: {
    Tree: {
      directoryNodeSelectedBg: '#37373d',
      directoryNodeSelectedColor: '#ffffff',
      nodeSelectedBg: '#094771',
      nodeHoverBg: '#2a2d2e',
      colorBgContainer: 'transparent',
      colorText: '#cccccc',
      borderRadius: 0,
      controlHeightSM: 24,
    },
    Button: {
      primaryShadow: 'none',
      contentFontSizeSM: 12,
    },
    Modal: {
      contentBg: '#252526',
      headerBg: '#252526',
      titleColor: '#cccccc',
    },
    Input: {
      activeShadow: 'none',
      colorBgContainer: '#3c3c3c',
      colorBorder: '#3e3e3e',
      colorText: '#cccccc',
      colorTextPlaceholder: '#777777',
    },
    Tabs: {
      colorBgContainer: '#1e1e1e',
      itemColor: '#999999',
      itemHoverColor: '#cccccc',
      itemSelectedColor: '#ffffff',
    },
    Card: {
      colorBgContainer: '#2d2d2d',
    },
    Tag: {
      defaultBg: '#3c3c3c',
      defaultColor: '#cccccc',
    },
    Select: {
      colorBgContainer: '#3c3c3c',
      colorBorder: '#3e3e3e',
    },
  },
}
```

- [ ] **Step 2: Create src/renderer/styles/global.css**

```css
*, *::before, *::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #root {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #1e1e1e;
  color: #cccccc;
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Scrollbar styling (VS Code style) */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(121, 121, 121, 0.4);
  border-radius: 0;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(100, 100, 100, 0.7);
}
::-webkit-scrollbar-corner {
  background: transparent;
}

/* Ant Design overrides for VS Code feel */
.ant-tree {
  background: transparent !important;
}
.ant-tree-treenode {
  padding: 1px 0 !important;
}
.ant-tree-node-content-wrapper {
  padding: 0 4px !important;
}
.ant-modal-header {
  border-bottom: 1px solid #3e3e3e !important;
}
.ant-modal-footer {
  border-top: 1px solid #3e3e3e !important;
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add Ant Design VS Code dark theme tokens and global styles"
```

---

### Task 8: Three-Panel Layout Shell

**Files:**
- Create: `src/renderer/components/layout/AppShell.tsx`, `src/renderer/components/layout/Sidebar.tsx`, `src/renderer/components/layout/EditorArea.tsx`, `src/renderer/components/shared/ResizeHandle.tsx`

**Interfaces:**
- Consumes: `useUIStore` from Task 6
- Produces: Layout shell components used by App.tsx

- [ ] **Step 1: Create src/renderer/components/shared/ResizeHandle.tsx**

```tsx
import { useCallback, useEffect, useRef } from 'react'

interface ResizeHandleProps {
  position: 'left' | 'right'
  onResize: (delta: number) => void
}

export default function ResizeHandle({ position, onResize }: ResizeHandleProps): JSX.Element {
  const dragging = useRef(false)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      onResize(position === 'left' ? e.movementX : -e.movementX)
    }
    const onMouseUp = () => {
      dragging.current = false
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [position, onResize])

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        width: 4,
        cursor: 'col-resize',
        background: 'transparent',
        flexShrink: 0,
        zIndex: 10,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        (e.target as HTMLElement).style.background = 'rgba(0, 122, 204, 0.5)'
      }}
      onMouseLeave={(e) => {
        if (!dragging.current) {
          (e.target as HTMLElement).style.background = 'transparent'
        }
      }}
    />
  )
}
```

- [ ] **Step 2: Create src/renderer/components/layout/Sidebar.tsx**

```tsx
import { useUIStore } from '../../stores/ui.store'

interface SidebarProps {
  top: React.ReactNode
  bottom: React.ReactNode
}

export default function Sidebar({ top, bottom }: SidebarProps): JSX.Element {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth)

  return (
    <div
      style={{
        width: sidebarWidth,
        minWidth: 200,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#252526',
        borderRight: '1px solid #3e3e3e',
        flexShrink: 0,
      }}
    >
      <div style={{ flex: '0 0 auto', maxHeight: '50%', overflow: 'auto' }}>
        {top}
      </div>
      <div style={{
        flex: '1 1 auto',
        overflow: 'auto',
        borderTop: '2px solid #3e3e3e',
      }}>
        {bottom}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create src/renderer/components/layout/EditorArea.tsx**

```tsx
interface EditorAreaProps {
  tabs: React.ReactNode
  editor: React.ReactNode
}

export default function EditorArea({ tabs, editor }: EditorAreaProps): JSX.Element {
  return (
    <div
      style={{
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 300,
        overflow: 'hidden',
      }}
    >
      <div style={{ flex: '0 0 auto' }}>{tabs}</div>
      <div style={{ flex: '1 1 auto', overflow: 'auto' }}>{editor}</div>
    </div>
  )
}
```

- [ ] **Step 4: Create src/renderer/components/layout/AppShell.tsx**

```tsx
import { useUIStore } from '../../stores/ui.store'
import Sidebar from './Sidebar'
import EditorArea from './EditorArea'
import ResizeHandle from '../shared/ResizeHandle'

interface AppShellProps {
  projectTree: React.ReactNode
  progressPanel: React.ReactNode
  editorTabs: React.ReactNode
  editor: React.ReactNode
  aiPanel: React.ReactNode
  statusBar: React.ReactNode
}

export default function AppShell({
  projectTree,
  progressPanel,
  editorTabs,
  editor,
  aiPanel,
  statusBar,
}: AppShellProps): JSX.Element {
  const aiPanelVisible = useUIStore((s) => s.aiPanelVisible)
  const aiPanelWidth = useUIStore((s) => s.aiPanelWidth)
  const resizeSidebar = useUIStore((s) => s.resizeSidebar)
  const resizeAIPanel = useUIStore((s) => s.resizeAIPanel)

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#1e1e1e',
    }}>
      {/* Main content area */}
      <div style={{
        flex: '1 1 auto',
        display: 'flex',
        overflow: 'hidden',
      }}>
        {/* Left sidebar */}
        <Sidebar top={projectTree} bottom={progressPanel} />
        <ResizeHandle position="left" onResize={resizeSidebar} />

        {/* Editor area */}
        <EditorArea tabs={editorTabs} editor={editor} />

        {/* Right AI panel (collapsible) */}
        {aiPanelVisible && (
          <>
            <ResizeHandle position="right" onResize={resizeAIPanel} />
            <div
              style={{
                width: aiPanelWidth,
                minWidth: 250,
                height: '100%',
                backgroundColor: '#252526',
                borderLeft: '1px solid #3e3e3e',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {aiPanel}
            </div>
          </>
        )}
      </div>

      {/* Status bar */}
      <div style={{
        flex: '0 0 auto',
        height: 24,
        borderTop: '1px solid #3e3e3e',
      }}>
        {statusBar}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add three-panel AppShell layout with resizable sidebars"
```

---

### Task 9: Project Management UI

**Files:**
- Create: `src/renderer/components/project/ProjectTree.tsx`, `src/renderer/components/project/ProjectCreateModal.tsx`

**Interfaces:**
- Consumes: `useProjectStore` from Task 6
- Produces: Project management React components

- [ ] **Step 1: Create src/renderer/components/project/ProjectTree.tsx**

```tsx
import { useEffect, useState } from 'react'
import { Tree, Dropdown, message } from 'antd'
import {
  FolderOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  DeleteOutlined,
  InboxOutlined,
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import { useProjectStore } from '../../stores/project.store'
import { useProgressStore } from '../../stores/progress.store'
import ProjectCreateModal from './ProjectCreateModal'

export default function ProjectTree(): JSX.Element {
  const { projects, currentProjectId, loadProjects, setCurrentProject, deleteProject } =
    useProjectStore()
  const loadByProject = useProgressStore((s) => s.loadByProject)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  const handleSelect = (selectedKeys: React.Key[]) => {
    const id = selectedKeys[0] as string | undefined
    if (id) {
      setCurrentProject(id)
      loadByProject(id)
    }
  }

  const contextMenuItems: MenuProps['items'] = [
    { key: 'delete', label: '删除项目', icon: <DeleteOutlined />, danger: true },
  ]

  const treeData = projects
    .filter((p) => p.status === 'active')
    .map((p) => ({
      key: p.id,
      title: (
        <Dropdown menu={{
          items: contextMenuItems,
          onClick: async ({ key }) => {
            if (key === 'delete') {
              await deleteProject(p.id)
              message.success(`已删除项目 "${p.name}"`)
            }
          }
        }} trigger={['contextMenu']}>
          <span style={{ fontSize: 13 }}>{p.name}</span>
        </Dropdown>
      ),
      icon: currentProjectId === p.id
        ? <FolderOpenOutlined style={{ color: '#dcb67a' }} />
        : <FolderOutlined style={{ color: '#dcb67a' }} />,
      isLeaf: true,
    }))

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px 8px',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: '#999',
        }}>
          项目
        </span>
        <PlusOutlined
          style={{ cursor: 'pointer', color: '#999', fontSize: 14 }}
          onClick={() => setModalOpen(true)}
        />
      </div>

      {treeData.length === 0 ? (
        <div style={{
          padding: '16px 12px',
          color: '#666',
          fontSize: 12,
          textAlign: 'center',
        }}>
          <InboxOutlined style={{ fontSize: 20, marginBottom: 8, display: 'block' }} />
          暂无项目，点击 + 创建
        </div>
      ) : (
        <Tree
          showIcon
          treeData={treeData}
          selectedKeys={currentProjectId ? [currentProjectId] : []}
          onSelect={handleSelect}
          blockNode
          style={{ padding: '0 4px' }}
        />
      )}

      <ProjectCreateModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </div>
  )
}
```

- [ ] **Step 2: Create src/renderer/components/project/ProjectCreateModal.tsx**

```tsx
import { useState } from 'react'
import { Modal, Input, message } from 'antd'
import { useProjectStore } from '../../stores/project.store'

interface Props {
  open: boolean
  onClose: () => void
}

export default function ProjectCreateModal({ open, onClose }: Props): JSX.Element {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const createProject = useProjectStore((s) => s.createProject)

  const handleOk = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      message.warning('请输入项目名称')
      return
    }
    setLoading(true)
    try {
      await createProject({ name: trimmed })
      message.success(`项目 "${trimmed}" 创建成功`)
      setName('')
      onClose()
    } catch {
      // Error handled by IPC layer
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    setName('')
    onClose()
  }

  return (
    <Modal
      title="创建新项目"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={loading}
      okText="创建"
      cancelText="取消"
      destroyOnClose
    >
      <Input
        placeholder="输入项目名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onPressEnter={handleOk}
        autoFocus
        style={{ marginTop: 8 }}
      />
    </Modal>
  )
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add ProjectTree with context menu and ProjectCreateModal"
```

---

### Task 10: Monaco Editor Integration

**Files:**
- Create: `src/renderer/components/editor/EditorTabs.tsx`, `src/renderer/components/editor/MonacoEditor.tsx`

**Interfaces:**
- Consumes: `useEditorStore` from Task 6

- [ ] **Step 1: Create src/renderer/components/editor/EditorTabs.tsx**

```tsx
import { useEditorStore } from '../../stores/editor.store'
import { CloseOutlined } from '@ant-design/icons'

export default function EditorTabs(): JSX.Element {
  const { openTabs, activeTabId, setActiveTab, closeTab } = useEditorStore()

  if (openTabs.length === 0) {
    return (
      <div style={{
        height: 36,
        backgroundColor: '#1e1e1e',
        borderBottom: '1px solid #3e3e3e',
      }} />
    )
  }

  return (
    <div style={{
      display: 'flex',
      height: 36,
      backgroundColor: '#252526',
      borderBottom: '1px solid #3e3e3e',
      overflowX: 'auto',
      overflowY: 'hidden',
    }}>
      {openTabs.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 12px',
              height: '100%',
              cursor: 'pointer',
              fontSize: 13,
              color: isActive ? '#ffffff' : '#999999',
              backgroundColor: isActive ? '#1e1e1e' : '#2d2d2d',
              borderRight: '1px solid #3e3e3e',
              borderTop: isActive ? '1px solid #007acc' : '1px solid transparent',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            <span>{tab.dirty ? '●' : ''} {tab.title}</span>
            <CloseOutlined
              style={{ fontSize: 10, color: '#999' }}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Create src/renderer/components/editor/MonacoEditor.tsx**

```tsx
import { useCallback } from 'react'
import Editor, { type OnChange, type OnMount } from '@monaco-editor/react'
import { useEditorStore } from '../../stores/editor.store'
import type { editor } from 'monaco-editor'

export default function MonacoEditorWrapper(): JSX.Element {
  const { fileContent, setFileContent, markDirty, activeTabId, openTabs } = useEditorStore()
  const activeTab = openTabs.find((t) => t.id === activeTabId)

  const handleChange: OnChange = useCallback((value) => {
    if (value !== undefined) {
      setFileContent(value)
      if (activeTabId) {
        markDirty(activeTabId)
      }
    }
  }, [setFileContent, markDirty, activeTabId])

  const handleMount: OnMount = useCallback((editor: editor.IStandaloneCodeEditor) => {
    // Auto-focus the editor
    editor.focus()
  }, [])

  if (!activeTab) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#666',
        fontSize: 14,
        userSelect: 'none',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>📝</div>
          <div>选择一个文件开始编辑</div>
          <div style={{ fontSize: 12, marginTop: 8, color: '#555' }}>
            Ctrl+O 打开文件
          </div>
        </div>
      </div>
    )
  }

  return (
    <Editor
      height="100%"
      defaultLanguage="markdown"
      language={getLanguage(activeTab.path)}
      value={fileContent}
      onChange={handleChange}
      onMount={handleMount}
      theme="vs-dark"
      options={{
        fontSize: 14,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
        lineNumbers: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        padding: { top: 16 },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        bracketPairColorization: { enabled: true },
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: 'selection',
      }}
    />
  )
}

function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    md: 'markdown',
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    sql: 'sql',
    css: 'css',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'shell',
  }
  return map[ext ?? ''] ?? 'plaintext'
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add Monaco Editor with tab management and language detection"
```

---

### Task 11: Progress Management UI

**Files:**
- Create: `src/renderer/components/progress/ProgressPanel.tsx`, `src/renderer/components/progress/ProgressKanban.tsx`, `src/renderer/components/progress/ProgressFormModal.tsx`

**Interfaces:**
- Consumes: `useProgressStore` from Task 6, `useProjectStore` from Task 6

- [ ] **Step 1: Create src/renderer/components/progress/ProgressFormModal.tsx**

```tsx
import { useState, useEffect } from 'react'
import { Modal, Input, Select, InputNumber } from 'antd'
import type { ProgressStatus, ProgressPriority, CreateProgressDTO, UpdateProgressDTO } from '../../types/progress'

const { TextArea } = Input

interface CreateProps {
  open: boolean
  projectId: string
  onClose: () => void
  onSubmit: (dto: CreateProgressDTO) => Promise<void>
}

interface EditProps {
  open: boolean
  initialData: {
    id: string
    title: string
    status: ProgressStatus
    priority: ProgressPriority
    notes: string
    estimatedHours: number | null
  }
  onClose: () => void
  onSubmit: (id: string, dto: UpdateProgressDTO) => Promise<void>
}

type Props = CreateProps | EditProps

export default function ProgressFormModal(props: Props): JSX.Element {
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<ProgressStatus>('todo')
  const [priority, setPriority] = useState<ProgressPriority>('medium')
  const [notes, setNotes] = useState('')
  const [estimatedHours, setEstimatedHours] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const isEdit = 'initialData' in props

  useEffect(() => {
    if (props.open) {
      if (isEdit) {
        setTitle(props.initialData.title)
        setStatus(props.initialData.status)
        setPriority(props.initialData.priority)
        setNotes(props.initialData.notes)
        setEstimatedHours(props.initialData.estimatedHours)
      } else {
        setTitle('')
        setStatus('todo')
        setPriority('medium')
        setNotes('')
        setEstimatedHours(null)
      }
    }
  }, [props.open])

  const handleOk = async () => {
    const trimmed = title.trim()
    if (!trimmed) return
    setLoading(true)
    try {
      if (isEdit) {
        await props.onSubmit(props.initialData.id, {
          title: trimmed,
          status,
          priority,
          notes,
          estimatedHours: estimatedHours ?? undefined,
        })
      } else {
        await props.onSubmit({
          projectId: props.projectId,
          title: trimmed,
          status,
          priority,
          notes,
          estimatedHours: estimatedHours ?? undefined,
        })
      }
      props.onClose()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={isEdit ? '编辑进度' : '添加进度'}
      open={props.open}
      onOk={handleOk}
      onCancel={props.onClose}
      confirmLoading={loading}
      okText={isEdit ? '保存' : '添加'}
      cancelText="取消"
      destroyOnClose
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
        <Input
          placeholder="任务标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onPressEnter={handleOk}
          autoFocus
        />

        <div style={{ display: 'flex', gap: 8 }}>
          <Select
            value={status}
            onChange={setStatus}
            style={{ flex: 1 }}
            options={[
              { value: 'todo', label: '📋 待开始' },
              { value: 'doing', label: '🔄 进行中' },
              { value: 'done', label: '✅ 已完成' },
              { value: 'blocked', label: '🚫 已阻塞' },
            ]}
          />
          <Select
            value={priority}
            onChange={setPriority}
            style={{ flex: 1 }}
            options={[
              { value: 'low', label: '低优先级' },
              { value: 'medium', label: '中优先级' },
              { value: 'high', label: '高优先级' },
            ]}
          />
        </div>

        <InputNumber
          placeholder="预估工时（小时）"
          value={estimatedHours}
          onChange={setEstimatedHours}
          min={0}
          step={0.5}
          style={{ width: '100%' }}
        />

        <TextArea
          placeholder="备注（可选）"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
      </div>
    </Modal>
  )
}
```

- [ ] **Step 2: Create src/renderer/components/progress/ProgressKanban.tsx**

```tsx
import { Card, Dropdown, Tag, Empty } from 'antd'
import { MoreOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import type { MenuProps } from 'antd'
import type { ProgressItem, ProgressStatus, UpdateProgressDTO } from '../../types/progress'

const COLUMNS: { status: ProgressStatus; title: string; color: string }[] = [
  { status: 'todo',     title: '待开始', color: '#6a6a6a' },
  { status: 'doing',    title: '进行中', color: '#007acc' },
  { status: 'done',     title: '已完成', color: '#4d9e4d' },
  { status: 'blocked',  title: '已阻塞', color: '#d16969' },
]

const PRIORITY_COLORS: Record<string, string> = {
  high: '#d16969',
  medium: '#d7ba7d',
  low: '#6a6a6a',
}

interface Props {
  items: ProgressItem[]
  onEdit: (item: ProgressItem) => void
  onDelete: (id: string) => void
  onStatusChange: (id: string, status: ProgressStatus) => void
}

export default function ProgressKanban({ items, onEdit, onDelete, onStatusChange }: Props): JSX.Element {
  return (
    <div style={{
      display: 'flex',
      gap: 8,
      padding: '0 8px 8px',
      overflow: 'auto',
    }}>
      {COLUMNS.map((col) => {
        const columnItems = items.filter((i) => i.status === col.status)
        return (
          <div
            key={col.status}
            style={{
              flex: '1 1 0',
              minWidth: 160,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              color: col.color,
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}>
              {col.title}
              <span style={{ color: '#666', fontWeight: 400 }}>
                {columnItems.length}
              </span>
            </div>

            {columnItems.length === 0 ? (
              <div style={{
                padding: 12,
                color: '#555',
                fontSize: 11,
                textAlign: 'center',
                border: '1px dashed #3e3e3e',
                borderRadius: 4,
              }}>
                拖拽或添加
              </div>
            ) : (
              columnItems.map((item) => {
                const menuItems: MenuProps['items'] = [
                  ...COLUMNS.filter((c) => c.status !== item.status).map((c) => ({
                    key: `move-${c.status}`,
                    label: `移动到 ${c.title}`,
                    onClick: () => onStatusChange(item.id, c.status),
                  })),
                  { type: 'divider' as const },
                  {
                    key: 'edit',
                    label: '编辑',
                    icon: <EditOutlined />,
                    onClick: () => onEdit(item),
                  },
                  {
                    key: 'delete',
                    label: '删除',
                    icon: <DeleteOutlined />,
                    danger: true,
                    onClick: () => onDelete(item.id),
                  },
                ]

                return (
                  <Card
                    key={item.id}
                    size="small"
                    styles={{ body: { padding: '8px 12px' } }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 13,
                          color: '#cccccc',
                          wordBreak: 'break-word',
                          marginBottom: 6,
                        }}>
                          {item.title}
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {item.priority && (
                            <Tag
                              color={PRIORITY_COLORS[item.priority]}
                              style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}
                            >
                              {item.priority === 'high' ? '高' : item.priority === 'medium' ? '中' : '低'}
                            </Tag>
                          )}
                          {item.estimatedHours != null && (
                            <Tag style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>
                              {item.estimatedHours}h
                            </Tag>
                          )}
                        </div>
                      </div>
                      <Dropdown menu={{ items: menuItems }} trigger={['click']}>
                        <MoreOutlined style={{
                          color: '#666',
                          cursor: 'pointer',
                          padding: '2px 4px',
                          fontSize: 12,
                        }} />
                      </Dropdown>
                    </div>
                  </Card>
                )
              })
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 3: Create src/renderer/components/progress/ProgressPanel.tsx**

```tsx
import { useState } from 'react'
import { Button, Empty } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useProgressStore } from '../../stores/progress.store'
import { useProjectStore } from '../../stores/project.store'
import ProgressKanban from './ProgressKanban'
import ProgressFormModal from './ProgressFormModal'
import type { ProgressItem, ProgressStatus, CreateProgressDTO, UpdateProgressDTO } from '../../types/progress'

export default function ProgressPanel(): JSX.Element {
  const { items, add, update, remove, loadByProject } = useProgressStore()
  const currentProjectId = useProjectStore((s) => s.currentProjectId)

  const [modalOpen, setModalOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<ProgressItem | null>(null)

  const handleAdd = async (dto: CreateProgressDTO) => {
    await add(dto)
  }

  const handleEdit = async (_id: string, dto: UpdateProgressDTO) => {
    if (!editingItem) return
    await update(editingItem.id, dto)
    setEditingItem(null)
  }

  const handleDelete = async (id: string) => {
    await remove(id)
  }

  const handleStatusChange = async (id: string, status: ProgressStatus) => {
    await update(id, { status })
  }

  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px 8px',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: '#999',
        }}>
          进度 {items.length > 0 && `(${items.length})`}
        </span>
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          disabled={!currentProjectId}
          onClick={() => setModalOpen(true)}
          style={{ color: '#999', fontSize: 12 }}
        >
          添加
        </Button>
      </div>

      {!currentProjectId ? (
        <div style={{ padding: '16px 12px', color: '#666', fontSize: 12, textAlign: 'center' }}>
          请先选择一个项目
        </div>
      ) : items.length === 0 ? (
        <div style={{ padding: '16px 12px', color: '#666', fontSize: 12, textAlign: 'center' }}>
          暂无进度，点击添加
        </div>
      ) : (
        <ProgressKanban
          items={items}
          onEdit={(item) => { setEditingItem(item); setModalOpen(true) }}
          onDelete={handleDelete}
          onStatusChange={handleStatusChange}
        />
      )}

      {/* Create modal */}
      {!editingItem && currentProjectId && (
        <ProgressFormModal
          open={modalOpen}
          projectId={currentProjectId}
          onClose={() => setModalOpen(false)}
          onSubmit={handleAdd}
        />
      )}

      {/* Edit modal */}
      {editingItem && (
        <ProgressFormModal
          open={modalOpen}
          initialData={{
            id: editingItem.id,
            title: editingItem.title,
            status: editingItem.status,
            priority: editingItem.priority,
            notes: editingItem.notes,
            estimatedHours: editingItem.estimatedHours,
          }}
          onClose={() => { setModalOpen(false); setEditingItem(null) }}
          onSubmit={handleEdit}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add progress management UI with kanban board and create/edit modal"
```

---

### Task 12: Status Bar

**Files:**
- Create: `src/renderer/components/layout/StatusBar.tsx`

**Interfaces:**
- Consumes: `useProjectStore` from Task 6, `useProgressStore` from Task 6, `useEditorStore` from Task 6

- [ ] **Step 1: Create src/renderer/components/layout/StatusBar.tsx**

```tsx
import { useProjectStore } from '../../stores/project.store'
import { useProgressStore } from '../../stores/progress.store'
import { useEditorStore } from '../../stores/editor.store'

export default function StatusBar(): JSX.Element {
  const currentProjectId = useProjectStore((s) => s.currentProjectId)
  const projects = useProjectStore((s) => s.projects)
  const items = useProgressStore((s) => s.items)
  const activeTabId = useEditorStore((s) => s.activeTabId)

  const currentProject = projects.find((p) => p.id === currentProjectId)
  const doneCount = items.filter((i) => i.status === 'done').length
  const progressPct = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0
  const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{
      height: 24,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 12px',
      fontSize: 12,
      color: '#999',
      backgroundColor: '#007acc',
      color: '#ffffff',
      userSelect: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span>
          {currentProject ? `📁 ${currentProject.name}` : '未选择项目'}
        </span>
        {currentProject && items.length > 0 && (
          <span>进度 {doneCount}/{items.length} ({progressPct}%)</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {activeTabId && <span>📝 编辑中</span>}
        <span>{now}</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add status bar with project info, progress stats, and time"
```

---

### Task 13: AI Panel Placeholder

**Files:**
- Create: `src/renderer/components/layout/AIPanel.tsx`

**Produces:**
- Collapsible AI panel placeholder for Phase 2

- [ ] **Step 1: Create src/renderer/components/layout/AIPanel.tsx**

```tsx
import { useUIStore } from '../../stores/ui.store'
import { CloseOutlined, RobotOutlined } from '@ant-design/icons'
import { Button } from 'antd'

export default function AIPanel(): JSX.Element {
  const toggleAIPanel = useUIStore((s) => s.toggleAIPanel)

  return (
    <>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 12px',
        borderBottom: '1px solid #3e3e3e',
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: '#999',
        }}>
          🤖 AI 助手
        </span>
        <Button
          type="text"
          size="small"
          icon={<CloseOutlined />}
          onClick={toggleAIPanel}
          style={{ color: '#999' }}
        />
      </div>

      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#555',
        padding: 24,
        textAlign: 'center',
      }}>
        <RobotOutlined style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }} />
        <div style={{ fontSize: 14, marginBottom: 8 }}>AI 助手</div>
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          Phase 2 将集成 Claude Agent<br />
          支持进度分析、周报生成、需求评审
        </div>
      </div>
    </>
  )
}
```

- [ ] **Step 2: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: add AI panel placeholder for Phase 2"
```

---

### Task 14: Wire Everything in App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: All layout and feature components from Tasks 8-13, theme from Task 7

- [ ] **Step 1: Update src/renderer/App.tsx**

```tsx
import { ConfigProvider } from 'antd'
import { antdTheme } from './styles/theme'
import './styles/global.css'

import AppShell from './components/layout/AppShell'
import StatusBar from './components/layout/StatusBar'
import AIPanel from './components/layout/AIPanel'
import ProjectTree from './components/project/ProjectTree'
import ProgressPanel from './components/progress/ProgressPanel'
import EditorTabs from './components/editor/EditorTabs'
import MonacoEditorWrapper from './components/editor/MonacoEditor'

export default function App(): JSX.Element {
  return (
    <ConfigProvider theme={antdTheme}>
      <AppShell
        projectTree={<ProjectTree />}
        progressPanel={<ProgressPanel />}
        editorTabs={<EditorTabs />}
        editor={<MonacoEditorWrapper />}
        aiPanel={<AIPanel />}
        statusBar={<StatusBar />}
      />
    </ConfigProvider>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/zuozuo/sf/zzwork && npx tsc --noEmit -p tsconfig.web.json 2>&1
```

Expected: No errors.

- [ ] **Step 3: Verify electron-vite builds**

```bash
cd /home/zuozuo/sf/zzwork && npx electron-vite build 2>&1
```

Expected: Build succeeds for main, preload, and renderer.

- [ ] **Step 4: Commit**

```bash
cd /home/zuozuo/sf/zzwork && git add -A && git commit -m "feat: wire all components in App.tsx with theme provider"
```

---

## Additional npm dependencies needed (not in Task 1)

After Task 1, install these as they're needed:

```bash
# Task 8-13: Ant Design icons (already included in Task 1 dependencies)
# Monaco Editor React wrapper (already included)
# @electron-toolkit/utils (used in main/index.ts for is.dev)
npm install @electron-toolkit/utils
```
