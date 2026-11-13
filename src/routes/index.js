// 路由表：所有路径与方法在这里一次性挂完。
// 纪律：这个文件只由成员 A 改（方案 7.8），B 新增接口时提供 handler，由 A 挂路由。
// 本次 B 侧补齐 yank/unyank 别名时在这里新增了两行，已同步告知 A。
import { Router } from 'express'
import { storage } from '../storage/storage.js'
import { renderDownload } from './pages/download.js'
import { renderAdmin } from './pages/admin.js'
import { uploadHandler } from './upload.js'
import { initUpload, uploadChunk, uploadStatus, completeUpload, abortUpload, abortUploadByKey } from './uploads.js'
import { downloadHandler, checksumHandler } from './download.js'
import { statsHandler } from './stats.js'
import * as releases from './releases.js'

export const router = Router()

// 健康检查：写盘探针失败即 503（磁盘满、/data 不可写）
// 注意不挂 CIDR：Docker 探针从 127.0.0.1 打进来，一限制就会把容器标成 unhealthy
router.get('/healthz', async (req, res) => {
  try {
    await storage.probe()
    res.status(200).send('ok')
  } catch {
    res.status(503).send('storage unavailable')
  }
})

// ── 页面 ────────────────────────────────────────────────
router.get('/', renderDownload)
router.get('/admin', renderAdmin)

// ── 写接口 / 版本管理（成员 B）────────────────────────────
// 上传：multipart 流式，元数据（version/platform/arch）必须走 query
router.post('/api/releases', uploadHandler)

// ── 分片上传会话（管理页用，并发多连接提速）──────────────
// init → 循环 PUT 分片 → complete；放弃时 DELETE。会话只在内存，重启即失效（客户端拿 410 重开）。
router.post('/api/uploads', initUpload)
router.get('/api/uploads/:id', uploadStatus)
router.put('/api/uploads/:id/chunks', uploadChunk)
router.post('/api/uploads/:id/complete', completeUpload)
router.delete('/api/uploads/:id', abortUpload)
// 按业务键（version+platform+arch）强制释放上次异常中断留下的占用
router.delete('/api/uploads', abortUploadByKey)
// 列表：支持 status / platform 筛选
router.get('/api/releases', releases.listHandler)

// 下载计数：管理页轮询它就地刷新「下载」列（整页刷新会把筛选和滚动位置丢掉）
router.get('/api/stats', statsHandler)

// 撤回 / 恢复：两组入口语义相同。
// PATCH 是当前前端在用的形态；POST /yank、/unyank 是方案 7.4 冻结的形态（CI 可能照冻结表写）。
// 保留两套是刻意的：接口契约以冻结表为准，前端不必为了改形态而跟着改一轮。
router.patch('/api/releases/:id', releases.patchHandler)
router.post('/api/releases/:id/yank', releases.yankHandler)
router.post('/api/releases/:id/unyank', releases.unyankHandler)

// 删除：墓碑式，记录保留、文件删除
router.delete('/api/releases/:id', releases.deleteHandler)

// 完整性校验：重算磁盘文件的 sha256，与上传时记录比对（管理页「校验」按钮）
router.get('/api/releases/:id/integrity', releases.integrityHandler)

// 孤儿文件（磁盘上有、记录里没有）：先看得见，才能判断该不该清
router.get('/api/orphans', releases.orphanListHandler)
router.delete('/api/orphans', releases.orphanDeleteHandler)

// ── 下载直链（成员 A）────────────────────────────────────
// 校验码必须排在直链之前：`/:combo.sha256` 里的 `.sha256` 是字面前缀，
// 顺序反了会被 `/:combo` 先吃掉（combo 变成 "windows10-x64.sha256"，段数校验直接 404）。
router.get('/dl/:version/:combo.sha256', checksumHandler)
router.get('/dl/:version/:combo', downloadHandler)
