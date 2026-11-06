// 严格 semver：MAJOR.MINOR.PATCH[-prerelease]，允许前缀 v，但入口处必须剥离。
// 版本号同时是唯一键和磁盘路径，归一化后所有环节统一使用。

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** 去掉前缀 v / 首尾空白 */
export function normalizeVersion(raw) {
  return String(raw ?? '').trim().replace(/^v/i, '')
}

/**
 * @param {string} raw
 * @returns {{version:string, major:number, minor:number, patch:number,
 * prerelease:string, is_prerelease:boolean} | null}
 */
export function parseVersion(raw) {
  const version = normalizeVersion(raw)
  const m = VERSION_RE.exec(version)
  if (!m) return null
  return {
    version,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || '',
    is_prerelease: Boolean(m[4]),
  }
}

/** @param {string} a @param {string} b */
export function compareVersion(a, b) {
  const pa = typeof a === 'string' ? parseVersion(a) : a
  const pb = typeof b === 'string' ? parseVersion(b) : b
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1

  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch

  // 无 prerelease 的版本优先级更高
  if (!pa.prerelease && !pb.prerelease) return 0
  if (!pa.prerelease) return 1
  if (!pb.prerelease) return -1
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

function comparePrerelease(a, b) {
  const as = a.split('.')
  const bs = b.split('.')
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
    } else if (xn) {
      return -1 // 数字标识符低于字母
    } else if (yn) {
      return 1
    } else {
      const d = x.localeCompare(y)
      if (d !== 0) return d < 0 ? -1 : 1
    }
  }
  return 0
}

/** 把 patch 加一，用于 409 冲突时自动建议新版本号 */
export function bumpPatch(version) {
  const p = parseVersion(version)
  if (!p) return ''
  return `${p.major}.${p.minor}.${p.patch + 1}`
}
