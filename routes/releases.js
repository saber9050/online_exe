// 版本列表 / 撤回 / 恢复 / 删除（墓碑）。
import { cfg } from '../config.js'
import { catalog } from '../lib/catalog.js'
import { storage } from '../lib/storage.js'
import { stats } from '../lib/stats.js'
import { enqueueWrite, writeAtomic, serialize } from '../lib/persist.js'
import { toReleaseDto } from './dto.js'

/** GET /api/releases */
export function listHandler(req, res) {
  const status = String(req.query.status || 'all')
  const platform = String(req.query.platform || 'all')

  let rows = catalog.list().slice()
  if (status === 'all') rows = rows.filter((r) => r.status !== 'deleted')
  else if (status === 'stable') rows = rows.filter((r) => r.status === 'active' && !r.is_prerelease)
  else if (status === 'prerelease') rows = rows.filter((r) => r.status === 'active' && r.is_prerelease)
  else if (status === 'yanked') rows = rows.filter((r) => r.status === 'yanked')
  else if (status === 'missing') rows = rows.filter((r) => r.status !== 'deleted' && r.file_missing)
  else if (status === 'deleted') rows = rows.filter((r) => r.status === 'deleted')

  if (platform !== 'all') rows = rows.filter((r) => r.platform === platform)

  res.json({
    releases: rows.map((r) => ({ ...toReleaseDto(r), downloads: stats.get(r.id) })),
  })
}

/** PATCH /api/releases/:id — 撤回 / 恢复 */
export async function patchHandler(req, res, next) {
  try {
    const rel = catalog.getById(req.params.id)
    if (!rel || rel.status === 'deleted') {
      return res.status(404).json({ error: '版本记录不存在' })
    }

    const status = String(req.body?.status || '')
    if (status !== 'active' && status !== 'yanked') {
      return res.status(400).json({ error: 'status 只能是 active 或 yanked' })
    }
    if (status === 'active' && rel.file_missing) {
      return res.status(409).json({ error: '文件缺失，请先重新上传后再恢复' })
    }

    await enqueueWrite(async () => {
      const record = { ...rel, status }
      await writeAtomic(cfg.jsonPath, serialize(catalog.withRecord(record)))
      catalog.apply(record)
      rel.status = status
    })

    res.json(toReleaseDto(rel))
  } catch (e) {
    next(e)
  }
}

/** DELETE /api/releases/:id — 墓碑：只删文件、记录改 status，不可恢复 */
export async function deleteHandler(req, res, next) {
  try {
    const rel = catalog.getById(req.params.id)
    if (!rel) return res.status(404).json({ error: '版本记录不存在' })
    if (rel.status === 'deleted') {
      return res.status(409).json({ error: '该版本已删除' })
    }

    await enqueueWrite(async () => {
      await storage.remove(rel.object_key)
      const record = { ...rel, status: 'deleted', file_missing: false }
      await writeAtomic(cfg.jsonPath, serialize(catalog.withRecord(record)))
      catalog.apply(record)
      rel.status = 'deleted'
      rel.file_missing = false
    })

    res.json(toReleaseDto(rel))
  } catch (e) {
    next(e)
  }
}
