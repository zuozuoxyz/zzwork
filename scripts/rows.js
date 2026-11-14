const http = require('http')
function getJson(p){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9333,path:p,timeout:3000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej)})}
;(async()=>{
  const list=await getJson('/json/list'); const page=list.find(t=>t.type==='page')
  const ws=new WebSocket(page.webSocketDebuggerUrl); let id=0; const wait={}
  const call=(m,p={})=>new Promise(r=>{const i=++id;wait[i]=r;ws.send(JSON.stringify({id:i,method:m,params:p}))})
  ws.addEventListener('message',ev=>{const d=JSON.parse(ev.data);if(d.id&&wait[d.id]){wait[d.id](d.result);delete wait[d.id]}})
  ws.addEventListener('open',async()=>{
    const r=await call('Runtime.evaluate',{expression:`JSON.stringify(Array.from(document.querySelectorAll('.part.sidebar .monaco-list-row')).map((e,i)=>({i,txt:(e.textContent||'').trim().slice(0,40),y:e.getBoundingClientRect().y})))`,returnByValue:true})
    console.log(r.result.value)
    ws.close();process.exit(0)
  })
  setTimeout(()=>process.exit(1),12000)
})().catch(e=>{console.error(e.message);process.exit(1)})
