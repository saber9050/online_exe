/* 下载页脚本：严格 ES5，兼容 Win7 + IE11。
 * 只做「UA 自动定位」这类可降级的增强，JS 失效时页面依然可用。
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

  function init() {
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

  if (document.addEventListener) {
    document.addEventListener('DOMContentLoaded', init, false);
  } else if (document.attachEvent) {
    document.attachEvent('onreadystatechange', function () {
      if (document.readyState === 'complete') init();
    });
  }
})();
