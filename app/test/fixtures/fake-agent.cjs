// 测试用 CLI 执行体：把收到的 prompt 作为输出返回
const prompt = process.argv.slice(2).join(' ')
process.stdout.write('FAKE-AGENT 收到：' + prompt + '\n')
