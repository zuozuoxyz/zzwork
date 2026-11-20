const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('zzwork', {
  version: process.versions.electron,
  invoke: (domain, method, payload) => ipcRenderer.invoke(`zz:${domain}:${method}`, payload),
  on: (channel, cb) => {
    const listener = (_event, data) => cb(data)
    ipcRenderer.on(`zz:${channel}`, listener)
    return () => ipcRenderer.removeListener(`zz:${channel}`, listener)
  }
})
