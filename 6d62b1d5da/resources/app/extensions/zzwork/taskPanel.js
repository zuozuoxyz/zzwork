// zzwork 任务详情面板：辅助侧栏 webview（信息/todo/文件树）
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')

let view = null

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;padding:8px 10px}
  h4{margin:14px 0 6px;font-size:11px;text-transform:uppercase;opacity:.7;font-weight:600;letter-spacing:.5px}
  .kv{display:flex;gap:6px;margin:3px 0;align-items:center}
  .kv b{flex:0 0 52px;font-weight:400;opacity:.65;font-size:12px}
  .kv span,.kv select{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  select,input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:2px;padding:2px 5px;font-size:12px}
  .btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:2px;padding:3px 10px;cursor:pointer;font-size:12px}
  button.sec{background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#fff)}
  button.mini{flex:0 0 auto;padding:1px 7px;font-size:11px;background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-input-border, #666);border-radius:3px;cursor:pointer}
  button.mini:hover{background:var(--vscode-input-background)}
  .todo{display:flex;gap:6px;align-items:flex-start;margin:4px 0;line-height:1.4}
  .todo.done span.t{text-decoration:line-through;opacity:.55}
  .pick{display:flex;align-items:center;gap:7px;margin:3px 0;font-size:12px;line-height:1.4;cursor:pointer}
  .pick input{margin:0;flex:0 0 auto}
  .pick .pn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pick .psrc{font-size:9.5px;opacity:.55;font-family:Consolas,monospace;flex:0 0 auto}
  .addbtn{margin-left:auto;cursor:pointer;opacity:.6;font-size:13px;padding:0 4px}
  .addbtn:hover{opacity:1}
  .empty2{opacity:.5;font-size:11.5px;padding:2px 0}
  .todo input[type=checkbox]{margin-top:3px}
  .todo span.t{flex:1;word-break:break-all}
  .todo .x{cursor:pointer;opacity:.5;flex:0 0 auto} .todo .x:hover{opacity:1}
  #todoIn{width:100%;margin-bottom:4px}
  .tree{line-height:1.5}
  .dir{cursor:pointer} .dir:hover{opacity:.8}
  .file{cursor:pointer;color:var(--vscode-foreground)} .file:hover{text-decoration:underline}
  .ico{display:inline-block;width:14px;opacity:.75}
  .empty{opacity:.6;padding:20px 0;text-align:center}
  .badge{display:inline-block;padding:1px 6px;border-radius:8px;font-size:11px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
</style></head><body><div id="root"><div class="empty">先在左侧选择一个任务</div></div>
<script>
  const vscode = acquireVsCodeApi()
  let state = null
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
  function render(){
    const r = $('root')
    if (!state || !state.task) { r.innerHTML = '<div class="empty">先在左侧选择一个任务</div>'; return }
    const t = state.task
    const TYPE = { work:'🛠 work', code:'💻 code' }
    r.innerHTML =
      '<h4>任务信息</h4>' +
      '<div class="kv"><b>名称</b><span>' + esc(t.name) + '</span></div>' +
      '<div class="kv"><b>类型</b><span class="badge">' + (TYPE[t.type]||t.type) + '</span></div>' +
      '<div class="kv"><b>状态</b><select onchange="st()"><option value="active"' + (t.status==='active'?' selected':'') + '>进行中</option><option value="done"' + (t.status==='done'?' selected':'')+'>已完成</option></select></div>' +
      '<div class="kv"><b>所属组</b><select onchange="gp(this.value)"><option value="">（无）</option>' +
        state.groups.map(g=>'<option value="'+g.id+'"'+(t.group_id===g.id?' selected':'')+'>'+esc(g.name)+'</option>').join('') + '</select></div>' +
      '<div class="kv"><b>执行体</b><select onchange="ag(this.value)">' +
        state.agents.map(a=>{
          const ok = a.kind==='builtin' || (state.installed||[]).includes(a.id)
          const mark = a.kind==='builtin' ? ' ·内置' : (ok ? ' ✓已安装' : ' ·未安装')
          return '<option value="'+a.id+'"'+(t.agent_id===a.id?' selected':'')+'>'+esc(a.name)+mark+'</option>'
        }).join('') + '</select><button class="mini" onclick="det()" title="重新检测该环境已安装的智能体">检测</button></div>' +
      ((t.agent_id||'builtin')==='builtin' ?
        '<div class="kv"><b>模型</b><select onchange="md(this.value)">' +
        (state.models||[]).map(m=>'<option value="'+m.id+'"'+(t.model_id===m.id?' selected':'')+'>'+esc(m.name)+'</option>').join('') +
        '</select></div>' : '') +
      '<div class="kv"><b>位置</b><span title="'+esc(t.path)+'">' + esc(t.path) + '</span></div>' +
      '<div class="kv"><b>环境</b><span>' + esc(state.envLabel) + '</span></div>' +
      '<div class="btns">' +
        '<button onclick="ai()">💬 AI 会话</button>' +
        '<button class="sec" onclick="folder()">在工作区打开</button>' +
      '</div>' +
      '<h4>TODO (' + state.todos.filter(d=>d.status==='done').length + '/' + state.todos.length + ')</h4>' +
      '<input id="todoIn" placeholder="添加 todo，回车保存" onkeydown="if(event.key===\\'Enter\\')addTodo()">' +
      '<div id="todos"></div>' +
      '<h4>Skills (' + (state.skills||[]).filter(s=>!(state.exSkills||[]).includes(s.id)).length + '/' + (state.skills||[]).length + ')' +
        '<span class="addbtn" onclick="addSkill()" title="添加 Skill 目录">＋</span></h4>' +
      '<div id="skills"></div>' +
      '<h4>MCP (' + (state.mcps||[]).filter(s=>!(state.exMcp||[]).includes(s.id)).length + '/' + (state.mcps||[]).length + ')' +
        '<span class="addbtn" onclick="addMcp()" title="添加 MCP 服务">＋</span></h4>' +
      '<div id="mcps"></div>' +
      '<h4>文件<span class="addbtn" onclick="nf()" title="新建文件">＋文件</span><span class="addbtn" onclick="nd()" title="新建文件夹">＋目录</span></h4><div class="tree" id="tree"></div>'
    renderTodos(); renderPicks(); renderTree()
  }
  function renderPicks(){
    const exS = state.exSkills || [], exM = state.exMcp || []
    const sEl = $('skills'); if (sEl) {
      sEl.innerHTML = (state.skills||[]).length ? (state.skills||[]).map(s =>
        '<label class="pick"><input type="checkbox"' + (exS.includes(s.id)?'':' checked') +
        ' onchange="tgSkill(\\'' + s.id + '\\',this.checked)" title="' + esc(s.description||'') + '">' +
        '<span class="pn">' + esc(s.name) + '</span><span class="psrc">' + esc(s.source||'user') + '</span></label>').join('')
        : '<div class="empty2">未发现 Skill（扫描 ~/.agents 与 ~/.claude）</div>'
    }
    const mEl = $('mcps'); if (mEl) {
      mEl.innerHTML = (state.mcps||[]).length ? (state.mcps||[]).map(m =>
        '<label class="pick"><input type="checkbox"' + (exM.includes(m.id)?'':' checked') +
        ' onchange="tgMcp(\\'' + m.id + '\\',this.checked)">' +
        '<span class="pn">' + esc(m.name) + '</span><span class="psrc">' + esc(m.type||'stdio') + '</span></label>').join('')
        : '<div class="empty2">未发现 MCP 配置</div>'
    }
  }
  function renderTodos(){
    const el = $('todos'); if (!el) return
    el.innerHTML = state.todos.map(d =>
      '<div class="todo' + (d.status==='done'?' done':'') + '">' +
      '<input type="checkbox"' + (d.status==='done'?' checked':'') + ' onchange="tg(\\''+d.id+'\\',this.checked)">' +
      '<span class="t">' + esc(d.title) + '</span><span class="x" onclick="del(\\''+d.id+'\\')">✕</span></div>').join('')
      || '<div style="opacity:.5;font-size:12px">暂无 todo</div>'
  }
  let expanded = {}
  function renderTree(){
    const el = $('tree'); if (!el) return
    el.innerHTML = ''
    const build = (entries, depth, container) => {
      for (const e of entries) {
        const div = document.createElement('div'); div.style.paddingLeft = (depth*14) + 'px'
        if (e.dir) {
          const open = !!expanded[e.path]
          div.className = 'dir'
          div.innerHTML = '<span class="ico">' + (open?'▾':'▸') + '</span>📁 ' + esc(e.name)
          div.onclick = () => {
            expanded[e.path] = !expanded[e.path]
            if (expanded[e.path] && !e.children) vscode.postMessage({t:'ls', path:e.path})
            else renderTree()
          }
          container.appendChild(div)
          if (open && e.children) build(e.children, depth+1, container)
        } else {
          div.className = 'file'
          div.innerHTML = '<span class="ico"> </span>📄 ' + esc(e.name)
          div.onclick = () => vscode.postMessage({t:'openFile', path:e.path})
          container.appendChild(div)
        }
      }
    }
    build(state.files || [], 0, el)
    if (!(state.files||[]).length) el.innerHTML = '<div style="opacity:.5;font-size:12px">（空目录）</div>'
  }
  const $ = (i) => document.getElementById(i)
  function addTodo(){ const v = $('todoIn').value.trim(); if(v){ vscode.postMessage({t:'addTodo', title:v}); $('todoIn').value='' } }
  window.addEventListener('message', (e) => {
    const d = e.data
    if (d.t === 'state') { state = d; render() }
    else if (d.t === 'files') {
      const set = (list) => list.forEach(x => { if (x.path === d.path) { x.children = d.entries; found = true } else if (x.children) set(x.children) })
      let found = false; set(state.files || [])
      if (!found) state.files = d.entries
      renderTree()
    }
  })
  const st = () => vscode.postMessage({t:'status'})
  const gp = (v) => vscode.postMessage({t:'group', groupId:v})
  const ag = (v) => vscode.postMessage({t:'agent', agentId:v})
  const md = (v) => vscode.postMessage({t:'model', modelId:v})
  const det = () => vscode.postMessage({t:'detect'})
  const tg = (id, done) => vscode.postMessage({t:'toggleTodo', id, status: done?'done':'todo'})
  const tgSkill = (id, checked) => vscode.postMessage({t:'toggleSkill', id, checked})
  const tgMcp = (id, checked) => vscode.postMessage({t:'toggleMcp', id, checked})
  const addSkill = () => vscode.postMessage({t:'addSkill'})
  const nf = () => vscode.postMessage({t:'newFile'})
  const nd = () => vscode.postMessage({t:'newFolder'})
  const addMcp = () => vscode.postMessage({t:'addMcp'})
  const del = (id) => vscode.postMessage({t:'delTodo', id})
  const ai = () => vscode.postMessage({t:'openAI'})
  const folder = () => vscode.postMessage({t:'openFolder'})
</script></body></html>`

function readDir(dir) {
  try {
    const names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.name !== '.zztask' && !d.name.startsWith('.git'))
    names.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    return names.slice(0, 200).map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
  } catch { return [] }
}

function buildState(store, taskId, extra) {
  const task = store.getTask(taskId)
  if (!task) return { t: 'state', task: null }
  const { resolveEnv } = require('./agentRunner')
  const { GLOBAL_ENV } = require('./envs')
  const agents = store.listAgents()
  const agent = agents.find((a) => a.id === task.agent_id) || agents[0]
  const env = resolveEnv(task.path, agent)
  return {
    t: 'state', task, groups: store.listGroups(), agents, models: store.listModels(),
    ...(extra || {}),
    skills: store.listSkills(GLOBAL_ENV), exSkills: store.taskExcludedSkills(task.id),
    mcps: store.listMcp(GLOBAL_ENV), exMcp: store.taskExcludedMcp(task.id),
    todos: store.listTodos(task.id), files: readDir(task.path),
    envLabel: { local: '本机', wsl: `WSL:${env.distro}`, ssh: `SSH:${env.host}` }[env.kind],
  }
}

// 返回 'detect' | 'changed' | false
function handleInfo(store, taskId, m, post) {
  const task = taskId && store.getTask(taskId)
  if (m.t === 'ls') { post({ t: 'files', path: m.path, entries: readDir(m.path) }); return false }
  if (m.t === 'detect') return 'detect'
  if (!task) return false
  if (m.t === 'addTodo') store.addTodo(task.id, m.title)
  else if (m.t === 'toggleSkill') store.setTaskSkillExcluded(task.id, m.id, !m.checked)
  else if (m.t === 'toggleMcp') store.setTaskMcpExcluded(task.id, m.id, !m.checked)
  else if (m.t === 'addSkill') { vscode.commands.executeCommand('zzwork.addSkill'); return false }
  else if (m.t === 'newFile') { vscode.commands.executeCommand('zzwork.newFileInTask'); return false }
  else if (m.t === 'newFolder') { vscode.commands.executeCommand('zzwork.newFolderInTask'); return false }
  else if (m.t === 'addMcp') { vscode.commands.executeCommand('zzwork.addMcp'); return false }
  else if (m.t === 'toggleTodo') store.setTodoStatus(m.id, m.status)
  else if (m.t === 'delTodo') store.deleteTodo(m.id)
  else if (m.t === 'status') store.updateTask(task.id, { status: task.status === 'done' ? 'active' : 'done' })
  else if (m.t === 'group') store.updateTask(task.id, { group_id: m.groupId || null })
  else if (m.t === 'agent') store.updateTask(task.id, { agent_id: m.agentId })
  else if (m.t === 'model') store.updateTask(task.id, { model_id: m.modelId })
  else if (m.t === 'openAI') { vscode.commands.executeCommand('zzwork.openAI', task.id); return false }
  else if (m.t === 'openFolder') { vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(task.path), false); return false }
  else if (m.t === 'openFile') { vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.path)); return false }
  return true
}

class TaskDetailProvider {
  constructor(store) { this.store = store; this.installed = [] }

  resolveWebviewView(v) {
    view = v
    v.webview.options = { enableScripts: true }
    v.webview.html = HTML
    v.webview.onDidReceiveMessage((m) => this.onMsg(m))
    this.push()
  }

  push() {
    if (!view) return
    const id = this.store.getSetting('activeTaskId', '')
    const task = id && this.store.getTask(id)
    const payload = task ? buildState(this.store, id, { installed: this.installed, detecting: this.detecting || false })
      : { t: 'state', task: null }
    view.webview.postMessage(payload)
    if (task) this.runDetect(task)
  }

  async runDetect(task) {
    if (this.detecting) return
    this.detecting = true
    const prev = JSON.stringify(this.installed)
    try {
      const { resolveEnv, detectAgents } = require('./agentRunner')
      const env = resolveEnv(task.path, { where: 'auto' })
      this.installed = await detectAgents(env)
    } catch { this.installed = [] }
    this.detecting = false
    // 结果有变化才回推，避免 push↔detect 递归
    if (JSON.stringify(this.installed) !== prev) this.push()
  }

  onMsg(m) {
    const id = this.store.getSetting('activeTaskId', '')
    const task = id && this.store.getTask(id)
    const r = handleInfo(this.store, id, m, (o) => view && view.webview.postMessage(o))
    if (r === 'detect') { if (task) this.runDetect(task); return }
    if (r === 'changed') { if (this.onChanged) this.onChanged(); this.push() }
  }
}

module.exports = { TaskDetailProvider, getDetailView: () => view, TASK_HTML: HTML, buildState, handleInfo, readDir }
