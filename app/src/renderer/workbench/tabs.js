// 编辑区 tab 条与 pane 切换
import { state, emit } from '../lib/state.js'
import { $, esc, ic, refreshIcons } from '../lib/ui.js'
import { showContextMenu } from '../components/contextMenu.js'

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
    const pinned = `<div class="tab${state.pane === 'board' ? ' on' : ''}" data-pane="board">${ic('kanban-square', 12)}<span>看板</span></div>`
    const parts = []
    for (const c of state.cardTabs) {
      const on = state.pane === 'card' && state.cardActive === c.id ? ' on' : ''
      parts.push(`<div class="tab${on}" data-pane="card" data-card="${esc(c.id)}" title="${esc(c.name)}">${ic('message-square', 12)}<span>${esc(c.name)}</span><span class="x" title="关闭">×</span></div>`)
    }
    for (const ft of state.fileTabs) {
      const on = state.pane === 'file' && state.activeFile === ft.path ? ' on' : ''
      parts.push(`<div class="tab${on}" data-pane="file" data-file="${esc(ft.path)}" title="${esc(ft.path)}">
        ${ic('file-code', 12)}<span>${esc(ft.name)}${ft.dirty ? ' •' : ''}</span><span class="x" title="关闭">×</span></div>`)
    }
    paintTabs(bar, pinned, parts.join(''))
    return
  }

  // 固定 tab（任务信息/会话管理/AI 对话）始终常驻左侧、不参与横向滚动；
  // 只有文件 tab 进入可滚动的区域，标签过多时右侧出现箭头
  const pinned = []
  const scroll = []
  if (!state.taskId) {
    const on = state.pane === 'info' ? ' on' : ''
    pinned.push(`<div class="tab${on}" data-pane="info">${ic('info', 12)}<span>未选择任务</span></div>`)
  } else {
    for (const f of FIXED) {
      const on = state.pane === f.pane ? ' on' : ''
      pinned.push(`<div class="tab${on}" data-pane="${f.pane}">${ic(f.icon, 12)}<span>${f.label}</span><span class="pin"></span></div>`)
    }
    for (const ft of state.fileTabs) {
      const on = state.pane === 'file' && state.activeFile === ft.path ? ' on' : ''
      scroll.push(`<div class="tab${on}" data-pane="file" data-file="${esc(ft.path)}" title="${esc(ft.path)}">
        ${ic('file-code', 12)}<span>${esc(ft.name)}${ft.dirty ? ' •' : ''}</span><span class="x" title="关闭">×</span></div>`)
    }
  }
  paintTabs(bar, pinned.join(''), scroll.join(''))
}

function inboxTabHtml() {
  // 需求便签为常驻 tab，不提供关闭按钮（不能 × 掉）；切走用左侧活动栏或选择任务
  const on = state.pane === 'inbox' ? ' on' : ''
  return `<div class="tab${on}" data-pane="inbox">${ic('sticky-note', 12)}<span>需求便签</span></div>`
}

function bindTabClicks(bar) {
  bar.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', (e) => {
      const pane = t.getAttribute('data-pane')
      const cardId = t.getAttribute('data-card')
      if (e.target.classList.contains('x')) {
        e.stopPropagation()
        if (pane === 'card') emit('card-close', cardId)
        else emit('file-close', t.getAttribute('data-file'))
        return
      }
      if (pane === 'card') { emit('card-activate', cardId); return }
      if (pane === 'file') emit('file-activate', t.getAttribute('data-file'))
      else showPane(pane)
    })
    // 文件 tab 右键：关闭右侧 / 关闭左侧 / 关闭全部
    if (t.getAttribute('data-pane') === 'file') {
      t.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        const path = t.getAttribute('data-file')
        const paths = state.fileTabs.map((f) => f.path)
        const idx = paths.indexOf(path)
        if (idx < 0) return
        const left = paths.slice(0, idx)
        const right = paths.slice(idx + 1)
        showContextMenu(e.clientX, e.clientY, [
          { label: '关闭右侧', action: () => { if (right.length) emit('file-close-many', right) } },
          { label: '关闭左侧', action: () => { if (left.length) emit('file-close-many', left) } },
          { sep: true },
          { label: '关闭全部', danger: true, action: () => { if (paths.length) emit('file-close-many', paths) } }
        ])
      })
    }
  })
}

// 渲染带横向滚动与左右箭头的 tab 条：标签过多时右侧出现箭头，点击平滑滚动；
// 每次渲染把当前激活标签滚入可视区（activate 会 emit tabs-changed 触发重渲染）
let tabResizeObs = null
function paintTabs(bar, pinnedHtml, scrollHtml) {
  bar.innerHTML =
    `<div class="tabs-pinned">${pinnedHtml || ''}</div>` +
    `<div class="tabs-scroll" id="tabsScroll">${scrollHtml || ''}</div>` +
    `<div class="tabs-nav" id="tabsNav">` +
    `<button class="tabnav" data-dir="-1" title="向左滚动">${ic('chevron-left', 13)}</button>` +
    `<button class="tabnav" data-dir="1" title="向右滚动">${ic('chevron-right', 13)}</button>` +
    `</div>`
  refreshIcons()
  bindTabClicks(bar)
  const scroller = bar.querySelector('.tabs-scroll')
  const nav = bar.querySelector('.tabs-nav')
  if (!scroller || !nav) return
  // 鼠标滚轮在 tab 条上横向滚动（纵向滚轮→横向位移），无需非得点箭头
  scroller.addEventListener('wheel', (e) => {
    if (scroller.scrollWidth <= scroller.clientWidth) return
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    if (!d) return
    e.preventDefault()
    scroller.scrollLeft += d
  }, { passive: false })
  const update = () => {
    const max = scroller.scrollWidth - scroller.clientWidth
    nav.classList.toggle('hidden', max <= 1)
    const left = nav.querySelector('[data-dir="-1"]')
    const right = nav.querySelector('[data-dir="1"]')
    if (left) left.classList.toggle('off', scroller.scrollLeft <= 1)
    if (right) right.classList.toggle('off', scroller.scrollLeft >= max - 1)
  }
  nav.querySelectorAll('.tabnav').forEach((b) => {
    b.addEventListener('click', () => {
      const dir = Number(b.getAttribute('data-dir'))
      scroller.scrollBy({ left: dir * Math.max(140, Math.round(scroller.clientWidth * 0.7)), behavior: 'smooth' })
    })
  })
  scroller.addEventListener('scroll', update, { passive: true })
  if (tabResizeObs) { try { tabResizeObs.disconnect() } catch {} }
  tabResizeObs = new ResizeObserver(update)
  tabResizeObs.observe(scroller)
  requestAnimationFrame(() => {
    const on = scroller.querySelector('.tab.on')
    if (on) {
      const sLeft = scroller.scrollLeft
      const sRight = sLeft + scroller.clientWidth
      const l = on.offsetLeft
      const r = l + on.offsetWidth
      if (l < sLeft) scroller.scrollLeft = l
      else if (r > sRight) scroller.scrollLeft = r - scroller.clientWidth
    }
    update()
  })
}

function cssEsc(s) {
  return String(s).replace(/["\\]/g, '\\$&')
}
