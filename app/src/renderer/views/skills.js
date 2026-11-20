// Skills 视图
import { store, env as envApi, fsapi, dialog } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, ic, refreshIcons, basename, dirname } from '../lib/ui.js'
import { reloadSkills, scanAll } from '../lib/data.js'
import { toast } from '../components/toast.js'

function sourceOf(path) {
  const p = String(path || '')
  if (p.includes('.agents')) return '.agents'
  if (p.includes('.claude')) return '.claude'
  return 'user'
}

export function initSkillsView() {
  $('#addSkillBtn').addEventListener('click', addSkill)
  $('#scanSkillsBtn').addEventListener('click', async () => {
    toast('正在扫描 Skills…')
    try { await scanAll(); await reloadSkills() } catch (e) { toast(e.message, 'err') }
    emit('data-scanned')
    renderSkills()
    toast('Skills 扫描完成')
  })
}

export function renderSkills() {
  const body = $('#skillsBody')
  const filter = state.filter.trim().toLowerCase()
  const list = state.skills.filter((s) => !filter
    || String(s.name).toLowerCase().includes(filter)
    || String(s.path || '').toLowerCase().includes(filter)
    || String(s.description || '').toLowerCase().includes(filter))
  if (!list.length) {
    body.innerHTML = `<div class="hint">自动扫描 ~/.zzwork/skills、.agents 与 .claude 目录</div><div class="empty">${filter ? '没有匹配的 Skill' : '还没有识别到 Skill，点击 ↻ 重新扫描'}</div>`
    return
  }
  body.innerHTML = `<div class="hint">自动扫描 ~/.zzwork/skills、.agents 与 .claude</div>` + list.map((s) => {
    const sel = state.mode === 'item' && state.item && state.item.kind === 'skill' && state.item.id === s.id
    return `<div class="item ${sel ? 'sel' : ''}" data-skill="${esc(s.id)}">
      <div class="top">${ic('file-text', 14).replace('<i ', '<i style="color:#2dd4bf;')}<span class="nm">${esc(s.name)}</span></div>
      <div class="meta"><span class="tag2">${esc(sourceOf(s.path))}</span><span>${esc(s.description || s.path)}</span></div>
    </div>`
  }).join('')
  refreshIcons()
  body.querySelectorAll('.item[data-skill]').forEach((el) => {
    el.addEventListener('click', () => emit('open-item', { kind: 'skill', id: el.getAttribute('data-skill') }))
  })
}

export async function renderSkillDetail(id) {
  const s = state.skills.find((x) => x.id === id)
  const bodyEl = $('#itemBody')
  if (!s) { bodyEl.innerHTML = `<div class="empty">Skill 不存在</div>`; return }
  bodyEl.innerHTML = `
    <div class="hd"><h2>${esc(s.name)}</h2><span class="pill b">Skill</span></div>
    <div class="pth">${esc(s.path)}</div>
    <div class="sec">基本信息</div>
    <div class="box"><div class="l">描述</div><div class="h">${esc(s.description || '（无描述）')}</div></div>
    <div class="box"><div class="l">来源目录</div><div class="h">自动扫描 .agents 与 .claude</div>
      <div class="frow"><div class="ftxt" style="max-width:120px">${esc(sourceOf(s.path))}</div><div class="ftxt">${esc(s.path)}</div></div></div>
    <div class="sec">内容预览</div>
    <div class="code" id="skillPreview">加载中…</div>
    <div class="frow" style="margin-top:12px">
      <button class="btn" id="openSkillFile">打开文件</button>
      ${state.taskId ? '<button class="btn pri" id="enableSkill">在会话中启用</button>' : ''}
      <button class="btn" id="delSkill" style="color:#f87171">删除记录</button>
    </div>`
  refreshIcons()

  try {
    const text = await envApi('readSkill', { path: s.path })
    const pre = $('#skillPreview')
    if (pre) pre.textContent = text || '（空文件）'
  } catch (e) {
    const pre = $('#skillPreview')
    if (pre) pre.textContent = '读取失败：' + e.message
  }

  $('#openSkillFile').addEventListener('click', () => fsapi('openPath', { path: s.path }).catch((e) => toast(e.message, 'err')))
  const en = $('#enableSkill')
  if (en) en.addEventListener('click', async () => {
    await store('taskSkills.setExcluded', { taskId: state.taskId, skillId: s.id, excluded: false })
    toast('已在本任务启用该 Skill')
  })
  $('#delSkill').addEventListener('click', async () => {
    await store('skills.delete', { id: s.id })
    await reloadSkills()
    renderSkills()
    emit('close-item')
    toast('已删除 Skill 记录')
  })
}

async function addSkill() {
  const file = await dialog('openFile')
  if (!file) return
  if (!/SKILL\.md$/i.test(file) && !/\.md$/i.test(file)) return toast('请选择 Skill 的 Markdown 文件', 'err')
  const name = basename(dirname(file)) || basename(file)
  await store('skills.upsert', { skill: { env_id: 'global', name, path: file, source: 'user', description: '' } })
  await reloadSkills()
  renderSkills()
  toast('已添加 Skill')
}
