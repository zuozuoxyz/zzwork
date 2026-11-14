// 查询 zzwork (VS Code fork) workbench DOM 中的登录相关元素
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
    console.log('TITLEBAR:', await q(`JSON.stringify(Array.from(document.querySelectorAll('.titlebar-center .action-item, .titlebar-right button, .titlebar-right a, .titlebar-right [role="button"]')).map(e=>({cls:(e.className||'').toString().slice(0,90),title:e.getAttribute('title')||'',aria:e.getAttribute('aria-label')||'',text:(e.textContent||'').trim().slice(0,30)})))`));
    console.log('ACTIVITYBAR:', await q(`JSON.stringify(Array.from(document.querySelectorAll('.activitybar li')).map(e=>({cls:(e.className||'').toString().slice(0,90),title:e.getAttribute('title')||'',aria:e.getAttribute('aria-label')||''})))`));
    console.log('SIGNIN:', await q(`JSON.stringify(Array.from(document.querySelectorAll('a,button,[role="button"]')).filter(e=>/sign in|登录|sync|备份|account/i.test((e.getAttribute('aria-label')||'')+(e.getAttribute('title')||'')+e.textContent)).slice(0,15).map(e=>({tag:e.tagName,cls:(e.className||'').toString().slice(0,110),aria:e.getAttribute('aria-label')||'',title:e.getAttribute('title')||'',text:(e.textContent||'').trim().slice(0,40)})))`));
    ws.close(); process.exit(0);
  });
  setTimeout(()=>{console.log('TIMEOUT');process.exit(1);},15000);
})().catch(e=>{console.error(e.message);process.exit(1);});
