#!/usr/bin/env node
// workbench.html 打补丁：登录/AI/更新 UI 隐藏 CSS + 活动栏重排脚本注入；同步 product.json checksum
// 用法: node patch-workbench.js <发行版根> <补丁目录>
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const root = process.argv[2]
const patchDir = process.argv[3]
if (!root || !patchDir) { console.error('usage: node patch-workbench.js <dist-root> <patch-dir>'); process.exit(1) }

const htmlPath = path.join(root, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html')
const uiJsSrc = path.join(patchDir, 'zzwork-ui.js')
const uiJsDst = path.join(root, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'zzwork-ui.js')
const pkgPath = path.join(root, '..', 'product.json') // root 是 out/ 的父级？注意：调用方传的是 resources/app
// 约定：process.argv[2] = <...>/resources/app
const appRoot = root
const pkg = path.join(appRoot, 'product.json')

let html = fs.readFileSync(htmlPath, 'utf8')

// 1) 注入 zzwork-ui.js（活动栏重排 + 隐藏原生图标/更新菜单）
if (!html.includes('zzwork-ui.js')) {
  html = html.replace('</body>', '\t<script src="./zzwork-ui.js"></script>\n\t</body>')
  fs.writeFileSync(htmlPath, html)
  console.log('injected zzwork-ui.js tag')
}
fs.copyFileSync(uiJsSrc, uiJsDst)
console.log('copied zzwork-ui.js')

// 2) 隐藏登录/同步/Update 的 CSS（幂等）
const CSS_MARK = '/* zzwork-no-login */'
if (!html.includes(CSS_MARK)) {
  const css = `\t${CSS_MARK}
\t\t<style id="zzwork-no-login">
\t\t\tli.action-item[aria-label="Sign In"],
\t\t\tli.action-item:has(> a[aria-label="Sign In"]),
\t\t\tli.action-item:has(span.action-label[aria-label="Sign In"]),
\t\t\tli.action-item:has(span[aria-label="Sign In"]) { display: none !important; }
\t\t\tli.action-item:has(> a.codicon-accounts-view-bar-icon),
\t\t\ta.codicon-accounts-view-bar-icon { display: none !important; }
\t\t\t.monaco-menu li.action-item:has(span.action-label[aria-label*="Backup and Sync"]),
\t\t\t.monaco-menu li.action-item:has(span.action-label[aria-label*="Sign in"]),
\t\t\t.monaco-menu li.action-item:has(span.action-label[aria-label*="Sign In"]),
\t\t\t.monaco-menu li.action-item:has(span.action-label[aria-label*="Settings Sync"]),
\t\t\t.monaco-menu li.action-item:has(a.action-menu-item[aria-label*="Backup and Sync"]) { display: none !important; }
\t\t\t.agent-status-container { display: none !important; }
\t\t\t/* title-bar update button */
\t\t\tli.action-item:has(> a.action-label[aria-label*="Update"]),
\t\t\tli.action-item:has(a[aria-label="Update"]) { display: none !important; }
\t\t</style>
`
  html = html.replace('</head>', css + '\t</head>')
  fs.writeFileSync(htmlPath, html)
  console.log('injected hide CSS')
}

// 3) 更新 product.json checksum（否则弹"installation appears to be corrupt"）
const chk = crypto.createHash('sha256').update(fs.readFileSync(htmlPath)).digest('base64').replace(/=+$/, '')
const j = JSON.parse(fs.readFileSync(pkg, 'utf8'))
j.checksums['vs/code/electron-browser/workbench/workbench.html'] = chk
fs.writeFileSync(pkg, JSON.stringify(j, null, '\t'))
console.log('checksum ->', chk.slice(0, 12))
