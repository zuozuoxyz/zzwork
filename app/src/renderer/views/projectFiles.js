// 项目面板下半部分：选中任务的文件树 + 上下分栏拖拽
import { store } from '../lib/api.js'
import { state } from '../lib/state.js'
import { $ } from '../lib/ui.js'
import { renderFileTree, resetFileTreeState } from '../workbench/fileTree.js'

const KEY = 'projects:split'
let ratio = 0.55
let lastTaskId = ''
let chain = Promise.resolve()

export function initProjectFiles() {
  const top = $('#projectsTop')
  const bottom = $('#projectsFiles')
  const bar = $('#projectsSplitBar')
  const split = $('#projectsSplit')
  if (!top || !bottom || !bar || !split) return

  const apply = () => {
    top.style.flex = ratio + ' 1 0'
    bottom.style.flex = (1 - ratio) + ' 1 0'
  }
  apply()
  store('settings.get', { key: KEY, dflt: '' }).then((raw) => {
    if (!raw) return
    const v = Number(raw)
    if (v > 0.1 && v < 0.9) { ratio = v; apply() }
  }).catch(() => {})

  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    bar.setPointerCapture(e.pointerId)
    const rect = split.getBoundingClientRect()
    const move = (ev) => {
      if (!rect.height) return
      ratio = Math.min(0.88, Math.max(0.12, (ev.clientY - rect.top) / rect.height))
      apply()
    }
    const up = () => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
      try { bar.releasePointerCapture(e.pointerId) } catch {}
      store('settings.set', { key: KEY, value: String(Math.round(ratio * 1000) / 1000) }).catch(() => {})
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
  })
}

export function renderProjectFiles() {
  chain = chain.then(async () => {
    const host = $('#filesTree')
    if (!host) return
    if (state.taskId !== lastTaskId) { lastTaskId = state.taskId; resetFileTreeState() }
    await renderFileTree(host)
  }).catch(() => {})
  return chain
}
