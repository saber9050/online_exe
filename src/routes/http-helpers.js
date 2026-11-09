// 请求级的两个小工具，上传的两条链路（单包 / 分片）共用。
import { cfg } from '../config.js'

/**
 * 取客户端 IP。只监听 IPv4 时不会有 ::ffff: 前缀，但剥一次便宜。
 * @param {import('express').Request} req
 */
export function clientIp(req) {
  const raw = req.socket?.remoteAddress || req.ip || req.headers['x-forwarded-for'] || ''
  return String(Array.isArray(raw) ? raw[0] : raw).replace(/^::ffff:/, '')
}

/**
 * 从请求头取文本。
 *
 * HTTP 头只能是 ASCII（非 ASCII 会被浏览器直接抛 TypeError），
 * 所以 changelog / filename 由前端 encodeURIComponent 后放进来，这里解回来。
 * 解不开就当原样 —— 猜测编码比丢掉信息更难排查。
 * @param {import('express').Request} req
 * @param {string} name 小写头名
 */
export function headerText(req, name) {
  const raw = req.headers[name]
  if (typeof raw !== 'string' || raw === '') return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 单包上限（字节） */
export function maxUploadBytes() {
  return cfg.maxUploadMb * 1024 * 1024
}
