import assert from 'node:assert/strict'
import path from 'node:path'

export default [
  {
    name: '窗口与视图渲染',
    async run(app) {
      assert.equal(await app.text('.brand'), 'zzwork')
      assert.equal(await app.count('.abi[data-view]'), 6)
      assert.equal(await app.count('.panel'), 7)
      assert.ok(await app.exists('#tabbar .tab'))
      assert.ok(await app.exists('#stVersion'))
    }
  },
  {
    name: '安全隔离（contextIsolation / sandbox）',
    async run(app) {
      const env = await app.eval(`({
        hasBridge: typeof window.zzwork === 'object' && typeof window.zzwork.invoke === 'function',
        hasRequire: typeof window.require,
        hasProcess: typeof window.process
      })`)
      assert.equal(env.hasBridge, true)
      assert.equal(env.hasRequire, 'undefined')
      assert.equal(env.hasProcess, 'undefined')
    }
  },
  {
    name: 'SQLite 已连接且位于测试目录',
    async run(app, sb) {
      const info = await app.store('db.info')
      assert.equal(info.kind, 'sqlite')
      assert.ok(path.resolve(info.path).startsWith(path.resolve(sb.data)), info.path)
      assert.ok(path.basename(info.path).endsWith('zzwork.db'))
    }
  },
  {
    name: '默认本机环境存在',
    async run(app) {
      const envs = await app.store('envs.list')
      assert.ok(envs.some((e) => e.id === 'local' && e.kind === 'local'))
    }
  }
]
