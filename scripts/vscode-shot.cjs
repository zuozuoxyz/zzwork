// 截取 zzwork VS Code 窗口截图（CDP）
const { execSync } = require('child_process')
const fs = require('fs')
async function main() {
  const list = JSON.parse(execSync('curl -s http://127.0.0.1:9333/json/list', { shell: true, encoding: 'utf8' }))
  const page = list.find((t) => t.type === 'page' && t.title.includes('zzwork')) || list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const png = await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }))
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data)
        if (m.id === 1) {
          ws.close()
          m.result?.data ? resolve(Buffer.from(m.result.data, 'base64')) : reject(new Error('no data'))
        }
      } catch (e) { reject(e) }
    }
    ws.onerror = () => reject(new Error('ws error'))
    setTimeout(() => reject(new Error('timeout')), 15000)
  })
  fs.writeFileSync(process.argv[2], png)
  console.log('saved', (png.length / 1024).toFixed(0) + 'KB from', page.title)
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
