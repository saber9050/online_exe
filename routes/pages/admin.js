// 管理页渲染：状态条 + 上传区 + 版本列表 + 清理建议。
import { cfg } from '../../config.js'
import { catalog } from '../../lib/catalog.js'
import { stats } from '../../lib/stats.js'
import { storage } from '../../lib/storage.js'
import { PLATFORM_GROUPS } from '../../lib/constants.js'
import { compareVersion } from '../../semver.js'
import { toReleaseDto } from '../dto.js'

const STATUS_FILTERS = ['all', 'stable', 'prerelease', 'yanked', 'missing', 'deleted']

export async function renderAdmin(req, res, next) {
  try {
    const statusRaw = String(req.query.status || 'all')
    const status = STATUS_FILTERS.includes(statusRaw) ? statusRaw : 'all'
    const platform = String(req.query.platform || 'all')

    const all = catalog.list()
    const live = all.filter((r) => r.status !== 'deleted')
    const totalVersions = live.length
    const occupied = live.reduce(
      (s, r) => s + (r.file_missing ? 0 : Number(r.size) || 0),
      0,
    )

    const [disk, orphan] = await Promise.all([
      storage.diskInfo().catch(() => ({ total: 0, free: 0 })),
      storage.orphanStats().catch(() => ({ count: 0, bytes: 0 })),
    ])

    let rows = all.slice()
    if (status === 'all') rows = rows.filter((r) => r.status !== 'deleted')
    else if (status === 'stable')
      rows = rows.filter((r) => r.status === 'active' && !r.is_prerelease)
    else if (status === 'prerelease')
      rows = rows.filter((r) => r.status === 'active' && r.is_prerelease)
    else if (status === 'yanked') rows = rows.filter((r) => r.status === 'yanked')
    else if (status === 'missing')
      rows = rows.filter((r) => r.status !== 'deleted' && r.file_missing)
    else if (status === 'deleted') rows = rows.filter((r) => r.status === 'deleted')

    if (platform !== 'all') rows = rows.filter((r) => r.platform === platform)

    rows.sort((a, b) => {
      const d = compareVersion(b, a)
      if (d !== 0) return d
      return String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || ''))
    })

    const dtoRows = rows.map((r) => ({
      ...toReleaseDto(r),
      downloads: stats.get(r.id),
    }))

    // 覆盖度提示：同一版本号已覆盖哪些组合（只算文件存在的在架版本）
    const coverage = live
      .filter((r) => !r.file_missing && r.status === 'active')
      .map((r) => ({ version: r.version, platform: r.platform, arch: r.arch }))

    // 清理建议：每个组合除最近 KEEP_PER_PLATFORM 个之外的旧包，只列出不自动删
    const byCombo = new Map()
    for (const r of live.filter((r) => !r.file_missing && r.status === 'active')) {
      const k = `${r.platform}-${r.arch}`
      if (!byCombo.has(k)) byCombo.set(k, [])
      byCombo.get(k).push(r)
    }
    const suggestions = []
    for (const [combo, arr] of byCombo) {
      arr.sort((a, b) => compareVersion(b, a))
      const extra = arr.slice(cfg.keepPerPlatform)
      if (extra.length > 0) {
        suggestions.push({
          combo,
          keep: cfg.keepPerPlatform,
          extra: extra.map((r) => ({
            version: r.version,
            size: r.size,
            uploaded_at: r.uploaded_at,
          })),
          bytes: extra.reduce((s, r) => s + (Number(r.size) || 0), 0),
        })
      }
    }
    suggestions.sort((a, b) => b.bytes - a.bytes)

    res.render('admin', {
      title: '管理端',
      page: 'admin',
      pageCss: 'admin',
      pageScript: 'admin',
      status,
      platform,
      summary: {
        totalVersions,
        occupied,
        free: disk.free,
        total: disk.total,
        orphan,
      },
      rows: dtoRows,
      coverage,
      suggestions,
      groups: PLATFORM_GROUPS,
      maxUploadMb: cfg.maxUploadMb,
      keepPerPlatform: cfg.keepPerPlatform,
    })
  } catch (e) {
    next(e)
  }
}
