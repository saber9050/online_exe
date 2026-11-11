// GET /api/stats — 各版本的下载计数，形状 { counts: { [releaseId]: number } }。
//
// 为什么要这个接口：管理页的「下载」列是服务端渲染的，用户下完再回来看，
// 不刷新页面就永远是旧值，看上去像「统计不到」。管理页现在每 10 秒拉一次这个接口
// 就地更新单元格，不用整页刷新。刻意只回计数、不回整张版本表，轮询成本可以忽略。
import { stats } from '../catalog/stats.js'

/** @param {import('express').Request} req @param {import('express').Response} res */
export function statsHandler(req, res) {
  res.json({ counts: stats.snapshot() })
}
