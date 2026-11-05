// 启动自检：目录 → 装载 JSON → 清理 tmp → 对账 → 计数装载。
import { catalog } from './catalog.js'
import { stats } from './stats.js'
import {
  ensureDirs,
  loadReleases,
  cleanupTmp,
  reconcile,
} from './persist.js'

export async function initStore() {
  await ensureDirs()
  const data = await loadReleases()
  catalog.load(data.releases)
  await cleanupTmp()
  await reconcile(catalog)
  await stats.load()
}
