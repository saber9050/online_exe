// 环境变量装载与默认值。所有路径基于项目根目录，不依赖进程工作目录。
import path from 'node:path'

// 本文件在 src/ 下，项目根是上一级
const root = path.join(import.meta.dirname, '..')

/** @typedef {{ port:number, dataDir:string, maxUploadMb:number, keepPerPlatform:number,
 * appName:string, appDescription:string, timezone:string, adminAllowCidr:string,
 * statsFlushSec:number, releasesDir:string, orphanDir:string, jsonPath:string,
 * statsPath:string, viewsDir:string, publicDir:string, root:string }} Config */

/** @type {Config} */
export const cfg = {
  root,
  port: Number(process.env.PORT || 8080),
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 800),
  keepPerPlatform: Number(process.env.KEEP_PER_PLATFORM || 5),
  // 只影响「首次初始化 releases.json」时写进 app 段的元信息（已在文件里的不会被覆盖）。
  // 与下载页 / 管理端的展示名称保持一致（2026-11-05 已按需求更名为 llm-wiki）。
  appName: process.env.APP_NAME || 'llm-wiki',
  appDescription: process.env.APP_DESCRIPTION || '客户端',
  timezone: process.env.TZ || 'Asia/Shanghai',
  adminAllowCidr: String(process.env.ADMIN_ALLOW_CIDR || '').trim(),
  statsFlushSec: Number(process.env.STATS_FLUSH_SEC || 30),
}

cfg.releasesDir = path.join(cfg.dataDir, 'releases')
cfg.orphanDir = path.join(cfg.dataDir, 'orphan')
cfg.jsonPath = path.join(cfg.dataDir, 'releases.json')
cfg.statsPath = path.join(cfg.dataDir, 'stats.json')
cfg.viewsDir = path.join(root, 'views')
cfg.publicDir = path.join(root, 'public')
