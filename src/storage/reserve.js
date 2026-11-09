// 磁盘可用空间的读取与预留额度。
//
// 单包上传（upload.js）和分片会话（uploads.js）必须共用同一本账：
// 两边各算一份 reservedBytes 的话，两个并发上传会各自看到「整盘可用」，
// 同时通过预检、同时开始写，最后一起 ENOSPC。
import { storage } from './storage.js'

/** 预留额度 > 5 秒就重新 statfs 一次，避免每次都打系统调用 */
const FREE_CACHE_MS = 5000

let reservedBytes = 0
let freeCacheAt = 0
let freeCacheBytes = 0

/**
 * 按 Content-Length 预留 1.1 倍空间。
 * 取 1.1 而不是 1.0：rename/日志/其它临时文件也要落盘，留点余量比正好卡满安全。
 *
 * @param {number} free 当前可用字节
 * @param {number} contentLength 本次要接收的字节
 * @returns {number} 预留下的字节数；0 表示空间不够
 */
export function tryReserve(free, contentLength) {
  const need = Math.ceil(contentLength * 1.1)
  if (free - reservedBytes < need) return 0
  reservedBytes += need
  return need
}

/** @param {number} need tryReserve 的返回值，原样传回来 */
export function releaseReserve(need) {
  if (need > 0) reservedBytes = Math.max(0, reservedBytes - need)
}

/** 当前已预留的总字节数（日志用） */
export function getReservedBytes() {
  return reservedBytes
}

/** @returns {Promise<number>} 可用字节，失败返回 0 由调用方拒绝上传 */
export async function getFreeBytes() {
  const now = Date.now()
  if (now - freeCacheAt < FREE_CACHE_MS) return freeCacheBytes
  freeCacheBytes = await storage.freeBytes()
  freeCacheAt = now
  return freeCacheBytes
}
