// 轻量提示条
let host
let seq = 0

export function toast(message, kind = 'info', ms = 2600) {
  host = host || document.getElementById('toast-host')
  if (!host) return
  const id = 't' + ++seq
  const el = document.createElement('div')
  el.className = 'zz-toast ' + kind
  el.id = id
  el.textContent = message
  host.appendChild(el)
  requestAnimationFrame(() => el.classList.add('on'))
  setTimeout(() => {
    el.classList.remove('on')
    setTimeout(() => el.remove(), 200)
  }, ms)
}
