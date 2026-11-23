// 模型视图：提供方 → 模型 两级（Key 按提供方保存）
import { store, secrets } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, ic, refreshIcons } from '../lib/ui.js'
import { reloadModels, reloadProviders } from '../lib/data.js'
import { openModal } from '../components/modal.js'
import { toast } from '../components/toast.js'
import { dialog } from '../lib/api.js'

const keyOf = (pid) => 'zzwork.key.provider.' + pid
const TYPE_LABEL = { anthropic: 'Anthropic', openai_compatible: 'OpenAI 兼容' }
const typeLabel = (t) => TYPE_LABEL[t] || 'OpenAI 兼容'

export function initModelsView() {
  $('#addModelBtn').addEventListener('click', addProvider)
}

export function renderModels() {
  const body = $('#modelsBody')
  const filter = state.filter.trim().toLowerCase()
  if (!state.providers.length) {
    body.innerHTML = `<div class="empty">${filter ? '没有匹配的模型' : '还没有提供方。点击 ＋ 添加模型提供方，再在提供方里添加模型。'}</div>`
    return
  }
  const parts = []
  for (const p of state.providers) {
    const models = state.models.filter((m) => m.provider_id === p.id)
    const hitProvider = !filter || String(p.name).toLowerCase().includes(filter)
    const shown = models.filter((m) => hitProvider || String(m.name).toLowerCase().includes(filter) || String(m.model_id).toLowerCase().includes(filter))
    if (!hitProvider && !shown.length) continue
    const selP = state.mode === 'item' && state.item && state.item.kind === 'provider' && state.item.id === p.id
    parts.push(`<div class="item ${selP ? 'sel' : ''}" data-provider="${esc(p.id)}">
      <div class="top">${ic('server', 14, '#c9b25e')}<span class="nm">${esc(p.name)}</span></div>
      <div class="meta"><span>${esc(typeLabel(p.type))}</span><span>${shown.length} 个模型</span></div>
    </div>`)
    for (const m of shown) {
      const selM = state.mode === 'item' && state.item && state.item.kind === 'model' && state.item.id === m.id
      parts.push(`<div class="item ${selM ? 'sel' : ''}" data-model="${esc(m.id)}" style="padding-left:26px">
        <div class="top">${ic('cpu', 13, m.is_default ? '#7dd3fc' : '#8b8f93')}<span class="nm">${esc(m.name)}</span>${m.is_default ? '<span class="pill b">默认</span>' : ''}</div>
        <div class="meta"><span>${esc(m.model_id)}</span></div>
      </div>`)
    }
  }
  body.innerHTML = parts.join('') || `<div class="empty">没有匹配的模型</div>`
  refreshIcons()
  body.querySelectorAll('.item[data-provider]').forEach((el) => {
    el.addEventListener('click', () => emit('open-item', { kind: 'provider', id: el.getAttribute('data-provider') }))
  })
  body.querySelectorAll('.item[data-model]').forEach((el) => {
    el.addEventListener('click', () => emit('open-item', { kind: 'model', id: el.getAttribute('data-model') }))
  })
}

export async function renderProviderDetail(id) {
  const p = state.providers.find((x) => x.id === id)
  const bodyEl = $('#itemBody')
  if (!p) { bodyEl.innerHTML = `<div class="empty">提供方不存在</div>`; return }
  let hasKey = false
  try { hasKey = await secrets('has', { key: keyOf(p.id) }) } catch {}
  const models = state.models.filter((m) => m.provider_id === p.id)
  const rows = models.length ? models.map((m) => `<div class="lrow" data-model="${esc(m.id)}">
      ${ic('cpu', 14)}<span class="nm">${esc(m.name)}</span>
      <span class="meta"><span>${esc(m.model_id)}</span>${m.is_default ? '<span class="pill b">默认</span>' : ''}</span></div>`).join('')
    : `<div class="hint">该提供方还没有模型，点击「添加模型」。</div>`

  bodyEl.innerHTML = `
    <div class="hd"><h2>${esc(p.name)}</h2><span class="pill b">${esc(typeLabel(p.type))}</span>
      <span class="pill ${hasKey ? 'g' : ''}">${hasKey ? 'Key 已设置' : '未设置 Key'}</span></div>
    <div class="sec">提供方配置</div>
    <div class="box"><div class="l">名称</div><div class="frow"><input class="ftxt" id="pvName" value="${esc(p.name)}" style="max-width:320px"></div></div>
    <div class="box"><div class="l">接口类型</div><div class="frow">
      <select class="sel2" id="pvType">
        <option value="openai_compatible" ${p.type !== 'anthropic' ? 'selected' : ''}>OpenAI 兼容</option>
        <option value="anthropic" ${p.type === 'anthropic' ? 'selected' : ''}>Anthropic</option>
      </select></div></div>
    <div class="box"><div class="l">Base URL</div><div class="h">Anthropic 原生或 OpenAI 兼容地址</div>
      <div class="frow"><input class="ftxt" id="pvUrl" value="${esc(p.base_url)}" style="max-width:420px"></div></div>
    <div class="box"><div class="l">API Key</div><div class="h">该提供方下所有模型共用；保存在本机 safeStorage</div>
      <div class="frow"><div class="ftxt">${hasKey ? '已保存' : '未设置'}</div><button class="btn" id="pvKeyBtn">${hasKey ? '更换' : '设置'}</button></div></div>
    <div class="frow" style="margin-top:6px"><button class="btn pri" id="pvSave">保存配置</button></div>
    <div class="sec">模型<span class="sp"></span><button class="btn sm" id="pvAddModel">${ic('plus', 11)} 添加模型</button></div>
    <div id="pvModels">${rows}</div>
    <div class="sec">操作</div>
    <div class="frow"><button class="btn" id="pvDel" style="color:#f87171">删除提供方</button></div>`
  refreshIcons()

  bodyEl.querySelectorAll('#pvModels .lrow[data-model]').forEach((el) => {
    el.style.cursor = 'pointer'
    el.addEventListener('click', () => emit('open-item', { kind: 'model', id: el.getAttribute('data-model') }))
  })

  $('#pvSave').addEventListener('click', async () => {
    const name = $('#pvName').value.trim()
    const base_url = $('#pvUrl').value.trim()
    const type = $('#pvType').value
    if (!name || !base_url) return toast('名称与 Base URL 不能为空', 'err')
    await store('providers.upsert', { provider: { id: p.id, name, type, base_url } })
    await Promise.all([reloadProviders(), reloadModels()])
    renderModels()
    renderProviderDetail(p.id)
    emit('task-updated', state.taskId)
    toast('已保存提供方配置')
  })

  $('#pvKeyBtn').addEventListener('click', async () => {
    const r = await openModal({
      title: 'API Key · ' + p.name,
      note: '密钥只保存在本机，该提供方下的所有模型共用。',
      fields: [{ name: 'key', label: 'Key', type: 'password', placeholder: 'sk-…' }],
      okText: '保存'
    })
    if (!r || !r.key.trim()) return
    await secrets('set', { key: keyOf(p.id), value: r.key.trim() })
    renderProviderDetail(p.id)
    toast('已保存 API Key')
  })

  $('#pvAddModel').addEventListener('click', () => addModel(p))

  $('#pvDel').addEventListener('click', async () => {
    const ok = await dialog('confirm', {
      message: `删除提供方「${p.name}」？`,
      detail: `其下 ${models.length} 个模型和已保存的 API Key 会一并删除。`
    })
    if (!ok) return
    await store('providers.delete', { id: p.id })
    await secrets('delete', { key: keyOf(p.id) })
    await Promise.all([reloadProviders(), reloadModels()])
    renderModels()
    emit('close-item')
    emit('task-updated', state.taskId)
    toast('已删除提供方')
  })
}

export async function renderModelDetail(id) {
  const m = state.models.find((x) => x.id === id)
  const bodyEl = $('#itemBody')
  if (!m) { bodyEl.innerHTML = `<div class="empty">模型不存在</div>`; return }
  const p = state.providers.find((x) => x.id === m.provider_id) || null
  bodyEl.innerHTML = `
    <div class="hd"><h2>${esc(m.name)}</h2><span class="pill b">${esc(p ? p.name : typeLabel(m.type))}</span>${m.is_default ? '<span class="pill g">默认</span>' : ''}</div>
    <div class="pth">${esc(m.model_id)}</div>
    <div class="sec">模型配置</div>
    <div class="box"><div class="l">显示名称</div><div class="frow"><input class="ftxt" id="mdName" value="${esc(m.name)}" style="max-width:320px"></div></div>
    <div class="box"><div class="l">模型 ID</div><div class="h">请求里使用的 model 字段</div>
      <div class="frow"><input class="ftxt" id="mdModelId" value="${esc(m.model_id)}" style="max-width:320px"></div></div>
    <div class="box"><div class="l">提供方</div><div class="h">接口地址与 API Key 跟随提供方</div>
      <div class="frow"><div class="ftxt">${esc(p ? p.name : '未关联提供方')}</div></div></div>
    <div class="frow" style="margin-top:6px">
      <button class="btn pri" id="mdSave">保存</button>
      ${m.is_default ? '' : '<button class="btn" id="setDefaultBtn">设为默认</button>'}
      <button class="btn" id="delModel" style="color:#f87171">删除</button>
    </div>`
  refreshIcons()

  $('#mdSave').addEventListener('click', async () => {
    const name = $('#mdName').value.trim()
    const model_id = $('#mdModelId').value.trim()
    if (!name || !model_id) return toast('名称与模型 ID 不能为空', 'err')
    await store('models.upsert', { model: { ...m, name, model_id } })
    await reloadModels()
    renderModels()
    renderModelDetail(id)
    emit('task-updated', state.taskId)
    toast('已保存模型')
  })

  const defBtn = $('#setDefaultBtn')
  if (defBtn) defBtn.addEventListener('click', async () => {
    await store('models.upsert', { model: { ...m, is_default: 1 } })
    await reloadModels()
    renderModels()
    renderModelDetail(id)
    emit('task-updated', state.taskId)
    toast('已设为默认模型')
  })

  $('#delModel').addEventListener('click', async () => {
    const ok = await dialog('confirm', { message: `删除模型「${m.name}」？`, detail: 'API Key 保存在提供方上，不受影响。' })
    if (!ok) return
    await store('models.delete', { id: m.id })
    await reloadModels()
    renderModels()
    emit('close-item')
    emit('task-updated', state.taskId)
    toast('已删除模型')
  })
}

async function addProvider() {
  const r = await openModal({
    title: '添加模型提供方',
    note: '先添加提供方（接口地址 + Key），再在其中添加多个模型。',
    fields: [
      { name: 'name', label: '名称', type: 'text', required: true, placeholder: '例如 Anthropic / OpenRouter / GLM' },
      { name: 'type', label: '接口类型', type: 'select', options: [['openai_compatible', 'OpenAI 兼容'], ['anthropic', 'Anthropic']], value: 'openai_compatible' },
      { name: 'base_url', label: 'Base URL', type: 'text', required: true, placeholder: '例如 https://api.anthropic.com' },
      { name: 'key', label: 'API Key', type: 'password', placeholder: '可稍后设置', hint: '该提供方下的模型共用这个 Key' }
    ],
    okText: '添加'
  })
  if (!r) return
  const id = await store('providers.upsert', {
    provider: { name: r.name.trim(), type: r.type, base_url: r.base_url.trim() }
  })
  if (r.key && r.key.trim()) await secrets('set', { key: keyOf(id), value: r.key.trim() })
  await Promise.all([reloadProviders(), reloadModels()])
  renderModels()
  toast('已添加提供方，可在其中添加模型')
}

async function addModel(p) {
  const r = await openModal({
    title: '添加模型 · ' + p.name,
    note: '接口地址与 API Key 使用提供方配置。',
    fields: [
      { name: 'name', label: '显示名称', type: 'text', required: true, placeholder: '例如 Claude Sonnet / DeepSeek V3' },
      { name: 'model_id', label: '模型 ID', type: 'text', required: true, placeholder: '请求里使用的 model 字段' },
      { name: 'is_default', label: '设为默认模型', type: 'checkbox', value: state.models.length === 0 }
    ],
    okText: '添加'
  })
  if (!r) return
  await store('models.upsert', {
    model: {
      name: r.name.trim(),
      model_id: r.model_id.trim(),
      type: p.type,
      base_url: p.base_url,
      provider_id: p.id,
      is_default: r.is_default ? 1 : 0
    }
  })
  await reloadModels()
  renderModels()
  if (state.item && state.item.kind === 'provider' && state.item.id === p.id) renderProviderDetail(p.id)
  else emit('open-item', { kind: 'provider', id: p.id })
  toast('已添加模型')
}
