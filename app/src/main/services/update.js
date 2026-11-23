// 版本更新：查 GitHub 最新 Release → 下载安装包 → 静默升级并重启
// 用 releases/latest 的跳转地址取版本号，避开 GitHub API 的匿名频率限制
const { app, net, shell, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

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
      res.pipe(out)
      out.on('error', fail)
      out.on('finish', () => {
        if (done) return
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

function installWin(setup) {
  // 便携版运行时 execPath 在临时目录，安装后改从默认安装位置拉起
  const tempRoot = path.join(app.getPath('temp'), 'zzwork-update')
  const installed = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'zzwork', 'zzwork.exe')
  const fromTemp = process.execPath.toLowerCase().startsWith(tempRoot.toLowerCase())
  const relaunch = fromTemp && fs.existsSync(installed) ? installed : process.execPath
  const q = (s) => String(s).replace(/'/g, "''")
  // 由独立进程等待静默安装结束再拉起新版本，避免本进程退出后无人重启
  const ps = `Start-Process -FilePath '${q(setup)}' -ArgumentList '/S' -Wait; Start-Sleep -Milliseconds 1500; Start-Process -FilePath '${q(relaunch)}'`
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
    detached: true, stdio: 'ignore', windowsHide: true
  }).unref()
  setTimeout(() => app.quit(), 400)
}

async function install() {
  if (downloading) return { ok: false, reason: 'busy' }
  if (!info || !info.hasUpdate) return { ok: false, reason: 'latest' }
  if (!app.isPackaged) return { ok: false, reason: 'dev' }
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
    installWin(file)
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
