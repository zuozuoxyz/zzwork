// 项目视图：分组 + 任务树
import { store, fsapi, dialog, env as envApi } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, ic, taskIcon, refreshIcons, joinPath, safeName, dirname, envLabelFromPath, fmtTime } from '../lib/ui.js'
import { reloadTasks, reloadGroups, reloadTrash } from '../lib/data.js'
import { promptText, openModal } from '../components/modal.js'
import { showContextMenu } from '../components/contextMenu.js'
import { toast } from '../components/toast.js'

// —— 拖拽：任务换组 / 组换父组 ——
let dragSource = null   // { kind:'task'|'group', id }

function descendantGroupIds(id) {
  const children = new Map()
  for (const g of state.groups) {
    const p = g.parent_id || ''
    if (!children.has(p)) children.set(p, [])
    children.get(p).push(g.id)
  }
  const out = new Set()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()
    for (const c of children.get(cur) || []) {
      if (!out.has(c)) { out.add(c); stack.push(c) }
    }
  }
  return out
}

// 当前拖拽是否可落到某目标（组/未分组根）；组需防止拖进自身或后代
function canDrop(target) {
  const src = dragSource
  if (!src) return false
  if (src.kind === 'task') return target.type === 'group' || target.type === 'root'
  if (src.kind === 'group') {
    if (target.type === 'root') return true
    if (target.type === 'group') return target.id !== src.id && !descendantGroupIds(src.id).has(target.id)
  }
  return false
}

function startDrag(e, src, row) {
  dragSource = { kind: src.kind, id: src.id }
  try { e.dataTransfer.effectAllowed = 'move' } catch {}
  try { e.dataTransfer.setData('text/plain', JSON.stringify(dragSource)) } catch {}
  row.classList.add('dragging')
}

function attachDropTarget(el, target) {
  el.addEventListener('dragover', (e) => {
    if (!canDrop(target)) return
    if (e.relatedTarget && el.contains(e.relatedTarget)) return
    e.preventDefault()
    e.stopPropagation()
    try { e.dataTransfer.dropEffect = 'move' } catch {}
    el.classList.add('drop-into')
  })
  el.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return
    el.classList.remove('drop-into')
  })
  el.addEventListener('drop', async (e) => {
    if (!canDrop(target)) return
    e.preventDefault()
    e.stopPropagation()
    el.classList.remove('drop-into')
    const src = dragSource
    dragSource = null
    await applyMove(src, target)
  })
}

async function applyMove(src, target) {
  if (!src) return
  try {
    if (src.kind === 'task') {
      const gid = target.type === 'group' ? target.id : null
      const task = state.tasks.find((t) => t.id === src.id)
      if (!task) return
      if ((task.group_id || null) === gid) return
      await store('tasks.update', { id: src.id, patch: { group_id: gid } })
      await reloadTasks()
      if (gid) state.collapsedGroups.delete(gid)
      toast(gid ? '已移动任务' : '已移出分组')
    } else if (src.kind === 'group') {
      const pid = target.type === 'group' ? target.id : null
      const g = state.groups.find((x) => x.id === src.id)
      if (!g) return
      if ((g.parent_id || null) === pid) return
      await store('groups.update', { id: src.id, patch: { parent_id: pid } })
      await reloadGroups()
      if (pid) state.collapsedGroups.delete(pid)
      toast(pid ? '已移动组' : '已移动到顶级')
    }
  } catch (e) {
    toast('移动失败：' + e.message, 'err', 4000)
  }
  renderProjects()
}

export function initProjectsView() {
  $('#newTaskBtn').addEventListener('click', () => newTask())
  $('#newGroupBtn').addEventListener('click', () => newGroup())
  $('#refreshTasksBtn').addEventListener('click', async () => {
    await Promise.all([reloadGroups(), reloadTasks()])
    renderProjects()
    toast('已刷新任务列表')
  })
  $('#projectsBody').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.row')) return
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, [
      { label: '新建组', icon: 'folder-plus', action: () => newGroup() },
      { label: '新建任务', icon: 'square-plus', action: () => newTask() }
    ])
  })
  // 空白处拖拽 = 移到顶级（组）/ 未分组（任务）
  const pbody = $('#projectsBody')
  pbody.addEventListener('dragover', (e) => {
    if (!dragSource || e.target.closest('.row')) return
    if (!canDrop({ type: 'root' })) return
    e.preventDefault()
    try { e.dataTransfer.dropEffect = 'move' } catch {}
    pbody.classList.add('drop-root')
  })
  pbody.addEventListener('dragleave', (e) => {
    if (e.target === pbody) pbody.classList.remove('drop-root')
  })
  pbody.addEventListener('drop', async (e) => {
    if (e.target.closest('.row')) return
    e.preventDefault()
    pbody.classList.remove('drop-root')
    const src = dragSource
    dragSource = null
    await applyMove(src, { type: 'root' })
  })
}

export function renderProjects() {
  const body = $('#projectsBody')
  const filter = state.filter.trim().toLowerCase()
  const match = (t) => !filter || String(t.name).toLowerCase().includes(filter) || String(t.path || '').toLowerCase().includes(filter)

  const groups = state.groups.slice()
  const groupIds = new Set(groups.map((g) => g.id))
  const childGroups = new Map() // parentId -> [group]
  const roots = []
  for (const g of groups) {
    const pid = g.parent_id && groupIds.has(g.parent_id) ? g.parent_id : ''
    if (pid) {
      if (!childGroups.has(pid)) childGroups.set(pid, [])
      childGroups.get(pid).push(g)
    } else roots.push(g)
  }

  const byGroup = new Map()
  const ungrouped = []
  for (const t of state.tasks) {
    if (t.scope === 'board') continue
    if (!match(t)) continue
    if (t.group_id && groupIds.has(t.group_id)) {
      if (!byGroup.has(t.group_id)) byGroup.set(t.group_id, [])
      byGroup.get(t.group_id).push(t)
    } else ungrouped.push(t)
  }

  // 过滤时：组名命中、或子树内存在命中任务才显示该组
  const groupMatch = new Map()
  function matchGroup(g, seen) {
    if (groupMatch.has(g.id)) return groupMatch.get(g.id)
    seen = seen || new Set()
    if (seen.has(g.id)) return false
    seen.add(g.id)
    const kids = childGroups.get(g.id) || []
    let ok = !filter || g.name.toLowerCase().includes(filter) || (byGroup.get(g.id) || []).length > 0
    if (!ok) ok = kids.some((c) => matchGroup(c, seen))
    groupMatch.set(g.id, ok)
    return ok
  }
  // 徽标任务数（含子组）：组=容器，显示其任务总量
  const countCache = new Map()
  function countTasks(g) {
    if (countCache.has(g.id)) return countCache.get(g.id)
    let n = (byGroup.get(g.id) || []).length
    for (const c of childGroups.get(g.id) || []) n += countTasks(c)
    countCache.set(g.id, n)
    return n
  }

  const taskRow = (t, depth) => {
    const meta = t.meta || {}
    const env = meta.envLabel || envLabelFromPath(t.path)
    const ti = taskIcon(t.type)
    return `<div class="row t1 ${state.mode === 'task' && state.taskId === t.id ? 'sel' : ''}" data-task="${esc(t.id)}" style="padding-left:${24 + depth * 14}px">
      ${ic(ti.name, 13, ti.color)}
      <span class="nm">${esc(t.name)}</span><span class="ds">${esc(env)}</span></div>`
  }

  let markup = ''
  let renderedAnyGroup = false
  const renderGroup = (g, depth) => {
    if (filter && !matchGroup(g)) return
    renderedAnyGroup = true
    const list = byGroup.get(g.id) || []
    const collapsed = state.collapsedGroups.has(g.id) && !filter
    markup += `<div class="row g" data-group="${esc(g.id)}" style="padding-left:${10 + depth * 14}px">
      ${ic(collapsed ? 'chevron-right' : 'chevron-down', 12)}
      ${ic(collapsed ? 'folder' : 'folder-open', 13, '#dcb67a')}
      <span class="nm">${esc(g.name)}</span><span class="ds gcount">${countTasks(g)}</span></div>`
    if (collapsed) return
    markup += list.map((t) => taskRow(t, depth)).join('')
    for (const c of childGroups.get(g.id) || []) renderGroup(c, depth + 1)
  }
  for (const g of roots) renderGroup(g, 0)
  if (ungrouped.length && renderedAnyGroup) {
    markup += `<div class="row sh" data-ungrouped="1"><span class="nm">未分组</span><span class="ds">${ungrouped.length}</span></div>`
  }
  markup += ungrouped.map((t) => taskRow(t, 0)).join('')
  // 回收站（固定在左侧任务列表底部）
  if (!filter) {
    const n = state.trash.length
    markup += `<div class="row g trash-head${state.trashOpen ? ' open' : ''}" data-trash="1">
      ${ic(state.trashOpen ? 'chevron-down' : 'chevron-right', 12)}
      ${ic('trash-2', 13, '#8b949e')}
      <span class="nm">回收站</span><span class="ds">${n}</span>
      ${n ? `<button class="ib trash-empty" data-trash-act="empty" title="清空回收站">${ic('trash-2', 12)}</button>` : ''}</div>`
    if (state.trashOpen) {
      markup += state.trash.length
        ? state.trash.map((t) => `<div class="row t2 trash-item" data-trash-task="${esc(t.id)}" title="${esc(t.path || '')}">
            ${ic('file-x', 12)}
            <span class="nm">${esc(t.name)}</span>
            <span class="ds">${esc(fmtTime(t.deleted_at) || '')}</span>
            <span class="trash-acts">
              <button class="ib" data-trash-act="restore" title="恢复">${ic('rotate-ccw', 12)}</button>
              <button class="ib danger" data-trash-act="purge" title="彻底删除">${ic('x', 12)}</button>
            </span></div>`).join('')
        : `<div class="empty" style="padding:8px 12px">回收站为空</div>`
    }
  }
  if (!markup) {
    markup = `<div class="empty">${filter ? '没有匹配的任务' : '还没有任务。点击右上角 ＋ 新建，或导入已有文件夹。'}</div>`
  }
  body.innerHTML = markup
  refreshIcons()

  body.querySelectorAll('.row[data-task]').forEach((row) => {
    const id = row.getAttribute('data-task')
    row.draggable = true
    row.addEventListener('dragstart', (e) => startDrag(e, { kind: 'task', id }, row))
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragSource = null })
    row.addEventListener('click', () => emit('select-task', id))
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const task = state.tasks.find((t) => t.id === id)
      showContextMenu(e.clientX, e.clientY, [
        { label: '在信息页打开', icon: 'info', action: () => emit('select-task', id) },
        { label: '编辑路径…', icon: 'pencil', action: () => editTaskPath(task) },
        { label: '重命名…', icon: 'pencil-line', action: () => renameTask(task) },
        { sep: true },
        { label: '打开任务目录', icon: 'folder-open', action: () => fsapi('openPath', { path: task.path }).catch((err) => toast(err.message, 'err')) },
        { sep: true },
        { label: '移到回收站', icon: 'trash-2', danger: true, action: () => deleteTask(task) }
      ])
    })
  })

  body.querySelectorAll('.row[data-group]').forEach((row) => {
    const gid = row.getAttribute('data-group')
    const group = state.groups.find((g) => g.id === gid)
    row.draggable = true
    row.addEventListener('dragstart', (e) => startDrag(e, { kind: 'group', id: gid }, row))
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragSource = null })
    attachDropTarget(row, { type: 'group', id: gid })
    row.addEventListener('click', () => {
      if (state.collapsedGroups.has(gid)) state.collapsedGroups.delete(gid)
      else state.collapsedGroups.add(gid)
      renderProjects()
    })
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showContextMenu(e.clientX, e.clientY, [
        { label: '在此组新建任务', icon: 'square-plus', action: () => newTask(gid) },
        { label: '在此组新建子组', icon: 'folder-plus', action: () => newGroup(gid) },
        { sep: true },
        { label: '删除组', icon: 'trash-2', danger: true, action: () => deleteGroup(group) }
      ])
    })
  })

  const ungroupedHead = body.querySelector('[data-ungrouped]')
  if (ungroupedHead) attachDropTarget(ungroupedHead, { type: 'root' })

  const trashHead = body.querySelector('[data-trash]')
  if (trashHead) {
    trashHead.addEventListener('click', (e) => {
      if (e.target.closest('[data-trash-act="empty"]')) { e.stopPropagation(); emptyTrash(); return }
      state.trashOpen = !state.trashOpen
      renderProjects()
    })
  }
  body.querySelectorAll('[data-trash-task]').forEach((row) => {
    const t = state.trash.find((x) => x.id === row.getAttribute('data-trash-task'))
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-trash-act]')
      if (!btn) return
      e.stopPropagation()
      const act = btn.getAttribute('data-trash-act')
      if (act === 'restore') restoreTrashTask(t)
      else if (act === 'purge') purgeTrashTask(t)
    })
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showContextMenu(e.clientX, e.clientY, [
        { label: '恢复任务', icon: 'rotate-ccw', action: () => restoreTrashTask(t) },
        { label: '打开任务目录', icon: 'folder-open', action: () => fsapi('openPath', { path: t.path }).catch((err) => toast(err.message, 'err')) },
        { sep: true },
        { label: '彻底删除', icon: 'trash-2', danger: true, action: () => purgeTrashTask(t) }
      ])
    })
  })
}

// 优先使用环境配置的默认执行体；不可用时回退到该环境首个可用执行体或内置
function pickEnvAgent(env) {
  const det = state.detected[env.id]
  const okIds = det ? det.list.filter((a) => a.ok).map((a) => a.id) : null
  const def = env.config && env.config.defaultAgent
  if (def && (def === 'builtin' || !okIds || okIds.includes(def))) return def
  return (state.agents.find((a) => a.kind === 'cli' && okIds && okIds.includes(a.id))
    || state.agents.find((a) => a.kind === 'builtin') || state.agents[0] || {}).id || 'builtin'
}

// 新建任务前确保已识别该环境的执行体（优先用已缓存结果）
async function ensureEnvDetected(env) {
  if (state.detected[env.id]) return state.detected[env.id]
  try {
    const cfg = env.config || {}
    const r = await envApi('detect', {
      id: env.id, kind: env.kind, distro: cfg.distro, host: cfg.host, user: cfg.user, port: cfg.port
    })
    if (r && Array.isArray(r.list)) state.detected[env.id] = { list: r.list, at: Date.now() }
  } catch {}
  return state.detected[env.id] || null
}

// 组的完整路径标签（父组 / 子组），帮助区分嵌套层级
function groupPathLabel(groupById, g) {
  const parts = []
  let cur = g, guard = 0
  while (cur && guard++ < 50) {
    parts.unshift(cur.name)
    cur = cur.parent_id ? groupById.get(cur.parent_id) : null
  }
  return parts.join(' / ')
}

export async function newTask(groupId) {
  const groupById = new Map(state.groups.map((g) => [g.id, g]))
  const groupOptions = [['', '（不分组）'], ...state.groups.map((g) => [g.id, groupPathLabel(groupById, g)])]
  const envs = state.envs.length ? state.envs : [{ id: 'local', name: '本机', kind: 'local', config: {} }]
  const localEnv = envs.find((e) => e.kind === 'local') || envs[0]
  const r = await showNewTaskModal({ envs, localEnv, groups: groupOptions, groupId })
  if (!r) return
  const name = r.name.trim()
  const env = r.env
  const path = r.path
  const meta = envTaskMeta(env)

  await ensureEnvDetected(env)
  const agentId = pickEnvAgent(env)
  let task
  try {
    task = await store('tasks.create', { dto: { name, type: r.type, groupId: r.group || null, path, agentId, meta } })
  } catch (e) { toast('创建任务失败：' + e.message, 'err', 4000); return }
  try {
    await fsapi('mkdir', { path })
    // info.md 放入 .zzwork（工作区显示时隐藏元数据目录）
    const zzDir = joinPath(path, '.zzwork')
    await fsapi('mkdir', { path: zzDir })
    const infoPath = joinPath(zzDir, 'info.md')
    const exists = await fsapi('exists', { path: infoPath })
    if (!exists) {
      const body = `# ${name}\n\n- 类型：${r.type}\n- 环境：${meta.envLabel || '本机'}\n- 创建时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n\n## 目标\n\n（在这里补充任务目标）\n`
      await fsapi('writeFile', { path: infoPath, content: body })
    }
  } catch (e) {
    toast('目录准备失败：' + e.message, 'err', 4000)
  }
  await reloadTasks()
  renderProjects()
  emit('select-task', task.id)
}

function envTaskMeta(env) {
  const cfg = env.config || {}
  const meta = {}
  if (env.kind === 'wsl') { meta.envLabel = 'WSL ' + (cfg.distro || ''); meta.envId = env.id }
  else if (env.kind === 'ssh') { meta.envLabel = 'SSH ' + ((cfg.user ? cfg.user + '@' : '') + (cfg.host || '')); meta.envId = env.id }
  return meta
}

async function homeOf(env) {
  if (env.__home !== undefined) return env.__home
  let h = ''
  try {
    const cfg = env.config || {}
    const r = await envApi('home', { id: env.id, kind: env.kind, distro: cfg.distro, host: cfg.host, user: cfg.user })
    h = (r && r.home) || ''
  } catch {}
  env.__home = h
  return h
}

// 默认任务目录：本机在默认工作目录下；WSL/SSH 在用户目录 .zzwork/project 下
async function defaultPathFor(env, name) {
  const safe = safeName(name || 'task')
  if (env.kind === 'local') return joinPath(state.workdir, safe)
  const cfg = env.config || {}
  const home = String(await homeOf(env)).replace(/\/+$/, '')
  const base = home || (env.kind === 'wsl' ? '/home' : '/tmp')
  const posix = base + '/.zzwork/project/' + safe
  if (env.kind === 'wsl') return '\\\\wsl$\\' + (cfg.distro || '') + posix.replace(/\//g, '\\')
  return 'ssh://' + env.id + posix
}

// 目录选择器起始位置：本机工作目录 / 远端用户主目录
async function browseBaseFor(env) {
  if (env.kind === 'local') return state.workdir || '.'
  const cfg = env.config || {}
  const home = String(await homeOf(env)).replace(/\/+$/, '') || '/'
  if (env.kind === 'wsl') return '\\\\wsl$\\' + (cfg.distro || '') + home.replace(/\//g, '\\')
  return 'ssh://' + env.id + home
}

const isRemoteRoot = (p) => /^ssh:\/\/[^/]+\/?$/i.test(p) || /^\\\\wsl\$\\[^\\]+\\?$/i.test(p)

// 弹框选择目录：本机 / WSL(UNC) / SSH(ssh://) 统一通过 fs.browse 浏览，只列子目录
function pickDirectory(startPath, title) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-host')
    const mask = document.createElement('div')
    mask.className = 'zz-modal-mask'
    mask.innerHTML = `<div class="zz-modal" style="width:540px">
      <div class="mt">${esc(title || '选择目录')}</div>
      <div id="pkCur" style="font-size:11px;color:var(--faint);word-break:break-all;margin-bottom:8px;min-height:16px"></div>
      <div class="frow" style="margin-bottom:8px;gap:6px">
        <button class="btn sm" data-act="up" type="button">↑ 上级</button>
        <button class="btn sm" data-act="new" type="button">新建文件夹</button>
      </div>
      <div id="pkList" style="max-height:320px;overflow:auto;border:1px solid var(--bd);border-radius:6px;padding:4px"></div>
      <div class="mbtns">
        <button class="btn" data-act="cancel" type="button">取消</button>
        <button class="btn pri" data-act="pick" type="button">选择此目录</button>
      </div>
    </div>`
    let current = startPath
    const curEl = mask.querySelector('#pkCur')
    const listEl = mask.querySelector('#pkList')
    const close = (val) => { document.removeEventListener('keydown', onKey, true); mask.remove(); resolve(val) }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null) } }
    async function browse(dir) {
      if (!dir) return
      current = dir
      curEl.textContent = dir
      listEl.innerHTML = `<div class="hint" style="padding:8px">加载中…</div>`
      let items = []
      try { items = await fsapi('browse', { path: dir }) } catch (e) {
        listEl.innerHTML = `<div class="hint" style="padding:8px;color:var(--warn)">无法读取：${esc(e.message)}</div>`
        return
      }
      if (!items.length) { listEl.innerHTML = `<div class="hint" style="padding:8px">（无子文件夹）</div>`; return }
      listEl.innerHTML = items.map((d) => `<div class="lrow" data-dir="${esc(d.path)}" style="cursor:pointer;padding:6px 8px;border-radius:5px">${ic('folder', 13, '#c9b25e')}<span class="nm">${esc(d.name)}</span></div>`).join('')
      refreshIcons()
      listEl.querySelectorAll('[data-dir]').forEach((el) => el.addEventListener('click', () => browse(el.getAttribute('data-dir'))))
    }
    mask.querySelector('[data-act="up"]').addEventListener('click', () => {
      if (isRemoteRoot(current)) { toast('已到根目录'); return }
      const up = dirname(current)
      if (up && up !== current) browse(up)
    })
    mask.querySelector('[data-act="new"]').addEventListener('click', async () => {
      const name = await promptText('新建文件夹', '名称', '')
      if (!name) return
      try { await fsapi('mkdir', { path: joinPath(current, safeName(name)) }) } catch (e) { toast('创建失败：' + e.message, 'err', 4000); return }
      browse(current)
    })
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null) })
    mask.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null))
    mask.querySelector('[data-act="pick"]').addEventListener('click', () => close(current))
    document.addEventListener('keydown', onKey, true)
    host.appendChild(mask)
    browse(current)
  })
}

// 新建任务弹框：名称/类型/组/环境 + 目录（默认或弹框选择）
function showNewTaskModal({ envs, localEnv, groups, groupId }) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-host')
    const mask = document.createElement('div')
    mask.className = 'zz-modal-mask'
    const agentName = (id) => (state.agents.find((a) => a.id === id) || {}).name || id
    const envLabel = (e) => {
      const c = e.config || {}
      let label
      if (e.kind === 'local') label = '本机'
      else if (e.kind === 'wsl') label = 'WSL · ' + (c.distro || e.name)
      else label = 'SSH · ' + ((c.user ? c.user + '@' : '') + (c.host || e.name))
      if (c.defaultAgent) label += '（执行体：' + agentName(c.defaultAgent) + '）'
      return label
    }
    const envOptions = envs.map((e) => `<option value="${esc(e.id)}" ${e.id === localEnv.id ? 'selected' : ''}>${esc(envLabel(e))}</option>`).join('')
    const groupOptions = groups.map(([v, l]) => `<option value="${esc(v)}" ${v === (groupId || '') ? 'selected' : ''}>${esc(l)}</option>`).join('')

    mask.innerHTML = `<div class="zz-modal">
      <div class="mt">新建任务</div>
      <div class="mfields">
        <div class="mf" data-field="name"><label for="f_name">任务名称</label>
          <input id="f_name" type="text" placeholder="例如 retcode" autocomplete="off" spellcheck="false"></div>
        <div class="mf" data-field="type"><label for="f_type">类型</label>
          <select id="f_type"><option value="work">work</option><option value="code">code · 代码仓库</option></select></div>
        <div class="mf" data-field="group"><label for="f_group">所属组</label><select id="f_group">${groupOptions}</select></div>
        <div class="mf" data-field="env"><label for="f_env">环境</label><select id="f_env">${envOptions}</select>
          <div class="mh">任务在执行体所在的环境（本机 / WSL / SSH）中创建</div></div>
        <div class="mf" data-field="path"><label for="f_path">目录</label>
          <div class="frow" style="gap:6px"><input id="f_path" type="text" readonly placeholder="默认目录">
            <button class="btn sm" id="ntPick" type="button">选择…</button></div>
          <div class="mh" id="ntHint"></div></div>
      </div>
      <div class="mbtns">
        <button class="btn" data-act="cancel" type="button">取消</button>
        <button class="btn pri" data-act="ok" type="button">创建</button>
      </div>
    </div>`

    const envSel = mask.querySelector('#f_env')
    const nameEl = mask.querySelector('#f_name')
    const pathEl = mask.querySelector('#f_path')
    const hintEl = mask.querySelector('#ntHint')
    let chosen = null
    let seq = 0
    const curEnv = () => envs.find((e) => e.id === envSel.value) || localEnv

    async function refreshPath() {
      const my = ++seq
      if (chosen) { pathEl.value = chosen; hintEl.textContent = '已选择目录'; return }
      const env = curEnv()
      pathEl.value = '（默认）计算中…'
      hintEl.textContent = env.kind === 'local' ? '默认：工作目录下的同名文件夹' : '默认：用户目录下 .zzwork/project 下的同名目录'
      const p = await defaultPathFor(env, nameEl.value)
      if (my !== seq || chosen) return
      pathEl.value = p
    }

    nameEl.addEventListener('input', refreshPath)
    // 允许外部直接写入目录（测试/高级用法）；选择器之外的手写值也视作已选择
    pathEl.addEventListener('input', () => { chosen = pathEl.value.trim() || null })
    envSel.addEventListener('change', () => { chosen = null; refreshPath() })
    mask.querySelector('#ntPick').addEventListener('click', async () => {
      const env = curEnv()
      const start = chosen || await browseBaseFor(env)
      const picked = await pickDirectory(start, '选择任务目录')
      if (picked) { chosen = picked; refreshPath() }
    })

    const close = (val) => { document.removeEventListener('keydown', onKey, true); mask.remove(); resolve(val) }
    async function submit() {
      const name = nameEl.value.trim()
      if (!name) { nameEl.classList.add('bad'); nameEl.focus(); return }
      const env = curEnv()
      const path = chosen || await defaultPathFor(env, name)
      close({ name, type: mask.querySelector('#f_type').value, group: mask.querySelector('#f_group').value, env, path })
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null) }
      else if (e.key === 'Enter' && e.target && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { e.preventDefault(); submit() }
    }
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null) })
    mask.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null))
    mask.querySelector('[data-act="ok"]').addEventListener('click', submit)
    document.addEventListener('keydown', onKey, true)
    host.appendChild(mask)
    setTimeout(() => nameEl.focus(), 20)
    refreshPath()
  })
}

async function renameTask(task) {
  const name = await promptText('重命名任务', '任务名称', task.name)
  if (!name || name === task.name) return
  await store('tasks.update', { id: task.id, patch: { name } })
  await reloadTasks()
  renderProjects()
  emit('task-updated', task.id)
}

async function editTaskPath(task) {
  const p = await promptText('编辑任务路径', '目录', task.path, { placeholder: 'C:\\path\\to\\repo 或 \\\\wsl$\\Ubuntu\\home\\me\\repo' })
  if (!p || p === task.path) return
  await store('tasks.update', { id: task.id, patch: { path: p } })
  await reloadTasks()
  renderProjects()
  emit('select-task', task.id)
}

async function deleteTask(task) {
  const ok = await dialog('confirm', { message: `将任务「${task.name}」移到回收站？`, detail: '可在左侧「回收站」中恢复。磁盘上的目录不会被删除。' })
  if (!ok) return
  await store('tasks.trash', { id: task.id })
  emit('task-deleted', task.id)
  if (state.taskId === task.id) emit('select-task', null)
  await Promise.all([reloadTasks(), reloadTrash()])
  renderProjects()
  toast('已移到回收站')
}

async function restoreTrashTask(task) {
  await store('tasks.restore', { id: task.id })
  await Promise.all([reloadTasks(), reloadTrash()])
  renderProjects()
  toast(`已恢复「${task.name}」`)
}

async function purgeTrashTask(task) {
  const ok = await dialog('confirm', { message: `彻底删除「${task.name}」？`, detail: '将删除任务记录与对话，且无法恢复。磁盘上的目录不受影响。' })
  if (!ok) return
  await store('tasks.delete', { id: task.id })
  await reloadTrash()
  renderProjects()
  toast('已彻底删除')
}

async function emptyTrash() {
  const n = state.trash.length
  if (!n) return
  const ok = await dialog('confirm', { message: `清空回收站（${n} 个任务）？`, detail: '将删除全部任务记录与对话，且无法恢复。磁盘上的目录不受影响。' })
  if (!ok) return
  await store('tasks.emptyTrash')
  await reloadTrash()
  renderProjects()
  toast('回收站已清空')
}

async function newGroup(parentId) {
  const groupById = new Map(state.groups.map((g) => [g.id, g]))
  const parentOptions = [['', '（顶级组）'], ...state.groups.map((g) => [g.id, groupPathLabel(groupById, g)])]
  const r = await openModal({
    title: '新建组',
    fields: [
      { name: 'name', label: '组名称', type: 'text', value: '', required: true, placeholder: '例如 客户项目' },
      { name: 'parent', label: '父组', type: 'select', value: parentId || '', options: parentOptions }
    ],
    okText: '创建'
  })
  if (!r) return
  const name = String(r.name || '').trim()
  if (!name) return
  await store('groups.create', { name, parentId: r.parent || '' })
  await reloadGroups()
  if (r.parent) state.collapsedGroups.delete(r.parent)
  renderProjects()
}

async function deleteGroup(group) {
  const ok = await dialog('confirm', { message: `删除组「${group.name}」？`, detail: '组内任务与子组会上移到上一级；无上一级则变为未分组。不会被删除。' })
  if (!ok) return
  await store('groups.delete', { id: group.id })
  await Promise.all([reloadGroups(), reloadTasks()])
  renderProjects()
  toast('已删除组')
}
