// 任务信息 pane
import { store, fsapi, chat as chatApi, env as envApi, share as shareApi } from '../lib/api.js'
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
const TYPE_OPTIONS = [['work', 'work'], ['code', 'code']]

// 每任务终端批处理：[{ id, name, cmd }]（cmd 可多行，逐行执行）
async function loadTermBatches(taskId) {
  try {
    const raw = await store('settings.get', { key: 'task:terms:' + taskId, dflt: '' })
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch { return [] }
}
function saveTermBatches(taskId, list) {
  return store('settings.set', { key: 'task:terms:' + taskId, value: JSON.stringify(list) }).catch(() => {})
}

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

  const [exSkills, exMcp, sessions, groups] = await Promise.all([
    store('taskSkills.excluded', { taskId: task.id }).catch(() => []),
    store('taskMcp.excluded', { taskId: task.id }).catch(() => []),
    store('sessions.list', { taskId: task.id }).catch(() => []),
    store('groups.list').catch(() => state.groups)
  ])
  const shareInfo = await shareApi('task.get', { taskId: task.id }).catch(() => null)
  const termBatches = await loadTermBatches(task.id)
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
  const type = task.type || 'work'
  const typeOpts = TYPE_OPTIONS.some(([v]) => v === type) ? TYPE_OPTIONS : TYPE_OPTIONS.concat([[type, type]])
  const envLabel = meta.envLabel || envLabelFromPath(task.path)
  const group = state.groups.find((g) => g.id === task.group_id)
  const envDesc = taskEnvDesc(task)
  const det = state.detected[envDesc.key]
  if (!det) ensureDetected(envDesc, task.id)
  const detectedIds = det ? det.list.filter((a) => a.ok).map((a) => a.id) : null
  const allAgents = state.agents.length ? state.agents : [{ id: 'builtin', name: '内置模型聊天', kind: 'builtin' }]
  const visibleAgents = allAgents.filter((a) => a.kind === 'external' || a.kind === 'builtin' || !detectedIds || detectedIds.includes(a.id))
  const curAgent = allAgents.find((a) => a.id === task.agent_id) || null
  const agentMissing = !!(detectedIds && curAgent && !visibleAgents.includes(curAgent))
  if (agentMissing) visibleAgents.push(curAgent)
  const agent = curAgent || visibleAgents[0] || {}
  const agentRow = allAgents.find((a) => a.id === agent.id) || agent
  const shareSection = buildShareSection(shareInfo, agentRow)
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
  const batchRows = termBatches.length ? termBatches.map((b, i) => `<div class="termbatch" data-bi="${i}">
      <div class="tb-head">
        <input class="ftxt tb-name" data-f="name" placeholder="名称（如：启动开发）" value="${esc(b.name || '')}">
        <button class="btn sm tb-del" data-bi="${i}" title="删除批处理">${ic('trash-2', 11)}</button>
      </div>
      <textarea class="tb-cmd" data-f="cmd" spellcheck="false" placeholder="要执行的命令，每行一条，例如：npm run dev">${esc(b.cmd || '')}</textarea>
    </div>`).join('')
    : `<div class="hint">还没有批处理。点「新增」填写名称与命令，之后悬停终端「+」即可一键新开终端执行。</div>`

  body.innerHTML = `
    <div class="hd"><h2>${esc(task.name)}</h2>
      <select class="pill-sel ty-${esc(type)}" id="typeSel" title="任务类型：work 通用 / code 代码仓库">
        ${typeOpts.map(([v, label]) => `<option value="${esc(v)}" ${v === type ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
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
    ${shareSection}
    <div class="sec">任务简介
      <span style="text-transform:none;letter-spacing:0;color:var(--faint)">所有会话汇总，供多代理共享</span>
      <button class="btn sm" id="refreshBriefBtn" style="margin-left:auto">${ic('refresh-cw', 11)} 刷新</button></div>
    <div class="briefcell"><div class="v">${task.brief ? esc(task.brief) : '（暂无简介，对话结束后会自动更新）'}</div></div>
    <div class="sec">关键信息 <span style="text-transform:none;letter-spacing:0;color:var(--faint)">账号、密钥、Key、关键人名等，随请求注入</span></div>
    <textarea class="membox" id="keyinfoBox" spellcheck="false" placeholder="每行一条，如：API Key：xxx / 测试账号：admin / 联系负责人：张三">${esc(keyinfo)}</textarea>
    <div class="sec">会话 <span style="text-transform:none;letter-spacing:0;color:var(--faint)">${topSessions.length}</span></div>
    <div id="sessionsList">${sessionRows}</div>
    <div class="sec">Skills</div>
    <div class="chklist chips" id="skillToggles">${skillRows}</div>
    <div class="sec">MCP</div>
    <div class="chklist" id="mcpToggles">${mcpRows}</div>
    <div class="sec">终端批处理
      <span style="text-transform:none;letter-spacing:0;color:var(--faint)">悬停终端「+」选择即新开终端执行</span>
      <button class="btn sm" id="addTermBatch" style="margin-left:auto">${ic('plus', 11)} 新增</button></div>
    <div id="termBatches">${batchRows}</div>`
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

  $('#typeSel').addEventListener('change', async (e) => {
    await store('tasks.update', { id: task.id, patch: { type: e.target.value } })
    await reloadTasks()
    emit('tasks-changed')
    await renderInfo()
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

  const saveBatchesLazy = debounce(() => saveTermBatches(task.id, termBatches), 500)
  const termBatchesEl = $('#termBatches')
  if (termBatchesEl) {
    termBatchesEl.addEventListener('input', (e) => {
      const row = e.target.closest('.termbatch')
      if (!row) return
      const i = Number(row.getAttribute('data-bi'))
      const f = e.target.getAttribute('data-f')
      if (!f || !termBatches[i]) return
      termBatches[i][f] = e.target.value
      saveBatchesLazy()
    })
    termBatchesEl.addEventListener('click', async (e) => {
      const del = e.target.closest('.tb-del')
      if (!del) return
      const i = Number(del.getAttribute('data-bi'))
      if (!termBatches[i]) return
      termBatches.splice(i, 1)
      await saveTermBatches(task.id, termBatches)
      renderInfo()
    })
  }
  const addBatchBtn = $('#addTermBatch')
  if (addBatchBtn) addBatchBtn.addEventListener('click', async () => {
    termBatches.push({ id: 'tb-' + Math.random().toString(36).slice(2, 9), name: '', cmd: '' })
    await saveTermBatches(task.id, termBatches)
    await renderInfo()
    const rows = document.querySelectorAll('#termBatches .termbatch')
    const last = rows[rows.length - 1]
    const inp = last && last.querySelector('.tb-name')
    if (inp) inp.focus()
  })

  const shareEl = (id) => document.getElementById(id)
  if (shareEl('shareEnable')) shareEl('shareEnable').addEventListener('click', async () => {
    try { await shareApi('task.enable', { taskId: task.id }); toast('已开启分享'); await renderInfo() }
    catch (e) { toast('开启分享失败：' + e.message, 'err') }
  })
  if (shareEl('shareDisable')) shareEl('shareDisable').addEventListener('click', async () => {
    try { await shareApi('task.disable', { taskId: task.id }); toast('已关闭分享'); await renderInfo() }
    catch (e) { toast(e.message, 'err') }
  })
  if (shareEl('shareRegen')) shareEl('shareRegen').addEventListener('click', async () => {
    try { await shareApi('task.regenerate', { taskId: task.id }); toast('已重新生成链接，旧链接立即失效'); await renderInfo() }
    catch (e) { toast(e.message, 'err') }
  })
  if (shareEl('shareCopy')) shareEl('shareCopy').addEventListener('click', async () => {
    const v = shareEl('shareLink') && shareEl('shareLink').value
    try { await navigator.clipboard.writeText(v || ''); toast('链接已复制') }
    catch { toast('复制失败，请手动选择复制', 'err') }
  })
  if (shareEl('addRemoteBtn')) shareEl('addRemoteBtn').addEventListener('click', () => addRemoteAgent())
  if (shareEl('browseRemoteBtn')) shareEl('browseRemoteBtn').addEventListener('click', () => browseRemote(shareEl('browseRemoteBtn').getAttribute('data-link')))

  updateStatus(task, envLabel)
}

function updateStatus(task, envLabel) {
  // 顶部标题由 main.js 的 syncTopTitle 统一维护（随视图同步），此处只更新右下环境
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

// 远程与分享：开启分享 / 展示链接，以及把他人链接添加为外部执行体
function buildShareSection(info, agentRow) {
  const running = !!(info && info.running)
  const enabled = !!(info && info.enabled)
  const link = (info && info.link) || ''
  let status
  if (running) status = '分享服务运行中 · 端口 ' + (info.port || '') + (info.publicBase ? ' · 隧道 ' + esc(info.publicBase) : '')
  else if (info && info.error) status = '分享服务启动失败：' + esc(info.error)
  else status = '分享服务未运行'
  let body
  if (enabled && link) {
    body = `<div class="sharerow"><input class="ftxt" id="shareLink" readonly value="${esc(link)}"><button class="btn sm" id="shareCopy">复制</button></div>
      <div class="sharerow"><button class="btn sm" id="shareRegen">重新生成链接</button><button class="btn sm" id="shareDisable">关闭分享</button></div>`
  } else {
    body = `<div class="sharerow"><button class="btn sm pri" id="shareEnable">生成分享链接</button>
      <span class="sharehint">生成后用公网隧道（如 cloudflared）把本机端口暴露出去即可分享</span></div>`
  }
  const extBtn = agentRow && agentRow.kind === 'external' && agentRow.link
    ? `<div class="sharerow"><button class="btn sm" id="browseRemoteBtn" data-link="${esc(agentRow.link)}">${ic('folder-search', 11)} 浏览远端文件</button>
        <span class="sharehint">当前执行体：${esc(agentRow.name || '')}</span></div>`
    : ''
  return `<div class="sec">远程与分享</div>
    <div class="sharecell">
      <div class="sharehint">${status}</div>
      ${body}
      <div class="sharesep"></div>
      <div class="sharehint">把别人的分享链接添加为「外部执行体」，在本任务的执行体下拉里选择即可远程问答：</div>
      <div class="sharerow"><input class="ftxt" id="remoteLinkInput" placeholder="粘贴分享链接（https://…/s/…）">
        <input class="ftxt shname" id="remoteNameInput" placeholder="名称(可选)"><button class="btn sm" id="addRemoteBtn">添加</button></div>
      ${extBtn}
    </div>`
}

async function addRemoteAgent() {
  const link = ((document.getElementById('remoteLinkInput') || {}).value || '').trim()
  if (!link) { toast('请先粘贴分享链接', 'err'); return }
  const customName = ((document.getElementById('remoteNameInput') || {}).value || '').trim()
  const t = await shareApi('agent.test', { link }).catch((e) => ({ ok: false, error: e.message }))
  if (!t || !t.ok) { toast('链接不可用：' + ((t && t.error) || '未知错误'), 'err'); return }
  const id = 'ext-' + Math.random().toString(16).slice(2, 10)
  const name = customName || ('远程 · ' + (t.name || '任务'))
  const list = (state.agents || []).slice()
  list.push({ id, name, kind: 'external', link, remoteName: t.name || '' })
  try {
    await store('agents.save', { list })
    state.agents = await store('agents.list')
    toast('已添加外部执行体「' + name + '」，可在上方执行体下拉选择')
    await renderInfo()
  } catch (e) { toast('添加失败：' + e.message, 'err') }
}

// 远端文件浏览：只读，点击目录下钻、点击文件查看内容
function browseRemote(link) {
  if (!link) return
  const host = document.getElementById('modal-host')
  const mask = document.createElement('div')
  mask.className = 'zz-modal-mask'
  mask.innerHTML = `<div class="zz-modal zz-remote" style="width:640px;max-width:92vw">
    <div class="mt">远端文件<span class="rb-name"></span></div>
    <div class="rb-crumb"></div>
    <div class="rb-list"></div>
    <pre class="rb-content" hidden></pre>
    <div class="mbtns"><button class="btn" data-act="close">关闭</button></div>
  </div>`
  host.appendChild(mask)
  const listEl = mask.querySelector('.rb-list')
  const crumbEl = mask.querySelector('.rb-crumb')
  const contentEl = mask.querySelector('.rb-content')
  const nameEl = mask.querySelector('.rb-name')
  let curPath = ''
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } }
  const close = () => { document.removeEventListener('keydown', onKey, true); mask.remove() }
  document.addEventListener('keydown', onKey, true)
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close() })
  mask.querySelector('[data-act="close"]').addEventListener('click', close)

  const load = async (path) => {
    curPath = path || ''
    crumbEl.textContent = '/ ' + curPath
    contentEl.hidden = true
    contentEl.textContent = ''
    listEl.innerHTML = '<div class="rb-empty">加载中…</div>'
    let r
    try { r = await shareApi('fs.list', { link, path: curPath }) } catch (e) { listEl.innerHTML = '<div class="rb-empty">读取失败：' + esc(e.message) + '</div>'; return }
    if (!r || !r.ok) { listEl.innerHTML = '<div class="rb-empty">' + esc((r && r.error) || '读取失败') + '</div>'; return }
    const items = r.list || []
    const rows = []
    if (curPath) rows.push('<div class="rb-row dir" data-up="1">⬆ 返回上级</div>')
    items.forEach((it, i) => rows.push(`<div class="rb-row ${it.dir ? 'dir' : 'file'}" data-i="${i}">${it.dir ? '📁' : '📄'} ${esc(it.name)}</div>`))
    if (!items.length) rows.push('<div class="rb-empty">（空目录）</div>')
    listEl.innerHTML = rows.join('')
    listEl.querySelectorAll('.rb-row').forEach((row) => {
      row.addEventListener('click', () => {
        if (row.getAttribute('data-up')) { load(curPath.split('/').slice(0, -1).join('/')); return }
        const it = items[Number(row.getAttribute('data-i'))]
        if (!it) return
        if (it.dir) load(it.path)
        else showFile(it.path)
      })
    })
  }
  const showFile = async (path) => {
    contentEl.hidden = false
    contentEl.textContent = '加载中…'
    let r
    try { r = await shareApi('fs.read', { link, path }) } catch (e) { contentEl.textContent = '读取失败：' + e.message; return }
    if (!r || !r.ok) { contentEl.textContent = (r && r.error) || '读取失败'; return }
    contentEl.textContent = r.content || '（空文件）'
  }

  shareApi('agent.test', { link }).then((t) => { if (t && t.ok) nameEl.textContent = ' · ' + (t.name || '') }).catch(() => {})
  load('')
}
