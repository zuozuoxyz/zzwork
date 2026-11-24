import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:net'
import { startFakeAI } from '../harness.mjs'
import { ensureTask, selectTask } from './_helpers.mjs'

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
    s.on('error', reject)
  })
}

function linkParts(link) {
  const u = new URL(link)
  u.hostname = '127.0.0.1'
  const token = u.pathname.split('/').filter(Boolean).pop()
  return { base: u.origin, token }
}

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'x-zzwork-share': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  })
}

async function setupProviderModel(app, { url, name }) {
  const pid = await app.store('providers.upsert', {
    provider: { name, type: 'openai_compatible', base_url: url }
  })
  await app.store('models.upsert', {
    model: { name: name + '-模型', model_id: 'fake-share', type: 'openai_compatible', base_url: url, provider_id: pid, is_default: 1 }
  })
  await app.invoke('secrets', 'set', { key: 'zzwork.key.provider.' + pid, value: 'sk-fake' })
}

export default [
  {
    name: '任务分享：健康检查与鉴权',
    async run(app) {
      const port = await freePort()
      const cfg = await app.invoke('share', 'config.save', { port, bind: '127.0.0.1', publicBase: '' })
      assert.ok(cfg, '配置保存应返回状态')

      const t = await ensureTask(app, '分享源任务')
      const info = await app.invoke('share', 'task.enable', { taskId: t.id })
      assert.ok(info.enabled, '应已开启分享')
      assert.ok(info.link, '应生成分享链接')
      assert.ok(info.running, '分享服务应已启动')

      // 信息面板应展示分享链接与「添加远程执行体」入口
      await selectTask(app, '分享源任务')
      await app.waitFor(() => !!document.querySelector('#shareLink'), 8000, '分享链接输入框')
      assert.ok(await app.exists('#shareCopy'), '应有复制按钮')
      assert.ok(await app.exists('#remoteLinkInput'), '应有添加远程执行体输入框')
      assert.ok(await app.exists('#addRemoteBtn'), '应有添加按钮')
      await app.clickText('.tab', '任务信息')
      await app.waitFor(() => { const p = document.querySelector('#pane-info'); return !!p && p.classList.contains('on') }, 5000, '任务信息页')
      await app.screenshot('share-info')

      const { base, token } = linkParts(info.link)

      // 健康检查
      const health = await fetch(`${base}/s/${token}/health`, { headers: { 'x-zzwork-share': '1' } })
      assert.equal(health.status, 200, '健康检查应 200')
      const hj = await health.json()
      assert.equal(hj.ok, true)
      assert.equal(hj.name, '分享源任务')

      // 缺少自定义头 → 404（不暴露信息）
      const noHeader = await fetch(`${base}/s/${token}/health`)
      assert.equal(noHeader.status, 404, '缺少 x-zzwork-share 应 404')

      // 错误 token → 404
      const bad = await fetch(`${base}/s/deadbeefdeadbeef/health`, { headers: { 'x-zzwork-share': '1' } })
      assert.equal(bad.status, 404, '错误 token 应 404')

      // 关闭分享后 token 失效
      await app.invoke('share', 'task.disable', { taskId: t.id })
      const off = await fetch(`${base}/s/${token}/health`, { headers: { 'x-zzwork-share': '1' } }).catch(() => ({ status: 404 }))
      assert.equal(off.status, 404, '关闭分享后应 404')
    }
  },
  {
    name: '任务分享：只读文件读取与越权拦截',
    async run(app) {
      const port = await freePort()
      await app.invoke('share', 'config.save', { port, bind: '127.0.0.1', publicBase: '' })
      const t = await ensureTask(app, '分享文件任务')
      // 指定独立工作目录并写入测试文件
      const dir = path.join(path.dirname(t.path || process.cwd()), 'share-src-' + Date.now())
      fs.mkdirSync(path.join(dir, '.zzwork'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'hello.txt'), '远端文件内容-OK', 'utf8')
      fs.writeFileSync(path.join(dir, '.zzwork', 'keyinfo.md'), 'SECRET-KEY', 'utf8')
      await app.store('tasks.update', { id: t.id, patch: { path: dir } })

      const info = await app.invoke('share', 'task.enable', { taskId: t.id })
      const { base, token } = linkParts(info.link)

      const listR = await post(`${base}/s/${token}/fs/list`, { path: '' })
      assert.equal(listR.status, 200)
      const lj = await listR.json()
      assert.ok(lj.ok, '列目录应成功')
      const names = (lj.list || []).map((x) => x.name)
      assert.ok(names.includes('hello.txt'), '应列出 hello.txt')
      assert.ok(!names.includes('.zzwork'), '不应列出 .zzwork')

      const readR = await post(`${base}/s/${token}/fs/read`, { path: 'hello.txt' })
      assert.equal(readR.status, 200)
      const rj = await readR.json()
      assert.equal(rj.content, '远端文件内容-OK')

      // 越权：.zzwork 下的密钥文件必须被拒
      const blocked = await post(`${base}/s/${token}/fs/read`, { path: '.zzwork/keyinfo.md' })
      assert.equal(blocked.status, 400, '越权读取应 400')

      // 越权：.. 逃逸
      const escape = await post(`${base}/s/${token}/fs/read`, { path: '../../etc/passwd' })
      assert.equal(escape.status, 400, '路径逃逸应 400')

      await app.invoke('share', 'task.disable', { taskId: t.id })
    }
  },
  {
    name: '任务分享：远端隐藏会话只读问答',
    async run(app) {
      const ai = await startFakeAI({ chunks: ['远端', '回答：', '这是被分享任务的信息。'] })
      try {
        await setupProviderModel(app, { url: ai.url, name: '分享问答' })
        const port = await freePort()
        await app.invoke('share', 'config.save', { port, bind: '127.0.0.1', publicBase: '' })
        const t = await ensureTask(app, '分享问答任务')
        const info = await app.invoke('share', 'task.enable', { taskId: t.id })
        const { base, token } = linkParts(info.link)

        const r = await post(`${base}/s/${token}/ask`, { question: '这个任务是做什么的？', fromTask: '消费端任务' })
        assert.equal(r.status, 200)
        const j = await r.json()
        assert.equal(j.ok, true, '远端问答应成功：' + JSON.stringify(j))
        assert.ok(String(j.answer).includes('被分享任务的信息'), '应返回模型答案：' + j.answer)

        // 会话应是隐藏 ask 会话（不出现在主会话列表）
        const sessions = await app.store('sessions.list', { taskId: t.id })
        const ask = sessions.filter((s) => s.kind === 'ask')
        assert.ok(ask.length >= 1, '应创建隐藏 ask 会话')

        await app.invoke('share', 'task.disable', { taskId: t.id })
      } finally {
        await ai.close()
      }
    }
  }
]
