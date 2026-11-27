// Monaco 编辑器（懒加载）+ 每个任务的文件 tab 记忆
import { fsapi, dialog, store, lspapi } from '../lib/api.js'
import { state, emit, activeTask } from '../lib/state.js'
import { $, esc, ic, basename, dirname, refreshIcons } from '../lib/ui.js'
import { toast } from '../components/toast.js'

let monaco = null
let editor = null
let ready = null
const models = new Map()   // path -> { model, saved, dirty }
let hostObserver = null

// 图片 / HTML / Markdown / JSON 预览：复用 pane-file，用一个覆盖层呈现
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])
const HTML_EXT = new Set(['html', 'htm'])
const MD_EXT = new Set(['md', 'markdown'])
const JSON_EXT = new Set(['json'])
const WIN_PATH_RE = /^[a-zA-Z]:[\\/]/
const previewFailed = new Set()   // 读取失败的图片退回源码，避免每次激活都重试
const viewMode = new Map()        // path -> 'preview' | 'source'（用户手动切换后覆盖默认）

// 「转到定义」：SSH / WSL 目标用 zzfile: 自定义 URI 承载（纯身份 + opener 路由）
let providersReady = false
const NAV_LANGS = ['python', 'c', 'cpp', 'go', 'rust']
const externalUriByPath = new Map()   // path -> id
const externalPathById = new Map()    // id -> path
let extSeq = 0
const noServerNotified = new Set()

function langOf(name) {
  const ext = String(name).split('.').pop().toLowerCase()
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', css: 'css', scss: 'scss',
    html: 'html', htm: 'html', md: 'markdown', py: 'python', go: 'go', rs: 'rust',
    java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', sh: 'shell',
    ps1: 'powershell', yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql', toml: 'ini',
    diff: 'diff', patch: 'diff'
  }
  return map[ext] || 'plaintext'
}

// ---------- 图片 / HTML 预览 ----------
function extOf(name) {
  const s = String(name || '')
  return s.includes('.') ? s.split('.').pop().toLowerCase() : ''
}

// 返回可渲染类型：image / html / md / json / ''（不可渲染）
function viewKind(path, name) {
  const p = String(path)
  if (previewFailed.has(p)) return ''
  const ext = extOf(name || p)
  if (IMAGE_EXT.has(ext) && !/^ssh:\/\//i.test(p)) return 'image'
  // HTML 预览只支持本地盘路径（WSL/SSH 无法解析相对资源），且必须落在任务目录内
  if (HTML_EXT.has(ext) && WIN_PATH_RE.test(p) && isUnder(currentTaskPath(), p)) return 'html'
  if (MD_EXT.has(ext)) return 'md'
  if (JSON_EXT.has(ext)) return 'json'
  return ''
}

// 各类文件的默认视图：html/md 默认渲染，json 默认源码
function defaultMode(kind) {
  return kind === 'json' ? 'source' : 'preview'
}

function currentMode(tab, kind) {
  if (kind === 'image') return 'preview'
  return viewMode.get(tab.path) || defaultMode(kind)
}

// 在「预览/格式」与「源码」之间切换，并记住该文件的选择
function toggleView(tab) {
  const kind = viewKind(tab.path, tab.name)
  if (!kind || kind === 'image') return
  viewMode.set(tab.path, currentMode(tab, kind) === 'preview' ? 'source' : 'preview')
  activate(tab.path)
}

function previewUrl(p) {
  const norm = String(p).replace(/\\/g, '/')
  return 'zzwork-file://local/' + norm.split('/').map(encodeURIComponent).join('/')
}

// 渲染栏右侧的「源码」按钮（预览 → 源码）
function pvSourceBtn() {
  return `<button class="btn sm" data-pv="toggle">${ic('file-code', 11)} 源码</button>`
}

function bindPvToggle(host, tab) {
  const b = host.querySelector('[data-pv="toggle"]')
  if (b) b.addEventListener('click', () => toggleView(tab))
}

async function readPreviewText(tab) {
  try { return await fsapi('readFile', { path: tab.path }) }
  catch { try { return await fsapi('readFileExternal', { path: tab.path }) } catch { return null } }
}

async function openPreview(tab, kind) {
  const host = $('#previewHost')
  const ed = $('#editorHost')
  if (!host || !ed) return false
  if (kind === 'image') {
    let d
    try { d = await fsapi('readBase64', { path: tab.path }) } catch (e) {
      previewFailed.add(tab.path)
      toast('无法预览图片：' + e.message, 'err', 4000)
      return false
    }
    host.innerHTML = `<div class="imgpane"><img src="${esc(d.dataUrl)}" alt="${esc(tab.name)}" title="点击放大"></div>`
    const img = host.querySelector('img')
    if (img) img.addEventListener('click', () => {
      import('../components/markdown.js').then((m) => m.openImageZoom(d.dataUrl, tab.name)).catch(() => {})
    })
  } else if (kind === 'html') {
    const url = previewUrl(tab.path)
    host.innerHTML = `<div class="pvbar"><span class="nm">${ic('globe', 11)} ${esc(tab.name)}</span>
      <button class="btn sm" data-pv="reload">${ic('refresh-cw', 11)} 刷新</button>
      ${pvSourceBtn()}</div>
      <iframe class="pvframe" id="pvFrame" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" src="${esc(url)}"></iframe>`
    const frame = host.querySelector('#pvFrame')
    if (frame) frame.addEventListener('load', () => { frame.dataset.loaded = '1' })
    const reload = host.querySelector('[data-pv="reload"]')
    if (reload) reload.addEventListener('click', () => {
      const f = host.querySelector('#pvFrame')
      if (f) f.src = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now()
    })
    bindPvToggle(host, tab)
  } else if (kind === 'md' || kind === 'json') {
    const text = await readPreviewText(tab)
    if (text == null) { toast('无法打开文件', 'err', 4000); return false }
    if (kind === 'md') {
      const m = await import('../components/markdown.js')
      host.innerHTML = `<div class="pvbar"><span class="nm">${ic('file-text', 11)} ${esc(tab.name)}</span>${pvSourceBtn()}</div>
        <div class="mdview md" id="mdView">${m.renderMarkdown(text)}</div>`
      const mdv = host.querySelector('#mdView')
      if (mdv) { m.highlightIn(mdv); m.enhanceMarkdown(mdv, { root: dirname(tab.path) }); m.bindMarkdownClicks(mdv) }
    } else {
      let pretty = text
      try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch {}
      host.innerHTML = `<div class="pvbar"><span class="nm">${ic('braces', 11)} ${esc(tab.name)}</span>${pvSourceBtn()}</div>
        <pre class="jsonview" id="jsonView"></pre>`
      const pre = host.querySelector('#jsonView')
      if (pre) pre.textContent = pretty
    }
    bindPvToggle(host, tab)
  }
  host.style.display = 'flex'
  ed.style.display = 'none'
  refreshIcons()
  return true
}

function hidePreview() {
  const host = $('#previewHost')
  if (!host) return
  host.style.display = 'none'
  host.innerHTML = ''
  const ed = $('#editorHost')
  if (ed) ed.style.display = ''
}

// 源码模式下右上角的「预览/格式化」切换按钮
function showSourceBar(tab, kind) {
  const bar = $('#fileBar')
  if (!bar) return
  if (!kind || kind === 'image') { hideFileBar(); return }
  const label = kind === 'json' ? '格式化' : '预览'
  const icon = kind === 'json' ? 'braces' : (kind === 'md' ? 'eye' : 'globe')
  bar.innerHTML = `<button class="btn sm" data-pv="toggle">${ic(icon, 11)} ${label}</button>`
  bar.style.display = 'flex'
  const b = bar.querySelector('[data-pv="toggle"]')
  if (b) b.addEventListener('click', () => toggleView(tab))
  refreshIcons()
}

function hideFileBar() {
  const bar = $('#fileBar')
  if (!bar) return
  bar.style.display = 'none'
  bar.innerHTML = ''
}

function showFilePane() {
  state.pane = 'file'
  const pane = document.getElementById('pane-file')
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p === pane))
  emit('pane-changed', 'file')
  emit('tabs-changed')
}

// ---------- 转到定义 ----------
function makeUri(path) {
  const p = String(path || '')
  if (/^\\\\wsl/i.test(p) || /^ssh:\/\//i.test(p)) {
    let id = externalUriByPath.get(p)
    if (!id) { id = 'x' + (++extSeq); externalUriByPath.set(p, id); externalPathById.set(id, p) }
    return monaco.Uri.parse('zzfile:///' + id)
  }
  return monaco.Uri.file(p)
}

function pathFromUri(uri) {
  if (!uri) return ''
  if (uri.scheme === 'zzfile') return externalPathById.get(String(uri.path || '').replace(/^\//, '')) || ''
  try { return uri.fsPath || '' } catch { return '' }
}

function isUnder(root, p) {
  if (!root) return true
  const r = String(root).replace(/[/\\]+$/, '').toLowerCase()
  const t = String(p).toLowerCase()
  return t === r || t.startsWith(r + '\\') || t.startsWith(r + '/')
}

function currentTaskPath() {
  // 看板卡片的工作目录即其任务目录：卡片激活时以其路径为根，html 预览等按此判定归属
  if (state.mode === 'card' && state.cardActive) {
    const c = state.boardCards.find((x) => x.id === state.cardActive) || state.tasks.find((x) => x.id === state.cardActive)
    if (c && c.path) return c.path
  }
  const t = activeTask()
  return (t && t.path) || ''
}

function findModelPath(model) {
  for (const [p, e] of models) if (e.model === model) return p
  try { return model.uri && model.uri.scheme === 'file' ? model.uri.fsPath : '' } catch { return '' }
}

function posFromSelectionOrPosition(x) {
  if (!x) return {}
  if (x.startLineNumber) return { line: x.startLineNumber - 1, character: x.startColumn - 1 }
  if (x.selectionStartLineNumber) return { line: x.selectionStartLineNumber - 1, character: x.selectionStartColumn - 1 }
  if (x.lineNumber) return { line: x.lineNumber - 1, character: x.column - 1 }
  return {}
}

async function provideDefinition(model, position) {
  const taskPath = currentTaskPath()
  const filePath = findModelPath(model)
  if (!taskPath || !filePath) return null
  let res
  try {
    res = await lspapi('definition', {
      taskPath,
      filePath,
      languageId: model.getLanguageId(),
      position: { line: position.lineNumber - 1, character: position.column - 1 },
      content: model.getValue()
    })
  } catch { return null }
  if (!res || !res.locations || !res.locations.length) {
    if (res && res.reason === 'no-server') {
      const key = taskPath + '::' + model.getLanguageId()
      if (!noServerNotified.has(key)) {
        noServerNotified.add(key)
        const cands = (res.candidates || []).join(' / ') || 'clangd'
        toast('本环境未找到 ' + model.getLanguageId() + ' 语言服务器（需 ' + cands + '）', 'err', 5000)
      }
    }
    return null
  }
  return res.locations.map((loc) => {
    const ln = Math.max(1, (loc.line | 0) + 1)
    const col = Math.max(1, (loc.character | 0) + 1)
    return { uri: makeUri(loc.path), range: { startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col + 1 } }
  })
}

async function gotoAtCursor() {
  if (!editor) return
  const model = editor.getModel()
  const position = editor.getPosition()
  if (!model || !position) return
  const locs = await provideDefinition(model, position)
  if (!locs || !locs.length) { toast('未找到定义', 'info', 2000); return }
  const first = locs[0]
  const path = pathFromUri(first.uri)
  if (!path) return
  const external = !isUnder(currentTaskPath(), path)
  await openFile(path, undefined, { external })
  await revealInEditor(path, { line: first.range.startLineNumber - 1, character: first.range.startColumn - 1 })
}

export async function revealInEditor(path, pos = {}) {
  const line = Math.max(0, pos.line | 0)
  const character = Math.max(0, pos.character | 0)
  await activate(path)
  if (!editor) return
  try {
    editor.revealLineInCenter(line + 1)
    editor.setPosition({ lineNumber: line + 1, column: character + 1 })
    editor.focus()
  } catch {}
}

function registerNavigation() {
  if (providersReady) return
  providersReady = true
  for (const lang of NAV_LANGS) {
    monaco.languages.registerDefinitionProvider(lang, { provideDefinition })
  }
  // 跳转目标统一走自有 tab 体系打开（库文件只读）；返回 true 拦截默认打开
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const path = pathFromUri(resource)
      if (!path) return false
      const pos = posFromSelectionOrPosition(selectionOrPosition)
      const external = !isUnder(currentTaskPath(), path)
      openFile(path, undefined, { external })
        .then(() => revealInEditor(path, pos))
        .catch(() => {})
      return true
    }
  })
}

async function ensureMonaco() {
  if (ready) return ready
  ready = (async () => {
    const [EditorWorker, JsonWorker, CssWorker, HtmlWorker, TsWorker, mon] = await Promise.all([
      import('monaco-editor/editor/editor.worker.js?worker'),
      import('monaco-editor/language/json/json.worker.js?worker'),
      import('monaco-editor/language/css/css.worker.js?worker'),
      import('monaco-editor/language/html/html.worker.js?worker'),
      import('monaco-editor/language/typescript/ts.worker.js?worker'),
      import('monaco-editor')
    ])
    globalThis.MonacoEnvironment = {
      getWorker(_id, label) {
        if (label === 'json') return new JsonWorker.default()
        if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker.default()
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker.default()
        if (label === 'typescript' || label === 'javascript') return new TsWorker.default()
        return new EditorWorker.default()
      }
    }
    monaco = mon
    if (!monaco.languages.getLanguages().some((l) => l.id === 'diff')) {
      monaco.languages.register({ id: 'diff' })
      monaco.languages.setMonarchTokensProvider('diff', {
        tokenizer: {
          root: [
            [/^(diff --git|index ).*/, 'diff.meta'],
            [/^(\+\+\+|---)( .*)?$/, 'diff.meta'],
            [/^@@.*@@.*/, 'diff.hunk'],
            [/^\+.*/, 'diff.inserted'],
            [/^-.*/, 'diff.deleted']
          ]
        }
      })
    }
    monaco.editor.defineTheme('zzwork-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'diff.inserted', foreground: '4ade80' },
        { token: 'diff.deleted', foreground: 'f87171' },
        { token: 'diff.hunk', foreground: '7dd3fc' },
        { token: 'diff.meta', foreground: '6f7275' }
      ],
      colors: {
        'editor.background': '#171717',
        'editor.lineHighlightBackground': '#ffffff08',
        'editorLineNumber.foreground': '#6f7275',
        'editorIndentGuide.background1': '#ffffff10'
      }
    })
    editor = monaco.editor.create($('#editorHost'), {
      theme: 'zzwork-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      renderWhitespace: 'selection',
      scrollBeyondLastLine: false,
      tabSize: 2
    })
    registerNavigation()
    editor.addCommand(monaco.KeyCode.F12, () => { gotoAtCursor() })
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 's') return
      if (!state.activeFile) return
      e.preventDefault()
      saveActive()
    }, true)
    hostObserver = new ResizeObserver(() => editor && editor.layout())
    hostObserver.observe($('#editorHost'))
  })()
  return ready
}

async function loadEntry(path, name, virtual, content, external) {
  if (models.has(path)) return models.get(path)
  await ensureMonaco()
  let text = ''
  if (virtual) {
    text = String(content || '')
  } else {
    try { text = await fsapi('readFile', { path }) }
    catch {
      try { text = await fsapi('readFileExternal', { path }) }
      catch (e) { toast('无法打开文件：' + e.message, 'err', 4000); return null }
    }
  }
  const uri = virtual ? monaco.Uri.parse(path) : monaco.Uri.file(path)
  const old = monaco.editor.getModel(uri)
  const model = old || monaco.editor.createModel(text, langOf(name), uri)
  const entry = { model, saved: text, dirty: false, virtual: !!virtual, readOnly: !!external }
  models.set(path, entry)
  if (!virtual && !external) {
    model.onDidChangeContent(() => {
      const dirty = model.getValue() !== entry.saved
      if (dirty === entry.dirty) return
      entry.dirty = dirty
      const tab = state.fileTabs.find((t) => t.path === path)
      if (tab) tab.dirty = dirty
      if (dirty && !state.changes.some((c) => c.path === path)) {
        state.changes.push({ path, name })
        emit('changes-updated')
      }
      emit('tabs-changed')
    })
  }
  return entry
}

function persistMemory(taskId) {
  if (!taskId || state.mode === 'card') return
  const paths = state.fileTabs.filter((t) => !t.virtual).map((t) => t.path)
  store('settings.set', { key: 'workbench:files:' + taskId, value: JSON.stringify(paths) }).catch(() => {})
}

export async function openFile(path, name, opts = {}) {
  const existing = state.fileTabs.find((t) => t.path === path)
    || state.fileTabs.find((t) => String(t.path).toLowerCase() === String(path).toLowerCase())
  const tabPath = existing ? existing.path : path
  const fname = name || basename(tabPath)
  if (!existing) {
    state.fileTabs.push({ path: tabPath, name: fname, dirty: false, external: !!opts.external, readOnly: !!opts.external })
  } else if (opts.external && !existing.readOnly) {
    existing.readOnly = true
    existing.external = true
  }
  persistMemory(state.taskId)
  if (opts.activate === false) { emit('tabs-changed'); return tabPath }
  await activate(tabPath)
  return tabPath
}

function buildDiffText(files) {
  return files.map((f) => {
    const p = (f && f.path) || ''
    const head = `diff --git a/${p} b/${p}`
    const body = f && f.binary ? '（二进制文件）' : String((f && f.patch) || '').replace(/\s+$/, '')
    if (/^diff --git /.test(body)) return body
    return body ? `${head}\n${body}` : `${head}\n（无文本差异）`
  }).join('\n\n')
}

let diffSeq = 0
export async function openDiffTab(files, title) {
  const list = Array.isArray(files) ? files : []
  if (!list.length) return
  await ensureMonaco()
  const content = buildDiffText(list)
  const path = `zzdiff://doc/${Date.now().toString(36)}-${(diffSeq++).toString(36)}`
  const name = (title ? String(title) : 'diff') + '.diff'
  state.fileTabs.push({ path, name, dirty: false, virtual: true, content })
  await activate(path)
}

export async function activate(path) {
  const tab = state.fileTabs.find((t) => t.path === path)
  if (!tab) return
  const kind = tab.virtual ? '' : viewKind(tab.path, tab.name)
  const mode = kind ? currentMode(tab, kind) : 'source'
  if (kind && mode === 'preview' && await openPreview(tab, kind)) {
    state.activeFile = path
    showFilePane()
    hideFileBar()
    return
  }
  const entry = await loadEntry(path, tab.name, tab.virtual, tab.content, tab.external)
  if (!entry) {
    state.fileTabs = state.fileTabs.filter((t) => t.path !== path)
    emit('tabs-changed')
    return
  }
  state.activeFile = path
  if (editor) {
    hidePreview()
    editor.updateOptions({ readOnly: !!(tab.virtual || tab.readOnly) })
    editor.setModel(entry.model)
    editor.layout()
    editor.focus()
  }
  showFilePane()
  showSourceBar(tab, kind)
}

export async function closeFile(path) {
  const entry = models.get(path)
  if (entry && entry.dirty) {
    const ok = await dialog('confirm', { message: '文件有未保存的改动，仍要关闭吗？', detail: '关闭后本次改动将丢失。' })
    if (!ok) return
  }
  if (entry) {
    try { entry.model.dispose() } catch {}
    models.delete(path)
  }
  state.fileTabs = state.fileTabs.filter((t) => t.path !== path)
  persistMemory(state.taskId)
  if (state.activeFile === path) {
    state.activeFile = null
    const next = state.fileTabs[state.fileTabs.length - 1]
    if (next) await activate(next.path)
    else {
      state.pane = 'info'
      hidePreview()
      hideFileBar()
      document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-info'))
      emit('tabs-changed')
    }
  } else {
    emit('tabs-changed')
  }
}

// 批量关闭文件 tab（关闭右侧 / 左侧 / 全部）；有未保存改动时统一确认一次
export async function closeFiles(paths) {
  const set = new Set((Array.isArray(paths) ? paths : []).filter(Boolean))
  if (!set.size) return
  const targets = state.fileTabs.filter((t) => set.has(t.path))
  if (!targets.length) return
  const dirty = targets.filter((t) => {
    const e = models.get(t.path)
    return (e && e.dirty) || t.dirty
  })
  if (dirty.length) {
    const names = dirty.map((t) => t.name)
    const ok = await dialog('confirm', {
      message: `有 ${names.length} 个文件未保存，仍要关闭吗？`,
      detail: names.slice(0, 8).join('、') + (names.length > 8 ? ' 等' : '') + '\n关闭后本次改动将丢失。'
    })
    if (!ok) return
  }
  for (const t of targets) {
    const entry = models.get(t.path)
    if (entry) { try { entry.model.dispose() } catch {}; models.delete(t.path) }
  }
  state.fileTabs = state.fileTabs.filter((t) => !set.has(t.path))
  persistMemory(state.taskId)
  const activeClosed = set.has(state.activeFile)
  if (activeClosed) {
    state.activeFile = null
    const next = state.fileTabs[state.fileTabs.length - 1]
    if (next) await activate(next.path)
    else {
      state.pane = 'info'
      hidePreview()
      hideFileBar()
      document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-info'))
    }
  }
  emit('tabs-changed')
}

export async function saveActive() {
  const path = state.activeFile
  const tab = path && state.fileTabs.find((t) => t.path === path)
  if (tab && (tab.virtual || tab.readOnly)) return
  const entry = path && models.get(path)
  if (!entry) return
  try {
    await fsapi('writeFile', { path, content: entry.model.getValue() })
    entry.saved = entry.model.getValue()
    entry.dirty = false
    const tab = state.fileTabs.find((t) => t.path === path)
    if (tab) tab.dirty = false
    emit('tabs-changed')
    toast('已保存 ' + basename(path))
  } catch (e) { toast('保存失败：' + e.message, 'err', 4000) }
}

export function closeAllFiles(taskId) {
  for (const [, entry] of models) { try { entry.model.dispose() } catch {} }
  models.clear()
  hidePreview()
  hideFileBar()
  if (taskId) persistMemory(taskId)
  state.fileTabs = []
  state.activeFile = null
}

export async function restoreForTask(taskId) {
  if (!taskId) return
  let paths = []
  try {
    const raw = await store('settings.get', { key: 'workbench:files:' + taskId, dflt: '[]' })
    paths = JSON.parse(raw)
  } catch { paths = [] }
  if (!Array.isArray(paths) || !paths.length) return
  for (const p of paths) {
    if (!state.fileTabs.some((t) => t.path === p)) {
      try {
        const exists = await fsapi('exists', { path: p })
        if (exists) state.fileTabs.push({ path: p, name: basename(p), dirty: false })
      } catch {}
    }
  }
  emit('tabs-changed')
}
