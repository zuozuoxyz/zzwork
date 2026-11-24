// 回归测试入口：node test/run.mjs [用例文件或名称过滤]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSandbox, App, TMP_DIR } from './harness.mjs'

const CASE_FILES = [
  'basic.mjs',
  'projects.mjs',
  'envs.mjs',
  'skills-mcp.mjs',
  'models.mjs',
  'info.mjs',
  'files.mjs',
  'changes.mjs',
  'settings.mjs',
  'session-chat.mjs',
  'session-prompt.mjs',
  'session-files.mjs',
  'features.mjs',
  'board.mjs',
  'featuremap.mjs',
  'share.mjs',
  'terminal.mjs',
  'security.mjs'
]

const filter = process.argv[2] || ''
const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[90m${s}\x1b[0m`

async function main() {
  const sandbox = prepareSandbox()
  const app = new App(sandbox)
  let pass = 0
  const failures = []

  console.log(dim(`临时环境：${TMP_DIR}`))
  try {
    await app.start()
    console.log(dim('应用已启动，开始回归\n'))
  } catch (e) {
    console.error(red('应用启动失败：' + e.message))
    const log = path.join(TMP_DIR, 'electron.log')
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-4000))
    await app.stop()
    process.exit(1)
  }

  try {
    for (const file of CASE_FILES) {
      if (filter && !file.includes(filter)) {
        const mod = await import(new URL('./cases/' + file, import.meta.url))
        if (!mod.default.some((c) => c.name.includes(filter))) continue
      }
      const mod = await import(new URL('./cases/' + file, import.meta.url))
      const cases = mod.default.filter((c) => !filter || c.name.includes(filter) || file.includes(filter))
      if (!cases.length) continue
      console.log(`\n\x1b[36m▌ ${file}\x1b[0m`)
      for (const c of cases) {
        const started = Date.now()
        try {
          await c.run(app, sandbox)
          pass++
          console.log(`  ${green('✓')} ${c.name} ${dim((Date.now() - started) + 'ms')}`)
        } catch (e) {
          failures.push({ name: c.name, error: e })
          console.log(`  ${red('✗')} ${c.name} ${dim((Date.now() - started) + 'ms')}`)
          console.log(red('    ' + String(e.message || e).split('\n').join('\n    ')))
          const shot = await app.screenshot('fail-' + c.name)
          if (shot) console.log(dim('    截图：' + shot))
        }
      }
    }
  } finally {
    await app.stop()
  }

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`通过 ${green(pass)} · 失败 ${failures.length ? red(failures.length) : 0}`)
  if (failures.length) {
    console.log('\n失败用例：')
    for (const f of failures) console.log('  · ' + f.name)
    console.log(dim('\n应用日志：' + path.join(TMP_DIR, 'electron.log')))
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
