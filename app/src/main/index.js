const { app, BrowserWindow, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { registerAll } = require('./ipc')

app.setName('zzwork')

// 开发态走 src/renderer/public，打包后走 out/renderer（electron-vite 会复制 public）
const APP_ICON = [
  path.join(__dirname, '../renderer/icon.png'),
  path.join(__dirname, '../../src/renderer/public/icon.png')
].find((p) => fs.existsSync(p))

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
      // 参考 VS Code：隐藏系统标题栏，窗口按钮用原生 overlay 画在自绘标题栏右侧
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#191a1b', symbolColor: '#c8cdd2', height: 30 },
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
    if (process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'))
    }
  }

  app.whenReady().then(() => {
    registerAll(require('electron').ipcMain, () => win)
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    try { require('./services/terminal').killAll() } catch {}
    try { require('./services/lsp').disposeAll() } catch {}
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
