// 更新入口：标题栏终端按钮左侧的升级按钮，有新版本时才显示
import { updateapi, onUpdateEvent } from './lib/api.js'
import { $ } from './lib/ui.js'
import { toast } from './components/toast.js'

let info = null
let busy = false

function render(text) {
  const b = $('#updateBtn')
  if (!b) return
  const show = !!(info && info.hasUpdate)
  b.hidden = !show
  b.disabled = busy
  b.classList.toggle('busy', busy)
  if (text) b.title = text
  else if (show) b.title = `发现新版本 ${info.latest}，点击一键升级`
}

export function initUpdate() {
  const b = $('#updateBtn')
  if (!b) return

  b.addEventListener('click', async () => {
    if (busy || !info || !info.hasUpdate) return
    busy = true
    render(`正在升级到 ${info.latest}…`)
    toast(`正在下载 ${info.latest}…`)
    let r = null
    try { r = await updateapi('install') } catch (e) { r = { ok: false, reason: 'error', message: String((e && e.message) || e) } }
    if (r && r.ok) return
    busy = false
    render()
    const reason = (r && r.reason) || 'error'
    if (reason === 'linux') { toast((r && r.message) || '已打开下载页，请手动下载新版', 'info', 6000); return }
    const msg = reason === 'dev' ? '开发模式不支持自动安装'
      : reason === 'latest' ? '当前已是最新版本'
        : reason === 'busy' ? '正在升级中…'
          : (r && r.message) || '升级失败'
    toast(msg, 'err', 5000)
  })

  onUpdateEvent((ev) => {
    if (!ev || !ev.type) return
    if (ev.type === 'status') {
      info = ev
      if (!busy) render()
      const st = $('#stVersion')
      if (st && ev.current) st.textContent = 'zzwork ' + ev.current
    } else if (ev.type === 'progress') {
      if (info && info.hasUpdate) render(`正在下载 ${info.latest} ${ev.percent || 0}%`)
    } else if (ev.type === 'installing') {
      busy = true
      render(`正在安装 ${info ? info.latest : ''}…`)
      toast(`已下载 ${info ? info.latest : '新版本'}，正在打开安装程序，按提示完成即可（完成后会自动重启）`, 'info', 10000)
    } else if (ev.type === 'manual') {
      busy = false
      render()
      toast(`已下载 ${ev.version ? 'v' + ev.version : '安装包'}，请在打开的安装包中完成升级`)
    } else if (ev.type === 'error') {
      busy = false
      render()
      toast(ev.message || '升级失败', 'err', 5000)
    }
  })

  // 先用本地版本填状态栏，随后异步检查 GitHub（失败静默，不打扰使用）
  updateapi('version').then((v) => {
    const st = $('#stVersion')
    if (st && v) st.textContent = 'zzwork ' + v
  }).catch(() => {})
  updateapi('check').catch(() => {})
  // 长时间挂着也能发现新版本
  setInterval(() => { updateapi('check').catch(() => {}) }, 6 * 3600 * 1000)
}
