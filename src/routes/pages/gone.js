// 下载直链不可用时的文案（404 / 410）。归属：成员 A。
//
// 为什么不再回纯文本 "not found"：直链会被贴进聊天群、工单、快捷方式里长期存在。
// 发版人撤回版本后，任何人点开都是一片白底黑字的 not found，
// 看起来像平台挂了，实际只是自己手上那份版本过期了。这里给一套能自己走出去的文案。
//
// 三个 404 分支（组合非法 / 记录不存在 / 已撤回或已删除）共用同一份文案：
// 分开写等于告诉扫描者「这个版本号曾经存在过」，与 download.js 统一回 404 的初衷冲突。
//
// 同一份文案，两种呈现：
//   · 直接打开 /dl/*（地址栏、聊天里点链接）→ 渲染 gone.ejs 整页；
//   · 停在下载页上点「下载」→ 前端先 HEAD 探测，命中后用同一份文案弹层（public/download.js），
//     不把用户从当前页面带走。文案只有这一份，改一处两边都变。

const COPY = {
  gone: {
    status: 404,
    heading: '该版本已下架',
    text: '这个版本的安装包已被发版人撤回或删除，链接已失效。',
    hint: '请刷新页面获取最新版本信息，或到「版本历史」里换一个版本下载。',
  },
  missing: {
    status: 410,
    heading: '包文件缺失',
    text: '这个版本的记录还在，但服务器上的包文件已经不在了。',
    hint: '请刷新页面确认最新版本，或联系发版人重新上传。',
  },
  // 磁盘上的文件还在，但字节数和发布记录对不上：搬运截断、磁盘损坏、有人手工覆盖过。
  // 继续把这份文件发出去，用户拿到的是一个装不上、或者跑起来莫名崩溃的包，
  // 而且从现象上完全看不出「下载到的就是坏的」。宁可当场拒掉并把原因说清楚。
  corrupt: {
    status: 500,
    heading: '包文件已损坏',
    text: '服务器上的包文件和发布记录对不上（大小不一致），下载下来也无法安装。',
    hint: '请稍后重试，或联系发版人重新上传该版本。管理端可以对这条记录做「校验」查看具体差异。',
  },
}

/** 供下载页把文案注入前端（window.__GONE__），避免弹层与整页两处各写一遍 */
export const GONE_COPY = COPY

/**
 * 渲染直链失效提示页。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {'gone'|'missing'|'corrupt'} [kind]
 */
export function renderGone(req, res, kind = 'gone') {
  const copy = COPY[kind] || COPY.gone

  // 必须 no-store：这是「状态会变」的页面。一旦被浏览器缓存，
  // 版本重新上架后用户点同一个链接还会看到「已下架」，比原来的白屏更难解释。
  res.setHeader('Cache-Control', 'private, no-store')
  // 让下载页的 HEAD 探测能分清是哪种失效：400/410 能靠状态码区分，
  // 而「已下架」和「包文件损坏」都可能落到 500 附近，靠这个头才不至于把话说错。
  res.setHeader('X-Dl-Status', kind)

  // HEAD 是下载页点「下载」前的探测请求，只关心状态码。
  // 渲染一整页模板再丢掉，白花一次模板解析，对探测毫无价值。
  if (req.method === 'HEAD') return res.status(copy.status).end()

  res.status(copy.status).render('gone', {
    title: copy.heading,
    page: 'download',
    pageCss: 'download',
    pageScript: null,
    heading: copy.heading,
    text: copy.text,
    hint: copy.hint,
  })
}
