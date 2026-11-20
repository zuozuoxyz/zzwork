// 项目视图：分组 + 任务树
import { store, fsapi, dialog, env as envApi } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, ic, refreshIcons, joinPath, safeName, dirname, envLabelFromPath } from '../lib/ui.js'
import { reloadTasks, reloadGroups } from '../lib/data.js'
import { promptText } from '../components/modal.js'
import { showContextMenu } from '../components/contextMenu.js'
import { toast } from '../components/toast.js'

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
}

export function renderProjects() {
  const body = $('#projectsBody')
  const filter = state.filter.trim().toLowerCase()
  const match = (t) => !filter || String(t.name).toLowerCase().includes(filter) || String(t.path || '').toLowerCase().includes(filter)

  const groups = state.groups.slice()
  const byGroup = new Map()
  const ungrouped = []
  for (const t of state.tasks) {
    if (!match(t)) continue
    if (t.group_id && groups.some((g) => g.id === t.group_id)) {
      if (!byGroup.has(t.group_id)) byGroup.set(t.group_id, [])
      byGroup.get(t.group_id).push(t)
    } else ungrouped.push(t)
  }

  const taskRow = (t) => {
    const meta = t.meta || {}
    const env = meta.envLabel || envLabelFromPath(t.path)
    const icon = t.type === 'code' ? 'repo' : 'notebook'
    const color = t.type === 'code' ? '#7aa2f7' : '#2dd4bf'
    return `<div class="row t1 ${state.mode === 'task' && state.taskId === t.id ? 'sel' : ''}" data-task="${esc(t.id)}">
      ${ic(icon, 13).replace('<i ', `<i style="color:${color};`)}
      <span class="nm">${esc(t.name)}</span><span class="ds">${esc(env)}</span></div>`
  }

  let markup = ''
  let renderedGroups = 0
  for (const g of groups) {
    const list = byGroup.get(g.id) || []
    if (filter && !list.length && !g.name.toLowerCase().includes(filter)) continue
    renderedGroups++
    const collapsed = state.collapsedGroups.has(g.id) && !filter
    markup += `<div class="row g" data-group="${esc(g.id)}">
      ${ic(collapsed ? 'chevron-right' : 'chevron-down', 12)}
      ${ic('folder', 13).replace('<i ', '<i style="color:#c9b25e;')}
      <span class="nm">${esc(g.name)}</span><span class="ds">${list.length}</span></div>`
    if (!collapsed) markup += list.map(taskRow).join('')
  }
  if (ungrouped.length && renderedGroups) {
    markup += `<div class="row sh"><span class="nm">未分组</span><span class="ds">${ungrouped.length}</span></div>`
  }
  markup += ungrouped.map(taskRow).join('')
  if (!markup) {
    markup = `<div class="empty">${filter ? '没有匹配的任务' : '还没有任务。点击右上角 ＋ 新建，或导入已有文件夹。'}</div>`
  }
  body.innerHTML = markup
  refreshIcons()

  body.querySelectorAll('.row[data-task]').forEach((row) => {
    const id = row.getAttribute('data-task')
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
        { label: '删除任务', icon: 'trash-2', danger: true, action: () => deleteTask(task) }
      ])
    })
  })

  body.querySelectorAll('.row[data-group]').forEach((row) => {
    const gid = row.getAttribute('data-group')
    const group = state.groups.find((g) => g.id === gid)
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
        { sep: true },
        { label: '删除组', icon: 'trash-2', danger: true, action: () => deleteGroup(group) }
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

export async function newTask(groupId) {
  const groupOptions = [['', '（不分组）'], ...state.groups.map((g) => [g.id, g.name])]
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
      listEl.innerHTML = items.map((d) => `<div class="lrow" data-dir="${esc(d.path)}" style="cursor:pointer;padding:6px 8px;border-radius:5px">${ic('folder', 13).replace('<i ', '<i style="color:#c9b25e;')}<span class="nm">${esc(d.name)}</span></div>`).join('')
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
          <select id="f_type"><option value="work">work · 临时任务</option><option value="code">code · 代码仓库</option></select></div>
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
  const ok = await dialog('confirm', { message: `删除任务「${task.name}」？`, detail: '仅删除任务记录与对话，不会删除磁盘上的目录。' })
  if (!ok) return
  await store('tasks.delete', { id: task.id })
  emit('task-deleted', task.id)
  if (state.taskId === task.id) emit('select-task', null)
  await reloadTasks()
  renderProjects()
  toast('已删除任务')
}

async function newGroup() {
  const name = await promptText('新建组', '组名称', '', { placeholder: '例如 客户项目' })
  if (!name) return
  await store('groups.create', { name })
  await reloadGroups()
  renderProjects()
}

async function deleteGroup(group) {
  const ok = await dialog('confirm', { message: `删除组「${group.name}」？`, detail: '组内任务会变为未分组，不会被删除。' })
  if (!ok) return
  await store('groups.delete', { id: group.id })
  await Promise.all([reloadGroups(), reloadTasks()])
  renderProjects()
  toast('已删除组')
}
