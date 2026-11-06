// 入口：启动自检（目录 → 装载 JSON → 清理 tmp → 对账 → 计数装载）→ HTTP Server（四个超时）→ 优雅退出。
import http from 'node:http'
import { createApp } from './app.js'
import { cfg } from './config.js'
import { catalog } from './catalog/catalog.js'
import { stats } from './catalog/stats.js'
import { ensureDirs, loadReleases, cleanupTmp, reconcile, flush } from './catalog/persist.js'
import { inflight } from './routes/upload.js'

async function initStore() {
  await ensureDirs()
  const data = await loadReleases()
  catalog.load(data.releases)
  await cleanupTmp()
  await reconcile(catalog)
  await stats.load()
}

async function main() {
  await initStore()

  const app = createApp()
  const server = http.createServer(app)

  // 关键：默认 300 秒会把大文件上传掐死，必须显式禁用
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  server.keepAliveTimeout = 65_000
  server.timeout = 0

  // 只监听 IPv4：双栈下 remoteAddress 会带 ::ffff:，CIDR 匹配必踩坑
  server.listen(cfg.port, '0.0.0.0', () => {
    console.log(
      `[online-exe] listening http://0.0.0.0:${cfg.port}  data=${cfg.dataDir}`,
    )
  })

  let shuttingDown = false

  async function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[shutdown] 收到 ${signal}，停止接收新请求`)

    server.close()

    // 等正在进行的上传结束，最多 30 秒
    const deadline = Date.now() + 30_000
    while (inflight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }

    stats.stop()
    await stats.flush()
    await flush()

    if (inflight.size > 0) {
      console.warn(`[shutdown] 仍有 ${inflight.size} 个上传未完成，强制退出`)
    }
    server.closeAllConnections?.()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err)
  })
}

main().catch((err) => {
  console.error('[startup] 启动失败：')
  console.error(err.message || err)
  process.exit(1)
})
