// 渲染层入口：启动、数据装载、视图路由
import { $, $$, refreshIcons } from './lib/ui.js'
import { store, dialog, env as envApi } from './lib/api.js'
import { state, on, emit } from './lib/state.js'
import { loadBase, reloadSkills, scanAll } from './lib/data.js'
import { initProjectsView, renderProjects } from './views/projects.js'
import { initProjectFiles, renderProjectFiles } from './views/projectFiles.js'
import { initEnvsView, renderEnvs, renderEnvDetail, loadDetectCache, refreshEnvsStatus } from './views/envs.js'
import { initSkillsView, renderSkills, renderSkillDetail } from './views/skills.js'
import { initMcpView, renderMcp, renderMcpDetail } from './views/mcp.js'
import { initModelsView, renderModels, renderModelDetail, renderProviderDetail } from './views/models.js'
import { renderSettings } from './views/settings.js'
import { initInboxView } from './views/inbox.js'
import { renderTabs, showPane } from './workbench/tabs.js'
import { renderInfo } from './workbench/info.js'
import { renderSession, initSessionView } from './workbench/session.js'
import { renderChat, refreshChatHeader, initChatView } from './workbench/chat.js'
import { openFile, activate, closeFile, closeAllFiles, restoreForTask } from './workbench/editor.js'
import { initTerminalView, attachTaskTerminal } from './workbench/terminal.js'

const ITEM_VIEW = { env: 'envs', skill: 'skills', mcp: 'mcp', model: 'models', provider: 'models' }
const ITEM_ICON = { env: 'server', skill: 'file-text', mcp: 'plug', model: 'cpu', provider: 'server' }
const ITEM_LABEL = { env: '环境', skill: 'Skill', mcp: 'MCP', model: '模型', provider: '提供方' }

function setView(v) {
  state.view = v
  $$('.abi[data-view]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-view') === v))
  $('#abSet').classList.toggle('on', v === 'settings')
  $$('.panel').forEach((p) => p.classList.toggle('on', p.id === 'panel-' + v))
}

function renderSidebars() {
  renderProjects()
  renderEnvs()
  renderSkills()
  renderMcp()
  renderModels()
}

async function selectTask(id) {
  if (!id) {
    closeAllFiles(state.taskId)
    state.taskId = null
    state.mode = 'task'
    state.item = null
    state.changes = []
    emit('changes-updated')
    renderProjects()
    renderTabs()
    await renderInfo()
    await renderSession(null)
    await renderChat(null)
    showPane('info')
    const stTask = $('#stTask')
    if (stTask) stTask.textContent = '未选择任务'
    attachTaskTerminal(null)
    await renderProjectFiles()
    return
  }
  if (id !== state.taskId) {
    const dirty = state.fileTabs.filter((t) => t.dirty)
    if (dirty.length) {
      const ok = await dialog('confirm', {
        message: '切换任务会关闭当前打开的文件，存在未保存的改动。',
        detail: dirty.map((t) => t.name).join('、')
      })
      if (!ok) return
    }
    closeAllFiles(state.taskId)
    state.changes = []
    emit('changes-updated')
  }
  state.taskId = id
  state.mode = 'task'
  state.item = null
  state.pane = 'info'
  try { await store('settings.set', { key: 'activeTaskId', value: id }) } catch {}
  renderProjects()
  await renderProjectFiles()
  await restoreForTask(id)
  await Promise.all([renderInfo(), renderSession(id), renderChat(id)])
  renderTabs()
  let autoAi = '1'
  try { autoAi = await store('settings.get', { key: 'ui:autoOpenAi', dflt: '1' }) } catch {}
  showPane(autoAi === '0' ? 'info' : 'ai')
  attachTaskTerminal(id)
}

function openItem(payload) {
  const kind = payload.kind
  const id = payload.id
  setView(ITEM_VIEW[kind] || 'projects')
  let label = ITEM_LABEL[kind] || '详情'
  if (kind === 'env') {
    const e = state.envs.find((x) => x.id === id)
    label += '：' + (e ? e.name : '')
    state.item = { kind, id, label, icon: ITEM_ICON[kind] }
    renderEnvDetail(e)
  } else if (kind === 'skill') {
    const s = state.skills.find((x) => x.id === id)
    label += '：' + (s ? s.name : '')
    state.item = { kind, id, label, icon: ITEM_ICON[kind] }
    renderSkillDetail(id)
  } else if (kind === 'mcp') {
    const m = state.mcp.find((x) => x.id === id)
    label += '：' + (m ? m.name : '')
    state.item = { kind, id, label, icon: ITEM_ICON[kind] }
    renderMcpDetail(id)
  } else if (kind === 'model') {
    const m = state.models.find((x) => x.id === id)
    label += '：' + (m ? m.name : '')
    state.item = { kind, id, label, icon: ITEM_ICON[kind] }
    renderModelDetail(id)
  } else if (kind === 'provider') {
    const p = state.providers.find((x) => x.id === id)
    label += '：' + (p ? p.name : '')
    state.item = { kind, id, label, icon: ITEM_ICON[kind] }
    renderProviderDetail(id)
  }
  state.mode = 'item'
  renderTabs()
  showPane('item')
}

function closeItem() {
  state.mode = 'task'
  state.item = null
  renderTabs()
  showPane('info')
}

function openInbox() {
  state.inboxOpen = true
  state.mode = 'task'
  state.item = null
  showPane('inbox')
  renderTabs()
}

function closeInbox() {
  state.inboxOpen = false
  showPane('info')
  renderTabs()
}

function openSettings() {
  state.mode = 'settings'
  setView('settings')
  renderTabs()
  showPane('settings')
  renderSettings()
}

function bindEvents() {
  $$('.abi[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-view')
      setView(v)
      if (v === 'projects' && state.mode === 'item') closeItem()
    })
  })
  $('#abSet').addEventListener('click', openSettings)
  $('#setGeneralRow').addEventListener('click', openSettings)
  $('#setAboutRow').addEventListener('click', openSettings)

  const filterInput = $('#cmdInput')
  filterInput.addEventListener('input', () => {
    state.filter = filterInput.value
    renderSidebars()
  })
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { filterInput.value = ''; state.filter = ''; renderSidebars(); filterInput.blur() }
  })

  on('select-task', selectTask)
  on('open-item', openItem)
  on('close-item', closeItem)
  on('open-inbox', openInbox)
  on('close-inbox', closeInbox)
  on('open-settings', openSettings)
  on('tabs-changed', renderTabs)
  on('file-activate', (p) => { if (p) activate(p) })
  on('file-close', (p) => { if (p) closeFile(p) })
  on('open-file', (p) => { if (p) openFile(p.path, p.name) })
  on('tasks-changed', async () => {
    renderProjects()
    if (state.taskId) await renderInfo()
  })
  on('data-scanned', () => renderSidebars())
  on('task-updated', async (id) => {
    if (id && id !== state.taskId) return
    if (state.taskId) {
      await renderChat(state.taskId)
      await renderInfo()
    }
  })
  on('pane-changed', (name) => {
    if (name === 'ai' && state.taskId) refreshChatHeader()
  })
  on('open-session', async ({ taskId, sessionId } = {}) => {
    if (!taskId) return
    if (state.taskId !== taskId) {
      await selectTask(taskId)
      if (sessionId) await renderChat(taskId, sessionId)
    } else if (sessionId) {
      await renderChat(taskId, sessionId)
    }
    showPane('ai')
  })
}

async function boot() {
  initProjectsView()
  initProjectFiles()
  initEnvsView()
  initSkillsView()
  initMcpView()
  initModelsView()
  initSessionView()
  initChatView()
  initInboxView()
  initTerminalView()
  bindEvents()

  try {
    await loadBase()
  } catch (e) {
    $('#projectsBody').innerHTML = `<div class="err" style="margin:10px">数据层加载失败：${String(e.message || e)}</div>`
    refreshIcons()
    return
  }

  // 启动时先用本机缓存快速出结果，稍后在后台刷新远端环境
  try { await envApi('scan', { remote: false }); await reloadSkills() } catch {}
  try { await loadDetectCache() } catch {}

  renderSidebars()
  setView('projects')

  let last = ''
  try { last = await store('settings.get', { key: 'activeTaskId', dflt: '' }) } catch {}
  const exists = state.tasks.some((t) => t.id === last)
  const first = exists ? last : (state.tasks[0] && state.tasks[0].id)
  if (first) await selectTask(first)
  else await selectTask(null)

  refreshIcons()

  // 后台刷新远端 Skills 与各环境执行体状态，不阻塞界面
  ;(async () => {
    try { await scanAll() } catch {}
    emit('data-scanned')
    try { await refreshEnvsStatus() } catch {}
  })()
}

boot()
