// 任务目录文件树（VS Code 风格：展开箭头、缩进参考线、类型图标、空白右键菜单）
import { fsapi, dialog } from '../lib/api.js'
import { state, activeTask } from '../lib/state.js'
import { esc, ic, refreshIcons, joinPath, dirname, basename } from '../lib/ui.js'
import { openFile, closeFile } from './editor.js'
import { promptText } from '../components/modal.js'
import { showContextMenu } from '../components/contextMenu.js'
import { toast } from '../components/toast.js'

const expanded = new Set()
const CHEV = `<span class="chev">${ic('chevron-right', 12)}</span>`
// 元数据目录不展示（项目文件视图只关心任务内容）
const HIDDEN = new Set(['.zzwork'])
let lastTaskPath = ''
// 拖拽移动文件/文件夹：{ path, name, dir }
let dragFile = null

const normSlash = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
// child 是否等于 parent 或位于 parent 之下
function isUnderPath(parent, child) {
  const p = normSlash(parent)
  const c = normSlash(child)
  return !!p && (c === p || c.startsWith(p + '/'))
}
// destDir 能否接收当前拖拽项
function validDrop(destDir) {
  const src = dragFile
  if (!src || !destDir) return false
  if (normSlash(dirname(src.path)) === normSlash(destDir)) return false // 原地
  if (src.dir && isUnderPath(src.path, destDir)) return false // 不能移入自身/后代
  return true
}

// 移动后修正展开状态（原路径前缀整体替换为新路径）
function remapExpanded(from, to) {
  for (const p of [...expanded]) {
    if (!isUnderPath(from, p)) continue
    expanded.delete(p)
    expanded.add(to + String(p).slice(String(from).length))
  }
}

// 关闭受移动影响的已打开文件（其磁盘路径已失效）
async function closeTabsUnder(from) {
  for (const t of state.fileTabs.filter((tab) => isUnderPath(from, tab.path))) {
    try { await closeFile(t.path) } catch {}
  }
}

async function moveEntry(destDir, container) {
  const src = dragFile
  dragFile = null
  if (!src || !destDir) return
  if (normSlash(dirname(src.path)) === normSlash(destDir)) return
  if (src.dir && isUnderPath(src.path, destDir)) return
  const target = joinPath(destDir, src.name)
  try { await fsapi('rename', { from: src.path, to: target }) } catch (e) { toast('移动失败：' + e.message, 'err', 4000); return }
  remapExpanded(src.path, target)
  await closeTabsUnder(src.path)
  await renderFileTree(container, container.__ftOpts)
}

export async function renderFileTree(container, opts = {}) {
  // 记住本次渲染选项，供内部新建/重命名/删除/移动后的重渲染复用（侧栏树不带 opts，回退到 activeTask）
  container.__ftOpts = opts
  const task = opts.task || activeTask()
  const root = opts.root || (task && task.path)
  if (!root) {
    lastTaskPath = ''
    container.innerHTML = `<div class="empty" style="padding:10px 8px;font-size:11px">选择任务后显示文件</div>`
    return
  }
  // 同一任务重渲染（刷新/新建/重命名）保留滚动位置；切任务归零
  const prevScroll = (root === lastTaskPath && container.querySelector('#ftreeBody')?.scrollTop) || 0
  lastTaskPath = root
  container.innerHTML = `
    <div class="treebar">
      <button class="ib" id="ftNewFile" title="新建文件"><i data-lucide="file-plus" style="width:13px;height:13px"></i></button>
      <button class="ib" id="ftNewDir" title="新建文件夹"><i data-lucide="folder-plus" style="width:13px;height:13px"></i></button>
      <button class="ib" id="ftRefresh" title="刷新"><i data-lucide="rotate-cw" style="width:12px;height:12px"></i></button>
      <button class="ib" id="ftReveal" title="在资源管理器中显示"><i data-lucide="external-link" style="width:12px;height:12px"></i></button>
      <span class="root">${esc(basename(root))}</span>
    </div>
    <div class="ftree" id="ftreeBody"></div>`
  refreshIcons()

  container.querySelector('#ftNewFile').addEventListener('click', () => newEntry(root, false, container))
  container.querySelector('#ftNewDir').addEventListener('click', () => newEntry(root, true, container))
  container.querySelector('#ftRefresh').addEventListener('click', () => renderFileTree(container, container.__ftOpts))
  container.querySelector('#ftReveal').addEventListener('click', () => fsapi('reveal', { path: root }).catch((e) => toast(e.message, 'err')))

  const body = container.querySelector('#ftreeBody')
  body.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.fr')) return
    e.preventDefault()
    e.stopPropagation()
    showContextMenu(e.clientX, e.clientY, [
      { label: '新建文件', icon: 'file-plus', action: () => newEntry(root, false, container) },
      { label: '新建文件夹', icon: 'folder-plus', action: () => newEntry(root, true, container) },
      { sep: true },
      { label: '刷新', icon: 'rotate-cw', action: () => renderFileTree(container, container.__ftOpts) },
      { label: '在资源管理器中显示', icon: 'external-link', action: () => fsapi('reveal', { path: root }).catch((err) => toast(err.message, 'err')) }
    ])
  })

  // 拖到树空白处 = 移到任务根目录
  body.addEventListener('dragover', (e) => {
    if (!dragFile || e.target.closest('.fr')) return
    if (!validDrop(root)) return
    e.preventDefault()
    try { e.dataTransfer.dropEffect = 'move' } catch {}
    body.classList.add('drop-root')
  })
  body.addEventListener('dragleave', (e) => {
    if (e.target === body) body.classList.remove('drop-root')
  })
  body.addEventListener('drop', async (e) => {
    if (e.target.closest('.fr')) return
    e.preventDefault()
    body.classList.remove('drop-root')
    await moveEntry(root, container)
  })

  await rebuild(container, root)
  const nb = container.querySelector('#ftreeBody')
  if (nb && prevScroll) nb.scrollTop = prevScroll
}

async function rebuild(container, root) {
  const body = container.querySelector('#ftreeBody')
  if (!body) return
  const scroll = body.scrollTop
  body.innerHTML = ''
  await buildTree(body, container, root, 0)
  body.scrollTop = scroll
  refreshIcons()
  markActive(container)
}

function markActive(container) {
  for (const row of container.querySelectorAll('#ftreeBody .fr')) {
    row.classList.toggle('sel', row.dataset.path === state.activeFile)
  }
}

async function buildTree(body, host, dirPath, depth, after) {
  let list = []
  try { list = await fsapi('readDir', { path: dirPath }) } catch (e) {
    const div = document.createElement('div')
    div.className = 'empty'
    div.textContent = `无法读取目录：${e.message}`
    if (after) after.insertAdjacentElement('afterend', div)
    else body.appendChild(div)
    return after || null
  }
  list = list.filter((it) => !HIDDEN.has(it.name))
  if (!list.length) {
    if (depth === 0) body.innerHTML = `<div class="empty">目录为空。右键或点击上方按钮新建文件。</div>`
    return after || null
  }
  let last = after || null
  for (const it of list) {
    const isOpen = expanded.has(it.path)
    const row = document.createElement('div')
    row.className = 'fr' + (it.dir ? ' dir' : '') + (isOpen ? ' open' : '')
    row.dataset.path = it.path
    row.title = it.name
    if (state.activeFile === it.path) row.classList.add('sel')
    const [icon, color] = it.dir ? [(isOpen ? 'folder-open' : 'folder'), '#dcb67a'] : fileIcon(it.name)
    row.innerHTML = `${'<span class="ind"></span>'.repeat(depth)}${it.dir ? CHEV : '<span class="chev"></span>'}<span class="fi" style="color:${color}">${ic(icon, 13)}</span><span class="nm">${esc(it.name)}</span>`
    if (last) last.insertAdjacentElement('afterend', row)
    else body.appendChild(row)
    last = row

    // 拖拽源
    row.draggable = true
    row.addEventListener('dragstart', (e) => {
      dragFile = { path: it.path, name: it.name, dir: !!it.dir }
      try { e.dataTransfer.effectAllowed = 'move' } catch {}
      try { e.dataTransfer.setData('text/plain', it.path) } catch {}
      row.classList.add('dragging')
    })
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragFile = null })
    // 文件夹作为放置目标：移入该文件夹
    if (it.dir) {
      row.addEventListener('dragover', (e) => {
        if (!validDrop(it.path)) return
        if (e.relatedTarget && row.contains(e.relatedTarget)) return
        e.preventDefault()
        e.stopPropagation()
        try { e.dataTransfer.dropEffect = 'move' } catch {}
        row.classList.add('drop-into')
      })
      row.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && row.contains(e.relatedTarget)) return
        row.classList.remove('drop-into')
      })
      row.addEventListener('drop', async (e) => {
        if (!validDrop(it.path)) return
        e.preventDefault()
        e.stopPropagation()
        row.classList.remove('drop-into')
        await moveEntry(it.path, host)
      })
    }

    row.addEventListener('click', async () => {
      if (it.dir) {
        // 只增删该目录的子节点，避免整树重建导致的闪烁与滚动跳动
        const open = !expanded.has(it.path)
        if (open) expanded.add(it.path)
        else expanded.delete(it.path)
        row.classList.toggle('open', open)
        const fi = row.querySelector('.fi')
        if (fi) fi.innerHTML = ic(open ? 'folder-open' : 'folder', 13)
        refreshIcons()
        if (open) {
          await buildTree(body, host, task, it.path, depth + 1, row)
          refreshIcons()
        } else {
          removeDescendants(body, it.path)
        }
      } else {
        const ftOpts = host.__ftOpts || {}
        if (ftOpts.onOpenFile) await ftOpts.onOpenFile(it.path, it.name)
        else { await openFile(it.path, it.name); markActive(host) }
      }
    })
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const items = []
      if (it.dir) items.push({ label: '新建文件', icon: 'file-plus', action: () => newEntry(it.path, false, host) })
      items.push({ label: '重命名…', icon: 'pencil', action: () => renameEntry(it, host) })
      items.push({ label: '删除', icon: 'trash-2', danger: true, action: () => deleteEntry(it, host) })
      items.push({ sep: true })
      items.push({ label: '在资源管理器中显示', icon: 'external-link', action: () => fsapi('reveal', { path: it.path }).catch((err) => toast(err.message, 'err')) })
      showContextMenu(e.clientX, e.clientY, items)
    })

    if (it.dir && isOpen) last = (await buildTree(body, host, it.path, depth + 1, last)) || last
  }
  return last
}

function removeDescendants(body, dirPath) {
  const prefixes = [dirPath + '\\', dirPath + '/']
  for (const row of [...body.querySelectorAll('.fr')]) {
    const p = row.dataset.path || ''
    if (prefixes.some((pre) => p.startsWith(pre))) row.remove()
  }
}

function fileIcon(name) {
  const ext = String(name).split('.').pop().toLowerCase()
  if (ext === 'md' || ext === 'markdown') return ['file-text', '#519aba']
  if (ext === 'json') return ['braces', '#cbcb41']
  if (['js', 'mjs', 'cjs'].includes(ext)) return ['file-code', '#cbcb41']
  if (['ts', 'tsx', 'jsx'].includes(ext)) return ['file-code', '#519aba']
  if (['css', 'scss', 'less'].includes(ext)) return ['file-code', '#519aba']
  if (['html', 'htm', 'xml'].includes(ext)) return ['file-code', '#e37933']
  if (['yml', 'yaml', 'toml', 'ini', 'env'].includes(ext)) return ['file-code', '#a074c4']
  if (['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'].includes(ext)) return ['terminal', '#89e051']
  if (['py', 'go', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'lua'].includes(ext)) return ['file-code', '#519aba']
  if (ext === 'rs') return ['file-code', '#dea584']
  if (['java', 'kt'].includes(ext)) return ['file-code', '#cc3e44']
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return ['image', '#a074c4']
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return ['file-archive', '#dad8d8']
  if (ext === 'pdf') return ['file-text', '#e37933']
  return ['file', 'inherit']
}

async function newEntry(dirPath, isDir, container) {
  const name = await promptText(isDir ? '新建文件夹' : '新建文件', '名称', '', { placeholder: isDir ? '例如 src' : '例如 notes.md' })
  if (!name) return
  const target = joinPath(dirPath, name)
  try {
    if (isDir) await fsapi('mkdir', { path: target })
    else await fsapi('writeFile', { path: target, content: '' })
  } catch (e) { toast('创建失败：' + e.message, 'err', 4000); return }
  if (dirPath) expanded.add(dirPath)
  await renderFileTree(container, container.__ftOpts)
  if (!isDir) {
    const ftOpts = container.__ftOpts || {}
    if (ftOpts.onOpenFile) ftOpts.onOpenFile(target, name)
    else openFile(target, name)
  }
}

async function renameEntry(it, container) {
  const name = await promptText('重命名', it.dir ? '文件夹名称' : '文件名', it.name)
  if (!name || name === it.name) return
  const target = joinPath(dirname(it.path), name)
  try { await fsapi('rename', { from: it.path, to: target }) } catch (e) { toast('重命名失败：' + e.message, 'err', 4000); return }
  if (expanded.has(it.path)) { expanded.delete(it.path); expanded.add(target) }
  if (state.activeFile === it.path) { try { await closeFile(it.path) } catch {} }
  await renderFileTree(container, container.__ftOpts)
}

async function deleteEntry(it, container) {
  const ok = await dialog('confirm', {
    message: `删除「${it.name}」？`,
    detail: it.dir ? '文件夹及其内容会被永久删除。' : '文件会被永久删除。'
  })
  if (!ok) return
  if (state.activeFile === it.path) { try { await closeFile(it.path) } catch {} }
  try { await fsapi('delete', { path: it.path }) } catch (e) { toast('删除失败：' + e.message, 'err', 4000); return }
  await renderFileTree(container, container.__ftOpts)
  toast('已删除 ' + it.name)
}

export function resetFileTreeState() {
  expanded.clear()
}
