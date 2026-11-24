// 任务文件读写助手：本地 / WSL(UNC) / SSH 统一入口，chat 与 featuremap 共用
const fs = require('fs')
const path = require('path')
const { parseRemotePath } = require('../../core/envs')
const remotefs = require('./remotefs')

// 任务内路径拼接：ssh:// 用 POSIX 分隔符，其余用本地 path
function taskJoin(base, ...segs) {
  const r = parseRemotePath(base)
  if (r) return 'ssh://' + r.envId + '/' + [r.remotePath.replace(/^\/+|\/+$/g, ''), ...segs].filter(Boolean).join('/')
  return path.join(base, ...segs)
}

async function readTextFile(file, limit = 4000) {
  const r = parseRemotePath(file)
  if (r) {
    const raw = await remotefs.readFile(r.envId, r.remotePath).catch(() => '')
    return raw.length > limit ? raw.slice(0, limit) : raw
  }
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return ''
    const raw = fs.readFileSync(file, 'utf8')
    return raw.length > limit ? raw.slice(0, limit) : raw
  } catch { return '' }
}

async function writeTaskTextFile(file, content) {
  const r = parseRemotePath(file)
  if (r) return remotefs.writeFile(r.envId, r.remotePath, content)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

// 列目录（本地 / 远程统一）：过滤 .zzwork/.git，目录优先。返回 [{ name, path, dir }]
async function listTaskDir(dir) {
  const r = parseRemotePath(dir)
  if (r) {
    const list = await remotefs.readDir(r.envId, r.remotePath).catch(() => [])
    return list.filter((x) => x.name !== '.zzwork' && x.name !== '.git')
  }
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.name !== '.zzwork' && d.name !== '.git')
  names.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
  return names.slice(0, 200).map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
}

module.exports = { taskJoin, readTextFile, writeTaskTextFile, listTaskDir }
