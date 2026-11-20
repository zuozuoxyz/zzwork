// 通用表单弹窗：openModal 返回字段对象或 null
import { esc } from '../lib/ui.js'

export function openModal(opts) {
  const {
    title = '', fields = [], okText = '确定', cancelText = '取消', note = '', wide = false
  } = opts || {}

  return new Promise((resolve) => {
    const host = document.getElementById('modal-host')
    const mask = document.createElement('div')
    mask.className = 'zz-modal-mask'

    const fieldHtml = fields.map((f) => {
      const id = 'f_' + f.name
      const common = `id="${id}" name="${esc(f.name)}"`
      let control = ''
      if (f.type === 'select') {
        const options = (f.options || []).map((o) => {
          const v = Array.isArray(o) ? o[0] : o.value
          const label = Array.isArray(o) ? o[1] : o.label
          return `<option value="${esc(v)}" ${String(v) === String(f.value || '') ? 'selected' : ''}>${esc(label)}</option>`
        }).join('')
        control = `<select ${common}>${options}</select>`
      } else if (f.type === 'textarea') {
        control = `<textarea ${common} rows="${f.rows || 4}" placeholder="${esc(f.placeholder || '')}" spellcheck="false">${esc(f.value || '')}</textarea>`
      } else if (f.type === 'checkbox') {
        control = `<input ${common} type="checkbox" ${f.value ? 'checked' : ''}>`
      } else {
        control = `<input ${common} type="${f.type || 'text'}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" ${f.readonly ? 'readonly' : ''} autocomplete="off" spellcheck="false">`
      }
      return `<div class="mf ${f.type === 'checkbox' ? 'inline' : ''}" data-field="${esc(f.name)}">
        ${f.label ? `<label for="${id}">${esc(f.label)}</label>` : ''}
        ${control}
        ${f.hint ? `<div class="mh">${esc(f.hint)}</div>` : ''}
      </div>`
    }).join('')

    const syncVisibility = () => {
      const vals = {}
      for (const f of fields) {
        const node = mask.querySelector('#f_' + f.name)
        if (node) vals[f.name] = f.type === 'checkbox' ? node.checked : node.value
      }
      for (const f of fields) {
        if (typeof f.visible !== 'function') continue
        const wrap = mask.querySelector(`.mf[data-field="${f.name}"]`)
        if (wrap) wrap.style.display = f.visible(vals) ? '' : 'none'
      }
    }

    mask.innerHTML = `<div class="zz-modal" ${wide ? 'style="width:560px"' : ''}>
      ${title ? `<div class="mt">${esc(title)}</div>` : ''}
      ${note ? `<div class="mn">${esc(note)}</div>` : ''}
      <div class="mfields">${fieldHtml}</div>
      <div class="mbtns">
        <button class="btn" data-act="cancel">${esc(cancelText)}</button>
        <button class="btn pri" data-act="ok">${esc(okText)}</button>
      </div>
    </div>`

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true)
      mask.remove()
      resolve(val)
    }

    const submit = () => {
      syncVisibility()
      const out = {}
      for (const f of fields) {
        const node = mask.querySelector('#f_' + f.name)
        if (!node) continue
        const wrap = mask.querySelector(`.mf[data-field="${f.name}"]`)
        const hidden = wrap && wrap.style.display === 'none'
        if (f.type === 'checkbox') out[f.name] = node.checked
        else out[f.name] = node.value
        if (!hidden && f.required && String(out[f.name] || '').trim() === '') {
          node.focus()
          node.classList.add('bad')
          return
        }
      }
      close(out)
    }

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null) }
      else if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) { e.preventDefault(); submit() }
    }

    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null) })
    mask.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null))
    mask.querySelector('[data-act="ok"]').addEventListener('click', submit)
    mask.addEventListener('input', syncVisibility)
    mask.addEventListener('change', syncVisibility)
    document.addEventListener('keydown', onKey, true)
    host.appendChild(mask)
    syncVisibility()

    const first = [...mask.querySelectorAll('.mfields input, .mfields select, .mfields textarea')]
      .find((el) => el.closest('.mf').style.display !== 'none')
    if (first) setTimeout(() => { first.focus(); if (first.select) first.select() }, 20)
  })
}

export function promptText(title, label, value = '', opts = {}) {
  return openModal({
    title,
    fields: [{ name: 'value', label, type: opts.multiline ? 'textarea' : 'text', value, required: true, placeholder: opts.placeholder }],
    okText: opts.okText || '确定'
  }).then((r) => (r ? r.value.trim() : null))
}
