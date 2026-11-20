// 右键菜单
import { ic, refreshIcons } from '../lib/ui.js'

let openMenu = null

export function hideContextMenu() {
  if (!openMenu) return
  document.removeEventListener('mousedown', onDocDown, true)
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('blur', hideContextMenu)
  window.removeEventListener('resize', hideContextMenu)
  openMenu.remove()
  openMenu = null
}

function onDocDown(e) {
  if (openMenu && !openMenu.contains(e.target)) hideContextMenu()
}

function onKey(e) {
  if (e.key === 'Escape') hideContextMenu()
}

export function showContextMenu(x, y, items) {
  hideContextMenu()
  const host = document.getElementById('ctx-host')
  const menu = document.createElement('div')
  menu.className = 'zz-ctx'
  menu.innerHTML = (items || []).map((it, i) => {
    if (it.sep) return '<div class="sep"></div>'
    return `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon ? ic(it.icon, 13) : ''}<span>${it.label}</span></button>`
  }).join('')

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-i]')
    if (!btn) return
    const it = items[Number(btn.getAttribute('data-i'))]
    hideContextMenu()
    if (it && it.action) it.action()
  })

  host.appendChild(menu)
  refreshIcons()
  const rect = menu.getBoundingClientRect()
  const left = Math.min(x, window.innerWidth - rect.width - 8)
  const top = Math.min(y, window.innerHeight - rect.height - 8)
  menu.style.left = Math.max(6, left) + 'px'
  menu.style.top = Math.max(6, top) + 'px'
  openMenu = menu

  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', hideContextMenu)
    window.addEventListener('resize', hideContextMenu)
  }, 0)
}
