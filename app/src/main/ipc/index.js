// IPC 总注册：各服务挂到 zz:<domain>:<method> 频道
const store = require('../services/store')
const secrets = require('../services/secrets')
const dialog = require('../services/dialog')
const fsService = require('../services/fs')
const env = require('../services/env')
const mcp = require('../services/mcp')
const chat = require('../services/chat')
const inbox = require('../services/inbox')
const terminal = require('../services/terminal')
const lsp = require('../services/lsp')
const { clipboard, nativeImage } = require('electron')

function registerAll(ipcMain, getWin) {
  store.register(ipcMain)
  secrets.register(ipcMain)
  dialog.register(ipcMain)
  fsService.register(ipcMain)
  env.register(ipcMain)
  mcp.register(ipcMain)
  chat.register(ipcMain, getWin)
  inbox.register(ipcMain)
  terminal.register(ipcMain, getWin)
  lsp.register(ipcMain)
  // 复制聊天里的图片到系统剪贴板
  ipcMain.handle('zz:app:copyImage', (_e, p) => {
    const url = String((p && p.dataUrl) || '')
    if (!/^data:image\//.test(url)) return false
    const img = nativeImage.createFromDataURL(url)
    if (!img || img.isEmpty()) return false
    clipboard.writeImage(img)
    return true
  })
}

module.exports = { registerAll }
