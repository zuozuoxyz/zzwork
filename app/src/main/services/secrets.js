// 密钥存储：safeStorage 加密后落盘 <userData>/secrets.json（默认即 %APPDATA%\zzwork\secrets.json）
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')

let cache = null

function filePath() {
  return path.join(app.getPath('userData'), 'secrets.json')
}

function load() {
  if (cache) return cache
  try { cache = JSON.parse(fs.readFileSync(filePath(), 'utf8')) } catch { cache = {} }
  return cache
}

function save() {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true })
    fs.writeFileSync(filePath(), JSON.stringify(cache || {}, null, 2))
  } catch (e) { console.error('[zzwork] secrets 保存失败: ' + e.message) }
}

function encrypt(value) {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(value).toString('base64')
  return 'plain:' + Buffer.from(value, 'utf8').toString('base64')
}

function decrypt(stored) {
  if (typeof stored !== 'string') return null
  try {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8')
    return stored
  } catch { return null }
}

module.exports = {
  get(key) {
    const raw = load()[key]
    return raw ? decrypt(raw) : null
  },
  set(key, value) {
    load()[key] = encrypt(value)
    save()
  },
  has(key) {
    return !!load()[key]
  },
  delete(key) {
    delete load()[key]
    save()
  },
  register(ipcMain) {
    ipcMain.handle('zz:secrets:get', (_e, p) => module.exports.get(p.key))
    ipcMain.handle('zz:secrets:set', (_e, p) => module.exports.set(p.key, p.value))
    ipcMain.handle('zz:secrets:has', (_e, p) => module.exports.has(p.key))
    ipcMain.handle('zz:secrets:delete', (_e, p) => module.exports.delete(p.key))
    ipcMain.handle('zz:secrets:available', () => safeStorage.isEncryptionAvailable())
  }
}
