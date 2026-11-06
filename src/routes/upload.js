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
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')
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
    return res.status(400).json({ error: '版本号格式不合法，应为 MAJOR.MINOR.PATCH[-prerelease]' })
  }
  if (!PLATFORM_ARCH_SET.has(`${platform}-${arch}`)) {
    return res.status(400).json({ error: `平台与架构组合不受支持：${platform}-${arch}` })
  }

  const version = parsed.version
  const key = `${platform}|${arch}|${version}`

  // 这一段同步执行，查重 + 占位天然原子
  const existing = catalog.get(platform, arch, version)
  if (existing && existing.file_missing !== true) {
    return res.status(409).json({
      error: `${version} / ${platform} / ${arch} 已存在，请改用新版本号`,
      existing: toReleaseDto(existing),
    })
  }
  if (inflight.has(key)) {
    return res.status(409).json({ error: '该版本正在上传，请稍后再试' })
  }
  inflight.set(key, Date.now())

  // 磁盘空间预检 + 预留额度
  const contentLength = Number(req.headers['content-length'] || 0)
  let reserved = 0
  if (contentLength > 0) {
    const free = await getFreeBytes()
    reserved = tryReserve(free, contentLength)
    if (reserved === 0) {
      inflight.delete(key)
      return res.status(507).json({ error: '磁盘空间不足，无法接收该文件' })
    }
  }

  try {
    await storage.ensureDir(storage.dirFor(version, platform, arch))
  } catch {
    inflight.delete(key)
    releaseReserve(reserved)
    return res.status(500).json({ error: '创建存储目录失败' })
  }

  let state = 'receiving' // receiving | committing | done | aborted
  let tmpPath = null
  let sha256 = null
  let bytesWritten = 0
  let userFilename = null
  let changelog = ''
  const tasks = []
  const taskErrors = []
  const reqIp = clientIp(req)

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
    inflight.delete(key)
    releaseReserve(reserved)
    return res.status(400).json({ error: 'multipart 解析失败，请检查 Content-Type' })
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

        await pipeline(stream, tap, createWriteStream(tmpPath))
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
          abort(500, '写盘失败，请检查磁盘后重试')
        }
        return null
      }),
    )
  })

  bb.on('field', (name, val) => {
    if (name === 'changelog') changelog = String(val)
  })

  bb.on('filesLimit', () => abort(400, '一次只能上传一个文件'))
  bb.on('fieldsLimit', () => abort(400, '字段数超出限制'))
  bb.on('error', () => abort(400, 'multipart 解析失败'))
  req.on('error', () => abort(400, '连接中断'))

  req.on('close', () => {
    if (!req.complete && state === 'receiving') abort(499, '客户端已断开')
  })

  bb.on('close', () => {
    if (state !== 'receiving') return
    state = 'committing'
    void commit()
  })

  function abort(code, msg) {
    if (state !== 'receiving') return
    state = 'aborted'
    void (async () => {
      await Promise.allSettled(tasks)
      await cleanup()
      releaseReserve(reserved)
    })()
    if (!res.headersSent) res.status(code).json({ error: msg })
  }

  async function cleanup() {
    if (tmpPath) {
      await fs.unlink(tmpPath).catch(() => {})
      tmpPath = null
    }
    inflight.delete(key)
  }

  async function commit() {
    try {
      if (tasks.length === 0) throw new Error('NO_FILE')
      await Promise.all(tasks)
      if (taskErrors.length > 0) throw taskErrors[0]
      if (!tmpPath) throw new Error('NO_FILE')

      const finalPath = storage.finalPath(version, platform, arch)
      const tmp = tmpPath

      const rec = await enqueueWrite(async () => {
        // 串行段内再次查重
        const cur = catalog.get(platform, arch, version)
        if (cur && cur.file_missing !== true) throw new Error('DUPLICATE')

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
      await cleanup()
      if (!res.headersSent) {
        // 错误码映射集中在一处：三个已知业务错误 + 兜底 500。
        // 不要在状态码上写三元套三元，也不要把同一个映射散到多处。
        const KNOWN = { DUPLICATE: 409, NO_FILE: 400, FILE_TOO_LARGE: 413 }
        const code = KNOWN[err.message] ?? 500
        const body = { error: '上传失败，请稍后重试' }

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
      inflight.delete(key)
      releaseReserve(reserved)
    }
  }

  req.pipe(bb)
}
