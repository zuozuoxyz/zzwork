// zzwork 主扩展：任务树 / 命令 / 面板接线
const vscode = require('vscode')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { makeStore } = require('./store')
const { openChat } = require('./aiPanel')
const { TaskDetailProvider } = require('./taskPanel')
const { openTaskWorkbench, refreshWorkbench, setRefreshHook, setStoreRef } = require('./workbench')
const { scanSkills, scanMcp, resolveTaskEnv, listWslDistros, clearCache, GLOBAL_ENV } = require('./envs')
const { initSettings } = require('./settingsPanel')
const { openModels } = require('./modelsPanel')

let store, secrets, detailProvider, statusItem, treeView, treeEmitter, contextRef

function log(msg) {
  console.log(msg)
  try { fs.appendFileSync('D:/zzwork-storage.log', `${new Date().toISOString()} ${msg}\n`) } catch {}
}

function refreshTree() { treeEmitter && treeEmitter.fire() }

// ---------- 任务树 ----------
class TaskNode extends vscode.TreeItem {
  constructor(task) {
    super(task.name, vscode.TreeItemCollapsibleState.None)
    this.task = task
    this.contextValue = 'task-' + task.type
    this.iconPath = new vscode.ThemeIcon(task.status === 'done' ? 'pass-filled' : (task.type === 'code' ? 'repo' : 'notebook'))
    const agent = store.listAgents().find((a) => a.id === task.agent_id)
    this.description = `${task.type}${task.status === 'done' ? ' · 已完成' : ''}${agent && agent.id !== 'builtin' ? ' · ' + agent.name : ''}`
    this.tooltip = `${task.name}\n类型 ${task.type} · 状态 ${task.status}\n${task.path}`
    this.command = { command: 'zzwork.selectTask', title: '打开任务', arguments: [task] }
  }
}

class TasksProvider {
  getChildren(el) {
    if (!el) {
      const groups = store.listGroups()
      const tasks = store.listTasks()
      const groupIds = new Set(groups.map((g) => g.id))
      const ungrouped = tasks.filter((t) => !t.group_id || !groupIds.has(t.group_id))
      const items = []
      for (const g of groups) {
        const it = new vscode.TreeItem(`🗂 ${g.name}`, vscode.TreeItemCollapsibleState.Expanded)
        it.contextValue = 'zzgroup'
        it.groupId = g.id
        it.tooltip = '右键：删除组 / 新建任务'
        items.push(it)
      }
      if (ungrouped.length) {
        const it = new vscode.TreeItem('🗒 未分组', vscode.TreeItemCollapsibleState.Expanded)
        it.contextValue = 'ungrouped'
        items.push(it)
      }
      return items
    }
    if (el.contextValue === 'zzgroup') return store.listTasks().filter((t) => t.group_id === el.groupId).map((t) => new TaskNode(t))
    if (el.contextValue === 'ungrouped') {
      const groups = store.listGroups()
      const ids = new Set(groups.map((g) => g.id))
      return store.listTasks().filter((t) => !t.group_id || !ids.has(t.group_id)).map((t) => new TaskNode(t))
    }
    return []
  }
  getTreeItem(el) { return el }
}

// ---------- 环境 / Skills / MCP / 模型 视图 ----------
const envAgents = new Map() // envId -> [{name, ok, version}]

class EnvProvider {
  getChildren(el) {
    if (!el) {
      return store.listEnvironments().map((e) => {
        const it = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.Collapsed)
        it.id = 'env:' + e.id
        it.contextValue = 'zzenv'
        it.envRecord = e
        it.description = (e.kind === 'local' ? '本地' : e.kind.toUpperCase()) + (e.id === 'local' ? ' · 默认' : '')
        it.iconPath = new vscode.ThemeIcon(e.kind === 'local' ? 'device-desktop' : e.kind === 'wsl' ? 'terminal' : 'remote')
        it.tooltip = `${e.name}\n类型 ${e.kind}`
        return it
      })
    }
    const agents = (envAgents.get(el.envRecord.id) || []).filter((a) => a.ok)
    if (!agents.length) return [new vscode.TreeItem('（未检测到已安装的执行体）', vscode.TreeItemCollapsibleState.None)]
    return agents.map((a) => {
      const it = new vscode.TreeItem(a.name, vscode.TreeItemCollapsibleState.None)
      it.description = a.version ? String(a.version).trim().slice(0, 24) : '已安装'
      it.iconPath = new vscode.ThemeIcon('pass-filled')
      it.contextValue = 'zzagent'
      it.tooltip = `${a.name}${a.path ? '\n' + a.path : ''}`
      return it
    })
  }
  getTreeItem(el) { return el }
}

class SkillProvider {
  getChildren(el) {
    if (!el) {
      return store.listSkills(GLOBAL_ENV).map((sk) => {
        const it = new vscode.TreeItem(sk.name, vscode.TreeItemCollapsibleState.None)
        it.id = 'skill:' + sk.id
        it.contextValue = 'zzskill'
        it.skill = sk
        it.description = sk.description ? String(sk.description).slice(0, 40) : ''
        it.tooltip = sk.name + '\n' + sk.path + '\n' + (sk.description || '')
        it.iconPath = new vscode.ThemeIcon('file-text')
        it.command = { command: 'zzwork.openSkill', title: '打开', arguments: [it] }
        return it
      })
    }
    return []
  }
  getTreeItem(el) { return el }
}

class McpProvider {
  getChildren(el) {
    if (!el) {
      return store.listMcp(GLOBAL_ENV).map((m) => {
        let last = null
        try { last = JSON.parse(m.config || '{}').lastTest || null } catch {}
        const it = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None)
        it.id = 'mcp:' + m.id
        it.contextValue = 'zzmcp'
        it.mcp = m
        it.description = m.type + (last ? (last.ok ? ' · ✓ ' + last.tools + ' tools' : ' · ✗') : '')
        it.tooltip = m.name + ' (' + m.type + ')\n来源 ' + (m.origin_path || m.source) + (last ? '\n' + (last.ok ? '握手成功，' + last.tools + ' 个工具' : '失败: ' + last.error) : '')
        it.iconPath = new vscode.ThemeIcon(last ? (last.ok ? 'pass-filled' : 'error') : 'plug')
        it.command = { command: 'zzwork.testMcp', title: '测试连接', arguments: [it] }
        return it
      })
    }
    return []
  }
  getTreeItem(el) { return el }
}

class ModelProvider {
  getChildren() {
    return store.listModels().map((m) => {
      const it = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None)
      it.id = 'model:' + m.id
      it.contextValue = 'zzmodel'
      it.model = m
      it.description = `${m.type === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}${m.is_default ? ' · 默认' : ''}`
      it.tooltip = `${m.name}\n${m.base_url}\n${m.model_id}`
      it.iconPath = new vscode.ThemeIcon(m.is_default ? 'star-full' : 'chip')
      it.command = { command: 'zzwork.useModel', title: '模型操作', arguments: [it] }
      return it
    })
  }
  getTreeItem(el) { return el }
}

let envView, skillView, mcpView, modelView
let treeEmitters = {}

function fireTree(name) { treeEmitters[name] && treeEmitters[name].fire() }

async function detectEnvAgents(envRecord) {
  const { detectAgents } = require('./agentRunner')
  const env = {
    kind: envRecord.kind,
    distro: (envRecord.config || {}).distro,
    host: (envRecord.config || {}).host,
    where: 'auto',
  }
  const ids = await detectAgents(env)
  const { KNOWN_AGENTS } = require('./agentRunner')
  const list = KNOWN_AGENTS.map((a) => ({ id: a.id, name: a.name || a.id, ok: ids.includes(a.id) }))
  envAgents.set(envRecord.id, list.filter((a) => a.ok).concat(list.filter((a) => !a.ok)))
}

async function detectAllEnvs() {
  for (const e of store.listEnvironments()) {
    try { await detectEnvAgents(e) } catch {}
  }
  fireTree('envs')
}


function getActiveTask() {
  const id = store.getSetting('activeTaskId', '')
  return (id && store.getTask(id)) || null
}

async function setActiveTask(task) {
  store.setSetting('activeTaskId', task.id)
  updateStatus()
  scanTaskMcp(task)
  try { await openTaskWorkbench(contextRef, store, secrets, task.id) } catch (e) { log('[zzwork] 工作台打开失败: ' + e.message) }
}

// ---------- 环境扫描 ----------
async function scanEnvironment() {
  try {
    const list = await scanSkills()
    for (const sk of list) {
      store.upsertSkill({ env_id: GLOBAL_ENV, name: sk.name, path: sk.path, source: 'user', description: sk.description })
    }
    log('[zzwork] 全局 skills 扫到 ' + list.length + ' 个')
  } catch (e) { log('[zzwork] skill 扫描失败: ' + e.message) }
}

async function scanTaskMcp(task) {
  if (!task) return
  try {
    const list = await scanMcp(task.path)
    for (const m of list) {
      store.upsertMcp({ env_id: GLOBAL_ENV, name: m.name, type: m.type, config: m.config, source: m.source, origin_path: m.origin_path })
    }
    detailProvider && detailProvider.push()
  } catch (e) { log('[zzwork] mcp 扫描失败: ' + e.message) }
}

async function scanAll() {
  await scanEnvironment()
  await scanTaskMcp(getActiveTask())
  refreshTree()
  fireTree('skills'); fireTree('mcp'); fireTree('envs')
  detailProvider && detailProvider.push()
}

function updateStatus() {
  const task = getActiveTask()
  if (!task) { statusItem.hide(); return }
  const todos = store.listTodos(task.id)
  const done = todos.filter((t) => t.status === 'done').length
  statusItem.text = `$(checklist) ${task.name} ${done}/${todos.length}`
  statusItem.tooltip = `任务「${task.name}」todo 完成 ${done}/${todos.length}`
  statusItem.show()
}

// ---------- 命令 ----------
function pickGroup() {
  const groups = store.listGroups()
  return vscode.window.showQuickPick(
    [{ label: '（不分组）', id: null }, ...groups.map((g) => ({ label: g.name, id: g.id }))],
    { placeHolder: '选择所属组（Esc 跳过）' })
}

async function pickType() {
  return vscode.window.showQuickPick(
    [{ label: 'work · 临时 / 简短任务', value: 'work' }, { label: 'code · 代码仓库 / 项目', value: 'code' }],
    { placeHolder: '任务类型' })
}

async function newTaskAt(groupId) {
  if (!store.workdir) {
    vscode.window.showWarningMessage('请先设置工作目录')
    return vscode.commands.executeCommand('zzwork.setWorkdir')
  }
  const name = await vscode.window.showInputBox({ placeHolder: '任务名（将创建同名文件夹）' })
  if (!name) return
  const type = await pickType()
  if (!type) return
  let dir = path.join(store.workdir, name.replace(/[\\/:*?"<>|]/g, '_'))
  let i = 1
  while (fs.existsSync(dir)) dir = path.join(store.workdir, `${name}(${++i})`)
  fs.mkdirSync(dir, { recursive: true })
  const task = store.createTask({ name, type: type.value, groupId: groupId || null, path: dir })
  refreshTree(); setActiveTask(task)
  vscode.window.showInformationMessage(`已创建任务「${name}」→ ${dir}`)
}

async function importTask() {
  const picks = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: '选择任务文件夹' })
  if (!picks || !picks.length) return
  const type = await pickType()
  if (!type) return
  const g = await pickGroup()
  const dir = picks[0].fsPath
  const task = store.createTask({ name: path.basename(dir), type: type.value, groupId: g && g.id, path: dir })
  refreshTree(); setActiveTask(task)
  vscode.window.showInformationMessage(`已导入任务「${task.name}」`)
}

async function moveTask(task) {
  const groups = store.listGroups()
  const pick = await vscode.window.showQuickPick(
    [{ label: '（无组）', id: null }, ...groups.map((g) => ({ label: g.name, id: g.id }))], { placeHolder: '移动到组' })
  if (!pick) return
  store.updateTask(task.id, { group_id: pick.id })
  refreshTree()
}

async function deleteTask(task) {
  const pick = await vscode.window.showWarningMessage(`删除任务「${task.name}」？（只删除记录，文件夹保留在磁盘上）`, '删除', '取消')
  if (pick !== '删除') return
  store.deleteTask(task.id)
  if (store.getSetting('activeTaskId', '') === task.id) store.setSetting('activeTaskId', '')
  refreshTree(); detailProvider && detailProvider.push(); updateStatus()
}

function activate(context) {
  secrets = context.secrets
  store = makeStore(log)
  if (!store.workdir) {
    const dflt = path.join(os.homedir(), 'zzwork-tasks')
    try { fs.mkdirSync(dflt, { recursive: true }); store.setSetting('workdir', dflt); log(`[zzwork] 默认工作目录: ${dflt}`) } catch {}
  }
  log(`[zzwork] 工作目录: ${store.workdir}`)
  // 自愈：迁移来的任务可能没有 path，指到 工作目录/任务名 并建目录
  for (const t of store.listTasks()) {
    if (!t.path) {
      const p = path.join(store.workdir || os.homedir(), String(t.name || 'task').replace(/[\\/:*?"<>|]/g, '_'))
      try { fs.mkdirSync(p, { recursive: true }) } catch {}
      store.updateTask(t.id, { path: p })
      log('[zzwork] 已补任务路径: ' + t.name + ' -> ' + p)
    }
  }

  treeEmitter = new vscode.EventEmitter()
  const provider = new TasksProvider()
  provider.onDidChangeTreeData = treeEmitter.event
  treeView = vscode.window.createTreeView('zzwork.tasks', { treeDataProvider: provider })
  context.subscriptions.push(treeView)

  const mkTree = (key, prov) => {
    const em = new vscode.EventEmitter()
    treeEmitters[key] = em
    prov.onDidChangeTreeData = em.event
    const v = vscode.window.createTreeView('zzwork.' + key, { treeDataProvider: prov })
    context.subscriptions.push(v)
    return v
  }
  envView = mkTree('envs', new EnvProvider())
  skillView = mkTree('skills', new SkillProvider())
  mcpView = mkTree('mcp', new McpProvider())
  modelView = mkTree('models', new ModelProvider())
  const { SettingsView } = require('./settingsPanel')
  initSettings(store, () => refreshTree())
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('zzwork.settings', new SettingsView(), { webviewOptions: { retainContextWhenHidden: true } }))

  contextRef = context
  setStoreRef(store)
  setRefreshHook(() => { refreshTree(); updateStatus(); fireTree('skills'); fireTree('mcp') })
  detailProvider = { push: () => { try { refreshWorkbench() } catch {} } }

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  statusItem.command = 'zzwork.showDetail'
  context.subscriptions.push(statusItem)
  updateStatus()

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  reg('zzwork.refresh', () => { refreshTree(); detailProvider && detailProvider.push() })
  reg('zzwork.newFileInTask', async (taskArg) => {
    const task = taskArg || getActiveTask()
    if (!task) { vscode.window.showWarningMessage('先选择一个任务'); return }
    // 与原生一致：在资源管理器里定位任务目录后触发内联"新建文件"
    try {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(task.path))
      await vscode.commands.executeCommand('focusFoldersView')
      await vscode.commands.executeCommand('explorer.newFile')
      return
    } catch {}
    // 兜底：输入框创建
    const name = await vscode.window.showInputBox({ placeHolder: '文件名（可含子目录）' })
    if (!name) return
    const p = path.join(task.path, name)
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      if (!fs.existsSync(p)) fs.writeFileSync(p, '')
      detailProvider && detailProvider.push()
      vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p))
    } catch (e) { vscode.window.showErrorMessage('创建失败: ' + e.message) }
  })
  reg('zzwork.newFolderInTask', async (taskArg) => {
    const task = taskArg || getActiveTask()
    if (!task) { vscode.window.showWarningMessage('先选择一个任务'); return }
    try {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(task.path))
      await vscode.commands.executeCommand('focusFoldersView')
      await vscode.commands.executeCommand('explorer.newFolder')
      return
    } catch {}
    const name = await vscode.window.showInputBox({ placeHolder: '文件夹名' })
    if (!name) return
    try { fs.mkdirSync(path.join(task.path, name), { recursive: true }); detailProvider && detailProvider.push() } catch (e) { vscode.window.showErrorMessage('创建失败: ' + e.message) }
  })
  reg('zzwork.rescan', async () => { clearCache(); await scanAll(); await detectAllEnvs(); vscode.window.showInformationMessage('已重新扫描环境') })
  reg('zzwork.addSkill', async () => {
    const envs = store.listEnvironments()
    const envPick = await vscode.window.showQuickPick(envs.map((e) => ({ label: e.name, id: e.id })), { placeHolder: '为哪个环境添加 Skill' })
    if (!envPick) return
    const picks = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: '选择包含 SKILL.md 的目录' })
    if (!picks || !picks.length) return
    const dir = picks[0].fsPath
    const file = path.join(dir, 'SKILL.md')
    if (!fs.existsSync(file)) { vscode.window.showWarningMessage('该目录下没有 SKILL.md'); return }
    const name = await vscode.window.showInputBox({ placeHolder: 'Skill 名称', value: path.basename(dir) })
    if (!name) return
    store.upsertSkill({ env_id: envPick.id, name, path: file, source: 'user', description: '' })
    detailProvider && detailProvider.push()
    vscode.window.showInformationMessage(`已添加 Skill「${name}」`)
  })
  reg('zzwork.addMcp', async () => {
    const envs = store.listEnvironments()
    const envPick = await vscode.window.showQuickPick(envs.map((e) => ({ label: e.name, id: e.id })), { placeHolder: '为哪个环境添加 MCP 服务' })
    if (!envPick) return
    const name = await vscode.window.showInputBox({ placeHolder: '服务名称（如 filesystem）' })
    if (!name) return
    const typePick = await vscode.window.showQuickPick([{ label: 'stdio（本机进程）', value: 'stdio' }, { label: 'http（远程服务）', value: 'http' }], { placeHolder: '传输方式' })
    if (!typePick) return
    const detail = await vscode.window.showInputBox({
      placeHolder: typePick.value === 'stdio' ? '启动命令（如 npx -y @modelcontextprotocol/server-filesystem D:\\work）' : '服务 URL',
    })
    if (!detail) return
    const config = typePick.value === 'stdio' ? { command: detail } : { url: detail }
    store.upsertMcp({ env_id: envPick.id, name, type: typePick.value, config, source: 'user', origin_path: 'user' })
    detailProvider && detailProvider.push()
    fireTree('mcp')
    vscode.window.showInformationMessage(`已添加 MCP「${name}」`)
  })

  // ---------- 环境 ----------
  reg('zzwork.addEnv', async () => {
    const kind = await vscode.window.showQuickPick(
      [{ label: '本地', value: 'local' }, { label: 'WSL', value: 'wsl' }, { label: 'SSH', value: 'ssh' }], { placeHolder: '环境类型' })
    if (!kind) return
    const name = await vscode.window.showInputBox({ placeHolder: '环境名称' })
    if (!name) return
    const config = {}
    if (kind.value === 'wsl') {
      let distros = []
      try { distros = await listWslDistros() } catch {}
      let distro
      if (distros.length) {
        const pick = await vscode.window.showQuickPick(distros.map((d) => ({ label: d })), { placeHolder: '选择 WSL 发行版' })
        if (!pick) return
        distro = pick.label
      } else {
        distro = await vscode.window.showInputBox({ placeHolder: 'WSL 发行版（未自动检测到，手动输入）' })
        if (!distro) return
      }
      config.distro = distro
    } else if (kind.value === 'ssh') {
      const host = await vscode.window.showInputBox({ placeHolder: '主机地址（如 10.0.0.21）' })
      if (!host) return
      const user = await vscode.window.showInputBox({ placeHolder: '用户名（可留空）' })
      config.host = host
      config.user = user || ''
    }
    store.upsertEnvironment({ name, kind: kind.value, config })
    const envs = store.listEnvironments()
    const created = envs[envs.length - 1]
    fireTree('envs'); fireTree('skills'); fireTree('mcp')
    if (created) {
      try { await detectEnvAgents(created) } catch {}
      fireTree('envs')
      const { clearCache } = require('./envs')
      clearCache()
      scanEnvironment().then(() => { fireTree('skills'); detailProvider && detailProvider.push() })
    }
    vscode.window.showInformationMessage(`已添加环境「${name}」，正在识别执行体`)
  })

  reg('zzwork.deleteEnv', async (item) => {
    const e = item && item.envRecord
    if (!e) return
    if (e.id === 'local') { vscode.window.showWarningMessage('本地环境不能删除'); return }
    const pick = await vscode.window.showWarningMessage(`删除环境「${e.name}」？`, '删除', '取消')
    if (pick !== '删除') return
    store.deleteEnvironment(e.id)
    fireTree('envs'); fireTree('skills'); fireTree('mcp')
  })

  // ---------- Skills ----------
  reg('zzwork.openSkill', (item) => {
    const s = item && item.skill
    if (s && fs.existsSync(s.path)) vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(s.path))
  })
  reg('zzwork.deleteSkill', async (item) => {
    const s = item && item.skill
    if (!s) return
    const pick = await vscode.window.showWarningMessage(`移除 Skill「${s.name}」？${s.source !== 'user' ? '（重新扫描会再次出现）' : ''}`, '移除', '取消')
    if (pick !== '移除') return
    store.deleteSkill(s.id)
    fireTree('skills')
  })

  // ---------- MCP ----------
  reg('zzwork.testMcp', async (item) => {
    const m = item && item.mcp
    if (!m) return
    const { testMcp } = require('./mcpTest')
    const cfg = (() => { try { return JSON.parse(m.config || '{}') } catch { return {} } })()
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `测试 ${m.name}…` }, async () => {
      const res = await testMcp({ name: m.name, type: m.type, config: cfg })
      cfg.lastTest = { ok: !!res.ok, tools: res.tools || 0, toolNames: res.toolNames || [], error: res.error || '', at: new Date().toISOString() }
      store.upsertMcp({ env_id: m.env_id, name: m.name, type: m.type, config: cfg, source: m.source, origin_path: m.origin_path })
      fireTree('mcp')
      if (res.ok) vscode.window.showInformationMessage(`${m.name}：连接成功，发现 ${res.tools} 个工具`)
      else vscode.window.showErrorMessage(`${m.name}：${res.error}`)
    })
  })
  reg('zzwork.deleteMcp', async (item) => {
    const m = item && item.mcp
    if (!m) return
    const pick = await vscode.window.showWarningMessage(`删除 MCP「${m.name}」？`, '删除', '取消')
    if (pick !== '删除') return
    store.deleteMcp(m.id)
    fireTree('mcp'); detailProvider && detailProvider.push()
  })

  // ---------- 模型 ----------
  reg('zzwork.addModel', () => openModels(store, secrets, () => fireTree('models')))
  reg('zzwork.setDefaultModel', (item) => {
    const m = item && item.model
    if (!m) return
    const models = store.listModels()
    for (const x of models) store.upsertModel({ ...x, is_default: x.id === m.id })
    fireTree('models')
    vscode.window.showInformationMessage(`默认模型：${m.name}`)
  })
  reg('zzwork.setModelKey', async (item) => {
    const m = item && item.model
    if (!m) return
    const key = await vscode.window.showInputBox({ placeHolder: `${m.name} 的 API Key`, password: true })
    if (!key) return
    await secrets.store('zzwork.key.' + m.id, key)
    vscode.window.showInformationMessage('已保存 API Key')
  })
  reg('zzwork.deleteModel', async (item) => {
    const m = item && item.model
    if (!m) return
    const pick = await vscode.window.showWarningMessage(`删除模型「${m.name}」？`, '删除', '取消')
    if (pick !== '删除') return
    store.deleteModel(m.id)
    fireTree('models')
  })
  reg('zzwork.useModel', () => openModels(store, secrets, () => fireTree('models')))
  reg('zzwork.setWorkdir', () => vscode.commands.executeCommand('zzwork.settings.focus'))
  reg('zzwork.newGroup', async () => {
    const name = await vscode.window.showInputBox({ placeHolder: '组名（如：日常 / 客户A）' })
    if (!name) return
    store.createGroup(name); refreshTree()
  })
  reg('zzwork.deleteGroup', async (item) => {
    if (!item || !item.groupId) return
    const g = store.listGroups().find((x) => x.id === item.groupId)
    const pick = await vscode.window.showWarningMessage(`删除组「${g ? g.name : ''}」？组内任务移到未分组`, '删除', '取消')
    if (pick !== '删除') return
    store.deleteGroup(item.groupId); refreshTree()
  })
  reg('zzwork.newTask', (item) => newTaskAt(item && item.groupId))
  reg('zzwork.importTask', () => importTask())
  reg('zzwork.selectTask', (task) => { setActiveTask(task); refreshTree() })
  reg('zzwork.openAI', async (taskId) => {
    const id = typeof taskId === 'string' ? taskId : (getActiveTask() || {}).id
    if (!id) return
    await openTaskWorkbench(context, store, secrets, id)
    openChat(context, store, secrets, id, { title: 'AI 对话' })
  })
  reg('zzwork.showDetail', async () => {
    const t = getActiveTask()
    if (t) await openTaskWorkbench(context, store, secrets, t.id)
    refreshWorkbench()
  })
  reg('zzwork.renameTask', async (task) => {
    const name = await vscode.window.showInputBox({ placeHolder: '新任务名', value: task.name })
    if (!name) return
    store.updateTask(task.id, { name }); refreshTree(); detailProvider && detailProvider.push(); updateStatus()
  })
  reg('zzwork.moveTask', moveTask)
  reg('zzwork.deleteTask', deleteTask)
  reg('zzwork.setStatus', (task) => {
    store.updateTask(task.id, { status: task.status === 'done' ? 'active' : 'done' })
    refreshTree(); detailProvider && detailProvider.push(); updateStatus()
  })
  reg('zzwork.openFolder', (task) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(task.path), false))
  reg('zzwork.openInExplorer', (task) => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(task.path)))

  log('[zzwork] extension activated')
  scanAll().then(() => detectAllEnvs()).catch((e) => log('[zzwork] 初始扫描失败: ' + e.message))
}

function deactivate() {}

module.exports = { activate, deactivate }
