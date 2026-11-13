// GET /dl/:version/:combo          — sendFile 原生支持 Range / If-Range，自定义 ETag 用 sha256。
// GET /dl/:version/:combo.sha256   — 只回一行「sha256  文件名」，给 sha256sum -c / 脚本校验用。
//
// 完整性这条线上有三道：
//   ① 上传时边收边算 sha256 并落进记录（upload.js / uploads.js），这是「期望值」；
//   ② 每次下载前对一次大小（本文件）：文件被截断/被覆盖时立刻拒发，而不是把坏包发出去；
//   ③ 管理端的「校验」（GET /api/releases/:id/integrity）重算整包 sha256，
//      用于事后确认磁盘上那份和记录是否一致（大小对得上但内容被改，只有它能发现）。
// 客户端侧靠 .sha256 + 页面上的校验码自行比对——网络中途断流造成的半包，服务端是看不见的。
import fs from 'node:fs/promises'
import { catalog } from '../catalog/catalog.js'
import { storage } from '../storage/storage.js'
import { stats } from '../catalog/stats.js'
import { PLATFORM_ARCH_SET } from '../constants.js'
import { renderGone } from './pages/gone.js'

/**
 * 解析直链，顺带完成所有「能不能给」的判断。
 * 返回 null 时已经写好响应（404 / 410 / 500 提示页），调用方直接 return。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ checkSize?: boolean }} [opts]
 */
async function locate(req, res, opts = {}) {
  // 段数必须严格校验：windows10-x64-extra 不能静默取前两段
  const parts = String(req.params.combo || '').split('-')
  if (parts.length !== 2) {
    renderGone(req, res)
    return null
  }
  const [platform, arch] = parts
  if (!PLATFORM_ARCH_SET.has(`${platform}-${arch}`)) {
    renderGone(req, res)
    return null
  }

  const rel = catalog.find(req.params.version, platform, arch)
  if (!rel) {
    renderGone(req, res)
    return null
  }

  // 只有 active 能下：墓碑（deleted）是版本号作废，已撤回（yanked）是发版人主动下架，
  // 两者都不该再被下载到。统一回 404 而不是 410，避免通过错误码反推出「这个版本存在过」。
  // 404 给的是提示内容而不是纯文本：用户多半停在「开着没刷新的下载页」上点旧链接，
  // 需要他们看懂「版本已下架，去刷新」这件事，纯文本 not found 只会被当成平台故障。
  if (rel.status !== 'active') {
    renderGone(req, res)
    return null
  }

  const abs = storage.abs(rel.object_key)
  const exists = await fs.stat(abs).catch(() => null)
  if (!exists) {
    renderGone(req, res, 'missing')
    return null
  }

  // 大小对不上 = 磁盘上这份已经不是当初上传的那份（截断、被别的东西覆盖、搬运没传完）。
  // 这里只 stat，不读内容，成本几乎为零；内容级比对交给管理端的「校验」按需做。
  if (opts.checkSize !== false && exists.size !== rel.size) {
    console.warn(
      '[download] ' +
        JSON.stringify({
          reason: 'size_mismatch',
          id: rel.id,
          version: rel.version,
          combo: `${rel.platform}-${rel.arch}`,
          recorded: rel.size,
          onDisk: exists.size,
        }),
    )
    renderGone(req, res, 'corrupt')
    return null
  }

  return { rel, abs }
}

/** @param {import('express').Request} req @param {import('express').Response} res */
export async function downloadHandler(req, res, next) {
  const hit = await locate(req, res)
  if (!hit) return
  const { rel, abs } = hit

  // 断点续传会发多个 Range 请求，只让「新下载」计数。
  // HEAD 同样不计：下载页点「下载」时会先发一次 HEAD 探测版本是否还在架，
  // 若跟着计数，用户每点一次按钮就被记两遍（探测一次 + 真正下载一次）。
  const range = req.headers.range
  if (req.method !== 'HEAD' && (!range || /^bytes=0-/.test(range))) stats.inc(rel.id)

  // IE11 不认 filename*，必须同时给 ASCII 回退
  const asciiFallback = rel.filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')

  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(rel.filename)}`,
  )
  res.setHeader('ETag', `"${rel.sha256}"`)
  // 校验码同时放进响应头：curl / 下载器可以直接取，不必再单独请求 .sha256
  res.setHeader('X-Checksum-Sha256', rel.sha256)
  // 缓存策略：private + no-store。这不是性能参数，是「计数正确性」参数。
  //   - public 会被内网 nginx / 公司代理缓存，第二次点「下载」根本没到 Node，
  //     管理端的下载次数永远是 0 —— 这正是「下载了但统计不到」的典型现场；
  //   - no-store 连协商缓存都不走，每次点击都实打实经过服务端，点一次算一次。
  // 代价是不再有 304（每次重下整包）。内网带宽不是瓶颈，统计可信更重要；
  // 而且管理端允许「删掉某版本后重传同版本号」，同一个 URL 换内容时
  // no-store 也不会出现「下了但程序没变」。
  res.setHeader('Cache-Control', 'private, no-store')

  res.sendFile(
    abs,
    { etag: false, lastModified: false, acceptRanges: true },
    (err) => {
      if (!err) return
      if (err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') return
      if (res.headersSent) return res.destroy() // 正文已开始发送，只能断连接
      next(err)
    },
  )
}

/**
 * GET /dl/:version/:combo.sha256
 * 输出 `sha256sum -c` 能直接吃的一行：`<hash>  <filename>`。
 * 故意不做大小校验：文件已经坏了的时候，用户更需要拿到「应该是什么值」来确认坏在哪，
 * 而不是一起被 500 挡住。
 */
export async function checksumHandler(req, res, next) {
  const hit = await locate(req, res, { checkSize: false })
  if (!hit) return
  const { rel } = hit

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'private, no-store')
  // 下载下来的文件名带上 .sha256，Linux 上 `sha256sum -c xxx.sha256` 直接可用
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${rel.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')}.sha256"`,
  )
  res.send(`${rel.sha256}  ${rel.filename}\n`)
}
