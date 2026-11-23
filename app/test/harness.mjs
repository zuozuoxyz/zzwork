// 回归测试框架：隔离启动内置 Electron，通过 CDP 驱动真实界面
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
export const APP_DIR = path.resolve(TEST_DIR, '..')
export const TMP_DIR = path.join(TEST_DIR, '.tmp')
export const SHOT_DIR = path.join(TMP_DIR, 'shots')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

function cleanException(details) {
  if (!details) return 'unknown error'
  if (details.exception && details.exception.description) return details.exception.description
  return details.text || 'evaluate failed'
}

// ---------- CDP 客户端 ----------
class CDP {
  constructor(url) {
    this.url = url
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
  }

  async connect(timeout = 15000) {
    const deadline = Date.now() + timeout
    for (;;) {
      try {
        this.ws = new WebSocket(this.url)
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000)
          this.ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
          this.ws.addEventListener('error', (e) => { clearTimeout(t); reject(e.error || new Error('WebSocket 错误')) }, { once: true })
        })
        break
      } catch (e) {
        if (Date.now() > deadline) throw e
        await sleep(150)
      }
    }
    this.ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
    await this.send('Runtime.enable')
    await this.send('Page.enable')
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch (e) { this.pending.delete(id); reject(e) }
    })
  }

  close() {
    try { this.ws && this.ws.close() } catch {}
  }
}

// ---------- 测试环境准备 ----------
export function prepareSandbox() {
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true })
  const dirs = {
    data: path.join(TMP_DIR, 'data'),
    home: path.join(TMP_DIR, 'home'),
    userData: path.join(TMP_DIR, 'userdata'),
    work: path.join(TMP_DIR, 'work'),
    pick: path.join(TMP_DIR, 'pick'),
    shots: SHOT_DIR
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })

  // 全局 Skills 种子（~/.zzwork/skills/...）
  const skillDir = path.join(dirs.home, '.zzwork', 'skills', 'demo-skill')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: 回归测试用 Skill\n---\n\n# Demo\n\n这是种子 Skill 的正文。\n')

  // 全局 MCP 种子（~/.zzwork/mcp.json）
  fs.writeFileSync(path.join(dirs.home, '.zzwork', 'mcp.json'), JSON.stringify({
    mcpServers: { seeded: { command: 'node', args: ['-e', 'console.log(1)'] } }
  }, null, 2))

  // 文件选择对话框注入
  const pickFile = path.join(dirs.pick, 'picked-skill', 'SKILL.md')
  fs.mkdirSync(path.dirname(pickFile), { recursive: true })
  fs.writeFileSync(pickFile, '---\nname: picked-skill\ndescription: 通过文件选择添加\n---\n\n# Picked\n')

  // 假 claude CLI：覆盖 runClaude 的 stream-json + 权限控制通道解析路径
  const fakeBin = path.join(dirs.home, 'fakebin')
  fs.mkdirSync(fakeBin, { recursive: true })
  const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.cjs', import.meta.url))
  fs.writeFileSync(path.join(fakeBin, 'claude.cmd'),
    `@echo off\r\n"${process.execPath}" "${fakeClaude}" %*\r\n`)

  // PATH 之外的执行体（模拟应用内自装 / GUI 应用随附 CLI）
  const localAppData = path.join(dirs.home, 'AppData', 'Local')
  const codexDir = path.join(localAppData, 'OpenAI', 'Codex', 'bin', 'testbuild')
  fs.mkdirSync(codexDir, { recursive: true })
  fs.writeFileSync(path.join(codexDir, 'codex.cmd'),
    '@echo off\r\nif "%1"=="--version" (echo codex-cli 9.9.9) else (echo CODEX-FAKE %*)\r\n')
  const zcodeDir = path.join(localAppData, 'ZCode', 'resources', 'glm')
  fs.mkdirSync(zcodeDir, { recursive: true })
  fs.writeFileSync(path.join(zcodeDir, 'zcode.cjs'),
    "if (process.argv.includes('--version')) { console.log('0.16.9'); process.exit(0) }\n" +
    "console.log('ZCODE-FAKE ' + process.argv.slice(2).join(' '))\n")

  // 假 npm：一键安装只记录调用参数
  const installLog = path.join(TMP_DIR, 'install.log')
  fs.writeFileSync(path.join(fakeBin, 'npm.cmd'),
    `@echo off\r\n>>"%ZZWORK_TEST_INSTALL_LOG%" echo %*\r\necho npm-ok\r\n`)

  fs.mkdirSync(dirs.shots, { recursive: true })
  return { ...dirs, pickFile, skillDir, fakeBin, localAppData, installLog }
}

// ---------- 应用实例 ----------
export class App {
  constructor(sandbox) {
    this.sb = sandbox
    this.proc = null
    this.cdp = null
    this.port = null
    this.logPath = path.join(TMP_DIR, 'electron.log')
    this.failures = 0
  }

  async start() {
    this.port = await freePort()
    const electron = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
    const env = {
      ...process.env,
      PATH: this.sb.fakeBin + path.delimiter + process.env.PATH,
      USERPROFILE: this.sb.home,
      LOCALAPPDATA: this.sb.localAppData,
      ZZWORK_DB_PATH: path.join(this.sb.data, 'zzwork.db'),
      ZZWORK_TEST_AUTOCONFIRM: '1',
      ZZWORK_TEST_PICK_DIR: this.sb.pick,
      ZZWORK_TEST_PICK_FILE: this.sb.pickFile,
      ZZWORK_TEST_INSTALL_LOG: this.sb.installLog
    }
    delete env.CLAUDE_CODE_GIT_BASH_PATH
    delete env.ELECTRON_RENDERER_URL
    delete env.ELECTRON_RUN_AS_NODE
    this.proc = spawn(electron, [
      '.',
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.sb.userData}`
    ], { cwd: APP_DIR, env, windowsHide: true })
    const log = fs.createWriteStream(this.logPath)
    this.proc.stdout.pipe(log)
    this.proc.stderr.pipe(log)

    const target = await this.waitForTarget()
    this.cdp = new CDP(target.webSocketDebuggerUrl)
    await this.cdp.connect()
    await this.waitFor(() => document.readyState === 'complete' && !!window.zzwork
      && !!document.querySelector('#tabbar .tab'), 20000, '应用启动')
  }

  async waitForTarget(timeout = 20000) {
    const deadline = Date.now() + timeout
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/json/list`)
        const list = await res.json()
        const page = list.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url))
        if (page) return page
      } catch {}
      if (Date.now() > deadline) throw new Error('未等到渲染进程调试目标')
      await sleep(200)
    }
  }

  async stop() {
    this.cdp && this.cdp.close()
    if (this.proc) {
      await new Promise((resolve) => {
        execFile('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], () => resolve())
      })
      this.proc = null
    }
  }

  // ---- 基础 ----
  async eval(expression) {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true
    })
    if (r.exceptionDetails) throw new Error(cleanException(r.exceptionDetails))
    return r.result ? r.result.value : undefined
  }

  call(fn, ...args) {
    return this.eval(`(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`)
  }

  async waitFor(fn, timeout = 6000, label = '条件') {
    const expr = typeof fn === 'function' ? `(${fn.toString()})()` : String(fn)
    const deadline = Date.now() + timeout
    let lastErr
    while (Date.now() < deadline) {
      try {
        if (await this.eval(expr)) return true
      } catch (e) { lastErr = e }
      await sleep(100)
    }
    throw new Error(`等待超时：${label}${lastErr ? '（最后一次错误：' + lastErr.message + '）' : ''}`)
  }

  async waitGone(selector, timeout = 6000) {
    return this.waitFor(`!document.querySelector(${JSON.stringify(selector)})`, timeout, `元素消失 ${selector}`)
  }

  async exists(selector) {
    return this.call((s) => !!document.querySelector(s), selector)
  }

  async count(selector) {
    return this.call((s) => document.querySelectorAll(s).length, selector)
  }

  async text(selector) {
    return this.call((s) => {
      const el = document.querySelector(s)
      return el ? el.textContent.trim() : null
    }, selector)
  }

  async visible(selector) {
    return this.call((s) => {
      const el = document.querySelector(s)
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'
    }, selector)
  }

  async click(selector) {
    await this.call((s) => {
      const el = document.querySelector(s)
      if (!el) throw new Error('元素不存在: ' + s)
      el.click()
      return true
    }, selector)
  }

  async clickText(selector, text) {
    await this.call((s, t) => {
      const el = [...document.querySelectorAll(s)].find((x) => x.textContent.includes(t))
      if (!el) throw new Error(`未找到「${t}」: ${s}`)
      el.click()
      return true
    }, selector, text)
  }

  async setValue(selector, value, fire = 'input') {
    await this.call((s, v, ev) => {
      const el = document.querySelector(s)
      if (!el) throw new Error('元素不存在: ' + s)
      el.value = v
      el.dispatchEvent(new Event(ev, { bubbles: true }))
      return true
    }, selector, value, fire)
  }

  async selectValue(selector, value) {
    await this.call((s, v) => {
      const el = document.querySelector(s)
      if (!el) throw new Error('元素不存在: ' + s)
      el.value = v
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return el.value
    }, selector, value)
  }

  async pressEnter(selector) {
    await this.call((s) => {
      const el = document.querySelector(s)
      if (!el) throw new Error('元素不存在: ' + s)
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return true
    }, selector)
  }

  async clickByText(selector, text) {
    return this.clickText(selector, text)
  }

  async modalFill(values) {
    await this.waitFor(() => !!document.querySelector('.zz-modal'), 3000, '弹窗出现')
    for (const [name, value] of Object.entries(values)) {
      await this.call((n, v) => {
        const el = document.querySelector('#f_' + n)
        if (!el) throw new Error('弹窗字段不存在: ' + n)
        if (el.type === 'checkbox') el.checked = !!v
        else el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }, name, value)
    }
  }

  async modalOk() {
    await this.click('.zz-modal [data-act="ok"]')
    await this.waitGone('.zz-modal', 3000)
  }

  async modalCancel() {
    await this.click('.zz-modal [data-act="cancel"]')
    await this.waitGone('.zz-modal', 3000)
  }

  async contextMenu(selector, label) {
    await this.call((s) => {
      const el = document.querySelector(s)
      if (!el) throw new Error('元素不存在: ' + s)
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: r.left + Math.min(40, r.width / 2), clientY: r.top + Math.min(20, r.height / 2)
      }))
      return true
    }, selector)
    await this.waitFor(() => !!document.querySelector('#ctx-host .zz-ctx'), 3000, '右键菜单出现')
    await this.clickText('#ctx-host .zz-ctx button', label)
  }

  async contextMenuText(selector, text, label) {
    await this.call((s, t) => {
      const el = [...document.querySelectorAll(s)].find((x) => x.textContent.includes(t))
      if (!el) throw new Error(`未找到「${t}」: ${s}`)
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: r.left + Math.min(40, r.width / 2), clientY: r.top + Math.min(20, r.height / 2)
      }))
      return true
    }, selector, text)
    await this.waitFor(() => !!document.querySelector('#ctx-host .zz-ctx'), 3000, '右键菜单出现')
    await this.clickText('#ctx-host .zz-ctx button', label)
  }

  async invoke(domain, method, payload = {}) {
    return this.eval(`window.zzwork.invoke(${JSON.stringify(domain)}, ${JSON.stringify(method)}, ${JSON.stringify(payload)})`)
  }

  async store(method, payload = {}) {
    return this.invoke('store', method, payload)
  }

  // ---- 真实输入（CDP Input 域）----
  async clickEl(selector) {
    const rect = await this.call((s) => {
      const el = document.querySelector(s)
      if (!el) throw new Error('元素不存在: ' + s)
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, selector)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
  }

  async insertText(text) {
    await this.cdp.send('Input.insertText', { text })
  }

  async pressKey({ key, code, keyCode, modifiers = 0 }) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  async screenshot(name) {
    try {
      const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(SHOT_DIR, name.replace(/[^\w一-龥-]+/g, '_') + '.png')
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
      return file
    } catch { return null }
  }
}

// ---------- 假 AI 服务（OpenAI 兼容 SSE）----------
// respond(body, index) 可按请求内容返回自定义文本（字符串或片段数组）
export async function startFakeAI({ chunks = ['你好', '，我是', '测试模型。'], thinking = [], delay = 20, respond = null, usage = null } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      let parsed = null
      try { parsed = JSON.parse(body) } catch {}
      requests.push(parsed)
      let out = chunks
      if (respond) {
        try {
          const r = respond(parsed, requests.length)
          if (r != null) out = Array.isArray(r) ? r : [String(r)]
        } catch {}
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      for (const text of thinking) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] }) + '\n\n')
        await sleep(delay)
      }
      for (const text of out) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n')
        await sleep(delay)
      }
      if (usage) res.write('data: ' + JSON.stringify({ choices: [], usage }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  server.unref()
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => new Promise((r) => server.close(() => r()))
  }
}

export { sleep }
