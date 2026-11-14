// zzwork 环境扫描：Skills 全局(~/.zzwork/skills)、MCP(~/.zzwork/mcp.json + 任务级)、WSL 枚举、远程同步
const fs = require('fs')
const path = require('path')
const os = require('os')
const { exec } = require('child_process')

const GLOBAL_ENV = 'global'
const CACHE = new Map()
const TTL = 10 * 60 * 1000

function sh(cmd, timeout) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeout || 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)))
  })
}
function cacheGet(key) {
  const v = CACHE.get(key)
  if (v && Date.now() - v.at < TTL) return v.value
  return undefined
}
function cacheSet(key, value) { CACHE.set(key, { at: Date.now(), value }) }
function clearCache() { CACHE.clear() }

function envExec(env, posixCmd) {
  if (env.kind === 'wsl') return sh(`wsl.exe -d ${env.config.distro} -- sh -lc ${JSON.stringify(posixCmd)}`, 15000)
  if (env.kind === 'ssh') {
    const user = env.config.user ? `${env.config.user}@` : ''
    return sh(`ssh -o BatchMode=yes -o ConnectTimeout=5 ${user}${env.config.host} ${JSON.stringify(posixCmd)}`, 18000)
  }
  return null
}

function skillsRoot(home) { return path.join(home || os.homedir(), '.zzwork', 'skills') }
function globalMcpPath(home) { return path.join(home || os.homedir(), '.zzwork', 'mcp.json') }

// ---------- SKILL.md ----------
function parseSkillText(raw, file, source) {
  let name = '', description = '', body = raw
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (m) {
    body = raw.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/)
      if (!kv) continue
      const k = kv[1].toLowerCase()
      const v = kv[2].trim().replace(/^["']|["']$/g, '')
      if (k === 'name') name = v
      else if (k === 'description') description = v
    }
  }
  if (!name) name = path.basename(path.dirname(file)) || file
  if (!description) {
    const first = body.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'))
    description = (first || '').slice(0, 200)
  }
  return { name, description, path: file, source: source || 'user' }
}

function walkSkills(root, out, depth) {
  if (depth > 5) return
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = path.join(root, e.name)
    if (e.isDirectory()) {
      walkSkills(p, out, depth + 1)
      // 目录即 skill：有 SKILL.md 才收录
    } else if (e.isFile() && e.name === 'SKILL.md') {
      try { out.push(parseSkillText(fs.readFileSync(p, 'utf8'), p, 'user')) } catch {}
    }
  }
}

// 全局 skills：只在本机 ~/.zzwork/skills
function scanSkillsSync() {
  const out = []
  const root = skillsRoot()
  if (fs.existsSync(root)) walkSkills(root, out, 0)
  return out
}
async function scanSkills() {
  const hit = cacheGet('skills:global')
  if (hit) return hit
  const list = scanSkillsSync()
  cacheSet('skills:global', list)
  return list
}

// ---------- MCP ----------
function normalizeServers(obj, topKey, originPath, out) {
  if (!obj || typeof obj !== 'object') return
  const servers = obj[topKey]
  if (!servers || typeof servers !== 'object') return
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    let type = cfg.type
    if (!type) type = cfg.url ? 'http' : 'stdio'
    const config = {}
    for (const k of ['command', 'args', 'env', 'envFile', 'cwd', 'url', 'headers', 'oauth']) {
      if (cfg[k] !== undefined) config[k] = cfg[k]
    }
    out.push({ name, type, config, source: 'discovered', origin_path: originPath })
  }
}
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// 全局 MCP：~/.zzwork/mcp.json + 任务级 .mcp.json / .vscode/mcp.json（本机路径）
async function scanMcp(taskPath) {
  const key = 'mcp:global:' + (taskPath || '')
  const hit = cacheGet(key)
  if (hit) return hit
  const out = []
  const userCfg = readJsonSafe(globalMcpPath())
  if (userCfg) normalizeServers(userCfg, 'mcpServers', '~/.zzwork/mcp.json', out)
  if (taskPath) {
    const proj = readJsonSafe(path.join(taskPath, '.mcp.json'))
    if (proj) normalizeServers(proj, 'mcpServers', '.mcp.json', out)
    const vscode = readJsonSafe(path.join(taskPath, '.vscode', 'mcp.json'))
    if (vscode) normalizeServers(vscode, 'servers', '.vscode/mcp.json', out)
  }
  cacheSet(key, out)
  return out
}

// ---------- WSL 发行版枚举 ----------
async function listWslDistros() {
  const hit = cacheGet('wsl:distros')
  if (hit) return hit
  let out = await sh('wsl.exe --list --quiet', 10000)
  let list = []
  if (out) {
    // wsl.exe 输出是 UTF-16LE
    if (out.includes('\x00')) out = Buffer.from(out, 'binary').swap16().toString('utf16le')
    list = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/docker/i.test(s))
  }
  cacheSet('wsl:distros', list)
  return list
}

// ---------- 远程同步：skills（按需，把本机 ~/.zzwork/skills/<name> 拷到远端同名目录）----------
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name)
    if (e.isDirectory()) copyDirRecursive(s, d)
    else fs.copyFileSync(s, d)
  }
}

async function syncSkillsToEnv(env, skillDirs) {
  if (!skillDirs || !skillDirs.length) return { ok: true, synced: 0 }
  const names = skillDirs.map((p) => path.basename(path.dirname(p))).filter(Boolean)
  if (env.kind === 'local' || env.kind === undefined) return { ok: true, synced: 0 }
  if (env.kind === 'wsl') {
    // 通过 \\wsl$ UNC 直接拷贝
    try {
      const homeOut = await envExec(env, 'printf %s "$HOME"')
      const home = (homeOut || '').trim()
      if (!home) return { ok: false, error: '无法取到远端 HOME' }
      const m = home.match(/^\/(mnt\/[a-z])\/(.*)$/i) // Windows 下 home 通常是 /home/user
      const winHome = home.replace(/\//g, '\\')
      const unc = `\\\\wsl$\\${env.config.distro}${winHome}\\.zzwork\\skills`
      fs.mkdirSync(unc, { recursive: true })
      let n = 0
      for (const dir of skillDirs) {
        const name = path.basename(dir)
        copyDirRecursive(dir, path.join(unc, name))
        n++
      }
      return { ok: true, synced: n }
    } catch (e) { return { ok: false, error: e.message } }
  }
  if (env.kind === 'ssh') {
    try {
      let n = 0
      for (const dir of skillDirs) {
        const name = path.basename(dir)
        // 逐文件 cat 写入远端
        const files = []
        ;(function walk(p, rel) {
          for (const e of fs.readdirSync(p, { withFileTypes: true })) {
            const fp = path.join(p, e.name), rp = rel ? rel + '/' + e.name : e.name
            if (e.isDirectory()) walk(fp, rp)
            else files.push([fp, rp])
          }
        })(dir, '')
        for (const [fp, rp] of files) {
          const content = fs.readFileSync(fp)
          const b64 = content.toString('base64')
          const res = await envExec(env, `mkdir -p "$HOME/.zzwork/skills/${name}" && printf %s ${JSON.stringify(b64)} | base64 -d > "$HOME/.zzwork/skills/${name}/${rp}"`)
          if (res === null) return { ok: false, error: 'ssh 写入失败' }
        }
        n++
      }
      return { ok: true, synced: n }
    } catch (e) { return { ok: false, error: e.message } }
  }
  return { ok: true, synced: 0 }
}

// 任务路径 -> 环境（WSL 路径自动识别发行版）
function resolveTaskEnv(store, task) {
  const envs = store.listEnvironments ? store.listEnvironments() : []
  const p = task && task.path ? task.path : ''
  const wsl = p.match(/^\\\\wsl(?:\.localhost|\$)?\\([^\\]+)/i)
  if (wsl) {
    const distro = wsl[1]
    const found = envs.find((e) => e.kind === 'wsl' && (e.config.distro === distro || e.name === distro))
    if (found) return found
    return { id: `wsl:${distro}`, name: distro, kind: 'wsl', config: { distro } }
  }
  // SSH 环境显式绑定在 task.meta.envId
  if (task && task.meta) {
    try {
      const meta = JSON.parse(task.meta)
      if (meta.envId) {
        const fe = envs.find((e) => e.id === meta.envId)
        if (fe) return fe
      }
    } catch {}
  }
  return envs.find((e) => e.kind === 'local') || { id: 'local', name: '本机', kind: 'local', config: {} }
}

module.exports = { GLOBAL_ENV, scanSkills, scanMcp, resolveTaskEnv, listWslDistros, syncSkillsToEnv, skillsRoot, globalMcpPath, clearCache }
