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
    name: '拖拽移动文件与文件夹',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      const a = path.join(t.path, 'mvA')
      const b = path.join(t.path, 'mvB')
      fs.mkdirSync(a, { recursive: true })
      fs.mkdirSync(b, { recursive: true })
      const file = path.join(t.path, 'mvfile.txt')
      fs.writeFileSync(file, 'm')
      await selectTask(app, '主任务改名')
      await app.click('#ftRefresh')
      await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.title==='mvfile.txt')`, 8000, '文件就绪')

      const dragByName = (srcName, dstName) => app.call((sn, dn) => {
        const find = (n) => [...document.querySelectorAll('#filesTree .fr')].find((r) => r.title === n)
        const s = find(sn)
        const d = find(dn)
        if (!s || !d) throw new Error('拖拽元素缺失 ' + sn + ' / ' + dn)
        const dt = new DataTransfer()
        s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
        d.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
        d.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
        s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
        return true
      }, srcName, dstName)

      // 文件拖入文件夹（mvA 默认收起，移动后根目录不再显示该文件）
      await dragByName('mvfile.txt', 'mvA')
      await app.waitFor(`![...document.querySelectorAll('#filesTree .fr')].some(r=>r.title==='mvfile.txt')`, 8000, '文件移出根目录')
      assert.ok(fs.existsSync(path.join(a, 'mvfile.txt')), '文件应移动到 mvA')
      assert.ok(!fs.existsSync(file), '根目录文件应不存在')

      // 文件夹拖入另一个文件夹（mvB 收起，移动后根目录不再显示 mvA）
      await dragByName('mvA', 'mvB')
      await app.waitFor(`![...document.querySelectorAll('#filesTree .fr')].some(r=>r.title==='mvA')`, 8000, '文件夹移出根目录')
      assert.ok(fs.existsSync(path.join(b, 'mvA', 'mvfile.txt')), 'mvA 应移动到 mvB 内')

      fs.rmSync(b, { recursive: true, force: true })
      fs.rmSync(a, { recursive: true, force: true })
      await app.click('#ftRefresh')
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
        return r ? { open: r.classList.contains('open'), chev: !!r.querySelector('.chev svg'), fi: !!r.querySelector('.fi svg') } : null
      }, name)
      await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('docs'))`, 8000)
      const before = await rowState('docs')
      assert.ok(before && before.chev && !before.open, '文件夹默认带展开箭头: ' + JSON.stringify(before))
      await clickRow('docs')
      await app.waitFor(`(() => { const r=[...document.querySelectorAll('#filesTree .fr')].find(x=>x.textContent.includes('docs')); return !!r && r.classList.contains('open') })()`, 8000, '展开')
      const opened = await rowState('docs')
      assert.ok(opened.chev, '展开后箭头图标不应消失')
      assert.ok(opened.fi, '展开后文件夹图标应存在')
      await clickRow('docs')
      await app.waitFor(`(() => { const r=[...document.querySelectorAll('#filesTree .fr')].find(x=>x.textContent.includes('docs')); return !!r && !r.classList.contains('open') })()`, 8000, '收起')
      const closed = await rowState('docs')
      assert.ok(closed.chev && closed.fi, '收起后箭头与文件夹图标都不应消失: ' + JSON.stringify(closed))
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
      // md 默认渲染预览，切到源码查看磁盘内容
      await app.waitFor(`!!document.querySelector('#previewHost [data-pv="toggle"]')`, 8000, 'md 预览就绪')
      await app.click('#previewHost [data-pv="toggle"]')
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
      // md 默认渲染预览，切到源码查看内容
      await app.waitFor(`!!document.querySelector('#previewHost [data-pv="toggle"]')`, 8000, 'md 预览就绪')
      await app.click('#previewHost [data-pv="toggle"]')
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
  },
  {
    name: '点击图片以图片方式预览（不乱码）',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      fs.writeFileSync(path.join(t.path, 'pixel.png'), Buffer.from(png, 'base64'))
      await selectTask(app, '主任务改名')
      await app.click('#ftRefresh')
      await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('pixel.png'))`, 8000)
      await openFromTree(app, 'pixel.png')
      await app.waitFor(`(() => {
        const h = document.querySelector('#previewHost')
        if (!h || getComputedStyle(h).display === 'none') return false
        const img = h.querySelector('.imgpane img')
        return !!img && img.src.startsWith('data:image/png') && img.naturalWidth > 0
      })()`, 10000, '图片预览显示')
      assert.equal(await app.exists('#editorHost .view-lines'), false, '图片不应以文本编辑器打开')
      await app.click('.tab[data-file] .x')
      await app.waitFor(`document.querySelectorAll('.tab[data-file]').length === 0`)
    }
  },
  {
    name: '点击 HTML 以网页方式预览（含相对资源）',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      if (!fs.existsSync(path.join(t.path, 'pixel.png'))) {
        fs.writeFileSync(path.join(t.path, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
      }
      fs.writeFileSync(path.join(t.path, 'page.html'),
        `<!doctype html><html><body><h1>预览标题</h1>
<script>
  const i = new Image()
  i.onload = () => { parent.postMessage('pv-ok', '*') }
  i.onerror = () => { parent.postMessage('pv-fail', '*') }
  i.src = 'pixel.png'
</script></body></html>`, 'utf8')
      await selectTask(app, '主任务改名')
      await app.click('#ftRefresh')
      await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('page.html'))`, 8000)
      await app.call(() => {
        window.__pv = ''
        window.addEventListener('message', (e) => { window.__pv = String(e.data) })
        return true
      })
      await openFromTree(app, 'page.html')
      await app.waitFor(`!!document.querySelector('#pvFrame')`, 8000, '预览 iframe 出现')
      const src = await app.call(() => document.querySelector('#pvFrame').getAttribute('src'))
      assert.ok(src && src.startsWith('zzwork-file://local/'), 'iframe 应走预览协议: ' + src)
      await app.waitFor(`document.querySelector('#pvFrame').dataset.loaded === '1'`, 10000, 'iframe 加载完成')
      await app.waitFor(`window.__pv === 'pv-ok'`, 10000, '页面脚本与相对图片资源正常')
      // 源码按钮切到 Monaco 文本编辑
      await app.click('#previewHost [data-pv="toggle"]')
      await app.waitFor(`(document.querySelector('#editorHost .view-lines')||{}).textContent?.includes('预览标题')`, 15000, '源码模式显示 HTML')
      // 源码模式下右上角可切回预览
      await app.waitFor(`!!document.querySelector('#fileBar [data-pv="toggle"]')`, 8000, '源码模式出现预览切换按钮')
      await app.click('#fileBar [data-pv="toggle"]')
      await app.waitFor(`!!document.querySelector('#pvFrame')`, 8000, '切回 HTML 预览')
      await app.click('.tab[data-file] .x')
      await app.waitFor(`document.querySelectorAll('.tab[data-file]').length === 0`)
    }
  },
  {
    name: 'Markdown 默认渲染并可切换源码/预览',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      const file = path.join(t.path, 'doc.md')
      fs.writeFileSync(file, '# 标题渲染\n\n正文 **加粗** 内容\n', 'utf8')
      try {
        await selectTask(app, '主任务改名')
        await app.click('#ftRefresh')
        await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('doc.md'))`, 8000)
        await openFromTree(app, 'doc.md')
        // 默认 markdown 渲染
        await app.waitFor(`(() => {
          const v = document.querySelector('#mdView')
          return !!v && !!v.querySelector('h1') && v.textContent.includes('标题渲染')
        })()`, 10000, 'markdown 默认渲染')
        assert.equal(await app.exists('#editorHost .view-lines'), false, '默认不以文本编辑器打开 md')
        // 切到源码
        await app.click('#previewHost [data-pv="toggle"]')
        await app.waitFor(`(document.querySelector('#editorHost .view-lines')||{}).textContent?.includes('标题渲染')`, 15000, 'md 源码显示')
        // 切回预览
        await app.waitFor(`!!document.querySelector('#fileBar [data-pv="toggle"]')`, 8000, 'md 源码出现预览按钮')
        await app.click('#fileBar [data-pv="toggle"]')
        await app.waitFor(`!!document.querySelector('#mdView h1')`, 8000, 'md 切回预览')
        await app.click('.tab[data-file] .x')
        await app.waitFor(`document.querySelectorAll('.tab[data-file]').length === 0`)
      } finally {
        fs.rmSync(file, { force: true })
        await app.click('#ftRefresh')
      }
    }
  },
  {
    name: 'JSON 默认源码并可切换格式化/源码',
    async run(app) {
      await ensureTask(app, '主任务改名')
      const t = await task(app, '主任务改名')
      const file = path.join(t.path, 'config.json')
      fs.writeFileSync(file, '{"a":1,"b":[2,3]}', 'utf8')
      try {
        await selectTask(app, '主任务改名')
        await app.click('#ftRefresh')
        await app.waitFor(`[...document.querySelectorAll('#filesTree .fr')].some(r=>r.textContent.includes('config.json'))`, 8000)
        await openFromTree(app, 'config.json')
        // 默认源码（Monaco）
        await app.waitFor(`(document.querySelector('#editorHost .view-lines')||{}).textContent?.includes('"a"')`, 15000, 'json 默认源码')
        assert.equal(await app.exists('#jsonView'), false, '默认不以格式化视图打开 json')
        await app.waitFor(`!!document.querySelector('#fileBar [data-pv="toggle"]')`, 8000, 'json 源码出现格式化按钮')
        // 格式化
        await app.click('#fileBar [data-pv="toggle"]')
        await app.waitFor(`(() => {
          const p = document.querySelector('#jsonView')
          return !!p && p.textContent.includes('"a": 1') && p.textContent.includes('\\n')
        })()`, 8000, 'json 格式化显示')
        // 切回源码
        await app.click('#previewHost [data-pv="toggle"]')
        await app.waitFor(`(document.querySelector('#editorHost .view-lines')||{}).textContent?.includes('"a"')`, 15000, 'json 切回源码')
        await app.click('.tab[data-file] .x')
        await app.waitFor(`document.querySelectorAll('.tab[data-file]').length === 0`)
      } finally {
        fs.rmSync(file, { force: true })
        await app.click('#ftRefresh')
      }
    }
  }
]
