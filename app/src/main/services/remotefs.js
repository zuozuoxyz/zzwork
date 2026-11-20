// 远程文件操作：ssh://<envId>/<path> 通过 ssh2 SFTP 读写（支持密码/密钥/agent）
const secrets = require('./secrets')
const { getStore } = require('./store')
const { connect } = require('../../core/sshconn')

const conns = new Map() // envId -> Promise<{ client, sftp }>

function sftpEnv(envId) {
  const e = (getStore().listEnvironments() || []).find((x) => x.id === envId)
  if (!e || e.kind !== 'ssh') throw new Error('远程环境不存在：' + envId)
  const c = e.config || {}
  return { id: envId, kind: 'ssh', host: c.host, user: c.user, port: c.port, config: c, secret: secrets.get('zzwork.ssh.' + envId) || '' }
}

function openSftp(envId) {
  let p = conns.get(envId)
  if (p) return p
  const env = sftpEnv(envId)
  p = connect(env, env.secret).then((client) => new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) { try { client.end() } catch {}; reject(err); return }
      const drop = () => { if (conns.get(envId) === p) conns.delete(envId) }
      client.on('close', drop)
      client.on('error', drop)
      resolve({ client, sftp })
    })
  })).catch((e) => { conns.delete(envId); throw e })
  conns.set(envId, p)
  return p
}

function call(envId, fn) {
  return openSftp(envId).then(({ sftp }) => fn(sftp)).catch((e) => { conns.delete(envId); throw e })
}

const op = (sftp, m, ...a) => new Promise((res, rej) => sftp[m](...a, (err, r) => (err ? rej(err) : res(r))))

function joinRemote(dir, name) {
  const d = String(dir || '/').replace(/\/+$/, '')
  return (d || '') + '/' + name
}

async function ensureDir(sftp, dir) {
  const parts = String(dir || '/').split('/').filter(Boolean)
  let cur = ''
  for (const seg of parts) {
    cur += '/' + seg
    await new Promise((res) => sftp.mkdir(cur, () => res())) // 已存在则忽略
  }
}

function kindError(e) {
  const msg = String((e && (e.message || e.code)) || e)
  if (/no such file|ENOENT|2:/i.test(msg)) return '文件不存在'
  if (/permission denied|EACCES|3:/i.test(msg)) return '权限不足'
  return '远程文件操作失败：' + msg
}

async function readDir(envId, dir) {
  const list = await call(envId, (s) => op(s, 'readdir', dir))
  const items = list.filter((d) => d.filename !== '.zztask' && d.filename !== '.git')
  items.sort((a, b) => (b.attrs.isDirectory() - a.attrs.isDirectory()) || a.filename.localeCompare(b.filename))
  // 返回 ssh:// 前缀，保证子项路径能再次被 fs 层识别并路由回远程
  return items.slice(0, 200).map((d) => ({ name: d.filename, path: 'ssh://' + envId + joinRemote(dir, d.filename), dir: d.attrs.isDirectory() }))
}

async function stat(envId, target) {
  const st = await call(envId, (s) => op(s, 'stat', target))
  return { size: st.size || 0, mtime: (st.mtime || 0) * 1000, dir: st.isDirectory() }
}

async function readFile(envId, target) {
  const st = await stat(envId, target)
  if (st.dir) throw new Error('目标是目录，无法作为文件打开')
  if (st.size > 20 * 1024 * 1024) throw new Error('文件超过 20MB，已取消打开')
  const buf = await call(envId, (s) => op(s, 'readFile', target))
  return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
}

async function writeFile(envId, target, content) {
  const dir = target.replace(/\/[^/]*$/, '') || '/'
  await call(envId, async (s) => { await ensureDir(s, dir); return op(s, 'writeFile', target, String(content == null ? '' : content)) })
  return true
}

// 二进制写入（图片附件）：SFTP writeFile 接受 Buffer，勿转字符串
async function writeBase64(envId, target, base64) {
  const dir = target.replace(/\/[^/]*$/, '') || '/'
  const buf = Buffer.from(String(base64 || ''), 'base64')
  await call(envId, async (s) => { await ensureDir(s, dir); return op(s, 'writeFile', target, buf) })
  return true
}

async function mkdir(envId, target) {
  await call(envId, (s) => ensureDir(s, target))
  return true
}

async function rename(envId, from, to) {
  await call(envId, (s) => op(s, 'rename', from, to))
  return true
}

async function rmrf(sftp, target) {
  let st
  try { st = await op(sftp, 'stat', target) } catch { return }
  if (st.isDirectory()) {
    const list = await op(sftp, 'readdir', target)
    for (const d of list) await rmrf(sftp, joinRemote(target, d.filename))
    await new Promise((res) => sftp.rmdir(target, () => res()))
  } else {
    await new Promise((res) => sftp.unlink(target, () => res()))
  }
}

async function remove(envId, target) {
  await call(envId, (s) => rmrf(s, target))
  return true
}

async function exists(envId, target) {
  try { await call(envId, (s) => op(s, 'stat', target)); return true } catch { return false }
}

async function appendText(envId, target, text) {
  const dir = target.replace(/\/[^/]*$/, '') || '/'
  await call(envId, (s) => new Promise((res, rej) => {
    ensureDir(s, dir).then(() => {
      const ws = s.createWriteStream(target, { flags: 'a' })
      ws.on('close', res)
      ws.on('error', rej)
      ws.end(String(text == null ? '' : text))
    }, rej)
  }))
  return true
}

module.exports = { readDir, readFile, writeFile, writeBase64, appendText, stat, mkdir, rename, remove, exists, kindError, joinRemote }
