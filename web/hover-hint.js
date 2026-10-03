/* 网页悬停提示：鼠标移到网页内可点击的线索上时，在光标旁弹出像素风小提示。
   线索在这批网页里表现为两类可点击元素：
     · 指向站内其它页面的链接 <a href="xxx.html">（点击后由游戏判定线索 / 成就）
     · 功能性按钮 <button> / [onclick]（如"搜索一下""加载更多"）
   纯装饰用的 href="#" / mailto: / javascript: 链接不做提示，避免误导玩家。
   与 pixel-theme.css / game-bridge.js 一样，本脚本被全部网页共享。 */
(function () {
  if (window.__webHoverHint) return;
  window.__webHoverHint = true;

  var CLICKABLE = 'a[href], button, [role="button"], [onclick], input[type="button"], input[type="submit"]';
  var TIP_ID = 'web-hover-hint';
  var tip = null;
  var active = null;

  /* 装饰 / 占位链接：锚点、脚本、邮件、电话 —— 不可导航，不提示 */
  function isPlaceholder(href) {
    if (!href) return true;
    var h = String(href).replace(/^\s+|\s+$/g, '').toLowerCase();
    return h === '' ||
      h.charAt(0) === '#' ||
      h.indexOf('javascript:') === 0 ||
      h.indexOf('mailto:') === 0 ||
      h.indexOf('tel:') === 0;
  }

  /* 由事件目标向上找最近的可提示元素；无则返回 null */
  function resolve(node) {
    var el = node && node.nodeType === 1 && node.closest ? node.closest(CLICKABLE) : null;
    if (!el) return null;
    if (el.disabled) return null;
    if (el.getAttribute('data-nohint') != null) return null;
    if (el.tagName === 'A') {
      if (isPlaceholder(el.getAttribute('href'))) return null;
      return { el: el, text: '点击查看' };
    }
    return { el: el, text: '点击' };
  }

  function ensureTip() {
    if (tip && tip.parentNode) return tip;
    var st = document.createElement('style');
    st.textContent =
      '#' + TIP_ID + '{' +
        'position:fixed!important;left:0;top:0;z-index:2147483647;display:none;' +
        'padding:3px 8px;max-width:240px;white-space:nowrap;' +
        'background:#1e1508;color:#ffd27a;border:2px solid #c18225;' +
        'box-shadow:2px 2px 0 rgba(0,0,0,.9),inset 1px 1px 0 #e3ac4e,inset -1px -1px 0 #7e5410;' +
        'font-family:"Zpix","Courier New",monospace;font-size:12px;line-height:16px;' +
        'letter-spacing:1px;cursor:default;pointer-events:none;image-rendering:pixelated;' +
        'transition:none!important;animation:none!important;}' +
      '#' + TIP_ID + '.on{display:block!important;}';
    (document.head || document.documentElement).appendChild(st);

    tip = document.createElement('div');
    tip.id = TIP_ID;
    (document.body || document.documentElement).appendChild(tip);
    return tip;
  }

  /* 跟随光标，并在视口边界内做钳制（右下放不下就翻到左上） */
  function place(x, y) {
    if (!tip) return;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var left = x + 14, top = y + 18;
    if (left + w > vw - 6) left = x - w - 10;
    if (left < 6) left = 6;
    if (top + h > vh - 6) top = y - h - 12;
    if (top < 6) top = 6;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function show(el, text, x, y) {
    ensureTip();
    var label = '\u25b8 ' + text; /* ▸ 前缀 */
    if (tip.textContent !== label) tip.textContent = label;
    tip.classList.add('on');
    place(x, y);
  }

  function hide() {
    active = null;
    if (tip) tip.classList.remove('on');
  }

  document.addEventListener('mouseover', function (ev) {
    var hit = resolve(ev.target);
    if (!hit) { hide(); return; }
    if (hit.el === active) return;
    active = hit.el;
    show(hit.el, hit.text, ev.clientX, ev.clientY);
  }, true);

  document.addEventListener('mouseout', function (ev) {
    if (!active) return;
    var to = ev.relatedTarget;
    if (to && active.contains && active.contains(to)) return; /* 仍在同一线索内 */
    hide();
  }, true);

  document.addEventListener('mousemove', function (ev) {
    if (active) { place(ev.clientX, ev.clientY); return; }
    /* 滚动等原因隐藏后，只要光标仍停在可点击元素上就自动恢复提示 */
    var hit = resolve(ev.target);
    if (hit) { active = hit.el; show(hit.el, hit.text, ev.clientX, ev.clientY); }
  }, true);

  document.addEventListener('mousedown', hide, true);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('mouseleave', hide);
  window.addEventListener('blur', hide);
})();
