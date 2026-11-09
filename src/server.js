// 入口：启动自检（目录 → 装载 JSON → 清理 tmp → 对账 → 计数装载）→ HTTP Server（四个超时）→ 优雅退出。
import http from 'node:http'
import { createApp } from './app.js'
import { cfg } from './config.js'
import { catalog } from './catalog/catalog.js'
import { stats } from './catalog/stats.js'
import { ensureDirs, loadReleases, cleanupTmp, reconcile, flush } from './catalog/persist.js'
import { inflight } from './routes/upload.js'
import { drainSessions } from './routes/uploads.js'

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

    // 分片会话先收掉：每个会话都占着一个 inflight 占位，
    // 不先清掉的话下面那个「等正在进行的上传结束」会白等满 30 秒。
    const drained = await drainSessions()
    if (drained > 0) console.log(`[shutdown] 放弃 ${drained} 个未提交的分片会话`)

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
  const msg = err && err.message ? err.message : String(err)
  console.error('[startup] 启动失败：')
  console.error(msg)

  // 权限类错误几乎只有一个原因：数据目录的属主不是运行用户。
  // 容器里跑的是 uid 1000（node），宿主机挂载目录若属于 root，mkdir 直接 EACCES。
  // 这里把「怎么改」直接打出来，省得对着 EACCES 猜。
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : '?'
    console.error(`[startup] 当前进程 uid=${uid}，数据目录 ${cfg.dataDir} 不可写`)
    if (uid === 0) {
      console.error('[startup] 请检查挂载目录是否只读（-v 后面有没有漏 :rw / 是否 NFS root_squash）')
    } else {
      console.error(`[startup] 宿主机执行：sudo chown -R ${uid}:${uid} <被挂载的宿主机目录>`)
      console.error('[startup] 若该目录在 Windows 盘（/mnt/c、/mnt/f），chown 不生效，请换到 ext4 路径或改用命名卷')
    }
  }

  // 磁盘满也是上传类服务最常见的启动失败原因，单独提示一句
  if (err && err.code === 'ENOSPC') {
    console.error('[startup] 磁盘空间不足，清理后重试（管理页状态条可看占用）')
  }

  process.exit(1)
})
