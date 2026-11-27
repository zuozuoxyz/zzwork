// zzwork 数据层：SQLite（组/任务/消息/设置），旧 projects 自动迁移
const path = require('path')
const fs = require('fs')
const os = require('os')
const { v4: uuid } = require('uuid')

// 会话落盘适配器（文件为权威）。注入后写入同步镜像到 .zzwork/sessions，读取仍走 DB 缓存
let fileStore = null
function setFileStore(adapter) { fileStore = adapter }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT DEFAULT '', brief TEXT DEFAULT '', brief_at TEXT DEFAULT '', created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, group_id TEXT, type TEXT DEFAULT 'work',
  status TEXT DEFAULT 'active', scope TEXT DEFAULT 'long', path TEXT NOT NULL, agent_id TEXT DEFAULT 'builtin', meta TEXT DEFAULT '{}',
  brief TEXT DEFAULT '', brief_at TEXT DEFAULT '', deleted_at TEXT DEFAULT '', created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, session_id TEXT DEFAULT '', kind TEXT DEFAULT 'text', run_id TEXT DEFAULT '',
  meta TEXT DEFAULT '{}', created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
  parent_session_id TEXT DEFAULT '', kind TEXT DEFAULT 'chat', title TEXT DEFAULT '',
  agent_id TEXT DEFAULT '', model_id TEXT DEFAULT '', summary TEXT DEFAULT '', meta TEXT DEFAULT '{}',
  created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT DEFAULT '',
  parent_run_id TEXT DEFAULT '', agent_id TEXT DEFAULT '', model_id TEXT DEFAULT '',
  status TEXT DEFAULT 'running', prompt TEXT DEFAULT '', result TEXT DEFAULT '', tokens INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0,
  error TEXT DEFAULT '', meta TEXT DEFAULT '{}', started_at TEXT, finished_at TEXT);
CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'openai_compatible',
  base_url TEXT NOT NULL, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'openai_compatible',
  base_url TEXT NOT NULL, model_id TEXT NOT NULL, is_default INTEGER DEFAULT 0, provider_id TEXT DEFAULT '', created_at TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT 'local',
  config TEXT DEFAULT '{}', created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, env_id TEXT NOT NULL, name TEXT NOT NULL,
  path TEXT NOT NULL, source TEXT DEFAULT 'user', description TEXT DEFAULT '', created_at TEXT, updated_at TEXT,
  UNIQUE(env_id, path));
CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, env_id TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT DEFAULT 'stdio', config TEXT DEFAULT '{}', source TEXT DEFAULT 'user', origin_path TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT, UNIQUE(env_id, name, origin_path));
CREATE TABLE IF NOT EXISTS task_skills (task_id TEXT NOT NULL, skill_id TEXT NOT NULL, excluded INTEGER DEFAULT 0,
  PRIMARY KEY(task_id, skill_id));
CREATE TABLE IF NOT EXISTS task_mcp (task_id TEXT NOT NULL, mcp_id TEXT NOT NULL, excluded INTEGER DEFAULT 0,
  PRIMARY KEY(task_id, mcp_id));
`

// 默认执行体：where=auto 表示跟随任务目录所在环境（本地/WSL/SSH）
const { KNOWN_AGENTS } = require('./agentRunner')
const DEFAULT_AGENTS = [
  { id: 'builtin', name: '内置模型聊天', kind: 'builtin', where: 'local', cmd: '' },
  ...KNOWN_AGENTS.map((a) => ({ id: a.id, name: a.name, kind: 'cli', where: 'auto', cmd: a.cmd })),
]

function now() { return new Date().toISOString() }

function providerName(type, baseUrl) {
  if (type === 'anthropic' || /anthropic/i.test(baseUrl || '')) return 'Anthropic'
  try { return new URL(baseUrl).host || 'OpenAI 兼容' } catch { return 'OpenAI 兼容' }
}

function appDataDir() {
  if (process.env.APPDATA) return process.env.APPDATA
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}

function openDb(log) {
  const primary = process.env.ZZWORK_DB_PATH
    || path.join(appDataDir(), 'zzwork', 'data', 'zzwork.db')
  const candidates = [primary, path.join(os.homedir(), '.zzwork-vscode', 'zzwork.db')]
  for (const p of candidates) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const Database = require('better-sqlite3')
      const db = new Database(p)
      db.pragma('journal_mode = WAL')
      db.exec(SCHEMA)
      migrate(db, log)
      log && log(`[zzwork] SQLite 已连接: ${p}`)
      return { kind: 'sqlite', db, path: p }
    } catch (e) {
      log && log(`[zzwork] SQLite 不可用(${e.message.slice(0, 80)})`)
    }
  }
  const jp = primary.replace(/\.db$/, '.json')
  fs.mkdirSync(path.dirname(jp), { recursive: true })
  const data = fs.existsSync(jp) ? JSON.parse(fs.readFileSync(jp, 'utf8'))
    : { groups: [], tasks: [], messages: [], models: [], providers: [], settings: {} }
  if (!data.providers) data.providers = []
  if (!data.sessions) data.sessions = []
  if (!data.runs) data.runs = []
  return { kind: 'json', data, path: jp }
}

// 旧 projects → tasks（只跑一次，旧表保留不动）
function migrate(db, log) {
  // tasks 增加 model_id（幂等）
  try {
    const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name)
    if (!cols.includes('model_id')) db.exec("ALTER TABLE tasks ADD COLUMN model_id TEXT DEFAULT ''")
    if (!cols.includes('brief')) db.exec("ALTER TABLE tasks ADD COLUMN brief TEXT DEFAULT ''")
    if (!cols.includes('brief_at')) db.exec("ALTER TABLE tasks ADD COLUMN brief_at TEXT DEFAULT ''")
    if (!cols.includes('deleted_at')) db.exec("ALTER TABLE tasks ADD COLUMN deleted_at TEXT DEFAULT ''")
    if (!cols.includes('scope')) db.exec("ALTER TABLE tasks ADD COLUMN scope TEXT DEFAULT 'long'")
  } catch {}
  // groups 增加 parent_id（幂等）：支持子组嵌套
  try {
    const cols = db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name)
    if (!cols.includes('parent_id')) db.exec("ALTER TABLE groups ADD COLUMN parent_id TEXT DEFAULT ''")
    if (!cols.includes('brief')) db.exec("ALTER TABLE groups ADD COLUMN brief TEXT DEFAULT ''")
    if (!cols.includes('brief_at')) db.exec("ALTER TABLE groups ADD COLUMN brief_at TEXT DEFAULT ''")
  } catch {}
  // messages 增加会话/类型/运行元数据（幂等）
  try {
    const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name)
    if (!cols.includes('session_id')) db.exec("ALTER TABLE messages ADD COLUMN session_id TEXT DEFAULT ''")
    if (!cols.includes('kind')) db.exec("ALTER TABLE messages ADD COLUMN kind TEXT DEFAULT 'text'")
    if (!cols.includes('run_id')) db.exec("ALTER TABLE messages ADD COLUMN run_id TEXT DEFAULT ''")
    if (!cols.includes('meta')) db.exec("ALTER TABLE messages ADD COLUMN meta TEXT DEFAULT '{}'")
  } catch {}
  // runs 增加输入/输出/缓存 token 统计（幂等）
  try {
    const cols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name)
    if (!cols.includes('input_tokens')) db.exec('ALTER TABLE runs ADD COLUMN input_tokens INTEGER DEFAULT 0')
    if (!cols.includes('output_tokens')) db.exec('ALTER TABLE runs ADD COLUMN output_tokens INTEGER DEFAULT 0')
    if (!cols.includes('cached_tokens')) db.exec('ALTER TABLE runs ADD COLUMN cached_tokens INTEGER DEFAULT 0')
  } catch {}
  // 旧消息归入每个任务的主会话；任务级 resume id 迁到会话 meta
  try {
    const tasks = db.prepare('SELECT id,agent_id,model_id,meta,created_at FROM tasks').all()
    for (const t of tasks) {
      if (db.prepare('SELECT COUNT(*) c FROM sessions WHERE task_id=?').get(t.id).c) continue
      const id = uuid(), ts = t.created_at || now()
      const meta = {}
      try {
        const m = JSON.parse(t.meta || '{}')
        for (const k of Object.keys(m)) if (k.startsWith('sid:')) meta[k] = m[k]
      } catch {}
      db.prepare(`INSERT INTO sessions (id,task_id,parent_session_id,kind,title,agent_id,model_id,summary,meta,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, t.id, '', 'chat', '主会话', '', '', '', JSON.stringify(meta), ts, ts)
      db.prepare("UPDATE messages SET session_id=? WHERE task_id=? AND (session_id IS NULL OR session_id='')").run(id, t.id)
    }
  } catch {}
  // models 增加 provider_id（幂等），旧模型按 (type, base_url) 归组生成提供方
  try {
    const cols = db.prepare('PRAGMA table_info(models)').all().map((c) => c.name)
    if (!cols.includes('provider_id')) db.exec("ALTER TABLE models ADD COLUMN provider_id TEXT DEFAULT ''")
    const rows = db.prepare("SELECT id,type,base_url FROM models WHERE provider_id IS NULL OR provider_id=''").all()
    const groups = new Map()
    for (const r of rows) {
      const key = (r.type || 'openai_compatible') + '|' + (r.base_url || '')
      if (!groups.has(key)) groups.set(key, { type: r.type || 'openai_compatible', base_url: r.base_url || '', ids: [] })
      groups.get(key).ids.push(r.id)
    }
    for (const g of groups.values()) {
      const id = uuid(), t = now()
      db.prepare('INSERT INTO providers (id,name,type,base_url,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(id, providerName(g.type, g.base_url), g.type, g.base_url, t, t)
      const upd = db.prepare('UPDATE models SET provider_id=? WHERE id=?')
      for (const mid of g.ids) upd.run(id, mid)
      log && log(`[zzwork] 已迁移模型到提供方: ${providerName(g.type, g.base_url)}`)
    }
  } catch {}
  const has = (t) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
  const cnt = (t) => has(t) ? db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c : 0
  if (has('projects') && cnt('tasks') === 0) {
    const t = now()
    db.prepare(`INSERT OR IGNORE INTO tasks (id,name,group_id,type,status,path,agent_id,meta,created_at,updated_at)
      SELECT id,name,group_id,'code',COALESCE(NULLIF(status,'archived'),'active'),COALESCE(path,''),'builtin','{}',COALESCE(created_at,?),COALESCE(updated_at,?) FROM projects`).run(t, t)
    log && log('[zzwork] 已迁移 projects → tasks')
  }
  if (!db.prepare("SELECT value FROM settings WHERE key='agents'").get()) {
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('agents', JSON.stringify(DEFAULT_AGENTS))
  }
  // 旧库补充新增的默认执行体（保留用户已有配置与自定义项）
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='agents'").get()
    const cur = JSON.parse(row.value)
    if (Array.isArray(cur)) {
      const have = new Set(cur.map((a) => a.id))
      const add = DEFAULT_AGENTS.filter((a) => !have.has(a.id))
      if (add.length) {
        db.prepare("UPDATE settings SET value=? WHERE key='agents'").run(JSON.stringify([...cur, ...add]))
        log && log('[zzwork] 已补充默认执行体: ' + add.map((a) => a.id).join(', '))
      }
    }
  } catch {}
  // 默认本地环境（只建一次）
  if (db.prepare('SELECT COUNT(*) c FROM environments').get().c === 0) {
    const t = now()
    db.prepare("INSERT INTO environments (id,name,kind,config,created_at,updated_at) VALUES ('local','本机','local','{}',?,?)").run(t, t)
    log && log('[zzwork] 已创建默认环境: 本机')
  }
}

function makeStore(log) {
  const h = openDb(log)
  const persist = () => h.kind === 'json' && fs.writeFileSync(h.path, JSON.stringify(h.data, null, 2))
  const J = (v) => JSON.stringify(v)

  const S = {
    kind: h.kind,
    dbPath: h.path,

    // ---- settings ----
    getSetting(key, dflt) {
      if (h.kind === 'sqlite') {
        const r = h.db.prepare('SELECT value FROM settings WHERE key=?').get(key)
        return r ? r.value : dflt
      }
      return h.data.settings[key] !== undefined ? h.data.settings[key] : dflt
    },
    setSetting(key, value) {
      if (h.kind === 'sqlite') h.db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
      else { h.data.settings[key] = value; persist() }
    },
    get workdir() { return S.getSetting('workdir', '') },

    // ---- agents ----
    listAgents() { try { return JSON.parse(S.getSetting('agents', J(DEFAULT_AGENTS))) } catch { return DEFAULT_AGENTS } },
    saveAgents(list) { S.setSetting('agents', J(list)) },

    // ---- groups ----
    listGroups() {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM groups ORDER BY created_at').all()
      return h.data.groups
    },
    createGroup(name, parentId) {
      const id = uuid(), t = now(), pid = parentId || ''
      if (h.kind === 'sqlite') {
        h.db.prepare('INSERT INTO groups (id,name,parent_id,brief,brief_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, name, pid, '', '', t, t)
        return h.db.prepare('SELECT * FROM groups WHERE id=?').get(id)
      }
      const g = { id, name, parent_id: pid, brief: '', brief_at: '', created_at: t, updated_at: t }
      h.data.groups.push(g); persist(); return g
    },
    getGroup(id) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM groups WHERE id=?').get(id)
      return h.data.groups.find((x) => x.id === id)
    },
    updateGroup(id, patch) {
      const t = now()
      const allowed = ['name', 'parent_id', 'brief', 'brief_at']
      if (h.kind === 'sqlite') {
        const sets = [], vals = {}
        for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k}=@${k}`); vals[k] = patch[k] }
        if (!sets.length) return S.getGroup(id)
        vals.updated_at = t; vals.id = id
        h.db.prepare(`UPDATE groups SET ${sets.join(',')},updated_at=@updated_at WHERE id=@id`).run(vals)
      } else {
        const x = h.data.groups.find((y) => y.id === id); if (!x) return
        for (const k of allowed) if (patch[k] !== undefined) x[k] = patch[k]
        x.updated_at = t; persist()
      }
      return S.getGroup(id)
    },
    deleteGroup(id) {
      if (h.kind === 'sqlite') {
        const g = h.db.prepare('SELECT * FROM groups WHERE id=?').get(id)
        const parent = g ? (g.parent_id || '') : ''
        // 子组与任务上提到被删组的父级（无父级则变为未分组）
        h.db.prepare('UPDATE tasks SET group_id=? WHERE group_id=?').run(parent || null, id)
        h.db.prepare('UPDATE groups SET parent_id=? WHERE parent_id=?').run(parent, id)
        h.db.prepare('DELETE FROM groups WHERE id=?').run(id)
      } else {
        const g = h.data.groups.find((x) => x.id === id)
        const parent = g ? (g.parent_id || '') : ''
        h.data.tasks.forEach((x) => { if (x.group_id === id) x.group_id = parent || null })
        h.data.groups.forEach((x) => { if (x.parent_id === id) x.parent_id = parent })
        h.data.groups = h.data.groups.filter((x) => x.id !== id); persist()
      }
    },

    // ---- tasks ----
    listTasks() {
      if (h.kind === 'sqlite') return h.db.prepare("SELECT * FROM tasks WHERE COALESCE(deleted_at,'')='' ORDER BY updated_at DESC").all()
      return h.data.tasks.filter((x) => !x.deleted_at)
    },
    listTrashedTasks() {
      if (h.kind === 'sqlite') return h.db.prepare("SELECT * FROM tasks WHERE COALESCE(deleted_at,'')!='' ORDER BY deleted_at DESC").all()
      return h.data.tasks.filter((x) => x.deleted_at).sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)))
    },
    trashTask(id) {
      const t = now()
      if (h.kind === 'sqlite') h.db.prepare('UPDATE tasks SET deleted_at=?, updated_at=? WHERE id=?').run(t, t, id)
      else { const x = h.data.tasks.find((y) => y.id === id); if (x) { x.deleted_at = t; x.updated_at = t; persist() } }
      return S.getTask(id)
    },
    restoreTask(id) {
      const t = now()
      if (h.kind === 'sqlite') h.db.prepare("UPDATE tasks SET deleted_at='', updated_at=? WHERE id=?").run(t, id)
      else { const x = h.data.tasks.find((y) => y.id === id); if (x) { x.deleted_at = ''; x.updated_at = t; persist() } }
      return S.getTask(id)
    },
    emptyTrash() {
      const ids = S.listTrashedTasks().map((t) => t.id)
      for (const id of ids) S.deleteTask(id)
      return ids.length
    },
    getTask(id) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
      return h.data.tasks.find((x) => x.id === id)
    },
    createTask(dto) {
      const id = uuid(), t = now()
      const meta = typeof dto.meta === 'string' ? dto.meta : JSON.stringify(dto.meta || {})
      const cols = { id, name: dto.name, group_id: dto.groupId || null, type: dto.type || 'work',
        status: dto.status || 'active', scope: dto.scope || 'long', path: dto.path, agent_id: dto.agentId || 'builtin',
        model_id: dto.modelId || '', meta, created_at: t, updated_at: t }
      if (h.kind === 'sqlite') {
        h.db.prepare(`INSERT INTO tasks (id,name,group_id,type,status,scope,path,agent_id,model_id,meta,created_at,updated_at)
          VALUES (@id,@name,@group_id,@type,@status,@scope,@path,@agent_id,@model_id,@meta,@created_at,@updated_at)`).run(cols)
        return S.getTask(id)
      }
      h.data.tasks.push(cols); persist(); return cols
    },
    updateTask(id, patch) {
      const t = now(); const allowed = ['name', 'group_id', 'type', 'status', 'scope', 'path', 'agent_id', 'model_id', 'meta', 'brief', 'brief_at']
      if (h.kind === 'sqlite') {
        const sets = [], vals = {}
        for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k}=@${k}`); vals[k] = patch[k] }
        if (!sets.length) return S.getTask(id)
        vals.updated_at = t; vals.id = id
        h.db.prepare(`UPDATE tasks SET ${sets.join(',')},updated_at=@updated_at WHERE id=@id`).run(vals)
      } else {
        const x = h.data.tasks.find((y) => y.id === id); if (!x) return
        for (const k of allowed) if (patch[k] !== undefined) x[k] = patch[k]
        x.updated_at = t; persist()
      }
      return S.getTask(id)
    },
    deleteTask(id) {
      if (h.kind === 'sqlite') {
        h.db.prepare('DELETE FROM messages WHERE task_id=?').run(id)
        h.db.prepare('DELETE FROM runs WHERE task_id=?').run(id)
        h.db.prepare('DELETE FROM sessions WHERE task_id=?').run(id)
        h.db.prepare('DELETE FROM task_skills WHERE task_id=?').run(id)
        h.db.prepare('DELETE FROM task_mcp WHERE task_id=?').run(id)
        h.db.prepare('DELETE FROM tasks WHERE id=?').run(id)
      } else {
        h.data.tasks = h.data.tasks.filter((x) => x.id !== id)
        h.data.messages = h.data.messages.filter((x) => x.task_id !== id)
        h.data.sessions = (h.data.sessions || []).filter((x) => x.task_id !== id)
        h.data.runs = (h.data.runs || []).filter((x) => x.task_id !== id)
        h.data.task_skills = (h.data.task_skills || []).filter((x) => x.task_id !== id)
        h.data.task_mcp = (h.data.task_mcp || []).filter((x) => x.task_id !== id)
        persist()
      }
    },

    // ---- messages ----
    listMessages(taskId, sessionId) {
      if (h.kind === 'sqlite') {
        return sessionId
          ? h.db.prepare('SELECT * FROM messages WHERE task_id=? AND session_id=? ORDER BY created_at,rowid').all(taskId, sessionId)
          : h.db.prepare('SELECT * FROM messages WHERE task_id=? ORDER BY created_at,rowid').all(taskId)
      }
      return h.data.messages.filter((x) => x.task_id === taskId && (!sessionId || x.session_id === sessionId))
    },
    getMessage(id) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM messages WHERE id=?').get(id)
      return h.data.messages.find((m) => m.id === id)
    },
    upsertMessage(rec) {
      const row = {
        id: rec.id, task_id: rec.task_id, role: rec.role || 'assistant',
        content: rec.content == null ? '' : String(rec.content),
        session_id: rec.session_id || '', kind: rec.kind || 'text', run_id: rec.run_id || '',
        meta: typeof rec.meta === 'string' ? rec.meta : J(rec.meta || {}),
        created_at: rec.created_at || now()
      }
      if (h.kind === 'sqlite') {
        h.db.prepare(`INSERT INTO messages (id,task_id,role,content,session_id,kind,run_id,meta,created_at)
          VALUES (@id,@task_id,@role,@content,@session_id,@kind,@run_id,@meta,@created_at)
          ON CONFLICT(id) DO UPDATE SET content=excluded.content, kind=excluded.kind,
          run_id=excluded.run_id, meta=excluded.meta`).run(row)
      } else {
        const i = h.data.messages.findIndex((m) => m.id === rec.id)
        if (i >= 0) h.data.messages[i] = { ...h.data.messages[i], ...row }
        else h.data.messages.push(row)
        persist()
      }
      return row.id
    },
    upsertSession(rec) {
      const t = rec.created_at || now()
      const row = {
        id: rec.id, task_id: rec.task_id, parent_session_id: rec.parent_session_id || '',
        kind: rec.kind || 'chat', title: rec.title || '会话', agent_id: rec.agent_id || '',
        model_id: rec.model_id || '', summary: rec.summary || '',
        meta: typeof rec.meta === 'string' ? rec.meta : J(rec.meta || {}),
        created_at: t, updated_at: rec.updated_at || t
      }
      if (h.kind === 'sqlite') {
        h.db.prepare(`INSERT INTO sessions (id,task_id,parent_session_id,kind,title,agent_id,model_id,summary,meta,created_at,updated_at)
          VALUES (@id,@task_id,@parent_session_id,@kind,@title,@agent_id,@model_id,@summary,@meta,@created_at,@updated_at)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title, agent_id=excluded.agent_id, model_id=excluded.model_id,
          summary=excluded.summary, meta=excluded.meta, parent_session_id=excluded.parent_session_id,
          kind=excluded.kind, updated_at=excluded.updated_at`).run(row)
      } else {
        h.data.sessions = h.data.sessions || []
        const i = h.data.sessions.findIndex((s) => s.id === rec.id)
        if (i >= 0) h.data.sessions[i] = { ...h.data.sessions[i], ...row }
        else h.data.sessions.push(row)
        persist()
      }
      return row.id
    },
    addMessage(taskId, role, content, opts) {
      const o = opts || {}
      const id = uuid(), t = now()
      const kind = o.kind || 'text'
      const sessionId = o.sessionId || ''
      const runId = o.runId || ''
      const meta = typeof o.meta === 'string' ? o.meta : J(o.meta || {})
      if (h.kind === 'sqlite') {
        h.db.prepare('INSERT INTO messages (id,task_id,role,content,session_id,kind,run_id,meta,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, taskId, role, content, sessionId, kind, runId, meta, t)
      } else {
        h.data.messages.push({ id, task_id: taskId, role, content, session_id: sessionId, kind, run_id: runId, meta, created_at: t })
        persist()
      }
      try {
        if (fileStore) fileStore.messageAdded({ taskId, sessionId, row: { id, role, kind, content, run_id: runId, created_at: t, meta }, fileMeta: o.fileMeta || null })
      } catch {}
      return id
    },
    updateMessage(id, patch) {
      const src = patch || {}
      const fileMeta = src.fileMeta || null
      const clean = { ...src }
      delete clean.fileMeta
      const allowed = ['content', 'kind', 'meta', 'run_id']
      let changed = false
      if (h.kind === 'sqlite') {
        const sets = [], vals = { id }
        for (const k of allowed) if (clean[k] !== undefined) { sets.push(`${k}=@${k}`); vals[k] = clean[k] }
        if (sets.length) { h.db.prepare(`UPDATE messages SET ${sets.join(',')} WHERE id=@id`).run(vals); changed = true }
      } else {
        const x = h.data.messages.find((m) => m.id === id)
        if (x) { for (const k of allowed) if (clean[k] !== undefined) { x[k] = clean[k]; changed = true } if (changed) persist() }
      }
      if (!changed) return
      try {
        if (fileStore) {
          const cur = S.getMessage(id)
          if (cur) fileStore.messageUpdated({ taskId: cur.task_id, sessionId: cur.session_id, id, patch: clean, fileMeta })
        }
      } catch {}
    },

    // ---- sessions ----
    listSessions(taskId) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM sessions WHERE task_id=? ORDER BY created_at,rowid').all(taskId)
      return (h.data.sessions || []).filter((x) => x.task_id === taskId)
    },
    getSession(id) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM sessions WHERE id=?').get(id)
      return (h.data.sessions || []).find((x) => x.id === id)
    },
    createSession(dto) {
      const d = dto || {}
      const id = d.id || uuid(), t = now()
      const rec = {
        id, task_id: d.taskId, parent_session_id: d.parentSessionId || '', kind: d.kind || 'chat',
        title: d.title || '新会话', agent_id: d.agentId || '', model_id: d.modelId || '',
        summary: d.summary || '', meta: typeof d.meta === 'string' ? d.meta : J(d.meta || {}),
        created_at: t, updated_at: t
      }
      if (h.kind === 'sqlite') {
        h.db.prepare(`INSERT INTO sessions (id,task_id,parent_session_id,kind,title,agent_id,model_id,summary,meta,created_at,updated_at)
          VALUES (@id,@task_id,@parent_session_id,@kind,@title,@agent_id,@model_id,@summary,@meta,@created_at,@updated_at)`).run(rec)
      } else {
        h.data.sessions = h.data.sessions || []
        h.data.sessions.push(rec); persist()
      }
      try { if (fileStore) fileStore.sessionCreated({ taskId: rec.task_id, sessionId: rec.id }) } catch {}
      return rec
    },
    updateSession(id, patch) {
      const allowed = ['title', 'agent_id', 'model_id', 'summary', 'meta', 'parent_session_id', 'kind']
      const t = now()
      if (h.kind === 'sqlite') {
        const sets = [], vals = {}
        for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k}=@${k}`); vals[k] = patch[k] }
        if (sets.length) {
          vals.updated_at = t; vals.id = id
          h.db.prepare(`UPDATE sessions SET ${sets.join(',')},updated_at=@updated_at WHERE id=@id`).run(vals)
        }
      } else {
        const x = (h.data.sessions || []).find((y) => y.id === id)
        if (x) {
          for (const k of allowed) if (patch[k] !== undefined) x[k] = patch[k]
          x.updated_at = t; persist()
        }
      }
      const s = S.getSession(id)
      try { if (fileStore && s) fileStore.sessionUpdated({ taskId: s.task_id, sessionId: id }) } catch {}
      return s
    },
    deleteSession(id) {
      const all = h.kind === 'sqlite'
        ? h.db.prepare('SELECT id,parent_session_id,task_id FROM sessions').all()
        : (h.data.sessions || [])
      const root = all.find((s) => s.id === id)
      const ids = new Set([id])
      let grew = true
      while (grew) {
        grew = false
        for (const s of all) if (!ids.has(s.id) && ids.has(s.parent_session_id)) { ids.add(s.id); grew = true }
      }
      const list = [...ids]
      if (h.kind === 'sqlite') {
        const delMsg = h.db.prepare('DELETE FROM messages WHERE session_id=?')
        const delRun = h.db.prepare('DELETE FROM runs WHERE session_id=?')
        const delSes = h.db.prepare('DELETE FROM sessions WHERE id=?')
        for (const sid of list) { delMsg.run(sid); delRun.run(sid); delSes.run(sid) }
      } else {
        h.data.messages = h.data.messages.filter((m) => !ids.has(m.session_id))
        h.data.runs = (h.data.runs || []).filter((r) => !ids.has(r.session_id))
        h.data.sessions = (h.data.sessions || []).filter((s) => !ids.has(s.id))
        persist()
      }
      try { if (fileStore && root) fileStore.sessionsDeleted({ taskId: root.task_id, sessionIds: list }) } catch {}
    },
    ensureSession(taskId) {
      // 跳过跨任务询问（kind='ask'）这类隐藏会话，避免被当成主会话
      const list = S.listSessions(taskId).filter((s) => s.kind !== 'ask')
      if (list.length) return list[0]
      const task = S.getTask(taskId)
      if (!task) return null
      return S.createSession({ taskId, title: '主会话', agentId: '', modelId: '' })
    },

    // ---- runs ----
    createRun(dto) {
      const d = dto || {}
      const id = d.id || uuid(), t = now()
      const rec = {
        id, task_id: d.taskId, session_id: d.sessionId || '', parent_run_id: d.parentRunId || '',
        agent_id: d.agentId || '', model_id: d.modelId || '', status: d.status || 'running',
        prompt: d.prompt || '', result: '', tokens: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, error: '',
        meta: typeof d.meta === 'string' ? d.meta : J(d.meta || {}), started_at: t, finished_at: ''
      }
      if (h.kind === 'sqlite') {
        h.db.prepare(`INSERT INTO runs (id,task_id,session_id,parent_run_id,agent_id,model_id,status,prompt,result,tokens,input_tokens,output_tokens,cached_tokens,error,meta,started_at,finished_at)
          VALUES (@id,@task_id,@session_id,@parent_run_id,@agent_id,@model_id,@status,@prompt,@result,@tokens,@input_tokens,@output_tokens,@cached_tokens,@error,@meta,@started_at,@finished_at)`).run(rec)
      } else {
        h.data.runs = h.data.runs || []
        h.data.runs.push(rec); persist()
      }
      return rec
    },
    updateRun(id, patch) {
      const allowed = ['status', 'result', 'tokens', 'input_tokens', 'output_tokens', 'cached_tokens', 'error', 'meta', 'finished_at', 'agent_id', 'model_id']
      if (h.kind === 'sqlite') {
        const sets = [], vals = { id }
        for (const k of allowed) if (patch[k] !== undefined) { sets.push(`${k}=@${k}`); vals[k] = patch[k] }
        if (!sets.length) return
        h.db.prepare(`UPDATE runs SET ${sets.join(',')} WHERE id=@id`).run(vals)
        return
      }
      const x = (h.data.runs || []).find((r) => r.id === id)
      if (x) { Object.assign(x, patch); persist() }
    },
    getRun(id) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM runs WHERE id=?').get(id)
      return (h.data.runs || []).find((r) => r.id === id)
    },
    listRuns(taskId, sessionId) {
      if (h.kind === 'sqlite') {
        return sessionId
          ? h.db.prepare('SELECT * FROM runs WHERE task_id=? AND session_id=? ORDER BY started_at').all(taskId, sessionId)
          : h.db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY started_at').all(taskId)
      }
      return (h.data.runs || []).filter((r) => r.task_id === taskId && (!sessionId || r.session_id === sessionId))
    },

    // ---- providers（模型提供方，Key 按提供方保存）----
    listProviders() {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM providers ORDER BY created_at').all()
      return h.data.providers || []
    },
    upsertProvider(p) {
      const t = now()
      const id = p.id || uuid()
      const type = p.type || 'openai_compatible'
      if (h.kind === 'sqlite') {
        const exists = p.id && h.db.prepare('SELECT id FROM providers WHERE id=?').get(p.id)
        if (exists) {
          h.db.prepare('UPDATE providers SET name=?,type=?,base_url=?,updated_at=? WHERE id=?').run(p.name, type, p.base_url, t, id)
          h.db.prepare('UPDATE models SET type=?,base_url=? WHERE provider_id=?').run(type, p.base_url, id)
        } else {
          h.db.prepare('INSERT INTO providers (id,name,type,base_url,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, p.name, type, p.base_url, t, t)
        }
        return id
      }
      if (!h.data.providers) h.data.providers = []
      const rec = { id, name: p.name, type, base_url: p.base_url, created_at: t, updated_at: t }
      const i = h.data.providers.findIndex((x) => x.id === id)
      if (i >= 0) h.data.providers[i] = { ...h.data.providers[i], ...rec }
      else h.data.providers.push(rec)
      for (const m of h.data.models) if (m.provider_id === id) { m.type = type; m.base_url = p.base_url }
      persist()
      return id
    },
    deleteProvider(id) {
      if (h.kind === 'sqlite') {
        const ids = h.db.prepare('SELECT id FROM models WHERE provider_id=?').all(id).map((r) => r.id)
        for (const mid of ids) h.db.prepare("UPDATE tasks SET model_id='' WHERE model_id=?").run(mid)
        h.db.prepare('DELETE FROM models WHERE provider_id=?').run(id)
        h.db.prepare('DELETE FROM providers WHERE id=?').run(id)
      } else {
        if (!h.data.providers) h.data.providers = []
        h.data.providers = h.data.providers.filter((x) => x.id !== id)
        const gone = h.data.models.filter((m) => m.provider_id === id).map((m) => m.id)
        h.data.models = h.data.models.filter((m) => m.provider_id !== id)
        for (const t of h.data.tasks) if (gone.includes(t.model_id)) t.model_id = ''
        persist()
      }
    },

    // ---- models（内置聊天用）----
    listModels() {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM models ORDER BY is_default DESC,created_at').all()
      return h.data.models
    },
    upsertModel(m) {
      const t = now()
      if (h.kind === 'sqlite') {
        let id = m.id
        if (m.id && h.db.prepare('SELECT id FROM models WHERE id=?').get(m.id)) {
          h.db.prepare('UPDATE models SET name=?,type=?,base_url=?,model_id=?,is_default=?,provider_id=? WHERE id=?')
            .run(m.name, m.type, m.base_url, m.model_id, m.is_default ? 1 : 0, m.provider_id || '', m.id)
        } else {
          id = m.id || uuid()
          h.db.prepare('INSERT INTO models (id,name,type,base_url,model_id,is_default,provider_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(id, m.name, m.type || 'openai_compatible', m.base_url, m.model_id, m.is_default ? 1 : 0, m.provider_id || '', t)
        }
        if (m.is_default) h.db.prepare('UPDATE models SET is_default=0 WHERE id!=?').run(id)
        return
      }
      const i = h.data.models.findIndex((x) => x.id === m.id)
      if (i >= 0) h.data.models[i] = { ...h.data.models[i], ...m }
      else h.data.models.push({ id: m.id || uuid(), created_at: t, ...m })
      if (m.is_default) for (const x of h.data.models) if (x.id !== m.id) x.is_default = 0
      persist()
    },
    deleteModel(id) {
      if (h.kind === 'sqlite') h.db.prepare('DELETE FROM models WHERE id=?').run(id)
      else { h.data.models = h.data.models.filter((x) => x.id !== id); persist() }
    },

    // ---- environments ----
    listEnvironments() {
      const parse = (e) => {
        if (e && typeof e.config === 'string') { try { e.config = JSON.parse(e.config) } catch { e.config = {} } }
        return e
      }
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM environments ORDER BY created_at').all().map(parse)
      return h.data.environments || []
    },
    getEnvironment(id) {
      const parse = (e) => {
        if (e && typeof e.config === 'string') { try { e.config = JSON.parse(e.config) } catch { e.config = {} } }
        return e
      }
      if (h.kind === 'sqlite') return parse(h.db.prepare('SELECT * FROM environments WHERE id=?').get(id))
      return (h.data.environments || []).find((x) => x.id === id)
    },
    upsertEnvironment(e) {
      const t = now()
      const id = e.id || uuid()
      if (h.kind === 'sqlite') {
        const ex = e.id && h.db.prepare('SELECT id FROM environments WHERE id=?').get(e.id)
        if (ex) h.db.prepare('UPDATE environments SET name=?,kind=?,config=?,updated_at=? WHERE id=?').run(e.name, e.kind, JSON.stringify(e.config || {}), t, e.id)
        else h.db.prepare('INSERT INTO environments (id,name,kind,config,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, e.name, e.kind || 'local', JSON.stringify(e.config || {}), t, t)
        return id
      }
      h.data.environments = h.data.environments || []
      const i = h.data.environments.findIndex((x) => x.id === e.id)
      if (i >= 0) h.data.environments[i] = { ...h.data.environments[i], ...e, updated_at: t }
      else h.data.environments.push({ id, created_at: t, updated_at: t, ...e })
      persist()
      return id
    },

    deleteEnvironment(id) {
      if (id === 'local') return
      if (h.kind === 'sqlite') {
        h.db.prepare('DELETE FROM skills WHERE env_id=?').run(id)
        h.db.prepare('DELETE FROM mcp_servers WHERE env_id=?').run(id)
        h.db.prepare('DELETE FROM environments WHERE id=?').run(id)
      } else {
        h.data.environments = (h.data.environments || []).filter((x) => x.id !== id)
        h.data.skills = (h.data.skills || []).filter((x) => x.env_id !== id)
        h.data.mcp_servers = (h.data.mcp_servers || []).filter((x) => x.env_id !== id)
        persist()
      }
    },

    // ---- skills（环境级发现 + 用户添加）----
    listSkills(envId) {
      if (h.kind === 'sqlite') {
        return envId ? h.db.prepare('SELECT * FROM skills WHERE env_id=? ORDER BY source,name').all(envId)
          : h.db.prepare('SELECT * FROM skills ORDER BY env_id,source,name').all()
      }
      return (h.data.skills || []).filter((x) => !envId || x.env_id === envId)
    },
    upsertSkill(s) {
      const t = now()
      if (h.kind === 'sqlite') {
        h.db.prepare(`INSERT INTO skills (id,env_id,name,path,source,description,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(env_id,path) DO UPDATE SET name=excluded.name,
          source=excluded.source, description=excluded.description, updated_at=excluded.updated_at`)
          .run(s.id || uuid(), s.env_id, s.name, s.path, s.source || 'user', s.description || '', t, t)
        return
      }
      h.data.skills = h.data.skills || []
      const i = h.data.skills.findIndex((x) => x.env_id === s.env_id && x.path === s.path)
      if (i >= 0) h.data.skills[i] = { ...h.data.skills[i], ...s, updated_at: t }
      else h.data.skills.push({ id: s.id || uuid(), created_at: t, updated_at: t, source: 'user', description: '', ...s })
      persist()
    },
    deleteSkill(id) {
      if (h.kind === 'sqlite') {
        h.db.prepare('DELETE FROM task_skills WHERE skill_id=?').run(id)
        h.db.prepare('DELETE FROM skills WHERE id=?').run(id)
      } else {
        h.data.skills = (h.data.skills || []).filter((x) => x.id !== id)
        h.data.task_skills = (h.data.task_skills || []).filter((x) => x.skill_id !== id)
        persist()
      }
    },

    // ---- mcp（环境级配置 + 用户添加）----
    listMcp(envId) {
      if (h.kind === 'sqlite') {
        return envId ? h.db.prepare('SELECT * FROM mcp_servers WHERE env_id=? ORDER BY name').all(envId)
          : h.db.prepare('SELECT * FROM mcp_servers ORDER BY env_id,name').all()
      }
      return (h.data.mcp_servers || []).filter((x) => !envId || x.env_id === envId)
    },
    upsertMcp(m) {
      const t = now()
      const cfg = JSON.stringify(m.config || {})
      if (h.kind === 'sqlite') {
        const ex = h.db.prepare('SELECT id FROM mcp_servers WHERE env_id=? AND name=? AND origin_path=?').get(m.env_id, m.name, m.origin_path || '')
        if (ex) h.db.prepare('UPDATE mcp_servers SET type=?,config=?,source=?,updated_at=? WHERE id=?').run(m.type || 'stdio', cfg, m.source || 'user', t, ex.id)
        else h.db.prepare('INSERT INTO mcp_servers (id,env_id,name,type,config,source,origin_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(m.id || uuid(), m.env_id, m.name, m.type || 'stdio', cfg, m.source || 'user', m.origin_path || '', t, t)
        return
      }
      h.data.mcp_servers = h.data.mcp_servers || []
      const i = h.data.mcp_servers.findIndex((x) => x.env_id === m.env_id && x.name === m.name && x.origin_path === (m.origin_path || ''))
      if (i >= 0) h.data.mcp_servers[i] = { ...h.data.mcp_servers[i], ...m, config: m.config, updated_at: t }
      else h.data.mcp_servers.push({ id: m.id || uuid(), created_at: t, updated_at: t, source: 'user', origin_path: '', ...m })
      persist()
    },
    deleteMcp(id) {
      if (h.kind === 'sqlite') {
        h.db.prepare('DELETE FROM task_mcp WHERE mcp_id=?').run(id)
        h.db.prepare('DELETE FROM mcp_servers WHERE id=?').run(id)
      } else {
        h.data.mcp_servers = (h.data.mcp_servers || []).filter((x) => x.id !== id)
        h.data.task_mcp = (h.data.task_mcp || []).filter((x) => x.mcp_id !== id)
        persist()
      }
    },

    // ---- 任务级裁剪（默认全选，只记录被排除的）----
    taskExcludedSkills(taskId) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT skill_id FROM task_skills WHERE task_id=? AND excluded=1').all(taskId).map((r) => r.skill_id)
      return (h.data.task_skills || []).filter((x) => x.task_id === taskId && x.excluded).map((x) => x.skill_id)
    },
    setTaskSkillExcluded(taskId, skillId, excluded) {
      if (h.kind === 'sqlite') {
        h.db.prepare(`INSERT INTO task_skills (task_id,skill_id,excluded) VALUES (?,?,?)
          ON CONFLICT(task_id,skill_id) DO UPDATE SET excluded=excluded.excluded`).run(taskId, skillId, excluded ? 1 : 0)
        return
      }
      h.data.task_skills = h.data.task_skills || []
      const i = h.data.task_skills.findIndex((x) => x.task_id === taskId && x.skill_id === skillId)
      if (i >= 0) h.data.task_skills[i].excluded = excluded ? 1 : 0
      else h.data.task_skills.push({ task_id: taskId, skill_id: skillId, excluded: excluded ? 1 : 0 })
      persist()
    },
    taskExcludedMcp(taskId) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT mcp_id FROM task_mcp WHERE task_id=? AND excluded=1').all(taskId).map((r) => r.mcp_id)
      return (h.data.task_mcp || []).filter((x) => x.task_id === taskId && x.excluded).map((x) => x.mcp_id)
    },
    setTaskMcpExcluded(taskId, mcpId, excluded) {
      if (h.kind === 'sqlite') {
        h.db.prepare(`INSERT INTO task_mcp (task_id,mcp_id,excluded) VALUES (?,?,?)
          ON CONFLICT(task_id,mcp_id) DO UPDATE SET excluded=excluded.excluded`).run(taskId, mcpId, excluded ? 1 : 0)
        return
      }
      h.data.task_mcp = h.data.task_mcp || []
      const i = h.data.task_mcp.findIndex((x) => x.task_id === taskId && x.mcp_id === mcpId)
      if (i >= 0) h.data.task_mcp[i].excluded = excluded ? 1 : 0
      else h.data.task_mcp.push({ task_id: taskId, mcp_id: mcpId, excluded: excluded ? 1 : 0 })
      persist()
    },
  }
  return S
}

module.exports = { makeStore, DEFAULT_AGENTS, setFileStore }
