import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ensureTask } from './_helpers.mjs'

export default [
  {
    name: '文件系统写操作限制在任务目录内',
    async run(app, sb) {
      await ensureTask(app, '主任务改名', { type: 'code' })
      await assert.rejects(
        () => app.invoke('fs', 'writeFile', { path: path.join(sb.data, 'evil.txt'), content: 'x' }),
        /不在任务目录内/
      )
      await assert.rejects(
        () => app.invoke('fs', 'readDir', { path: sb.work }),
        /不在任务目录内/
      )
      const t = (await app.store('tasks.list')).find((x) => x.name === '主任务改名')
      await assert.rejects(
        () => app.invoke('fs', 'writeFile', { path: path.join(t.path, '..', 'escape.txt'), content: 'x' }),
        /不在任务目录内/
      )
      await app.invoke('fs', 'writeFile', { path: path.join(t.path, 'inside-ok.txt'), content: 'ok' })
      assert.equal(fs.readFileSync(path.join(t.path, 'inside-ok.txt'), 'utf8'), 'ok')
      await app.invoke('fs', 'delete', { path: path.join(t.path, 'inside-ok.txt') })
    }
  },
  {
    name: '密钥加密存储（safeStorage）',
    async run(app, sb) {
      const available = await app.invoke('secrets', 'available')
      await app.invoke('secrets', 'set', { key: 'zzwork.test.secret', value: 'secret-plain-123' })
      assert.equal(await app.invoke('secrets', 'get', { key: 'zzwork.test.secret' }), 'secret-plain-123')
      assert.equal(await app.invoke('secrets', 'has', { key: 'zzwork.test.secret' }), true)
      const file = path.join(sb.userData, 'secrets.json')
      const raw = fs.readFileSync(file, 'utf8')
      const stored = JSON.parse(raw)['zzwork.test.secret']
      assert.ok(stored.startsWith(available ? 'enc:' : 'plain:'), stored.slice(0, 12))
      assert.ok(!raw.includes('secret-plain-123'), '磁盘上不应出现明文')
      await app.invoke('secrets', 'delete', { key: 'zzwork.test.secret' })
      assert.equal(await app.invoke('secrets', 'has', { key: 'zzwork.test.secret' }), false)
    }
  }
]
