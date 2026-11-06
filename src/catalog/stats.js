// 下载计数：内存累加 + 定时批量落盘。key 用完整 id。
import fs from 'node:fs/promises'
import { cfg } from '../config.js'
import { writeAtomic } from './persist.js'

class Stats {
  constructor() {
    /** @type {Record<string, number>} */
    this.map = {}
    this.dirty = false
    this.timer = null
  }

  async load() {
    try {
      const raw = await fs.readFile(cfg.statsPath, 'utf8')
      const obj = JSON.parse(raw)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        this.map = obj
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn('[stats] stats.json 读取失败，按空计数启动：', e.message)
      }
    }
    this.startTimer()
  }

  startTimer() {
    if (this.timer) return
    const sec = Math.max(5, cfg.statsFlushSec)
    this.timer = setInterval(() => {
      void this.flush()
    }, sec * 1000)
    this.timer.unref?.()
  }

  /** @param {string} id */
  inc(id) {
    this.map[id] = (this.map[id] || 0) + 1
    this.dirty = true
  }

  /** @param {string} id */
  get(id) {
    return this.map[id] || 0
  }

  async flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      await writeAtomic(cfg.statsPath, JSON.stringify(this.map, null, 2))
    } catch (e) {
      this.dirty = true
      console.warn('[stats] 计数落盘失败：', e.message)
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

export const stats = new Stats()
