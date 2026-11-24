// IPC 总注册：各服务挂到 zz:<domain>:<method> 频道
const store = require('../services/store')
const secrets = require('../services/secrets')
const dialog = require('../services/dialog')
const fsService = require('../services/fs')
const env = require('../services/env')
const mcp = require('../services/mcp')
const chat = require('../services/chat')
const inbox = require('../services/inbox')
const board = require('../services/board')
const terminal = require('../services/terminal')
const lsp = require('../services/lsp')
const featuremap = require('../services/featuremap')
const update = require('../services/update')
const share = require('../services/share')
const { clipboard, nativeImage, protocol } = require('electron')

function registerAll(ipcMain, getWin) {
  store.register(ipcMain)
  secrets.register(ipcMain)
  dialog.register(ipcMain)
  fsService.register(ipcMain)
  fsService.registerProtocol(protocol)
  env.register(ipcMain)
  mcp.register(ipcMain)
  chat.register(ipcMain, getWin)
  inbox.register(ipcMain)
  board.register(ipcMain)
  terminal.register(ipcMain, getWin)
  lsp.register(ipcMain)
  featuremap.register(ipcMain)
  update.register(ipcMain)
  share.register(ipcMain)
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
