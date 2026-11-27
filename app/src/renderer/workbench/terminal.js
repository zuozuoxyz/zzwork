// 底部终端面板：每任务多标签 + 分屏（布局持久化，PTY 由主进程管理）
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { invoke, store } from '../lib/api.js'
import { state, on } from '../lib/state.js'
import { $, esc, refreshIcons } from '../lib/ui.js'
import { toast } from '../components/toast.js'
import { showContextMenu } from '../components/contextMenu.js'

const zz = window.zzwork
const UI_KEY = 'terminal:ui'
const MAX_PANES = 8
const MAX_TABS = 12
const MIN_HEIGHT = 120

const tasks = new Map() // taskId -> { tabs, activeTabId, panes: Map, loaded }
const panesByTerm = new Map() // termId -> pane
let currentTaskId = null
let panel = null
let body = null
let tabsEl = null
let ui = { height: 260, max: false }
let persistTimer = null

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2))

function termTheme() {
  const cs = getComputedStyle(document.documentElement)
  const v = (n, d) => (cs.getPropertyValue(n) || d).trim()
  return {
    background: v('--bg', '#171717'),
    foreground: v('--fg', '#e4e4e4'),
    cursor: v('--brand', '#0ea5e9'),
    cursorAccent: v('--bg', '#171717'),
    selectionBackground: 'rgba(14,165,233,.35)',
    black: '#1b1c1d', red: '#f87171', green: '#34d399', yellow: '#fbbf24',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#2dd4bf', white: '#e4e4e4',
    brightBlack: '#6f7275', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fde68a',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#99f6e4', brightWhite: '#fafafa'
  }
}

function taskState(taskId) {
  let ts = tasks.get(taskId)
  if (!ts) {
    ts = { tabs: [], activeTabId: null, panes: new Map(), loaded: false, open: false }
    tasks.set(taskId, ts)
  }
  return ts
}

function activeTab(ts) {
  return ts.tabs.find((t) => t.id === ts.activeTabId) || ts.tabs[0] || null
}

function walkLeaves(node, fn) {
  if (!node) return
  if (node.type === 'leaf') { fn(node.id); return }
  walkLeaves(node.a, fn)
  walkLeaves(node.b, fn)
}

function countLeaves(node) {
  let n = 0
  walkLeaves(node, () => { n += 1 })
  return n
}

function mkPane(paneId, taskId) {
  return { paneId, taskId, termId: '', el: null, term: null, fit: null, dead: false, ro: null, fitTimer: null }
}

// ---------- 持久化 ----------

function saveLayout(tid) {
  const ts = tasks.get(tid)
  if (!ts) return
  const data = {
    tabs: ts.tabs.map((t) => ({ id: t.id, title: t.title, lockTitle: !!t.lockTitle, layout: t.layout, activePaneId: t.activePaneId })),
    activeTabId: ts.activeTabId,
    open: !!ts.open
  }
  store('settings.set', { key: 'terminal:layout:' + tid, value: JSON.stringify(data) }).catch(() => {})
}

function persist() {
  const tid = currentTaskId
  if (!tid) return
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => saveLayout(tid), 300)
}

// 顶部终端按钮的高亮跟随「当前任务」的展开态，而非全局
// 需求便签/看板为整页上下文，不显示终端
function termBlocked() {
  return state.pane === 'inbox' || state.pane === 'board'
}

function syncToggle() {
  const toggle = $('#termToggle')
  if (!toggle) return
  const ts = currentTaskId ? tasks.get(currentTaskId) : null
  // 便签/看板页面不显示终端：即使此前展开也不高亮，且不允许在此页打开
  toggle.classList.toggle('on', !!(ts && ts.open) && !termBlocked())
}

function saveUi() {
  store('settings.set', { key: UI_KEY, value: JSON.stringify(ui) }).catch(() => {})
  syncToggle()
}

async function loadStored(taskId) {
  const ts = taskState(taskId)
  if (ts.loaded) return ts
  ts.loaded = true
  let raw = ''
  try { raw = await store('settings.get', { key: 'terminal:layout:' + taskId, dflt: '' }) } catch {}
  if (!raw) return ts
  try {
    const data = JSON.parse(raw)
    for (const t of data.tabs || []) {
      if (!t || !t.layout) continue
      const ids = []
      walkLeaves(t.layout, (pid) => ids.push(pid))
      if (!ids.length) continue
      const panes = ids.map((pid) => {
        if (!ts.panes.has(pid)) ts.panes.set(pid, mkPane(pid, taskId))
        return pid
      })
      ts.tabs.push({ id: t.id || uuid(), title: t.title || '终端', lockTitle: !!t.lockTitle, layout: t.layout, activePaneId: t.activePaneId || panes[0] })
    }
    ts.activeTabId = (data.tabs || []).length ? (data.activeTabId || ts.tabs[0].id) : null
    ts.open = !!data.open
  } catch {}
  return ts
}

// ---------- 剪贴板 ----------

async function copyText(text) {
  if (!text) return
  try { await invoke('terminal', 'copy', { text }) } catch {}
}

async function pasteInto(pane) {
  if (!pane || pane.dead || !pane.term) return
  let text = ''
  try { text = await invoke('terminal', 'paste') } catch {}
  if (!text) return
  pane.term.paste(text)
  pane.term.focus()
}

// ---------- xterm 挂载 ----------

// 去掉 URL 末尾误并入的标点，避免把紧跟的句号/右括号当成链接一部分
function trimUrl(u) {
  let url = u
  while (/[.,;:!?'"\]}>]$/.test(url)) url = url.slice(0, -1)
  // 右括号只在左边没有成对左括号时才去掉（保留维基百科这类带括号的链接）
  while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1)
  return url
}

// 识别终端输出里的 http(s) 链接，Ctrl/⌘ + 点击在系统浏览器打开
function attachLinkProvider(term) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)
      if (!line) { callback(undefined); return }
      const text = line.translateToString(true)
      const re = /https?:\/\/[^\s<>"'`]+/g
      const links = []
      let m
      while ((m = re.exec(text))) {
        const url = trimUrl(m[0])
        if (!url) continue
        const startX = m.index + 1
        const endX = m.index + url.length
        links.push({
          range: { start: { x: startX, y }, end: { x: endX, y } },
          text: url,
          activate: (event, u) => {
            if (!(event.ctrlKey || event.metaKey)) return
            if (/^https?:/i.test(u)) window.open(u, '_blank')
          }
        })
      }
      callback(links.length ? links : undefined)
    }
  })
}

function ensureMounted(pane) {
  if (pane.el) return
  pane.el = document.createElement('div')
  pane.el.className = 'term-pane'
  pane.el.dataset.pane = pane.paneId
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 12,
    lineHeight: 1.15,
    scrollback: 5000,
    fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
    theme: termTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(pane.el)
  attachLinkProvider(term)
  pane.term = term
  pane.fit = fit
  term.onData((d) => {
    if (pane.dead) {
      if (d === '\r' || d === '\n') respawnPane(pane)
      return
    }
    if (pane.termId) invoke('terminal', 'write', { id: pane.termId, data: d }).catch(() => {})
  })
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || e.altKey) return true
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.code === 'KeyC') {
      const sel = term.getSelection()
      if (sel) { copyText(sel); return false }
      // 无选区时让 Ctrl+C 继续作为 SIGINT 发送
      return true
    }
    if (mod && e.code === 'Insert') {
      const sel = term.getSelection()
      if (sel) { copyText(sel); return false }
    }
    if (mod && e.shiftKey && e.code === 'KeyV') { pasteInto(pane); return false }
    if (e.shiftKey && e.code === 'Insert') { pasteInto(pane); return false }
    return true
  })
  pane.el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, [
      { label: '复制', icon: 'copy', action: () => copyText(term.getSelection()) },
      { label: '粘贴', icon: 'clipboard-paste', action: () => pasteInto(pane) },
      { label: '全选', icon: 'text-select', action: () => term.selectAll() },
      { sep: true },
      { label: '清屏', icon: 'eraser', action: () => term.clear() }
    ])
  })
  const ts = tasks.get(pane.taskId)
  pane.el.addEventListener('click', () => {
    if (ts) { const tab = activeTab(ts); if (tab) tab.activePaneId = pane.paneId }
    term.focus()
  })
  pane.ro = new ResizeObserver(() => scheduleFit(pane))
  pane.ro.observe(pane.el)
  scheduleFit(pane)
}

function scheduleFit(pane) {
  clearTimeout(pane.fitTimer)
  pane.fitTimer = setTimeout(() => {
    if (!pane.el || !pane.el.offsetParent || !pane.fit) return
    try { pane.fit.fit() } catch {}
    if (pane.termId) {
      invoke('terminal', 'resize', { id: pane.termId, cols: pane.term.cols, rows: pane.term.rows }).catch(() => {})
    }
  }, 80)
}

function fitActive(ts) {
  const tab = activeTab(ts)
  if (!tab) return
  walkLeaves(tab.layout, (pid) => { const p = ts.panes.get(pid); if (p) scheduleFit(p) })
}

// ---------- 进程 ----------

// 在指定窗格里执行一段命令（多行按回车逐条发送），等待 shell 就绪后写入
function runInPane(pane, cmd) {
  const text = String(cmd || '').replace(/\r?\n/g, '\r')
  if (!text.trim()) return
  setTimeout(() => {
    if (!pane || !pane.termId || pane.dead) return
    invoke('terminal', 'write', { id: pane.termId, data: text + '\r' }).catch(() => {})
    if (pane.term) pane.term.focus()
  }, 220)
}

async function spawnPane(pane, tab) {
  if (!pane || pane.termId || pane.dead || !pane.term || !pane.el || !pane.el.offsetParent) return
  try {
    const r = await invoke('terminal', 'create', {
      taskId: pane.taskId,
      paneId: pane.paneId,
      cols: pane.term.cols || 80,
      rows: pane.term.rows || 24
    })
    pane.termId = r.id
    panesByTerm.set(r.id, pane)
    if (tab) { if (!tab.lockTitle) tab.title = r.title || tab.title; renderTabs() }
    if (pane.initialCmd) { const cmd = pane.initialCmd; pane.initialCmd = ''; runInPane(pane, cmd) }
  } catch (e) {
    pane.dead = true
    pane.term.writeln('\x1b[31m[zzwork] 无法启动终端：' + String((e && e.message) || e) + '\x1b[0m')
    pane.term.writeln('\x1b[90m回车重试\x1b[0m')
  }
}

function spawnTab(ts, tab) {
  if (!tab) return
  walkLeaves(tab.layout, (pid) => { const p = ts.panes.get(pid); if (p) spawnPane(p, tab) })
}

function respawnPane(pane) {
  if (!pane.dead) return
  pane.dead = false
  pane.term.clear()
  const ts = tasks.get(pane.taskId)
  spawnPane(pane, ts ? activeTab(ts) : null)
}

async function killPane(pane) {
  try { pane.ro && pane.ro.disconnect() } catch {}
  clearTimeout(pane.fitTimer)
  if (pane.termId) {
    panesByTerm.delete(pane.termId)
    invoke('terminal', 'kill', { id: pane.termId }).catch(() => {})
  }
  try { pane.term && pane.term.dispose() } catch {}
  try { pane.el && pane.el.remove() } catch {}
}

// ---------- 分屏树 ----------

function buildNode(ts, tab, node) {
  if (node.type === 'leaf') {
    const pane = ts.panes.get(node.id)
    const wrap = document.createElement('div')
    wrap.className = 'term-leaf'
    if (!pane) return wrap
    ensureMounted(pane)
    wrap.appendChild(pane.el)
    const close = document.createElement('button')
    close.className = 'term-px'
    close.title = '关闭此终端'
    close.textContent = '×'
    close.addEventListener('click', (e) => { e.stopPropagation(); closePane(ts, tab, pane.paneId) })
    wrap.appendChild(close)
    return wrap
  }
  const wrap = document.createElement('div')
  wrap.className = 'term-node ' + (node.dir === 'row' ? 'dir-row' : 'dir-col')
  const a = buildNode(ts, tab, node.a)
  const b = buildNode(ts, tab, node.b)
  const div = document.createElement('div')
  div.className = 'term-divider' + (node.dir === 'row' ? '' : ' v')
  a.style.flex = node.ratio + ' 1 0'
  b.style.flex = (1 - node.ratio) + ' 1 0'
  wireDivider(div, node, wrap, a, b)
  wrap.append(a, div, b)
  return wrap
}

function wireDivider(div, node, wrap, a, b) {
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    div.setPointerCapture(e.pointerId)
    const rect = wrap.getBoundingClientRect()
    const move = (ev) => {
      const row = node.dir === 'row'
      const size = row ? rect.width : rect.height
      const pos = row ? ev.clientX - rect.left : ev.clientY - rect.top
      if (!size) return
      node.ratio = Math.min(0.85, Math.max(0.15, pos / size))
      a.style.flex = node.ratio + ' 1 0'
      b.style.flex = (1 - node.ratio) + ' 1 0'
    }
    const up = () => {
      div.removeEventListener('pointermove', move)
      div.removeEventListener('pointerup', up)
      try { div.releasePointerCapture(e.pointerId) } catch {}
      persist()
      const ts = tasks.get(currentTaskId)
      if (ts) fitActive(ts)
    }
    div.addEventListener('pointermove', move)
    div.addEventListener('pointerup', up)
  })
}

function replaceLeaf(node, target, repl) {
  if (!node) return node
  if (node.type === 'leaf') return node.id === target ? repl : node
  return { ...node, a: replaceLeaf(node.a, target, repl), b: replaceLeaf(node.b, target, repl) }
}

function removeLeaf(node, target) {
  if (!node) return null
  if (node.type === 'leaf') return node.id === target ? null : node
  const a = removeLeaf(node.a, target)
  const b = removeLeaf(node.b, target)
  if (!a) return b
  if (!b) return a
  return { ...node, a, b }
}

function firstLeaf(node) {
  let found = null
  walkLeaves(node, (id) => { if (!found) found = id })
  return found
}

function findTabOf(ts, paneId) {
  for (const t of ts.tabs) {
    let hit = false
    walkLeaves(t.layout, (id) => { if (id === paneId) hit = true })
    if (hit) return t
  }
  return null
}

// ---------- 面板渲染 ----------

function renderTabs() {
  if (!currentTaskId) return
  const ts = tasks.get(currentTaskId)
  if (!tabsEl || !ts) return
  tabsEl.innerHTML = ts.tabs.map((t) => {
    const on = t.id === ts.activeTabId ? ' on' : ''
    return `<div class="term-tab${on}" data-tab="${t.id}" title="${t.title}">
      <span class="t">${t.title}</span><span class="x" data-close="${t.id}">×</span></div>`
  }).join('')
  for (const el of tabsEl.querySelectorAll('.term-tab')) {
    el.addEventListener('click', (e) => {
      const closeId = e.target && e.target.getAttribute && e.target.getAttribute('data-close')
      if (closeId) { e.stopPropagation(); closeTab(ts, closeId); return }
      ts.activeTabId = el.getAttribute('data-tab')
      renderPanel()
      persist()
      setTimeout(focusActive, 60)
    })
  }
}

function renderPanel() {
  if (!currentTaskId || !body) return
  const ts = tasks.get(currentTaskId)
  if (!ts) return
  renderTabs()
  body.innerHTML = ''
  if (!ts.tabs.length) {
    const empty = document.createElement('div')
    empty.className = 'term-empty'
    empty.innerHTML = '暂无终端 <button class="term-ib" id="termEmptyNew">新建终端</button>'
    body.appendChild(empty)
    const btn = empty.querySelector('#termEmptyNew')
    if (btn) btn.addEventListener('click', () => newTab())
    refreshIcons()
    return
  }
  const tab = activeTab(ts)
  const root = document.createElement('div')
  root.className = 'term-tabroot'
  root.appendChild(buildNode(ts, tab, tab.layout))
  body.appendChild(root)
  requestAnimationFrame(() => {
    fitActive(ts)
    spawnTab(ts, tab)
  })
}

function focusActive() {
  if (!currentTaskId) return
  const ts = tasks.get(currentTaskId)
  const tab = activeTab(ts)
  const pane = tab && ts.panes.get(tab.activePaneId)
  if (pane && pane.term && pane.el && pane.el.offsetParent) pane.term.focus()
}

// ---------- 操作 ----------

// ---------- 新建终端「批处理」悬停菜单 ----------

let batchMenu = null
let batchMenuList = []
let batchMenuTimer = 0
let batchMenuSeq = 0

async function loadBatches(taskId) {
  try {
    const raw = await store('settings.get', { key: 'task:terms:' + taskId, dflt: '' })
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

function hideBatchMenu() {
  clearTimeout(batchMenuTimer)
  batchMenuSeq++
  if (batchMenu) batchMenu.classList.remove('on')
}

function scheduleHideBatchMenu() {
  clearTimeout(batchMenuTimer)
  batchMenuTimer = setTimeout(hideBatchMenu, 170)
}

function ensureBatchMenu() {
  if (batchMenu) return batchMenu
  batchMenu = document.createElement('div')
  batchMenu.className = 'term-batchmenu'
  const host = document.getElementById('ctx-host') || document.body
  host.appendChild(batchMenu)
  batchMenu.addEventListener('mouseenter', () => clearTimeout(batchMenuTimer))
  batchMenu.addEventListener('mouseleave', scheduleHideBatchMenu)
  batchMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.tbm-item')
    if (!item) return
    const i = Number(item.getAttribute('data-i'))
    hideBatchMenu()
    if (i < 0) newTab()
    else { const b = batchMenuList[i]; if (b) newTab(b) }
  })
  return batchMenu
}

async function showBatchMenu(anchor) {
  clearTimeout(batchMenuTimer)
  if (!currentTaskId) return
  const seq = ++batchMenuSeq
  batchMenuList = await loadBatches(currentTaskId)
  if (seq !== batchMenuSeq) return
  const menu = ensureBatchMenu()
  const items = [`<div class="tbm-item" data-i="-1"><i data-lucide="terminal" style="width:13px;height:13px"></i><span class="nm">新建空白终端</span></div>`]
  if (batchMenuList.length) {
    items.push('<div class="tbm-sep"></div>')
    batchMenuList.forEach((b, i) => {
      const first = String(b.cmd || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
      items.push(`<div class="tbm-item" data-i="${i}" title="${esc(first || '（未配置命令）')}">
        <i data-lucide="play" style="width:13px;height:13px"></i>
        <span class="nm">${esc(b.name || '未命名批处理')}</span>
        ${first ? `<span class="cmd">${esc(first)}</span>` : ''}
      </div>`)
    })
  } else {
    items.push(`<div class="tbm-empty">在任务信息中配置批处理后，可在此一键执行</div>`)
  }
  menu.innerHTML = items.join('')
  refreshIcons()
  const r = anchor.getBoundingClientRect()
  const w = menu.offsetWidth || 220
  let left = Math.round(r.right - w)
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
  menu.style.left = left + 'px'
  menu.style.top = Math.round(r.bottom + 4) + 'px'
  menu.classList.add('on')
}

function newTab(batch) {
  if (!currentTaskId) return
  const ts = taskState(currentTaskId)
  if (ts.tabs.length >= MAX_TABS) { toast('终端标签数量已达上限', 'warn'); return }
  const paneId = uuid()
  const pane = mkPane(paneId, currentTaskId)
  const cmd = batch ? String(batch.cmd || '') : ''
  if (cmd.trim()) pane.initialCmd = cmd
  ts.panes.set(paneId, pane)
  const named = !!(batch && String(batch.name || '').trim())
  const tab = { id: uuid(), title: named ? batch.name.trim() : '终端', lockTitle: named, layout: { type: 'leaf', id: paneId }, activePaneId: paneId }
  ts.tabs.push(tab)
  ts.activeTabId = tab.id
  ts.open = true
  if (panel) panel.classList.add('on')
  syncToggle()
  renderPanel()
  persist()
  setTimeout(focusActive, 60)
}

function splitActive(dir) {
  if (!currentTaskId) return
  const ts = tasks.get(currentTaskId)
  const tab = activeTab(ts)
  if (!tab) { toast('先新建一个终端', 'warn'); return }
  if (countLeaves(tab.layout) >= MAX_PANES) { toast('分屏数量已达上限', 'warn'); return }
  const target = tab.activePaneId || firstLeaf(tab.layout)
  const paneId = uuid()
  const pane = mkPane(paneId, currentTaskId)
  ts.panes.set(paneId, pane)
  tab.layout = replaceLeaf(tab.layout, target, {
    type: 'split', dir, ratio: 0.5,
    a: { type: 'leaf', id: target },
    b: { type: 'leaf', id: paneId }
  })
  tab.activePaneId = paneId
  renderPanel()
  persist()
  setTimeout(focusActive, 60)
}

function closePane(ts, tab, paneId) {
  const pane = ts.panes.get(paneId)
  if (pane) { killPane(pane); ts.panes.delete(paneId) }
  const next = removeLeaf(tab.layout, paneId)
  if (!next) { closeTab(ts, tab.id); return }
  tab.layout = next
  if (tab.activePaneId === paneId) tab.activePaneId = firstLeaf(next)
  renderPanel()
  persist()
}

function closeTab(ts, tabId) {
  const i = ts.tabs.findIndex((t) => t.id === tabId)
  if (i < 0) return
  const tab = ts.tabs[i]
  walkLeaves(tab.layout, (pid) => {
    const p = ts.panes.get(pid)
    if (p) { killPane(p); ts.panes.delete(pid) }
  })
  ts.tabs.splice(i, 1)
  if (ts.activeTabId === tabId) ts.activeTabId = ts.tabs[i] ? ts.tabs[i].id : (ts.tabs[0] ? ts.tabs[0].id : null)
  renderPanel()
  persist()
}

function toggleMax() {
  ui.max = !ui.max
  const ed = document.querySelector('.ed')
  if (ed) ed.classList.toggle('term-max', ui.max)
  saveUi()
  const ts = tasks.get(currentTaskId)
  if (ts) setTimeout(() => fitActive(ts), 60)
}

export function toggleTerminal(force) {
  if (!currentTaskId) return
  // 需求便签/看板页面不显示终端，也不允许在此打开
  if (termBlocked()) return
  const ts = taskState(currentTaskId)
  ts.open = force === undefined ? !ts.open : !!force
  if (panel) panel.classList.toggle('on', ts.open)
  syncToggle()
  saveLayout(currentTaskId)
  if (ts.open) {
    if (!ts.tabs.length) newTab()
    else { renderPanel(); setTimeout(focusActive, 60) }
  } else {
    hideBatchMenu()
    const tab = activeTab(ts)
    const pane = tab && ts.panes.get(tab.activePaneId)
    if (pane && pane.term) pane.term.blur()
  }
}

export async function attachTaskTerminal(taskId) {
  currentTaskId = taskId
  hideBatchMenu()
  if (!panel) return
  if (!taskId) { panel.classList.remove('on'); syncToggle(); return }
  const ts = await loadStored(taskId)
  panel.classList.toggle('on', !!ts.open)
  syncToggle()
  renderPanel()
}

// ---------- 初始化 ----------

export function initTerminalView() {
  panel = $('#termPanel')
  body = $('#termBody')
  tabsEl = $('#termTabs')
  if (!panel || !body) return

  store('settings.get', { key: UI_KEY, dflt: '' }).then((raw) => {
    if (!raw) return
    try {
      ui = { ...ui, ...JSON.parse(raw) }
      applyUi()
    } catch {}
  }).catch(() => {})

  function applyUi() {
    if (panel) panel.style.height = (ui.height || 260) + 'px'
    const ed = document.querySelector('.ed')
    if (ed) ed.classList.toggle('term-max', !!ui.max)
    syncToggle()
  }
  applyUi()

  const toggle = $('#termToggle')
  if (toggle) toggle.addEventListener('click', () => toggleTerminal())
  const on2 = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn) }
  on2('#termNew', () => newTab())
  const termNewBtn = $('#termNew')
  if (termNewBtn) {
    termNewBtn.addEventListener('mouseenter', () => showBatchMenu(termNewBtn))
    termNewBtn.addEventListener('mouseleave', scheduleHideBatchMenu)
  }
  document.addEventListener('mousedown', (e) => {
    if (!batchMenu || !batchMenu.classList.contains('on')) return
    if (batchMenu.contains(e.target)) return
    if (termNewBtn && termNewBtn.contains(e.target)) return
    hideBatchMenu()
  }, true)
  on2('#termSplitH', () => splitActive('row'))
  on2('#termSplitV', () => splitActive('col'))
  on2('#termMax', toggleMax)
  on2('#termClose', () => toggleTerminal(false))

  const grip = $('#termResize')
  if (grip) {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      const startY = e.clientY
      const startH = panel.getBoundingClientRect().height
      const move = (ev) => {
        const h = Math.min(window.innerHeight * 0.75, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)))
        ui.height = Math.round(h)
        panel.style.height = ui.height + 'px'
      }
      const up = () => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        try { grip.releasePointerCapture(e.pointerId) } catch {}
        saveUi()
        const ts = tasks.get(currentTaskId)
        if (ts) fitActive(ts)
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
    })
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'Backquote') {
      if (document.querySelector('.zz-modal')) return
      e.preventDefault()
      toggleTerminal()
    }
  }, true)

  zz.on('terminal:data', ({ id, data }) => {
    const pane = panesByTerm.get(id)
    if (pane && pane.term) pane.term.write(data)
  })
  zz.on('terminal:exit', ({ id, code, error }) => {
    const pane = panesByTerm.get(id)
    if (!pane || !pane.term) return
    panesByTerm.delete(id)
    // 正常退出（如输入 exit）直接关闭窗格，空标签一并关闭；异常退出保留重试
    if (!error && (code === 0 || code === undefined || code === null)) {
      pane.dead = true
      const ts = tasks.get(pane.taskId)
      const tab = ts && findTabOf(ts, pane.paneId)
      if (ts && tab) closePane(ts, tab, pane.paneId)
      else {
        try { pane.term.dispose() } catch {}
        try { pane.el && pane.el.remove() } catch {}
      }
      return
    }
    pane.dead = true
    const extra = error ? '：' + error : ''
    pane.term.write(`\r\n\x1b[90m[进程已退出，代码 ${code}${extra}，回车重试]\x1b[0m\r\n`)
  })

  on('task-deleted', (taskId) => {
    const ts = tasks.get(taskId)
    if (!ts) return
    for (const pane of ts.panes.values()) killPane(pane)
    tasks.delete(taskId)
    if (currentTaskId === taskId) { currentTaskId = null; panel.classList.remove('on') }
  })
  // 切到/离开需求便签时同步终端按钮高亮（便签页面不显示、不可打开终端）
  on('pane-changed', () => syncToggle())
}
