// 分片上传会话。为什么要有它：
//
// 400MB 走单连接，在乱序严重的链路上会被 TCP 自己压到 400KB/s（实测 rcv_ooopack≈21%）。
// 拆成 N 个分片、并发 N 条连接，每条连接有自己的拥塞窗口，单条被打下去不影响其它条；
// 顺带拿到「错一片只补一片」的能力，不用整包重传。
//
// 会话只活在内存里：容器重启后会话丢失，残留的 *.tmp 由启动时的 cleanupTmp() 收掉，
// 客户端拿到 410 重新 init 即可。刻意不做持久化 —— 落盘一份会话状态，
// 就要处理它和 releases.json 的一致性，收益不抵复杂度。
//
// 接口：
//   POST   /api/uploads?version=&platform=&arch=&total=&chunkSize=   → { id, chunkSize, chunks }
//   PUT    /api/uploads/:id/chunks?offset=N                          → { received, chunks }
//   GET    /api/uploads/:id                                          → { received, chunks, missing }
//   POST   /api/uploads/:id/complete                                 → 201 + 版本记录
//   DELETE /api/uploads/:id                                          → 204
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { cfg } from '../config.js'
import { catalog } from '../catalog/catalog.js'
import { storage } from '../storage/storage.js'
import { enqueueWrite, writeAtomic, serialize } from '../catalog/persist.js'
import { getFreeBytes, tryReserve, releaseReserve, getReservedBytes } from '../storage/reserve.js'
import { parseVersion } from '../semver.js'
import { PLATFORM_ARCH_SET } from '../constants.js'
import { validatePackageName } from '../filetypes.js'
import { toReleaseDto } from './dto.js'
import { buildRecord, isVersionTaken, newId, newUploadId } from './record.js'
import { clientIp, headerText, maxUploadBytes } from './http-helpers.js'
import { inflight } from './upload.js'

/** 分片大小默认 40MB（用户定的）。上限给到 64MB 留余量，下限 256KB 防止有人传 1 字节一片把服务打满 */
const DEFAULT_CHUNK = 40 * 1024 * 1024
const MIN_CHUNK = 256 * 1024
const MAX_CHUNK = 64 * 1024 * 1024

/** 会话闲置多久回收。客户端关页面/拔网线时兜底，别让 tmp 和占位挂到进程退出 */
const SESSION_IDLE_MS = 10 * 60 * 1000

/**
 * 会话绝对寿命。分片越大、链路越慢，单片传输时间越长；
 * 光靠「闲置回收」会把正在写的会话误杀，所以再给一条硬上限兜底真正卡死的。
 */
const SESSION_MAX_MS = 6 * 60 * 60 * 1000

/** @type {Map<string, Session>} */
const sessions = new Map()

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string} key         platform|arch|version，与单包上传共用 inflight 占位
 * @property {any} parsed
 * @property {string} version
 * @property {string} platform
 * @property {string} arch
 * @property {string} filename
 * @property {string} changelog
 * @property {string} ip
 * @property {number} total
 * @property {number} chunkSize
 * @property {number} chunks
 * @property {string} tmpPath
 * @property {Uint8Array} done   1 = 该分片已完整落盘
 * @property {Set<number>} writing 正在写的分片，防同一片并发写
 * @property {number} received
 * @property {number} reserved
 * @property {'open'|'committing'} state
 * @property {number} createdAt
 * @property {number} updatedAt
 */

function log(obj) {
  console.log('[upload] ' + JSON.stringify({ via: 'chunked', ...obj }))
}

/** 会话没了（重启 / GC / 传错 id）统一 410：客户端据此重新 init */
function gone(res) {
  return res.status(410).json({ error: '上传会话不存在或已过期，请重新上传' })
}

/** 把会话的资源全部还回去：tmp、占位、预留额度 */
async function destroySession(sess) {
  sessions.delete(sess.id)
  inflight.delete(sess.key)
  releaseReserve(sess.reserved)
  if (sess.tmpPath) {
    const target = sess.tmpPath
    sess.tmpPath = null
    await fs.unlink(target).catch(() => {})
  }
}

const gcTimer = setInterval(() => {
  const now = Date.now()
  const idleDeadline = now - SESSION_IDLE_MS
  const hardDeadline = now - SESSION_MAX_MS
  for (const sess of sessions.values()) {
    if (sess.state !== 'open') continue // committing 的一律不碰，避免把 rename 搞坏
    // 有分片正在写就不按「闲置」回收：40MB 一片在慢链路上要传好几分钟，
    // 这时候删会话会把正在写的 tmp 一起 unlink 掉，客户端传完才拿到 410，白传。
    const idle = sess.writing.size === 0 && sess.updatedAt < idleDeadline
    const tooOld = sess.createdAt < hardDeadline
    if (idle || tooOld) {
      log({
        op: 'gc',
        id: sess.id,
        version: sess.version,
        received: sess.received,
        chunks: sess.chunks,
        reason: tooOld ? 'max_age' : 'idle',
      })
      void destroySession(sess)
    }
  }
}, 60 * 1000)
gcTimer.unref?.()

/**
 * POST /api/uploads — 开一个会话。
 * 元数据全走 query / header：这里没有 body，只有随后一片一片的真数据。
 */
export async function initUpload(req, res) {
  const ip = clientIp(req)
  const parsed = parseVersion(req.query.version)
  const platform = String(req.query.platform || '')
  const arch = String(req.query.arch || '')
  const total = Number(req.query.total)
  const filename = headerText(req, 'x-filename')
  const changelog = headerText(req, 'x-changelog')

  if (!parsed) return res.status(400).json({ error: '版本号格式不合法，应为 MAJOR.MINOR.PATCH[-prerelease]' })
  if (!PLATFORM_ARCH_SET.has(`${platform}-${arch}`)) {
    return res.status(400).json({ error: `平台与架构组合不受支持：${platform}-${arch}` })
  }
  if (!Number.isInteger(total) || total <= 0) {
    return res.status(400).json({ error: 'total 必须是大于 0 的整数（文件总字节数）' })
  }
  const maxBytes = maxUploadBytes()
  if (total > maxBytes) {
    return res.status(413).json({ error: `文件超过单包上限 ${cfg.maxUploadMb}MB` })
  }

  const version = parsed.version
  const key = `${platform}|${arch}|${version}`

  // 文件类型闸门放在最前：不合规的文件连会话都不建，客户端立刻拿到 400，
  // 而不是陪着一条慢链路把几百 MB 传完再被拒。
  const typeCheck = validatePackageName(filename)
  if (!typeCheck.ok) {
    log({ op: 'init', reason: 'bad_filetype', version, platform, arch, filename: filename || '' })
    return res.status(400).json({ code: 'bad_filetype', error: typeCheck.error })
  }

  // 与单包上传共用同一套查重 + 占位：分片会话进行中，同版本的单包上传也必须被挡住
  const existing = catalog.get(platform, arch, version)
  if (isVersionTaken(existing)) {
    log({ op: 'init', reason: 'version_taken', version, platform, arch })
    return res.status(409).json({
      error: `${version} / ${platform} / ${arch} 已存在，请改用新版本号`,
      existing: toReleaseDto(existing),
    })
  }
  if (inflight.has(key)) {
    log({ op: 'init', reason: 'inflight', version, platform, arch })
    // code 给前端识别用：管理页据此显示「释放上次残留」按钮，而不是让用户干等
    return res.status(409).json({
      code: 'inflight',
      error: '该版本正在上传（可能是上次中断的残留），可稍后重试，或点「释放上次残留」立即解除占用',
    })
  }

  // 磁盘预检：按整个文件一次性预留，中途不再算账
  let reserved = 0
  try {
    const free = await getFreeBytes()
    reserved = tryReserve(free, total)
    if (reserved === 0) {
      log({ op: 'init', reason: 'no_space', free, reservedBytes: getReservedBytes() })
      return res.status(507).json({ error: '磁盘空间不足，无法接收该文件' })
    }
  } catch {
    return res.status(500).json({ error: '磁盘状态检查超时，请稍后重试' })
  }

  inflight.set(key, Date.now())

  let chunkSize = Number(req.query.chunkSize) || DEFAULT_CHUNK
  if (!Number.isFinite(chunkSize) || chunkSize < MIN_CHUNK) chunkSize = DEFAULT_CHUNK
  if (chunkSize > MAX_CHUNK) chunkSize = MAX_CHUNK
  const chunks = Math.ceil(total / chunkSize)

  const tmpPath = storage.tmpPath(version, platform, arch)
  /** @type {Session} */
  const sess = {
    id: newUploadId(),
    key,
    parsed,
    version,
    platform,
    arch,
    filename, // 已过 validatePackageName，必然非空且后缀合规
    changelog,
    ip,
    total,
    chunkSize,
    chunks,
    tmpPath,
    done: new Uint8Array(chunks),
    writing: new Set(),
    received: 0,
    reserved,
    state: 'open',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  try {
    await storage.ensureDir(storage.dirFor(version, platform, arch))
    // 先把文件按最终大小建出来：分片用 r+ 定位写，不 preallocate 的话
    // 最后一片落在稀疏区之前的洞上，stat.size 会小于 total。
    const fh = await fs.open(tmpPath, 'w')
    try {
      await fh.truncate(total)
    } finally {
      await fh.close()
    }
  } catch (e) {
    releaseReserve(reserved)
    inflight.delete(key)
    log({ op: 'init', reason: 'prepare_failed', code: e?.code, message: e?.message })
    return res.status(500).json({ error: '创建存储目录失败' })
  }

  sessions.set(sess.id, sess)
  log({ op: 'init', id: sess.id, version, platform, arch, total, chunkSize, chunks, ip })
  return res.status(201).json({ id: sess.id, chunkSize, chunks, total })
}

/**
 * PUT /api/uploads/:id/chunks?offset=N — 收一片。
 *
 * offset 必须是 chunkSize 的整数倍；长度必须严格等于 min(chunkSize, total - offset)。
 * 长度校验不做「宽容」：短了就说明客户端传了一半，写进去的文件是对的但记录会骗人。
 */
export async function uploadChunk(req, res) {
  const sess = sessions.get(req.params.id)
  if (!sess) return gone(res)
  if (sess.state !== 'open') return res.status(409).json({ error: '会话正在提交，不再接收分片' })

  const offset = Number(req.query.offset)
  if (!Number.isInteger(offset) || offset < 0 || offset >= sess.total || offset % sess.chunkSize !== 0) {
    req.resume()
    return res.status(400).json({ error: 'offset 必须是 chunkSize 的整数倍且小于总长度' })
  }

  const index = offset / sess.chunkSize
  const expected = Math.min(sess.chunkSize, sess.total - offset)
  const declared = Number(req.headers['content-length'] || 0)
  if (declared !== expected) {
    log({ op: 'chunk', id: sess.id, reason: 'bad_length', index, declared, expected })
    req.resume()
    return res.status(400).json({ error: `分片长度不符：期望 ${expected} 字节，实际 ${declared} 字节` })
  }

  // 幂等：重试打回来同一片时直接成功，别重复写
  if (sess.done[index]) {
    req.resume()
    return res.json({ received: sess.received, chunks: sess.chunks, duplicate: true })
  }
  if (sess.writing.has(index)) {
    req.resume()
    return res.status(409).json({ error: '该分片正在写入，请勿并发重试同一片' })
  }

  sess.writing.add(index)
  let written = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length
      cb(null, chunk)
    },
  })

  try {
    // r+ + start：positional write，不同分片各开各的 fd，互不干扰
    const ws = createWriteStream(sess.tmpPath, { flags: 'r+', start: offset })
    await pipeline(req, counter, ws)
    if (written !== expected) throw new Error('SHORT_CHUNK')

    sess.done[index] = 1
    sess.received += 1
    sess.updatedAt = Date.now()
    log({ op: 'chunk', id: sess.id, index, bytes: written, received: sess.received, chunks: sess.chunks })
    return res.json({ received: sess.received, chunks: sess.chunks })
  } catch (err) {
    log({ op: 'chunk', id: sess.id, reason: 'write_failed', index, written, message: err?.message })
    if (!res.headersSent) res.status(500).json({ error: '分片写入失败，请重试这一片' })
    return undefined
  } finally {
    sess.writing.delete(index)
  }
}

/** GET /api/uploads/:id — 客户端断线重连后查进度（也可用来做断点续传 / 暂停保活） */
export function uploadStatus(req, res) {
  const sess = sessions.get(req.params.id)
  if (!sess) return gone(res)
  // 暂停期间客户端会定时打这个接口当心跳：刷新 updatedAt，避免被闲置 GC 当成跑路回收。
  // 只有 open 状态刷新；committing 已经在 rename 的路上，不该被续命。
  if (sess.state === 'open') sess.updatedAt = Date.now()
  const missing = []
  for (let i = 0; i < sess.chunks; i++) if (!sess.done[i]) missing.push(i)
  return res.json({
    id: sess.id,
    total: sess.total,
    chunkSize: sess.chunkSize,
    chunks: sess.chunks,
    received: sess.received,
    missing,
    expiresInMs: Math.max(0, sess.updatedAt + SESSION_IDLE_MS - Date.now()),
  })
}

/** @returns {Promise<string>} 整个文件的 sha256 */
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** POST /api/uploads/:id/complete — 校验完整、落成正式记录 */
export async function completeUpload(req, res) {
  const sess = sessions.get(req.params.id)
  if (!sess) return gone(res)
  if (sess.state !== 'open') return res.status(409).json({ error: '正在提交，请勿重复调用' })
  if (sess.received !== sess.chunks) {
    return res.status(400).json({
      error: `还有 ${sess.chunks - sess.received} 个分片未上传，无法提交`,
    })
  }

  sess.state = 'committing'
  const { version, platform, arch, tmpPath } = sess

  try {
    // fsync：分片是多次 positional write，不 fsync 就 rename，断电后可能内容截断
    const fh = await fs.open(tmpPath, 'r+')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }

    const stat = await fs.stat(tmpPath)
    if (stat.size !== sess.total) throw new Error(`SIZE_MISMATCH ${stat.size}/${sess.total}`)

    // 分片乱序到达，没法边传边算，只能最后整读一遍。400MB 在 2C 机器上约 2 秒。
    const sha256 = await hashFile(tmpPath)

    const rec = await enqueueWrite(async () => {
      // 串行段内再查一次：入口查重通过、提交时发现已存在，只可能是并发竞态
      const cur = catalog.get(platform, arch, version)
      if (isVersionTaken(cur)) throw new Error('DUPLICATE')

      const finalPath = storage.finalPath(version, platform, arch)
      await storage.ensureDir(storage.dirFor(version, platform, arch))
      await fs.rename(tmpPath, finalPath)
      // 数据现在在 finalPath。这里**不能**把 tmpPath 置空：写 releases.json 失败时
      // 分片数据只剩这一份，置空就等于丢了 —— 客户端会收到「分片已保留」的谎话。
      // 指向 finalPath 后，重试 complete 时 rename(final,final) 是空操作，能原地续上。
      sess.tmpPath = finalPath

      const record = buildRecord({
        id: cur?.id ?? newId(),
        parsed: sess.parsed,
        platform,
        arch,
        filename: sess.filename,
        size: sess.total,
        sha256,
        changelog: sess.changelog,
        ip: sess.ip,
      })

      // 写 json 失败时不删文件：删了数据就没了。留在 finalPath，重试能接着提，
      // 真放弃了也会在下次启动的 reconcile 里被当成孤儿移进 data/orphan/，不占正式目录。
      await writeAtomic(cfg.jsonPath, serialize(catalog.withRecord(record)))
      catalog.apply(record)
      return record
    })

    sessions.delete(sess.id)
    inflight.delete(sess.key)
    releaseReserve(sess.reserved)
    log({ op: 'complete', id: sess.id, version, platform, arch, bytes: sess.total, sha256 })
    return res.status(201).json(toReleaseDto(rec))
  } catch (err) {
    log({ op: 'complete', id: sess.id, reason: 'failed', message: err?.message })
    if (err.message === 'DUPLICATE') {
      await destroySession(sess)
      const cur = catalog.get(platform, arch, version)
      const body = { error: `${version} / ${platform} / ${arch} 已存在，请改用新版本号` }
      if (cur) body.existing = toReleaseDto(cur)
      return res.status(409).json(body)
    }
    // 其它错误：会话退回 open，客户端可以直接重试 complete，不用重传分片
    sess.state = 'open'
    return res.status(500).json({ error: '提交失败，请重试（分片已保留）' })
  }
}

/** DELETE /api/uploads/:id — 客户端放弃，立刻还资源，别等 GC */
export async function abortUpload(req, res) {
  const sess = sessions.get(req.params.id)
  if (!sess) return gone(res)
  if (sess.state === 'committing') return res.status(409).json({ error: '正在提交，无法取消' })
  log({ op: 'abort', id: sess.id, version: sess.version, received: sess.received, chunks: sess.chunks })
  await destroySession(sess)
  return res.status(204).end()
}

/**
 * DELETE /api/uploads?version=&platform=&arch=
 * 按「平台 + 架构 + 版本」强制释放占用。
 *
 * 场景：上次上传异常结束（直接关页面、断网、进程被杀），会话与 inflight 占位还在，
 * 同版本再次上传一直吃 409。正常刷新已由前端 pagehide 里的 DELETE /:id 处理，
 * 这条是兜底：会话 id 已经丢了，只能按业务键释放。
 */
export async function abortUploadByKey(req, res) {
  const parsed = parseVersion(req.query.version)
  const platform = String(req.query.platform || '')
  const arch = String(req.query.arch || '')
  if (!parsed) return res.status(400).json({ error: '版本号格式不合法' })
  const key = `${platform}|${arch}|${parsed.version}`

  let hit = null
  for (const s of sessions.values()) {
    if (s.key === key) {
      hit = s
      break
    }
  }

  if (hit) {
    if (hit.state === 'committing') return res.status(409).json({ error: '正在提交，无法取消' })
    log({
      op: 'force_release',
      id: hit.id,
      version: hit.version,
      platform,
      arch,
      received: hit.received,
      chunks: hit.chunks,
      by: 'key',
    })
    await destroySession(hit)
    return res.status(204).end()
  }

  // 没有分片会话，只剩单包上传留下的占位（或已经自然结束）：一并清掉。
  // 单包上传如果还在跑，提交阶段会再查一次重（DUPLICATE），不会写出两条记录。
  const had = inflight.delete(key)
  log({ op: 'force_release', version: parsed.version, platform, arch, session: false, had })
  return res.status(204).end()
}

/**
 * 优雅退出用：把还没提交的会话清掉、占位还回去。
 * 正在提交（committing）的不动 —— 它已经在 rename 的路上，这时候 unlink 会把提交搞坏。
 */
export async function drainSessions() {
  const all = [...sessions.values()].filter((s) => s.state === 'open')
  for (const s of all) sessions.delete(s.id)
  await Promise.all(all.map((s) => destroySession(s)))
  return all.length
}
