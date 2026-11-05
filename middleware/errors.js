export function notFound(req, res) {
  res.status(404).send('not found')
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  console.error('[error]', req.method, req.originalUrl, err)
  if (res.headersSent) return res.destroy()
  res.status(500).json({ error: '服务器内部错误' })
}
