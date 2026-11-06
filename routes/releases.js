// 版本列表 / 撤回 / 恢复 / 删除（墓碑）。
// 归属：成员 B（管理页接口层）。磁盘结构与落盘由成员 A 的 lib/catalog.js、lib/persist.js 负责，
// 本文件不允许自己拼路径、自己写 releases.json。
import { cfg } from '../config.js'
import { catalog } from '../lib/catalog.js'
import { storage } from '../lib/storage.js'
import { stats } from '../lib/stats.js'
import { enqueueWrite, writeAtomic, serialize } from '../lib/persist.js'
import { compareVersion } from '../semver.js'
import { toReleaseDto } from './dto.js'

/**
 * status 筛选白名单（唯一事实来源）。
 *
 * 为什么必须用「白名单 + 映射」而不是 if/else 链：
 * 链式写法对未知值会「落不进任何分支」，等价于完全不过滤 —— 结果把墓碑（deleted）
 * 一起吐出去，属于信息泄露。改成查表后，「不认识的值」与「all」是两件必须显式区分的事：
 *   · 接口层（GET /api/releases）：非法值 → 400，让调用方知道自己写错了
 *   · 页面层（/admin）：非法值 → 回落到 all，页面不能因为 URL 被手改就白屏
 */
const STATUS_FILTERS = {
  all: (r) => r.status !== 'deleted',
  stable: (r) => r.status === 'active' && !r.is_prerelease,
  prerelease: (r) => r.status === 'active' && r.is_prerelease,
  yanked: (r) => r.status === 'yanked',
  missing: (r) => r.status !== 'deleted' && r.file_missing,
  deleted: (r) => r.status === 'deleted',
}

/** 合法筛选值列表，导出给页面渲染做兜底、给文档做对照 */
export const STATUS_VALUES = Object.keys(STATUS_FILTERS)

/**
 * 按 status + platform 过滤版本记录，页面与接口共用一份实现。
 *
 * 两个维度是正交的：
 *   · status       —— 发版人的意图（在架 / 已撤回 / 墓碑），外加 stable|prerelease 这个派生视图
 *   · file_missing —— 磁盘的客观事实，不参与 status 判断，只在 missing 视图里单独筛
 * 所以这里不做「状态优先级」之类的合并，各筛各的。
 *
 * @param {any[]} rows 原始记录数组（不会被修改）
 * @param {{status?:string, platform?:string}} [query]
 * @returns {any[]} 新数组
 */
export function filterReleases(rows, query = {}) {
  const status = query.status || 'all'
  const platform = query.platform || 'all'

  // 未知 status 回落到 all：接口层已在入口 400 挡住，这里只是页面层的最后一道兜底
  const pred = STATUS_FILTERS[status] || STATUS_FILTERS.all
  let out = rows.filter(pred)

  // platform 不做法定白名单校验：写错了只会得到空列表，不会泄露数据，没必要 400
  if (platform !== 'all') out = out.filter((r) => r.platform === platform)

  return out
}

/**
 * 版本排序：主版本号降序，同版本按上传时间降序。
 * 接口响应与页面列表共用，保证两边顺序一致（否则用户会发现「刷新一下行位置变了」）。
 *
 * @param {any[]} rows
 * @returns {any[]} 就地排序后的同一数组
 */
export function sortReleases(rows) {
  return rows.sort((a, b) => {
    const d = compareVersion(b, a)
    if (d !== 0) return d
    return String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || ''))
  })
}

/**
 * GET /api/releases
 *
 * 查询参数：
 *   status   all | stable | prerelease | yanked | missing | deleted（默认 all）
 *   platform all | windows7 | windows10 | macos | linux（默认 all）
 *
 * 响应：{ releases: [ ReleaseDto & { downloads } ] }
 * downloads（下载计数）只在这个列表响应里出现，上传 201 响应里没有。
 */
export function listHandler(req, res) {
  const status = String(req.query.status || 'all')
  const platform = String(req.query.platform || 'all')

  if (!STATUS_FILTERS[status]) {
    return res.status(400).json({
      error: `status 取值不合法：${status}，可选 ${STATUS_VALUES.join(' / ')}`,
    })
  }

  const rows = sortReleases(filterReleases(catalog.list().slice(), { status, platform }))

  res.json({
    // 展开 DTO 后叠一个 downloads：DTO 负责「记录长什么样」，计数属于列表视图的附加信息
    releases: rows.map((r) => ({ ...toReleaseDto(r), downloads: stats.get(r.id) })),
  })
}

/**
 * 撤回 / 恢复的公共实现（PATCH 与两条 POST 别名都走这里）。
 *
 * 状态变更必须排进 A 的串行写队列：并发两个操作打同一条记录时，
 * 各自 read-modify-write 会互相覆盖，最后落盘的是「后写的那份快照」，
 * 而内存索引可能停在另一份上，重启后表现成「操作丢了」。
 *
 * @param {'active'|'yanked'} targetStatus
 */
async function setStatus(req, res, next, targetStatus) {
  try {
    const rel = catalog.getById(req.params.id)

    // 墓碑不能撤回也不能恢复：记录留着是为了挡住「删了再用同版本号传」，
    // 它已经不在任何可操作状态里，按「不存在」处理比给 409 更不容易误导。
    if (!rel || rel.status === 'deleted') {
      return res.status(404).json({ error: '版本记录不存在' })
    }

    // 恢复的前提是文件还在。文件没了还恢复，下载页会多出一条点了就 404 的链接，
    // 正确路径是先「重新上传」补齐文件（file_missing 记录允许同版本重传）。
    if (targetStatus === 'active' && rel.file_missing) {
      return res.status(409).json({ error: '文件缺失，请先重新上传后再恢复' })
    }

    // 幂等：本来就是目标状态，直接返回当前快照，不写盘也不占队列
    if (rel.status === targetStatus) return res.json(toReleaseDto(rel))

    await enqueueWrite(async () => {
      // 先算出要落盘的新对象，写盘成功后再落到内存：
      // 中间失败时内存与磁盘都还是旧值，不会出现「内存改了、磁盘没改」
      const record = { ...rel, status: targetStatus }
      await writeAtomic(cfg.jsonPath, serialize(catalog.withRecord(record)))
      catalog.apply(record)
    })

    res.json(toReleaseDto(catalog.getById(rel.id) || rel))
  } catch (e) {
    next(e)
  }
}

/** PATCH /api/releases/:id  body: { status: "active" | "yanked" } */
export function patchHandler(req, res, next) {
  const status = String(req.body?.status || '')
  if (status !== 'active' && status !== 'yanked') {
    return res.status(400).json({ error: 'status 只能是 active 或 yanked' })
  }
  return setStatus(req, res, next, status)
}

/** POST /api/releases/:id/yank —— 方案冻结形态，语义等同 PATCH { status: "yanked" } */
export function yankHandler(req, res, next) {
  return setStatus(req, res, next, 'yanked')
}

/** POST /api/releases/:id/unyank —— 方案冻结形态，语义等同 PATCH { status: "active" } */
export function unyankHandler(req, res, next) {
  return setStatus(req, res, next, 'active')
}

/**
 * DELETE /api/releases/:id —— 墓碑式删除。
 *
 * 只删文件，不删记录：真删会留下「删掉再传同版本号，URL 不变而内容变了」的洞，
 * 直接击穿 Cache-Control: immutable 与「版本号不可变」两条底线。
 * 墓碑让上传侧的查重天然拦住（复用 file_missing !== true 那条判断）。
 *
 * object_key 必须保留（指向已不存在的文件），file_missing 必须置 false：
 * 墓碑是「文件被主动删除」，不是「文件意外丢失」，两者混了会让启动对账误判。
 */
export async function deleteHandler(req, res, next) {
  try {
    const rel = catalog.getById(req.params.id)
    if (!rel) return res.status(404).json({ error: '版本记录不存在' })
    if (rel.status === 'deleted') {
      return res.status(409).json({ error: '该版本已删除' })
    }

    let updated = null
    await enqueueWrite(async () => {
      // 删文件放在写 JSON 之前：即使后面写盘失败，最坏结果是「文件没了、记录还在」，
      // 重启对账会把它标成 file_missing，页面红标提示，属于可自愈的不一致。
      // 反过来先写墓碑再删文件，失败时留下的是一条指着活文件的墓碑，更难解释。
      await storage.remove(rel.object_key)
      const record = { ...rel, status: 'deleted', file_missing: false }
      await writeAtomic(cfg.jsonPath, serialize(catalog.withRecord(record)))
      catalog.apply(record)
      updated = record
    })

    res.json(toReleaseDto(updated || rel))
  } catch (e) {
    next(e)
  }
}
