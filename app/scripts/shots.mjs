// 生成 README 用的界面截图：隔离启动应用、灌入演示数据、逐视图截图到 docs/images
// 用法：node scripts/shots.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSandbox, App, startFakeAI } from '../test/harness.mjs'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.resolve(APP_DIR, '..', 'docs', 'images')

const HERO_REPLY = `## 登录流程梳理与重构方案

当前登录链路把「校验、发码、落库、签票」耦合在同一个接口里，扩展困难。建议拆成三步：

1. **认证（Authn）**：账号/验证码/第三方 OAuth 统一收敛到 \`AuthProvider\` 接口
2. **会话（Session）**：登录成功后签发短期 access token + 长期 refresh token
3. **鉴权（Authz）**：网关侧校验 token，业务侧只认 \`userId\`

| 步骤 | 现状 | 重构后 |
| --- | --- | --- |
| 发码 | 短信/邮件各写一套 | 统一 \`CodeSender\`，按渠道注入 |
| 校验 | 散落在控制器 | \`AuthProvider.verify()\` |
| 签票 | 同步写库 | 异步签发 + 缓存 |

\`\`\`ts
interface AuthProvider {
  verify(credential: Credential): Promise<Identity>
  issue(identity: Identity): Promise<TokenPair>
}
\`\`\`

按此拆分后，新增「企业微信扫码登录」只需实现一个 \`AuthProvider\`，无需改主流程。需要我直接给出 \`AuthProvider\` 的首个实现与迁移步骤吗？`

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const sandbox = prepareSandbox()
  const app = new App(sandbox)
  const server = await startFakeAI({
    thinking: ['先理解现有登录链路的耦合点…', '再规划可扩展的拆分方式…'],
    chunks: [HERO_REPLY],
    delay: 6
  })

  const snap = async (name) => {
    const file = path.join(OUT_DIR, name)
    const r = await app.cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    console.log('  已保存 ' + path.basename(file))
  }
  // 某一步的 UI 等待没就绪也不应中断后续截图
  const wait = async (expr, label, timeout = 10000) => {
    try { await app.waitFor(expr, timeout, label) } catch (e) { console.warn('  (跳过等待) ' + label) }
  }

  try {
    await app.start()
    const workdir = await app.store('workdir.get')

    // 提供方 + 模型（指向本地假 AI）
    const pid = await app.store('providers.upsert', {
      provider: { name: 'Anthropic 兼容', type: 'openai_compatible', base_url: server.url }
    })
    await app.store('models.upsert', {
      model: { name: '旗舰模型 · Claude', model_id: 'fake-1', type: 'openai_compatible', base_url: server.url, provider_id: pid, is_default: 1 }
    })
    const mid = (await app.store('models.list')).find((x) => x.provider_id === pid).id
    // 假 AI 仍需一个「已配置」的 Key，否则内置对话会直接报「未设置 API Key」
    await app.invoke('secrets', 'set', { key: 'zzwork.key.provider.' + pid, value: 'sk-fake' })

    // 分组 + 任务
    const g1 = await app.store('groups.create', { name: '产品迭代' })
    const g2 = await app.store('groups.create', { name: '平台与基建' })
    const mk = (n) => { const p = path.join(workdir, n); fs.mkdirSync(p, { recursive: true }); return p }
    for (const [name, gid] of [['支付回调对账', g1.id], ['消息中心改版', g1.id], ['统一日志接入', g2.id]]) {
      await app.store('tasks.create', { dto: { name, type: 'work', status: 'active', scope: 'long', group_id: gid, path: mk(name) } })
    }
    const hero = await app.store('tasks.create', {
      dto: { name: '重构登录流程', type: 'work', status: 'active', scope: 'long', path: mk('重构登录流程'), modelId: mid, agentId: 'builtin' }
    })
    // 给任务写一份简介，任务信息页更饱满
    try { fs.writeFileSync(path.join(hero.path, 'README.md'), '# 重构登录流程\n\n将分散的登录逻辑收敛为可扩展的认证/会话/鉴权三层。\n') } catch {}
    await app.store('tasks.update', { id: hero.id, patch: { brief: '把分散的登录逻辑收敛为可复用的认证、会话、鉴权三层，支持新增第三方登录而不改主流程。' } })

    // 看板卡片（须在重载前创建）
    const board = [
      { name: '接入企业微信扫码登录', status: 'todo', content: '支持企业微信扫码，无需输入账号密码。' },
      { name: '登录失败风控提示', status: 'todo', content: '连续失败时给出风险提示与冷却倒计时。' },
      { name: '短信验证码限流', status: 'doing', content: '按手机号/IP 维度限流，防刷。' },
      { name: 'OAuth 回调重构', status: 'review', content: '统一回调处理，兼容多个第三方。' },
      { name: '会话改为双 Token', status: 'done', content: 'access + refresh，自动续期。' }
    ]
    for (const b of board) {
      await app.store('tasks.create', { dto: { name: b.name, type: 'work', status: b.status, scope: 'board', path: mk('board-' + b.name), meta: { content: b.content } } })
    }

    // 需求便签内容：在重载前写好，启动时 loadInbox 会读入（写晚了左栏会是空的）
    const inboxFile = path.join(workdir, '.zzwork', 'inbox.md')
    fs.mkdirSync(path.dirname(inboxFile), { recursive: true })
    fs.writeFileSync(inboxFile, '希望支持把任务分享给同事协作\n登录页加载太慢，需要排查首屏\n给看板卡片加上负责人字段\n', 'utf8')

    // 通过 store 写入的数据只在启动时读入界面，CDP 重载一次让任务树/看板/便签拿到演示数据
    await app.cdp.send('Page.reload', { ignoreCache: false }).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
    await wait(() => document.readyState === 'complete' && !!window.zzwork && !!document.querySelector('#tabbar .tab'), '重载完成', 20000)
    await app.click('.abi[data-view="projects"]')
    // 轮询直到任务树出现（重载后 loadBase 读库完成有延迟）
    for (let i = 0; i < 40; i++) {
      const n = await app.call(() => document.querySelectorAll('.row[data-task]').length).catch(() => 0)
      if (n > 0) break
      await new Promise((r) => setTimeout(r, 200))
    }
    console.log('  DB tasks=' + (await app.store('tasks.list')).length + ' treeRows=' + await app.call(() => document.querySelectorAll('.row[data-task]').length))

    // 选中主任务，打开 AI 对话并跑一轮真实对话
    await wait(`[...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes('重构登录流程'))`, '主任务行出现', 15000)
    await app.call(() => { const r = [...document.querySelectorAll('.row[data-task]')].find((x) => x.textContent.includes('重构登录流程')); r && r.click(); return true })
    await wait(() => !!document.querySelector('.tab[data-pane="ai"]'), 'AI 标签出现')
    await app.click('.tab[data-pane="ai"]')
    const info = await app.invoke('chat', 'init', { taskId: hero.id })
    await app.invoke('chat', 'send', { taskId: hero.id, text: '登录流程现在很乱，帮我梳理并给出重构方案。', sessionId: info.session.id })
    await wait(`[...document.querySelectorAll('.msg.a .abody')].some(b=>b.textContent.includes('登录流程梳理与重构方案'))`, '助手回复渲染', 20000)
    await new Promise((r) => setTimeout(r, 800))
    await snap('01-workbench-ai.png')

    // 任务信息页（执行体 / 环境 / 简介）
    await app.click('.tab[data-pane="info"]')
    await wait(`document.querySelector('#pane-info') && document.querySelector('#pane-info').classList.contains('on')`, '信息页')
    await new Promise((r) => setTimeout(r, 400))
    await snap('04-task-info.png')

    // 看板
    await app.click('.abi[data-view="board"]')
    await wait(() => !!document.querySelector('#boardHost .bcol'), '看板加载')
    await new Promise((r) => setTimeout(r, 500))
    await snap('02-board.png')

    // 需求便签（内容已在重载前写入 inbox.md）
    await app.click('#openInboxBtn')
    await wait(`document.querySelector('#pane-inbox') && document.querySelector('#pane-inbox').classList.contains('on')`, '便签打开')
    await new Promise((r) => setTimeout(r, 600))
    await snap('03-inbox.png')

    console.log('\n完成，截图目录：' + OUT_DIR)
  } catch (e) {
    console.error('生成失败：' + (e && e.message || e))
    try { await app.screenshot('shots-fail') } catch {}
    process.exitCode = 1
  } finally {
    await app.stop()
    try { await server.close() } catch {}
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
