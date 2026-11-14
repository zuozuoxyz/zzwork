// zzwork 数据层：SQLite（组/任务/todo/消息/设置），旧 projects/progress 自动迁移
const path = require('path')
const fs = require('fs')
const os = require('os')
const { v4: uuid } = require('uuid')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL, group_id TEXT, type TEXT DEFAULT 'work',
  status TEXT DEFAULT 'active', path TEXT NOT NULL, agent_id TEXT DEFAULT 'builtin', meta TEXT DEFAULT '{}',
  created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL, status TEXT DEFAULT 'todo', sort INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, created_at TEXT);
CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'openai_compatible',
  base_url TEXT NOT NULL, model_id TEXT NOT NULL, is_default INTEGER DEFAULT 0, created_at TEXT);
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
const DEFAULT_AGENTS = [
  { id: 'builtin', name: '内置模型聊天', kind: 'builtin', where: 'local', cmd: '' },
  { id: 'claude-code', name: 'Claude Code', kind: 'cli', where: 'auto', cmd: 'claude' },
  { id: 'opencode', name: 'opencode', kind: 'cli', where: 'auto', cmd: 'opencode' },
  { id: 'zcode', name: 'zcode', kind: 'cli', where: 'auto', cmd: 'zcode' },
]

function now() { return new Date().toISOString() }

function openDb(log) {
  const candidates = [
    path.join(process.env.APPDATA || '', 'zzwork', 'data', 'zzwork.db'),
    path.join(os.homedir(), '.zzwork-vscode', 'zzwork.db'),
  ]
  for (const p of candidates) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const Database = require('better-sqlite3')
      const db = new Database(p)
      db.pragma('journal_mode = WAL')
      db.exec(SCHEMA)
      migrate(db, log)
      log && log(`[zzwork] SQLite 已连接: ${p}`)
      try { fs.appendFileSync('D:/zzwork-storage.log', `${now()} SQLITE OK ${p}\n`) } catch {}
      return { kind: 'sqlite', db, path: p }
    } catch (e) {
      log && log(`[zzwork] SQLite 不可用(${e.message.slice(0, 80)})`)
      try { fs.appendFileSync('D:/zzwork-storage.log', `${now()} SQLITE FAIL ${p} :: ${e.message.slice(0, 400)}\n`) } catch {}
    }
  }
  const jp = candidates[candidates.length - 1].replace(/\.db$/, '.json')
  fs.mkdirSync(path.dirname(jp), { recursive: true })
  const data = fs.existsSync(jp) ? JSON.parse(fs.readFileSync(jp, 'utf8'))
    : { groups: [], tasks: [], todos: [], messages: [], models: [], settings: {} }
  return { kind: 'json', data, path: jp }
}

// 旧 projects/progress → tasks/todos（只跑一次，旧表保留不动）
function migrate(db, log) {
  // tasks 增加 model_id（幂等）
  try {
    const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name)
    if (!cols.includes('model_id')) db.exec("ALTER TABLE tasks ADD COLUMN model_id TEXT DEFAULT ''")
  } catch {}
  const has = (t) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
  const cnt = (t) => has(t) ? db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c : 0
  if (has('projects') && cnt('tasks') === 0) {
    const t = now()
    db.prepare(`INSERT OR IGNORE INTO tasks (id,name,group_id,type,status,path,agent_id,meta,created_at,updated_at)
      SELECT id,name,group_id,'code',COALESCE(NULLIF(status,'archived'),'active'),COALESCE(path,''),'builtin','{}',COALESCE(created_at,?),COALESCE(updated_at,?) FROM projects`).run(t, t)
    log && log('[zzwork] 已迁移 projects → tasks')
  }
  if (has('progress') && cnt('todos') === 0) {
    db.prepare(`INSERT OR IGNORE INTO todos (id,task_id,title,status,sort,created_at,updated_at)
      SELECT id,project_id,title,CASE WHEN status='done' THEN 'done' ELSE 'todo' END,0,COALESCE(created_at,?),COALESCE(updated_at,?) FROM progress`).run(now(), now())
    log && log('[zzwork] 已迁移 progress → todos')
  }
  if (!db.prepare("SELECT value FROM settings WHERE key='agents'").get()) {
    db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('agents', JSON.stringify(DEFAULT_AGENTS))
  }
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
    createGroup(name) {
      const id = uuid(), t = now()
      if (h.kind === 'sqlite') {
        h.db.prepare('INSERT INTO groups (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, name, t, t)
        return h.db.prepare('SELECT * FROM groups WHERE id=?').get(id)
      }
      const g = { id, name, created_at: t, updated_at: t }
      h.data.groups.push(g); persist(); return g
    },
    deleteGroup(id) {
      if (h.kind === 'sqlite') {
        h.db.prepare('UPDATE tasks SET group_id=NULL WHERE group_id=?').run(id)
        h.db.prepare('DELETE FROM groups WHERE id=?').run(id)
      } else {
        h.data.tasks.forEach((x) => { if (x.group_id === id) x.group_id = null })
        h.data.groups = h.data.groups.filter((x) => x.id !== id); persist()
      }
    },

    // ---- tasks ----
    listTasks() {
      if (h.kind === 'sqlite') return h.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all()
      return h.data.tasks
    },
    getTask(id) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
      return h.data.tasks.find((x) => x.id === id)
    },
    createTask(dto) {
      const id = uuid(), t = now()
      const cols = { id, name: dto.name, group_id: dto.groupId || null, type: dto.type || 'work',
        status: 'active', path: dto.path, agent_id: dto.agentId || 'builtin', meta: '{}', created_at: t, updated_at: t }
      if (h.kind === 'sqlite') {
        h.db.prepare(`INSERT INTO tasks (id,name,group_id,type,status,path,agent_id,meta,created_at,updated_at)
          VALUES (@id,@name,@group_id,@type,@status,@path,@agent_id,@meta,@created_at,@updated_at)`).run(cols)
        return S.getTask(id)
      }
      h.data.tasks.push(cols); persist(); return cols
    },
    updateTask(id, patch) {
      const t = now(); const allowed = ['name', 'group_id', 'type', 'status', 'path', 'agent_id', 'model_id', 'meta']
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
        h.db.prepare('DELETE FROM todos WHERE task_id=?').run(id)
        h.db.prepare('DELETE FROM messages WHERE task_id=?').run(id)
        h.db.prepare('DELETE FROM tasks WHERE id=?').run(id)
      } else {
        h.data.tasks = h.data.tasks.filter((x) => x.id !== id)
        h.data.todos = h.data.todos.filter((x) => x.task_id !== id)
        h.data.messages = h.data.messages.filter((x) => x.task_id !== id)
        persist()
      }
    },

    // ---- todos ----
    listTodos(taskId) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM todos WHERE task_id=? ORDER BY sort,created_at').all(taskId)
      return h.data.todos.filter((x) => x.task_id === taskId)
    },
    addTodo(taskId, title) {
      const id = uuid(), t = now()
      const sort = S.listTodos(taskId).length
      if (h.kind === 'sqlite') {
        h.db.prepare('INSERT INTO todos (id,task_id,title,status,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, taskId, title, 'todo', sort, t, t)
      } else { h.data.todos.push({ id, task_id: taskId, title, status: 'todo', sort, created_at: t, updated_at: t }); persist() }
      return id
    },
    setTodoStatus(todoId, status) {
      const t = now()
      if (h.kind === 'sqlite') h.db.prepare('UPDATE todos SET status=?,updated_at=? WHERE id=?').run(status, t, todoId)
      else { const x = h.data.todos.find((y) => y.id === todoId); if (x) { x.status = status; x.updated_at = t; persist() } }
    },
    deleteTodo(todoId) {
      if (h.kind === 'sqlite') h.db.prepare('DELETE FROM todos WHERE id=?').run(todoId)
      else { h.data.todos = h.data.todos.filter((x) => x.id !== todoId); persist() }
    },

    // ---- messages ----
    listMessages(taskId) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM messages WHERE task_id=? ORDER BY created_at').all(taskId)
      return h.data.messages.filter((x) => x.task_id === taskId)
    },
    addMessage(taskId, role, content) {
      const id = uuid(), t = now()
      if (h.kind === 'sqlite') h.db.prepare('INSERT INTO messages (id,task_id,role,content,created_at) VALUES (?,?,?,?,?)').run(id, taskId, role, content, t)
      else { h.data.messages.push({ id, task_id: taskId, role, content, created_at: t }); persist() }
      return id
    },

    // ---- models（内置聊天用）----
    listModels() {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM models ORDER BY is_default DESC,created_at').all()
      return h.data.models
    },
    upsertModel(m) {
      const t = now()
      if (h.kind === 'sqlite') {
        if (m.id && h.db.prepare('SELECT id FROM models WHERE id=?').get(m.id)) {
          h.db.prepare('UPDATE models SET name=?,type=?,base_url=?,model_id=?,is_default=? WHERE id=?').run(m.name, m.type, m.base_url, m.model_id, m.is_default ? 1 : 0, m.id)
        } else {
          h.db.prepare('INSERT INTO models (id,name,type,base_url,model_id,is_default,created_at) VALUES (?,?,?,?,?,?,?)')
            .run(m.id || uuid(), m.name, m.type || 'openai_compatible', m.base_url, m.model_id, m.is_default ? 1 : 0, t)
        }
        if (m.is_default) {
          const row = h.db.prepare('SELECT id FROM models WHERE name=? AND base_url=? AND model_id=?').get(m.name, m.base_url, m.model_id)
          if (row) h.db.prepare('UPDATE models SET is_default=0 WHERE id!=?').run(row.id)
        }
        return
      }
      const i = h.data.models.findIndex((x) => x.id === m.id)
      if (i >= 0) h.data.models[i] = { ...h.data.models[i], ...m }; else h.data.models.push({ id: m.id || uuid(), created_at: t, ...m })
      persist()
    },
    deleteModel(id) {
      if (h.kind === 'sqlite') h.db.prepare('DELETE FROM models WHERE id=?').run(id)
      else { h.data.models = h.data.models.filter((x) => x.id !== id); persist() }
    },

    // ---- environments ----
    listEnvironments() {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM environments ORDER BY created_at').all()
      return h.data.environments || []
    },
    getEnvironment(id) {
      if (h.kind === 'sqlite') return h.db.prepare('SELECT * FROM environments WHERE id=?').get(id)
      return (h.data.environments || []).find((x) => x.id === id)
    },
    upsertEnvironment(e) {
      const t = now()
      if (h.kind === 'sqlite') {
        const ex = e.id && h.db.prepare('SELECT id FROM environments WHERE id=?').get(e.id)
        if (ex) h.db.prepare('UPDATE environments SET name=?,kind=?,config=?,updated_at=? WHERE id=?').run(e.name, e.kind, JSON.stringify(e.config || {}), t, e.id)
        else h.db.prepare('INSERT INTO environments (id,name,kind,config,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(e.id || uuid(), e.name, e.kind || 'local', JSON.stringify(e.config || {}), t, t)
        return
      }
      h.data.environments = h.data.environments || []
      const i = h.data.environments.findIndex((x) => x.id === e.id)
      if (i >= 0) h.data.environments[i] = { ...h.data.environments[i], ...e, updated_at: t }
      else h.data.environments.push({ id: e.id || uuid(), created_at: t, updated_at: t, ...e })
      persist()
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

module.exports = { makeStore, DEFAULT_AGENTS }
