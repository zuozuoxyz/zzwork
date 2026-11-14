// 点击活动栏 zzwork 图标，读取项目树内容
const http = require('http');
function getJson(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9333,path,timeout:3000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
(async()=>{
  const list = await getJson('/json/list');
  const page = list.find(t=>t.title.includes('zzwork')) || list.find(t=>t.type==='page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const wait={};
  const call=(method,params={})=>new Promise(r=>{const i=++id;wait[i]=r;ws.send(JSON.stringify({id:i,method,params}));});
  ws.addEventListener('message',ev=>{const d=JSON.parse(ev.data);if(d.id&&wait[d.id]){wait[d.id](d.result);delete wait[d.id];}});
  ws.addEventListener('open',async()=>{
    const q = async (expr) => (await call('Runtime.evaluate',{expression:expr,returnByValue:true})).result.value;
    const rect = await q(`(() => {
      const a = Array.from(document.querySelectorAll('.activitybar li a')).find(x => (x.getAttribute('aria-label')||'').includes('zzwork'));
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2});
    })()`);
    if (!rect) { console.log('zzwork icon not found'); ws.close(); process.exit(1); }
    const {x,y} = JSON.parse(rect);
    await call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,2000));
    const sidebar = await q(`(() => {
      const sb = document.querySelector('.part.sidebar');
      if (!sb) return 'no-sidebar';
      const rows = Array.from(sb.querySelectorAll('.monaco-list-row, .pane-header, .section-header')).map(e => (e.textContent||'').trim().replace(/\s+/g,' ').slice(0,60)).filter(Boolean);
      return rows.slice(0,40).join(' | ') || ('sidebar-empty; visible text: ' + (sb.innerText||'').slice(0,300));
    })()`);
    console.log('SIDEBAR:', sidebar);
    ws.close(); process.exit(0);
  });
  setTimeout(()=>{console.log('TIMEOUT');process.exit(1);},20000);
})().catch(e=>{console.error(e.message);process.exit(1);});
