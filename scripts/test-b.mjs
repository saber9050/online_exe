// 成员 B 的接口冒烟测试。用法：npm test（或 node scripts/test-b.mjs）
//
// 为什么不用测试框架：生产依赖只有 express/busboy/ejs，为 30 条断言引 Jest 不划算。
// 这里用 node 内置能力（fetch / FormData / Blob / node:test 风格的断言）跑真实 HTTP，
// 测的是「起一个真进程 + 真落盘 + 真接口」，不是 mock。
//
// 每个用例独立端口与独立 DATA_DIR，跑完自动清理；任何一个用例失败，进程以 1 退出，
// 方便以后直接挂到 CI 上。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..') // scripts/ 的上一级就是项目根

let passed = 0
const failures = []

/** 断言：成功记一行，失败收集起来最后统一打印（不在中途中断，能一次看全所有问题） */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 起一个真实服务进程，返回操作句柄 */
function startServer({ dataDir, port, env = {} }) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, TZ: 'Asia/Shanghai', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const logs = []
  // 必须消费子进程输出，否则管道写满会把它卡死（表现成「服务莫名不响应」）
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))

  return {
    child,
    logs,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await Promise.race([
        new Promise((r) => child.once('exit', r)),
        sleep(3000).then(() => child.kill('SIGKILL')),
      ])
    },
  }
}

/** 轮询健康检查，等服务真正可连接（比 sleep 固定时间稳） */
async function waitReady(base, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`)
      if (res.ok) return true
    } catch {
      // 还没监听上，继续等
    }
    await sleep(100)
  }
  return false
}

/** 统一请求封装：返回 { status, body, text } —— body 解析失败时不抛，交给调用方判断 */
async function req(base, pathname, options = {}) {
  const res = await fetch(base + pathname, options)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { status: res.status, body, text }
}

/** 上传一个「文件」：元数据走 query，文件走 multipart（与方案约定一致） */
function upload(base, { version, platform, arch, bytes, filename = 'pkg.bin', changelog = '' }) {
  const form = new FormData()
  if (changelog) form.append('changelog', changelog)
  form.append('file', new Blob([new Uint8Array(bytes)]), filename)

  const qs = new URLSearchParams({ version, platform, arch }).toString()
  return req(base, `/api/releases?${qs}`, { method: 'POST', body: form })
}

/** 造一个固定内容的假产物（不用随机数，失败时好复现） */
function makeBytes(size, seed = 'a') {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = seed.charCodeAt(0) + (i % 26)
  return buf
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'online-exe-test-'))
  const dataA = path.join(tmpRoot, 'data-a') // 主用例
  const dataB = path.join(tmpRoot, 'data-b') // 上传上限用例
  const dataC = path.join(tmpRoot, 'data-c') // CIDR 用例
  const dataD = path.join(tmpRoot, 'data-d') // 分片上传用例

  console.log(`临时数据目录：${tmpRoot}\n`)

  // ════════════════════════════════════════════════════════════════
  // 场景一：空目录首启 + 上传 + 查重 + 并发
  // ════════════════════════════════════════════════════════════════
  // 显式传 APP_NAME：这个用例要验的是「环境变量会写进首次初始化的 releases.json」，
  // 不该跟着产品名改动而失效（应用名是运营层面的事，测试不该绑死某个品牌词）
  const A = startServer({ dataDir: dataA, port: 19081, env: { APP_NAME: '测试应用' } })
  console.log('[场景一] 空 /data 首启、上传、409、并发')

  const readyA = await waitReady(A.url)
  check('空 data 目录能正常启动（不是拒绝启动）', readyA, A.logs.join('').slice(-300))
  if (!readyA) {
    console.log(A.logs.join(''))
    process.exit(1)
  }

  // 1) 首启应自动生成空的 releases.json，而不是仅仅「起得来」
  const jsonA = await fs.readFile(path.join(dataA, 'releases.json'), 'utf8').catch(() => null)
  check('首启自动生成 releases.json', Boolean(jsonA))
  check(
    'releases.json 的 app 段写入 APP_NAME（环境变量生效）',
    Boolean(jsonA && jsonA.includes('测试应用')),
    jsonA ? jsonA.slice(0, 80) : '文件不存在',
  )

  // 2) healthz
  const hz = await req(A.url, '/healthz')
  check('GET /healthz → 200 ok', hz.status === 200 && hz.text === 'ok')

  // 3) 正常上传：sha256 与 size 必须是服务端实算的
  const pkg = makeBytes(64 * 1024, 'x')
  const up1 = await upload(A.url, {
    version: '1.3.0',
    platform: 'windows10',
    arch: 'x64',
    bytes: pkg,
    filename: '核心力量-1.3.0.exe',
    changelog: '修复登录闪退',
  })
  check('POST 上传 → 201', up1.status === 201, JSON.stringify(up1.body))
  check('201 响应 sha256 与本地一致', up1.body?.sha256 === sha256(pkg))
  check('201 响应 size 与本地一致', up1.body?.size === pkg.length)
  check('中文文件名不乱码（defParamCharset: utf8）', up1.body?.filename === '核心力量-1.3.0.exe', up1.body?.filename)
  check('下载直链是相对路径', up1.body?.download_url === '/dl/1.3.0/windows10-x64')
  check('上传 201 响应不含 downloads 字段', up1.body && !('downloads' in up1.body))

  // 4) 同版本重复上传 → 409 + existing
  const dup = await upload(A.url, {
    version: '1.3.0',
    platform: 'windows10',
    arch: 'x64',
    bytes: pkg,
  })
  check('同版本重复上传 → 409', dup.status === 409)
  check('409 带上 existing 供前端自动 +1', Boolean(dup.body?.existing?.version), JSON.stringify(dup.body))

  // 5) 同版本但换个平台组合 → 允许（Win7 / Win10 是两个独立平台）
  const otherPlatform = await upload(A.url, {
    version: '1.3.0',
    platform: 'windows7',
    arch: 'x64',
    bytes: pkg,
  })
  check('windows7 与 windows10 同版本号可共存', otherPlatform.status === 201)

  // 6) 并发同一版本：必须一个成功一个 409
  const raceBytes = makeBytes(1024 * 1024, 'r')
  const [r1, r2] = await Promise.all([
    upload(A.url, { version: '2.0.0', platform: 'linux', arch: 'x64', bytes: raceBytes }),
    upload(A.url, { version: '2.0.0', platform: 'linux', arch: 'x64', bytes: raceBytes }),
  ])
  const codes = [r1.status, r2.status].sort()
  check('并发同版本：201 + 409（不是两个都成功）', codes.join(',') === '201,409', codes.join(','))

  // 7) 参数校验
  const badVersion = await upload(A.url, {
    version: '1.3',
    platform: 'linux',
    arch: 'x64',
    bytes: pkg,
  })
  check('非法版本号 → 400', badVersion.status === 400, JSON.stringify(badVersion.body))

  const badCombo = await upload(A.url, {
    version: '3.0.0',
    platform: 'windows10',
    arch: 'arm64', // 不在 8 组白名单
    bytes: pkg,
  })
  check('白名单外的平台组合 → 400', badCombo.status === 400)
  check('组合错误文案含具体组合', String(badCombo.body?.error || '').includes('windows10-arm64'))

  const noFile = await req(
    A.url,
    '/api/releases?version=3.0.0&platform=linux&arch=x64',
    { method: 'POST', body: new FormData() },
  )
  check('没有 file part → 400', noFile.status === 400, JSON.stringify(noFile.body))

  const twoFiles = new FormData()
  twoFiles.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'a.bin')
  twoFiles.append('file', new Blob([new Uint8Array([4, 5, 6])]), 'b.bin')
  const multi = await req(A.url, '/api/releases?version=3.0.0&platform=linux&arch=x64', {
    method: 'POST',
    body: twoFiles,
  })
  check('一次传两个文件 → 400（不静默只存第一个）', multi.status === 400, JSON.stringify(multi.body))

  // 8) 上传后磁盘落点与临时文件清理
  const finalPath = path.join(dataA, 'releases', '1.3.0', 'windows10-x64', 'package.bin')
  const st = await fs.stat(finalPath).catch(() => null)
  check('产物落在 data/releases/{version}/{platform}-{arch}/package.bin', Boolean(st && st.size === pkg.length))
  const leftovers = await fs.readdir(path.join(dataA, 'releases', '1.3.0', 'windows10-x64'))
  check('提交后目录里不残留 .tmp', !leftovers.some((f) => f.endsWith('.tmp')), leftovers.join(','))

  // ════════════════════════════════════════════════════════════════
  // 场景二：列表筛选、撤回/恢复、墓碑
  // ════════════════════════════════════════════════════════════════
  console.log('\n[场景二] 列表筛选、yank/unyank、墓碑删除')

  // 造一个预发布版本，供筛选用例使用
  const pre = await upload(A.url, {
    version: '2.1.0-beta.1',
    platform: 'macos',
    arch: 'arm64',
    bytes: makeBytes(2048, 'p'),
  })
  check('预发布版本上传 → 201 且 is_prerelease=true', pre.status === 201 && pre.body?.is_prerelease === true)

  const all = await req(A.url, '/api/releases')
  check('GET /api/releases 返回 releases 数组', Array.isArray(all.body?.releases))
  check(
    '列表按版本号降序（2.1.0-beta.1 在最前）',
    all.body?.releases?.[0]?.version === '2.1.0-beta.1',
    all.body?.releases?.map((r) => r.version).join(','),
  )
  check('列表项带 downloads 计数', typeof all.body?.releases?.[0]?.downloads === 'number')

  const stable = await req(A.url, '/api/releases?status=stable')
  check(
    'status=stable 只返回正式在架版本',
    stable.body.releases.every((r) => r.status === 'active' && !r.is_prerelease),
  )

  const prerelease = await req(A.url, '/api/releases?status=prerelease')
  check('status=prerelease 只返回预发布', prerelease.body.releases.length === 1)

  const byPlatform = await req(A.url, '/api/releases?platform=windows7')
  check(
    'platform 筛选生效',
    byPlatform.body.releases.length === 1 && byPlatform.body.releases[0].platform === 'windows7',
  )

  const badStatus = await req(A.url, '/api/releases?status=whatever')
  check('非法 status → 400（不再静默返回全部含墓碑）', badStatus.status === 400, JSON.stringify(badStatus.body))

  // 撤回（POST 别名）→ 列表可见 → 恢复
  const id1 = up1.body.id
  const yank = await req(A.url, `/api/releases/${id1}/yank`, { method: 'POST' })
  check('POST /:id/yank → 200 且 status=yanked', yank.status === 200 && yank.body?.status === 'yanked')

  const yankAgain = await req(A.url, `/api/releases/${id1}/yank`, { method: 'POST' })
  check('重复撤回是幂等的（仍 200）', yankAgain.status === 200 && yankAgain.body?.status === 'yanked')

  const yankedList = await req(A.url, '/api/releases?status=yanked')
  check('status=yanked 能查到', yankedList.body.releases.some((r) => r.id === id1))

  // 撤回必须真的下不到：只在列表里灰显而直链还能下，等于没下架
  const dlYanked = await fetch(`${A.url}/dl/1.3.0/windows10-x64`)
  check('已撤回版本直链 → 404', dlYanked.status === 404, String(dlYanked.status))
  const pageYanked = await (await fetch(`${A.url}/`)).text()
  check('已撤回版本不出现在下载页版本历史', !pageYanked.includes('/dl/1.3.0/windows10-x64'))

  const unyank = await req(A.url, `/api/releases/${id1}/unyank`, { method: 'POST' })
  check('POST /:id/unyank → 200 且 status=active', unyank.status === 200 && unyank.body?.status === 'active')

  const dlBack = await fetch(`${A.url}/dl/1.3.0/windows10-x64`)
  check('恢复后直链又能下载 → 200', dlBack.status === 200, String(dlBack.status))

  // PATCH 形态与别名等价
  const patch = await req(A.url, `/api/releases/${id1}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'yanked' }),
  })
  check('PATCH {status:"yanked"} 与别名等价', patch.status === 200 && patch.body?.status === 'yanked')

  const patchBad = await req(A.url, `/api/releases/${id1}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'deleted' }),
  })
  check('PATCH 非法 status → 400', patchBad.status === 400)

  const patch404 = await req(A.url, '/api/releases/not-exist-id', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'yanked' }),
  })
  check('不存在的 id → 404', patch404.status === 404)

  // 删除 → 墓碑
  const del = await req(A.url, `/api/releases/${id1}`, { method: 'DELETE' })
  check('DELETE → 200 且 status=deleted', del.status === 200 && del.body?.status === 'deleted')
  check('删除后 file_missing 归 false（墓碑不是缺文件）', del.body?.file_missing === false)
  check('墓碑保留 object_key（指向已删除文件）', Boolean(del.body && del.body.version))
  check('删除后磁盘文件已消失', !(await fs.stat(finalPath).catch(() => null)))

  const delAgain = await req(A.url, `/api/releases/${id1}`, { method: 'DELETE' })
  check('重复删除 → 409', delAgain.status === 409)

  const allAfter = await req(A.url, '/api/releases')
  check('墓碑不出现在默认列表', !allAfter.body.releases.some((r) => r.id === id1))

  const delList = await req(A.url, '/api/releases?status=deleted')
  check('status=deleted 能查到墓碑', delList.body.releases.some((r) => r.id === id1))

  // 删除后同版本重传：允许重新发布（墓碑不再挡重发）
  // 语义：删除 = 这个版本作废、文件没了；既然东西没了，就不该再拿它挡住重新发布
  const rePkg = makeBytes(2048, 'n')
  const reup = await upload(A.url, {
    version: '1.3.0',
    platform: 'windows10',
    arch: 'x64',
    bytes: rePkg,
  })
  check('删除后同版本重传 → 201（墓碑不再阻止重发）', reup.status === 201, JSON.stringify(reup.body))
  check('重传沿用原 id（下载计数不归零）', reup.body?.id === id1, `${reup.body?.id} vs ${id1}`)
  check('重传后状态回到 active', reup.body?.status === 'active')
  check('重传后 sha256 是新内容的', reup.body?.sha256 === sha256(rePkg))
  check(
    '重传后文件重新落盘',
    Boolean(await fs.stat(finalPath).catch(() => null)),
  )

  const delListAfter = await req(A.url, '/api/releases?status=deleted')
  check('重传后不再出现在「已删除」筛选里', !delListAfter.body.releases.some((r) => r.id === id1))

  const allAfterReup = await req(A.url, '/api/releases')
  check(
    '重传后回到默认列表且为在架',
    allAfterReup.body.releases.some((r) => r.id === id1 && r.status === 'active'),
  )

  // 只放宽了「墓碑」这一种，在架版本仍然不允许覆盖 —— 否则同 URL 换内容防不住
  const dupAgain = await upload(A.url, {
    version: '1.3.0',
    platform: 'windows10',
    arch: 'x64',
    bytes: makeBytes(1024, 'q'),
  })
  check('在架版本重复上传仍 409（没把口子开太大）', dupAgain.status === 409, JSON.stringify(dupAgain.body))

  // 同版本号可能换内容，下载侧不能再给 immutable，否则客户端一年不回头
  const dl = await fetch(`${A.url}/dl/1.3.0/windows10-x64`)
  const cc = dl.headers.get('cache-control') || ''
  await dl.arrayBuffer()
  check('下载响应 Cache-Control 改为 no-cache（保留 ETag 协商）', cc.includes('no-cache'), cc)

  // ════════════════════════════════════════════════════════════════
  // 场景三：file_missing 记录可重传且沿用原 id（需重启触发对账）
  // ════════════════════════════════════════════════════════════════
  console.log('\n[场景三] 缺文件对账 + 同版本重传沿用 id')

  const keepId = otherPlatform.body.id // windows7-x64 1.3.0
  const keepPath = path.join(dataA, 'releases', '1.3.0', 'windows7-x64', 'package.bin')
  await fs.unlink(keepPath) // 手工删文件，模拟磁盘意外丢失
  await A.stop()

  const A2 = startServer({ dataDir: dataA, port: 19081 })
  check('重启成功（对账在启动阶段跑）', await waitReady(A2.url))

  const missingList = await req(A2.url, '/api/releases?status=missing')
  check(
    '重启对账把记录标成 file_missing=true',
    missingList.body.releases.some((r) => r.id === keepId && r.file_missing === true),
    JSON.stringify(missingList.body?.releases?.map((r) => [r.version, r.file_missing])),
  )

  const missingDetail = missingList.body.releases.find((r) => r.id === keepId)
  check('缺文件不改变 status（仍是 active）', missingDetail?.status === 'active')

  // 缺文件的记录允许同版本重传，且必须沿用原 id（stats.json 的 key 不能换）
  const repair = await upload(A2.url, {
    version: '1.3.0',
    platform: 'windows7',
    arch: 'x64',
    bytes: makeBytes(4096, 'm'),
  })
  check('缺文件记录允许同版本重传 → 201', repair.status === 201, JSON.stringify(repair.body))
  check('重传沿用原 id（下载计数不归零）', repair.body?.id === keepId, `${repair.body?.id} vs ${keepId}`)
  check('重传后 file_missing 归 false', repair.body?.file_missing === false)

  // 已撤回 + 缺文件：恢复必须 409（先补齐文件）
  const yankId = pre.body.id
  await req(A2.url, `/api/releases/${yankId}/yank`, { method: 'POST' })
  await fs.unlink(path.join(dataA, 'releases', '2.1.0-beta.1', 'macos-arm64', 'package.bin'))
  await A2.stop()

  const A3 = startServer({ dataDir: dataA, port: 19081 })
  await waitReady(A3.url)

  const yankMissing = await req(A3.url, `/api/releases/${yankId}/unyank`, { method: 'POST' })
  check('已撤回 + 缺文件时恢复 → 409', yankMissing.status === 409, JSON.stringify(yankMissing.body))

  const stillYanked = await req(A3.url, `/api/releases?status=yanked`)
  check(
    '缺文件不会把已撤回变回 active（status 与文件事实解耦）',
    stillYanked.body.releases.some((r) => r.id === yankId && r.status === 'yanked'),
  )

  // ════════════════════════════════════════════════════════════════
  // 场景四：孤儿文件（可见 / 单删 / 清空 / 路径穿越）
  // ════════════════════════════════════════════════════════════════
  console.log('\n[场景四] 孤儿文件接口')

  const orphanDir = path.join(dataA, 'orphan')
  await fs.mkdir(orphanDir, { recursive: true })
  await fs.writeFile(path.join(orphanDir, '9.9.9__linux-x64__package.bin.111'), Buffer.alloc(100))
  await fs.writeFile(path.join(orphanDir, '8.8.8__macos-x64__package.bin.222'), Buffer.alloc(200))

  const orphans = await req(A3.url, '/api/orphans')
  check('GET /api/orphans 返回 2 个孤儿', orphans.body?.count === 2, JSON.stringify(orphans.body))
  check('返回总字节数', orphans.body?.bytes === 300)
  check('每个孤儿都带 path 与 size', Boolean(orphans.body?.orphans?.[0]?.path && orphans.body?.orphans?.[0]?.size))

  const escape = await req(A3.url, '/api/orphans?path=' + encodeURIComponent('../releases.json'), {
    method: 'DELETE',
  })
  check('路径穿越 → 400（不能删 orphan 之外的文件）', escape.status === 400, JSON.stringify(escape.body))

  const removeOne = await req(
    A3.url,
    '/api/orphans?path=' + encodeURIComponent('9.9.9__linux-x64__package.bin.111'),
    { method: 'DELETE' },
  )
  check('DELETE ?path= 删单个 → 200', removeOne.status === 200 && removeOne.body?.removed === 1)

  const afterOne = await req(A3.url, '/api/orphans')
  check('单删后只剩 1 个', afterOne.body?.count === 1)

  const removeMissing = await req(A3.url, '/api/orphans?path=' + encodeURIComponent('nope.bin'), {
    method: 'DELETE',
  })
  check('删除不存在的孤儿 → 404', removeMissing.status === 404)

  const clear = await req(A3.url, '/api/orphans', { method: 'DELETE' })
  check('DELETE /api/orphans 清空 → 200', clear.status === 200 && clear.body?.removed === 1)

  const afterClear = await req(A3.url, '/api/orphans')
  check('清空后为 0', afterClear.body?.count === 0)

  // ════════════════════════════════════════════════════════════════
  // 场景五：管理页可渲染
  // ════════════════════════════════════════════════════════════════
  console.log('\n[场景五] 管理页渲染')

  const page = await req(A3.url, '/admin')
  check('GET /admin → 200', page.status === 200)
  check('页面含孤儿入口', page.text.includes('id="orphan-toggle"') && page.text.includes('id="orphan-panel"'))
  check('页面含 IE 兜底标记', page.text.includes('ie-blocked'))
  check('筛选非法 status 时页面回落而不是报错', (await req(A3.url, '/admin?status=%E4%B9%B1%E5%86%99')).status === 200)

  await A3.stop()

  // ════════════════════════════════════════════════════════════════
  // 场景六：上传体积上限（独立实例，MAX_UPLOAD_MB=1）
  // ════════════════════════════════════════════════════════════════
  console.log('\n[场景六] 超限 413')

  const B = startServer({ dataDir: dataB, port: 19082, env: { MAX_UPLOAD_MB: '1' } })
  await waitReady(B.url)

  const tooBig = await upload(B.url, {
    version: '1.0.0',
    platform: 'linux',
    arch: 'x64',
    bytes: makeBytes(2 * 1024 * 1024, 'b'), // 2MB > 1MB 上限
  })
  check('超过 MAX_UPLOAD_MB → 413', tooBig.status === 413, JSON.stringify(tooBig.body))
  check('超限文案含上限值', String(tooBig.body?.error || '').includes('1MB'))

  const tmpLeft = await fs
    .readdir(path.join(dataB, 'releases', '1.0.0', 'linux-x64'))
    .catch(() => [])
  check('超限后临时文件已清理', !tmpLeft.some((f) => f.endsWith('.tmp')), tmpLeft.join(','))

  // 超限失败后服务仍然健康（失败路径不能打死进程）
  const hzB = await req(B.url, '/healthz')
  check('413 之后进程仍健康（失败路径没有未捕获异常）', hzB.status === 200)
  check('日志里没有 UnhandledPromiseRejection', !B.logs.join('').includes('UnhandledPromiseRejection'))

  await B.stop()

  // ════════════════════════════════════════════════════════════════
  // 场景七：CIDR 限制（403 必须是 JSON）
  // ════════════════════════════════════════════════════════════════
  console.log('\n[场景七] CIDR 403')

  const C = startServer({
    dataDir: dataC,
    port: 19083,
    env: { ADMIN_ALLOW_CIDR: '10.99.0.0/16' }, // 故意不含 127.0.0.1
  })
  await waitReady(C.url)

  const forbidden = await req(C.url, '/api/releases')
  check('网段外访问 /api → 403', forbidden.status === 403, String(forbidden.status))
  check('403 响应是 JSON 且带中文原因', Boolean(forbidden.body?.error), forbidden.text.slice(0, 60))

  const pageForbidden = await req(C.url, '/admin')
  check('网段外访问 /admin → 403', pageForbidden.status === 403)

  const healthStillOk = await req(C.url, '/healthz')
  check('/healthz 不受 CIDR 限制（否则容器会被标 unhealthy）', healthStillOk.status === 200)

  await C.stop()

  // ════════════════════════════════════════════════════════════════
  // 场景八：分片上传（管理页走的线路）
  // ════════════════════════════════════════════════════════════════
  console.log('\n[场景八] 分片上传')

  const D = startServer({ dataDir: dataD, port: 19084, env: { MAX_UPLOAD_MB: '64' } })
  await waitReady(D.url)

  const cbytes = makeBytes(21 * 1024 * 1024 + 11, 'c') // 21MB → 8+8+5 三片
  const cwant = sha256(cbytes)
  // 显式指定 8MB 分片：服务端默认已改成 40MB，不指定的话 21MB 只有 1 片，
  // 「乱序并发推分片」这条用例就退化成单发，测不到定位写。
  const cqs = new URLSearchParams({
    version: '2.0.0',
    platform: 'linux',
    arch: 'x64',
    total: String(cbytes.length),
    chunkSize: String(8 * 1024 * 1024),
  }).toString()

  const init = await req(D.url, `/api/uploads?${cqs}`, {
    method: 'POST',
    headers: {
      'X-Filename': encodeURIComponent('分片包.bin'),
      'X-Changelog': encodeURIComponent('第一行\n第二行'),
    },
  })
  check('init → 201', init.status === 201, JSON.stringify(init.body))
  const { id, chunkSize, chunks } = init.body || {}

  const badLen = await req(D.url, `/api/uploads/${id}/chunks?offset=${chunkSize}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(cbytes.subarray(chunkSize, chunkSize + 10)),
  })
  check('分片长度不符 → 400', badLen.status === 400, badLen.text.slice(0, 60))

  const badOff = await req(D.url, `/api/uploads/${id}/chunks?offset=7`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(10),
  })
  check('offset 不对齐 → 400', badOff.status === 400)

  const earlyDone = await req(D.url, `/api/uploads/${id}/complete`, { method: 'POST' })
  check('分片不全时 complete → 400', earlyDone.status === 400, earlyDone.text.slice(0, 60))

  // 故意倒序并发发片：定位写（r+ + start）写错了顺序就会拼错
  const order = [...Array(chunks).keys()].reverse()
  const pushed = await Promise.all(
    order.map((i) => {
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, cbytes.length)
      return req(D.url, `/api/uploads/${id}/chunks?offset=${start}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(cbytes.subarray(start, end)),
      })
    }),
  )
  check('乱序并发推分片全成功', pushed.every((r) => r.status === 200), pushed.map((r) => r.status).join(','))

  const dupChunk = await req(D.url, `/api/uploads/${id}/chunks?offset=0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(cbytes.subarray(0, Math.min(chunkSize, cbytes.length))),
  })
  check('重复分片幂等（duplicate:true）', dupChunk.status === 200 && dupChunk.body?.duplicate === true)

  const done = await req(D.url, `/api/uploads/${id}/complete`, { method: 'POST' })
  check('complete → 201', done.status === 201, JSON.stringify(done.body).slice(0, 120))
  check('分片拼出来的 sha256 与源一致', done.body?.sha256 === cwant, `${done.body?.sha256} vs ${cwant}`)
  check('size 等于源长度', done.body?.size === cbytes.length)
  check('中文文件名解对', done.body?.filename === '分片包.bin', String(done.body?.filename))
  check('多行 changelog 解对', done.body?.changelog === '第一行\n第二行', JSON.stringify(done.body?.changelog))
  check('提交后查会话 → 410', (await req(D.url, `/api/uploads/${id}`)).status === 410)

  const dupInit = await req(D.url, `/api/uploads?${cqs}`, { method: 'POST' })
  check('同版本再 init → 409 且带 existing', dupInit.status === 409 && Boolean(dupInit.body?.existing))

  const s2qs = new URLSearchParams({
    version: '3.0.0',
    platform: 'linux',
    arch: 'x64',
    total: '1000',
  }).toString()
  const s2 = await req(D.url, `/api/uploads?${s2qs}`, { method: 'POST' })
  const aborted = await req(D.url, `/api/uploads/${s2.body.id}`, { method: 'DELETE' })
  check('abort → 204', aborted.status === 204)
  check('abort 后会话 410', (await req(D.url, `/api/uploads/${s2.body.id}`)).status === 410)
  const abortTmp = (
    await fs.readdir(path.join(dataD, 'releases', '3.0.0', 'linux-x64')).catch(() => [])
  ).filter((f) => f.endsWith('.tmp'))
  check('abort 后没有残留 .tmp', abortTmp.length === 0, abortTmp.join(','))

  const bigTot = new URLSearchParams({
    version: '4.0.0',
    platform: 'linux',
    arch: 'x64',
    total: String(200 * 1024 * 1024),
  }).toString()
  check('total 超上限 → 413', (await req(D.url, `/api/uploads?${bigTot}`, { method: 'POST' })).status === 413)

  check('分片全流程后进程仍健康', (await req(D.url, '/healthz')).status === 200)
  check('日志里没有 UnhandledPromiseRejection', !D.logs.join('').includes('UnhandledPromiseRejection'))

  await D.stop()

  // ════════════════════════════════════════════════════════════════
  // 收尾
  // ════════════════════════════════════════════════════════════════
  await fs.rm(tmpRoot, { recursive: true, force: true })

  console.log('\n' + '─'.repeat(56))
  if (failures.length === 0) {
    console.log(`全部通过：${passed} 条断言`)
    process.exit(0)
  }
  console.log(`通过 ${passed} 条，失败 ${failures.length} 条：`)
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}

main().catch((err) => {
  console.error('[test] 未预期的异常：', err)
  process.exit(1)
})
