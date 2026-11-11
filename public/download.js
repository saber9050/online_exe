/* 下载页脚本：严格 ES5，兼容 Win7 + IE11。
 * 只做「UA 自动定位」「下载前探测版本是否还在架」这类可降级的增强。
 * JS 失效时页面依然可用：点链接会落到服务端渲染的提示页。
 * 不要在这里使用 const / let / 箭头函数 / 模板字符串 / fetch。
 */
(function () {
  'use strict';

  // 子组 id → 所属大类 id。Windows 的 Win7 / Win10 都归属同一个大类区块。
  var FAMILY_OF = {
    'sub-win7': 'os-windows',
    'sub-win10': 'os-windows',
    'sub-macos': 'os-macos',
    'sub-linux': 'os-linux'
  };

  function $(id) {
    return document.getElementById(id);
  }

  // ── UA 自动定位 ───────────────────────────────────────────────
  function detectPlatform() {
    var ua = navigator.userAgent || '';
    // Win11 也报 Windows NT 10.0，无需区分
    if (/Windows NT 6\.1/.test(ua)) return 'sub-win7';
    if (/Windows NT 10\.0/.test(ua)) return 'sub-win10';
    if (/Mac OS X/.test(ua)) return 'sub-macos';
    if (/Linux/.test(ua) && !/Android/.test(ua)) return 'sub-linux';
    return '';
  }

  function scrollToId(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.scrollIntoView) {
      try {
        el.scrollIntoView(true);
      } catch (e) {
        /* 旧浏览器忽略参数差异，滚到顶部即可 */
      }
    }
  }

  function locatePlatform() {
    var subId = detectPlatform();
    if (!subId) return;

    var famId = FAMILY_OF[subId];
    var famEl = famId ? document.getElementById(famId) : null;
    if (!famEl) return;

    famEl.className += ' ua-target';

    var subEl = document.getElementById(subId);
    if (subEl) subEl.className += ' ua-sub';

    // 地址栏带锚点（如分类标签的 #history、导航的 #os-macos）时交给浏览器定位，
    // 否则自动滚动会把用户刚点的位置抢走。
    if (window.location.hash && window.location.hash.length > 1) return;

    // 等布局完成再滚动，避免图片 / 字体撑开高度后位置偏移
    setTimeout(function () {
      scrollToId(famId);
    }, 60);
  }

  // ── 下载前探测 ───────────────────────────────────────────────
  // 场景：A 页撤回了某个版本，B 页还开着没刷新的列表（版本仍显示在页面上）。
  // B 点「下载」若直接跳转，浏览器会整页落在服务端的提示页上，
  // B 就丢掉了「当前页还有哪些版本」的上下文，还得自己点回来。
  // 所以在点击时先发一次 HEAD 探测：还在架就直接下，已下架就在当前页弹提示。
  // 用 HEAD 而不是先下再判断：HEAD 没有响应体，不会把几百 MB 拉两遍；
  // 用 XHR 而不是 fetch：IE11 没有 fetch，而这个页面是要跑在 Win7 上的。

  var noticeEl = null;
  var probing = false;

  function findDownloadLink(node) {
    while (node && node.nodeType === 1) {
      if (node.tagName === 'A') {
        var href = node.getAttribute('href') || '';
        return href.indexOf('/dl/') === 0 ? node : null;
      }
      node = node.parentNode;
    }
    return null;
  }

  function startDownload(url) {
    window.location.href = url;
  }

  /** 文案由服务端注入（window.__GONE__），与整页 gone.ejs 共用 gone.js 里的那一份 */
  function openNotice(kind) {
    var all = window.__GONE__ || {};
    var copy = all[kind] || all.gone;
    if (!noticeEl || !copy) return false;

    var titleEl = $('dl-notice-title');
    var textEl = $('dl-notice-text');
    var hintEl = $('dl-notice-hint');
    if (!titleEl || !textEl || !hintEl) return false;

    // textContent 而不是 innerHTML：文案来自服务端但没必要开一个 HTML 注入面
    titleEl.textContent = copy.heading;
    textEl.textContent = copy.text;
    hintEl.textContent = copy.hint;

    noticeEl.hidden = false;

    var closeBtn = $('dl-notice-close');
    if (closeBtn && closeBtn.focus) closeBtn.focus();
    return true;
  }

  function closeNotice() {
    if (noticeEl) noticeEl.hidden = true;
  }

  function probe(url) {
    probing = true;

    var xhr = new XMLHttpRequest();
    var settled = false;

    function finish() {
      if (settled) return false;
      settled = true;
      probing = false;
      return true;
    }

    function settle(code) {
      if (!finish()) return;
      if (code === 404) {
        if (!openNotice('gone')) startDownload(url);
        return;
      }
      if (code === 410) {
        if (!openNotice('missing')) startDownload(url);
        return;
      }
      // 200 / 206 以及探测不出来的情况：交给浏览器，服务端仍有整页兜底
      startDownload(url);
    }

    try {
      xhr.open('HEAD', url, true);
    } catch (e) {
      finish();
      return startDownload(url);
    }

    xhr.timeout = 8000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      // status 0 = 请求根本没发出去（断网 / 被插件拦截），此时判断不了，
      // 照常跳转，让服务端给出最终答案。
      settle(xhr.status);
    };
    xhr.ontimeout = function () {
      // 探测超时不该把用户卡在原地：直接下，大不了落到服务端提示页
      if (!finish()) return;
      startDownload(url);
    };
    xhr.send(null);
  }

  function onClick(e) {
    e = e || window.event;
    if (e.defaultPrevented) return;
    // 修饰键 / 中键是「在新标签打开」的意图，不拦；新标签里由服务端整页兜底
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (typeof e.button === 'number' && e.button !== 0) return;

    var a = findDownloadLink(e.target || e.srcElement);
    if (!a) return;

    var url = a.href;
    if (!url) return;

    if (e.preventDefault) e.preventDefault();
    else e.returnValue = false;

    // 上一次探测还没回来就点了另一个版本：不排队、不吞点击，直接放行。
    // 探测只是「尽量别跳走」的增强，不能因为它在飞就让用户点了没反应。
    if (probing) {
      startDownload(url);
      return;
    }

    probe(url);
  }

  function onNoticeClick(e) {
    e = e || window.event;
    var t = e.target || e.srcElement;
    while (t && t !== noticeEl) {
      var action = t.getAttribute ? t.getAttribute('data-action') : null;
      if (action === 'reload') {
        window.location.reload();
        return;
      }
      if (action === 'close') {
        closeNotice();
        return;
      }
      t = t.parentNode;
    }
  }

  function onKeydown(e) {
    e = e || window.event;
    if ((e.keyCode || e.which) !== 27) return; // Esc
    if (noticeEl && !noticeEl.hidden) closeNotice();
  }

  function bindNotice() {
    noticeEl = $('dl-notice');
    if (noticeEl) noticeEl.onclick = onNoticeClick;
  }

  function init() {
    if (document.addEventListener) {
      document.addEventListener('click', onClick, false);
      document.addEventListener('keydown', onKeydown, false);
    }
    bindNotice();
    locatePlatform();
  }

  if (document.addEventListener) {
    document.addEventListener('DOMContentLoaded', init, false);
  } else if (document.attachEvent) {
    document.attachEvent('onreadystatechange', function () {
      if (document.readyState === 'complete') init();
    });
  }
})();
