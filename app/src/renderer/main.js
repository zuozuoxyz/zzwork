// 渲染层入口：启动、数据装载、视图路由
import { $, $$, refreshIcons } from './lib/ui.js'
import { store, dialog, env as envApi, fsapi } from './lib/api.js'
import { state, on, emit } from './lib/state.js'
import { loadBase, reloadSkills, scanAll } from './lib/data.js'
import { initProjectsView, renderProjects } from './views/projects.js'
import { initProjectFiles, renderProjectFiles } from './views/projectFiles.js'
import { initEnvsView, renderEnvs, renderEnvDetail, loadDetectCache, refreshEnvsStatus } from './views/envs.js'
import { initSkillsView, renderSkills, renderSkillDetail } from './views/skills.js'
import { initMcpView, renderMcp, renderMcpDetail } from './views/mcp.js'
import { initModelsView, renderModels, renderModelDetail, renderProviderDetail } from './views/models.js'
import { renderSettings } from './views/settings.js'
import { initInboxView, renderInboxBoard, renderInboxCode } from './views/inbox.js'
import { renderBoard, initBoardView, mountCardChat } from './views/board.js'
import { renderTabs, showPane } from './workbench/tabs.js'
import { renderInfo } from './workbench/info.js'
import { renderSession, initSessionView } from './workbench/session.js'
import { renderChat, refreshChatHeader, initChatView } from './workbench/chat.js'
import { openFile, activate, closeFile, closeAllFiles, restoreForTask } from './workbench/editor.js'
import { renderFileTree } from './workbench/fileTree.js'
import { initTerminalView, attachTaskTerminal } from './workbench/terminal.js'
import { initUpdate } from './update.js'

const ITEM_VIEW = { env: 'envs', skill: 'skills', mcp: 'mcp', model: 'models', provider: 'models' }
const ITEM_ICON = { env: 'server', skill: 'file-text', mcp: 'plug', model: 'cpu', provider: 'server' }
const ITEM_LABEL = { env: '环境', skill: 'Skill', mcp: 'MCP', model: '模型', provider: '提供方' }

function setView(v) {
  state.view = v
  $$('.abi[data-view]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-view') === v))
  $('#abSet').classList.toggle('on', v === 'settings')
  $$('.panel').forEach((p) => p.classList.toggle('on', p.id === 'panel-' + v))
}

const TASK_PANES = new Set(['info', 'session', 'ai', 'file'])
// 进入看板/设置/详情等整页模式前，记住当前任务工作区 pane，离开时回到它
function rememberTaskPane() {
  if (TASK_PANES.has(state.pane)) state.lastTaskPane = state.pane
}

// 当前挂载在 #cardChat 的卡片对话清理函数（切换/关闭卡片标签时释放订阅）
let cardChatCleanup = null
function cleanupCardChat() {
  if (cardChatCleanup) { try { cardChatCleanup() } catch {} ; cardChatCleanup = null }
}
function cardById(id) {
  return state.boardCards.find((c) => c.id === id) || state.tasks.find((t) => t.id === id) || null
}
// 离开看板上下文（进入设置/详情/便签/切换任务）时放弃卡片标签，避免其残留后再次出现
function abandonCardTabs() {
  if (!state.cardTabs.length && state.cardActive == null) return
  cleanupCardChat()
  state.cardTabs = []
  state.cardActive = null
  closeAllFiles() // 丢弃卡片工作目录里打开的临时文件标签
}
// 把某张卡片的 AI 对话挂载到编辑区 #cardChat；工作目录树显示在左侧系统侧栏
function mountActiveCard(card, preset) {
  const chatHost = $('#cardChat')
  if (!chatHost) return
  cleanupCardChat()
  cardChatCleanup = mountCardChat(chatHost, card, preset)
}

// 左侧栏在「看板配置」与「卡片工作目录树」之间切换：只有看板页面才显示模型/执行体等配置
function showBoardSideConfig() {
  const cfg = $('#boardSideBody'), files = $('#boardSideFiles')
  if (cfg) cfg.style.display = ''
  if (files) files.style.display = 'none'
  const t = $('#boardPheadTitle'); if (t) t.textContent = '看板'
  const nb = $('#boardNewBtn'); if (nb) nb.style.display = ''
  const rb = $('#boardRefreshBtn'); if (rb) rb.style.display = ''
}
function showBoardSideFiles(card) {
  if (!card) return
  const cfg = $('#boardSideBody'), files = $('#boardSideFiles')
  if (cfg) cfg.style.display = 'none'
  if (files) files.style.display = ''
  const t = $('#boardPheadTitle'); if (t) t.textContent = '工作目录'
  const nb = $('#boardNewBtn'); if (nb) nb.style.display = 'none'
  const rb = $('#boardRefreshBtn'); if (rb) rb.style.display = 'none'
  // 未开始的卡片目录可能尚未创建，先建好再渲染（允许直接在其中放文件）
  fsapi('mkdir', { path: card.path }).catch(() => {}).finally(() => {
    if (state.cardActive === card.id && files) renderFileTree(files, { root: card.path })
  })
}
// 依据当前编辑区是否为「卡片对话」pane 决定侧栏内容
function syncBoardSide() {
  if (state.view !== 'board') return
  // 卡片对话或查看卡片工作目录里的文件时，侧栏都保持工作目录树
  if ((state.pane === 'card' || state.pane === 'file') && state.cardActive) showBoardSideFiles(cardById(state.cardActive))
  else showBoardSideConfig()
}
function openCardTab(card, preset) {
  if (!card || !card.id) return
  rememberTaskPane()
  state.mode = 'card'
  state.item = null
  setView('board')
  let t = state.cardTabs.find((x) => x.id === card.id)
  if (!t) { t = { id: card.id, name: card.name || '卡片' }; state.cardTabs.push(t) }
  else if (card.name) t.name = card.name
  // 切换到不同的卡片时清掉上一张卡片打开的临时文件标签，避免串卡
  if (state.cardActive !== card.id) closeAllFiles()
  state.cardActive = card.id
  renderTabs()
  showPane('card')
  mountActiveCard(card, preset)
}
function activateCardTab(id) {
  if (!id) return
  const card = cardById(id)
  if (!card) return
  if (state.cardActive !== id) closeAllFiles()
  state.cardActive = id
  renderTabs()
  showPane('card')
  mountActiveCard(card)
}
function closeCardTab(id) {
  const idx = state.cardTabs.findIndex((x) => x.id === id)
  if (idx === -1) return
  const wasActive = state.cardActive === id
  state.cardTabs.splice(idx, 1)
  if (!wasActive) { renderTabs(); return }
  cleanupCardChat()
  const next = state.cardTabs[idx] || state.cardTabs[idx - 1] || null
  if (next) {
    state.cardActive = next.id
    renderTabs()
    showPane('card')
    const card = cardById(next.id)
    if (card) mountActiveCard(card)
  } else {
    // 最后一张卡片关闭 → 回到看板
    state.cardActive = null
    state.mode = 'board'
    renderTabs()
    showPane('board')
    renderBoard().catch((e) => console.error('[board]', e))
  }
}

// 从看板/设置/详情切回常规任务视图：右栏大块必须跟着切走，不能停留在整页模式
function exitSpecialMode() {
  if (state.mode === 'item') { closeItem(); return }
  abandonCardTabs()
  if (state.mode === 'board' || state.mode === 'settings' || state.mode === 'card') {
    state.mode = 'task'
    state.item = null
    let next = state.taskId ? (state.lastTaskPane || 'ai') : 'info'
    if (next === 'file' && !state.activeFile) next = 'ai'
    showPane(next)
    renderTabs()
  }
}

// 侧栏导航项默认展示的详情：环境→本机；模型→首个提供方；skill/mcp→首个
const DEFAULT_ITEM_VIEW = new Set(['envs', 'models', 'skills', 'mcp'])
function preferredItem(v) {
  if (v === 'envs') {
    const e = state.envs.find((x) => x.kind === 'local') || state.envs[0]
    return e ? { kind: 'env', id: e.id } : null
  }
  if (v === 'models') {
    const p = state.providers[0]
    return p ? { kind: 'provider', id: p.id } : null
  }
  if (v === 'skills') {
    const s = state.skills[0]
    return s ? { kind: 'skill', id: s.id } : null
  }
  if (v === 'mcp') {
    const m = state.mcp[0]
    return m ? { kind: 'mcp', id: m.id } : null
  }
  return null
}

function renderSidebars() {
  renderProjects()
  renderEnvs()
  renderSkills()
  renderMcp()
  renderModels()
}

async function selectTask(id) {
  abandonCardTabs()
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
  abandonCardTabs()
  rememberTaskPane()
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
  let next = state.taskId ? (state.lastTaskPane || 'info') : 'info'
  if (next === 'file' && !state.activeFile) next = 'ai'
  renderTabs()
  showPane(next)
}

async function openInbox() {
  abandonCardTabs()
  state.inboxOpen = true
  state.mode = 'task'
  state.item = null
  showPane('inbox')
  renderTabs()
  await renderInboxBoard()
  renderInboxCode()
}

function closeInbox() {
  state.inboxOpen = false
  showPane('info')
  renderTabs()
}

function openBoard() {
  rememberTaskPane()
  state.item = null
  setView('board')
  // 已有卡片标签时保留它们（标签条仍显示卡片），仅把编辑区切回看板
  state.mode = state.cardTabs.length ? 'card' : 'board'
  renderTabs()
  showPane('board')
  renderBoard().catch((e) => console.error('[board]', e))
}

function openSettings() {
  abandonCardTabs()
  rememberTaskPane()
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
      if (v === 'board') { openBoard(); return }
      // 已在该类详情页则保留当前选择，不强行跳回默认项
      const stayingOnItem = state.mode === 'item' && state.item && ITEM_VIEW[state.item.kind] === v
      setView(v)
      if (stayingOnItem) return
      if (DEFAULT_ITEM_VIEW.has(v)) {
        const pick = preferredItem(v)
        if (pick) { emit('open-item', pick); return }
      }
      exitSpecialMode()
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
  on('open-card-tab', (p) => { if (p && p.card) openCardTab(p.card, p.sessionId) })
  on('card-activate', activateCardTab)
  on('card-close', closeCardTab)
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
    // 编辑区在「看板」与「卡片对话」间切换时，左侧栏同步切回看板配置/工作目录树
    syncBoardSide()
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

// 让出到下一帧，确保开屏动画已绘制后再进行较重的数据装载
function nextFrame() {
  return new Promise((resolve) => {
    let done = false
    const fin = () => { if (!done) { done = true; resolve() } }
    requestAnimationFrame(() => setTimeout(fin, 0))
    setTimeout(fin, 120) // 兜底：隐藏窗口节流 rAF 时也不卡死启动
  })
}

// 淡出并移除开屏遮罩
function hideBootSplash() {
  const s = document.getElementById('bootSplash')
  if (!s || s.classList.contains('out')) return
  s.classList.add('out')
  setTimeout(() => { try { s.remove() } catch {} }, 400)
}

async function boot() {
  // 首帧只画开屏遮罩，交互被冻结的这段时间用户看到的是加载动画而非不可操作的界面
  await nextFrame()
  try {
    initProjectsView()
    initProjectFiles()
    initEnvsView()
    initSkillsView()
    initMcpView()
    initModelsView()
    initSessionView()
    initChatView()
    initInboxView()
    initBoardView()
    initTerminalView()
    initUpdate()
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
  } finally {
    hideBootSplash()
  }
}

boot()
