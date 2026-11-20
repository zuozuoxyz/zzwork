// 测试用 zcode：回显收到的 -p 提示词，用于验证多行提示词不会被 cmd.exe 截断
const prompt = process.argv.slice(-1)[0] || ''
process.stdout.write('ZCODE-FAKE 收到：' + prompt + '\n')
