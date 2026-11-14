// zzwork AI 会话面板：编辑器区 webview，每任务一会话，ZCode 风格界面
// 配置（执行体/模型）在右侧任务详情面板中设置
const vscode = require('vscode')
const { chatStream } = require('./ai')
const { runAgent } = require('./agentRunner')
const fsx = require('fs')
const pathx = require('path')

const panels = new Map() // taskId -> panel

// ZCode 暗色主题令牌（取自 ZCode 渲染层样式表）
const T = {
  bg: '#171717', sidebar: '#0a0a0a', card: '#262626', cardHover: '#404040',
  brand: '#0ea5e9', user: '#60a5fa', assistant: '#2dd4bf', reasoning: '#a78bfa',
  fg: '#fafafa', fgDim: '#a3a3a3', border: 'rgba(250,250,250,.1)',
  surface: 'rgba(255,255,255,.05)', surfaceHover: 'rgba(255,255,255,.1)',
}

function html() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    :root{--bg:${T.bg};--card:${T.card};--brand:${T.brand};--user:${T.user};--assistant:${T.assistant};--fg:${T.fg};--dim:${T.fgDim};--bd:${T.border};--sf:${T.surface}}
    *{box-sizing:border-box}
    body{font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;font-size:13.5px;color:${T.fg};margin:0;height:100vh;display:flex;flex-direction:column;background:var(--bg)}
    #top{display:flex;gap:10px;padding:8px 16px;border-bottom:1px solid var(--bd);align-items:center;flex:0 0 auto;font-size:12px}
    #top .agent{color:var(--assistant);font-weight:600}
    #top .env{color:${T.fgDim}}
    #top .badge{background:var(--sf);border:1px solid var(--bd);border-radius:99px;padding:1px 8px;color:${T.fgDim}}
    #msgs{flex:1 1 auto;overflow-y:auto;padding:20px 16px}
    #inner{max-width:760px;margin:0 auto}
    .msg{margin:14px 0;display:flex;flex-direction:column}
    .msg.user{align-items:flex-end}
    .who{font-size:11px;margin-bottom:4px;letter-spacing:.3px}
    .msg.user .who{color:var(--user)}
    .msg.ai .who{color:var(--assistant)}
    .bubble{max-width:86%;padding:9px 14px;border-radius:14px;line-height:1.6;word-break:break-word;white-space:pre-wrap}
    .msg.user .bubble{background:rgba(14,165,233,.13);border:1px solid rgba(96,165,250,.25);border-bottom-right-radius:4px}
    .msg.ai .body{width:100%;line-height:1.65;color:var(--fg)}
    .err{color:#f87171;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.25);border-radius:10px;padding:8px 12px;max-width:86%}
    .cursor{display:inline-block;width:7px;height:15px;background:var(--brand);vertical-align:-2px;margin-left:2px;animation:blink 1s steps(2) infinite;border-radius:1px}
    @keyframes blink{50%{opacity:0}}
    /* markdown */
    .md h1,.md h2,.md h3{margin:.7em 0 .35em;line-height:1.3}
    .md h1{font-size:1.25em}.md h2{font-size:1.15em}.md h3{font-size:1.05em}
    .md p{margin:.45em 0}
    .md ul,.md ol{margin:.4em 0;padding-left:1.4em}
    .md li{margin:.2em 0}
    .md a{color:var(--brand)}
    .md code{background:var(--sf);border:1px solid var(--bd);border-radius:4px;padding:1px 5px;font-family:Consolas,'Courier New',monospace;font-size:.92em}
    .md blockquote{border-left:3px solid var(--bd);margin:.5em 0;padding:2px 12px;color:var(--dim)}
    .md hr{border:none;border-top:1px solid var(--bd);margin:.8em 0}
    .md table{border-collapse:collapse;margin:.5em 0}
    .md td,.md th{border:1px solid var(--bd);padding:4px 10px}
    .cb{margin:.7em 0;border:1px solid var(--bd);border-radius:10px;overflow:hidden;background:${T.sidebar}}
    .cb-head{display:flex;justify-content:space-between;align-items:center;padding:5px 12px;background:var(--sf);font-size:11px;color:var(--dim)}
    .cb-copy{cursor:pointer;color:var(--dim);border:1px solid var(--bd);border-radius:5px;padding:1px 8px;font-size:11px;background:transparent}
    .cb-copy:hover{color:var(--fg);background:var(--sf)}
    .cb pre{margin:0;padding:12px;overflow-x:auto;font-family:Consolas,'Courier New',monospace;font-size:12.5px;line-height:1.55;color:#e5e5e5;white-space:pre}
    #keyrow{display:none;padding:6px 16px;border-bottom:1px solid var(--bd);gap:8px;align-items:center;font-size:12px}
    #keyrow input{flex:1;background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:5px 10px;color:var(--fg);outline:none}
    #bottom{flex:0 0 auto;border-top:1px solid var(--bd);padding:12px 16px;background:var(--bg)}
    #composer{max-width:760px;margin:0 auto;display:flex;gap:10px;align-items:flex-end}
    #inp{flex:1;background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:10px 14px;color:var(--fg);font-size:13.5px;font-family:inherit;min-height:44px;max-height:180px;resize:none;outline:none;line-height:1.5}
    #inp:focus{border-color:var(--brand)}
    #send{background:var(--brand);color:#fff;border:none;border-radius:10px;padding:10px 18px;cursor:pointer;font-size:13px;font-weight:500;height:44px}
    #send:hover{background:#0284c7}
    #send:disabled{opacity:.45;cursor:default}
    #stop{background:transparent;color:var(--dim);border:1px solid var(--bd);border-radius:10px;padding:10px 16px;cursor:pointer;font-size:13px;height:44px;display:none}
    #stop:hover{color:var(--fg);border-color:var(--fg)}
    #hint{max-width:760px;margin:0 auto 6px;font-size:11px;color:${T.fgDim};opacity:.8}
  </style></head><body>
    <div id="top"><span class="agent" id="agName"></span><span class="env" id="env"></span><span class="badge" id="tbadge"></span></div>
    <div id="keyrow"><span>API Key:</span><input id="key" type="password"><button id="ksave" style="background:var(--brand);color:#fff;border:none;border-radius:8px;padding:4px 12px;cursor:pointer">保存</button></div>
    <div id="msgs"><div id="inner"></div></div>
    <div id="bottom">
      <div id="hint">Enter 发送 · Shift+Enter 换行 · 执行体与模型在「任务信息」tab 中配置</div>
      <div id="composer">
        <textarea id="inp" placeholder="发送消息给执行体…"></textarea>
        <button id="send">发送</button>
        <button id="stop">停止</button>
      </div>
    </div>
  <script>
    const vscode = acquireVsCodeApi()
    let running = false, agLabel = ''
    const $ = (i) => document.getElementById(i)
    const escHtml = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')

    // ---- 轻量 markdown 渲染（代码块/标题/加粗/行内码/列表/引用/链接/表格线）----
    function inlineMd(s) {
      s = escHtml(s)
      s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')
      s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<i>$2</i>')
      s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2">$1</a>')
      return s
    }
    function md(src) {
      const parts = String(src).split(/\`\`\`/)
      let out = ''
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) { // 代码块：首行可能是语言
          let code = parts[i]; let lang = ''
          const nl = code.indexOf('\\n')
          if (nl > 0 && /^[a-zA-Z0-9+#-]{0,20}$/.test(code.slice(0, nl).trim())) { lang = code.slice(0, nl).trim(); code = code.slice(nl + 1) }
          const id = 'cb' + i + '_' + Math.random().toString(36).slice(2, 6)
          out += '<div class="cb"><div class="cb-head"><span>' + (lang || 'text') + '</span>' +
            '<button class="cb-copy" onclick="cp(\\''+id+'\\')">复制</button></div>' +
            '<pre id="' + id + '">' + escHtml(code.replace(/\\n$/, '')) + '</pre></div>'
        } else {
          const lines = parts[i].split('\\n'); let html = '', list = null
          const flush = () => { if (list) { html += '</' + list + '>'; list = null } }
          for (let ln of lines) {
            const h = ln.match(/^(#{1,3})\\s+(.*)/)
            const ul = ln.match(/^[-*+]\\s+(.*)/)
            const ol = ln.match(/^\\d+[.)]\\s+(.*)/)
            if (h) { flush(); html += '<h' + h[1].length + '>' + inlineMd(h[2]) + '</h' + h[1].length + '>' }
            else if (ul) { if (list !== 'ul') { flush(); html += '<ul>'; list = 'ul' } html += '<li>' + inlineMd(ul[1]) + '</li>' }
            else if (ol) { if (list !== 'ol') { flush(); html += '<ol>'; list = 'ol' } html += '<li>' + inlineMd(ol[1]) + '</li>' }
            else if (/^&gt;\\s?/.test(escHtml(ln)) && !ln.trim()) { }
            else if (ln.trim() === '') { flush() }
            else if (/^---+$/.test(ln.trim())) { flush(); html += '<hr>' }
            else { flush(); html += '<p>' + inlineMd(ln) + '</p>' }
          }
          flush(); out += html
        }
      }
      return '<div class="md">' + out + '</div>'
    }
    function cp(id) { navigator.clipboard.writeText(document.getElementById(id).textContent) }

    // ---- 消息渲染 ----
    function addUser(text) {
      const el = document.createElement('div'); el.className = 'msg user'
      el.innerHTML = '<div class="who">你</div>'
      const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text
      el.appendChild(b); $('inner').appendChild(el); scrollEnd()
    }
    function addAi(htmlContent) {
      const el = document.createElement('div'); el.className = 'msg ai'
      el.innerHTML = '<div class="who">' + escHtml(agLabel || 'AI') + '</div>'
      const b = document.createElement('div'); b.className = 'body md'; b.innerHTML = htmlContent
      el.appendChild(b); $('inner').appendChild(el); scrollEnd()
    }
    function addErr(text) {
      const el = document.createElement('div'); el.className = 'msg ai'
      const e = document.createElement('div'); e.className = 'err'; e.textContent = '✗ ' + text
      el.appendChild(e); $('inner').appendChild(el); scrollEnd()
    }
    let streamEl = null, streamTxt = ''
    function streamStart() {
      streamEl = document.createElement('div'); streamEl.className = 'msg ai'
      streamEl.innerHTML = '<div class="who">' + escHtml(agLabel || 'AI') + '</div>'
      const b = document.createElement('div'); b.className = 'body md'
      const s = document.createElement('span'); s.id = 'stext'
      const c = document.createElement('span'); c.className = 'cursor'
      b.appendChild(s); b.appendChild(c); streamEl.appendChild(b)
      $('inner').appendChild(streamEl); streamTxt = ''; scrollEnd()
    }
    function streamDelta(t) {
      streamTxt += t
      const s = document.getElementById('stext'); if (s) s.innerHTML = md(streamTxt)
      scrollEnd()
    }
    function streamEnd() { if (streamEl) { streamEl.remove(); streamEl = null } }
    function scrollEnd(){ $('msgs').scrollTop = $('msgs').scrollHeight }

    window.addEventListener('message', (e) => {
      const d = e.data
      if (d.t === 'init') {
        agLabel = d.agentName; $('agName').textContent = d.agentName
        $('env').textContent = d.envLabel
        $('tbadge').textContent = d.task.type === 'code' ? 'CODE' : 'WORK'
        $('inner').innerHTML = ''
        for (const m of d.messages) { m.role === 'user' ? addUser(m.content) : addAi(md(m.content)) }
        scrollEnd()
      } else if (d.t === 'delta') { if (!streamEl) streamStart(); streamDelta(d.text) }
      else if (d.t === 'done') {
        streamEnd()
        if (d.error) addErr(d.error)
        else if (d.content) addAi(md(d.content))
        setRunning(false)
      } else if (d.t === 'needKey') { $('keyrow').style.display = 'flex'; $('key').focus() }
    })
    function setRunning(r){ running = r; $('send').disabled = r; $('stop').style.display = r ? '' : 'none' }
    function send(){
      const text = $('inp').value.trim(); if (!text || running) return
      $('inp').value = ''
      addUser(text); setRunning(true)
      vscode.postMessage({ t: 'send', text })
    }
    $('send').onclick = send
    $('stop').onclick = () => vscode.postMessage({ t: 'stop' })
    $('ksave').onclick = () => { vscode.postMessage({ t: 'key', key: $('key').value }); $('keyrow').style.display = 'none'; $('key').value = '' }
    $('inp').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
  </script></body></html>`
}

class AIChat {
  constructor(ctx, store, secrets, taskId, title) {
    this.ctx = ctx; this.store = store; this.secrets = secrets; this.taskId = taskId
    this.runner = null
    const task = store.getTask(taskId)
    this.panel = vscode.window.createWebviewPanel('zzwork.ai', title || `AI 对话 · ${task ? task.name : ''}`, vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true })
    panels.set(taskId, this)
    this.panel.webview.html = html()
    this.panel.onDidDispose(() => { if (this.runner) this.runner.kill(); panels.delete(taskId) })
    this.panel.webview.onDidReceiveMessage((m) => this.onMsg(m))
    this.pushInit()
  }

  pushInit() {
    const task = this.store.getTask(this.taskId)
    if (!task) return
    const { resolveEnv } = require('./agentRunner')
    const agents = this.store.listAgents()
    const agent = agents.find((a) => a.id === task.agent_id) || agents[0]
    const env = resolveEnv(task.path, agent)
    this.panel.webview.postMessage({
      t: 'init', task, agentName: agent.name,
      envLabel: { local: '本机', wsl: `WSL:${env.distro}`, ssh: `SSH:${env.host}` }[env.kind],
      messages: this.store.listMessages(this.taskId),
    })
  }

  refresh() { this.pushInit() }

  appendChatFile(role, content) {
    try {
      const task = this.store.getTask(this.taskId)
      if (!task || !task.path) return
      const dir = pathx.join(task.path, '.zzwork', 'chat')
      fsx.mkdirSync(dir, { recursive: true })
      const file = pathx.join(dir, new Date().toISOString().slice(0, 10) + '.md')
      const stamp = new Date().toTimeString().slice(0, 8)
      fsx.appendFileSync(file, '## ' + (role === 'user' ? '用户' : 'AI') + ' · ' + stamp + '\n\n' + String(content || '').trim() + '\n\n')
    } catch {}
  }

  async onMsg(m) {
    if (m.t === 'key') {
      const task = this.store.getTask(this.taskId)
      const model = this.store.listModels().find((x) => x.id === task.model_id) || this.store.listModels()[0]
      if (model) await this.secrets.store('zzwork.key.' + model.id, m.key)
      return
    }
    if (m.t === 'stop') { if (this.runner) this.runner.kill(); return }
    if (m.t !== 'send') return

    const task = this.store.getTask(this.taskId)
    if (!task) return
    const agents = this.store.listAgents()
    const agent = agents.find((a) => a.id === task.agent_id) || agents[0]
    this.store.addMessage(this.taskId, 'user', m.text)
    this.appendChatFile('user', m.text)

    const post = (o) => this.panel && this.panel.webview.postMessage(o)
    const onDelta = (s) => post({ t: 'delta', text: s })

    if (agent.kind === 'builtin') {
      const models = this.store.listModels()
      const model = models.find((x) => x.id === task.model_id) || models[0]
      if (!model) { post({ t: 'done', error: '未配置模型：请在右侧任务详情中选择模型' }); return }
      const key = await this.secrets.get('zzwork.key.' + model.id)
      if (!key) { post({ t: 'needKey' }); this.store.addMessage(this.taskId, 'assistant', '(未设置 API Key，已中断)'); post({ t: 'done', error: '未设置 API Key' }); return }
      const history = this.store.listMessages(this.taskId).slice(-30).map((x) => ({ role: x.role === 'user' ? 'user' : 'assistant', content: x.content }))
      let acc = ''
      this.runner = { kill: () => { this.aborted = true; if (this.ctrl) this.ctrl.abort() } }
      try {
        const extra = this.store.getSetting('session:prompt:' + task.id, '')
        const sys = `你是 zzwork 工作助手，当前任务「${task.name}」（类型 ${task.type}）。回答简洁实用。` +
          (extra ? '\n\n【本次会话提示词】\n' + extra : '')
        await chatStream(model, key, history, sys, (d) => { acc += d; onDelta(d) })
        this.store.addMessage(this.taskId, 'assistant', acc)
        this.appendChatFile('assistant', acc)
        post({ t: 'done', content: acc })
      } catch (e) {
        if (this.aborted) { this.store.addMessage(this.taskId, 'assistant', acc + '\n(已停止)'); post({ t: 'done', content: acc + '\n(已停止)' }) }
        else { post({ t: 'done', error: e.message }) }
      } finally { this.runner = null; this.aborted = false }
      return
    }

    // CLI 执行体
    let meta = {}; try { meta = JSON.parse(task.meta || '{}') } catch {}
    // 任务级 Skills / MCP 选择（默认全选，排除项来自任务详情页）
    let selection = { skills: [], mcps: [] }
    try {
      const { resolveTaskEnv } = require('./envs')
      const taskEnv = resolveTaskEnv(this.store, task)
      const exS = this.store.taskExcludedSkills(task.id)
      const exM = this.store.taskExcludedMcp(task.id)
      selection.skills = this.store.listSkills(taskEnv.id).filter((s) => !exS.includes(s.id))
      selection.mcps = this.store.listMcp(taskEnv.id).filter((m) => !exM.includes(m.id))
    } catch {}
    let acc = ''
    const systemExtra = this.store.getSetting('session:prompt:' + task.id, '')
    this.runner = await runAgent({
      task, agent, prompt: m.text, meta, selection, systemExtra,
      onMeta: (k, v) => { meta[k] = v; this.store.updateTask(this.taskId, { meta: JSON.stringify(meta) }) },
      onDelta: (s) => { acc += s; onDelta(s) },
      onDone: (result) => {
        const content = (result && result.trim()) ? result : acc
        this.store.addMessage(this.taskId, 'assistant', content)
        this.appendChatFile('assistant', content)
        post({ t: 'done', content })
        this.runner = null
      },
      onError: (err) => { post({ t: 'done', error: err }); this.runner = null },
    })
  }
}

function openChat(ctx, store, secrets, taskId, opts) {
  const ex = panels.get(taskId)
  if (ex) { ex.panel.reveal(vscode.ViewColumn.One); ex.refresh(); return ex }
  return new AIChat(ctx, store, secrets, taskId, opts && opts.title)
}

function disposeChat(taskId) {
  const ex = panels.get(taskId)
  if (ex) { try { ex.panel.dispose() } catch {} }
  panels.delete(taskId)
}

module.exports = { openChat, disposeChat, panels }
