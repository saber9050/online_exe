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
  // 默认值必须是本项目真实值：忘了传环境变量时，页面标题和 JSON 元信息也应该是「核心力量」，
  // 而不是任何历史模板留下的名字。
  appName: process.env.APP_NAME || '核心力量',
  appDescription: process.env.APP_DESCRIPTION || '少儿跑酷客户端',
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
