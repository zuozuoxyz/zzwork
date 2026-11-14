// zzwork UI patch:
// 1) 五个 zzwork 活动栏图标排最前
// 2) 隐藏原生活动栏图标（Explorer/搜索/源代码管理/运行/扩展/账号）
// 3) 隐藏标题栏 Update 按钮、菜单中更新/同步类项
(function () {
  var NAMES = ['项目', '环境', 'Skills', 'MCP', '模型', '设置']
  var HIDE_ACTIVITY = ['Search', 'Source Control', 'Run and Debug', 'Extensions', 'Accounts', 'Testing', 'Remote Explorer']
  var HIDE_MENU = ['Check for Update', 'Backup and Sync', 'Sign in', 'Sign In', 'Settings Sync', 'Turn On']
  var busy = false

  function orderAndHide() {
    if (busy) return
    var bar = document.querySelector('.activitybar .actions-container')
    if (!bar) return
    var items = Array.prototype.slice.call(bar.children)
    // 1) 隐藏原生项
    items.forEach(function (li) {
      var a = li.querySelector && li.querySelector('a[aria-label]')
      if (!a) return
      var label = a.getAttribute('aria-label') || ''
      var hide = HIDE_ACTIVITY.some(function (n) { return label.indexOf(n) === 0 })
      if (hide) li.style.display = 'none'
    })
    // 2) zzwork 项排最前
    var picked = []
    for (var i = 0; i < NAMES.length; i++) {
      var found = null
      for (var j = 0; j < items.length; j++) {
        var a2 = items[j].querySelector && items[j].querySelector('a[aria-label]')
        if (a2 && a2.getAttribute('aria-label') === NAMES[i]) { found = items[j]; break }
      }
      if (!found) return
      picked.push(found)
    }
    if (bar.firstElementChild === picked[0]) return
    busy = true
    for (var k = picked.length - 1; k >= 0; k--) bar.insertBefore(picked[k], bar.firstElementChild)
    busy = false
  }

  // 菜单是动态创建的：全局监听 DOM 插入，隐藏更新/同步菜单项
  function filterMenus() {
    document.querySelectorAll('.monaco-menu .action-item, .context-view .action-item').forEach(function (li) {
      if (li.__zzFiltered) return
      var label = (li.getAttribute('aria-label') || '') + ' ' + (li.textContent || '')
      if (HIDE_MENU.some(function (n) { return label.indexOf(n) >= 0 })) {
        li.style.display = 'none'
        li.__zzFiltered = true
      }
    })
  }

  // 标题栏 Update 按钮
  function hideUpdateButton() {
    document.querySelectorAll('.titlebar .action-item, .titlebar-center .action-item').forEach(function (li) {
      var a = li.querySelector('a[aria-label]')
      if (a && /Update/i.test(a.getAttribute('aria-label') || '')) li.style.display = 'none'
    })
  }

  function tick() { orderAndHide(); filterMenus(); hideUpdateButton() }

  function start() {
    var bar = document.querySelector('.activitybar .actions-container')
    if (!bar) return setTimeout(start, 400)
    tick()
    new MutationObserver(function () { setTimeout(tick, 0) }).observe(document.body, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
