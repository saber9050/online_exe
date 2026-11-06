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

  // 墓碑不是「文件缺失」，直接 404
  if (rel.status === 'deleted') return res.status(404).send('not found')

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
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')

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
