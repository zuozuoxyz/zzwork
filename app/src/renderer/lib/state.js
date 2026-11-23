// 全局状态与事件总线（渲染层内部）
export const state = {
  view: 'projects',
  mode: 'task',        // task | item | settings | board | card
  pane: 'info',
  lastTaskPane: 'info',  // 进入看板/设置/详情前的工作区 pane，离开时恢复
  taskId: null,
  item: null,          // { kind: 'env'|'skill'|'mcp'|'model', id, label, icon }
  fileTabs: [],        // [{ path, name, dirty }]
  activeFile: null,
  inboxOpen: false,    // 需求便签 tab 是否打开（唯一）
  cardTabs: [],        // 看板卡片的对话标签 [{ id, name }]
  cardActive: null,    // 当前激活的卡片标签 id（决定 #cardChat 挂载哪张卡）
  boardCards: [],      // 看板卡片（short 任务，scope==='board'）
  filter: '',
  collapsedGroups: new Set(),

  groups: [],
  tasks: [],
  trash: [],           // 回收站中的任务
  trashOpen: false,
  envs: [],
  skills: [],
  mcp: [],
  models: [],
  providers: [],
  agents: [],
  workdir: '',
  detected: {},        // envId -> { list, at }
  envConn: {},         // envId -> { ok, message, at } 真实连接测试结果
  changes: []          // 本次会话改动的文件 [{ path, name }]
}

const subs = new Map()

export function on(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set())
  subs.get(topic).add(fn)
  return () => subs.get(topic).delete(fn)
}

export function emit(topic, payload) {
  const set = subs.get(topic)
  if (!set) return
  for (const fn of set) {
    try { fn(payload) } catch (e) { console.error('[zzwork] listener error', topic, e) }
  }
}

export function activeTask() {
  return state.tasks.find((t) => t.id === state.taskId) || null
}

export function parseJSON(s, dflt) {
  try { return JSON.parse(s) } catch { return dflt }
}

export function taskMeta(task) {
  if (!task) return {}
  return typeof task.meta === 'string' ? parseJSON(task.meta, {}) : (task.meta || {})
}

export function envById(id) {
  return state.envs.find((e) => e.id === id) || null
}

export function agentById(id) {
  return state.agents.find((a) => a.id === id) || null
}

export function modelById(id) {
  return state.models.find((m) => m.id === id) || state.models.find((m) => m.is_default) || null
}
