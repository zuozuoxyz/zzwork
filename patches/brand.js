#!/usr/bin/env node
// product.json 品牌化：只改 5 个字段的值，绝不删键（删键会黑屏）
// 用法: node brand.js <发行版根/product.json>
const fs = require('fs')
const p = process.argv[2]
if (!p || !fs.existsSync(p)) { console.error('usage: node brand.js <path/to/product.json>'); process.exit(1) }
const j = JSON.parse(fs.readFileSync(p, 'utf8'))
j.nameShort = 'zzwork'
j.nameLong = 'zzwork'
j.applicationName = 'zzwork'
j.dataFolderName = '.zzwork-vscode'
j.win32MutexName = 'zzwork'
fs.writeFileSync(p, JSON.stringify(j, null, '\t'))
console.log('branded ->', p)
