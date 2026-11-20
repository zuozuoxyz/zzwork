import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { selectTask, waitToast, ensureTask } from './_helpers.mjs'

async function task(app, name) {
  return (await app.store('tasks.list')).find((t) => t.name === name)
}

async function openFromTree(app, name) {
  await app.waitFor(`(() => {
    const row = [...document.querySelectorAll('#filesTree .fr')].find((r) => r.textContent.includes(${JSON.stringify(name)}))
    if (!row) return false
    row.click()
    return true
  })()`, 8000, '打开文件 ' + name)
}

const tabFor = (name) => `.tab[data-file]`

export default [
  {
    name: '文件树渲染任务目录',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await selectTask(app, '主任务改名')
      await app.waitFor(`!!document.querySelector('#filesTree #ftreeBody')`, 10000)
      assert.ok(await app.exists('#ftNewFile'))
      assert.ok(await app.exists('#ftNewDir'))
    }
  },
  {
    name: '文件树显示 .gitignore 但隐藏 .git 目录',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      const giPath = path.join(t.path, '.gitignore')
      const gitDir = path.join(t.path, '.git')
      fs.writeFileSync(giPath, 'node_modules\n')
      if (!fs.existsSync(gitDir)) fs.mkdirSync(gitDir)
      try {
        await selectTask(app, '主任务改名')
        await app.click('#ftRefresh')
        await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some((r) => r.title === '.gitignore')`, 8000, '.gitignore 应显示')
        const hasGitDir = await app.call(() => [...document.querySelectorAll('#filesTree .fr')].some((r) => r.title === '.git'))
        assert.ok(!hasGitDir, '.git 目录应隐藏')
      } finally {
        fs.rmSync(giPath, { force: true })
        fs.rmSync(gitDir, { recursive: true, force: true })
        await app.click('#ftRefresh')
      }
    }
  },
  {
    name: '新建文件并在编辑器中打开',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      await app.click('#ftNewFile')
      await app.modalFill({ value: 'notes.md' })
      await app.modalOk()
      await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('notes.md'))`, 8000)
      assert.ok(fs.existsSync(path.join(t.path, 'notes.md')))
      await app.waitFor(`document.querySelector('#pane-file').classList.contains('on')`, 8000, '编辑器 pane 打开')
      await app.waitFor(`[...document.querySelectorAll(${JSON.stringify(tabFor('notes.md'))})].some(t=>t.textContent.includes('notes.md'))`, 8000)
    }
  },
  {
    name: '新建文件夹',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      await app.click('#ftNewDir')
      await app.modalFill({ value: 'docs' })
      await app.modalOk()
      await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('docs'))`, 8000)
      assert.ok(fs.statSync(path.join(t.path, 'docs')).isDirectory())
    }
  },
  {
    name: '展开文件夹箭头与子项保持渲染',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await selectTask(app, '主任务改名')
      const clickRow = (name) => app.call((n) => {
        const r = [...document.querySelectorAll('#filesTree .fr')].find((x) => x.textContent.includes(n))
        if (!r) return false
        r.click()
        return true
      }, name)
      const rowState = (name) => app.call((n) => {
        const r = [...document.querySelectorAll('#filesTree .fr')].find((x) => x.textContent.includes(n))
        return r ? { open: r.classList.contains('open'), chev: !!r.querySelector('.chev svg') } : null
      }, name)
      await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('docs'))`, 8000)
      const before = await rowState('docs')
      assert.ok(before && before.chev && !before.open, '文件夹默认带展开箭头: ' + JSON.stringify(before))
      await clickRow('docs')
      await app.waitFor(`(() => { const r=[...document.querySelectorAll('#filesTree .fr')].find(x=>x.textContent.includes('docs')); return !!r && r.classList.contains('open') })()`, 8000, '展开')
      const opened = await rowState('docs')
      assert.ok(opened.chev, '展开后箭头图标不应消失')
      await clickRow('docs')
      await app.waitFor(`(() => { const r=[...document.querySelectorAll('#filesTree .fr')].find(x=>x.textContent.includes('docs')); return !!r && !r.classList.contains('open') })()`, 8000, '收起')
    }
  },
  {
    name: '展开文件夹后保持滚动位置',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      const dir = path.join(t.path, 'scroll-dir')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'inner.txt'), 'x')
      for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(t.path, `sfile-${String(i).padStart(2, '0')}.txt`), 'x')
      await selectTask(app, '主任务改名')
      await app.click('#ftRefresh')
      await app.waitFor(`document.querySelector('#ftreeBody').querySelectorAll('.fr').length >= 40`, 10000, '文件树就绪')
      const before = await app.call(() => {
        const b = document.querySelector('#ftreeBody')
        b.scrollTop = 120
        return b.scrollTop
      })
      assert.ok(before > 60, '文件树应可滚动: ' + before)
      await app.call(() => {
        const r = [...document.querySelectorAll('#filesTree .fr')].find((x) => x.textContent.includes('scroll-dir'))
        if (r) r.click()
        return !!r
      })
      await app.waitFor(`(() => { const r=[...document.querySelectorAll('#filesTree .fr')].find(x=>x.textContent.includes('scroll-dir')); return !!r && r.classList.contains('open') })()`, 8000, '文件夹展开')
      const after = await app.call(() => document.querySelector('#ftreeBody').scrollTop)
      // 不能重置到顶部；Chrome 滚动锚定会在上方插入子项时微调 scrollTop 保持可见内容不变
      assert.ok(after >= before - 4 && after < before + 120, `展开文件夹后滚动位置应保持（${before} → ${after}）`)
    }
  },
  {
    name: '空白处右键新建文件夹',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      await selectTask(app, '主任务改名')
      await app.waitFor(`!!document.querySelector('#ftreeBody')`, 8000)
      await app.call(() => {
        document.querySelector('#ftreeBody').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 220 }))
        return true
      })
      await app.waitFor(() => !!document.querySelector('#ctx-host .zz-ctx'), 3000, '空白右键菜单')
      await app.clickText('#ctx-host .zz-ctx button', '新建文件夹')
      await app.modalFill({ value: 'blankdir' })
      await app.modalOk()
      await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('blankdir'))`, 8000)
      assert.ok(fs.statSync(path.join(t.path, 'blankdir')).isDirectory())
    }
  },
  {
    name: '重新打开文件显示磁盘内容',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      const file = path.join(t.path, 'notes.md')
      await app.invoke('fs', 'writeFile', { path: file, content: '# hello 内容' })
      await app.click('.tab[data-file] .x')
      await app.waitFor(`document.querySelectorAll('.tab[data-file]').length === 0`)
      await openFromTree(app, 'notes.md')
      await app.waitFor(`(document.querySelector('#editorHost .view-lines')||{}).textContent?.includes('hello')`, 15000, '编辑器显示文件内容')
    }
  },
  {
    name: '编辑文件出现脏标记与改动清单',
    async run(app) {
      await app.clickEl('#editorHost')
      await app.insertText(' world')
      await app.waitFor(`[...document.querySelectorAll('.tab[data-file]')].some(t=>t.textContent.includes('•'))`, 8000, '脏标记出现')
      await app.click('.tab[data-pane="session"]')
      await app.waitFor(`document.querySelector('#sessionChanges').textContent.includes('notes.md')`, 8000, '改动清单出现')
    }
  },
  {
    name: 'Ctrl+S 保存文件',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      await app.pressKey({ key: 's', code: 'KeyS', keyCode: 83, modifiers: 2 })
      await waitToast(app, '已保存 notes.md')
      const disk = fs.readFileSync(path.join(t.path, 'notes.md'), 'utf8')
      assert.ok(disk.includes('hello') && disk.includes('world'), disk)
      await app.waitFor(`![...document.querySelectorAll('.tab[data-file]')].some(t=>t.textContent.includes('•'))`, 8000, '脏标记清除')
    }
  },
  {
    name: '关闭文件 tab',
    async run(app) {
      await app.click('.tab[data-file] .x')
      await app.waitFor(`document.querySelectorAll('.tab[data-file]').length === 0`)
      await app.waitFor(`document.querySelector('#pane-info').classList.contains('on')`)
    }
  },
  {
    name: '重命名文件',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      await app.contextMenuText('#filesTree .fr', 'notes.md', '重命名…')
      await app.modalFill({ value: 'renamed.md' })
      await app.modalOk()
      await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('renamed.md'))`, 8000)
      assert.ok(fs.existsSync(path.join(t.path, 'renamed.md')))
      assert.ok(!fs.existsSync(path.join(t.path, 'notes.md')))
    }
  },
  {
    name: '切换任务后恢复文件 tab',
    async run(app) {
      await ensureTask(app, '主任务改名')
      await ensureTask(app, '路径任务', { type: 'code' })
      await selectTask(app, '主任务改名')
      await openFromTree(app, 'renamed.md')
      await app.waitFor(`document.querySelectorAll('.tab[data-file]').length === 1`)
      await selectTask(app, '路径任务')
      await app.waitFor(`document.querySelectorAll('.tab[data-file]').length === 0`)
      await selectTask(app, '主任务改名')
      await app.waitFor(`[...document.querySelectorAll('.tab[data-file]')].some(t=>t.textContent.includes('renamed.md'))`, 8000, 'tab 记忆恢复')
      await app.clickText('.tab[data-file]', 'renamed.md')
      await app.waitFor(`(document.querySelector('#editorHost .view-lines')||{}).textContent?.includes('world')`, 15000, '恢复后的文件内容')
    }
  },
  {
    name: '删除文件',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      await app.contextMenuText('#filesTree .fr', 'renamed.md', '删除')
      await app.waitFor(`![...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('renamed.md'))`, 8000)
      assert.ok(!fs.existsSync(path.join(t.path, 'renamed.md')))
    }
  }
]
