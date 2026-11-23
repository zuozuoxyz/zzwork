// 统一 IPC 入口：window.zzwork 由 preload 注入
const zz = window.zzwork

export const invoke = (domain, method, payload) => zz.invoke(domain, method, payload)

export const store = (method, payload) => invoke('store', method, payload || {})
export const fsapi = (method, payload) => invoke('fs', method, payload || {})
export const env = (method, payload) => invoke('env', method, payload || {})
export const mcp = (method, payload) => invoke('mcp', method, payload || {})
export const secrets = (method, payload) => invoke('secrets', method, payload || {})
export const dialog = (method, payload) => invoke('dialog', method, payload || {})
export const chat = (method, payload) => invoke('chat', method, payload || {})
export const featuremap = (method, payload) => invoke('featuremap', method, payload || {})
export const lspapi = (method, payload) => invoke('lsp', method, payload || {})
export const updateapi = (method, payload) => invoke('update', method, payload || {})

export const onChatEvent = (cb) => zz.on('chat:event', cb)
export const onUpdateEvent = (cb) => zz.on('update:event', cb)
