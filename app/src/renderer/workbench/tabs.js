// 编辑区 tab 条与 pane 切换
import { state, emit } from '../lib/state.js'
import { $, esc, ic, refreshIcons } from '../lib/ui.js'

const FIXED = [
  { pane: 'info', icon: 'info', label: '任务信息' },
  { pane: 'session', icon: 'layers', label: '会话管理' },
  { pane: 'ai', icon: 'message-square', label: 'AI 对话' }
]

const PANES = ['info', 'inbox', 'session', 'ai', 'file', 'item', 'settings', 'board', 'card']

export function showPane(name) {
  state.pane = name
  for (const p of PANES) {
    const el = document.getElementById('pane-' + p)
    if (el) el.classList.toggle('on', p === name)
  }
  const bar = $('#tabbar')
  bar.querySelectorAll('.tab').forEach((t) => {
    // 卡片的多个 tab 共享 data-pane="card"，只有当前激活卡片高亮
    if (t.hasAttribute('data-card')) {
      t.classList.toggle('on', name === 'card' && t.getAttribute('data-card') === state.cardActive)
      return
    }
    t.classList.toggle('on', t.getAttribute('data-pane') === name && !t.hasAttribute('data-file'))
  })
  const activeFileTab = bar.querySelector(`.tab[data-file="${cssEsc(state.activeFile || '')}"]`)
  if (name === 'file' && activeFileTab) activeFileTab.classList.add('on')
  emit('pane-changed', name)
}

export function renderTabs() {
  const bar = $('#tabbar')
  // 需求便签是独占 tab：激活时编辑区只显示它本身，关闭后恢复常规 tab 条
  if (state.mode === 'task' && state.inboxOpen && state.pane === 'inbox') {
    bar.innerHTML = inboxTabHtml()
    refreshIcons()
    bindTabClicks(bar)
    return
  }
  if (state.mode === 'item') {
    const it = state.item || {}
    bar.innerHTML = `<div class="tab on" data-pane="item">${ic(it.icon || 'file-text', 12)}<span>${esc(it.label || '详情')}</span><span class="pin"></span></div>`
    refreshIcons()
    return
  }
  if (state.mode === 'settings') {
    bar.innerHTML = `<div class="tab on" data-pane="settings">${ic('settings', 12)}<span>设置</span><span class="pin"></span></div>`
    refreshIcons()
    return
  }
  if (state.mode === 'board') {
    bar.innerHTML = `<div class="tab on" data-pane="board">${ic('kanban-square', 12)}<span>看板</span><span class="pin"></span></div>`
    refreshIcons()
    return
  }
  if (state.mode === 'card') {
    const parts = [`<div class="tab${state.pane === 'board' ? ' on' : ''}" data-pane="board">${ic('kanban-square', 12)}<span>看板</span></div>`]
    for (const c of state.cardTabs) {
      const on = state.pane === 'card' && state.cardActive === c.id ? ' on' : ''
      parts.push(`<div class="tab${on}" data-pane="card" data-card="${esc(c.id)}" title="${esc(c.name)}">${ic('message-square', 12)}<span>${esc(c.name)}</span><span class="x" title="关闭">×</span></div>`)
    }
    bar.innerHTML = parts.join('')
    refreshIcons()
    bindTabClicks(bar)
    return
  }

  const parts = []
  if (!state.taskId) {
    const on = state.pane === 'info' ? ' on' : ''
    parts.push(`<div class="tab${on}" data-pane="info">${ic('info', 12)}<span>未选择任务</span></div>`)
  } else {
    for (const f of FIXED) {
      const on = state.pane === f.pane ? ' on' : ''
      parts.push(`<div class="tab${on}" data-pane="${f.pane}">${ic(f.icon, 12)}<span>${f.label}</span><span class="pin"></span></div>`)
    }
    for (const ft of state.fileTabs) {
      const on = state.pane === 'file' && state.activeFile === ft.path ? ' on' : ''
      parts.push(`<div class="tab${on}" data-pane="file" data-file="${esc(ft.path)}">
        ${ic('file-code', 12)}<span>${esc(ft.name)}${ft.dirty ? ' •' : ''}</span><span class="x" title="关闭">×</span></div>`)
    }
  }
  bar.innerHTML = parts.join('')
  refreshIcons()
  bindTabClicks(bar)
}

function inboxTabHtml() {
  const on = state.pane === 'inbox' ? ' on' : ''
  return `<div class="tab${on}" data-pane="inbox">${ic('sticky-note', 12)}<span>需求便签</span><span class="x" title="关闭">×</span></div>`
}

function bindTabClicks(bar) {
  bar.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', (e) => {
      const pane = t.getAttribute('data-pane')
      const cardId = t.getAttribute('data-card')
      if (e.target.classList.contains('x')) {
        e.stopPropagation()
        if (pane === 'inbox') emit('close-inbox')
        else if (pane === 'card') emit('card-close', cardId)
        else emit('file-close', t.getAttribute('data-file'))
        return
      }
      if (pane === 'card') { emit('card-activate', cardId); return }
      if (pane === 'file') emit('file-activate', t.getAttribute('data-file'))
      else showPane(pane)
    })
  })
}

function cssEsc(s) {
  return String(s).replace(/["\\]/g, '\\$&')
}
