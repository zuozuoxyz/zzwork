// 工作区变更感知：Git 仓库取提交/工作区差异；普通目录用文件快照对比
// 检查点按会话保存，只带入"自该会话上次成功回合以来"的改动
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { resolveEnv } = require('../../core/agentRunner')

const DEFAULT_BUDGET = 10000
const MAX_FILES = 800
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'release', 'dist', 'build', '.zzwork', '.next',
  'target', '.venv', 'venv', '__pycache__', '.idea', '.vs', '.cache', 'coverage'])
const SKIP_FILES = /(^|[\\/])(\.env(\..*)?|.*\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|7z|exe|dll|so|dylib|class|jar|woff2?|ttf|mp4|mp3|lock))$/i

function parseMeta(s) {
  if (!s) return {}
  if (typeof s === 'object') return s
  try { return JSON.parse(s) } catch { return {} }
}

function runFile(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeout || 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout || '')))
  })
}

// git diff --no-index 有差异时退出码为 1，需要保留 stdout
function runFileAny(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeout || 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(String(stdout || '')))
  })
}

function posixGitCmd(unixPath, args) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  return `cd ${q(unixPath)} && git ${args.map((a) => q(a)).join(' ')} 2>/dev/null`
}

function gitFor(env, taskPath) {
  const remotePath = env.unixPath || taskPath
  if (env.kind === 'wsl') return (list) => runFile('wsl.exe', ['-d', env.distro, '--', 'sh', '-lc', posixGitCmd(remotePath, list)], 12000)
  if (env.kind === 'ssh') {
    const c = env.config || {}
    const user = env.user || c.user, host = env.host || c.host, port = env.port || c.port
    const target = user ? `${user}@${host}` : String(host)
    const portArgs = port ? ['-p', String(port)] : []
    return (list) => runFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...portArgs, target, posixGitCmd(remotePath, list)], 15000)
  }
  return (list) => runFile('git', ['-C', taskPath, ...list])
}

async function hashFile(file) {
  try { return crypto.createHash('sha1').update(await fs.promises.readFile(file)).digest('hex').slice(0, 12) } catch { return '' }
}

function sigOf(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16)
}

// 异步遍历（fs.promises）避免大目录同步读取阻塞主进程事件循环造成界面卡顿
async function snapshotTree(root) {
  const out = {}
  let n = 0
  const walk = async (dir, rel, depth) => {
    if (n >= MAX_FILES || depth > 6) return
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (n >= MAX_FILES) break
      const name = e.name
      const full = path.join(dir, name)
      const rp = rel ? rel + '/' + name : name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        await walk(full, rp, depth + 1)
      } else if (e.isFile()) {
        if (SKIP_FILES.test(rp)) continue
        let st
        try { st = await fs.promises.stat(full) } catch { continue }
        out[rp] = [st.size, Math.round(st.mtimeMs), st.size <= 262144 ? await hashFile(full) : '']
        n++
      }
    }
  }
  await walk(root, '', 0)
  return out
}

function diffSnapshots(prev, next) {
  const added = [], modified = [], deleted = []
  for (const [p, v] of Object.entries(next)) {
    const old = prev[p]
    if (!old) added.push(p)
    else if (old[0] !== v[0] || old[2] !== v[2]) modified.push(p)
  }
  for (const p of Object.keys(prev)) if (!next[p]) deleted.push(p)
  return { added, modified, deleted }
}

function cap(text, max) {
  const s = String(text || '').trim()
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + `\n…（已截断 ${s.length - max} 字符）`
}

function listLines(text, max) {
  const lines = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max) }
}

// 工作区每个脏文件的指纹：有 diff 块用其摘要；未跟踪用 'U'；其余用状态码。
// 用来在回合结束时记录基线，下次 collect 时把已基线（AI 自己改的）文件剔除。
function fileSig(blocks, p, code) {
  const block = blocks.get(p)
  if (block) return 'B:' + sigOf(block)
  return String(code).includes('?') ? 'U' : 'C:' + code
}

async function collectGit(task, env, ck, budget) {
  const git = gitFor(env, task.path)
  const inside = (await git(['rev-parse', '--is-inside-work-tree']) || '').trim()
  if (inside !== 'true') return null
  const top = (await git(['rev-parse', '--show-toplevel']) || '').trim()
  if (top && env.kind === 'local') {
    const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '')
    if (norm(top) !== norm(task.path)) return null
  }

  const head = (await git(['rev-parse', 'HEAD']) || '').trim()
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim()
  const prev = ck && ck.head
  const baseSnap = ck && ck.snap && typeof ck.snap === 'object' ? ck.snap : null
  const sections = []
  let commitCount = 0

  if (prev && head && prev !== head) {
    const log = await git(['log', '--oneline', `${prev}..${head}`])
    const stat = await git(['diff', '--stat', `${prev}..${head}`])
    const ll = listLines(log, 20)
    commitCount = ll.lines.length
    sections.push('自上次请求以来的新提交:\n' + cap(ll.lines.join('\n') + (ll.more ? `\n…另有 ${ll.more} 个提交` : ''), 2400))
    if (stat && stat.trim()) sections.push('提交改动统计:\n' + cap(stat, 2400))
  }

  const statusRaw = (await git(['status', '--porcelain=v1']) || '')
  const statusMap = parseGitStatus(statusRaw)
  const patchRaw = (await git(['diff', '--no-color', '-U3']) || '') + (await git(['diff', '--cached', '--no-color', '-U3']) || '')
  const blocks = splitPatchBlocks(patchRaw)

  // 只保留"自上次基线以来真正变化"的文件，剔除 AI 自己改过、且其后未再变的文件
  const changed = []
  for (const [p, code] of statusMap.entries()) {
    if (baseSnap && Object.prototype.hasOwnProperty.call(baseSnap, p) && baseSnap[p] === fileSig(blocks, p, code)) continue
    changed.push([p, code])
  }

  if (changed.length) {
    const shown = changed.slice(0, 60)
    sections.push('未提交变更:\n' + cap(shown.map(([p, code]) => `${code} ${p}`).join('\n') + (changed.length > 60 ? `\n…另有 ${changed.length - 60} 个文件` : ''), 2400))
    // 聚合统计只在无基线时给出，避免把已基线的 AI 改动混入
    if (!baseSnap) {
      const diffStat = (await git(['diff', '--stat']) || '') + (await git(['diff', '--cached', '--stat']) || '')
      if (diffStat.trim()) sections.push('工作区统计:\n' + cap(diffStat, 2400))
    }
  }

  let patch = ''
  if (prev && head && prev !== head) patch += (await git(['diff', `${prev}..${head}`]) || '')
  if (baseSnap) {
    const keep = new Set(changed.map(([p]) => p))
    patch += [...blocks.entries()].filter(([p]) => keep.has(p)).map(([, b]) => b).join('')
  } else {
    patch += patchRaw
  }
  if (patch.trim()) {
    const used = sections.join('\n\n').length
    const remaining = Math.max(2000, budget - used)
    sections.push('差异（截断）:\n' + cap(patch, remaining))
  }

  const changedCount = changed.length
  const summaryBits = []
  if (commitCount) summaryBits.push(`${commitCount} 个新提交`)
  if (changedCount) summaryBits.push(`${changedCount} 个未提交文件`)
  const summary = summaryBits.length
    ? `Git（${branch || 'detached'}）：${summaryBits.join('，')}`
    : `Git（${branch || 'detached'}）：工作区无变化`

  const text = sections.length
    ? `<workspace_changes>\n${cap(sections.join('\n\n'), budget)}\n</workspace_changes>`
    : ''
  const snap = {}
  for (const [p, code] of statusMap.entries()) snap[p] = fileSig(blocks, p, code)
  return {
    text,
    summary,
    count: commitCount + changedCount,
    detail: sections.join('\n\n'),
    ck: { kind: 'git', head, branch, snap, at: Date.now() }
  }
}

async function collectSnapshot(task, ck, budget) {
  const prev = ck && ck.snapshot
  const next = await snapshotTree(task.path)
  const p = prev && typeof prev === 'object' ? prev : null
  if (!p) {
    return {
      text: '',
      summary: '已建立文件基线，下次请求起会带入改动',
      count: 0,
      detail: '',
      ck: { kind: 'snapshot', snapshot: next, at: Date.now() }
    }
  }
  const d = diffSnapshots(p, next)
  const total = d.added.length + d.modified.length + d.deleted.length
  if (!total) {
    return { text: '', summary: '工作区无变化', count: 0, detail: '', ck: { kind: 'snapshot', snapshot: next, at: Date.now() } }
  }
  const lines = []
  if (d.added.length) lines.push('新增文件:\n' + d.added.slice(0, 40).join('\n') + (d.added.length > 40 ? `\n…另有 ${d.added.length - 40} 个` : ''))
  if (d.modified.length) lines.push('修改文件:\n' + d.modified.slice(0, 40).join('\n') + (d.modified.length > 40 ? `\n…另有 ${d.modified.length - 40} 个` : ''))
  if (d.deleted.length) lines.push('删除文件:\n' + d.deleted.slice(0, 40).join('\n') + (d.deleted.length > 40 ? `\n…另有 ${d.deleted.length - 40} 个` : ''))
  const detail = lines.join('\n\n')
  return {
    text: `<workspace_changes>\n以下文件自上次请求以来发生变化（非 Git 目录，仅列出路径，请按需读取）：\n${cap(detail, budget)}\n</workspace_changes>`,
    summary: `非 Git 工作区：${d.added.length} 新增 / ${d.modified.length} 修改 / ${d.deleted.length} 删除`,
    count: total,
    detail,
    ck: { kind: 'snapshot', snapshot: next, at: Date.now() }
  }
}

async function collect({ task, agent, env: envIn, ck, budget }) {
  const limit = budget || DEFAULT_BUDGET
  if (!task || !task.path) return { text: '', summary: '', count: 0, detail: '', ck: null }
  const env = envIn || resolveEnv(task.path, agent || {})
  try {
    const g = await collectGit(task, env, ck, limit)
    if (g) return g
  } catch {}
  if (env.kind !== 'local') {
    return { text: '', summary: '远程环境暂不检测文件快照', count: 0, detail: '', ck: null }
  }
  try { return await collectSnapshot(task, ck, limit) } catch (e) {
    return { text: '', summary: '变更检测失败：' + e.message, count: 0, detail: '', ck: null }
  }
}

function saveCheckpoint(S, sessionId, ck) {
  if (!sessionId || !ck) return
  const s = S.getSession(sessionId)
  if (!s) return
  const meta = parseMeta(s.meta)
  meta.ck = ck
  S.updateSession(sessionId, { meta: JSON.stringify(meta) })
}

// 回合结束后的基线：记录"回合结束后"的工作区状态（含 AI 本轮改动），
// 下次 collect 以此为对照，从而不把 AI 自己改动的文件再次带入对话。
async function gitCheckpoint(task, env) {
  const git = gitFor(env, task.path)
  const inside = (await git(['rev-parse', '--is-inside-work-tree']) || '').trim()
  if (inside !== 'true') return null
  const top = (await git(['rev-parse', '--show-toplevel']) || '').trim()
  if (top && env.kind === 'local') {
    const norm = (p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '')
    if (norm(top) !== norm(task.path)) return null
  }
  const head = (await git(['rev-parse', 'HEAD']) || '').trim()
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim()
  const statusRaw = (await git(['status', '--porcelain=v1']) || '')
  const patchRaw = (await git(['diff', '--no-color', '-U3']) || '') + (await git(['diff', '--cached', '--no-color', '-U3']) || '')
  const blocks = splitPatchBlocks(patchRaw)
  const snap = {}
  for (const [p, code] of parseGitStatus(statusRaw).entries()) snap[p] = fileSig(blocks, p, code)
  return { kind: 'git', head, branch, snap, at: Date.now() }
}

async function checkpoint(task, env) {
  if (!task || !task.path) return null
  const e = env || resolveEnv(task.path, {})
  try {
    const g = await gitCheckpoint(task, e)
    if (g) return g
  } catch {}
  if (e.kind !== 'local') return null
  try { return { kind: 'snapshot', snapshot: await snapshotTree(task.path), at: Date.now() } } catch { return null }
}

// 回合结束：把当下（含 AI 本轮改动）的状态记为"下次注入"的基线。
// 非 Git 本地目录用同步快照，保证回合结束即落库、下次请求立刻读到；
// Git 目录需要异步 git 查询，后台完成后保存（不影响回合结束、按钮态）。
async function saveBaseline(S, sessionId, task, env, modeHint) {
  if (!sessionId || !task || !task.path) return
  if (modeHint === 'git') {
    try { const ck = await gitCheckpoint(task, env); if (ck) saveCheckpoint(S, sessionId, ck) } catch {}
    return
  }
  if (!env || env.kind === 'local') {
    try { saveCheckpoint(S, sessionId, { kind: 'snapshot', snapshot: await snapshotTree(task.path), at: Date.now() }) } catch {}
  }
}

// ---------- 单次对话回合的文件差异（对话后展示） ----------

const TURN_TEXT_LIMIT = 256 * 1024
const TURN_MAX_FILES = 400
// patch 存在消息 meta 里供聊天内联展示 + 在编辑区标签页查看完整内容。
// 存储级上限（远大于内联展示的 2400，内联截断改在渲染层做），避免超大 diff 撑爆 DB。
const STORE_PATCH_LIMIT = 200000
const STORE_PATCH_BUDGET = 1500000

// WSL 任务目录通过 \\wsl$ 共享可本地直读；只有 ssh:// 必须走远程
function readableLocally(taskPath, env) {
  if (!env || env.kind === 'local') return true
  if (env.kind === 'wsl') return /^\\\\wsl/i.test(String(taskPath || ''))
  return false
}

async function readTextSnapshot(root) {
  const out = new Map()
  let n = 0
  const walk = async (dir, rel, depth) => {
    if (n >= TURN_MAX_FILES || depth > 6) return
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (n >= TURN_MAX_FILES) break
      const name = e.name
      const full = path.join(dir, name)
      const rp = rel ? rel + '/' + name : name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        await walk(full, rp, depth + 1)
      } else if (e.isFile()) {
        if (SKIP_FILES.test(rp)) continue
        let st
        try { st = await fs.promises.stat(full) } catch { continue }
        if (st.size > TURN_TEXT_LIMIT) { out.set(rp, { bin: true, text: '' }); n++; continue }
        let buf
        try { buf = await fs.promises.readFile(full) } catch { continue }
        if (buf.includes(0)) out.set(rp, { bin: true, text: '' })
        else out.set(rp, { text: buf.toString('utf8') })
        n++
      }
    }
  }
  await walk(root, '', 0)
  return out
}

function parseGitStatus(text) {
  const map = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim() || line.length < 4) continue
    let p = line.slice(3)
    const arrow = p.indexOf(' -> ')
    if (arrow >= 0) p = p.slice(arrow + 4)
    p = p.replace(/^"|"$/g, '')
    map.set(p, line.slice(0, 2))
  }
  return map
}

function splitPatchBlocks(patchText) {
  const map = new Map()
  for (const block of String(patchText || '').split(/^diff --git /m).slice(1)) {
    const first = block.split(/\r?\n/, 1)[0]
    const m = first.match(/^a\/(.*?) b\/(.*)$/) || first.match(/^a\/(.*)$/)
    if (!m) continue
    map.set(m[2] || m[1], 'diff --git ' + block)
  }
  return map
}

function addDelOf(block) {
  let a = 0, d = 0
  for (const line of String(block || '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) a++
    else if (line.startsWith('-')) d++
  }
  return { adds: a, dels: d }
}

function hunksOnly(diffText) {
  const lines = String(diffText || '').split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith('@@'))
  return i >= 0 ? lines.slice(i).join('\n') : ''
}

async function unifiedDiff(oldText, newText) {
  const dir = path.join(os.tmpdir(), 'zzwdiff-' + crypto.randomBytes(4).toString('hex'))
  const oldFile = path.join(dir, 'old.txt')
  const newFile = path.join(dir, 'new.txt')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(oldFile, oldText)
    fs.writeFileSync(newFile, newText)
    const out = await runFileAny('git', ['diff', '--no-index', '--no-color', '--ignore-cr-at-eol', '--unified=3', '--', oldFile, newFile], 12000)
    return hunksOnly(out)
  } catch {
    return ''
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

function coarsePatch(text, sign, limit) {
  const lines = String(text || '').replace(/\n$/, '').split(/\r?\n/)
  const shown = lines.slice(0, limit || 20000)
  const more = lines.length - shown.length
  return shown.map((l) => sign + l).join('\n') + (more > 0 ? `\n…（另有 ${more} 行）` : '')
}

function capStoredPatch(text) {
  const s = String(text || '')
  return s.length > STORE_PATCH_LIMIT ? s.slice(0, STORE_PATCH_LIMIT) + '\n…（已截断）' : s
}

async function captureTurn(task, env) {
  if (!task || !task.path) return null
  const e = env || resolveEnv(task.path, {})
  if (readableLocally(task.path, e)) {
    try { return { kind: 'local', files: await readTextSnapshot(task.path) } } catch { return null }
  }
  try {
    const git = gitFor(e, task.path)
    const inside = (await git(['rev-parse', '--is-inside-work-tree']) || '').trim()
    if (inside !== 'true') return null
    const status = await git(['status', '--porcelain=v1']) || ''
    return { kind: 'git', head: (await git(['rev-parse', 'HEAD']) || '').trim(), status }
  } catch { return null }
}

function statusOf(code) {
  const c = String(code || '')
  if (c.includes('?') || c.startsWith('A') || c[1] === 'A') return 'added'
  if (c.startsWith('D') || c[1] === 'D') return 'deleted'
  return 'modified'
}

async function localTurnDiff(task, start) {
  const now = await readTextSnapshot(task.path)
  const files = []
  let budget = STORE_PATCH_BUDGET
  const paths = [...new Set([...start.files.keys(), ...now.keys()])].sort()
  for (const rel of paths) {
    const a = start.files.get(rel)
    const b = now.get(rel)
    if (a && b && a.bin && b.bin) continue
    // 仅行尾符（CRLF↔LF）不同不算修改，避免整文件被误报为 -N/+N
    const same = a && b && !a.bin && !b.bin &&
      a.text.replace(/\r\n/g, '\n') === b.text.replace(/\r\n/g, '\n')
    if (same) continue
    const status = !a ? 'added' : !b ? 'deleted' : 'modified'
    const file = { path: rel, status, adds: 0, dels: 0, patch: '' }
    if (a && b && (a.bin || b.bin)) {
      file.binary = true
    } else if (!a) {
      const lines = String(b.text || '').replace(/\n$/, '').split(/\r?\n/).length
      file.adds = lines
      file.patch = budget > 0 ? coarsePatch(b.text, '+') : ''
    } else if (!b) {
      const lines = String(a.text || '').replace(/\n$/, '').split(/\r?\n/).length
      file.dels = lines
      file.patch = budget > 0 ? coarsePatch(a.text, '-') : ''
    } else {
      const hunk = await unifiedDiff(a.text, b.text)
      const counts = addDelOf(hunk)
      file.adds = counts.adds
      file.dels = counts.dels
      file.patch = budget > 0 ? hunksOnly(hunk) : ''
    }
    if (file.patch) file.patch = capStoredPatch(file.patch)
    if (file.patch) budget -= file.patch.length
    files.push(file)
  }
  return { files, note: '' }
}

async function gitTurnDiff(task, env, start) {
  const git = gitFor(env, task.path)
  const statusNow = await git(['status', '--porcelain=v1']) || ''
  const headNow = (await git(['rev-parse', 'HEAD']) || '').trim()
  const patchNow = (await git(['diff', '--no-color', '-U3']) || '') + (await git(['diff', '--cached', '--no-color', '-U3']) || '')
  const prev = parseGitStatus(start.status)
  const now = parseGitStatus(statusNow)
  const blocks = splitPatchBlocks(patchNow)
  const files = []
  let budget = STORE_PATCH_BUDGET
  for (const [p, code] of [...now.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (prev.get(p) === code && !blocks.has(p)) continue
    const block = blocks.get(p) || ''
    const counts = addDelOf(block)
    const file = { path: p, status: statusOf(code), adds: counts.adds, dels: counts.dels, patch: '' }
    if (block && budget > 0) {
      const text = capStoredPatch(block)
      file.patch = text
      budget -= text.length
    }
    files.push(file)
  }
  const note = headNow && start.head && headNow !== start.head ? '存在新提交，仅列出工作区差异' : ''
  return { files, note }
}

async function turnDiff(task, env, start) {
  if (!task || !task.path || !start) return null
  const e = env || resolveEnv(task.path, {})
  try {
    if (start.kind === 'local' && readableLocally(task.path, e)) return await localTurnDiff(task, start)
    if (start.kind === 'git') return await gitTurnDiff(task, e, start)
  } catch {}
  return null
}

module.exports = { collect, saveCheckpoint, saveBaseline, checkpoint, parseMeta, snapshotTree, diffSnapshots, captureTurn, turnDiff }
