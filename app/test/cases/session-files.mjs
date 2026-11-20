// 会话内容落盘：<task>/.zzwork/sessions/<sid>/{meta.json,transcript.jsonl}
// 文件为权威（含完整思考与工具 I/O），DB 为可重建缓存
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createTaskUI, selectTask, ensureTask } from './_helpers.mjs'
import { sleep } from '../harness.mjs'

let seq = 0
async function freshTask(app, sandbox, tag) {
  const name = '落盘-' + tag + '-' + (++seq)
  const dir = path.join(sandbox.work, name)
  fs.mkdirSync(dir, { recursive: true })
  const t = await createTaskUI(app, { name, path: dir })
  await app.store('tasks.update', { id: t.id, patch: { agent_id: 'claude-code', model_id: '' } })
  const task = await app.store('tasks.get', { id: t.id })
  return { name, task }
}

async function openAndSend(app, name, text) {
  await selectTask(app, name)
  await openAiTab(app)
  await app.setValue('#chatInput', text)
  await app.click('#chatSend')
}

async function openAiTab(app) {
  await app.waitFor(() => !!document.querySelector('.tab[data-pane="ai"]'), 10000, 'AI 标签出现')
  await app.click('.tab[data-pane="ai"]')
  await app.waitFor(`document.querySelector('#pane-ai').classList.contains('on')`)
}

async function waitTurnDone(app, taskId, needle) {
  await app.waitFor(`(async () => {
    const msgs = await window.zzwork.invoke('store', 'messages.list', { taskId: ${JSON.stringify(taskId)} })
    const last = msgs[msgs.length - 1]
    return !!(last && last.role === 'assistant' && String(last.content).includes(${JSON.stringify(needle)}))
  })()`, 25000, '回合落库')
  await sleep(400) // 等待文件写入队列 flush
}

function readTranscript(dir, sid) {
  const file = path.join(dir, '.zzwork', 'sessions', sid, 'transcript.jsonl')
  assert.ok(fs.existsSync(file), '应为会话生成 transcript.jsonl: ' + file)
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

async function waitGone(p, timeout = 4000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!fs.existsSync(p)) return true
    await sleep(100)
  }
  return !fs.existsSync(p)
}

export default [
  {
    name: '会话内容落盘到 .zzwork（完整思考 + 工具 I/O）',
    async run(app, sandbox) {
      const { name, task } = await freshTask(app, sandbox, 'disk')
      await openAndSend(app, name, 'claude落盘')
      await waitTurnDone(app, task.id, 'CLAUDE-FAKE 收到：claude落盘')

      const sessions = await app.store('sessions.list', { taskId: task.id })
      const sid = sessions[sessions.length - 1].id
      const sessionDir = path.join(task.path, '.zzwork', 'sessions', sid)
      assert.ok(fs.existsSync(path.join(sessionDir, 'meta.json')), '应生成 meta.json')

      const metaFile = JSON.parse(fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf8'))
      assert.equal(metaFile.id, sid, 'meta.json 应含会话 id')
      assert.equal(metaFile.meta['sid:claude-code'], 'fake-claude-session', 'meta.json 应记录执行体会话 id')

      const rows = readTranscript(task.path, sid)
      const row = rows.find((r) => r.t === 'msg' && r.role === 'assistant' && Array.isArray(r.parts))
      assert.ok(row, '应有带 parts 的助手消息')
      assert.ok(String(row.thinking || '').includes('CLAUDE-THINK'), '应保存完整思考过程')
      const kinds = row.parts.map((p) => p.t)
      assert.ok(kinds.includes('think') && kinds.includes('tool') && kinds.includes('text'), 'parts 应含 思考/工具/正文: ' + kinds)
      const tool = row.parts.find((p) => p.t === 'tool' && p.name === 'Bash')
      assert.ok(tool, '应有 Bash 工具步骤')
      assert.equal(tool.input && tool.input.command, 'echo hi', '工具步骤应保存完整输入')
      assert.ok('output' in tool, '工具步骤应保存完整输出字段')

      // 瘦身只进 DB 缓存：完整工具输入/输出不落 DB meta（渲染只需 detail）
      const dbMsgs = await app.store('messages.list', { taskId: task.id })
      const dbAssistant = dbMsgs.find((m) => m.id === row.id)
      assert.ok(dbAssistant, '助手消息应缓存到 DB')
      const dbParts = JSON.parse(dbAssistant.meta).parts || []
      const dbTool = dbParts.find((p) => p.t === 'tool' && p.name === 'Bash')
      assert.ok(dbTool && dbTool.detail === 'echo hi', 'DB 缓存应保留工具摘要')
      assert.ok(!('input' in dbTool) && !('output' in dbTool), 'DB 缓存不应保存完整工具 I/O')
    }
  },
  {
    name: '旧会话（DB 有、文件无）打开后迁出到 .zzwork',
    async run(app, sandbox) {
      const { name, task } = await freshTask(app, sandbox, 'migrate')
      await openAndSend(app, name, 'claude迁移')
      await waitTurnDone(app, task.id, 'CLAUDE-FAKE 收到：claude迁移')

      const sessions = await app.store('sessions.list', { taskId: task.id })
      const sid = sessions[sessions.length - 1].id
      const sessionDir = path.join(task.path, '.zzwork', 'sessions', sid)
      fs.rmSync(sessionDir, { recursive: true, force: true })
      assert.ok(!fs.existsSync(sessionDir), '应已删除会话目录，模拟旧数据只有 DB')

      await app.invoke('chat', 'init', { taskId: task.id, sessionId: sid })
      const rows = readTranscript(task.path, sid)
      assert.ok(rows.some((r) => r.t === 'msg' && String(r.content).includes('CLAUDE-FAKE 收到：claude迁移')), '应把 DB 历史迁出到文件')
      assert.ok(fs.existsSync(path.join(sessionDir, 'meta.json')), '迁移后应生成 meta.json')
    }
  },
  {
    name: '文件为准：改动会话文件后重新打开反映到历史',
    async run(app, sandbox) {
      const { name, task } = await freshTask(app, sandbox, 'win')
      await openAndSend(app, name, 'claude改文件')
      await waitTurnDone(app, task.id, 'CLAUDE-FAKE 收到：claude改文件')

      const sessions = await app.store('sessions.list', { taskId: task.id })
      const sid = sessions[sessions.length - 1].id
      const file = path.join(task.path, '.zzwork', 'sessions', sid, 'transcript.jsonl')
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      const out = lines.map((l) => {
        const r = JSON.parse(l)
        if (r.t === 'msg' && r.role === 'assistant' && String(r.content).includes('CLAUDE-FAKE')) r.content = 'FILE-WINS-MARK'
        return JSON.stringify(r)
      })
      fs.writeFileSync(file, out.join('\n') + '\n')

      await app.invoke('chat', 'init', { taskId: task.id, sessionId: sid })
      const dbMsgs = await app.store('messages.list', { taskId: task.id })
      assert.ok(dbMsgs.some((m) => m.content === 'FILE-WINS-MARK'), '改动文件内容应在重新打开后生效（文件为准）')
    }
  },
  {
    name: '删除会话连带删除 .zzwork 会话目录',
    async run(app, sandbox) {
      const { name, task } = await freshTask(app, sandbox, 'del')
      await openAndSend(app, name, 'claude删除')
      await waitTurnDone(app, task.id, 'CLAUDE-FAKE 收到：claude删除')

      const sessions = await app.store('sessions.list', { taskId: task.id })
      const sid = sessions[sessions.length - 1].id
      const sessionDir = path.join(task.path, '.zzwork', 'sessions', sid)
      assert.ok(fs.existsSync(sessionDir), '会话目录应存在')

      await app.store('sessions.delete', { id: sid })
      assert.ok(await waitGone(sessionDir), '删除会话后目录应消失')
    }
  }
]
