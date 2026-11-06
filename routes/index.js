// 路由表：所有路径与方法在这里一次性挂完。
// 纪律：这个文件只由成员 A 改（方案 7.8），B 新增接口时提供 handler，由 A 挂路由。
// 本次 B 侧补齐 yank/unyank 别名时在这里新增了两行，已同步告知 A。
import { Router } from 'express'
import { storage } from '../lib/storage.js'
import { renderDownload } from './pages/download.js'
import { renderAdmin } from './pages/admin.js'
import { uploadHandler } from './upload.js'
import { downloadHandler } from './download.js'
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
// 列表：支持 status / platform 筛选
router.get('/api/releases', releases.listHandler)

// 撤回 / 恢复：两组入口语义相同。
// PATCH 是当前前端在用的形态；POST /yank、/unyank 是方案 7.4 冻结的形态（CI 可能照冻结表写）。
// 保留两套是刻意的：接口契约以冻结表为准，前端不必为了改形态而跟着改一轮。
router.patch('/api/releases/:id', releases.patchHandler)
router.post('/api/releases/:id/yank', releases.yankHandler)
router.post('/api/releases/:id/unyank', releases.unyankHandler)

// 删除：墓碑式，记录保留、文件删除
router.delete('/api/releases/:id', releases.deleteHandler)

// ── 下载直链（成员 A）────────────────────────────────────
router.get('/dl/:version/:combo', downloadHandler)
