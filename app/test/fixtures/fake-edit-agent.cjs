// 测试用 CLI 执行体：在任务目录写入一个文件，模拟 AI 修改代码
const fs = require('fs')
const path = require('path')
const prompt = process.argv.slice(2).join(' ')
const file = path.join(process.cwd(), 'ai-note.md')
let prev = ''
try { prev = fs.readFileSync(file, 'utf8') } catch {}
fs.writeFileSync(file, prev + 'AI 修改内容：' + prompt + '\n')
process.stdout.write('EDIT-AGENT 完成：' + prompt + '\n')
