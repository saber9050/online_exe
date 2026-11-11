// GET /dl/:version/:combo — sendFile 原生支持 Range / If-Range，自定义 ETag 用 sha256。
import fs from 'node:fs/promises'
import { catalog } from '../catalog/catalog.js'
import { storage } from '../storage/storage.js'
import { stats } from '../catalog/stats.js'
import { PLATFORM_ARCH_SET } from '../constants.js'
import { renderGone } from './pages/gone.js'

/** @param {import('express').Request} req @param {import('express').Response} res */
export async function downloadHandler(req, res, next) {
  // 段数必须严格校验：windows10-x64-extra 不能静默取前两段
  const parts = String(req.params.combo || '').split('-')
  if (parts.length !== 2) return renderGone(req, res)
  const [platform, arch] = parts
  if (!PLATFORM_ARCH_SET.has(`${platform}-${arch}`)) {
    return renderGone(req, res)
  }

  const rel = catalog.find(req.params.version, platform, arch)
  if (!rel) return renderGone(req, res)

  // 只有 active 能下：墓碑（deleted）是版本号作废，已撤回（yanked）是发版人主动下架，
  // 两者都不该再被下载到。统一回 404 而不是 410，避免通过错误码反推出「这个版本存在过」。
  // 404 给的是提示内容而不是纯文本：用户多半停在「开着没刷新的下载页」上点旧链接，
  // 需要他们看懂「版本已下架，去刷新」这件事，纯文本 not found 只会被当成平台故障。
  if (rel.status !== 'active') return renderGone(req, res)

  const abs = storage.abs(rel.object_key)
  const exists = await fs.stat(abs).catch(() => null)
  if (!exists) {
    return renderGone(req, res, 'missing')
  }

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
