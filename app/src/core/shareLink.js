// 任务分享链接的纯工具：token 生成/校验、链接解析、路径越界判断。主进程两端共用，不依赖 electron。
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// 32 字节随机 → base64url（无填充），足够抗枚举
function makeToken() {
  return crypto.randomBytes(32).toString('base64url')
}

// 定长比较，避免计时侧信道；长度不同直接 false（timingSafeEqual 会抛）
function tokenEquals(a, b) {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  if (x.length !== y.length || x.length === 0) return false
  try { return crypto.timingSafeEqual(x, y) } catch { return false }
}

// 解析分享链接 <base>/s/<token> → { base, token }；base 保留隧道可能带的前缀
function parseShareLink(link) {
  const s = String(link || '').trim()
  if (!s) return null
  let u
  try { u = new URL(s) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const segs = u.pathname.split('/').filter(Boolean)
  if (segs.length < 2 || segs[segs.length - 2] !== 's') return null
  const token = segs[segs.length - 1]
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null
  const base = s.replace(/\/s\/[^/?#]+\/?$/, '').replace(/\/+$/, '')
  return { base, token }
}

// 目标是否在 root 之内（大小写归一，兼容 Windows）
function isInside(root, target) {
  const r = path.resolve(root)
  const t = path.resolve(target)
  const rl = r.toLowerCase(), tl = t.toLowerCase()
  return tl === rl || tl.startsWith(rl + path.sep)
}

// 把相对路径安全解析到 root 下；拒绝绝对路径、盘符、..、.zzwork/.git，realpath 后再校验（防符号链接逃逸）
function safeResolve(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(clean) || clean.startsWith('/')) throw new Error('不允许绝对路径')
  const segs = clean.split('/').filter((s) => s && s !== '.')
  if (segs.includes('..')) throw new Error('不允许 ..')
  if (segs.some((s) => s === '.zzwork' || s === '.git')) throw new Error('该目录不可访问')
  const abs = path.resolve(root, segs.join('/'))
  if (!isInside(root, abs)) throw new Error('路径越界')
  try {
    const realRoot = fs.realpathSync(root)
    const real = fs.realpathSync(abs)
    if (!isInside(realRoot, real)) throw new Error('路径越界')
    return real
  } catch (e) {
    if (/越界/.test(e.message)) throw e
    return abs // 目标尚不存在：返回未解析路径，由调用方按需报错
  }
}

// 日志/展示用：隐去 token
function redactUrl(link) {
  return String(link || '').replace(/(\/s\/)[A-Za-z0-9_-]+/, '$1***')
}

module.exports = { makeToken, tokenEquals, parseShareLink, isInside, safeResolve, redactUrl }
