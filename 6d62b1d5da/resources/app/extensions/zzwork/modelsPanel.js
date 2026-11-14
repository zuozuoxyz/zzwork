// zzwork 模型管理：编辑器区 tab（列表 + 新增表单 + 设默认/Key/删除）
const vscode = require('vscode')

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);margin:0;padding:18px 22px;background:var(--vscode-editor-background)}
  h2{margin:0 0 2px;font-size:16px;font-weight:500}
  .sub{font-size:11.5px;opacity:.6;margin-bottom:14px}
  h3{font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;opacity:.65;margin:16px 0 6px;font-weight:600}
  .mrow{display:flex;align-items:center;gap:10px;border:1px solid rgba(128,128,128,.25);border-radius:6px;padding:9px 12px;margin-bottom:6px;max-width:640px}
  .mrow .nm{font-size:13px}
  .mrow .meta{margin-left:auto;font-size:11px;opacity:.6;display:flex;gap:10px;align-items:center}
  .tag{border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:0 7px;font-size:10px;opacity:.75}
  .tag.def{border-color:rgba(14,165,233,.5);color:#7dd3fc}
  button{background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.3));color:inherit;border:none;border-radius:4px;padding:4px 10px;font-size:11.5px;cursor:pointer}
  button.pri{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  form{max-width:640px}
  .frow{display:flex;gap:8px;margin-bottom:8px;align-items:center}
  label{flex:0 0 92px;font-size:12px;opacity:.8}
  input,select{flex:1;height:27px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));border-radius:4px;padding:0 8px;font-size:12.5px;font-family:inherit}
</style></head><body>
  <h2>模型</h2>
  <div class="sub">支持 Anthropic 原生与 OpenAI 兼容接口；API Key 保存在系统密钥存储</div>
  <div id="list"></div>
  <h3>新增模型</h3>
  <form onsubmit="return save(event)">
    <div class="frow"><label>显示名</label><input id="f_name" placeholder="如 Claude Sonnet" required></div>
    <div class="frow"><label>接口类型</label><select id="f_type"><option value="anthropic">Anthropic</option><option value="openai_compatible" selected>OpenAI 兼容</option></select></div>
    <div class="frow"><label>Base URL</label><input id="f_base" placeholder="https://api.example.com/v1"></div>
    <div class="frow"><label>模型 ID</label><input id="f_mid" placeholder="claude-sonnet-4-5 / glm-4.6" required></div>
    <div class="frow"><label>API Key</label><input id="f_key" type="password" placeholder="可稍后在列表里设置"></div>
    <div class="frow"><label></label><button class="pri" type="submit">添加</button></div>
  </form>
<script>
  const vscode = acquireVsCodeApi()
  const $=(i)=>document.getElementById(i)
  const esc=(s)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
  window.addEventListener('message',(e)=>{
    const d=e.data
    if(d.t==='state'){
      $('list').innerHTML = d.models.length ? d.models.map(m=>
        '<div class="mrow"><span class="nm">'+esc(m.name)+'</span>' +
        '<span class="tag">'+(m.type==='anthropic'?'Anthropic':'OpenAI 兼容')+'</span>' +
        (m.is_default?'<span class="tag def">默认</span>':'') +
        '<span class="meta"><span>'+esc(m.model_id)+'</span>' +
        (m.hasKey?'<span>✓ Key</span>':'<span style="opacity:.5">无 Key</span>') + '</span>' +
        '<button onclick="act(\\'def\\',\\''+m.id+'\\')">设为默认</button>' +
        '<button onclick="act(\\'key\\',\\''+m.id+'\\')">设置 Key</button>' +
        '<button onclick="act(\\'del\\',\\''+m.id+'\\')">删除</button></div>').join('')
        : '<div style="opacity:.5;padding:8px 0">还没有模型，先在下面添加一个</div>'
    }
  })
  function act(a,id){vscode.postMessage({a,id})}
  function save(ev){
    ev.preventDefault()
    vscode.postMessage({a:'add',name:$('f_name').value,type:$('f_type').value,
      base_url:$('f_base').value,model_id:$('f_mid').value,key:$('f_key').value})
    ;['f_name','f_base','f_mid','f_key'].forEach(i=>$(i).value='')
    return false
  }
</script></body></html>`

let panel = null
let store = null
let secrets = null
let onChanged = null

async function refresh() {
  if (!panel || !store) return
  const models = store.listModels()
  const keys = await Promise.all(models.map((m) => secrets.get('zzwork.key.' + m.id)))
  panel.webview.postMessage({ t: 'state', models: models.map((m, i) => ({ ...m, hasKey: !!keys[i] })) })
}

function openModels(s, sec, changed) {
  store = s; secrets = sec; onChanged = changed
  if (panel) { panel.reveal(vscode.ViewColumn.One); refresh(); return }
  panel = vscode.window.createWebviewPanel('zzwork.modelsTab', '模型', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true })
  panel.webview.html = HTML
  panel.webview.onDidReceiveMessage(async (m) => {
    if (!store) return
    if (m.a === 'add') {
      const id = require('crypto').randomUUID()
      store.upsertModel({ id, name: m.name, type: m.type, base_url: m.base_url || (m.type === 'anthropic' ? 'https://api.anthropic.com' : ''), model_id: m.model_id, is_default: store.listModels().length === 0 })
      if (m.key) await secrets.store('zzwork.key.' + id, m.key)
      if (onChanged) onChanged()
    } else if (m.a === 'def') {
      for (const x of store.listModels()) store.upsertModel({ ...x, is_default: x.id === m.id })
      if (onChanged) onChanged()
    } else if (m.a === 'del') {
      store.deleteModel(m.id)
      if (onChanged) onChanged()
    } else if (m.a === 'key') {
      const k = await vscode.window.showInputBox({ password: true, placeHolder: 'API Key' })
      if (k) await secrets.store('zzwork.key.' + m.id, k)
    }
    refresh()
  })
  panel.onDidDispose(() => { panel = null })
  refresh()
}

module.exports = { openModels }
