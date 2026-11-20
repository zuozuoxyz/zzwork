import { createIcons, icons } from 'lucide'

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function ic(name, size = 14) {
  return `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>`
}

export function refreshIcons() {
  try { createIcons({ icons, attrs: { 'stroke-width': 1.8 } }) } catch {}
}

export function html(el, markup) {
  el.innerHTML = markup
  refreshIcons()
  return el
}

export function joinPath(dir, name) {
  const d = String(dir || '').replace(/[\\/]+$/, '')
  const sep = d.includes('\\') || /^[A-Za-z]:/.test(d) ? '\\' : '/'
  return d ? d + sep + name : name
}

export function basename(p) {
  const s = String(p || '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}

export function dirname(p) {
  const s = String(p || '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i > 0 ? s.slice(0, i) : s
}

export function safeName(name) {
  return String(name || 'task').trim().replace(/[\\/:*?"<>|]/g, '_')
}

export function envLabelFromPath(p) {
  const s = String(p || '')
  const m = s.match(/^\\\\wsl(?:\.localhost|\$)?\\([^\\]+)/i)
  if (m) return 'WSL ' + m[1]
  if (/^ssh:\/\//i.test(s)) return 'SSH'
  return '本机'
}

export function fmtTime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

export function debounce(fn, ms) {
  let t = 0
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}
