import assert from 'node:assert/strict'
import fs from 'node:fs'
import { sleep } from '../harness.mjs'
import { setView } from './_helpers.mjs'

const envs = async (app) => app.store('envs.list')
const envByName = async (app, name) => (await envs(app)).find((e) => e.name === name)

export default [
  {
    name: '环境列表渲染',
    async run(app) {
      await setView(app, 'envs')
      await app.waitFor(() => !!document.querySelector('.item[data-env="local"]'))
      assert.ok((await app.text('.item[data-env="local"]')).includes('本机'))
    }
  },
  {
    name: '添加 WSL 环境',
    async run(app) {
      await app.click('#addEnvBtn')
      await app.waitFor(() => !!document.querySelector('.zz-modal'), 3000, '弹窗出现')
      // 类型只应提供 WSL / SSH（本机为固定默认环境）
      const kinds = await app.call(() => [...document.querySelectorAll('#f_kind option')].map((o) => o.value))
      assert.deepEqual(kinds, ['wsl', 'ssh'])
      const isSelect = await app.call(() => document.querySelector('#f_distro').tagName === 'SELECT')
      let distro
      if (isSelect) {
        distro = await app.call(() => {
          const el = document.querySelector('#f_distro')
          el.value = el.options[0].value
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return el.value
        })
      } else {
        distro = 'Ubuntu-Test'
        await app.modalFill({ distro })
      }
      await app.modalFill({ name: '回归WSL', kind: 'wsl' })
      await app.modalOk()
      await app.waitFor(`document.querySelectorAll('.item[data-env]').length === 2`)
      const e = await envByName(app, '回归WSL')
      assert.equal(e.kind, 'wsl')
      assert.equal(e.config.distro, distro)
    }
  },
  {
    name: '添加 SSH 环境（密码认证）',
    async run(app) {
      await app.click('#addEnvBtn')
      await app.modalFill({ name: '回归SSH', kind: 'ssh', host: '10.0.0.9', user: 'dev', auth: 'password', password: 'pw123' })
      await app.modalOk()
      await app.waitFor(`document.querySelectorAll('.item[data-env]').length === 3`)
      const e = await envByName(app, '回归SSH')
      assert.equal(e.kind, 'ssh')
      assert.equal(e.config.host, '10.0.0.9')
      assert.equal(e.config.user, 'dev')
      assert.equal(e.config.auth, 'password')
      const stored = await app.invoke('secrets', 'get', { key: 'zzwork.ssh.' + e.id })
      assert.equal(stored, 'pw123', 'SSH 密码应加密保存')
      await app.waitFor(`document.querySelector('#envsBody').textContent.includes('dev@10.0.0.9')`)
    }
  },
  {
    name: '执行体探测',
    async run(app) {
      await app.click('.item[data-env="local"]')
      await app.waitFor(() => !!document.querySelector('#detectBtn'))
      await app.click('#detectBtn')
      await app.waitFor(`document.querySelector('#itemBody .hd').textContent.includes('已检测')`, 40000, '执行体探测完成')
      assert.ok(await app.count('#agentList .lrow') >= 1)
      const builtin = await app.call(() => {
        const row = [...document.querySelectorAll('#agentList .lrow')].find((r) => r.textContent.includes('内置'))
        return row ? row.textContent : ''
      })
      assert.ok(builtin.includes('已安装'), '内置执行体应可用')
      const codex = await app.call(() => {
        const row = [...document.querySelectorAll('#agentList .lrow')].find((r) => r.textContent.includes('OpenAI Codex'))
        return row ? row.textContent : ''
      })
      assert.ok(codex.includes('已安装'), 'PATH 之外安装的 codex 应被识别')
      const zcode = await app.call(() => {
        const row = [...document.querySelectorAll('#agentList .lrow')].find((r) => r.textContent.includes('zcode'))
        return row ? row.textContent : ''
      })
      assert.ok(zcode.includes('已安装'), 'GUI 应用随附的 zcode CLI 应被识别')
    }
  },
  {
    name: '一键安装执行体（本机 npm）',
    async run(app, sb) {
      await app.click('.item[data-env="local"]')
      await app.waitFor(() => !!document.querySelector('#agentList [data-install="opencode"]'), 40000, '出现安装按钮')
      await app.click('#agentList [data-install="opencode"]')
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        if (fs.existsSync(sb.installLog)) break
        await sleep(150)
      }
      assert.ok(fs.existsSync(sb.installLog), '应调用 npm 安装')
      assert.ok(fs.readFileSync(sb.installLog, 'utf8').includes('install -g opencode-ai'))
    }
  },
  {
    name: '删除环境（本地环境不可删）',
    async run(app) {
      const e = await envByName(app, '回归WSL')
      await app.click(`.item[data-env="${e.id}"]`)
      await app.waitFor(() => !!document.querySelector('#delEnv'))
      await app.click('#delEnv')
      await app.waitFor(`!document.querySelector('.item[data-env="${e.id}"]')`)
      assert.equal(await envByName(app, '回归WSL'), undefined)
      await app.click('.item[data-env="local"]')
      await app.waitFor(() => !!document.querySelector('#detectBtn'))
      assert.equal(await app.exists('#delEnv'), false)
    }
  }
]
