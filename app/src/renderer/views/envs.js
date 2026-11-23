// 环境视图：本机 / WSL / SSH
import { store, env as envApi, secrets, lspapi } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, ic, refreshIcons } from '../lib/ui.js'
import { reloadEnvs, reloadSkills, scanAll } from '../lib/data.js'
import { openModal } from '../components/modal.js'
import { toast } from '../components/toast.js'
import { dialog } from '../lib/api.js'

const KIND = {
  local: { label: '本机', icon: 'monitor', color: '#7dd3fc' },
  wsl: { label: 'WSL', icon: 'hard-drive', color: '#2dd4bf' },
  ssh: { label: 'SSH', icon: 'server', color: '#c9b25e' }
}

export function initEnvsView() {
  $('#addEnvBtn').addEventListener('click', addEnv)
  $('#scanEnvBtn').addEventListener('click', async () => {
    toast('正在扫描环境…')
    try { await scanAll(); await reloadSkills() } catch (e) { toast(e.message, 'err') }
    emit('data-scanned')
    renderEnvs()
    if (state.item && state.item.kind === 'env') renderEnvDetail(envById(state.item.id))
    toast('环境扫描完成')
  })
}

function envById(id) { return state.envs.find((e) => e.id === id) || null }

function envDesc(e) {
  const c = e.config || {}
  return { id: e.id, kind: e.kind, distro: c.distro, host: c.host, user: c.user, port: c.port }
}

function detectKey(id) { return 'zz:detect:' + id }

function persistDetect(id, list) {
  store('settings.set', { key: detectKey(id), value: JSON.stringify({ list, at: Date.now() }) }).catch(() => {})
}

// 启动时先读上次的识别结果，环境页不必每次都是「未检测」
export async function loadDetectCache() {
  for (const e of state.envs) {
    try {
      const raw = await store('settings.get', { key: detectKey(e.id), dflt: '' })
      if (!raw) continue
      const d = JSON.parse(raw)
      if (d && Array.isArray(d.list)) state.detected[e.id] = d
    } catch {}
  }
}

// 启动后后台刷新所有环境的执行体识别（WSL/SSH 顺带更新连接状态）
export async function refreshEnvsStatus() {
  for (const e of state.envs) {
    try {
      const r = await envApi('detect', envDesc(e))
      if (r && Array.isArray(r.list)) {
        state.detected[e.id] = { list: r.list, at: Date.now() }
        // 连接失败时的空列表不落盘，避免污染对话侧的可用执行体缓存
        if (!r.error) persistDetect(e.id, r.list)
      }
      if (e.kind !== 'local') {
        state.envConn[e.id] = r && r.error
          ? { ok: false, message: r.error, at: Date.now() }
          : { ok: true, message: '连接正常', at: Date.now() }
      }
    } catch (err) {
      if (e.kind !== 'local') state.envConn[e.id] = { ok: false, message: err.message, at: Date.now() }
    }
  }
  emit('data-scanned')
  if (state.mode === 'item' && state.item && state.item.kind === 'env') renderEnvDetail(envById(state.item.id))
}

// 真实连接测试（WSL 启动发行版 / SSH 登录），结果写入 state.envConn
async function testEnv(e, quiet) {
  const r = await envApi('test', envDesc(e)).catch((err) => ({ ok: false, message: err.message }))
  const res = { ok: !!(r && r.ok), message: (r && r.message) || '', at: Date.now() }
  state.envConn[e.id] = res
  if (!quiet) toast(res.ok ? res.message : '连接失败：' + res.message, res.ok ? 'ok' : 'err', 5000)
  return res
}

function skillSource(path) {
  const p = String(path || '')
  if (p.includes('.agents')) return '.agents'
  if (p.includes('.claude')) return '.claude'
  return 'user'
}

export function renderEnvs() {
  const body = $('#envsBody')
  const filter = state.filter.trim().toLowerCase()
  const list = state.envs.filter((e) => !filter || String(e.name).toLowerCase().includes(filter))
  if (!list.length) {
    body.innerHTML = `<div class="empty">未扫描到环境配置</div>`
    return
  }
  body.innerHTML = list.map((e) => {
    const k = KIND[e.kind] || KIND.local
    const skills = state.skills.filter((s) => s.env_id === e.id || (e.id === 'local' && s.env_id === 'global'))
    const det = state.detected[e.id]
    const conn = state.envConn[e.id]
    const agents = det ? det.list.filter((a) => a.ok).length : null
    const desc = e.kind === 'wsl' ? `发行版 ${e.config.distro || '?'}` : e.kind === 'ssh' ? (e.config.user ? e.config.user + '@' : '') + (e.config.host || '?') : (e.config.path || '默认环境')
    const dot = conn ? (conn.ok ? 'ok' : 'warn') : det ? (agents > 0 || e.kind === 'local' ? 'ok' : 'warn') : 'off'
    const connTxt = conn ? (conn.ok ? '已连接' : '连接失败') : (agents == null ? '未检测' : agents + ' 执行体')
    const sel = state.mode === 'item' && state.item && state.item.kind === 'env' && state.item.id === e.id
    return `<div class="item ${sel ? 'sel' : ''}" data-env="${esc(e.id)}">
      <div class="top">${ic(k.icon, 14, k.color)}<span class="nm">${esc(e.name)}</span>
        <span class="dot ${dot}" title="${esc((conn && conn.message) || '')}"></span></div>
      <div class="meta"><span>${esc(desc)}</span><span>${connTxt}</span><span>${skills.length} skills</span></div>
    </div>`
  }).join('')
  refreshIcons()

  body.querySelectorAll('.item[data-env]').forEach((item) => {
    item.addEventListener('click', () => emit('open-item', { kind: 'env', id: item.getAttribute('data-env') }))
  })
}

export function renderEnvDetail(env) {
  if (!env) {
    $('#itemBody').innerHTML = `<div class="empty">环境不存在</div>`
    return
  }
  const k = KIND[env.kind] || KIND.local
  const det = state.detected[env.id]
  const conn = state.envConn[env.id]
  const skills = state.skills.filter((s) => s.env_id === env.id || (env.id === 'local' && s.env_id === 'global'))
  const sub = env.kind === 'wsl' ? `WSL · ${env.config.distro || '未指定发行版'}`
    : env.kind === 'ssh' ? `SSH · ${(env.config.user ? env.config.user + '@' : '') + (env.config.host || '?')}${env.config.port ? ':' + env.config.port : ''}`
      : '本机 · 默认环境'
  const connText = env.kind === 'local' ? ''
    : conn ? `<div class="hint" style="color:${conn.ok ? 'var(--ok)' : 'var(--warn)'}">${conn.ok ? '✓ ' : '✗ '}${esc(conn.message)}</div>`
      : `<div class="hint">尚未验证连接。点击「测试连接」确认能否真正连上。</div>`
  const curDefault = (env.config && env.config.defaultAgent) || ''
  const agentRows = det
    ? det.list.map((a) => `<div class="lrow">${ic('terminal', 14)}<span class="nm">${esc(a.name)}</span>
        <span class="meta">${a.ok ? '<span style="color:var(--ok)">✓ 已安装</span>' : '<span style="color:var(--faint)">未安装</span>'}
        ${a.id === 'builtin' ? '<span class="pill b">内置</span>' : ''}
        ${a.id === curDefault && a.ok && a.id !== 'builtin' ? '<span class="pill g">默认</span>' : ''}</span>
        ${!a.ok && a.pkg ? `<button class="btn sm" data-install="${esc(a.id)}" title="npm install -g ${esc(a.pkg)}">${ic('download', 11)} 安装</button>` : ''}</div>`).join('')
    : `<div class="hint">尚未检测。点击「刷新识别」检查 PATH 与常见安装目录。</div>`
  // 默认执行体下拉：优先已安装执行体；保留当前默认（即便未识别）以便看见并可清除
  const okAgents = det ? det.list.filter((a) => a.ok) : [{ id: 'builtin', name: '内置模型聊天', ok: true }]
  const defOpts = okAgents.map((a) => [a.id, a.name])
  if (curDefault && !defOpts.some((o) => o[0] === curDefault)) defOpts.push([curDefault, curDefault + '（未识别）'])
  const skillRows = skills.length ? skills.map((s) => `<div class="lrow">${ic('file-text', 14)}
      <span class="nm">${esc(s.name)}</span>
      <span class="meta"><span class="tag2">${esc(skillSource(s.path))}</span><span>${esc(s.description || s.path)}</span></span></div>`).join('')
    : `<div class="hint">该环境暂未识别到 Skills，点击顶部「扫描环境」重新扫描</div>`

  $('#itemBody').innerHTML = `
    <div class="hd"><h2>${esc(env.name)}</h2><span class="pill b">${esc(k.label)}</span>
      <span class="pill ${det ? 'g' : ''}">${det ? '已检测' : '未检测'}</span></div>
    <div class="pth">${esc(sub)}</div>
    ${connText}
    <div class="sec">执行体<span class="sp"></span><button class="btn sm" id="detectBtn">${ic('refresh-cw', 11)} 刷新识别</button></div>
    <div class="frow" style="margin-bottom:6px">
      <span style="font-size:11px;color:var(--faint);min-width:64px">默认执行体</span>
      <select class="sel2" id="defaultAgentSel">
        <option value="" ${curDefault ? '' : 'selected'}>（不指定，优先可用执行体）</option>
        ${defOpts.map(([v, l]) => `<option value="${esc(v)}" ${v === curDefault ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <span style="font-size:10px;color:var(--faint)">新建任务时默认使用</span>
    </div>
    <div id="agentList">${agentRows}</div>
    <div class="hint" id="detectHint">${det ? '上次识别：' + new Date(det.at).toLocaleString('zh-CN', { hour12: false }) : ''}</div>
    <div class="sec">语言服务器<span class="sp"></span><span style="text-transform:none;letter-spacing:0;font-size:10px;color:var(--faint)">Ctrl/Cmd+单击或 F12 转到定义</span></div>
    <div id="langList"><div class="hint">检测中…</div></div>
    <div class="sec">Skills<span class="sp"></span><span style="text-transform:none;letter-spacing:0;font-size:10px;color:var(--faint)">来源 .zzwork / .agents / .claude</span></div>
    <div>${skillRows}</div>
    <div class="sec">操作</div>
    <div class="frow">
      ${env.kind !== 'local' ? `<button class="btn" id="testEnv">${ic('plug-zap', 11)} 测试连接</button>` : ''}
      ${env.kind !== 'local' ? `<button class="btn" id="delEnv" style="color:#f87171">删除环境</button>` : ''}
    </div>`
  refreshIcons()
  loadLangServers(env)

  const detectBtn = $('#detectBtn')
  detectBtn.addEventListener('click', async () => {
    detectBtn.disabled = true
    detectBtn.textContent = '识别中…'
    try {
      const r = await envApi('detect', { ...envDesc(env), force: true })
      state.detected[env.id] = { list: r.list, at: Date.now() }
      if (!r.error) persistDetect(env.id, r.list)
      if (r.error) {
        state.envConn[env.id] = { ok: false, message: r.error, at: Date.now() }
        toast('连接失败：' + r.error, 'err', 6000)
      } else {
        state.envConn[env.id] = { ok: true, message: '连接正常', at: Date.now() }
      }
      renderEnvs()
      if (state.item && state.item.kind === 'env' && state.item.id === env.id) renderEnvDetail(env)
      if (!r.error) {
        const found = r.list.filter((a) => a.ok).length
        toast(`识别完成：${found} 个可用执行体`)
      }
    } catch (e) {
      toast('识别失败：' + e.message, 'err', 4000)
      detectBtn.disabled = false
      detectBtn.textContent = '刷新识别'
    }
  })

  const defSel = $('#defaultAgentSel')
  if (defSel) defSel.addEventListener('change', async () => {
    const val = defSel.value || ''
    const cfg = { ...(env.config || {}) }
    if (val) cfg.defaultAgent = val
    else delete cfg.defaultAgent
    try {
      await store('envs.upsert', { env: { id: env.id, name: env.name, kind: env.kind, config: cfg } })
      await reloadEnvs()
      renderEnvs()
      const fresh = envById(env.id)
      if (state.item && state.item.kind === 'env' && state.item.id === env.id) renderEnvDetail(fresh)
      toast(val ? '已设为该环境默认执行体' : '已清除默认执行体')
    } catch (e) { toast('保存失败：' + e.message, 'err', 4000) }
  })

  const agentList = $('#agentList')
  if (agentList) agentList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-install]')
    if (!btn) return
    const agentId = btn.getAttribute('data-install')
    btn.disabled = true
    btn.textContent = '安装中…'
    toast('正在安装执行体，可能需要 1–2 分钟…')
    const r = await envApi('install', { ...envDesc(env), agentId }).catch((err) => ({ ok: false, output: err.message }))
    if (r && r.ok) toast('安装完成，正在重新识别…')
    else toast('安装失败：' + String((r && r.output) || '未知错误').slice(-300), 'err', 6000)
    try {
      const d = await envApi('detect', { ...envDesc(env), force: true })
      state.detected[env.id] = { list: d.list, at: Date.now() }
      persistDetect(env.id, d.list)
    } catch {}
    renderEnvs()
    if (state.item && state.item.kind === 'env' && state.item.id === env.id) renderEnvDetail(env)
  })

  const testBtn = $('#testEnv')
  if (testBtn) testBtn.addEventListener('click', async () => {
    testBtn.disabled = true
    testBtn.textContent = '连接中…'
    await testEnv(env)
    renderEnvs()
    if (state.item && state.item.kind === 'env' && state.item.id === env.id) renderEnvDetail(env)
  })

  const del = $('#delEnv')
  if (del) del.addEventListener('click', async () => {
    const ok = await dialog('confirm', { message: `删除环境「${env.name}」？`, detail: '会同时删除该环境下的 Skills 与 MCP 记录。' })
    if (!ok) return
    await store('envs.delete', { id: env.id })
    await reloadEnvs()
    renderEnvs()
    emit('close-item')
    toast('已删除环境')
  })
}

// 语言服务器（转到定义）：列出各语言状态 + 一键安装
async function loadLangServers(env) {
  const host = $('#langList')
  if (!host) return
  let list = []
  try { list = await lspapi('list', envDesc(env)) } catch (e) {
    host.innerHTML = `<div class="hint">检测失败：${esc(e.message)}</div>`
    return
  }
  if (!Array.isArray(list) || !list.length) {
    host.innerHTML = `<div class="hint">暂无可检测的语言服务器</div>`
    return
  }
  host.innerHTML = list.map((s) => {
    const status = s.installed
      ? `<span style="color:var(--ok)">✓ ${esc(s.server || '已安装')}</span>`
      : `<span style="color:var(--faint)">未安装</span>`
    let action = ''
    if (!s.installed) {
      if (s.installers && s.installers.length) {
        const via = s.installers[0].via || s.installers[0].tool
        action = `<button class="btn sm" data-langinstall="${esc(s.id)}" title="${esc(s.installers[0].cmd)}">${ic('download', 11)} 安装 · ${esc(via)}</button>`
      } else {
        action = `<span class="meta" style="color:var(--faint)">无可用安装方式</span>`
      }
    }
    return `<div class="lrow">${ic('code', 14)}<span class="nm">${esc(s.label)}</span>
      <span class="meta">${status}</span>${action}</div>`
  }).join('')
  refreshIcons()
  host.querySelectorAll('[data-langinstall]').forEach((btn) => {
    btn.addEventListener('click', () => doInstallLang(env, btn.getAttribute('data-langinstall'), btn))
  })
}

async function doInstallLang(env, langId, btn) {
  btn.disabled = true
  btn.textContent = '安装中…'
  toast('正在安装语言服务器，可能需要 1–2 分钟…')
  const r = await lspapi('install', { ...envDesc(env), languageId: langId }).catch((err) => ({ ok: false, output: err.message }))
  if (r && r.ok) toast('安装完成，正在重新检测…')
  else toast('安装失败：' + String((r && r.output) || '未知错误').slice(-300), 'err', 6000)
  await loadLangServers(env)
}

async function addEnv() {
  let distros = []
  try { distros = await envApi('wsl') } catch {}
  const distroOptions = (distros || []).map((d) => {
    const ver = d.version ? ` · WSL${d.version}` : ''
    return [d.name, `${d.name}${ver}${d.default ? '（默认）' : ''}`]
  })
  const defDistro = (distros || []).find((d) => d.default) || (distros || [])[0]
  const isWsl = (v) => v.kind === 'wsl'
  const isSsh = (v) => v.kind === 'ssh'
  const isPwd = (v) => v.kind === 'ssh' && v.auth === 'password'

  const r = await openModal({
    title: '添加环境',
    fields: [
      { name: 'name', label: '名称', type: 'text', required: true, placeholder: '例如 Ubuntu-24.04 / dev@10.0.0.21' },
      { name: 'kind', label: '类型', type: 'select', options: [['wsl', 'WSL 发行版'], ['ssh', 'SSH 远程']], value: 'wsl' },
      distroOptions.length
        ? { name: 'distro', label: 'WSL 发行版', type: 'select', options: distroOptions, value: defDistro.name, hint: '来自 wsl --list --verbose', visible: isWsl }
        : { name: 'distro', label: 'WSL 发行版', type: 'text', placeholder: '例如 Ubuntu-24.04', hint: '未检测到已安装发行版，可手动输入', visible: isWsl },
      { name: 'host', label: 'SSH 主机', type: 'text', placeholder: '例如 10.0.0.21', hint: '仅 SSH 类型需要', visible: isSsh },
      { name: 'port', label: 'SSH 端口', type: 'text', placeholder: '22', visible: isSsh },
      { name: 'user', label: 'SSH 用户', type: 'text', placeholder: '例如 dev', visible: isSsh },
      { name: 'auth', label: '认证方式', type: 'select', options: [['key', '密钥 / ssh-agent'], ['password', '密码']], value: 'key', visible: isSsh },
      { name: 'password', label: 'SSH 密码', type: 'password', placeholder: '登录密码', hint: '加密保存在本机，不上传', visible: isPwd }
    ],
    okText: '添加'
  })
  if (!r) return

  const name = r.name.trim()
  const config = {}
  let password = ''
  if (r.kind === 'wsl') {
    const distro = String(r.distro || '').trim()
    if (!distro) return toast('请选择 WSL 发行版', 'err')
    if (state.envs.some((e) => e.kind === 'wsl' && e.config && e.config.distro === distro)) {
      return toast(`发行版「${distro}」已添加`, 'err')
    }
    config.distro = distro
  } else if (r.kind === 'ssh') {
    const host = String(r.host || '').trim()
    if (!host) return toast('请填写 SSH 主机', 'err')
    const user = String(r.user || '').trim()
    const port = String(r.port || '').trim()
    if (port && !/^\d+$/.test(port)) return toast('SSH 端口应为数字', 'err')
    config.host = host
    config.user = user
    if (port) config.port = Number(port)
    config.auth = r.auth === 'password' ? 'password' : 'key'
    if (config.auth === 'password') {
      password = String(r.password || '')
      if (!password) return toast('请填写 SSH 密码', 'err')
    }
    if (state.envs.some((e) => e.kind === 'ssh' && e.config && e.config.host === host
      && (e.config.user || '') === user && (e.config.port || 22) === (config.port || 22))) {
      return toast('该 SSH 环境已添加', 'err')
    }
  }

  const id = await store('envs.upsert', { env: { name, kind: r.kind, config } })
  if (r.kind === 'ssh') {
    try {
      if (password) await secrets('set', { key: 'zzwork.ssh.' + id, value: password })
      else await secrets('delete', { key: 'zzwork.ssh.' + id })
    } catch (e) { toast('密码保存失败：' + e.message, 'err', 4000) }
  }
  await reloadEnvs()
  renderEnvs()
  toast('已添加环境')

  const added = state.envs.find((e) => e.id === id)
  if (added && added.kind !== 'local') {
    testEnv(added, true).then((res) => {
      renderEnvs()
      if (state.item && state.item.kind === 'env' && state.item.id === added.id) renderEnvDetail(added)
      toast(res.ok ? '连接正常：' + res.message : '已添加，但连接失败：' + res.message, res.ok ? 'ok' : 'err', res.ok ? 4000 : 7000)
    })
  }
}
