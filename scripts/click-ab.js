const http = require('http')
const label = process.argv[2]
function getJson(p){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9333,path:p,timeout:3000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej)})}
;(async()=>{
  const list=await getJson('/json/list'); const page=list.find(t=>t.type==='page')
  const ws=new WebSocket(page.webSocketDebuggerUrl); let id=0; const wait={}
  const call=(m,p={})=>new Promise(r=>{const i=++id;wait[i]=r;ws.send(JSON.stringify({id:i,method:m,params:p}))})
  ws.addEventListener('message',ev=>{const d=JSON.parse(ev.data);if(d.id&&wait[d.id]){wait[d.id](d.result);delete wait[d.id]}})
  ws.addEventListener('open',async()=>{
    const pos=(await call('Runtime.evaluate',{expression:`(()=>{const a=Array.from(document.querySelectorAll('.activitybar a')).find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});if(!a)return null;const r=a.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`,returnByValue:true})).result.value
    if(!pos){console.log('not found');ws.close();process.exit(1)}
    const p=JSON.parse(pos)
    await call('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1})
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1})
    await new Promise(r=>setTimeout(r,2500))
    const txt=(await call('Runtime.evaluate',{expression:`(document.querySelector('.part.sidebar')||{}).innerText||''`,returnByValue:true})).result.value
    console.log(String(txt).slice(0,400).replace(/\n/g,' | '))
    ws.close();process.exit(0)
  })
  setTimeout(()=>process.exit(1),20000)
})().catch(e=>{console.error(e.message);process.exit(1)})
