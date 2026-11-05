// /admin 与写接口的来源网段限制。空配置 = 不限制。
import { cfg } from '../config.js'

function ipv4ToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = (n << 8) | v
  }
  return n >>> 0
}

/** @returns {{net:number, mask:number} | null} */
function parseCidr(cidr) {
  const [ip, bitsRaw] = cidr.split('/')
  const net = ipv4ToInt(ip)
  if (net === null) return null
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return { net, mask }
}

const RULES = cfg.adminAllowCidr
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(parseCidr)
  .filter(Boolean)

export function adminGuard(req, res, next) {
  if (RULES.length === 0) return next()

  const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  const ip = ipv4ToInt(addr)
  if (ip === null) {
    return res.status(403).send('该来源地址无权访问管理页')
  }

  for (const rule of RULES) {
    if ((ip & rule.mask) === (rule.net & rule.mask)) return next()
  }
  return res.status(403).send('该来源网段无权访问管理页')
}
