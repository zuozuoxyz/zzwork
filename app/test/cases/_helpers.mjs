import assert from 'node:assert/strict'

export async function setView(app, name) {
  await app.click(`.abi[data-view="${name}"]`)
}

export async function selectTask(app, name) {
  await setView(app, 'projects')
  const before = await app.call(() => {
    const b = document.querySelector('#infoBody')
    return (b && b.dataset.renderId) || '0'
  })
  await app.call((n) => {
    const row = [...document.querySelectorAll('.row[data-task]')].find((r) => r.textContent.includes(n))
    if (!row) throw new Error('任务行不存在: ' + n)
    row.click()
    return true
  }, name)
  await app.waitFor(`(() => {
    const b = document.querySelector('#infoBody')
    return !!b && b.dataset.renderId !== ${JSON.stringify(before)} && b.textContent.includes(${JSON.stringify(name)})
  })()`, 10000, '信息页显示任务 ' + name)
}

export async function createTaskUI(app, { name, type = 'work', path = '' } = {}) {
  await setView(app, 'projects')
  await app.click('#newTaskBtn')
  await app.modalFill({ name, type, path })
  await app.modalOk()
  await app.waitFor(
    `[...document.querySelectorAll('.row[data-task]')].some(r=>r.textContent.includes(${JSON.stringify(name)}))`,
    10000, '任务行出现 ' + name
  )
  const tasks = await app.store('tasks.list')
  const t = tasks.find((x) => x.name === name)
  assert.ok(t, '任务未落库: ' + name)
  return t
}

export async function ensureTask(app, name, { type = 'work' } = {}) {
  const t = (await app.store('tasks.list')).find((x) => x.name === name)
  if (t) return t
  return createTaskUI(app, { name, type })
}

export async function waitToast(app, text, timeout = 8000) {
  return app.waitFor(
    `[...document.querySelectorAll('#toast-host .zz-toast')].some(t=>t.textContent.includes(${JSON.stringify(text)}))`,
    timeout, '提示「' + text + '」'
  )
}

export async function tasksByName(app) {
  const list = await app.store('tasks.list')
  return (name) => list.find((t) => t.name === name)
}
