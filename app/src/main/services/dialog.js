// 系统对话框（替代 VS Code 的 QuickPick/InputBox 之外的路径选择类交互）
const { dialog, BrowserWindow } = require('electron')

function win() {
  return BrowserWindow.getAllWindows()[0]
}

// 回归测试用：无法用 CDP 操作原生对话框，由测试进程通过环境变量注入结果
const testPickDir = () => process.env.ZZWORK_TEST_PICK_DIR || null
const testPickFile = () => process.env.ZZWORK_TEST_PICK_FILE || null

module.exports = {
  register(ipcMain) {
    ipcMain.handle('zz:dialog:openDirectory', async () => {
      if (testPickDir()) return testPickDir()
      const r = await dialog.showOpenDialog(win(), { properties: ['openDirectory', 'createDirectory'] })
      return r.canceled ? null : r.filePaths[0]
    })
    ipcMain.handle('zz:dialog:openFile', async () => {
      if (testPickFile()) return testPickFile()
      const r = await dialog.showOpenDialog(win(), { properties: ['openFile'] })
      return r.canceled ? null : r.filePaths[0]
    })
    ipcMain.handle('zz:dialog:saveFile', async (_e, p) => {
      const r = await dialog.showSaveDialog(win(), p && p.defaultPath ? { defaultPath: p.defaultPath } : {})
      return r.canceled ? null : r.filePath
    })
    ipcMain.handle('zz:dialog:confirm', async (_e, p) => {
      if (process.env.ZZWORK_TEST_AUTOCONFIRM === '1') return true
      const r = await dialog.showMessageBox(win(), {
        type: 'warning', buttons: ['取消', '确定'], defaultId: 1, cancelId: 0,
        message: p.message, detail: p.detail || ''
      })
      return r.response === 1
    })
  }
}
