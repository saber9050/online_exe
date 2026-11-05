// 内存版本索引。唯一键 (platform, arch, version)，不含渠道。
import { compareVersion, normalizeVersion } from '../semver.js'

function makeKey(platform, arch, version) {
  return `${platform}|${arch}|${version}`
}

export function createCatalog() {
  /** @type {any[]} */
  let list = []
  /** @type {Map<string, any>} */
  const byKey = new Map()

  function rebuild() {
    byKey.clear()
    for (const r of list) byKey.set(makeKey(r.platform, r.arch, r.version), r)
  }

  return {
    load(records) {
      list = Array.isArray(records) ? records.slice() : []
      rebuild()
    },

    list() {
      return list
    },

    get(platform, arch, version) {
      return byKey.get(makeKey(platform, arch, normalizeVersion(version)))
    },

    find(version, platform, arch) {
      return byKey.get(makeKey(platform, arch, normalizeVersion(version)))
    },

    getById(id) {
      return list.find((r) => r.id === id) || null
    },

    /** 应用一条记录（新增或替换），只在磁盘写成功后调用 */
    apply(record) {
      const key = makeKey(record.platform, record.arch, record.version)
      const idx = list.findIndex((r) => makeKey(r.platform, r.arch, r.version) === key)
      if (idx >= 0) list[idx] = record
      else list.push(record)
      byKey.set(key, record)
    },

    /** 返回包含给定记录的新数组，不改动内存（用于落盘快照） */
    withRecord(record) {
      const key = makeKey(record.platform, record.arch, record.version)
      const out = list.filter((r) => makeKey(r.platform, r.arch, r.version) !== key)
      out.push(record)
      return out
    },

    /**
     * 各 platform+arch 独立取最新：正式版优先，无正式版回落到最高预发布。
     * @returns {{rel:any, isPrerelease:boolean} | null}
     */
    latest(platform, arch) {
      const cands = list.filter(
        (r) =>
          r.platform === platform &&
          r.arch === arch &&
          r.status === 'active' &&
          !r.file_missing,
      )
      if (cands.length === 0) return null

      const stable = cands.filter((r) => !r.is_prerelease)
      const pool = stable.length > 0 ? stable : cands
      pool.sort((a, b) => {
        const d = compareVersion(b, a)
        if (d !== 0) return d
        return String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || ''))
      })
      const rel = pool[0]
      return { rel, isPrerelease: Boolean(rel.is_prerelease) }
    },
  }
}

export const catalog = createCatalog()
