// 需求便签：工作区顶层记录 + 归类（新建/归入任务）+ 一键执行
import { invoke } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, debounce, refreshIcons } from '../lib/ui.js'
import { reloadTasks } from '../lib/data.js'
import { toast } from '../components/toast.js'

let loaded = false
let busy = false

const inboxInvoke = (method, payload) => invoke('inbox', method, payload || {})

export function initInboxView() {
  const openBtn = $('#openInboxBtn')
  if (openBtn) openBtn.addEventListener('click', () => emit('open-inbox'))
  const input = $('#inboxInput')
  if (!input) return
  const save = debounce(async () => {
    try {
      await inboxInvoke('save', { content: input.value })
      setHint('已自动保存到工作区 .zzwork/inbox.md')
    } catch (e) { setHint('保存失败：' + e.message) }
  }, 500)
  input.addEventListener('input', save)
  $('#triageBtn').addEventListener('click', () => runTriage().catch((e) => toast(e.message, 'err')))
  loadInbox()
}

async function loadInbox() {
  if (loaded) return
  loaded = true
  try {
    const r = await inboxInvoke('get')
    const input = $('#inboxInput')
    if (input && r && r.content) input.value = r.content
    setHint('自动保存到工作区 .zzwork/inbox.md')
  } catch (e) { setHint('读取失败：' + e.message) }
}

function setHint(text) {
  const el = $('#inboxHint')
  if (el) el.textContent = text
}

async function runTriage() {
  if (busy) return
  const input = $('#inboxInput')
  const content = input.value.trim()
  if (!content) { toast('便签是空的，先记录几条需求'); return }
  busy = true
  setHint('正在归类…')
  let result
  try {
    result = await inboxInvoke('triage', { content })
  } finally {
    busy = false
  }
  const items = (result && result.items) || []
  if (!items.length) { toast('没有可归类的需求行'); setHint('自动保存到工作区 .zzwork/inbox.md'); return }
  setHint(`归类完成（${result.mode === 'llm' ? 'AI' : '关键词'}），请确认`)
  const applied = await showTriageModal(items, result.mode)
  if (!applied) { setHint('自动保存到工作区 .zzwork/inbox.md'); return }
  await applyTriage(applied, content)
}

function showTriageModal(items, mode) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-host')
    const mask = document.createElement('div')
    mask.className = 'zz-modal-mask'

    const rows = items.map((it, i) => {
      const action = it.action === 'attach' ? 'attach' : it.action === 'ignore' ? 'ignore' : 'new'
      const taskOpts = state.tasks.map((t) => `<option value="${esc(t.id)}" ${t.id === it.taskId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')
      return `<div class="tri-row" data-i="${i}" data-text="${esc(it.text)}"
          data-reason="${esc(it.reason || '')}">
        <div class="txt">${esc(it.text)}</div>
        <select class="tri-act">
          <option value="new" ${action === 'new' ? 'selected' : ''}>新建任务</option>
          <option value="attach" ${action === 'attach' ? 'selected' : ''}>归入任务</option>
          <option value="ignore" ${action === 'ignore' ? 'selected' : ''}>忽略</option>
        </select>
        <div class="tri-target">
          <input class="tri-name" value="${esc(it.name || it.text.slice(0, 40))}" placeholder="新任务名" ${action === 'new' ? '' : 'style="display:none"'}>
          <select class="tri-task" ${action === 'attach' ? '' : 'style="display:none"'}>
            ${taskOpts || '<option value="">（暂无任务）</option>'}
          </select>
        </div>
        <div class="sub">
          <span class="tri-reason">${esc(it.reason || '')}</span>
          <span>置信度 ${Math.round((Number(it.confidence) || 0) * 100)}%</span>
          <select class="tri-type" style="margin-left:auto;width:110px">
            <option value="work" ${it.type === 'code' ? '' : 'selected'}>work</option>
            <option value="code" ${it.type === 'code' ? 'selected' : ''}>code</option>
          </select>
        </div>
      </div>`
    }).join('')

    mask.innerHTML = `<div class="zz-modal tr">
      <div class="mt">需求归类（${mode === 'llm' ? 'AI' : '关键词'}）</div>
      <div class="mn">确认每条需求是新建任务还是归入已有任务，应用后会附带执行。</div>
      <div class="tri-rows">${rows}</div>
      <div class="tri-foot">
        <label class="mf inline" style="margin:0"><input type="checkbox" id="tri-exec" checked> 立即执行</label>
        <span class="sp"></span>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn pri" data-act="ok">归类并执行</button>
      </div>
    </div>`

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true)
      mask.remove()
      resolve(val)
    }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null) } }

    mask.querySelectorAll('.tri-row').forEach((row) => {
      const act = row.querySelector('.tri-act')
      const name = row.querySelector('.tri-name')
      const task = row.querySelector('.tri-task')
      act.addEventListener('change', () => {
        const v = act.value
        name.style.display = v === 'new' ? '' : 'none'
        task.style.display = v === 'attach' ? '' : 'none'
      })
      if (act.value === 'attach' && !task.value) {
        const first = state.tasks[0]
        if (first) task.value = first.id
      }
    })

    mask.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null))
    mask.querySelector('[data-act="ok"]').addEventListener('click', () => {
      const out = []
      mask.querySelectorAll('.tri-row').forEach((row) => {
        const action = row.querySelector('.tri-act').value
        if (action === 'ignore') return
        const text = row.getAttribute('data-text')
        if (action === 'attach') {
          const sel = row.querySelector('.tri-task')
          const taskId = sel.value
          const t = state.tasks.find((x) => x.id === taskId)
          if (!taskId) return
          out.push({ action: 'attach', text, taskId, taskName: t ? t.name : '' })
        } else {
          const name = row.querySelector('.tri-name').value.trim() || text.slice(0, 40)
          const type = row.querySelector('.tri-type').value
          out.push({ action: 'new', text, name, type })
        }
      })
      if (!out.length) { toast('没有需要应用的需求'); return }
      close({ items: out, execute: mask.querySelector('#tri-exec').checked })
    })

    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null) })
    document.addEventListener('keydown', onKey, true)
    host.appendChild(mask)
    refreshIcons()
  })
}

async function applyTriage(payload, content) {
  const btn = $('#triageBtn')
  if (btn) btn.disabled = true
  setHint('正在应用并执行…')
  try {
    const r = await inboxInvoke('apply', { items: payload.items, execute: payload.execute !== false })
    const ok = (r.results || []).filter((x) => x.ok)
    const fail = (r.results || []).filter((x) => !x.ok)
    await reloadTasks()
    emit('tasks-changed')
    const created = ok.filter((x) => x.action === 'new').length
    const attached = ok.filter((x) => x.action === 'attach').length
    toast(`已处理 ${ok.length} 条：新建 ${created} · 归入 ${attached}${fail.length ? ' · 失败 ' + fail.length : ''}`, fail.length ? 'err' : 'info', 4000)
    if (fail.length) console.warn('[inbox] 失败项', fail)
    const input = $('#inboxInput')
    if (input) { input.value = ''; await inboxInvoke('save', { content: '' }) }
    setHint('已应用，便签已清空')
    const first = ok.find((x) => x.taskId)
    if (first) emit('open-session', { taskId: first.taskId, sessionId: first.sessionId || '' })
  } catch (e) {
    toast('应用失败：' + e.message, 'err', 4000)
    setHint('应用失败：' + e.message)
  } finally {
    if (btn) btn.disabled = false
  }
}
