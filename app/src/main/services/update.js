// 版本更新：查 GitHub 最新 Release → 下载安装包 → 交给系统 shell 启动安装程序（安装后自动拉起新版本）
// 用 releases/latest 的跳转地址取版本号，避开 GitHub API 的匿名频率限制
const { app, net, shell, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const REPO = 'zuozuoxyz/zzwork'
const LATEST_URL = `https://github.com/${REPO}/releases/latest`
const CHECK_TIMEOUT = 7000

let info = null
let seq = 0
let downloading = false
let percent = 0

function broadcast(payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('zz:update:event', payload)
  }
}

function parseVersion(s) {
  const m = String(s || '').match(/(\d+(?:\.\d+)*)/)
  return m ? m[1] : ''
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

function fetchLatestTag() {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err, tag) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { req.abort() } catch {}
      if (err) reject(err)
      else resolve(tag)
    }
    const req = net.request({ method: 'GET', url: LATEST_URL, redirect: 'manual' })
    const timer = setTimeout(() => finish(new Error('检查更新超时')), CHECK_TIMEOUT)
    req.on('redirect', (_status, _method, url) => {
      const m = String(url || '').match(/\/releases\/tag\/([^/?#]+)/i)
      finish(null, m ? decodeURIComponent(m[1]) : '')
    })
    req.on('response', (res) => {
      // 没有跳转说明还没有 Release
      res.on('data', () => {})
      res.on('end', () => finish(null, ''))
      res.on('error', (e) => finish(e))
    })
    req.on('error', (e) => finish(e))
    req.end()
  })
}

// payload.latest 仅供回归测试注入版本，正常调用不带参数
async function check(payload) {
  const current = app.getVersion()
  const my = ++seq
  let tag = payload && payload.latest ? String(payload.latest) : ''
  let error = ''
  if (!tag) {
    try { tag = await fetchLatestTag() } catch (e) { error = String((e && e.message) || e) }
  }
  const version = parseVersion(tag)
  const res = {
    current,
    latest: version ? 'v' + version : '',
    version,
    hasUpdate: !!version && !error && cmpVersion(version, current) > 0,
    error
  }
  if (my === seq) {
    info = res
    broadcast({ type: 'status', ...res })
  }
  return res
}

function assetName(version) {
  if (process.platform === 'win32') return `zzwork-${version}-setup.exe`
  if (process.platform === 'linux') return `zzwork-${version}.AppImage`
  return `zzwork-${version}-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url })
    req.setHeader('User-Agent', 'zzwork-updater')
    let last = -1
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('HTTP ' + res.statusCode))
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      let done = false
      const out = fs.createWriteStream(file)
      const fail = (e) => {
        if (done) return
        done = true
        out.destroy()
        reject(e)
      }
      res.on('data', (chunk) => {
        received += chunk.length
        if (!total) return
        const pct = Math.min(99, Math.floor((received * 100) / total))
        if (pct === last) return
        last = pct
        percent = pct
        broadcast({ type: 'progress', percent: pct, version: info && info.version })
      })
      res.on('error', fail)
      res.on('aborted', () => fail(new Error('下载中断')))
      res.pipe(out)
      out.on('error', fail)
      out.on('finish', () => {
        if (done) return
        // 连接中途断开时 content-length 与实际写入不符，避免把残缺安装包当成功
        if (total && received !== total) return fail(new Error(`安装包不完整（${received}/${total}）`))
        done = true
        out.close(() => {
          percent = 100
          broadcast({ type: 'progress', percent: 100, version: info && info.version })
          resolve()
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function installWin(setup) {
  // 关键：安装包必须由「不属于 zzwork 进程树」的方式启动。
  // 之前用 detached powershell 拉起安装包，但本进程退出时整棵子进程树会被回收，
  // 在 powershell 真正执行 Start-Process 之前就跟着退出（杀软拖慢 powershell 启动时更明显），
  // 表现就是「下载完自动关闭后什么都不发生」。改由系统 shell(ShellExecute) 启动安装包，
  // 让安装程序立刻、独立地跑起来，再退出本进程让出文件锁。
  // 安装器是 assisted 安装（electron-builder oneClick:false），安装完成后会自动拉起新版本。
  const err = await shell.openPath(setup).catch((e) => String((e && e.message) || e))
  if (err) {
    broadcast({ type: 'error', message: '启动安装程序失败：' + err })
    return false
  }
  // 先让安装窗口弹出，再退出以释放文件锁；避免「应用关了但安装器还没起来」的观感
  setTimeout(() => { try { app.quit() } catch {} }, 1200)
  return true
}

async function install() {
  if (downloading) return { ok: false, reason: 'busy' }
  if (!info || !info.hasUpdate) return { ok: false, reason: 'latest' }
  if (!app.isPackaged) return { ok: false, reason: 'dev' }
  // Linux 暂无稳定的自更新通道（AppImage 需手动替换）：打开 Release 页面由用户下载
  if (process.platform === 'linux') {
    try { await shell.openExternal(LATEST_URL) } catch {}
    return { ok: false, reason: 'linux', message: '已在浏览器打开下载页，请下载新版 AppImage 替换后重启' }
  }
  const version = info.version
  const asset = assetName(version)
  const url = `https://github.com/${REPO}/releases/download/v${version}/${asset}`
  const dir = path.join(app.getPath('temp'), 'zzwork-update', 'v' + version)
  const file = path.join(dir, asset)
  downloading = true
  percent = 0
  broadcast({ type: 'progress', percent: 0, version })
  try {
    fs.mkdirSync(dir, { recursive: true })
    await download(url, file)
  } catch (e) {
    downloading = false
    const message = '下载升级包失败：' + String((e && e.message) || e)
    broadcast({ type: 'error', message })
    return { ok: false, reason: 'download', message }
  }
  downloading = false
  if (process.platform === 'win32') {
    broadcast({ type: 'installing', version })
    const ok = await installWin(file)
    if (!ok) return { ok: false, reason: 'install', message: '启动安装程序失败' }
  } else {
    // macOS 未签名，无法静默替换：挂载 dmg 让用户拖入「应用程序」
    try { await shell.openPath(file) } catch {}
    broadcast({ type: 'manual', version, file })
  }
  return { ok: true, version }
}

module.exports = {
  register(ipcMain) {
    ipcMain.handle('zz:update:check', (_e, p) => check(p || {}))
    ipcMain.handle('zz:update:install', () => install())
    ipcMain.handle('zz:update:version', () => app.getVersion())
  }
}
