// 本地磁盘存储实现。object_key 由程序生成，绝不使用用户文件名。
import fs from 'node:fs/promises'
import path from 'node:path'
import { cfg } from '../config.js'

export const storage = {
  /** @param {string} objectKey */
  abs(objectKey) {
    return path.join(cfg.releasesDir, objectKey)
  },

  /** @param {string} version @param {string} platform @param {string} arch */
  dirFor(version, platform, arch) {
    return path.join(cfg.releasesDir, version, `${platform}-${arch}`)
  },

  /** @param {string} version @param {string} platform @param {string} arch */
  finalPath(version, platform, arch) {
    return path.join(this.dirFor(version, platform, arch), 'package.bin')
  },

  /** 唯一临时文件名，必须与目标文件同一文件系统 */
  tmpPath(version, platform, arch) {
    const dir = this.dirFor(version, platform, arch)
    const rand = Math.random().toString(16).slice(2, 10)
    return path.join(dir, `package.bin.${Date.now()}-${rand}.tmp`)
  },

  /** @param {string} dir */
  async ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true })
  },

  /** @param {string} objectKey */
  async remove(objectKey) {
    await fs.unlink(this.abs(objectKey)).catch(() => {})
  },

  /** @returns {Promise<{total:number, free:number}>} */
  async diskInfo() {
    const s = await fs.statfs(cfg.dataDir)
    return {
      total: Number(s.blocks) * Number(s.bsize),
      free: Number(s.bavail) * Number(s.bsize),
    }
  },

  /** 剩余可用字节，失败时返回 0 由调用方拒绝上传 */
  async freeBytes() {
    try {
      const s = await fs.statfs(cfg.dataDir)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      return 0
    }
  },

  /** 健康探针：写一个临时文件再删除，失败即存储不可用 */
  async probe() {
    const p = path.join(cfg.dataDir, '.health.tmp')
    await fs.writeFile(p, 'ok')
    await fs.unlink(p)
  },

  /** 孤儿文件统计（data/orphan/） */
  async orphanStats() {
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
        } else if (ent.isFile()) {
          const st = await fs.stat(p).catch(() => null)
          if (st) {
            count += 1
            bytes += st.size
          }
        }
      }
    }
    await walk(cfg.orphanDir)
    return { count, bytes }
  },
}
