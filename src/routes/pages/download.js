// 下载页渲染：只组装模板变量，不 import dto 之外的响应结构。
import { catalog } from '../../catalog/catalog.js'
import { stats } from '../../catalog/stats.js'
import { PLATFORM_GROUPS, OS_FAMILIES, osFamilyOf } from '../../constants.js'
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

  // 版本历史：先取全量（已删除的墓碑记录不展示），再按 OS 大类切标签
  // 客户端只展示「能正常下载」的记录：缺文件（磁盘上已没有包）的整行不出现，
  // 否则用户点进去只会拿到 410。缺文件记录仍可在管理端看到并重传修复。
  const allHistory = catalog
    .list()
    .filter((r) => r.status !== 'deleted' && !r.file_missing)
    .sort((a, b) => {
      const d = compareVersion(b, a)
      if (d !== 0) return d
      return String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || ''))
    })

  const osParam = String(req.query.os || 'all')
  const activeOs = OS_FAMILIES.some((f) => f.id === osParam) ? osParam : 'all'

  const countOf = (osId) =>
    osId === 'all'
      ? allHistory.length
      : allHistory.filter((r) => osFamilyOf(r.platform) === osId).length

  const scoped =
    activeOs === 'all'
      ? allHistory
      : allHistory.filter((r) => osFamilyOf(r.platform) === activeOs)

  const history = scoped
    .slice(0, 20)
    .map((r) => ({ ...toReleaseDto(r), downloads: stats.get(r.id) }))

  const historyTabs = [
    { id: 'all', label: '全部', href: '/#history', count: countOf('all') },
    ...OS_FAMILIES.map((f) => ({
      id: f.id,
      label: f.label,
      href: `/?os=${f.id}#history`,
      count: countOf(f.id),
    })),
  ].map((t) => ({ ...t, active: t.id === activeOs }))

  res.render('download', {
    title: '客户端下载',
    page: 'download',
    pageCss: 'download',
    pageScript: 'download',
    groups,
    families,
    history,
    historyTabs,
    historyTotal: scoped.length,
    activeOs,
  })
}
