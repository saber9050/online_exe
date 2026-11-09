// GET /dl/:version/:combo — sendFile 原生支持 Range / If-Range，自定义 ETag 用 sha256。
import fs from 'node:fs/promises'
import { catalog } from '../catalog/catalog.js'
import { storage } from '../storage/storage.js'
import { stats } from '../catalog/stats.js'
import { PLATFORM_ARCH_SET } from '../constants.js'

/** @param {import('express').Request} req @param {import('express').Response} res */
export async function downloadHandler(req, res, next) {
  // 段数必须严格校验：windows10-x64-extra 不能静默取前两段
  const parts = String(req.params.combo || '').split('-')
  if (parts.length !== 2) return res.status(404).send('not found')
  const [platform, arch] = parts
  if (!PLATFORM_ARCH_SET.has(`${platform}-${arch}`)) {
    return res.status(404).send('not found')
  }

  const rel = catalog.find(req.params.version, platform, arch)
  if (!rel) return res.status(404).send('not found')

  // 只有 active 能下：墓碑（deleted）是版本号作废，已撤回（yanked）是发版人主动下架，
  // 两者都不该再被下载到。统一回 404 而不是 410，避免通过错误码反推出「这个版本存在过」。
  if (rel.status !== 'active') return res.status(404).send('not found')

  const abs = storage.abs(rel.object_key)
  const exists = await fs.stat(abs).catch(() => null)
  if (!exists) {
    return res.status(410).send('包文件缺失，请联系发版人重新上传')
  }

  // 断点续传会发多个 Range 请求，只让「新下载」计数
  const range = req.headers.range
  if (!range || /^bytes=0-/.test(range)) stats.inc(rel.id)

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
  // 缓存策略：no-cache = 可以存，但每次必须回源校验（ETag 是内容 sha256，未变就 304，几乎零成本）。
  //
  // 为什么不用原来的 `max-age=31536000, immutable`：
  // 管理页允许「删除某版本后重新上传同一版本号」（墓碑不再挡重发），
  // 这时同一个 /dl URL 会对应新内容。immutable 会让浏览器一年内不再发请求，
  // 用户只会报「我下了但程序没变」，而且从现象上根本查不到原因。
  // 内网带宽不是瓶颈，牺牲「完全不发请求」换「永远拿到当前那份」是划算的。
  res.setHeader('Cache-Control', 'public, no-cache')

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
