// 工作区变更感知：行尾符（CRLF↔LF）差异不应被误报为文件修改
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const changes = require('../../src/main/services/changes.js')

async function withTaskDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzchg-'))
  try { return await fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

export default [
  {
    name: '仅行尾符变化（CRLF↔LF）不算文件修改',
    run: () => withTaskDir(async (dir) => {
      const file = path.join(dir, 'a.txt')
      const lines = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
      fs.writeFileSync(file, lines.join('\r\n') + '\r\n')
      const task = { path: dir }
      const env = { kind: 'local', unixPath: dir }
      const start = await changes.captureTurn(task, env)
      fs.writeFileSync(file, lines.join('\n') + '\n')
      const d = await changes.turnDiff(task, env, start)
      assert.deepEqual(d.files, [], '仅行尾符变化不应产生文件变更')
    })
  },
  {
    name: '真实修改叠加行尾符变化只统计真实改动行',
    run: () => withTaskDir(async (dir) => {
      const file = path.join(dir, 'b.txt')
      const lines = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
      fs.writeFileSync(file, lines.join('\r\n') + '\r\n')
      const task = { path: dir }
      const env = { kind: 'local', unixPath: dir }
      const start = await changes.captureTurn(task, env)
      const edited = lines.map((x) => (x === 'epsilon' ? 'epsilon-已改' : x))
      fs.writeFileSync(file, edited.join('\n') + '\n')
      const d = await changes.turnDiff(task, env, start)
      assert.equal(d.files.length, 1, '应检测到一个文件变更')
      assert.equal(d.files[0].status, 'modified')
      assert.equal(d.files[0].adds, 1, '新增行数应为 1')
      assert.equal(d.files[0].dels, 1, '删除行数应为 1')
    })
  },
  {
    name: '大改动 diff 保留完整文本（供标签页查看）',
    run: () => withTaskDir(async (dir) => {
      const file = path.join(dir, 'big.txt')
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(16)}`)
      fs.writeFileSync(file, lines.join('\n') + '\n')
      const task = { path: dir }
      const env = { kind: 'local', unixPath: dir }
      const start = await changes.captureTurn(task, env)
      // 改动前 800 行，产生远大于内联展示上限（2400 字符）的 diff
      const edited = lines.map((x, i) => (i < 800 ? x + '-已改' : x))
      fs.writeFileSync(file, edited.join('\n') + '\n')
      const d = await changes.turnDiff(task, env, start)
      assert.equal(d.files.length, 1)
      assert.ok(d.files[0].patch.length > 2400, '完整 patch 应超过内联展示上限 2400')
      assert.ok(d.files[0].patch.length <= 200000 + 20, 'patch 受存储级上限约束')
      assert.equal(d.files[0].adds, 800, '新增行数应准确')
      assert.equal(d.files[0].dels, 800, '删除行数应准确')
    })
  },
  {
    name: '本次问答只统计回合内改动，不带入问答前已有的脏文件（Git）',
    run: () => withTaskDir(async (dir) => {
      const g = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', windowsHide: true })
      g(['init', '-q'])
      g(['config', 'user.email', 't@t.t'])
      g(['config', 'user.name', 't'])
      g(['config', 'commit.gpgsign', 'false'])
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n')
      fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n')
      g(['add', '.'])
      g(['commit', '-q', '-m', 'init'])

      const task = { path: dir }
      const env = { kind: 'local', unixPath: dir }

      // 问答前：a.txt 已有未提交改动
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo-CHANGED-BEFORE\nthree\n')
      const start = await changes.captureTurn(task, env)
      assert.ok(start && start.kind === 'git' && start.files instanceof Map, 'git 仓库应记录回合起始脏文件快照')

      // 本回合：继续改 a.txt（+four）并新建 c.txt
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo-CHANGED-BEFORE\nthree\nfour\n')
      fs.writeFileSync(path.join(dir, 'c.txt'), 'ccc\n')
      const d = await changes.turnDiff(task, env, start)

      const a = d.files.find((f) => f.path === 'a.txt')
      assert.ok(a, 'a.txt 本回合有改动应出现')
      assert.equal(a.adds, 1, '只统计本回合新增的 1 行')
      assert.equal(a.dels, 0, '问答前已有的改动不算本回合删除')
      assert.ok(!a.patch.includes('+two-CHANGED-BEFORE'), '问答前已有的改行不应作为本回合新增出现')
      assert.ok(a.patch.includes('+four'), '本回合新增行应出现在 patch 中')

      const c = d.files.find((f) => f.path === 'c.txt')
      assert.ok(c && c.status === 'added', '本回合新建的 c.txt 应记为新增')

      assert.ok(!d.files.find((f) => f.path === 'b.txt'), '未改动的 b.txt 不应出现')
    })
  },
  {
    name: 'AI 自身改动已基线，不再带入下次请求（Git）',
    run: () => withTaskDir(async (dir) => {
      const g = (args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', windowsHide: true })
      g(['init', '-q'])
      g(['config', 'user.email', 't@t.t'])
      g(['config', 'user.name', 't'])
      g(['config', 'commit.gpgsign', 'false'])
      fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n')
      g(['add', '.'])
      g(['commit', '-q', '-m', 'init'])

      const task = { path: dir }
      const env = { kind: 'local', unixPath: dir }
      const ckClean = await changes.checkpoint(task, env)

      // 模拟 AI 回合：修改 a.txt 并新建 b.txt
      fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world\n')
      fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n')
      const g1 = await changes.collect({ task, env, ck: ckClean })
      assert.ok(g1.count > 0 && g1.text.includes('a.txt') && g1.text.includes('b.txt'), '回合内应检测到 AI 的改动')

      // 回合结束：以当前（含 AI 改动）状态作为基线
      const ckAfter = await changes.checkpoint(task, env)
      const g2 = await changes.collect({ task, env, ck: ckAfter })
      assert.equal(g2.count, 0, 'AI 自己的改动不应再次带入')
      assert.equal(g2.text, '', 'AI 自己的改动不应再次注入上下文')

      // 基线之后用户再改动：仍应被检测到
      fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world!!!\n')
      const g3 = await changes.collect({ task, env, ck: ckAfter })
      assert.ok(g3.count > 0 && g3.text.includes('a.txt'), '基线之后的用户改动仍应带入')
    })
  },
  {
    name: 'AI 自身改动已基线，不再带入下次请求（非 Git 快照）',
    run: () => withTaskDir(async (dir) => {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'v1\n')
      const task = { path: dir }
      const env = { kind: 'local', unixPath: dir }
      const ckBefore = await changes.checkpoint(task, env)

      fs.writeFileSync(path.join(dir, 'a.txt'), 'v2\n')
      const g1 = await changes.collect({ task, env, ck: ckBefore })
      assert.ok(g1.count > 0 && g1.text.includes('a.txt'), 'AI 改动应被检测')

      const ckAfter = await changes.checkpoint(task, env)
      const g2 = await changes.collect({ task, env, ck: ckAfter })
      assert.equal(g2.count, 0, 'AI 自己的改动不应再次带入')

      fs.writeFileSync(path.join(dir, 'a.txt'), 'v3\n')
      const g3 = await changes.collect({ task, env, ck: ckAfter })
      assert.ok(g3.count > 0 && g3.text.includes('a.txt'), '基线之后的用户改动仍应带入')
    })
  }
]
