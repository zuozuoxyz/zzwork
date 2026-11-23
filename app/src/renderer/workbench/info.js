// 任务信息 pane
import { store, fsapi, chat as chatApi, env as envApi } from '../lib/api.js'
import { state, activeTask, taskMeta, emit, on } from '../lib/state.js'
import { $, esc, ic, refreshIcons, envLabelFromPath, joinPath, debounce, fmtTime } from '../lib/ui.js'
import { reloadTasks } from '../lib/data.js'
import { toast } from '../components/toast.js'
import { openModal } from '../components/modal.js'
import { showContextMenu } from '../components/contextMenu.js'

// 大模型回合结束后自动同步的简介 / 关键信息（无需手动刷新）
on('brief-updated', ({ taskId, brief }) => {
  if (state.taskId !== taskId) return
  const cell = document.querySelector('#infoBody .briefcell .v')
  if (cell) cell.textContent = brief || '（暂无简介，对话结束后会自动更新）'
})
on('keyinfo-updated', ({ taskId, content }) => {
  if (state.taskId !== taskId) return
  const box = document.getElementById('keyinfoBox')
  if (!box || document.activeElement === box || box.value === content) return
  box.value = content
})

let renderSeq = 0
const detecting = new Set()
const STATUS_OPTIONS = [['active', '进行中'], ['paused', '已暂停'], ['done', '已完成']]

// 任务路径 -> 所在环境（与主进程 resolveTaskEnv 对齐）
export function taskEnvDesc(task) {
  const p = String((task && task.path) || '')
  const wsl = p.match(/^\\\\wsl(?:\.localhost|\$)?\\([^\\]+)/i)
  if (wsl) {
    const distro = wsl[1]
    const e = state.envs.find((x) => x.kind === 'wsl' && ((x.config || {}).distro === distro || x.name === distro))
    if (e) return envDescOf(e)
    return { key: 'wsl:' + distro, kind: 'wsl', distro }
  }
  const ssh = p.match(/^ssh:\/\/([^/]+)/i)
  if (ssh) {
    const e = state.envs.find((x) => x.id === ssh[1])
    if (e) return envDescOf(e)
    return { key: ssh[1], id: ssh[1], kind: 'ssh' }
  }
  const meta = taskMeta(task)
  if (meta.envId) {
    const e = state.envs.find((x) => x.id === meta.envId)
    if (e) return envDescOf(e)
  }
  const local = state.envs.find((x) => x.kind === 'local')
  return { key: (local && local.id) || 'local', id: local && local.id, kind: 'local' }
}

function envDescOf(e) {
  const c = e.config || {}
  return {
    key: e.id, id: e.id, kind: e.kind,
    distro: c.distro, host: c.host, user: c.user, port: c.port
  }
}

// 按任务环境识别执行体（结果缓存），完成后重渲染该任务信息
async function ensureDetected(desc, taskId) {
  const hit = state.detected[desc.key]
  if ((hit && Date.now() - (hit.at || 0) < 60000) || detecting.has(desc.key)) return
  detecting.add(desc.key)
  try {
    const r = await envApi('detect', {
      id: desc.id, kind: desc.kind, distro: desc.distro, host: desc.host, user: desc.user, port: desc.port
    })
    state.detected[desc.key] = { list: (r && r.list) || [], at: Date.now() }
  } catch {} finally {
    detecting.delete(desc.key)
  }
  if (state.taskId === taskId) renderInfo()
}

export async function renderInfo() {
  const seq = ++renderSeq
  const current = activeTask()
  const body = $('#infoBody')
  if (!current) {
    body.innerHTML = `<div class="empty" style="padding:40px 24px">
      <div style="font-size:15px;margin-bottom:6px;color:var(--fg)">zzwork 任务工作台</div>
      <div>选择左侧任务，或新建 / 导入一个任务开始。每个任务对应磁盘上的一个目录。</div></div>`
    body.dataset.renderId = String(seq)
    return
  }
  let task = current
  try { task = (await store('tasks.get', { id: current.id })) || current } catch {}

  const [todos, exSkills, exMcp, sessions, groups] = await Promise.all([
    store('todos.list', { taskId: task.id }).catch(() => []),
    store('taskSkills.excluded', { taskId: task.id }).catch(() => []),
    store('taskMcp.excluded', { taskId: task.id }).catch(() => []),
    store('sessions.list', { taskId: task.id }).catch(() => []),
    store('groups.list').catch(() => state.groups)
  ])
  const groupList = groups || state.groups
  const groupById = new Map((groupList || []).map((g) => [g.id, g]))
  const groupLabel = (g) => { const parts = []; let c = g, n = 0; while (c && n++ < 50) { parts.unshift(c.name); c = c.parent_id ? groupById.get(c.parent_id) : null } return parts.join(' / ') }
  if (seq !== renderSeq) return
  const keyinfoPath = joinPath(task.path, '.zzwork/keyinfo.md')
  let keyinfo = ''
  try {
    if (await fsapi('exists', { path: keyinfoPath })) keyinfo = await fsapi('readFile', { path: keyinfoPath })
  } catch { keyinfo = '' }

  const topSessions = sessions.filter((s) => s.kind !== 'subagent' && s.kind !== 'ask')
  const sessionRows = topSessions.length ? topSessions.map((s) => `<div class="sessrow" data-session="${esc(s.id)}" title="点击打开，右键更多操作">
      ${ic(s.kind === 'subagent' ? 'bot' : 'messages-square', 12)}
      <span class="sn">${esc(s.title || '会话')}${s.summary ? ' · <span style="color:var(--faint)">' + esc(s.summary.slice(0, 48)) + '</span>' : ''}</span>
      <span class="sd">${esc(fmtTime(s.updated_at))}</span></div>`).join('')
    : `<div class="hint">还没有会话，去 AI 对话发送第一条消息。</div>`

  const meta = taskMeta(task)
  const status = task.status || 'active'
  const statusOpts = STATUS_OPTIONS.some(([v]) => v === status)
    ? STATUS_OPTIONS
    : STATUS_OPTIONS.concat([[status, status]])
  const envLabel = meta.envLabel || envLabelFromPath(task.path)
  const group = state.groups.find((g) => g.id === task.group_id)
  const envDesc = taskEnvDesc(task)
  const det = state.detected[envDesc.key]
  if (!det) ensureDetected(envDesc, task.id)
  const detectedIds = det ? det.list.filter((a) => a.ok).map((a) => a.id) : null
  const allAgents = state.agents.length ? state.agents : [{ id: 'builtin', name: '内置模型聊天', kind: 'builtin' }]
  const visibleAgents = allAgents.filter((a) => a.kind === 'builtin' || !detectedIds || detectedIds.includes(a.id))
  const curAgent = allAgents.find((a) => a.id === task.agent_id) || null
  const agentMissing = !!(detectedIds && curAgent && !visibleAgents.includes(curAgent))
  if (agentMissing) visibleAgents.push(curAgent)
  const agent = curAgent || visibleAgents[0] || {}
  const dflt = state.models.find((m) => m.is_default) || state.models[0] || null
  const cur = task.model_id ? state.models.find((m) => m.id === task.model_id) : null
  const modelGroups = (() => {
    const groups = []
    const used = new Set()
    for (const p of state.providers) {
      const ms = state.models.filter((m) => m.provider_id === p.id)
      if (!ms.length) continue
      ms.forEach((m) => used.add(m.id))
      groups.push(`<optgroup label="${esc(p.name)}">${ms.map((m) => `<option value="${esc(m.id)}" ${cur && m.id === cur.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`)
    }
    const rest = state.models.filter((m) => !used.has(m.id))
    if (rest.length) groups.push(`<optgroup label="未分组">${rest.map((m) => `<option value="${esc(m.id)}" ${cur && m.id === cur.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</optgroup>`)
    return groups.join('')
  })()

  const todoDone = todos.filter((t) => t.status === 'done').length
  const todoHtml = todos.length
    ? todos.map((t) => `<div class="todo ${t.status === 'done' ? 'done' : ''}" data-todo="${esc(t.id)}">
        <span class="bx" data-act="toggle" title="切换完成"></span>
        <span class="tt">${esc(t.title)}</span>
        <span class="rm" data-act="del" title="删除">×</span></div>`).join('')
    : `<div class="hint">还没有 TODO，输入后回车添加</div>`

  // 只列出任务所在环境的 Skills / MCP（本机 skills 入库在 global 名下）
  const skillEnvId = envDesc.kind === 'local' ? 'global' : envDesc.id
  const skills = state.skills.filter((s) => s.env_id === skillEnvId)
  const mcps = state.mcp.filter((m) => m.env_id === 'global' || (envDesc.kind !== 'local' && m.env_id === envDesc.id))
  const skillRows = skills.length ? skills.map((s) => `<label class="chkchip${exSkills.includes(s.id) ? ' off' : ''}" title="${esc(s.description || s.name)}">
      <input type="checkbox" data-skill="${esc(s.id)}" ${exSkills.includes(s.id) ? '' : 'checked'}>
      <span>${esc(s.name)}</span></label>`).join('')
    : `<div class="hint">未发现 Skills，可在 Skills 视图扫描</div>`
  const mcpRows = mcps.length ? mcps.map((m) => `<label class="chkrow">
      <input type="checkbox" data-mcp="${esc(m.id)}" ${exMcp.includes(m.id) ? '' : 'checked'}>
      <span class="nm">${esc(m.name)}</span>
      <span class="ds">${esc(m.type || 'stdio')}</span></label>`).join('')
    : `<div class="hint">未发现 MCP 服务</div>`

  body.innerHTML = `
    <div class="hd"><h2>${esc(task.name)}</h2>
      <span class="pill b">${esc(task.type)}</span>
      <select class="pill-sel st-${esc(status)}" id="statusSel" title="任务状态">
        ${statusOpts.map(([v, label]) => `<option value="${esc(v)}" ${v === status ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <span class="pill">${esc(envLabel)}</span>
      <span style="margin-left:auto;display:flex;gap:6px">
        <button class="btn sm" id="openTaskDir">${ic('folder-open', 11)} 打开目录</button>
      </span></div>
    <div class="pth">${esc(task.path)}</div>
    <div class="grid">
      <div class="cell"><div class="k">所属组</div><div class="v">
        <select class="sel2" id="groupSel">
          <option value="">（不分组）</option>
          ${groupList.map((g) => `<option value="${esc(g.id)}" ${g.id === task.group_id ? 'selected' : ''}>${esc(groupLabel(g))}</option>`).join('')}
        </select></div></div>
      <div class="cell"><div class="k">执行体</div><div class="v">
        <select class="sel2" id="agentSel">
          ${visibleAgents.map((a) => `<option value="${esc(a.id)}" ${a.id === agent.id ? 'selected' : ''}>${esc(a.name)}${agentMissing && a.id === task.agent_id ? '（未识别）' : ''}</option>`).join('')}
        </select>
        ${detectedIds ? `<span style="color:var(--faint);font-size:10px">按环境识别 ${visibleAgents.length - (agentMissing ? 1 : 0)} 个可用执行体</span>`
          : `<span style="color:var(--faint);font-size:10px">正在识别环境执行体…</span>`}
        ${agentMissing ? `<span style="color:var(--warn);font-size:10px">当前执行体未在该环境识别到，请切换</span>` : ''}
        </div></div>
      <div class="cell"><div class="k">模型（内置聊天）</div><div class="v">
        <select class="sel2" id="modelSel">
          <option value="" ${cur ? '' : 'selected'}>（默认：${dflt ? esc(dflt.name) : '未配置'}）</option>
          ${modelGroups}
        </select></div></div>
      <div class="cell"><div class="k">启用 Skills / MCP</div><div class="v">${skills.length - exSkills.length} / ${mcps.length - exMcp.length}
        <span style="color:var(--faint);font-size:10.5px">按任务裁剪，默认全选</span></div></div>
    </div>
    <div class="sec">任务简介
      <span style="text-transform:none;letter-spacing:0;color:var(--faint)">所有会话汇总，供多代理共享</span>
      <button class="btn sm" id="refreshBriefBtn" style="margin-left:auto">${ic('refresh-cw', 11)} 刷新</button></div>
    <div class="briefcell"><div class="v">${task.brief ? esc(task.brief) : '（暂无简介，对话结束后会自动更新）'}</div></div>
    <div class="sec">关键信息 <span style="text-transform:none;letter-spacing:0;color:var(--faint)">账号、密钥、Key、关键人名等，随请求注入</span></div>
    <textarea class="membox" id="keyinfoBox" spellcheck="false" placeholder="每行一条，如：API Key：xxx / 测试账号：admin / 联系负责人：张三">${esc(keyinfo)}</textarea>
    <div class="sec">会话 <span style="text-transform:none;letter-spacing:0;color:var(--faint)">${topSessions.length}</span></div>
    <div id="sessionsList">${sessionRows}</div>
    <div class="sec">TODO <span style="text-transform:none;letter-spacing:0;color:var(--faint)">${todoDone} / ${todos.length}</span></div>
    <div id="todoList">${todoHtml}</div>
    <div class="frow" style="margin:6px 0 0"><input class="ftxt" id="todoInput" placeholder="添加 TODO，回车确认"></div>
    <div class="sec">Skills</div>
    <div class="chklist chips" id="skillToggles">${skillRows}</div>
    <div class="sec">MCP</div>
    <div class="chklist" id="mcpToggles">${mcpRows}</div>`
  body.dataset.renderId = String(seq)
  refreshIcons()

  $('#openTaskDir').addEventListener('click', () => fsapi('openPath', { path: task.path }).catch((e) => toast(e.message, 'err')))

  $('#refreshBriefBtn').addEventListener('click', () => refreshBrief(task.id))

  const saveKeyinfo = debounce(async (value) => {
    try { await fsapi('writeFile', { path: keyinfoPath, content: value }) } catch (e) { toast('关键信息保存失败：' + e.message, 'err') }
  }, 700)
  $('#keyinfoBox').addEventListener('input', (e) => saveKeyinfo(e.target.value))

  $('#sessionsList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-session]')
    if (!row) return
    emit('open-session', { taskId: task.id, sessionId: row.getAttribute('data-session') })
  })
  $('#sessionsList').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-session]')
    if (!row) return
    e.preventDefault()
    const sid = row.getAttribute('data-session')
    const session = topSessions.find((s) => s.id === sid) || { id: sid }
    showContextMenu(e.clientX, e.clientY, [
      { label: '打开会话', icon: 'messages-square', action: () => emit('open-session', { taskId: task.id, sessionId: sid }) },
      { sep: true },
      { label: '重命名会话…', icon: 'pencil-line', action: () => renameSession(session) },
      { label: '生成会话摘要', icon: 'scroll-text', action: () => summarizeSession(task.id, session) },
      { label: '刷新任务简介', icon: 'book-open', action: () => refreshBrief(task.id) },
      { sep: true },
      { label: '删除会话', icon: 'trash-2', danger: true, action: () => deleteSession(session) }
    ])
  })

  $('#statusSel').addEventListener('change', async (e) => {
    await store('tasks.update', { id: task.id, patch: { status: e.target.value } })
    await reloadTasks()
    emit('tasks-changed')
    await renderInfo()
  })
  $('#groupSel').addEventListener('change', async (e) => {
    await store('tasks.update', { id: task.id, patch: { group_id: e.target.value || null } })
    await reloadTasks()
    emit('tasks-changed')
  })
  $('#agentSel').addEventListener('change', async (e) => {
    await store('tasks.update', { id: task.id, patch: { agent_id: e.target.value } })
    await reloadTasks()
    emit('task-updated', task.id)
  })
  $('#modelSel').addEventListener('change', async (e) => {
    await store('tasks.update', { id: task.id, patch: { model_id: e.target.value } })
    await reloadTasks()
    emit('task-updated', task.id)
  })

  const todoList = $('#todoList')
  todoList.addEventListener('click', async (e) => {
    const row = e.target.closest('.todo')
    if (!row) return
    const id = row.getAttribute('data-todo')
    const act = e.target.getAttribute('data-act')
    if (act === 'toggle') {
      const t = todos.find((x) => x.id === id)
      await store('todos.setStatus', { id, status: t && t.status === 'done' ? 'todo' : 'done' })
      await renderInfo()
    } else if (act === 'del') {
      await store('todos.delete', { id })
      await renderInfo()
    }
  })
  $('#todoInput').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return
    const v = e.target.value.trim()
    if (!v) return
    await store('todos.add', { taskId: task.id, title: v })
    await renderInfo()
    const again = $('#todoInput')
    if (again) again.focus()
  })

  $('#skillToggles').addEventListener('change', async (e) => {
    const id = e.target.getAttribute('data-skill')
    if (!id) return
    await store('taskSkills.setExcluded', { taskId: task.id, skillId: id, excluded: !e.target.checked })
    await renderInfo()
  })
  $('#mcpToggles').addEventListener('change', async (e) => {
    const id = e.target.getAttribute('data-mcp')
    if (!id) return
    await store('taskMcp.setExcluded', { taskId: task.id, mcpId: id, excluded: !e.target.checked })
    await renderInfo()
  })

  updateStatus(task, todoDone, todos.length, envLabel)
}

function updateStatus(task, done, total, envLabel) {
  const stTask = $('#stTask')
  if (stTask) stTask.textContent = `✓ ${task.name} ${done}/${total}`
  const stRight = $('#stRight')
  if (stRight) stRight.textContent = '环境：' + envLabel
}

async function refreshBrief(taskId) {
  toast('正在生成任务简介…')
  try {
    const r = await chatApi('brief', { taskId })
    if (r && r.ok) { toast('任务简介已更新'); await renderInfo() }
    else toast('简介生成失败：' + (r && r.error || '未知错误'), 'err')
  } catch (e) { toast('简介生成失败：' + e.message, 'err') }
}

async function renameSession(session) {
  const r = await openModal({
    title: '重命名会话',
    fields: [{ name: 'title', label: '会话名称', type: 'text', required: true, value: session.title || '' }],
    okText: '保存'
  })
  if (!r) return
  try {
    await store('sessions.update', { id: session.id, patch: { title: r.title.trim() } })
    await renderInfo()
  } catch (e) { toast('重命名失败：' + e.message, 'err') }
}

async function summarizeSession(taskId, session) {
  toast('正在生成会话摘要…')
  try {
    const r = await chatApi('summarize', { taskId, sessionId: session.id })
    if (r && r.summary) { toast('摘要已更新'); await renderInfo() }
    else toast('暂无可摘要的内容')
  } catch (e) { toast('摘要失败：' + e.message, 'err') }
}

async function deleteSession(session) {
  const isSub = session.kind === 'subagent'
  const r = await openModal({
    title: '删除会话',
    note: isSub ? '将同时删除其派生的下级子会话。' : '将删除该会话的全部消息与运行记录。',
    fields: [{ name: 'ok', type: 'checkbox', label: '确认删除「' + (session.title || '会话') + '」', value: false }],
    okText: '删除'
  })
  if (!r || !r.ok) return
  try {
    await store('sessions.delete', { id: session.id })
    toast('已删除会话')
    await renderInfo()
  } catch (e) { toast('删除失败：' + e.message, 'err') }
}
