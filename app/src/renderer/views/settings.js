// 设置视图
import { store, dialog, fsapi, invoke } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, refreshIcons } from '../lib/ui.js'
import { reloadTasks } from '../lib/data.js'
import { toast } from '../components/toast.js'

const isLocalPath = (p) => !!p && !/^ssh:\/\//i.test(p) && !/^\\\\wsl/i.test(p)
const normPath = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const underDir = (p, dir) => !!dir && normPath(p).startsWith(normPath(dir) + '\\')

async function migrateTasks(payload) {
  let r
  try { r = await store('workdir.migrate', payload) } catch (e) { toast('迁移失败：' + e.message, 'err', 5000); return false }
  await reloadTasks()
  emit('tasks-changed')
  const skipped = (r && r.skipped) || []
  if (skipped.length) {
    toast(`已迁移 ${r.moved.length} 个，跳过 ${skipped.length} 个：` + skipped.map((s) => s.name + '（' + s.reason + '）').join('；'), 'err', 8000)
  } else {
    toast(`已迁移 ${(r && r.moved.length) || 0} 个任务目录`)
  }
  return true
}

export async function renderSettings() {
  const body = $('#settingsBody')
  let info = { kind: 'sqlite', path: '' }
  try { info = await store('db.info') } catch {}
  await reloadTasks()
  const workdir = (await store('workdir.get')) || ''
  state.workdir = workdir
  const autoAi = (await store('settings.get', { key: 'ui:autoOpenAi', dflt: '1' })) !== '0'
  const defType = await store('settings.get', { key: 'newTask:type', dflt: 'work' })
  const outsiders = state.tasks.filter((t) => isLocalPath(t.path) && workdir && !underDir(t.path, workdir))
  let appVer = ''
  try { appVer = (await invoke('update', 'version')) || '' } catch {}

  body.innerHTML = `
    <h2>常规设置</h2><div class="sub">全局设置，对所有任务生效</div>
    <div class="box"><div class="l">工作目录</div><div class="h">新建任务会在这里创建同名文件夹；更换时可迁移旧目录下的任务</div>
      <div class="frow"><div class="ftxt">${esc(workdir || '(未设置)')}</div>
        <button class="btn" id="changeWorkdir">更换…</button>
        <button class="btn" id="openWorkdir">打开</button></div></div>
    ${outsiders.length ? `<div class="box"><div class="l">任务目录不在工作目录下</div>
      <div class="h">${outsiders.length} 个任务的文件夹位于工作目录之外，可迁移进来（移动到各自同名文件夹）</div>
      <div class="frow"><div class="ftxt" style="max-height:66px;overflow:auto">${esc(outsiders.map((t) => t.name).join('、'))}</div>
        <button class="btn" id="migrateOutsiders">迁移…</button></div></div>` : ''}
    <div class="box"><div class="l">新任务默认类型</div><div class="h">work = 通用任务；code = 代码仓库</div>
      <div class="frow"><div class="ftxt" style="max-width:170px" id="defTypeVal">${esc(defType)}</div>
        <button class="btn" id="toggleDefType">切换</button></div></div>
    <div class="box"><div class="frow" style="justify-content:space-between">
        <div><div class="l">选中任务时自动打开 AI 对话</div><div class="h">关闭后需手动切到 AI tab</div></div>
        <span class="tg ${autoAi ? 'on' : ''}" id="toggleAutoAi"></span></div></div>
    <div class="box"><div class="l">数据存储</div><div class="h">${esc(info.kind === 'sqlite' ? 'SQLite（WAL）' : 'JSON 回退')} · ${esc(info.path || '')}</div>
      <div class="frow"><button class="btn" id="openDataDir">打开数据目录</button></div></div>
    <div class="box"><div class="l">关于</div><div class="h">zzwork ${esc(appVer || '0.4')} · Electron ${esc((window.zzwork && window.zzwork.version) || '43')} · 独立壳（不再依赖 VS Code 内核）</div></div>`
  refreshIcons()

  $('#changeWorkdir').addEventListener('click', async () => {
    const dir = await dialog('openDirectory')
    if (!dir) return
    const old = (await store('workdir.get')) || ''
    const affected = state.tasks.filter((t) => isLocalPath(t.path) && underDir(t.path, old))
    if (affected.length) {
      const ok = await dialog('confirm', {
        message: `有 ${affected.length} 个任务位于原工作目录下`,
        detail: '「确定」：把这些任务文件夹移动到新的工作目录并更新任务路径；「取消」：只更换工作目录，不移动现有文件夹。'
      })
      if (ok) await migrateTasks({ from: old, to: dir })
    }
    await store('settings.set', { key: 'workdir', value: dir })
    state.workdir = dir
    renderSettings()
    if (!affected.length) toast('工作目录已更新')
  })
  const migrateOutsiders = $('#migrateOutsiders')
  if (migrateOutsiders) migrateOutsiders.addEventListener('click', async () => {
    const ids = outsiders.map((t) => t.id)
    if (!ids.length) return
    const ok = await dialog('confirm', {
      message: `把 ${ids.length} 个任务目录迁移到工作目录？`,
      detail: '将把以下任务的文件夹移动到 ' + workdir + ' 下的同名文件夹：' + outsiders.map((t) => t.name).join('、')
    })
    if (!ok) return
    if (await migrateTasks({ ids, to: workdir })) renderSettings()
  })
  $('#openWorkdir').addEventListener('click', () => {
    if (!state.workdir) return toast('工作目录未设置', 'err')
    fsapi('openPath', { path: state.workdir }).catch((e) => toast(e.message, 'err'))
  })
  $('#toggleDefType').addEventListener('click', async () => {
    const cur = $('#defTypeVal').textContent
    const next = cur === 'work' ? 'code' : 'work'
    await store('settings.set', { key: 'newTask:type', value: next })
    renderSettings()
  })
  $('#toggleAutoAi').addEventListener('click', async () => {
    await store('settings.set', { key: 'ui:autoOpenAi', value: autoAi ? '0' : '1' })
    renderSettings()
  })
  $('#openDataDir').addEventListener('click', async () => {
    try {
      const p = await store('db.info')
      const dir = String(p.path || '').replace(/[\\/][^\\/]+$/, '')
      if (dir) await fsapi('openPath', { path: dir })
    } catch (e) { toast(e.message, 'err') }
  })
}
