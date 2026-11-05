// 展示层格式化：字节数、UTC 转本地时间。

/** @param {number} bytes */
export function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2
  return `${v.toFixed(digits)} ${units[i]}`
}

/** @param {string} iso @param {string} timezone */
export function fmtDate(iso, timezone = 'Asia/Shanghai') {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d)
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ')
  }
}

/** @param {number} n */
export function fmtNum(n) {
  return new Intl.NumberFormat('zh-CN').format(Number(n) || 0)
}
