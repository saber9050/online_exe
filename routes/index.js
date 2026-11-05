import { Router } from 'express'
import { storage } from '../lib/storage.js'
import { renderDownload } from './pages/download.js'
import { renderAdmin } from './pages/admin.js'
import { uploadHandler } from './upload.js'
import { downloadHandler } from './download.js'
import * as releases from './releases.js'

export const router = Router()

// 健康检查：写盘探针失败即 503（磁盘满、/data 不可写）
router.get('/healthz', async (req, res) => {
  try {
    await storage.probe()
    res.status(200).send('ok')
  } catch {
    res.status(503).send('storage unavailable')
  }
})

// 页面
router.get('/', renderDownload)
router.get('/admin', renderAdmin)

// 写接口与版本管理
router.post('/api/releases', uploadHandler)
router.get('/api/releases', releases.listHandler)
router.patch('/api/releases/:id', releases.patchHandler)
router.delete('/api/releases/:id', releases.deleteHandler)

// 下载直链
router.get('/dl/:version/:combo', downloadHandler)
