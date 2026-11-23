// 环境服务：Skills/MCP 扫描入库、执行体探测/安装、连接测试、WSL 发行版
const fs = require('fs')
const { exec, execFile } = require('child_process')
const { scanSkills, scanSkillsRemote, scanMcp, listWslDistros, clearCache, GLOBAL_ENV, skillsRoot, skillRoots, globalMcpPath, parseRemotePath } = require('../../core/envs')
const { detectAgents, clearDetectCache, KNOWN_AGENTS, envPathShell } = require('../../core/agentRunner')
const { runRemote } = require('../../core/sshconn')
const remotefs = require('./remotefs')
const secrets = require('./secrets')
const { getStore } = require('./store')

function sshKey(envId) { return 'zzwork.ssh.' + envId }
// 远端 posix 路径 -> 本应用可路由的方案路径（SSH: ssh://id/path；WSL: UNC）
function remoteSchemePath(env, posix) {
  if (env.kind === 'ssh') return 'ssh://' + env.id + posix
  return '\\\\wsl$\\' + (env.config.distro || '') + String(posix).replace(/\//g, '\\')
}

// UI 传来的环境描述 -> 内部环境对象（附带密码）
function buildEnv(desc) {
  const d = desc || {}
  const cfg = d.config || {}
  const env = {
    id: d.id || '',
    kind: d.kind || 'local',
    distro: d.distro || cfg.distro,
    host: d.host || cfg.host,
    where: 'auto',
    config: {
      distro: d.distro || cfg.distro,
      host: d.host || cfg.host,
      user: d.user || cfg.user,
      port: d.port || cfg.port,
      keyPath: cfg.keyPath
    }
  }
  env.secret = env.kind === 'ssh' && env.id ? (secrets.get(sshKey(env.id)) || '') : ''
  return env
}

// 扫描结果入库：清掉扫描目录下已不存在的旧记录（含去重前的重复项），手动添加的条目不动
function isScannedSkillPath(p) {
  const s = String(p || '').replace(/\//g, '\\').toLowerCase()
  return s.includes('\\.zzwork\\skills\\') || s.includes('\\.agents\\skills\\') || s.includes('\\.claude\\skills\\')
}
function replaceEnvSkills(envId, list) {
  const S = getStore()
  const keep = new Set(list.map((x) => x.path))
  for (const old of S.listSkills(envId)) {
    if (!keep.has(old.path) && isScannedSkillPath(old.path)) {
      try { S.deleteSkill(old.id) } catch {}
    }
  }
  for (const x of list) {
    S.upsertSkill({ env_id: envId, name: x.name, path: x.path, source: 'user', description: x.description })
  }
}

async function scan(opts) {
  const withRemote = !opts || opts.remote !== false
  const S = getStore()
  clearCache()
  let skillCount = 0
  let mcpCount = 0
  try {
    const list = await scanSkills()
    replaceEnvSkills(GLOBAL_ENV, list)
    skillCount = list.length
  } catch (e) { console.error('[zzwork] skill 扫描失败: ' + e.message) }
  // WSL / SSH 环境各自扫描远端 skills，按环境 id 入库
  if (withRemote) {
    try {
      const remoteEnvs = (S.listEnvironments() || []).filter((e) => e.kind === 'wsl' || e.kind === 'ssh')
      for (const raw of remoteEnvs) {
        let cfg = raw.config
        if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg || '{}') } catch { cfg = {} } }
        const env = buildEnv({ id: raw.id, kind: raw.kind, config: cfg || {} })
        try {
          const list = await scanSkillsRemote(env)
          replaceEnvSkills(env.id, list.map((sk) => ({ ...sk, path: remoteSchemePath(env, sk.path) })))
          skillCount += list.length
        } catch (e) { console.error(`[zzwork] ${raw.name} skill 扫描失败: ` + e.message) }
      }
    } catch (e) { console.error('[zzwork] 远端 skill 扫描失败: ' + e.message) }
  }
  const activeId = S.getSetting('activeTaskId', '')
  const task = activeId && S.getTask(activeId)
  if (task) {
    try {
      const list = await scanMcp(task.path)
      for (const m of list) {
        S.upsertMcp({ env_id: GLOBAL_ENV, name: m.name, type: m.type, config: m.config, source: m.source, origin_path: m.origin_path })
      }
      mcpCount = list.length
    } catch (e) { console.error('[zzwork] mcp 扫描失败: ' + e.message) }
  }
  return { skills: skillCount, mcp: mcpCount }
}

// 真实连接测试：WSL 启动发行版执行命令；SSH 用密码（ssh2）或系统密钥登录
function testConnection(env) {
  if (env.kind === 'local') return Promise.resolve({ ok: true, message: '本机环境' })
  if (env.kind === 'wsl') {
    const distro = /^[\w.-]+$/.test(String(env.config.distro || '')) ? env.config.distro : ''
    if (!distro) return Promise.resolve({ ok: false, message: 'WSL 发行版名无效' })
    return new Promise((resolve) => {
      execFile('wsl.exe', ['-d', distro, '--', 'sh', '-lc', 'printf ZZOK'],
        { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (!err && String(stdout).includes('ZZOK')) return resolve({ ok: true, message: 'WSL 连接正常 · ' + distro })
          const detail = String(stderr || (err && err.message) || '').trim().slice(0, 500)
          resolve({ ok: false, message: 'WSL 连接失败：' + (detail || '无法启动发行版 ' + distro) })
        })
    })
  }
  if (env.kind === 'ssh') {
    if (!env.config.host) return Promise.resolve({ ok: false, message: '未配置 SSH 主机' })
    return runRemote(env, env.secret, 'printf ZZOK', 15000).then((r) => {
      if (r.ok && String(r.stdout).includes('ZZOK')) {
        const who = (env.config.user ? env.config.user + '@' : '') + env.config.host
        return { ok: true, message: 'SSH 连接正常 · ' + who }
      }
      const detail = String(r.error || r.stderr || '').trim().slice(0, 500)
      return { ok: false, message: detail || 'SSH 连接失败' }
    })
  }
  return Promise.resolve({ ok: true, message: '' })
}

const INSTALL_PKGS = Object.fromEntries(KNOWN_AGENTS.filter((a) => a.pkg).map((a) => [a.id, a.pkg]))

async function detect(envDesc) {
  const env = buildEnv(envDesc)
  const persist = (list) => {
    if (!env.id) return
    try { getStore().setSetting('zz:detect:' + env.id, JSON.stringify({ list, at: Date.now() })) } catch {}
  }
  // 远端环境先真实连一次，连不上时把原因带回 UI，而不是静默显示 0 个执行体
  if (env.kind !== 'local') {
    const t = await testConnection(env)
    if (!t.ok) {
      return {
        ids: [],
        error: t.message,
        list: [
          { id: 'builtin', name: '内置模型聊天', ok: true, pkg: '' },
          ...KNOWN_AGENTS.map((a) => ({ id: a.id, name: a.name || a.id, ok: false, pkg: a.pkg || '' }))
        ]
      }
    }
  }
  const ids = await detectAgents(env, !!envDesc.force)
  // 本机探测偶发为空（并发子进程 / --version 超时）：若已有可用缓存，保留缓存，
  // 别把「全部已安装」误显示成「全部未安装」。手动刷新（force）时以真实结果为准。
  if (env.kind === 'local' && !envDesc.force && !ids.length) {
    let prev = null
    try {
      const raw = getStore().getSetting('zz:detect:' + env.id, '')
      if (raw) { const d = JSON.parse(raw); if (d && Array.isArray(d.list)) prev = d.list }
    } catch {}
    if (prev && prev.some((a) => a.ok && a.id !== 'builtin')) {
      return { ids: prev.filter((a) => a.ok).map((a) => a.id), list: prev, cached: true }
    }
  }
  const list = [
    { id: 'builtin', name: '内置模型聊天', ok: true, pkg: '' },
    ...KNOWN_AGENTS.map((a) => ({ id: a.id, name: a.name || a.id, ok: ids.includes(a.id), pkg: a.pkg || '' }))
  ]
  persist(list)
  return { ids, list }
}

// 一键安装：npm 全局安装（本机 / WSL / SSH）；包名只来自白名单
// 远端必须用补全后的 PATH：裸 sh -lc 会落到系统旧版 node（如 Ubuntu 的 v10）且全局目录通常无写权限
const NODE_ENV_HINT = /EACCES|Unsupported engine|Not compatible with your version of node/i
function installResult(ok, code, out) {
  let output = String(out || '')
  if (!ok && NODE_ENV_HINT.test(output)) {
    output += '\n\n提示：远端当前 Node/npm 版本过旧或无全局写权限。请先通过 nvm/fnm 安装 Node ≥ 22（并确保其在 PATH 中），再重试安装。'
  }
  return { ok, code, output: output.slice(-4000) }
}
function install(envDesc, agentId) {
  const pkg = INSTALL_PKGS[agentId]
  if (!pkg) return Promise.resolve({ ok: false, output: '该执行体暂不支持一键安装，请手动安装。' })
  const env = buildEnv(envDesc)
  const base = `npm install -g ${pkg}`
  if (env.kind === 'ssh') {
    if (!env.config.host) return Promise.resolve({ ok: false, output: 'SSH 主机名无效' })
    return runRemote(env, env.secret, envPathShell(base), 300000).then((r) => {
      if (r.ok) clearDetectCache()
      const out = String(r.stdout || '') + String(r.stderr || '')
      return installResult(r.ok, r.code, out || r.error || '')
    })
  }
  if (env.kind === 'wsl') {
    const distro = /^[\w.-]+$/.test(String(env.config.distro || '')) ? env.config.distro : ''
    if (!distro) return Promise.resolve({ ok: false, output: 'WSL 发行版名无效' })
    return new Promise((resolve) => {
      execFile('wsl.exe', ['-d', distro, '--', 'sh', '-c', envPathShell(base)],
        { timeout: 300000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) clearDetectCache()
          resolve(installResult(!err, err ? (err.code || 1) : 0, String(stdout || '') + String(stderr || '')))
        })
    })
  }
  return new Promise((resolve) => {
    exec(base, { timeout: 300000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) clearDetectCache()
        resolve(installResult(!err, err ? (err.code || 1) : 0, String(stdout || '') + String(stderr || '')))
      })
  })
}

function readSkill(file) {
  const hit = getStore().listSkills().find((s) => s.path === file)
  if (!hit) throw new Error('未登记的 Skill 文件')
  const rp = parseRemotePath(hit.path)
  if (rp) return remotefs.readFile(rp.envId, rp.remotePath)
  const st = fs.statSync(hit.path)
  if (st.size > 512 * 1024) return fs.readFileSync(hit.path, 'utf8').slice(0, 512 * 1024)
  return fs.readFileSync(hit.path, 'utf8')
}

// 远端 HOME 目录（用于新建任务时给出默认目录）
function homeDir(envDesc) {
  const env = buildEnv(envDesc)
  if (env.kind === 'wsl') {
    const distro = /^[\w.-]+$/.test(String(env.config.distro || '')) ? env.config.distro : ''
    if (!distro) return Promise.resolve({ ok: false, home: '' })
    return new Promise((resolve) => {
      execFile('wsl.exe', ['-d', distro, '--', 'sh', '-c', 'echo $HOME'],
        { timeout: 10000, windowsHide: true }, (err, stdout) => resolve({ ok: !err, home: String(stdout || '').trim() }))
    })
  }
  if (env.kind === 'ssh') {
    return runRemote(env, env.secret, 'echo $HOME', 10000).then((r) => ({ ok: r.ok, home: String(r.stdout || '').trim() }))
  }
  return Promise.resolve({ ok: false, home: '' })
}

module.exports = {
  scan,
  detect,
  test: (p) => testConnection(buildEnv(p || {})),
  install,
  homeDir,
  sshKey,
  register(ipcMain) {
    ipcMain.handle('zz:env:scan', (_e, p) => scan(p || {}))
    ipcMain.handle('zz:env:detect', (_e, p) => detect(p || {}))
    ipcMain.handle('zz:env:test', (_e, p) => testConnection(buildEnv(p || {})))
    ipcMain.handle('zz:env:install', (_e, p) => install(p || {}, p && p.agentId))
    ipcMain.handle('zz:env:wsl', () => listWslDistros())
    ipcMain.handle('zz:env:home', (_e, p) => homeDir(p || {}))
    ipcMain.handle('zz:env:clearCache', () => { clearCache(); return true })
    ipcMain.handle('zz:env:readSkill', (_e, p) => readSkill(p.path))
    ipcMain.handle('zz:env:paths', () => ({ skillsRoot: skillsRoot(), skillRoots: skillRoots(), mcpJson: globalMcpPath(), globalEnv: GLOBAL_ENV }))
  }
}
