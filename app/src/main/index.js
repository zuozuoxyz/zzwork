const { app, BrowserWindow, shell, protocol } = require('electron')
const path = require('path')
const fs = require('fs')
const { registerAll } = require('./ipc')

// HTML 预览：任务内文件经自定义标准协议加载，相对资源（css/js/图片）可正常解析
protocol.registerSchemesAsPrivileged([
  { scheme: 'zzwork-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

app.setName('zzwork')
// 固定 AUMID：与 electron-builder 的 appId 一致，避免开发态任务栏回退成 Electron 默认图标
if (process.platform === 'win32') { try { app.setAppUserModelId('com.zzwork.app') } catch {} }

// 开发态走 src/renderer/public，打包后走 out/renderer（electron-vite 会复制 public）
// Windows 任务栏/窗口图标优先用 .ico，缩放更清晰
const ICON_PNG = [
  path.join(__dirname, '../renderer/icon.png'),
  path.join(__dirname, '../../src/renderer/public/icon.png')
].find((p) => fs.existsSync(p))
const ICON_ICO = [
  path.join(__dirname, '../renderer/icon.ico'),
  path.join(__dirname, '../../build/icon.ico')
].find((p) => fs.existsSync(p))
const APP_ICON = (process.platform === 'win32' && ICON_ICO) ? ICON_ICO : ICON_PNG

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let win = null

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  function createWindow() {
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      show: false,
      backgroundColor: '#17181c',
      icon: APP_ICON,
      autoHideMenuBar: true,
      // 参考 VS Code：Windows/macOS 隐藏系统标题栏，窗口按钮用原生 overlay 画在自绘标题栏右侧。
      // Linux 不支持 titleBarOverlay，若仍隐藏标题栏会失去关闭/最小化按钮，故保留系统原生标题栏。
      ...(process.platform === 'linux'
        ? {}
        : {
            titleBarStyle: 'hidden',
            titleBarOverlay: { color: '#191a1b', symbolColor: '#c8cdd2', height: 30 }
          }),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    win.once('ready-to-show', () => win.show())
    win.once('closed', () => {
      try { require('./services/terminal').killAll() } catch {}
      win = null
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
    // 拦截主窗口被页面内链接改导航：外部链接交给系统浏览器，其余一律阻止，
    // 避免 AI 对话里的链接（如 html 链接）把整个应用导航走、覆盖界面导致无法操作
    win.webContents.on('will-navigate', (e, url) => {
      const devUrl = process.env.ELECTRON_RENDERER_URL
      if (devUrl && url.startsWith(devUrl)) return
      e.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'))
    }
  }

  app.whenReady().then(() => {
    registerAll(require('electron').ipcMain, () => win)
    createWindow()
    // 看板中被强制退出而中断的「进行中」卡片，启动后自动续跑
    try {
      require('./services/board').resumeAll().catch((e) => console.error('[zzwork] 看板自动恢复失败：' + e.message))
    } catch (e) { console.error('[zzwork] 看板自动恢复异常：' + e.message) }
    // 已启用的任务分享：启动后在后台起 HTTP 服务（自带隧道由用户另行暴露）
    try {
      require('./services/share').startAll().catch((e) => console.error('[zzwork] 分享服务启动失败：' + e.message))
    } catch (e) { console.error('[zzwork] 分享服务启动异常：' + e.message) }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    try { require('./services/terminal').killAll() } catch {}
    try { require('./services/lsp').disposeAll() } catch {}
    try { require('./services/share').stopAll() } catch {}
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
