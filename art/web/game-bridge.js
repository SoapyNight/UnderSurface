/* 网页 ↔ 游戏 通信桥：
  ① 网页 → 游戏：向父窗口自报当前页面文件名。
     以 file:// 打开游戏时，每个文档都是不透明源，父窗口读取 iframe 的 location
     会抛 SecurityError（导致线索 / 成就 / 浏览历史 / 官网 F12 面板全部失效）。
     postMessage 不受同源限制，因此改由每个网页主动上报，父窗口据此统一处理。
  ② 游戏 → 网页：收到 {type:'web:clue', keyword} 后，不自动定位，交由玩家自行滚动翻找；
     当该关键词元素进入视口中心带（上 1/4 ~ 下 3/4）时，把它移到页面正中心并高亮，
     同时上报 {type:'web:clue-found', page, keyword}（仅首次）。
     线索的发放与内心独白由游戏父窗口在收到上报后处理。 */
(function () {
  var page = (location.pathname || '').split('/').pop(); // 只取文件名，如 index.html

  /* ---- 找出「含关键词、且文本最短」的元素（最贴近关键信息的那一处） ---- */
  function findTarget(kw) {
    var nodes = document.querySelectorAll('body *');
    var best = null, bestLen = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var txt = nodes[i].textContent || '';
      if (txt.indexOf(kw) < 0) continue;
      if (txt.length < bestLen) { best = nodes[i]; bestLen = txt.length; }
    }
    return best;
  }

  function highlight(node) {
    var oldOutline = node.style.outline;
    var oldOffset = node.style.outlineOffset;
    node.style.outline = '3px solid #ffcc33';
    node.style.outlineOffset = '3px';
    setTimeout(function () {
      node.style.outline = oldOutline;
      node.style.outlineOffset = oldOffset;
    }, 2600);
  }

  function centerOn(node) {
    try { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch (e) { try { node.scrollIntoView(); } catch (e2) {} }
    highlight(node);
  }

  /* 视野中心带：视口高度的 1/4 ~ 3/4 */
  function inCenterBand(node) {
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!vh) return false;
    var r = node.getBoundingClientRect();
    if (!r.height && !r.width) return false;   // 尚未完成布局
    var center = r.top + r.height / 2;
    return center >= vh * 0.25 && center <= vh * 0.75;
  }

  function scrollable() {
    var d = document.documentElement, b = document.body;
    var h = Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0);
    var vh = window.innerHeight || (d ? d.clientHeight : 0) || 0;
    return h > vh + 24;
  }

  var watch = null;   // { keyword, node, fired }

  function onScroll() {
    if (!watch || watch.fired) return;
    var node = watch.node || findTarget(watch.keyword);
    if (!node) return;
    watch.node = node;
    if (inCenterBand(node)) fire(node, watch.keyword);
  }

  function fire(node, keyword) {
    watch.fired = true;
    window.removeEventListener('scroll', onScroll);
    centerOn(node);   // 把核心线索移到页面正中心
    try { window.parent.postMessage({ type: 'web:clue-found', page: page, keyword: keyword }, '*'); } catch (e) {}
  }

  /* 武装滚动监听：每次页面载入只处理一次；命中后不再重复居中 / 上报 */
  function armClueWatch(kw) {
    if (!kw || watch) return;
    watch = { keyword: kw, node: null, fired: false };
    window.addEventListener('scroll', onScroll, { passive: true });

    // 页面可能尚未解析完（父窗口在 iframe load 之前就发来了指令）：轮询等待元素出现
    var tries = 0;
    (function poll() {
      if (!watch || watch.fired) return;
      var node = findTarget(watch.keyword);
      if (!node) {
        if (tries++ < 25) setTimeout(poll, 120);
        return;
      }
      watch.node = node;
      // 元素此刻已在中心带内（首屏可见）→ 直接命中；页面不可滚动时玩家无从翻找，也直接给出
      if (inCenterBand(node) || !scrollable()) fire(node, watch.keyword);
    })();
  }

  try {
    if (window.parent === window) return;                 // 非 iframe 内，忽略

    // 监听父窗口的指令（游戏 → 网页）
    window.addEventListener('message', function (ev) {
      var d = ev.data || {};
      if (d.type === 'web:clue' && typeof d.keyword === 'string') armClueWatch(d.keyword);
    });

    if (!page) return;
    window.parent.postMessage({ type: 'web:page', page: page }, '*');
  } catch (e) {}
})();
