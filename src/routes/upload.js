// POST /api/releases — busboy 流式上传。
// 元数据走 query（先于 body 到达），文件走 multipart，边写边算 sha256。
import Busboy from 'busboy'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { cfg } from '../config.js'
import { catalog } from '../catalog/catalog.js'
import { storage } from '../storage/storage.js'
import { enqueueWrite, writeAtomic, serialize } from '../catalog/persist.js'
import { parseVersion } from '../semver.js'
import { PLATFORM_ARCH_SET } from '../constants.js'
import { toReleaseDto } from './dto.js'

/** 正在上传的版本占位：key → 开始时间。导出供优雅退出等待。 */
export const inflight = new Map()

let reservedBytes = 0
let freeCacheAt = 0
let freeCacheBytes = 0

// 每 5 分钟清理超过 30 分钟未提交的占位（客户端拔网线跑路时兜底）
const cleanupTimer = setInterval(() => {
  const deadline = Date.now() - 30 * 60 * 1000
  for (const [key, at] of inflight) {
    if (at < deadline) {
      inflight.delete(key)
      console.warn(`[upload] 释放超时占位 ${key}`)
    }
  }
}, 5 * 60 * 1000)
cleanupTimer.unref?.()

function clientIp(req) {
  const raw = req.socket?.remoteAddress || req.ip || req.headers['x-forwarded-for'] || ''
  return String(Array.isArray(raw) ? raw[0] : raw).replace(/^::ffff:/, '')
}

/** 上传途中连续多久收不到数据就判定客户端已跑路。默认无限等会把连接、占位、临时文件一起挂死。 */
const UPLOAD_IDLE_MS = 120 * 1000

/** 预检（statfs / mkdir）最多等多久。卡住就放弃，别把占位一起挂死。 */
const PREPARE_TIMEOUT_MS = 10 * 1000

/**
 * 拒绝/异常出口统一打一行结构化日志。
 * 必记的原因：提前拒绝时响应常常被 RST 吞掉（客户端还在推大 body），
 * 前端只能看到「连接中断」，能还原当时原因的只剩这行日志。
 */
function logReject(req, reason, detail) {
  console.warn('[upload] ' + JSON.stringify({
    reason,
    ip: clientIp(req),
    version: String(req.query.version || ''),
    platform: String(req.query.platform || ''),
    arch: String(req.query.arch || ''),
    contentLength: Number(req.headers['content-length'] || 0),
    ...detail,
  }))
}

/**
 * 分段日志：定位「请求到没到 handler」「body 到没到服务端」这类只能靠现场还原的问题。
 * begin → first_byte → body_done，缺哪一段就说明断在哪里。
 */
function logStage(req, stage, detail) {
  console.log('[upload] ' + JSON.stringify({
    stage,
    ip: clientIp(req),
    version: String(req.query.version || ''),
    platform: String(req.query.platform || ''),
    arch: String(req.query.arch || ''),
    ...detail,
  }))
}

function newId() {
  // 20261105T021000-1f3a9c7e
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')
  return `${ts}-${randomBytes(4).toString('hex')}`
}

async function getFreeBytes() {
  const now = Date.now()
  if (now - freeCacheAt < 5000) return freeCacheBytes
  freeCacheBytes = await storage.freeBytes()
  freeCacheAt = now
  return freeCacheBytes
}

function tryReserve(free, contentLength) {
  const need = Math.ceil(contentLength * 1.1)
  if (free - reservedBytes < need) return 0
  reservedBytes += need
  return need
}

function releaseReserve(need) {
  if (need > 0) reservedBytes = Math.max(0, reservedBytes - need)
}

/** 给可能永久挂住的系统调用加超时：占位不能等一个再也不返回的 promise。 */
function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label}_TIMEOUT`)
      reject(err)
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 在 body 还没读的情况下拒绝请求。
 *
 * 直接 res.json 之后由 Node 关连接，内核会因为「接收缓冲区里还有未读数据」发 RST，
 * 浏览器把已经收到的响应一起丢掉，用户只能看到「连接被中断」，409 的原因全丢。
 * 所以这里先把响应写出去，再把客户端仍在推的 body 读空（丢弃）。
 * 最多读 5 秒就掐断：这个请求注定失败，没必要陪着传完几百 MB。
 */
function rejectEarly(req, res, code, body) {
  if (res.headersSent) return
  res.status(code).json(body)
  req.resume()
  const timer = setTimeout(() => req.destroy(), 5000)
  timer.unref?.()
  const done = () => clearTimeout(timer)
  req.on('end', done)
  req.on('close', done)
}

/**
 * 同一个版本号还能不能再传。
 *
 * 只有「这条记录还在用」时才拦，两种状态放行：
 *   ① file_missing === true —— 记录在、文件丢了，允许补齐（沿用原 id，下载计数不归零）
 *   ② status === 'deleted'  —— 墓碑。删除的语义是「这个版本作废、东西没了」，
 *      既然文件已经删了，就不该再拿它挡住重新发布；否则用户只能改版本号来绕，
 *      而他要发的本来就是同一个版本。
 *
 * 在架（active）和已撤回（yanked）仍然一律 409：这两种状态下文件还在，
 * 覆盖等于「同一个 URL 换内容」，客户端缓存和版本追溯都会失效。
 *
 * @param {any} rec
 * @returns {boolean} true = 已被占用，拒绝上传
 */
function isVersionTaken(rec) {
  if (!rec) return false
  if (rec.file_missing === true) return false
  if (rec.status === 'deleted') return false
  return true
}

function buildRecord({ id, parsed, platform, arch, filename, size, sha256, changelog, ip }) {
  return {
    id,
    version: parsed.version,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease,
    is_prerelease: parsed.is_prerelease,
    platform,
    arch,
    filename,
    object_key: `${parsed.version}/${platform}-${arch}/package.bin`,
    size,
    sha256,
    changelog,
    status: 'active',
    file_missing: false,
    uploaded_at: new Date().toISOString(),
    uploaded_ip: ip,
  }
}

/** @param {import('express').Request} req @param {import('express').Response} res */
export async function uploadHandler(req, res) {
  const parsed = parseVersion(req.query.version)
  const platform = String(req.query.platform || '')
  const arch = String(req.query.arch || '')

  if (!parsed) {
    logReject(req, 'bad_version')
    return res.status(400).json({ error: '版本号格式不合法，应为 MAJOR.MINOR.PATCH[-prerelease]' })
  }
  if (!PLATFORM_ARCH_SET.has(`${platform}-${arch}`)) {
    logReject(req, 'bad_platform')
    return res.status(400).json({ error: `平台与架构组合不受支持：${platform}-${arch}` })
  }

  const version = parsed.version
  const key = `${platform}|${arch}|${version}`

  // 这一段同步执行，查重 + 占位天然原子
  const existing = catalog.get(platform, arch, version)
  if (isVersionTaken(existing)) {
    logReject(req, 'version_taken', {
      existingId: existing.id,
      status: existing.status,
      fileMissing: existing.file_missing,
    })
    return rejectEarly(req, res, 409, {
      error: `${version} / ${platform} / ${arch} 已存在，请改用新版本号`,
      existing: toReleaseDto(existing),
    })
  }
  if (inflight.has(key)) {
    logReject(req, 'inflight', { since: new Date(inflight.get(key)).toISOString() })
    return rejectEarly(req, res, 409, {
      error: '该版本正在上传（可能是上次中断的残留），请约 2 分钟后再试',
    })
  }
  inflight.set(key, Date.now())

  // ── 占位已建立：从这行往下，每条返回路径都必须调用 releaseOnce() ──────────
  let state = 'receiving' // receiving | committing | done | aborted
  let tmpPath = null
  let idleTimer = null
  let sha256 = null
  let bytesWritten = 0
  let bytesReceived = 0
  let userFilename = null
  let changelog = ''
  let reserved = 0
  let released = false
  let sawFirstByte = false
  const beganAt = Date.now()
  const tasks = []
  const taskErrors = []
  const streams = new Set()
  const reqIp = clientIp(req)

  /** 占位 + 预留额度 + 看门狗，三件事要么一起收、要么一起放，避免漏掉一处。 */
  function releaseOnce() {
    if (released) return
    released = true
    stopIdle()
    inflight.delete(key)
    releaseReserve(reserved)
  }

  function stopIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function armIdle() {
    idleTimer = setTimeout(onIdle, UPLOAD_IDLE_MS)
    idleTimer.unref?.()
  }

  // 客户端拔网线/热点掉线时 Node 永不超时（requestTimeout 与 server.timeout 都是 0），
  // 连接、inflight 占位和临时文件会一起挂住，期间同版本重试全部被 409 秒拒。
  // 这里按「读空闲」兜底：连续 UPLOAD_IDLE_MS 一个字节都没收到，就结束占位并断开。
  function onIdle() {
    idleTimer = null
    abort(408, '上传超时：长时间没有收到数据，请重试', 'idle_timeout')
    // 先给响应一点写出时间，立刻 destroy 会把 408 一起丢掉
    const timer = setTimeout(() => req.destroy(), 1000)
    timer.unref?.()
  }

  function abort(code, msg, reason) {
    if (state !== 'receiving') return
    state = 'aborted'
    logReject(req, reason || 'aborted', { code, message: msg })
    // 占位必须立刻释放：客户端已经断了，再等清理完成会让同版本重试一直吃到 409。
    releaseOnce()
    // 连接断开后 busboy 的文件流不会自己结束，pipeline 会永久挂住，得主动打断。
    for (const s of streams) {
      try {
        s.destroy()
      } catch {}
    }
    streams.clear()
    void cleanupAfterAbort()
    if (!res.headersSent && !res.destroyed) res.status(code).json({ error: msg })
  }

  /** 中断后的收尾：清理任务最多等 3 秒，不能让它把 tmp 文件永久留下。 */
  async function cleanupAfterAbort() {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000)
        timer.unref?.()
      }),
    ])
    await cleanupTmp()
  }

  async function cleanupTmp() {
    const target = tmpPath
    if (!target) return
    tmpPath = null
    // Windows 上文件句柄释放有延迟，unlink 可能短暂 EBUSY/EPERM，重试几次
    for (let i = 0; i < 5; i++) {
      try {
        await fs.unlink(target)
        return
      } catch (e) {
        if (e?.code === 'ENOENT') return
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
  }

  async function commit() {
    stopIdle() // body 已收完，后面是纯本地提交，不该被读空闲超时打断
    try {
      if (tasks.length === 0) throw new Error('NO_FILE')
      await Promise.all(tasks)
      if (taskErrors.length > 0) throw taskErrors[0]
      if (!tmpPath) throw new Error('NO_FILE')

      const finalPath = storage.finalPath(version, platform, arch)
      const tmp = tmpPath

      const rec = await enqueueWrite(async () => {
        // 串行段内再次查重（判据与入口共用 isVersionTaken，别写两份）
        const cur = catalog.get(platform, arch, version)
        if (isVersionTaken(cur)) throw new Error('DUPLICATE')

        await storage.ensureDir(storage.dirFor(version, platform, arch))
        await fs.rename(tmp, finalPath)
        tmpPath = null

        const record = buildRecord({
          id: cur?.id ?? newId(),
          parsed,
          platform,
          arch,
          filename: userFilename || `package-${version}-${platform}-${arch}.bin`,
          size: bytesWritten,
          sha256,
          changelog,
          ip: reqIp,
        })

        try {
          await writeAtomic(cfg.jsonPath, serialize(catalog.withRecord(record)))
        } catch (e) {
          await fs.unlink(finalPath).catch(() => {})
          throw e
        }
        catalog.apply(record)
        return record
      })

      state = 'done'
      if (!res.headersSent) res.status(201).json(toReleaseDto(rec))
    } catch (err) {
      state = 'aborted'
      await cleanupTmp()
      if (!res.headersSent) {
        // 错误码映射集中在一处：三个已知业务错误 + 兜底 500。
        // 不要在状态码上写三元套三元，也不要把同一个映射散到多处。
        const KNOWN = { DUPLICATE: 409, NO_FILE: 400, FILE_TOO_LARGE: 413 }
        const code = KNOWN[err.message] ?? 500
        const body = { error: '上传失败，请稍后重试' }
        logReject(req, 'commit_failed', { code, message: err.message, errno: err?.code })

        if (err.message === 'DUPLICATE') {
          // 走到这里 = 入口查重通过、提交时发现已存在，只可能是并发竞态。
          // 这里必须给中文文案：此前直接把 err.message 吐给前端，UI 上会显示大写英文 DUPLICATE。
          // 同时带上已存在记录的 DTO，前端才能像入口 409 那样自动把补丁号 +1。
          const cur = catalog.get(platform, arch, version)
          body.error = `${version} / ${platform} / ${arch} 已存在，请改用新版本号`
          if (cur) body.existing = toReleaseDto(cur)
        } else if (err.message === 'NO_FILE') {
          body.error = '请求中没有文件，请用 file 字段上传'
        } else if (err.message === 'FILE_TOO_LARGE') {
          body.error = `文件超过单包上限 ${cfg.maxUploadMb}MB`
        } else if (err?.code) {
          // 系统错误（ENOSPC / EACCES / EROFS…）：只回错误码，不回堆栈
          body.error = `写盘失败（${err.code}），请检查磁盘后重试`
        }

        res.status(code).json(body)
      }
    } finally {
      releaseOnce()
    }
  }

  // 看门狗必须在任何 await 之前武装：一旦 getFreeBytes / ensureDir 卡住，
  // 否则占位、连接、临时文件会一起挂死，同版本重试全部被 409 挡住。
  armIdle()

  // 计量必须走管道上的 Transform：直接在 req 上挂 'data' 会把请求切到 flowing 模式，
  // 下面几个 await 期间的 chunk 会被丢掉，busboy 再也拿不到文件。
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      if (idleTimer) idleTimer.refresh()
      bytesReceived += chunk.length
      if (!sawFirstByte) {
        sawFirstByte = true
        logStage(req, 'first_byte', { afterMs: Date.now() - beganAt })
      }
      cb(null, chunk)
    },
  })

  req.on('end', () => {
    logStage(req, 'body_done', { afterMs: Date.now() - beganAt, bytesReceived })
  })

  logStage(req, 'begin', { contentLength: Number(req.headers['content-length'] || 0) })

  try {
    // 磁盘空间预检 + 预留额度（带超时：statfs 卡住不能把整个上传挂死）
    const contentLength = Number(req.headers['content-length'] || 0)
    if (contentLength > 0) {
      let free
      try {
        free = await withTimeout(getFreeBytes(), PREPARE_TIMEOUT_MS, 'STATFS')
      } catch {
        logReject(req, 'statfs_timeout')
        releaseOnce()
        return rejectEarly(req, res, 500, { error: '磁盘状态检查超时，请稍后重试' })
      }
      reserved = tryReserve(free, contentLength)
      if (reserved === 0) {
        logReject(req, 'no_space', { free, reservedBytes })
        releaseOnce()
        return rejectEarly(req, res, 507, { error: '磁盘空间不足，无法接收该文件' })
      }
    }

    try {
      await withTimeout(
        storage.ensureDir(storage.dirFor(version, platform, arch)),
        PREPARE_TIMEOUT_MS,
        'MKDIR',
      )
    } catch (e) {
      const timeout = e?.message === 'MKDIR_TIMEOUT'
      logReject(req, timeout ? 'mkdir_timeout' : 'mkdir_failed', { code: e?.code })
      releaseOnce()
      return rejectEarly(req, res, 500, { error: '创建存储目录失败' })
    }

    let bb
    try {
      bb = Busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: {
          fileSize: cfg.maxUploadMb * 1024 * 1024,
          files: 1,
          fields: 10,
          fieldSize: 64 * 1024,
        },
      })
    } catch {
      logReject(req, 'bad_multipart')
      releaseOnce()
      return rejectEarly(req, res, 400, { error: 'multipart 解析失败，请检查 Content-Type' })
    }

    bb.on('file', (name, stream, info) => {
      if (name !== 'file') {
        stream.resume()
        return
      }
      if (!userFilename && info && info.filename) userFilename = info.filename
      tmpPath = storage.tmpPath(version, platform, arch)

      // 必须当场 catch：abort 路径下 commit 不会执行，裸 promise 会变成未捕获异常
      tasks.push(
        (async () => {
          const hash = createHash('sha256')
          const tap = new Transform({
            transform(chunk, _enc, cb) {
              hash.update(chunk)
              cb(null, chunk)
            },
          })

          let tooLarge = false
          stream.on('limit', () => {
            tooLarge = true
          })

          const ws = createWriteStream(tmpPath)
          streams.add(stream)
          streams.add(ws)
          try {
            await pipeline(stream, tap, ws)
          } finally {
            streams.delete(stream)
            streams.delete(ws)
          }
          if (tooLarge) throw new Error('FILE_TOO_LARGE')

          // 包也要 fsync：只 rename 不 fsync，断电后可能文件在、内容截断
          const fh = await fs.open(tmpPath, 'r+')
          try {
            await fh.sync()
          } finally {
            await fh.close()
          }

          sha256 = hash.digest('hex')
          bytesWritten = (await fs.stat(tmpPath)).size
        })().catch((err) => {
          taskErrors.push(err)
          // 写盘错误时 pipeline 会销毁文件流，busboy 可能不再前进；主动 abort 兜底。
          // 超限除外：它需要等 busboy 正常收尾，由 commit 统一返回 413。
          if (err && err.message !== 'FILE_TOO_LARGE') {
            abort(500, '写盘失败，请检查磁盘后重试', 'write_failed')
          }
          return null
        }),
      )
    })

    bb.on('field', (name, val) => {
      if (name === 'changelog') changelog = String(val)
    })

    bb.on('filesLimit', () => abort(400, '一次只能上传一个文件', 'files_limit'))
    bb.on('fieldsLimit', () => abort(400, '字段数超出限制', 'fields_limit'))
    bb.on('error', () => abort(400, 'multipart 解析失败', 'multipart_error'))
    req.on('error', () => abort(400, '连接中断', 'request_error'))

    req.on('close', () => {
      if (!req.complete && state === 'receiving') abort(499, '客户端已断开', 'client_closed')
    })

    bb.on('close', () => {
      if (state !== 'receiving') return
      state = 'committing'
      void commit()
    })

    req.pipe(meter).pipe(bb)
  } catch (e) {
    // 预检/建 busboy/挂管道任意一步同步抛错，占位都必须收回
    logReject(req, 'prepare_failed', { code: e?.code, message: e?.message })
    releaseOnce()
    if (!res.headersSent && !res.destroyed) res.status(500).json({ error: '服务器内部错误' })
  }
}
