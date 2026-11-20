// 极简 LSP 客户端：JSON-RPC over stdio（Content-Length 分帧），仅实现「转到定义」所需
// 适配任意形如 child_process 的子进程对象（本机 spawn / wsl.exe / sshconn.spawnRemote）
const SYNC_FULL = 1

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii')
  return Buffer.concat([head, body])
}

class LspClient {
  constructor(proc) {
    this.proc = proc
    this.nextId = 1
    this.pending = new Map()      // id -> { resolve, reject, timer }
    this.requestHandlers = []     // server -> client 请求（需应答，否则服务器会卡住）
    this.notificationHandlers = []
    this.buf = Buffer.alloc(0)
    this.closed = false
    this.stderrTail = ''
    if (proc.stdout) proc.stdout.on('data', (d) => this._onData(d))
    if (proc.stderr) proc.stderr.on('data', (d) => {
      const s = Buffer.isBuffer(d) ? d.toString('utf8') : String(d)
      this.stderrTail = (this.stderrTail + s).slice(-4000)
    })
    proc.on('close', () => this._finishAll(new Error('language server 已退出')))
    proc.on('error', (e) => this._finishAll(e instanceof Error ? e : new Error(String(e))))
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')])
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n')
      if (sep < 0) return
      const header = this.buf.slice(0, sep).toString('ascii')
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) { this.buf = this.buf.slice(sep + 4); continue }
      const len = Number(m[1])
      const start = sep + 4
      if (this.buf.length < start + len) return
      const body = this.buf.slice(start, start + len).toString('utf8')
      this.buf = this.buf.slice(start + len)
      let msg
      try { msg = JSON.parse(body) } catch { continue }
      this._dispatch(msg)
    }
  }

  _dispatch(msg) {
    // 响应（有 id 且无 method）
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message || 'LSP 错误'))
      else p.resolve(msg.result)
      return
    }
    // 服务器发来的请求（有 id 且有 method）：必须应答
    if (msg.method && msg.id !== undefined) {
      let result = null
      if (msg.method === 'workspace/configuration') {
        const items = (msg.params && msg.params.items) || []
        result = items.map(() => null)
      }
      this._write({ jsonrpc: '2.0', id: msg.id, result })
      for (const h of this.requestHandlers) { try { h(msg.method, msg.params) } catch {} }
      return
    }
    // 通知（无 id）
    if (msg.method) {
      for (const h of this.notificationHandlers) { try { h(msg.method, msg.params) } catch {} }
    }
  }

  _write(obj) {
    if (this.closed) return
    try { this.proc.stdin.write(frame(obj)) } catch {}
  }

  request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('language server 已关闭'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('LSP 请求超时：' + method))
      }, timeoutMs || 15000)
      if (timer.unref) timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      this._write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params })
  }

  _finishAll(err) {
    if (this.closed) return
    this.closed = true
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
  }

  dispose() {
    try { this.notify('exit') } catch {}
    this._finishAll(new Error('language server 已释放'))
    try { this.proc.stdin.end() } catch {}
    try { this.proc.kill() } catch {}
  }
}

// 高层：initialized + 文档同步（全量）+ definition
class LanguageSession {
  constructor(client, languageId, rootUri, initializationOptions) {
    this.client = client
    this.languageId = languageId
    this.rootUri = rootUri || null
    this.initOptions = initializationOptions || {}
    this.docs = new Map()   // uri -> { version, text }
    this.opened = false
  }

  async open() {
    await this.client.request('initialize', {
      processId: process.pid,
      rootUri: this.rootUri,
      workspaceFolders: this.rootUri ? [{ uri: this.rootUri, name: 'root' }] : null,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
          definition: { dynamicRegistration: false, linkSupport: true }
        },
        workspace: { configuration: true, workspaceFolders: true }
      },
      initializationOptions: this.initOptions
    }, 30000)
    this.client.notify('initialized', {})
    this.opened = true
  }

  // 全量同步：内容变化才推 didChange（不带 range 即整篇替换，兼容增量服务器）
  ensureDoc(uri, text) {
    const body = String(text == null ? '' : text)
    const d = this.docs.get(uri)
    if (!d) {
      this.client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.languageId, version: 1, text: body }
      })
      this.docs.set(uri, { version: 1, text: body })
      return
    }
    if (d.text === body) return
    const version = d.version + 1
    this.client.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: body }]
    })
    this.docs.set(uri, { version, text: body })
  }

  definition(uri, position) {
    return this.client.request('textDocument/definition', {
      textDocument: { uri },
      position: { line: position.line, character: position.character }
    }, 20000)
  }

  dispose() { this.client.dispose() }
}

module.exports = { LspClient, LanguageSession, SYNC_FULL }
