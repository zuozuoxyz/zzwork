(function () {
  var out = [];
  var targets = ['任务详情', 'zzwork.tasks', '任务'];
  var walk = function (root, label) {
    if (!root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      var t = walker.currentNode.textContent;
      if (t && t.trim() === '任务详情') {
        var el = walker.currentNode.parentElement, chain = [label];
        for (var i = 0; el && i < 9; i++) {
          var desc = el.id ? '#' + el.id : '.' + String(el.className).split(' ').slice(0, 2).join('.');
          chain.push(desc);
          el = el.parentElement;
        }
        out.push(chain.join('\n  <- '));
      }
    }
  };
  walk(document.getElementById('workbench.parts.auxiliarybar'), '[aux]');
  walk(document.getElementById('workbench.parts.sidebar'), '[sidebar]');
  return out.join('\n---\n') || 'not-found-in-aux-or-sidebar';
})()
