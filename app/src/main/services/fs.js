// 任务目录文件操作：所有写操作必须落在某个任务根目录内
const fs = require('fs')
const path = require('path')
const { shell } = require('electron')
const { taskRoots } = require('./store')
const remotefs = require('./remotefs')
const { parseRemotePath } = require('../../core/envs')

function insideTaskRoot(target) {
  const abs = path.resolve(target)
  const lower = abs.toLowerCase()
  return taskRoots().some((root) => {
    const r = path.resolve(root || '').toLowerCase()
    return r && (lower === r || lower.startsWith(r + path.sep))
  })
}

function assertInside(target) {
  if (!insideTaskRoot(target)) throw new Error('路径不在任务目录内: ' + target)
  return path.resolve(target)
}

// 远程路径（ssh://）前缀必须落在某个远程任务根内
function assertRemoteInside(target) {
  const rp = parseRemotePath(target)
  if (!rp) return null
  const t = String(target)
  const roots = taskRoots().filter((r) => /^ssh:\/\//i.test(String(r)))
  const hit = roots.find((r) => t === r || t.startsWith(r.replace(/\/+$/, '') + '/'))
  if (!hit) throw new Error('路径不在任务目录内: ' + target)
  return rp
}

function readDir(dir) {
  const abs = assertInside(dir)
  const names = fs.readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.name !== '.zztask' && d.name !== '.git')
  names.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
  return names.slice(0, 200).map((d) => ({ name: d.name, path: path.join(abs, d.name), dir: d.isDirectory() }))
}

// 目录选择器用：只列出子目录，允许任意绝对路径（只读，不参与写操作校验）
async function browseDirs(dir) {
  const r = parseRemotePath(dir)
  if (r) {
    const list = await remotefs.readDir(r.envId, r.remotePath)
    return list.filter((x) => x.dir)
  }
  const abs = path.resolve(dir)
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '.git')
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries.slice(0, 500).map((d) => ({ name: d.name, path: path.join(abs, d.name), dir: true }))
}

// 只读打开任务目录外的文件（如「转到定义」跳进的库文件）：不走 assertInside，但仅读、不提供越界写
function readFileExternal(target) {
  const r = parseRemotePath(target)
  if (r) return remotefs.readFile(r.envId, r.remotePath)
  const abs = path.resolve(String(target))
  const st = fs.statSync(abs)
  if (st.isDirectory()) throw new Error('目标是目录，无法作为文件打开')
  if (st.size > 20 * 1024 * 1024) throw new Error('文件超过 20MB，已取消打开')
  return fs.readFileSync(abs, 'utf8')
}

// 写二进制图片（dataURL → 文件）：本地直接写；远程经 SFTP。落点必须落在任务根内
async function writeBase64File(target, dataUrl) {
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(String(dataUrl || ''))
  if (!m) throw new Error('无效的图片数据')
  const mime = m[1].toLowerCase()
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime]
  if (!ext) throw new Error('不支持的图片类型')
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > 8 * 1024 * 1024) throw new Error('图片超过 8MB')
  const r = assertRemoteInside(target)
  if (r) { await remotefs.writeBase64(r.envId, r.remotePath, buf.toString('base64')); return { size: buf.length } }
  const abs = assertInside(target)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buf)
  return { size: buf.length }
}

module.exports = {
  readDir,
  readFileExternal,
  writeBase64File,
  register(ipcMain) {
    ipcMain.handle('zz:fs:readDir', (_e, p) => {
      const r = parseRemotePath(p.path)
      if (r) return remotefs.readDir(r.envId, r.remotePath)
      return readDir(p.path)
    })
    ipcMain.handle('zz:fs:browse', (_e, p) => browseDirs(p.path))
    ipcMain.handle('zz:fs:readFile', (_e, p) => {
      const r = parseRemotePath(p.path)
      if (r) return remotefs.readFile(r.envId, r.remotePath)
      const abs = assertInside(p.path)
      const st = fs.statSync(abs)
      if (st.size > 20 * 1024 * 1024) throw new Error('文件超过 20MB，已取消打开')
      return fs.readFileSync(abs, 'utf8')
    })
    const MIME_BY_EXT = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
    }
    ipcMain.handle('zz:fs:readFileExternal', (_e, p) => readFileExternal(p.path))
    ipcMain.handle('zz:fs:readBase64', (_e, p) => {
      if (parseRemotePath(p.path)) throw new Error('远程图片暂不支持预览')
      const abs = assertInside(p.path)
      const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()]
      if (!mime) throw new Error('不是可预览的图片文件')
      const st = fs.statSync(abs)
      if (st.size > 8 * 1024 * 1024) throw new Error('图片超过 8MB')
      const buf = fs.readFileSync(abs)
      return { dataUrl: `data:${mime};base64,` + buf.toString('base64'), size: st.size }
    })
    ipcMain.handle('zz:fs:writeBase64', (_e, p) => writeBase64File(p.path, p.dataUrl))
    ipcMain.handle('zz:fs:writeFile', (_e, p) => {
      const r = assertRemoteInside(p.path)
      if (r) return remotefs.writeFile(r.envId, r.remotePath, p.content)
      const abs = assertInside(p.path)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, p.content, 'utf8')
      return true
    })
    ipcMain.handle('zz:fs:mkdir', (_e, p) => {
      const r = assertRemoteInside(p.path)
      if (r) return remotefs.mkdir(r.envId, r.remotePath)
      const abs = assertInside(p.path)
      fs.mkdirSync(abs, { recursive: true })
      return true
    })
    ipcMain.handle('zz:fs:rename', (_e, p) => {
      const rf = assertRemoteInside(p.from)
      if (rf) {
        const rt = assertRemoteInside(p.to)
        return remotefs.rename(rf.envId, rf.remotePath, rt.remotePath)
      }
      const from = assertInside(p.from)
      const to = assertInside(p.to)
      fs.renameSync(from, to)
      return true
    })
    ipcMain.handle('zz:fs:delete', (_e, p) => {
      const r = assertRemoteInside(p.path)
      if (r) return remotefs.remove(r.envId, r.remotePath)
      const abs = assertInside(p.path)
      fs.rmSync(abs, { recursive: true, force: true })
      return true
    })
    ipcMain.handle('zz:fs:stat', (_e, p) => {
      const r = parseRemotePath(p.path)
      if (r) return remotefs.stat(r.envId, r.remotePath)
      const abs = assertInside(p.path)
      const st = fs.statSync(abs)
      return { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() }
    })
    ipcMain.handle('zz:fs:exists', (_e, p) => {
      const r = parseRemotePath(p.path)
      if (r) return remotefs.exists(r.envId, r.remotePath)
      try { return fs.existsSync(p.path) } catch { return false }
    })
    ipcMain.handle('zz:fs:reveal', (_e, p) => {
      if (parseRemotePath(p.path)) throw new Error('远程文件不支持在本地资源管理器中显示')
      shell.showItemInFolder(path.resolve(p.path))
      return true
    })
    ipcMain.handle('zz:fs:openPath', (_e, p) => {
      if (parseRemotePath(p.path)) throw new Error('远程目录不支持在本地打开')
      return shell.openPath(path.resolve(p.path))
    })
  }
}
