// 管理页渲染：状态条 + 上传区 + 版本列表 + 清理建议。
// 归属：成员 B。这里只做「数据装配」，不做 HTML 决策，模板变量形状见 docs/zxp/development.md §7.2。
import { cfg } from '../../config.js'
import { catalog } from '../../catalog/catalog.js'
import { stats } from '../../catalog/stats.js'
import { storage } from '../../storage/storage.js'
import { PLATFORM_GROUPS } from '../../constants.js'
import { compareVersion } from '../../semver.js'
import { toReleaseDto } from '../dto.js'
// 筛选用接口层同一份实现：两处各写一遍必然漂移（改了接口忘了页面，用户会看到两套口径）
import { filterReleases, sortReleases, STATUS_VALUES } from '../releases.js'

export async function renderAdmin(req, res, next) {
  try {
    // 页面层的 status 是「URL 可手改」的输入，非法值必须回落而不是报错 —— 白屏比筛错严重
    const statusRaw = String(req.query.status || 'all')
    const status = STATUS_VALUES.includes(statusRaw) ? statusRaw : 'all'
    const platform = String(req.query.platform || 'all')

    const all = catalog.list()

    // 状态条口径：墓碑不计入总数、不计入占用。
    // 否则删掉一个版本后数字纹丝不动，用户会以为删除失败，接着反复点。
    // 缺文件的记录 size 归零：文件都不在了，算进占用只会虚高。
    const live = all.filter((r) => r.status !== 'deleted')
    const totalVersions = live.length
    const occupied = live.reduce((s, r) => s + (r.file_missing ? 0 : Number(r.size) || 0), 0)

    // 磁盘与孤儿统计并行走：两个都是 IO，串行会让管理页白等一轮 statfs + 一次递归遍历
    const [disk, orphan] = await Promise.all([
      storage.diskInfo().catch(() => ({ total: 0, free: 0 })),
      storage.orphanStats().catch(() => ({ count: 0, bytes: 0 })),
    ])

    // 行数据：**不再按筛选裁掉**，一次把所有记录都给前端。
    // 为什么：切筛选走整页刷新会让页面跳位/抖动——滚动位置被重置，列表变短时
    // 纵向滚动条出现/消失还会引起整行重排。改成前端显隐 <tr>，URL 用 replaceState 同步。
    // 服务端仍然算出「当前 URL 下哪些行可见」，模板据此打初始隐藏标记，
    // 这样首屏和刷新后的结果与服务端筛选口径完全一致，也不会出现「先全显示再闪一下」。
    const rows = sortReleases(all.slice()).map((r) => ({
      ...toReleaseDto(r),
      downloads: stats.get(r.id),
    }))
    const visibleIds = new Set(filterReleases(all, { status, platform }).map((r) => r.id))

    // 覆盖度提示：同一版本号已覆盖哪些「在架且文件在」的组合。
    // 只提示不阻止提交 —— 强制齐套会挡住「这次只修 macOS bug」这种合法场景。
    const coverage = live
      .filter((r) => !r.file_missing && r.status === 'active')
      .map((r) => ({ version: r.version, platform: r.platform, arch: r.arch }))

    // 清理建议：口径是 8 个 platform-arch 组合，不是 4 个 OS。
    // 按 OS 归并会把「Win7 x64 有 6 版」和「Win7 ia32 只有 1 版」混成一个数，结论就错了。
    // 只列出，不自动删：版本包不可再生，自动删是事故而不是优化。
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
    // 省得清理建议一屏列 8 条还要自己找哪条最值得清
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
      rows,
      visibleIds,
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
