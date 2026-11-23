// 数据装载：从主进程拉取各域数据并写入 state
import { store, env as envApi, invoke } from './api.js'
import { state, parseJSON } from './state.js'

export async function loadBase() {
  const [groups, tasks, trashed, envs, skills, mcp, models, providers, agents, workdir] = await Promise.all([
    store('groups.list'), store('tasks.list'), store('tasks.trashed'), store('envs.list'), store('skills.list'),
    store('mcp.list'), store('models.list'), store('providers.list'), store('agents.list'), store('workdir.get')
  ])
  state.groups = groups || []
  state.tasks = (tasks || []).map((t) => ({ ...t, meta: typeof t.meta === 'string' ? parseJSON(t.meta, {}) : (t.meta || {}) }))
  state.trash = (trashed || []).map((t) => ({ ...t, meta: typeof t.meta === 'string' ? parseJSON(t.meta, {}) : (t.meta || {}) }))
  state.envs = (envs || []).map((e) => ({ ...e, config: typeof e.config === 'string' ? parseJSON(e.config, {}) : (e.config || {}) }))
  state.skills = skills || []
  state.mcp = (mcp || []).map((m) => ({ ...m, config: typeof m.config === 'string' ? parseJSON(m.config, {}) : (m.config || {}) }))
  state.models = models || []
  state.providers = providers || []
  state.agents = agents || []
  state.workdir = workdir || ''
}

export async function reloadTasks() {
  state.tasks = (await store('tasks.list') || []).map((t) => ({ ...t, meta: typeof t.meta === 'string' ? parseJSON(t.meta, {}) : (t.meta || {}) }))
}

export async function reloadTrash() {
  state.trash = await store('tasks.trashed') || []
}

export async function reloadGroups() {
  state.groups = await store('groups.list') || []
}

export async function reloadBoard() {
  state.boardCards = (await invoke('board', 'list')) || []
}

export async function reloadEnvs() {
  state.envs = (await store('envs.list') || []).map((e) => ({ ...e, config: typeof e.config === 'string' ? parseJSON(e.config, {}) : (e.config || {}) }))
}

export async function reloadSkills() {
  state.skills = await store('skills.list') || []
}

export async function reloadMcp() {
  state.mcp = (await store('mcp.list') || []).map((m) => ({ ...m, config: typeof m.config === 'string' ? parseJSON(m.config, {}) : (m.config || {}) }))
}

export async function reloadModels() {
  state.models = await store('models.list') || []
}

export async function reloadProviders() {
  state.providers = await store('providers.list') || []
}

export async function scanAll() {
  await envApi('scan')
  await Promise.all([reloadSkills(), reloadMcp()])
}
