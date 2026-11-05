import express from 'express'
import { cfg } from './config.js'
import { router } from './routes/index.js'
import { adminGuard } from './middleware/cidr.js'
import { notFound, errorHandler } from './middleware/errors.js'
import { fmtSize, fmtDate } from './lib/format.js'

export function createApp() {
  const app = express()

  app.set('view engine', 'ejs')
  app.set('views', cfg.viewsDir)

  // 模板全局变量与格式化函数
  app.locals.cfg = cfg
  app.locals.fmtSize = fmtSize
  app.locals.fmtDate = (iso) => fmtDate(iso, cfg.timezone)

  // 静态资源：默认 ETag + 协商缓存，不设长缓存（文件名无指纹）
  app.use(express.static(cfg.publicDir))

  app.use(express.json({ limit: '1mb' }))

  // /admin 与 /api 受来源网段限制（ADMIN_ALLOW_CIDR 为空时不限制）
  app.use('/admin', adminGuard)
  app.use('/api', adminGuard)

  app.use(router)

  app.use(notFound)
  app.use(errorHandler)

  return app
}
