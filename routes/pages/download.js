// 下载页渲染：只组装模板变量，不 import dto 之外的响应结构。
import { catalog } from '../../lib/catalog.js'
import { stats } from '../../lib/stats.js'
import { PLATFORM_GROUPS, OS_FAMILIES } from '../../lib/constants.js'
import { compareVersion } from '../../semver.js'
import { toReleaseDto } from '../dto.js'

export function renderDownload(req, res) {
  const groups = PLATFORM_GROUPS.map((g) => {
    const arches = g.arches.map((a) => {
      const latest = catalog.latest(g.id, a.id)
      return {
        id: a.id,
        label: a.label,
        latest: latest
          ? { ...toReleaseDto(latest.rel), downloads: stats.get(latest.rel.id) }
          : null,
      }
    })

    // 摘要把一个 OS 压成一行：取各 arch latest() 中版本最高者
    const present = arches.filter((a) => a.latest).slice()
    let summary = null
    let mixed = false
    if (present.length > 0) {
      present.sort((a, b) => compareVersion(b.latest, a.latest))
      summary = present[0].latest
      mixed = present.some((a) => a.latest.version !== summary.version)
    }

    return { ...g, arches, summary, mixed }
  })

  // 两层聚合：OS 大类 → 子组（Windows 下是 Win7 / Win10·11）
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const families = OS_FAMILIES.map((f) => {
    const subs = f.platforms.map((id) => groupById.get(id)).filter(Boolean)
    const archTotal = subs.reduce((n, g) => n + g.arches.length, 0)
    const archReady = subs.reduce(
      (n, g) => n + g.arches.filter((a) => !!a.latest).length,
      0,
    )
    return { ...f, subs, archTotal, archReady }
  })

  const history = catalog
    .list()
    .filter((r) => r.status !== 'deleted')
    .sort((a, b) => {
      const d = compareVersion(b, a)
      if (d !== 0) return d
      return String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || ''))
    })
    .slice(0, 20)
    .map((r) => ({ ...toReleaseDto(r), downloads: stats.get(r.id) }))

  const totalCount = catalog.list().filter((r) => r.status !== 'deleted').length

  res.render('download', {
    title: '客户端下载',
    page: 'download',
    pageCss: 'download',
    pageScript: 'download',
    groups,
    families,
    history,
    totalCount,
  })
}
