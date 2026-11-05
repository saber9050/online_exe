// releases.json 的原子写、三态加载、tmp 清理与启动对账。
import fs from 'node:fs/promises'
import path from 'node:path'
import { cfg } from '../config.js'

const SCHEMA = 3

let appMeta = {
  name: cfg.appName,
  description: cfg.appDescription,
}

/** 所有 JSON 写入串行化。固定 .tmp 后缀 + 并发 = 写出半个 JSON。 */
let writeQueue = Promise.resolve()

/** @param {() => Promise<any>} fn */
export function enqueueWrite(fn) {
  const run = writeQueue.then(fn, fn)
  writeQueue = run.catch(() => {})
  return run
}

/** 等待队列排空（优雅退出用） */
export function flush() {
  return writeQueue
}

export function getAppMeta() {
  return appMeta
}

/** @param {any[]} records */
export function serialize(records) {
  return JSON.stringify(
    { schema: SCHEMA, app: appMeta, releases: records },
    null,
    2,
  )
}

/** 原子写：tmp → fsync → rename → 目录 fsync */
export async function writeAtomic(target, data) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  const fh = await fs.open(tmp, 'w')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.rename(tmp, target)

  try {
    const dir = await fs.open(path.dirname(target), 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } catch (e) {
    if (!['EACCES', 'EPERM', 'EINVAL', 'EISDIR'].includes(e.code)) throw e
  }
}

export async function ensureDirs() {
  await fs.mkdir(cfg.dataDir, { recursive: true })
  await fs.mkdir(cfg.releasesDir, { recursive: true })
  await fs.mkdir(cfg.orphanDir, { recursive: true })
}

/** 三态加载：不存在→初始化空结构；语法错误→拒绝启动；缺字段→补默认值 */
export async function loadReleases() {
  let raw
  try {
    raw = await fs.readFile(cfg.jsonPath, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') {
      const initial = { schema: SCHEMA, app: appMeta, releases: [] }
      await writeAtomic(cfg.jsonPath, JSON.stringify(initial, null, 2))
      return initial
    }
    throw e
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const err = new Error(
      `releases.json 语法错误，拒绝启动。\n  文件：${cfg.jsonPath}\n  位置：${e.message}\n` +
        `  建议：先备份该文件，再手动修复或用 releases.json.bak 覆盖。`,
    )
    err.fatal = true
    throw err
  }

  if (typeof parsed.schema === 'number' && parsed.schema > SCHEMA) {
    const err = new Error(
      `releases.json schema=${parsed.schema} 高于程序支持的 ${SCHEMA}，请升级程序后再启动。`,
    )
    err.fatal = true
    throw err
  }

  if (parsed.app && typeof parsed.app === 'object') {
    appMeta = {
      name: parsed.app.name || cfg.appName,
      description: parsed.app.description || cfg.appDescription,
    }
  }

  const releases = Array.isArray(parsed.releases) ? parsed.releases : []
  for (const r of releases) {
    if (r.file_missing === undefined) r.file_missing = false
    if (!r.status) r.status = 'active'
    if (r.is_prerelease === undefined) r.is_prerelease = Boolean(r.prerelease)
  }

  return { schema: SCHEMA, app: appMeta, releases }
}

/** 递归删除残留 *.tmp，日志输出个数与总字节数 */
export async function cleanupTmp() {
  let count = 0
  let bytes = 0

  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (e) {
      if (e.code === 'ENOENT') return
      throw e
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(p)
      } else if (ent.name.endsWith('.tmp')) {
        const st = await fs.stat(p).catch(() => null)
        await fs.unlink(p).catch(() => {})
        count += 1
        if (st) bytes += st.size
      }
    }
  }

  await walk(cfg.releasesDir)
  if (count > 0) {
    console.log(`[startup] 清理临时文件 ${count} 个 / ${bytes} 字节`)
  }
}

/**
 * 文件与记录对账：只动 file_missing，不碰 status；墓碑整体跳过。
 * 孤儿文件移入 data/orphan/，不直接删除。
 */
export async function reconcile(catalog) {
  const files = new Set()

  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (e) {
      if (e.code === 'ENOENT') return
      throw e
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(p)
      } else if (ent.isFile()) {
        files.add(path.relative(cfg.releasesDir, p).split(path.sep).join('/'))
      }
    }
  }
  await walk(cfg.releasesDir)

  let changed = false

  for (const rel of catalog.list()) {
    if (rel.status === 'deleted') continue // 墓碑不参与对账
    const exists = files.has(rel.object_key)
    if (!exists && !rel.file_missing) {
      rel.file_missing = true
      changed = true
    }
    if (exists && rel.file_missing) {
      rel.file_missing = false
      changed = true
    }
  }

  const referenced = new Set(catalog.list().map((r) => r.object_key))
  for (const f of files) {
    if (!f.endsWith('package.bin')) continue
    if (referenced.has(f)) continue
    const src = path.join(cfg.releasesDir, f)
    const dest = path.join(cfg.orphanDir, `${f.replace(/\//g, '__')}.${Date.now()}`)
    try {
      await fs.rename(src, dest)
      console.log(`[startup] 孤儿文件 ${f} → data/orphan/`)
    } catch (e) {
      console.warn(`[startup] 移动孤儿文件失败：${f}`, e.message)
    }
  }

  if (changed) {
    await writeAtomic(cfg.jsonPath, serialize(catalog.list()))
  }
}
