// 全局状态与事件总线（渲染层内部）
export const state = {
  view: 'projects',
  mode: 'task',        // task | item | settings
  pane: 'info',
  taskId: null,
  item: null,          // { kind: 'env'|'skill'|'mcp'|'model', id, label, icon }
  fileTabs: [],        // [{ path, name, dirty }]
  activeFile: null,
  inboxOpen: false,    // 需求便签 tab 是否打开（唯一）
  filter: '',
  collapsedGroups: new Set(),

  groups: [],
  tasks: [],
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
