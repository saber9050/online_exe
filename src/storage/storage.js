// 存储接口。当前只有本地磁盘实现（方案明确不做对象存储），
// 将来要换到对象存储，只改下面这一行 import，调用方一行不用动。
//
// 契约（实现见 ./local.js）：
//   abs(objectKey)              -> string          对象键转绝对路径
//   dirFor(version, p, a)       -> string          版本目录（不含文件名）
//   finalPath(version, p, a)    -> string          包文件最终路径
//   tmpPath(version, p, a)      -> string          唯一临时路径，必须与目标同一文件系统
//   ensureDir(dir)              -> Promise<void>
//   remove(objectKey)           -> Promise<void>   幂等删除，文件不存在不报错
//   diskInfo()                  -> Promise<{total:number, free:number}>
//   freeBytes()                 -> Promise<number> 可用字节，失败返回 0（由调用方拒绝上传）
//   probe()                     -> Promise<void>   健康探针，写入失败即抛
//   orphanStats()               -> Promise<{count:number, bytes:number}>
import { localStorage } from './local.js'

/** @typedef {typeof localStorage} Storage */

/** @type {Storage} */
export const storage = localStorage
