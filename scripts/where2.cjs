const http = require('http');
const fs = require('fs');
function getJson(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9333,path,timeout:3000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
(async()=>{
  const list = await getJson('/json/list');
  const page = list.find(t=>t.type==='page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const wait={};
  const call=(method,params={})=>new Promise(r=>{const i=++id;wait[i]=r;ws.send(JSON.stringify({id:i,method,params}));});
  ws.addEventListener('message',ev=>{const d=JSON.parse(ev.data);if(d.id&&wait[d.id]){wait[d.id](d.result);delete wait[d.id];}});
  ws.addEventListener('open',async()=>{
    const expr = `(() => {
      const out = [];
      const find = (root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const t = walker.currentNode.textContent;
          if (t && t.trim() === '任务详情') {
            let el = walker.currentNode.parentElement, chain = [];
            for (let i=0; el && i<9; i++) { chain.push(el.id ? '#'+el.id : '.'+el.className.toString().split(' ').slice(0,2).join('.')); el = el.parentElement; }
            out.push(chain.join('\n  <- '));
          }
        }
      };
      find(document.getElementById('workbench.parts.auxiliarybar') || document.body);
      find(document.getElementById('workbench.parts.sidebar') || document.body);
      return out.join('\n---\n') || 'not-found';
    })()`;
    const r = await call('Runtime.evaluate',{expression:expr,returnByValue:true});
    console.log(r.exceptionDetails ? 'EXC' : r.result.value);
    ws.close(); process.exit(0);
  });
  setTimeout(()=>process.exit(1),12000);
})().catch(e=>{console.error(e.message);process.exit(1);});
