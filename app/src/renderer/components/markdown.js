// Markdown 渲染 + 富内容增强（本地图片、文件链接、代码块工具条）
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'
import { esc, basename, joinPath } from '../lib/ui.js'
import { fsapi } from '../lib/api.js'
import { openFile } from '../workbench/editor.js'

marked.use({ gfm: true, breaks: true })

export function renderMarkdown(text) {
  const raw = marked.parse(String(text || ''))
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] })
}

export function highlightIn(el) {
  if (!el) return
  el.querySelectorAll('pre code').forEach((code) => {
    if (code.dataset.hl) return
    try { hljs.highlightElement(code); code.dataset.hl = '1' } catch {}
  })
}

const REMOTE_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i
function isRemoteUrl(u) { return !u || REMOTE_RE.test(u) }
function isAbsolutePath(p) { return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\') }
function resolveUnder(root, p) { return isAbsolutePath(p) ? p : joinPath(root, p) }

async function existingPath(root, target) {
  if (!target) return null
  const abs = resolveUnder(root, target)
  try {
    const exists = await fsapi('exists', { path: abs })
    return exists ? abs : null
  } catch { return null }
}

// 把一段 markdown 渲染结果“增强”：图片本地化、路径可点击、代码块加工具条。
// 需在元素插入 DOM 后调用；root = 任务目录，用于解析相对路径。
export function enhanceMarkdown(el, opts = {}) {
  if (!el) return
  const root = opts.root || ''

  el.querySelectorAll('img').forEach(async (img) => {
    const src = img.getAttribute('src') || ''
    if (!src) return
    img.classList.add('mdimg')
    if (isRemoteUrl(src)) {
      if (/^https?:/i.test(src)) img.setAttribute('loading', 'lazy')
      return
    }
    const abs = await existingPath(root, src)
    if (!abs) { img.classList.add('broken'); return }
    img.dataset.path = abs
    img.title = '点击放大'
    try {
      const data = await fsapi('readBase64', { path: abs })
      if (data && data.dataUrl) img.src = data.dataUrl
    } catch {}
  })

  el.querySelectorAll('a[href]').forEach(async (a) => {
    const href = a.getAttribute('href') || ''
    if (isRemoteUrl(href)) {
      if (/^https?:/i.test(href)) a.classList.add('extlink')
      return
    }
    const abs = await existingPath(root, href)
    if (!abs) return
    a.classList.add('filelink')
    a.dataset.path = abs
    a.removeAttribute('target')
  })

  // 行内代码里像路径的片段：存在则变成可点击
  el.querySelectorAll('code').forEach(async (c) => {
    if (c.closest('pre')) return
    const t = String(c.textContent || '').trim()
    if (!t || t.length > 200 || /\s/.test(t) || isRemoteUrl(t)) return
    if (!/[\\/.]/.test(t)) return
    const abs = await existingPath(root, t)
    if (!abs) return
    c.classList.add('filelink')
    c.dataset.path = abs
    c.title = '打开 ' + abs
  })

  el.querySelectorAll('pre').forEach((pre) => {
    if (pre.dataset.chrome) return
    pre.dataset.chrome = '1'
    const code = pre.querySelector('code')
    const m = code && String(code.className || '').match(/language-([\w+#.-]+)/)
    const wrap = document.createElement('div')
    wrap.className = 'codewrap'
    pre.parentNode.insertBefore(wrap, pre)
    wrap.appendChild(pre)
    const bar = document.createElement('div')
    bar.className = 'codebar'
    bar.innerHTML = `<span class="lang">${esc((m && m[1]) || 'code')}</span><button class="copybtn" type="button">复制</button>`
    wrap.insertBefore(bar, pre)
    const copy = bar.querySelector('.copybtn')
    copy.addEventListener('click', async (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      try {
        await navigator.clipboard.writeText(code ? code.textContent : pre.textContent)
        copy.textContent = '已复制'
        setTimeout(() => { copy.textContent = '复制' }, 1200)
      } catch {}
    })
  })
}

// 图片放大浮层：点击聊天里的图片全屏查看，Esc 或点击空白关闭
function zoomEl() {
  let el = document.getElementById('zzImgZoom')
  if (el) return el
  const host = document.getElementById('zzv') || document.body
  el = document.createElement('div')
  el.id = 'zzImgZoom'
  el.className = 'imgzoom'
  el.innerHTML = '<img alt="">'
  el.addEventListener('click', () => el.classList.remove('on'))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.classList.contains('on')) el.classList.remove('on')
  })
  host.appendChild(el)
  return el
}

export function openImageZoom(src, alt) {
  const s = String(src || '')
  if (!s) return
  const el = zoomEl()
  const img = el.querySelector('img')
  img.src = s
  img.alt = String(alt || '')
  el.classList.add('on')
}

// 点击缩略图放大；有 data-path 时读取全分辨率副本，回退到当前 src
function zoomFromImg(img) {
  const fallback = img.getAttribute('src') || ''
  const path = img.dataset.path
  if (path) {
    fsapi('readBase64', { path }).then((d) => openImageZoom((d && d.dataUrl) || fallback, img.alt))
      .catch(() => openImageZoom(fallback, img.alt))
  } else openImageZoom(fallback, img.alt)
}

// 对话区点击：本地文件链接打开编辑器，图片放大查看
export function bindMarkdownClicks(host) {
  if (!host || host.dataset.mdclick) return
  host.dataset.mdclick = '1'
  host.addEventListener('click', (e) => {
    const img = e.target.closest('img.mdimg')
    if (img) {
      e.preventDefault()
      zoomFromImg(img)
      return
    }
    const link = e.target.closest('a.filelink[data-path], code.filelink[data-path]')
    if (link) {
      e.preventDefault()
      const p = link.dataset.path
      openFile(p, basename(p))
      return
    }
    // 其余链接：聊天内容里的任意 <a> 都不得让主窗口跳转；
    // http(s) 交给系统浏览器打开，其余（file:/相对路径等）直接忽略
    const a = e.target.closest('a[href]')
    if (a) {
      e.preventDefault()
      const href = a.getAttribute('href') || ''
      if (/^https?:/i.test(href)) window.open(href, '_blank')
    }
  })
}
