// 测试用 CLI 执行体：输出富内容（表格、代码块、本地文件链接、本地图片）
const fs = require('fs')
const path = require('path')
const cwd = process.cwd()
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
fs.writeFileSync(path.join(cwd, 'pic.png'), png)
fs.writeFileSync(path.join(cwd, 'rich-note.md'), '# note\n')
const out = [
  '## 富内容结果',
  '',
  '| 名称 | 值 |',
  '| --- | --- |',
  '| 状态 | 成功 |',
  '',
  '```js',
  "console.log('rich-code')",
  '```',
  '',
  '[打开 rich-note.md](rich-note.md)',
  '',
  '![示意图](pic.png)',
  ''
].join('\n')
process.stdout.write(out)
