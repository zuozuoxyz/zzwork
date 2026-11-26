import { createIcons, icons } from 'lucide'

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function ic(name, size = 14, color) {
  const c = color ? `color:${color};` : ''
  return `<i data-lucide="${name}" style="${c}width:${size}px;height:${size}px"></i>`
}

export function refreshIcons() {
  try { createIcons({ icons, attrs: { 'stroke-width': 1.8 } }) } catch {}
}

// 任务类型图标（与文件系统图标观感一致）：代码任务=folder-git(蓝)，通用任务=notebook(青)
export function taskIcon(type) {
  const code = type === 'code'
  return { name: code ? 'folder-git' : 'notebook', color: code ? '#7aa2f7' : '#2dd4bf' }
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
  const debounced = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
  // 取消尚未触发的调用：清空输入后立刻发送时，用它丢弃旧内容待写入的存档，避免被写回
  debounced.cancel = () => { clearTimeout(t); t = 0 }
  return debounced
}

// token 数量紧凑显示：3100 → 3.1k，100 → 0.1k，0 → 0
export function fmtTok(v) {
  const n = Number(v) || 0
  if (n <= 0) return '0'
  if (n >= 100) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// 面板全屏：给宿主加 .zz-fullscreen 填满整个窗口；按钮或 Esc 退出
export function setupFullscreen(hostEl, btnEl, onChange) {
  if (!hostEl || !btnEl) return null
  const paint = (on) => {
    btnEl.innerHTML = ic(on ? 'minimize-2' : 'maximize-2', 14)
    btnEl.setAttribute('title', on ? '退出全屏（Esc）' : '全屏')
    refreshIcons()
  }
  const set = (on) => {
    hostEl.classList.toggle('zz-fullscreen', on)
    paint(on)
    if (typeof onChange === 'function') setTimeout(() => onChange(on), 60)
  }
  const toggle = () => set(!hostEl.classList.contains('zz-fullscreen'))
  btnEl.addEventListener('click', toggle)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && hostEl.classList.contains('zz-fullscreen')) { e.preventDefault(); set(false) }
  })
  return { toggle, set }
}
