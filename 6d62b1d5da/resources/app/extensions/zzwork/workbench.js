// 任务工作台：编辑区三固定 tab（任务信息 / 会话管理 / AI 对话）+ 每任务文件 tab 记忆
const vscode = require('vscode')
const { TASK_HTML, buildState, handleInfo } = require('./taskPanel')
const { openChat, disposeChat, panels: chatPanels } = require('./aiPanel')

const sessions = new Map()
// taskId -> { info, session }
const fileMemory = new Map() // taskId -> string[]
let currentId = null
let refreshHook = null

const SESSION_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:14px 16px;font-size:13px}
  h3{font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;opacity:.65;margin:14px 0 6px;font-weight:600}
  .row{display:flex;gap:14px;align-items:flex-start}
  .left{flex:1;min-width:0}
  .right{width:300px;flex:0 0 auto}
  #prompt{width:100%;min-height:120px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));border-radius:5px;padding:9px 11px;font-family:inherit;font-size:13px;line-height:1.65;resize:vertical;box-sizing:border-box}
  canvas{display:block;width:100%;height:250px;border:1px solid rgba(128,128,128,.3);border-radius:6px;cursor:crosshair;background:transparent}
  .bar{display:flex;gap:6px;margin:6px 0 0;align-items:center}
  button{background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.25));color:var(--vscode-button-secondaryForeground,inherit);border:none;border-radius:4px;padding:4px 10px;font-size:11.5px;cursor:pointer}
  .chg{display:flex;gap:8px;align-items:center;border:1px solid rgba(128,128,128,.25);border-radius:5px;padding:6px 9px;margin-bottom:5px;font-size:12px}
  .chg .k{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chg .v{opacity:.65;font-size:11px}
  .hint{opacity:.55;font-size:11px;margin-top:6px}
</style></head><body>
  <div class="row">
    <div class="left">
      <h3>提示词</h3>
      <textarea id="prompt" placeholder="写这次想怎么让 AI 干活；会随每条消息一起带给执行体"></textarea>
      <div class="hint" id="saveHint">自动保存</div>
      <h3>改动 · 随对话一起发送</h3>
      <div id="changes"></div>
    </div>
    <div class="right">
      <h3>画板</h3>
      <canvas id="cv"></canvas>
      <div class="bar">
        <button id="clr">清空</button>
        <span class="hint" id="cvHint"></span>
      </div>
    </div>
  </div>
<script>
  const vscode = acquireVsCodeApi()
  const $ = (i) => document.getElementById(i)
  let taskId = null, saveTimer = null
  const prompt = $('prompt')
  prompt.addEventListener('input', () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => vscode.postMessage({ t: 'prompt', text: prompt.value }), 400)
  })

  const cv = $('cv')
  const ctx = cv.getContext('2d')
  let drawing = false, dirty = false
  function fit() {
    const dpr = window.devicePixelRatio || 1
    const r = cv.getBoundingClientRect()
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      ctx.strokeStyle = getComputedStyle(document.body).color
    }
  }
  new ResizeObserver(fit).observe(cv)
  function pos(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  cv.addEventListener('pointerdown', (e) => { fit(); drawing = true; cv.setPointerCapture(e.pointerId); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y) })
  cv.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); dirty = true })
  cv.addEventListener('pointerup', () => { if (!drawing) return; drawing = false; save() })
  $('clr').onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); dirty = false; save(); $('cvHint').textContent = '' }
  function save() { vscode.postMessage({ t: 'canvas', data: dirty ? cv.toDataURL('image/png') : '' }) }

  window.addEventListener('message', (e) => {
    const d = e.data
    if (d.t === 'init') {
      taskId = d.task.id
      prompt.value = d.prompt || ''
      if (d.canvas) { const img = new Image(); img.onload = () => { fit(); ctx.drawImage(img, 0, 0, cv.getBoundingClientRect().width, cv.getBoundingClientRect().height) }; img.src = d.canvas; $('cvHint').textContent = '已有草图' }
      $('changes').innerHTML = d.items.map((x) =>
        '<div class="chg"><span class="k">' + x.k + '</span><span class="v">' + x.v + '</span></div>').join('')
    }
  })
</script></body></html>`

function closeFileTabs() {
  try {
    const toClose = []
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        if (t.input && t.input.uri && !t.isDirty) toClose.push(t)
      }
    }
    if (toClose.length) return vscode.window.tabGroups.close(toClose, true)
  } catch {}
  return Promise.resolve()
}

function currentFilePaths() {
  const out = []
  try {
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        if (t.input && t.input.uri && t.input.uri.scheme === 'file') out.push(t.input.uri.fsPath)
      }
    }
  } catch {}
  return out
}

function createInfoPanel(ctx, store, taskId) {
  const panel = vscode.window.createWebviewPanel('zzwork.info', '任务信息', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true })
  panel.webview.html = TASK_HTML
  const post = (o) => { try { panel.webview.postMessage(o) } catch {} }
  const refresh = () => post(buildState(store, taskId, { installed: [] }))
  panel.webview.onDidReceiveMessage(async (m) => {
    const r = handleInfo(store, taskId, m, post)
    if (r === 'detect') {
      try {
        const { resolveEnv, detectAgents } = require('./agentRunner')
        const task = store.getTask(taskId)
        const env = resolveEnv(task.path, { where: 'auto' })
        const installed = await detectAgents(env)
        post(buildState(store, taskId, { installed }))
      } catch {}
      return
    }
    if (r === 'changed') {
      refresh()
      refreshHook && refreshHook()
    }
  })
  panel.onDidDispose(() => { /* 由 workbench 统一管理 */ })
  refresh()
  return { panel, refresh }
}

function createSessionPanel(store, taskId) {
  const panel = vscode.window.createWebviewPanel('zzwork.session', '会话管理', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true })
  panel.webview.html = SESSION_HTML
  const post = (o) => { try { panel.webview.postMessage(o) } catch {} }
  const promptKey = 'session:prompt:' + taskId
  const canvasKey = 'session:canvas:' + taskId
  const refresh = () => {
    const task = store.getTask(taskId)
    if (!task) return
    const { resolveTaskEnv } = require('./envs')
    const env = resolveTaskEnv(store, task)
    const skills = store.listSkills(env.id)
    const mcps = store.listMcp(env.id)
    const exS = store.taskExcludedSkills(taskId)
    const exM = store.taskExcludedMcp(taskId)
    const prompt = store.getSetting(promptKey, '')
    const canvas = store.getSetting(canvasKey, '')
    post({
      t: 'init', task,
      prompt, canvas,
      items: [
        { k: '提示词', v: prompt ? '已填写' : '空' },
        { k: '画板', v: canvas ? '有草图' : '空' },
        { k: 'Skills', v: `${skills.filter((s) => !exS.includes(s.id)).length}/${skills.length} 选中` },
        { k: 'MCP', v: `${mcps.filter((m) => !exM.includes(m.id)).length}/${mcps.length} 选中` },
      ],
    })
  }
  panel.webview.onDidReceiveMessage((m) => {
    if (m.t === 'prompt') store.setSetting(promptKey, m.text)
    else if (m.t === 'canvas') store.setSetting(canvasKey, m.data)
  })
  refresh()
  return { panel, refresh }
}

// 把若干任务目录确保挂在工作区（原生 Explorer 直接可操作）；managedRoots 记录 zzwork 挂的根
const managedRoots = new Set()

function isManaged(fsPath) {
  for (const p of managedRoots) if (p.toLowerCase() === fsPath.toLowerCase()) return true
  return false
}

function ensureTaskRoots(desired) {
  const want = (Array.isArray(desired) ? desired : [desired]).filter(Boolean).map((p) => String(p))
  if (!want.length) return false
  try {
    let cur = vscode.workspace.workspaceFolders || []
    // 1) 需要的根若已存在（无论谁挂的），登记并跳过
    const missing = []
    for (const p of want) {
      const hit = cur.find((f) => f.uri.fsPath.toLowerCase() === p.toLowerCase())
      if (hit) managedRoots.add(p)
      else missing.push(p)
    }
    // 2) 移除不再需要的 zzwork 根（倒序删，索引稳定）
    const toRemove = cur.map((f, i) => ({ i, p: f.uri.fsPath })).filter((x) => isManaged(x.p) && !want.some((w) => w.toLowerCase() === x.p.toLowerCase()))
    for (const r of toRemove.slice().reverse()) {
      vscode.workspace.updateWorkspaceFolders(r.i, 1)
      managedRoots.delete(r.p)
    }
    if (toRemove.length) cur = vscode.workspace.workspaceFolders || []
    // 3) 追加缺失的根
    let okAll = true
    for (const p of missing) {
      const ok = vscode.workspace.updateWorkspaceFolders(cur.length, 0, { uri: vscode.Uri.file(p) })
      if (ok) { managedRoots.add(p); cur = vscode.workspace.workspaceFolders || cur }
      else okAll = false
    }
    try { require('fs').appendFileSync('D:/zzwork-storage.log', new Date().toISOString() + ` [zzwork] ensureTaskRoots want=${want.length} remove=${toRemove.length} add=${missing.length} ok=${okAll}\n`) } catch {}
    return okAll
  } catch (e) {
    try { require('fs').appendFileSync('D:/zzwork-storage.log', new Date().toISOString() + ' [zzwork] ensureTaskRoots ERR ' + e.message + '\n') } catch {}
    return false
  }
}

function setTaskRoot(taskPath) { ensureTaskRoots([taskPath]) }

async function openTaskWorkbench(ctx, store, secrets, taskId) {
  const task = store.getTask(taskId)
  if (!task) return null
  setTaskRoot(task.path)
  if (currentId && currentId !== taskId) {
    fileMemory.set(currentId, currentFilePaths())
    disposeWorkbench(currentId)
    await closeFileTabs()
  }
  if (currentId === taskId && sessions.has(taskId)) {
    const cur = sessions.get(taskId)
    cur.info.panel.reveal(vscode.ViewColumn.One)
    return cur
  }

  const info = createInfoPanel(ctx, store, taskId)
  const session = createSessionPanel(store, taskId)
  openChat(ctx, store, secrets, taskId, { title: 'AI 对话' })

  const files = fileMemory.get(taskId) || []
  const rec = { info: info.panel, session: session.panel }
  sessions.set(taskId, rec)
  currentId = taskId

  // 打开该任务上次的文件 tab
  for (const f of files) {
    try { await vscode.window.showTextDocument(vscode.Uri.file(f), { viewColumn: vscode.ViewColumn.One, preview: false }) } catch {}
  }
  // 固定 tab 顺序：信息 → 会话 → AI
  try { info.panel.reveal(vscode.ViewColumn.One, true) } catch {}
  return rec
}

function disposeWorkbench(taskId) {
  const s = sessions.get(taskId)
  if (s) {
    try { s.info.dispose() } catch {}
    try { s.session.dispose() } catch {}
    disposeChat(taskId)
    sessions.delete(taskId)
  }
  if (currentId === taskId) currentId = null
}

function refreshWorkbench() {
  const s = sessions.get(currentId)
  if (!s) return
  const info = sessions.get(currentId)
  // 重新创建信息/会话面板内容通过各自 refresh：这里直接重建 webview 状态
  try {
    const storeRef = global.__zzStore
    if (storeRef) {
      const st = buildState(storeRef, currentId, { installed: [] })
      // 找到 info panel 对应对象
      const rec = sessions.get(currentId)
      // info/session 面板对象只保留了 panel，无法调用 refresh；用 postMessage
      rec.info.webview.postMessage(st)
      const { resolveTaskEnv } = require('./envs')
      const task = storeRef.getTask(currentId)
      const env = resolveTaskEnv(storeRef, task)
      const skills = storeRef.listSkills(env.id)
      const mcps = storeRef.listMcp(env.id)
      const exS = storeRef.taskExcludedSkills(currentId)
      const exM = storeRef.taskExcludedMcp(currentId)
      rec.session.webview.postMessage({
        t: 'init', task,
        prompt: storeRef.getSetting('session:prompt:' + currentId, ''),
        canvas: storeRef.getSetting('session:canvas:' + currentId, ''),
        items: [
          { k: '提示词', v: storeRef.getSetting('session:prompt:' + currentId, '') ? '已填写' : '空' },
          { k: '画板', v: storeRef.getSetting('session:canvas:' + currentId, '') ? '有草图' : '空' },
          { k: 'Skills', v: `${skills.filter((s) => !exS.includes(s.id)).length}/${skills.length} 选中` },
          { k: 'MCP', v: `${mcps.filter((m) => !exM.includes(m.id)).length}/${mcps.length} 选中` },
        ],
      })
    }
  } catch {}
}

function setRefreshHook(fn) { refreshHook = fn }
function setStoreRef(store) { global.__zzStore = store }

module.exports = { openTaskWorkbench, disposeWorkbench, refreshWorkbench, setRefreshHook, setStoreRef, ensureTaskRoots, sessions }
