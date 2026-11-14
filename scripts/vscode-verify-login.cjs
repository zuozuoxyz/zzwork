// 验证登录相关元素是否已隐藏
const http = require('http');
function getJson(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9333,path,timeout:3000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
(async()=>{
  const list = await getJson('/json/list');
  const page = list.find(t=>t.title.includes('zzwork')) || list.find(t=>t.type==='page');
  if(!page){console.log('no page');process.exit(1);}
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const wait={};
  const call=(method,params={})=>new Promise(r=>{const i=++id;wait[i]=r;ws.send(JSON.stringify({id:i,method,params}));});
  ws.addEventListener('message',ev=>{const d=JSON.parse(ev.data);if(d.id&&wait[d.id]){wait[d.id](d.result);delete wait[d.id];}});
  ws.addEventListener('open',async()=>{
    const q = async (expr) => (await call('Runtime.evaluate',{expression:expr,returnByValue:true})).result.value;
    const visible = await q(`(() => {
      const sels = [
        ['SignIn-button', 'li.action-item:has(> a.action-label[aria-label="Sign In"])'],
        ['Accounts-icon', 'a.codicon-accounts-view-bar-icon'],
        ['AgentStatus', '.agent-status-container'],
      ];
      const out = [];
      for (const [name, sel] of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
          out.push(name + ': display=' + cs.display + ' visible=' + (r.width>0||r.height>0));
        }
      }
      const style = document.getElementById('zzwork-no-login');
      out.push('style-patch-present: ' + !!style);
      return out.length ? out.join(' | ') : 'none-found';
    })()`);
    console.log('RESULT:', visible);
    ws.close(); process.exit(0);
  });
  setTimeout(()=>{console.log('TIMEOUT');process.exit(1);},15000);
})().catch(e=>{console.error(e.message);process.exit(1);});
