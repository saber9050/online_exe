// 孤儿文件管理：data/orphan/ 下的「磁盘上有、releases.json 里没有」的文件。
//
// 归属说明：这个文件属于成员 B（管理页的「孤儿可见 + 可清理」是 B 的交付，验收项 #14）。
// 成员 A 的 src/storage/storage.js 只提供 orphanStats()（个数 + 总字节），查询/删除路径放在这里，
// 目的是不往 A 的文件里塞展示层需求，避免两边同时改同一个文件。
//
// 生命周期：启动对账（src/catalog/persist.js 的 reconcile）把 src 文件 rename 成
//   data/orphan/{version}__{platform}-{arch}__package.bin.{时间戳}
// 也就是「平铺 + 带时间戳」的命名。对账只搬走、不删除，因此这里必须有入口，
// 否则 orphan/ 会悄悄涨满磁盘 —— 和「启动清理 tmp」要解决的是同一类问题：只清不展示等于没解决。
import fs from 'node:fs/promises'
import path from 'node:path'
import { cfg } from '../config.js'

/** 构造带 HTTP 状态码的错误，交给统一错误处理映射 */
function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/**
 * 把「相对 orphanDir 的路径」解析成绝对路径，并挡住路径穿越。
 *
 * 为什么必须校验：这个值来自 HTTP 查询参数，`?path=../../data/releases.json`
 * 能把整个版本库删掉。检查方式是「解析后必须仍在 orphanDir 之内」，
 * 而不是简单禁止 `..` —— 后者对 URL 编码、Windows 反斜杠、符号链接都不够稳。
 */
function resolveInside(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw httpError(400, 'path 不能为空')
  }

  const root = path.resolve(cfg.orphanDir)
  const abs = path.resolve(root, relPath)

  // 注意要比较 root + 分隔符：只 startsWith(root) 会放过 /data/orphan-evil/x
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw httpError(400, 'path 非法：必须位于 data/orphan/ 之内')
  }
  return abs
}

/** 递归收集 orphanDir 下的所有普通文件（对账搬进来的是文件，但历史数据可能有子目录） */
async function walkFiles(dir, root, out) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (e) {
    // 目录不存在 = 没有孤儿，不是错误
    if (e.code === 'ENOENT') return
    throw e
  }

  for (const ent of entries) {
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      await walkFiles(abs, root, out)
      continue
    }
    if (!ent.isFile()) continue // 符号链接等一律忽略，不给它被删的机会
    const st = await fs.stat(abs).catch(() => null)
    if (!st) continue
    out.push({
      // 统一用正斜杠：这个字段会进 JSON、也会回传给 DELETE ?path=，
      // Windows 下若原样带反斜杠，前端拼 URL 时会被转义成 %5C，删不掉
      path: path.relative(root, abs).split(path.sep).join('/'),
      size: st.size,
      mtime: st.mtime.toISOString(),
    })
  }
}

/**
 * 列出全部孤儿文件，按修改时间倒序（最近搬进来的在最上面）。
 * @returns {Promise<{count:number, bytes:number, orphans:Array<{path:string,size:number,mtime:string}>}>}
 */
export async function listOrphans() {
  const root = path.resolve(cfg.orphanDir)
  const out = []
  await walkFiles(root, root, out)
  out.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return {
    count: out.length,
    bytes: out.reduce((s, f) => s + f.size, 0),
    orphans: out,
  }
}

/**
 * 删除单个孤儿文件。
 * 只接受文件，不接受目录：递归删目录的破坏面太大，而孤儿本质上都是文件。
 *
 * @param {string} relPath 相对 data/orphan/ 的路径
 */
export async function removeOrphan(relPath) {
  const abs = resolveInside(relPath)

  let st
  try {
    st = await fs.stat(abs)
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError(404, '该孤儿文件不存在（可能已被删除）')
    throw e
  }

  if (!st.isFile()) throw httpError(400, '只能删除孤儿文件，不能删除目录')
  await fs.unlink(abs)

  return { path: relPath, size: st.size }
}

/**
 * 清空整个 orphan 目录。
 *
 * 用 rm -r 之后重建目录，而不是逐个 unlink：孤儿目录里可能有对账早期留下的子目录结构，
 * 逐个删要处理「删空目录」的顺序问题，收益为零。注意这里删的是 data/orphan/，
 * 不在 data/releases/ 的扫描范围内，所以不会被下次对账当成新的孤儿。
 */
export async function clearOrphans() {
  // 先统计，删完就查不到了
  const before = await listOrphans()
  await fs.rm(path.resolve(cfg.orphanDir), { recursive: true, force: true })
  await fs.mkdir(path.resolve(cfg.orphanDir), { recursive: true })
  return { removed: before.count, bytes: before.bytes }
}
