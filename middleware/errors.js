// 404 与统一错误响应。归属：成员 B。
// 目标：任何一条失败路径吐给客户端的都是 { error: "中文说明" }，状态码有意义。

export function notFound(req, res) {
  // 404 走纯文本是刻意的：这个处理器只兜「路由没命中」，
  // 通常意味着调用方把 URL 写错了，不需要前端按 JSON 解析。
  res.status(404).send('not found')
}

/**
 * 统一错误处理。四条规则：
 *   1. err.status 有值就用它（业务层用「抛带 status 的错误」表达 4xx，避免每处都写 res.status）
 *   2. 5xx 一律不把内部信息吐给客户端，只留「服务器内部错误」，细节进日志
 *   3. 4xx 用 err.message 原样输出 —— 这些文案是写给调用方看的
 *   4. headersSent 时必须 destroy()。写成「什么都不做」的话，传输中途出错连接会挂到
 *      keepAliveTimeout，用户侧表现为「下载/上传卡死」，比直接断开更难排查
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = Number(err?.status) || 500

  // 只有 5xx 打完整堆栈；4xx 是预期内的输入错误，打堆栈只会把日志淹掉
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err)

  if (res.headersSent) return res.destroy()

  res.status(status).json({
    error: status >= 500 ? '服务器内部错误' : String(err?.message || '请求无法处理'),
  })
}
