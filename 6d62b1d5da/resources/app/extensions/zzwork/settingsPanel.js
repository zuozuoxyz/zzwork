// zzwork 全局设置：活动栏第 6 个视图（webview）
const vscode = require('vscode')

let view = null
let store = null
let onChanged = null

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;padding:12px 14px}
  h4{margin:16px 0 6px;font-size:11px;text-transform:uppercase;opacity:.7;letter-spacing:.5px;font-weight:600}
  .box{border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));border-radius:6px;padding:10px 12px;margin-bottom:8px}
  .l{font-size:13px;margin-bottom:2px}
  .h{font-size:11px;opacity:.6;margin-bottom:8px}
  .row{display:flex;gap:8px;align-items:center}
  .txt{flex:1;height:26px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;display:flex;align-items:center;padding:0 8px;font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  button{background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.3));color:inherit;border:none;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer}
  button.pri{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  select{background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));border-radius:4px;padding:3px 6px;font-size:12px}
</style></head><body>
  <div id="root"></div>
<script>
  const vscode = acquireVsCodeApi()
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')}
  window.addEventListener('message',(e)=>{
    const d=e.data
    if(d.t!=='state')return
    const r=document.getElementById('root')
    r.innerHTML =
      '<h4>工作目录</h4>' +
      '<div class="box"><div class="l">任务存放位置</div>' +
      '<div class="h">新建任务会在此目录下创建同名文件夹</div>' +
      '<div class="row"><div class="txt" title="'+esc(d.workdir)+'">'+esc(d.workdir||'未设置')+'</div>' +
      '<button onclick="cmd(\\'pick\\')">更换…</button><button onclick="cmd(\\'open\\')">打开</button></div></div>' +
      '<h4>默认值</h4>' +
      '<div class="box"><div class="l">新任务默认类型</div>' +
      '<div class="h">work = 临时/简短任务；code = 代码仓库</div>' +
      '<div class="row"><select onchange="cmd(\\'type\\',this.value)">' +
      '<option value="work"'+(d.defaultType==='work'?' selected':'')+'>work</option>' +
      '<option value="code"'+(d.defaultType==='code'?' selected':'')+'>code</option></select></div></div>' +
      '<div class="box"><div class="l">选中任务时自动打开 AI 对话</div>' +
      '<div class="h">关闭后仅打开任务信息</div>' +
      '<div class="row"><select onchange="cmd(\\'autoAI\\',this.value)">' +
      '<option value="1"'+(d.autoAI?' selected':'')+'>开</option>' +
      '<option value=""'+(!d.autoAI?' selected':'')+'>关</option></select></div></div>' +
      '<h4>关于</h4>' +
      '<div class="box"><div class="h">zzwork · VS Code 1.142 内核 · 数据在本地</div></div>'
  })
  function cmd(a,v){vscode.postMessage({a,v})}
</script></body></html>`

class SettingsView {
  resolveWebviewView(v) {
    view = v
    v.webview.options = { enableScripts: true }
    v.webview.html = HTML
    v.webview.onDidReceiveMessage(async (m) => {
      if (!store) return
      if (m.a === 'pick') {
        const picks = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: '选择工作目录' })
        if (picks && picks.length) {
          store.setSetting('workdir', picks[0].fsPath)
          if (onChanged) onChanged()
          this.push()
        }
      } else if (m.a === 'open') {
        const wd = store.getSetting('workdir', '')
        if (wd) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(wd))
      } else if (m.a === 'type') {
        store.setSetting('defaultTaskType', m.v)
      } else if (m.a === 'autoAI') {
        store.setSetting('autoOpenAI', m.v === '1' ? '1' : '')
      }
    })
    this.push()
  }
  push() {
    if (!view || !store) return
    view.webview.postMessage({
      t: 'state',
      workdir: store.getSetting('workdir', ''),
      defaultType: store.getSetting('defaultTaskType', 'work'),
      autoAI: store.getSetting('autoOpenAI', '1') === '1',
    })
  }
}

function initSettings(s, changed) { store = s; onChanged = changed; const inst = new SettingsView(); inst.push(); return inst }

module.exports = { SettingsView, initSettings }
