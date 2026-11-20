// MCP 视图
import { store, mcp as mcpApi, env as envApi, fsapi } from '../lib/api.js'
import { state, emit } from '../lib/state.js'
import { $, esc, ic, refreshIcons } from '../lib/ui.js'
import { reloadMcp } from '../lib/data.js'
import { openModal } from '../components/modal.js'
import { toast } from '../components/toast.js'

export function initMcpView() {
  $('#addMcpBtn').addEventListener('click', addMcp)
}

export function renderMcp() {
  const body = $('#mcpBody')
  const filter = state.filter.trim().toLowerCase()
  const list = state.mcp.filter((m) => !filter || String(m.name).toLowerCase().includes(filter))
  if (!list.length) {
    body.innerHTML = `<div class="empty">${filter ? '没有匹配的 MCP 服务' : '还没有 MCP 服务。可扫描 ~/.zzwork/mcp.json 或手动添加。'}</div>`
    return
  }
  body.innerHTML = list.map((m) => {
    const t = m.config && m.config.lastTest
    const dot = !t ? 'off' : (t.ok ? 'ok' : 'warn')
    const sel = state.mode === 'item' && state.item && state.item.kind === 'mcp' && state.item.id === m.id
    const meta = t ? (t.ok ? `已连接 · ${t.tools} 个工具` : '连接失败') : '未测试'
    return `<div class="item ${sel ? 'sel' : ''}" data-mcp="${esc(m.id)}">
      <div class="top">${ic('plug', 14).replace('<i ', '<i style="color:#7dd3fc;')}<span class="nm">${esc(m.name)}</span><span class="dot ${dot}"></span></div>
      <div class="meta"><span>${esc(m.type || 'stdio')}</span><span>${esc(meta)}</span></div>
    </div>`
  }).join('')
  refreshIcons()
  body.querySelectorAll('.item[data-mcp]').forEach((el) => {
    el.addEventListener('click', () => emit('open-item', { kind: 'mcp', id: el.getAttribute('data-mcp') }))
  })
}

export function renderMcpDetail(id) {
  const m = state.mcp.find((x) => x.id === id)
  const bodyEl = $('#itemBody')
  if (!m) { bodyEl.innerHTML = `<div class="empty">MCP 服务不存在</div>`; return }
  const cfg = m.config || {}
  const t = cfg.lastTest
  const target = m.type === 'http' || m.type === 'sse' ? (cfg.url || '') : [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' ')
  const tools = t && t.ok && Array.isArray(t.toolNames) ? t.toolNames : []
  bodyEl.innerHTML = `
    <div class="hd"><h2>${esc(m.name)}</h2><span class="pill b">MCP</span>
      <span class="pill ${t ? (t.ok ? 'g' : '') : ''}">${t ? (t.ok ? '已连接' : '连接失败') : '未测试'}</span></div>
    <div class="pth">${esc(m.type || 'stdio')} · ${esc(target || '未配置')}</div>
    <div class="sec">配置</div>
    <div class="box"><div class="l">传输方式</div><div class="h">stdio 在本机启动进程；http 连接远端服务</div>
      <div class="frow"><div class="ftxt" style="max-width:140px">${esc(m.type || 'stdio')}</div></div></div>
    <div class="box"><div class="l">命令 / 地址</div><div class="h">启动命令或服务 URL</div>
      <div class="frow"><div class="ftxt">${esc(target)}</div></div></div>
    ${t ? `<div class="box"><div class="l">最近一次测试</div><div class="h">${esc(new Date(t.at).toLocaleString('zh-CN', { hour12: false }))} · ${t.ok ? '成功，' + t.tools + ' 个工具' : esc(t.error || '失败')}</div></div>` : ''}
    <div class="sec">已发现的工具</div>
    ${tools.length ? tools.map((n) => `<div class="lrow">${ic('wrench', 13)}<span class="nm">${esc(n)}</span></div>`).join('') : `<div class="hint">${t && !t.ok ? '连接失败，暂无工具' : '尚未测试'}</div>`}
    <div class="frow" style="margin-top:12px">
      <button class="btn pri" id="testMcpBtn">测试连接</button>
      <button class="btn" id="openMcpConfig">打开配置文件</button>
      <button class="btn" id="delMcp" style="color:#f87171">删除</button>
    </div>`
  refreshIcons()

  $('#testMcpBtn').addEventListener('click', async () => {
    const btn = $('#testMcpBtn')
    btn.disabled = true
    btn.textContent = '测试中…'
    try {
      const r = await mcpApi('test', { server: m })
      await reloadMcp()
      renderMcp()
      renderMcpDetail(id)
      toast(r.ok ? `连接成功，发现 ${r.tools} 个工具` : '连接失败：' + (r.error || '未知错误'), r.ok ? 'info' : 'err', 4000)
    } catch (e) {
      toast('测试失败：' + e.message, 'err', 4000)
      btn.disabled = false
      btn.textContent = '测试连接'
    }
  })
  $('#openMcpConfig').addEventListener('click', async () => {
    try {
      const p = await envApi('paths')
      await fsapi('openPath', { path: p.mcpJson })
    } catch (e) { toast('无法打开配置文件：' + e.message, 'err') }
  })
  $('#delMcp').addEventListener('click', async () => {
    await store('mcp.delete', { id: m.id })
    await reloadMcp()
    renderMcp()
    emit('close-item')
    toast('已删除 MCP 服务')
  })
}

async function addMcp() {
  const r = await openModal({
    title: '添加 MCP 服务',
    fields: [
      { name: 'name', label: '名称', type: 'text', required: true, placeholder: '例如 filesystem' },
      { name: 'type', label: '传输方式', type: 'select', options: [['stdio', 'stdio · 本机进程'], ['http', 'http · 远端服务']], value: 'stdio' },
      { name: 'command', label: '启动命令', type: 'text', placeholder: '例如 npx -y @modelcontextprotocol/server-filesystem D:\\work', hint: '仅 stdio 需要' },
      { name: 'url', label: '服务 URL', type: 'text', placeholder: '例如 https://mcp.example.com/github', hint: '仅 http 需要' }
    ],
    okText: '添加'
  })
  if (!r) return
  let config
  if (r.type === 'http') {
    if (!r.url.trim()) return toast('请填写服务 URL', 'err')
    config = { url: r.url.trim(), headers: {} }
  } else {
    if (!r.command.trim()) return toast('请填写启动命令', 'err')
    config = { command: r.command.trim(), args: [], env: {} }
  }
  await store('mcp.upsert', { server: { env_id: 'global', name: r.name.trim(), type: r.type, config, source: 'user', origin_path: '' } })
  await reloadMcp()
  renderMcp()
  toast('已添加 MCP 服务')
}
