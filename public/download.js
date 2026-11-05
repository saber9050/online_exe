/* 下载页脚本：严格 ES5，兼容 Win7 + IE11。
 * 只做「UA 自动定位」这类可降级的增强，JS 失效时页面依然可用。
 * 不要在这里使用 const / let / 箭头函数 / 模板字符串 / fetch。
 */
(function () {
  'use strict';

  function detectPlatform() {
    var ua = navigator.userAgent || '';
    // Win11 也报 Windows NT 10.0，无需区分
    if (/Windows NT 6\.1/.test(ua)) return 'win7';
    if (/Windows NT 10\.0/.test(ua)) return 'win10';
    if (/Mac OS X/.test(ua)) return 'macos';
    if (/Linux/.test(ua) && !/Android/.test(ua)) return 'linux';
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
    var id = detectPlatform();
    if (!id) return;

    var el = document.getElementById(id);
    if (!el) return;

    el.className += ' ua-target';

    // 等布局完成再滚动，避免图片 / 字体撑开高度后位置偏移
    setTimeout(function () {
      scrollToId(id);
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
