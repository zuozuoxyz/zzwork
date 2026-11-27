// 数据层服务：包装 core/store，初始化默认工作目录并自愈任务路径
const path = require('path')
const fs = require('fs')
const os = require('os')
const { makeStore, setFileStore } = require('../../core/store')

let instance = null
let ipcMainRef = null

function log(msg) {
  console.log(msg)
}

// 把 store 的写入镜像到 <task>/.zzwork/sessions（文件为权威）；失败吞掉不阻塞回合
function createFileAdapter(S) {
  const sf = require('./sessionFiles')
  const taskOf = (taskId) => { try { return taskId ? S.getTask(taskId) : null } catch { return null } }
  return {
    messageAdded({ taskId, sessionId, row, fileMeta }) {
      const task = taskOf(taskId)
      if (!task || !task.path || !sessionId || !row) return
      const metaObj = fileMeta || sf.parseMeta(row.meta)
      sf.appendMessage(task, sessionId, {
        id: row.id, role: row.role, kind: row.kind, content: row.content,
        run_id: row.run_id, created_at: row.created_at, meta: metaObj
      })
    },
    messageUpdated({ taskId, sessionId, id, patch, fileMeta }) {
      const task = taskOf(taskId)
      if (!task || !task.path || !sessionId || !id) return
      const p = { ...(patch || {}) }
      delete p.fileMeta
      if (fileMeta) p.meta = JSON.stringify(fileMeta)
      sf.appendUpdate(task, sessionId, id, p)
    },
    sessionCreated({ taskId, sessionId }) {
      const task = taskOf(taskId)
      if (!task || !task.path) return
      const s = S.getSession(sessionId)
      if (s) sf.writeMeta(task, s)
    },
    sessionUpdated({ taskId, sessionId }) {
      const task = taskOf(taskId)
      if (!task || !task.path) return
      const s = S.getSession(sessionId)
      if (s) sf.writeMeta(task, s)
    },
    sessionsDeleted({ taskId, sessionIds }) {
      const task = taskOf(taskId)
      if (!task || !task.path) return
      for (const sid of sessionIds || []) sf.removeSessionDir(task, sid)
    }
  }
}

let fileStoreInstalled = false
function installFileStore(S) {
  if (fileStoreInstalled) return
  fileStoreInstalled = true
  try { setFileStore(createFileAdapter(S)) } catch (e) { log('[zzwork] 会话落盘适配器装配失败: ' + e.message) }
}

function getStore() {
  if (instance) return instance
  instance = makeStore(log)
  installFileStore(instance)
  if (!instance.workdir) {
    const dflt = path.join(os.homedir(), 'zzwork-tasks')
    try {
      fs.mkdirSync(dflt, { recursive: true })
      instance.setSetting('workdir', dflt)
      log(`[zzwork] 默认工作目录: ${dflt}`)
    } catch {}
  }
  for (const t of instance.listTasks()) {
    if (!t.path) {
      const p = path.join(instance.workdir || os.homedir(), String(t.name || 'task').replace(/[\\/:*?"<>|]/g, '_'))
      try { fs.mkdirSync(p, { recursive: true }) } catch {}
      instance.updateTask(t.id, { path: p })
    }
    // 旧任务根目录 info.md → .zzwork/info.md（远端任务在 chat 读取时迁移）
    if (t.path && !/^ssh:\/\//i.test(t.path)) {
      try {
        const zzDir = path.join(t.path, '.zzwork')
        const legacy = path.join(t.path, 'info.md')
        const next = path.join(zzDir, 'info.md')
        if (fs.existsSync(legacy) && !fs.existsSync(next)) {
          fs.mkdirSync(zzDir, { recursive: true })
          fs.renameSync(legacy, next)
        }
      } catch {}
    }
  }
  return instance
}

function taskRoots() {
  return getStore().listTasks().map((t) => t.path).filter(Boolean)
}

const isRemoteTaskPath = (p) => /^ssh:\/\//i.test(p) || /^\\\\wsl/i.test(p)

// 迁移任务目录：默认迁移 from 下的任务；传 ids 时迁移指定任务（移动到 to/<原目录名>）
function migrateTaskDirs(payload) {
  const S = getStore()
  const p = payload || {}
  const to = p.to ? path.resolve(String(p.to)) : ''
  if (!to) throw new Error('目标工作目录无效')
  const from = p.from ? path.resolve(String(p.from)) : ''
  const ids = Array.isArray(p.ids) ? new Set(p.ids) : null
  const result = { moved: [], skipped: [] }
  const destTaken = new Set(S.listTasks().map((t) => (t.path ? path.resolve(t.path).toLowerCase() : '')))
  for (const t of S.listTasks()) {
    if (!t.path || isRemoteTaskPath(t.path)) continue
    if (ids && !ids.has(t.id)) continue
    const src = path.resolve(t.path)
    let rel = ''
    if (!ids) {
      const low = src.toLowerCase(), f = from.toLowerCase()
      if (low !== f && !low.startsWith(f + path.sep)) continue
      rel = path.relative(from, src)
      if (!rel) { result.skipped.push({ name: t.name, reason: '任务目录就是原工作目录' }); continue }
    }
    const dest = rel ? path.join(to, rel) : path.join(to, path.basename(src))
    if (destTaken.has(dest.toLowerCase())) { result.skipped.push({ name: t.name, reason: '目标已存在' }); continue }
    if (!fs.existsSync(src)) { result.skipped.push({ name: t.name, reason: '源目录不存在' }); continue }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      try {
        fs.renameSync(src, dest)
      } catch (e) {
        // 跨盘符时 Windows 无法直接 rename 目录，回退为复制 + 删除
        if (e.code !== 'EXDEV' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e
        if (fs.existsSync(dest)) throw new Error('目标已存在')
        fs.cpSync(src, dest, { recursive: true })
        fs.rmSync(src, { recursive: true, force: true })
      }
      S.updateTask(t.id, { path: dest })
      destTaken.delete(src.toLowerCase())
      destTaken.add(dest.toLowerCase())
      result.moved.push({ id: t.id, name: t.name, from: t.path, to: dest })
    } catch (e) { result.skipped.push({ name: t.name, reason: e.message }) }
  }
  return result
}

function handlers() {
  const S = () => getStore()
  return {
    'db.info': () => ({ kind: S().kind, path: S().dbPath }),

    'settings.get': (p) => S().getSetting(p.key, p.dflt),
    'settings.set': (p) => S().setSetting(p.key, p.value),
    'workdir.get': () => S().workdir,
    'workdir.migrate': (p) => migrateTaskDirs(p),

    'agents.list': () => S().listAgents(),
    'agents.save': (p) => S().saveAgents(p.list),

    'groups.list': () => S().listGroups(),
    'groups.get': (p) => S().getGroup(p.id),
    'groups.create': (p) => S().createGroup(p.name, p.parentId || ''),
    'groups.update': (p) => S().updateGroup(p.id, p.patch),
    'groups.delete': (p) => S().deleteGroup(p.id),

    'tasks.list': () => S().listTasks(),
    'tasks.get': (p) => S().getTask(p.id),
    'tasks.create': (p) => S().createTask(p.dto),
    'tasks.update': (p) => S().updateTask(p.id, p.patch),
    'tasks.delete': (p) => S().deleteTask(p.id),
    'tasks.trash': (p) => S().trashTask(p.id),
    'tasks.restore': (p) => S().restoreTask(p.id),
    'tasks.trashed': () => S().listTrashedTasks(),
    'tasks.emptyTrash': () => S().emptyTrash(),

    'messages.list': (p) => S().listMessages(p.taskId, p.sessionId),
    'messages.add': (p) => S().addMessage(p.taskId, p.role, p.content, p.opts),
    'messages.update': (p) => S().updateMessage(p.id, p.patch),

    'sessions.list': (p) => S().listSessions(p.taskId),
    'sessions.get': (p) => S().getSession(p.id),
    'sessions.create': (p) => S().createSession(p.dto),
    'sessions.update': (p) => S().updateSession(p.id, p.patch),
    'sessions.delete': (p) => S().deleteSession(p.id),
    'sessions.ensure': (p) => S().ensureSession(p.taskId),

    'runs.list': (p) => S().listRuns(p.taskId, p.sessionId),
    'runs.get': (p) => S().getRun(p.id),

    'providers.list': () => S().listProviders(),
    'providers.upsert': (p) => S().upsertProvider(p.provider),
    'providers.delete': (p) => S().deleteProvider(p.id),

    'models.list': () => S().listModels(),
    'models.upsert': (p) => S().upsertModel(p.model),
    'models.delete': (p) => S().deleteModel(p.id),

    'envs.list': () => S().listEnvironments(),
    'envs.get': (p) => S().getEnvironment(p.id),
    'envs.upsert': (p) => S().upsertEnvironment(p.env),
    'envs.delete': (p) => {
      const r = S().deleteEnvironment(p.id)
      try { require('./secrets').delete('zzwork.ssh.' + p.id) } catch {}
      return r
    },

    'skills.list': (p) => S().listSkills(p && p.envId),
    'skills.upsert': (p) => S().upsertSkill(p.skill),
    'skills.delete': (p) => S().deleteSkill(p.id),

    'mcp.list': (p) => S().listMcp(p && p.envId),
    'mcp.upsert': (p) => S().upsertMcp(p.server),
    'mcp.delete': (p) => S().deleteMcp(p.id),

    'taskSkills.excluded': (p) => S().taskExcludedSkills(p.taskId),
    'taskSkills.setExcluded': (p) => S().setTaskSkillExcluded(p.taskId, p.skillId, p.excluded),
    'taskMcp.excluded': (p) => S().taskExcludedMcp(p.taskId),
    'taskMcp.setExcluded': (p) => S().setTaskMcpExcluded(p.taskId, p.mcpId, p.excluded)
  }
}

function register(ipcMain) {
  ipcMainRef = ipcMain
  for (const [name, fn] of Object.entries(handlers())) {
    ipcMain.handle(`zz:store:${name}`, (_e, payload) => fn(payload || {}))
  }
}

module.exports = { register, getStore, log, taskRoots }
