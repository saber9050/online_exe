// 下载计数：内存累加 + 定时批量落盘。key 用完整 id。
//
// 为什么比「内存 + 30 秒落盘」多做三件事：
//   1. inc 之后 1 秒就落一次盘。原来只靠 30 秒定时器，中途被 kill / 断电，
//      这段时间的下载全丢——现象就是「明明下了，管理端还是 0」。
//   2. 落盘前先 reload 一次并与磁盘取「较大值」合并。同一份 data 目录被两个进程
//      打开时（比如另起一个实例验证），各自的内存表互不可见，后落盘的会把先落盘的整份覆盖掉。
//   3. 每 5 秒热加载一次。别的进程写进来的增量，本进程的 get() 也能看到。
// 计数只会单调递增，所以合并用 max 是安全的。
import fs from 'node:fs/promises'
import { cfg } from '../config.js'
import { writeAtomic } from './persist.js'

/** inc 之后多久落盘：够合并连续点击，又不至于丢太多 */
const FLUSH_DEBOUNCE_MS = 1000

/** 多久热加载一次磁盘计数（让多进程共享 data 目录时也能看到对方的增量） */
const RELOAD_MS = 5000

class Stats {
  constructor() {
    /** @type {Record<string, number>} */
    this.map = {}
    this.dirty = false
    this.timer = null
    this.reloadTimer = null
    this.flushTimer = null
    /** 上次从磁盘读到/写入的 mtime，用来判断文件有没有被别的进程改过 */
    this.mtimeMs = 0
  }

  async load() {
    await this.reload()
    this.startTimer()
  }

  /** 读磁盘并与内存取较大值。文件没变就直接返回，不产生 IO。 */
  async reload() {
    let st
    try {
      st = await fs.stat(cfg.statsPath)
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[stats] stats.json 不可读：', e.message)
      return
    }
    if (st.mtimeMs === this.mtimeMs) return
    try {
      const raw = await fs.readFile(cfg.statsPath, 'utf8')
      const obj = JSON.parse(raw)
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
      for (const key of Object.keys(obj)) {
        const n = Number(obj[key]) || 0
        if ((this.map[key] || 0) < n) this.map[key] = n
      }
      this.mtimeMs = st.mtimeMs
    } catch (e) {
      // 读到半个文件（另一个进程正在 rename）就下次再说，不要把计数清空
      console.warn('[stats] stats.json 解析失败，跳过本次热加载：', e.message)
    }
  }

  startTimer() {
    if (!this.timer) {
      const sec = Math.max(5, cfg.statsFlushSec)
      this.timer = setInterval(() => {
        void this.flush()
      }, sec * 1000)
      this.timer.unref?.()
    }
    if (!this.reloadTimer) {
      this.reloadTimer = setInterval(() => {
        void this.reload()
      }, RELOAD_MS)
      this.reloadTimer.unref?.()
    }
  }

  /** @param {string} id */
  inc(id) {
    this.map[id] = (this.map[id] || 0) + 1
    this.dirty = true
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        void this.flush()
      }, FLUSH_DEBOUNCE_MS)
      this.flushTimer.unref?.()
    }
  }

  /** @param {string} id */
  get(id) {
    return this.map[id] || 0
  }

  /** 给 /api/stats 用：拷一份，别把内部表暴露出去 */
  snapshot() {
    return { ...this.map }
  }

  async flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      // 先吸收别的进程刚写进去的增量，否则这次整份覆盖会把它们抹掉
      await this.reload()
      await writeAtomic(cfg.statsPath, JSON.stringify(this.map, null, 2))
      const st = await fs.stat(cfg.statsPath).catch(() => null)
      if (st) this.mtimeMs = st.mtimeMs
    } catch (e) {
      this.dirty = true
      console.warn('[stats] 计数落盘失败：', e.message)
    }
  }

  stop() {
    for (const t of [this.timer, this.reloadTimer, this.flushTimer]) {
      if (t) clearInterval(t)
    }
    this.timer = null
    this.reloadTimer = null
    this.flushTimer = null
  }
}

export const stats = new Stats()
