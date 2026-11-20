import assert from 'node:assert/strict'
import { setView, selectTask, waitToast, ensureTask } from './_helpers.mjs'

const providers = async (app) => app.store('providers.list')
const models = async (app) => app.store('models.list')

async function openProvider(app, name) {
  await setView(app, 'models')
  await app.clickText('.item[data-provider]', name)
  await app.waitFor(() => !!document.querySelector('#pvName'))
}

export default [
  {
    name: '添加模型提供方（含 Key）',
    async run(app) {
      await setView(app, 'models')
      await app.click('#addModelBtn')
      await app.modalFill({ name: '回归提供方', type: 'openai_compatible', base_url: 'http://127.0.0.1:1/v1', key: 'sk-regress' })
      await app.modalOk()
      await app.waitFor(`document.querySelector('#modelsBody').textContent.includes('回归提供方')`)
      const list = await providers(app)
      assert.equal(list.length, 1)
      assert.equal(list[0].type, 'openai_compatible')
      const has = await app.invoke('secrets', 'has', { key: 'zzwork.key.provider.' + list[0].id })
      assert.equal(has, true)
    }
  },
  {
    name: '在提供方下添加多个模型',
    async run(app) {
      await openProvider(app, '回归提供方')
      await app.click('#pvAddModel')
      await app.modalFill({ name: '模型A', model_id: 'model-a', is_default: true })
      await app.modalOk()
      await app.waitFor(`document.querySelectorAll('#pvModels .lrow').length === 1`)
      await app.click('#pvAddModel')
      await app.modalFill({ name: '模型B', model_id: 'model-b', is_default: false })
      await app.modalOk()
      await app.waitFor(`document.querySelectorAll('#pvModels .lrow').length === 2`)
      const ms = await models(app)
      assert.equal(ms.length, 2)
      const p = (await providers(app))[0]
      assert.ok(ms.every((m) => m.provider_id === p.id))
      await app.waitFor(`document.querySelectorAll('.item[data-model]').length === 2`)
    }
  },
  {
    name: '默认模型全库唯一',
    async run(app) {
      const ms = await models(app)
      const a = ms.find((m) => m.name === '模型A')
      const b = ms.find((m) => m.name === '模型B')
      let list = await models(app)
      assert.equal(list.filter((m) => m.is_default).length, 1, '默认模型应唯一')
      assert.equal(list.find((m) => m.is_default).id, a.id, '添加时勾选默认的模型A应为默认')
      // 已默认的模型不显示「设为默认」
      await app.clickText('.item[data-model]', '模型A')
      await app.waitFor(() => !!document.querySelector('#mdName'))
      assert.equal(await app.exists('#setDefaultBtn'), false, '已是默认的模型不应显示「设为默认」')
      // 把默认切到 B
      await app.clickText('.item[data-model]', '模型B')
      await app.waitFor(() => !!document.querySelector('#setDefaultBtn'))
      await app.click('#setDefaultBtn')
      await app.waitFor(`!document.querySelector('#setDefaultBtn')`, 8000, '默认切换后按钮消失')
      list = await models(app)
      const defs = list.filter((m) => m.is_default)
      assert.equal(defs.length, 1, '默认模型应唯一')
      assert.equal(defs[0].id, b.id)
    }
  },
  {
    name: '编辑提供方级联到模型',
    async run(app) {
      await openProvider(app, '回归提供方')
      await app.setValue('#pvName', '回归提供方改')
      await app.setValue('#pvUrl', 'http://127.0.0.1:2/v1')
      await app.setValue('#pvType', 'anthropic')
      await app.click('#pvSave')
      await waitToast(app, '已保存提供方配置')
      const p = (await providers(app))[0]
      assert.equal(p.name, '回归提供方改')
      assert.equal(p.type, 'anthropic')
      assert.equal(p.base_url, 'http://127.0.0.1:2/v1')
      const ms = await models(app)
      assert.ok(ms.every((m) => m.type === 'anthropic' && m.base_url === 'http://127.0.0.1:2/v1'))
    }
  },
  {
    name: '更换提供方 API Key',
    async run(app) {
      const p = (await providers(app))[0]
      await app.click('#pvKeyBtn')
      await app.modalFill({ key: 'sk-regress-v2' })
      await app.modalOk()
      await app.waitFor(() => !!document.querySelector('#pvKeyBtn'))
      const val = await app.invoke('secrets', 'get', { key: 'zzwork.key.provider.' + p.id })
      assert.equal(val, 'sk-regress-v2')
    }
  },
  {
    name: '任务模型选择：默认预选与切换',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await selectTask(app, '主任务改名')
      await app.waitFor(() => !!document.querySelector('#modelSel'))
      const first = await app.call(() => document.querySelector('#modelSel option').textContent)
      assert.ok(first.includes('（默认：模型B）'), first)
      const ms = await models(app)
      const a = ms.find((m) => m.name === '模型A')
      const t = (await app.store('tasks.list')).find((x) => x.name === '主任务改名')
      await app.selectValue('#modelSel', a.id)
      await app.waitFor(`(async () => {
        const ts = await window.zzwork.invoke('store', 'tasks.list')
        const x = ts.find((v) => v.id === ${JSON.stringify(t.id)})
        return !!(x && x.model_id === ${JSON.stringify(a.id)})
      })()`, 8000, '任务模型已保存')
      let updated = (await app.store('tasks.list')).find((x) => x.id === t.id)
      assert.equal(updated.model_id, a.id)
      await app.selectValue('#modelSel', '')
      await app.waitFor(`(async () => {
        const ts = await window.zzwork.invoke('store', 'tasks.list')
        const x = ts.find((v) => v.id === ${JSON.stringify(t.id)})
        return !!(x && x.model_id === '')
      })()`, 8000, '任务模型已清空')
      updated = (await app.store('tasks.list')).find((x) => x.id === t.id)
      assert.equal(updated.model_id, '')
    }
  },
  {
    name: '删除模型',
    async run(app) {
      const a = (await models(app)).find((m) => m.name === '模型A')
      await setView(app, 'models')
      await app.clickText('.item[data-model]', '模型A')
      await app.waitFor(() => !!document.querySelector('#delModel'))
      await app.click('#delModel')
      await app.waitFor(`!document.querySelector('#modelsBody').textContent.includes('模型A')`)
      const ms = await models(app)
      assert.equal(ms.length, 1)
      assert.equal(ms[0].name, '模型B')
      assert.ok(a)
    }
  },
  {
    name: '删除提供方级联（模型 + Key + 任务引用）',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const p = (await providers(app))[0]
      const b = (await models(app))[0]
      const t = (await app.store('tasks.list')).find((x) => x.name === '主任务改名')
      await app.store('tasks.update', { id: t.id, patch: { model_id: b.id } })
      await openProvider(app, '回归提供方改')
      await app.click('#pvDel')
      await app.waitFor(`document.querySelector('#modelsBody').textContent.includes('还没有提供方')`)
      assert.equal((await providers(app)).length, 0)
      assert.equal((await models(app)).length, 0)
      const after = (await app.store('tasks.list')).find((x) => x.id === t.id)
      assert.equal(after.model_id, '')
      const has = await app.invoke('secrets', 'has', { key: 'zzwork.key.provider.' + p.id })
      assert.equal(has, false)
    }
  }
]
