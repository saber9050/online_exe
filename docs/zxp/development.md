# 成员 B 开发文档

> 对应方案：`docs/release-platform-design.md`（v3.4）
> 归属：**B（运行时 + 管理页 + 部署）**
> 配套文档：[`api.md`](./api.md)（对外接口契约）

---

## 0. 读之前先对齐两件事

**① 目录结构已与方案 4.2 一致。** 代码全部在 `src/` 下（`catalog/`、`routes/`、`middleware/`、`storage/`），`views/`、`public/`、`fixtures/`、`data/` 仍在项目根。本文所有路径都是**实际路径**，可以直接对照方案 4.2 的目录树。

方案目录树里原本没列、但实现必须有的 4 个文件（已在方案 4.2 补上）：

| 文件 | 为什么需要 |
|---|---|
| `src/constants.js` | 8 组合白名单、平台/架构标签、下载页 OS 分组 |
| `src/format.js` | 展示层格式化（字节数、UTC→本地时间），只喂 EJS locals |
| `src/catalog/orphan.js` | 孤儿文件的枚举/删除 + 路径逃逸防护 |
| `src/storage/local.js` | 存储接口的本地实现；`src/storage/storage.js` 只做门面，换存储改那一行 import |

另外 `src/catalog/types.js` 是纯 JSDoc 类型定义（不参与运行），给编辑器和 `import('./types.js').Release` 用。

**② 我只改自己那半。** 方案 7.8 划死的边界：

| 我负责（别人不动） | A 负责（我不动） |
|---|---|
| `src/config.js`、`src/app.js`、`src/server.js` | `src/routes/index.js`（全部路由挂载） |
| `src/middleware/errors.js` | `src/middleware/cidr.js` |
| `src/routes/dto.js`、`src/routes/upload.js`、`src/routes/releases.js` | `src/catalog/catalog.js`、`src/storage/storage.js`、`src/catalog/persist.js`、`src/catalog/stats.js`、`src/semver.js` |
| `src/routes/pages/admin.js`、`views/admin.ejs`、`public/admin.css`、`public/admin.js` | `src/routes/pages/download.js`、`views/download.ejs`、`views/partials/*`、`public/download.*` |
| `Dockerfile`、`docker-entrypoint.sh`、`.dockerignore` | `fixtures/releases.sample.json` 的维护口径 |

**必须同改**：`src/constants.js`（8 组合白名单）、`package.json`、`package-lock.json`、`public/base.css`。

---

## 1. 交付物清单

| # | 文件 | 行数（约） | 一句话职责 | 出错的后果 |
|---|---|---|---|---|
| 1 | `src/config.js` | 34 | 环境变量装载、派生路径 | 路径错 → 数据写错地方 |
| 2 | `src/app.js` | 34 | Express 实例、中间件顺序、路由挂载点 | 顺序错 → 大上传被打断 / 鉴权漏 |
| 3 | `src/server.js` | 76 | 启动自检、四个超时、IPv4 监听、优雅退出 | 超时没关 → 400MB 必断 |
| 4 | `src/middleware/errors.js` | 30 | 404 + 按 `err.status` 输出统一错误 | 报错格式不统一，前端解析炸 |
| 5 | `src/routes/dto.js` | 29 | 磁盘结构 → HTTP 结构映射 | 磁盘 JSON 被响应格式污染 |
| 6 | `src/routes/upload.js` | 330 | busboy 流式上传、查重、并发、空间预检 | 内存爆 / 进程被未捕获异常打死 |
| 7 | `src/routes/releases.js` | 233 | 列表筛选、撤回/恢复、墓碑、孤儿接口 | 在架版本被覆盖 / 墓碑挡住重发 |
| 8 | `src/catalog/orphan.js` | 126 | 孤儿文件列出/单删/清空 + 路径逃逸防护 | `?path=../` 能把版本库删掉 |
| 9 | `src/routes/pages/admin.js` | 99 | 管理页数据装配 | 状态条数字不对、按钮给错 |
| 10 | `views/admin.ejs` | 188 | 三段式页面骨架 + 孤儿面板 | IE 打开一片空白 |
| 11 | `public/admin.css` | 141 | 管理页样式（不用 CSS 变量 / Grid） | — |
| 12 | `public/admin.js` | 533 | 上传进度、409 自动 +1、行操作、孤儿面板 | 发版人重复填 8 遍表单 |
| 13 | `scripts/test-b.mjs` | 506 | 接口冒烟测试（`npm test`，74 条断言） | 改完不知道有没有弄坏别的 |
| 14 | `Dockerfile` / `docker-entrypoint.sh` / `.dockerignore` | 47 / 62 / 13 | 单容器交付 + 启动时修 `/data` 属主 | 内网起不来 / `EACCES: mkdir '/data/releases'` |

> `src/routes/index.js` 归 A，本次为补齐 `yank`/`unyank`/`orphans` 路由改了 6 行，已同步告知。

**对外的三个承诺**（方案 7.3）：

1. 进程不死——客户端拔网线、写盘失败、并发提交都不能把进程带走
2. 超时正确——400MB 包在 2Mbps 链路上传 27 分钟不中断
3. 错误格式统一——`{ "error": "..." }` + 语义正确的状态码

---

## 2. 我依赖 A 的接口（契约）

这些签名是**我单方面消费**的，A 改了我就崩。方案 7.4 要求阶段 0 冻结，实际冻结口径**以代码为准**（方案里写的 `has/find/add/setStatus` 与现码不一致，见 §10 缺口 5）。

### 2.1 版本索引 `src/catalog/catalog.js`

| 签名 | 返回 | 我在哪用 |
|---|---|---|
| `catalog.get(platform, arch, version)` | `record \| undefined` | 上传查重（同步块内，不能是 async） |
| `catalog.getById(id)` | `record \| null` | 撤回 / 恢复 / 删除 |
| `catalog.list()` | `record[]`（**内部数组引用，别原地改**） | 列表、状态条统计、清理建议 |
| `catalog.apply(record)` | — | 磁盘写成功后更新内存 |
| `catalog.withRecord(record)` | `record[]` 新数组 | 生成落盘快照，不动内存 |
| `catalog.latest(platform, arch)` | `{rel, isPrerelease} \| null` | 管理页不直接用（A 的下载页用），但**别误用** |

**硬约束**：`apply()` 必须在 `writeAtomic()` 成功之后调。顺序反了，写盘失败时内存有记录、磁盘没有，重启后记录消失、文件变孤儿。

### 2.2 文件存储 `src/storage/storage.js`

| 签名 | 用途 |
|---|---|
| `storage.abs(objectKey)` | 墓碑删除文件 |
| `storage.dirFor(v, p, a)` / `storage.finalPath(v, p, a)` | 目标目录与 `package.bin` 绝对路径 |
| `storage.tmpPath(v, p, a)` | **与目标同目录**的唯一临时名（跨文件系统 `rename` 会 EXDEV） |
| `storage.ensureDir(dir)` | 建目录 |
| `storage.remove(objectKey)` | 删文件（内部已 `.catch`，不抛） |
| `storage.freeBytes()` | 空间预检，失败返回 `0` |
| `storage.diskInfo()` | 状态条「磁盘可用 / 总量」 |
| `storage.orphanStats()` | 状态条「孤儿 N 个 / X MB」 |
| `storage.probe()` | `/healthz` 写盘探针 |

### 2.3 落盘队列 `src/catalog/persist.js`

| 签名 | 用途 | 注意 |
|---|---|---|
| `enqueueWrite(fn)` | 所有 JSON 写入串行化 | **必须接住返回值**，`commit` 里要用它拿 `record` |
| `writeAtomic(target, data)` | tmp → fsync → rename → 目录 fsync | 别自己写 `fs.writeFile` |
| `serialize(records)` | `{schema, app, releases}` 快照 | 传入数组，不是单条 |
| `flush()` | `await writeQueue` | 优雅退出用，别在 shutdown 里再发起一次写 |

### 2.4 其他

| 模块 | 签名 | 用途 |
|---|---|---|
| `src/catalog/stats.js` | `stats.get(id)` / `stats.flush()` / `stats.stop()` | 列表行下载数、退出前落盘 |
| `src/semver.js` | `parseVersion(raw)` → `{version, major, minor, patch, prerelease, is_prerelease}` \| `null` | 上传入口校验 + 归一化（内部已剥 `v`） |
| `src/semver.js` | `compareVersion(a, b)` | 列表排序、清理建议 |
| `src/constants.js` | `PLATFORM_ARCH_SET` / `PLATFORM_GROUPS` / `platformLabel` / `archLabel` / `comboLabel` | 白名单校验 + 中文展示 |
| `src/middleware/cidr.js` | `adminGuard` | 我不用，但**依赖它挂在 `/api` 上** |
| `src/server.js` | `initStore()`（模块内私有） | 启动第 0 步。**目录迁移后它从 `lib/store.js` 搬进了 `server.js`**，成了我的文件，但实现仍是调 A 的四个函数：`ensureDirs → loadReleases → cleanupTmp → reconcile`，末尾再 `stats.load()` |

启动自检的五步顺序（写错就会出现「空目录起不来」或「孤儿文件被当成正常版本」）：

```text
ensureDirs()      建 data/、data/releases/、data/orphan/
loadReleases()    三态加载：不存在 → 空结构；JSON 语法错 → 拒绝启动；缺字段 → 补默认
catalog.load()    内存索引换掉
cleanupTmp()      递归删 **/*.tmp
reconcile()       孤儿移走、缺文件标 file_missing（跳过墓碑）
stats.load()      装载 stats.json，下载计数接着算
```

---

## 3. 运行时三件套

### 3.1 `src/config.js`

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | host 网络下由应用自己监听 |
| `DATA_DIR` | `<root>/data` | 容器内固定 `/data` |
| `MAX_UPLOAD_MB` | `800` | → busboy `limits.fileSize` |
| `KEEP_PER_PLATFORM` | `5` | 清理建议口径，只提示不自动删 |
| `APP_NAME` | `llm-wiki` | 仅首次初始化 `releases.json` 时写入 app 段；产品改名后统一在这里改默认值或传环境变量 |
| `APP_DESCRIPTION` | `客户端` | 顶部导航副标题 |
| `TZ` | `Asia/Shanghai` | 页面渲染与日志 |
| `ADMIN_ALLOW_CIDR` | 空 | **支持逗号分隔多网段**；空 = 不限制 |
| `STATS_FLUSH_SEC` | `30` | 下载计数落盘间隔 |

路径一律从 `import.meta.dirname` 派生，**不用 `process.cwd()`**：ESM 里没有 `__dirname`，而 `cwd` 在 `docker exec`、systemd、换工作目录时会变，表现为静态资源静默 404。

目录迁移到 `src/` 后这里有个小坑——`config.js` 在 `src/` 下，项目根是**上一级**：

```js
const root = path.join(import.meta.dirname, '..')   // 少这一级，views/ 和 public/ 全会 404
```

### 3.2 `src/app.js`：中间件顺序不能动

```text
1. app.set('view engine' / 'views')      ← 用 config 的绝对路径
2. app.locals: cfg / fmtSize / fmtDate   ← EJS 里直接用，模板不写格式化逻辑
3. express.static(publicDir)             ← 默认 ETag + 协商缓存，不设长缓存
4. express.json({ limit: '1mb' })        ← 只服务 PATCH 的小 body
5. adminGuard  挂 /admin 和 /api          ← 下载页 /dl 与 /healthz 不受限
6. router                                 ← A 的路由表
7. notFound → errorHandler
```

四个顺序要点：

| # | 点 | 原因 |
|---|---|---|
| 1 | `static` 放最前 | 静态文件不经过 CIDR 与 body 解析；`public/` 无敏感数据 |
| 2 | **绝不给 `/api/releases` 加任何 body parser** | `express.json` 只看 `Content-Type: application/json`，multipart 不会被它读进来。但一旦有人为了「方便」加 `express.raw`/`urlencoded`，400MB 会整包进内存 |
| 3 | `adminGuard` 在 `router` 之前 | 先拦来源，再进业务；`/api` 整段受保护，包括 `GET /api/releases` |
| 4 | `notFound` 在 `router` 之后、`errorHandler` 最后 | Express 5 里同步抛错也能到错误中间件，但顺序反了会吞异常 |

`/healthz` **不能**挂 `adminGuard`——Docker 探针从 `127.0.0.1` 打进来，网段限制一开就会把容器标成 unhealthy，表现为「服务没挂但一直重启」。

### 3.3 `src/server.js`：四个超时（最大坑）

| 参数 | Node 默认 | 必须 | 不改的后果 |
|---|---|---|---|
| `requestTimeout` | 300000 | **`0`** | 400MB 在 2Mbps 链路要 27 分钟，408 掐断，报错只说 `request timeout` |
| `headersTimeout` | 60000 | `60000`（保持） | 与上传无关，**不要改成 66000** |
| `keepAliveTimeout` | 5000 | `65000` | 默认太短，客户端连接池复用到已关 socket，偶发 `ECONNRESET` |
| `timeout` | 0 | `0`（保持） | 设了会断长传输 |

两条容易被「优化」掉的真相：

- Node 的唯一强约束是 **`headersTimeout ≤ requestTimeout`（两者都 > 0 时校验）**，违反直接抛 `ERR_OUT_OF_RANGE`、进程起不来。`requestTimeout = 0` 后这个校验直接跳过，所以 60000 / 65000 这组值不会冲突。所谓「`headersTimeout` 必须大于 `keepAliveTimeout`」在源码里不存在。
- `requestTimeout = 0` 不等于裸奔：体积靠 busboy `limits.fileSize`，空闲连接靠 `keepAliveTimeout`。

监听必须写 `server.listen(cfg.port, '0.0.0.0')`。双栈下 IPv4 客户端的 `remoteAddress` 会变成 `::ffff:10.20.3.51`，CIDR 一个都匹配不上，管理页全 403，而日志里地址看着完全正常。

### 3.4 优雅退出时序

```text
SIGTERM
  ├─ server.close()                    不再接新连接，已有连接继续
  ├─ 轮询 inflight ≤ 30s               每 200ms 查一次，等上传自己收尾
  ├─ stats.stop() + await stats.flush() 计数落盘
  ├─ await flush()                    = await writeQueue，排空待写 JSON
  ├─ server.closeAllConnections()      收掉残留 keep-alive
  └─ process.exit(0)
```

| 约束 | 值 | 关系 |
|---|---|---|
| 等 inflight 上限 | 30s | 代码里写死 |
| `stop_grace_period` | 45s | **必须 > 30s**，否则 Docker 在我们还在等的时候 SIGKILL |

**别在 `shutdown` 里直接 `process.exit()`**，也不要在里面再发起一次 `writeAtomic`——前者跳过 flush，后者会和串行队列打架。`flush()` 的语义就是「等队尾」，写别的形态等于把串行化拆了。

`process.on('unhandledRejection')` 只打日志不退出，这是**兜底不是保护**：真出现未捕获 rejection，说明 `upload.js` 里有 promise 没挂 `.catch`，去修那里。

---

## 4. 错误与 DTO

### 4.1 `src/middleware/errors.js`

| 处理器 | 行为 |
|---|---|
| `notFound` | `404` + 纯文本 `not found` |
| `errorHandler(err, req, res, next)` | `status = err.status ?? 500` → 5xx 打完整日志并只回「服务器内部错误」，4xx 回 `err.message` → `headersSent` 时 **`res.destroy()`** |

`err.status` 这一条是业务层偷懒的正道：`src/catalog/orphan.js` 里 `throw httpError(400, '路径非法')`，handler 只写 `next(e)`，不用每处都 `res.status(x).json()`。5xx 永远不把内部信息吐出去，细节留在日志里。

`headersSent` 分支必须 `destroy()`。写成「什么都不做」的话，传输中途出错时连接会挂在那里等 `keepAliveTimeout`，用户侧表现为「下载卡死」。

### 4.2 `src/routes/dto.js`：磁盘结构 ≠ 响应结构

`toReleaseDto(rec)` 输出 22 个字段（见 `api.md` §8）。三条纪律：

1. **不许与磁盘对象共用引用**，必须是新对象（现在就是 `return { ... }` 全量重建）
2. 派生字段（`platformLabel` / `archLabel` / `comboLabel` / `download_url`）只在这里出现，**永不写进 `releases.json`**
3. **A 的 `src/routes/pages/download.js` 不许 import 这个文件**（方案 7.5 的硬边界）。一旦 A 拿 DTO 渲染下载页，我改个字段名就会静默弄坏他的页面

`GET /api/releases` 在 DTO 之上再叠一个 `downloads`，这个字段**只出现在列表响应**，上传 201 响应里没有。

---

## 5. 上传 `src/routes/upload.js`

### 5.1 请求形状与「为什么元数据走 query」

```text
POST /api/releases?version=1.3.0&platform=windows10&arch=x64
Content-Type: multipart/form-data
  file      二进制
  changelog 文本（可选）
```

multipart 的 part **按客户端发送顺序到达**。`file` 先到时，服务端还不知道 `version/platform/arch`，就没法算唯一键、没法查重、没法定临时文件路径——只能先把 400MB 丢进随机临时文件等着。query string 在请求行里，**一定先于 body 到达**，所以「校验 → 查重 → 占位 → 空间预检」全部能在收第一个字节之前完成。

`changelog` 留在 multipart，因为它可能很长（URL 8KB 限制），且晚到无所谓。

### 5.2 状态机

```text
receiving ──bb.close──→ committing ──成功──→ done
   │                        │
   └────abort()─────────────┴──→ aborted
```

| 事件 | 触发 | 动作 |
|---|---|---|
| `state !== 'receiving'` | 任何 `abort()` 入口 | **直接 return**（防重入，只清理一次） |
| `bb.on('close')` | 请求体读完 | 置 `committing` → `void commit()` |
| `commit` 成功 | — | 置 `done` → `201` |
| `commit` 失败 | — | 置 `aborted` → `cleanup()` → 错误码 |

**`bb.on('close')` ≠ 文件写完。** 它只表示「请求体读完了」，`pipeline` 的落盘还在跑。直接在 close 里提交会出现「JSON 有记录、`package.bin` 是半截」——小文件测试根本发现不了。

### 5.3 十步流程

| 步 | 动作 | 关键点 |
|---|---|---|
| 1 | `parseVersion(query.version)` + 白名单校验 | 不需要读 body；`parseVersion` 内部已剥 `v` |
| 2 | **同步块**：`catalog.get` 查重（判据 `isVersionTaken()`，见 §6.3）→ `inflight.has` → `inflight.set` | 中间不能有 `await`，否则不原子 |
| 3 | `freeBytes()`（5s 缓存）+ `tryReserve(Content-Length)` | 可用 − 已预留 < `1.1 × CL` → `507` |
| 4 | `storage.ensureDir()` | 失败 → 释放占位 + 额度 |
| 5 | 建 busboy，挂 8 个事件 | 见 §5.5 |
| 6 | `pipeline(stream, tap, writeStream)` | `tap` 里算 sha256 |
| 7 | 临时文件 `fsync` + 读实际字节数 | 只 rename 不 fsync，断电后「文件在、内容截断」 |
| 8 | 失败 → 删 tmp、删 inflight、还额度 | 三件事都要做 |
| 9 | `enqueueWrite`：再次查重 → `rename` → 写 JSON → `apply` | **顺序不能反**；写 JSON 失败要 `unlink` 回滚 |
| 10 | `201 + toReleaseDto(rec)` | `rec` 必须从 `enqueueWrite` 的返回值拿 |

### 5.4 并发三道闸

| 闸 | 解决什么 | 实现 |
|---|---|---|
| ① 同步查重 + `inflight` | 同 key 两个请求同时开始 | 整段同步执行，Node 单线程天然原子 |
| ② `reservedBytes` 累加器 | 单次预检的 TOCTOU：8 个请求都看到「够」，一起写然后集体 ENOSPC | 预检看「实际可用 − 别人已预留」 |
| ③ `enqueueWrite` | `inflight` 被超时误清后，两个提交同时 rename 覆盖 | 「再次查重 + rename + 写 JSON + 内存」整段串行 |

三个数字要记住：

- 空间系数 **1.1**，不是 2。`rename` 只改目录项不复制数据，峰值就是一份。按 2 倍算等于白扔一半磁盘预算
- `inflight` 超时兜底 **30 分钟**，`setInterval` 每 5 分钟扫一次（客户端拔网线跑路时靠它，别指望人肉重启）
- `freeBytes` 缓存 **5 秒**，省掉并发时几百次 `statfs`

**额度必须在三处都还**：`abort()` 里、`commit()` 的 `finally` 里、建目录失败处。漏一处 `reservedBytes` 就单调递增，最终**所有上传都 507**，而且日志里看不出来。

### 5.5 busboy 事件表

| 事件 | 必须处理 | 不处理的后果 |
|---|---|---|
| `bb.on('file')` | 建 tmp、push promise | — |
| `bb.on('field')` | 收 `changelog` | 更新说明丢失 |
| `bb.on('filesLimit')` | `abort(400)` | 传两个文件静默只存第一个 |
| `bb.on('fieldsLimit')` | `abort(400)` | 异常请求没边界 |
| `bb.on('error')` | `abort(400)` | 解析失败时请求挂死 |
| `req.on('error')` | `abort(400)` | 同上 |
| `req.on('close')` + `!req.complete` | `abort(499)` | 客户端断开后 tmp 残留 |

构造参数四个都不能省：

```js
Busboy({
  headers: req.headers,
  defParamCharset: 'utf8',   // 默认 latin1，中文 filename 直接乱码
  limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1, fields: 10, fieldSize: 64 * 1024 },
})
```

`limits.fields` 默认是 `Infinity`，不设它 `fieldsLimit` 监听就是死代码。

**五条禁止写法**：

| # | 禁止 | 原因 |
|---|---|---|
| 1 | `bb.on('file', async (…) => {})` | busboy 不等 async 函数，reject 没人接；必须自己把 promise push 进数组 |
| 2 | `stream.on('data', c => hash.update(c))` | 切 flowing 模式，与 `pipeline` 抢数据源，文件写不全 / 哈希对不上 |
| 3 | 自己写 `ws.write(chunk)` | 丢背压，内存暴涨 |
| 4 | 固定临时文件名 | 并发互相覆盖，写出半个包但 sha256 记的是另一次 |
| 5 | 临时文件放 `/tmp` | 跨文件系统 `rename` → `EXDEV`，原子提交的前提没了 |

**失败路径的 promise 必须当场 `.catch`。** 这是本项目最容易漏、后果最重的一条：`abort()` 路径根本不走 `commit()`，`tasks` 里的 promise 没人 await，而 `pipeline` 在客户端断开时会 reject——Node 15+ 默认 `--unhandled-rejections=throw`，**整个进程退出**。不是这一个上传失败，是全部在传的上传一起废掉。所以现在的写法是：

```js
tasks.push((async () => { … })().catch((err) => { taskErrors.push(err); …; return null }))
```

### 5.6 失败路径清理对照

| 场景 | 删 tmp | 删 inflight | 还额度 | HTTP |
|---|---|---|---|---|
| 版本号 / 白名单不合法 | 无 tmp | 未占位 | 未预留 | 400 |
| 同版本已存在 | 无 tmp | 不设 | 不预留 | 409 |
| 同 key 正在上传 | 无 tmp | 不设 | 不预留 | 409 |
| 空间不足 | 无 tmp | ✅ | 未预留 | 507 |
| 建目录失败 | — | ✅ | ✅ | 500 |
| 无 `file` part | — | ✅（finally） | ✅ | 400 |
| 超 `MAX_UPLOAD_MB` | ✅（abort 前等 pipeline） | ✅ | ✅ | 413 |
| 客户端断开 | ✅ | ✅ | ✅ | 499 |
| 写盘失败 | ✅ | ✅ | ✅ | 500 |
| 写 JSON 失败 | rename 后的文件要 `unlink` | ✅ | ✅ | 500 |

### 5.7 错误码映射集中一处

```js
{ DUPLICATE: 409, NO_FILE: 400, FILE_TOO_LARGE: 413 }[err.message] ?? 500
```

不要在状态码上写三元套三元。`DUPLICATE` 有两个来源：入口同步查重（带 `existing` DTO）和队列内再次查重（不带），前端按 `existing` 是否存在决定要不要自动 +1。

### 5.8 联调命令（PowerShell）

> PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，**必须写 `curl.exe`**；续行用反引号，不是 `\`。

```powershell
# 正常上传（元数据在 query，changelog 在 multipart）
curl.exe -X POST "http://127.0.0.1:8080/api/releases?version=1.3.0&platform=windows10&arch=x64" `
  -F "changelog=fix login crash" `
  -F "file=@F:/tmp/pkg/CoreRunner-1.3.0-win10-x64.exe"

# 重复上传 → 409
curl.exe -i -X POST "http://127.0.0.1:8080/api/releases?version=1.3.0&platform=windows10&arch=x64" `
  -F "file=@F:/tmp/pkg/CoreRunner-1.3.0-win10-x64.exe"

# 并发同一版本 → 一个 201 一个 409
$jobs = 1..2 | ForEach-Object {
  Start-Job { curl.exe -s -o NUL -w '%{http_code}' -X POST `
    "http://127.0.0.1:8080/api/releases?version=1.4.0&platform=linux&arch=x64" `
    -F "file=@F:/tmp/pkg/big.bin" }
}
($jobs | Wait-Job | Receive-Job) -join ','; $jobs | Remove-Job

# 一次传两个文件 → 400
curl.exe -i -X POST "http://127.0.0.1:8080/api/releases?version=1.4.1&platform=linux&arch=x64" `
  -F "file=@F:/tmp/pkg/a.bin" -F "file=@F:/tmp/pkg/b.bin"

# 上传中断后进程必须还活着
$j = Start-Job { curl.exe --limit-rate 1M -X POST `
  "http://127.0.0.1:8080/api/releases?version=9.9.9&platform=linux&arch=x64" `
  -F "file=@F:/tmp/pkg/big.bin" }
Start-Sleep -Seconds 2; Stop-Job $j; Remove-Job $j -Force
curl.exe -s -o NUL -w 'healthz=%{http_code}' http://127.0.0.1:8080/healthz
```

排查 tmp 残留：

```powershell
Get-ChildItem -Recurse F:\tmp\oe-test\releases -Filter *.tmp
```

正常情况下一份都不该有——有就是失败路径漏了清理。

---

## 6. 版本管理 `src/routes/releases.js`

### 6.1 列表筛选矩阵

| `status` 参数 | 过滤条件 | 备注 |
|---|---|---|
| `all`（默认） | `status !== 'deleted'` | 墓碑默认不显示 |
| `stable` | `status === 'active' && !is_prerelease` | |
| `prerelease` | `status === 'active' && is_prerelease` | |
| `yanked` | `status === 'yanked'` | |
| `missing` | `status !== 'deleted' && file_missing` | 与撤回正交 |
| `deleted` | `status === 'deleted'` | 墓碑区 |

`platform` 参数：`all` 或 4 个平台 id 之一。

`status` 走白名单查表：非法值在接口层返回 400（文案会列出可选值），页面层回落成 `all`。别再用 if/else 链——链式写法对未知值落不进任何分支，等于完全不过滤，会把墓碑一起吐出去。

### 6.2 撤回 / 恢复

| 动作 | 前置 | 写入 | 失败码 |
|---|---|---|---|
| 撤回 | `active` | `status='yanked'` | 记录不存在/已删除 → 404 |
| 恢复 | `yanked` 且 `!file_missing` | `status='active'` | `file_missing` → 409「请先重新上传」 |

撤回是可逆操作，前端单击即可；不要加二次确认，加了反而让人懒得用。

### 6.3 删除是墓碑

```js
await storage.remove(rel.object_key)                      // 只删文件
record = { ...rel, status: 'deleted', file_missing: false } // 记录留着，file_missing 归零
await writeAtomic(cfg.jsonPath, serialize(catalog.withRecord(record)))
catalog.apply(record)
```

三条必须有：

1. **`object_key` 保留**，不要置空——置空后查不出「这条记录当初存在哪个路径」
2. **`file_missing = false`**：墓碑不是「文件意外丢失」，是「文件被主动删除」
3. **对账必须跳过 `status === 'deleted'`**（A 的 `persist.reconcile`）。否则重启对账发现「记录在、文件没了」，会给墓碑打上 `file_missing = true` 红标，管理页看着像丢文件事故

**墓碑不阻止重新发布。** 删除的语义是「这个版本作废、东西没了」；既然文件已经删了，就不该再用「已存在」拦住重传同一个版本号。查重判据统一在 `isVersionTaken()`：

```js
function isVersionTaken(rec) {
  if (!rec) return false
  if (rec.file_missing === true) return false   // 记录在、文件没了 → 补传
  if (rec.status === 'deleted') return false    // 墓碑 → 删掉重发
  return true                                   // active / yanked → 409
}
```

入口查重和队列内二次查重**必须调同一个函数**，写两份必然漂移。

代价与配套：同一个 `/dl/{version}/{combo}` 在不同时间可能对应不同内容，所以下载响应不能再设 `Cache-Control: immutable`，改成 `no-cache` + ETag（内容没变就 304）。这条在 A 的 `src/routes/download.js` 里。

### 6.4 状态 × 文件事实 → 按钮矩阵

| `status` | `file_missing` | 按钮 | 服务端兜底 |
|---|---|---|---|
| `active` | false | 撤回 / 删除 | 正常 |
| `active` | true | 重新上传 / 删除 | **不允许撤回**（文件都没了） |
| `yanked` | false | 恢复 / 删除 | 正常 |
| `yanked` | true | 重新上传 / ~~恢复~~ / 删除 | 恢复 → 409 |
| `deleted` | false | 无 | 删除 → 409，撤回/恢复 → 404 |

这张表是**两个维度**，不要压成一个 `status`。`file_missing` 只由对账改，业务代码只在「删除」和「重传」两处显式置值。

---

## 7. 管理页

### 7.1 `src/routes/pages/admin.js` 的职责

只做**数据装配**，不做渲染决策。四块输出：

| 变量 | 形状 | 计算口径 |
|---|---|---|
| `summary.totalVersions` | number | **排除 `deleted`**，否则删完数字不动，用户以为没删掉 |
| `summary.occupied` | bytes | 排除 `deleted`，且 `file_missing` 计 0 |
| `summary.free` / `total` | bytes | `storage.diskInfo()`，失败降级 0 |
| `summary.orphan` | `{count, bytes}` | `storage.orphanStats()` |
| `rows` | DTO + `downloads` | 按 `compareVersion` 降序，同版本按 `uploaded_at` 降序 |
| `coverage` | `[{version, platform, arch}]` | 只算 `active && !file_missing`，前端按版本号分组算 5/8 |
| `suggestions` | `[{combo, keep, extra[], bytes}]` | 每个 `platform-arch` 除最近 `KEEP_PER_PLATFORM` 个之外的旧包，**只列不删** |
| `groups` / `maxUploadMb` / `keepPerPlatform` | — | 表单与提示文案 |

`suggestions` 的口径是 **8 个组合**，不是 4 个 OS。按 OS 归并会把「Win7 x64 有 6 个版本」和「Win7 ia32 只有 1 个」混在一起，结论就错了。

### 7.2 模板变量契约

`views/admin.ejs` 收到的字段（阶段 0 冻结项，改字段要通知 A）：

```text
title, page='admin', pageCss='admin', pageScript='admin',
status, platform,
summary: { totalVersions, occupied, free, total, orphan: { count, bytes } },
rows: ReleaseDto[] & { downloads },
coverage: [{ version, platform, arch }],
suggestions: [{ combo, keep, extra: [{version,size,uploaded_at}], bytes }],
groups: PlatformGroup[],
maxUploadMb, keepPerPlatform
```

在模板里额外注入两个全局量给前端脚本用：

```html
<script>
  window.__PLATFORMS__ = [...];  // id / label / arches
  window.__COVERAGE__  = [...];  // 覆盖度
</script>
```

### 7.3 三段式

| 区 | 内容 | 硬要求 |
|---|---|---|
| ① 状态条 | 磁盘可用/总量、版本总数、占用合计、孤儿 N 个 / X MB | 常驻顶部，不用滚到底才发现盘满 |
| ② 上传区 | 版本号 / 平台 / 架构 / 更新说明 + 拖拽 + 进度条 | 平台 8 组合下拉；Win7 与 Win10 是两个独立选项 |
| ③ 列表区 | 版本、平台、架构、大小、时间、状态、下载数、操作 | 操作按钮按 §6.4 矩阵给，不给所有行同一套 |

### 7.4 `public/admin.js` 行为清单

| # | 行为 | 实现要点 |
|---|---|---|
| 1 | 表单记忆 | `sessionStorage['online-exe-upload']`，一次发版连传 8 个包不用重填 |
| 2 | 架构联动 | 切平台重建架构下拉，非法组合不可能选中 |
| 3 | 渠道只读回显 | 版本号带 `-` 就显示「预发布 Beta」，**不设渠道下拉** |
| 4 | 覆盖度实时算 | 用注入的 `__COVERAGE__` 算 `已覆盖 N/8`，只提示不阻止提交 |
| 5 | 进度与速率 | `xhr.upload.onprogress`，显示 `% · 已传/总量 · 速率` |
| 6 | 409 自动 +1 | 读 `data.existing.version`，`bumpPatch` 到 `1.3.1` |
| 7 | 成功高亮 | `sessionStorage['online-exe-flash']` 存 id，重载后给该行加 3 秒高亮 |
| 8 | 重新上传预填 | `data-action="reupload"` 把版本/平台/架构写回表单并滚到上传区 |
| 9 | 删除二次确认 | `window.confirm` 弹框，文案含「版本（平台 · 架构）+ 不可恢复 + 版本号作废 + 提示改用撤回」；**不再要求手打版本号** |
| 10 | **前端筛选（不提交表单）** | select `change` / 「筛选」按钮提交都 `preventDefault`，改为遍历 `tr[data-*]` 切 `.row-hidden`；URL 用 `history.replaceState` 同步，刷新或分享链接时服务端仍按参数渲染 |
| 11 | 孤儿面板 | 点「查看」才 `GET /api/orphans`（懒加载），逐行删除二次确认，全部清理后整页刷新；列表用 `textContent` 渲染，文件名绝不当 HTML 拼 |
| 12 | **行内更新（不整页刷新）** | 撤回/恢复只改这一行：徽章 `innerHTML`、撤回↔恢复按钮互换 `data-action` 与文字、`flashRow` 闪 3 秒；删除只摘掉 `<tr>` 并同步状态条（版本总数 −1、占用按 `data-bytes` 减 `data-size`） |
| 13 | 不匹配筛选的行保留 | 撤回后若当前筛选是「正式/预发布」，行加 `.row-stale` 淡化 + `title` 说明「切换筛选后不再显示」，**不立刻删行**——否则用户点完就看不见结果 |

> 10/12/13 三条解决的是同一类问题：**列表区的任何操作都不该引起整页刷新**。
> 刷新会重置滚动位置，列表变短时纵向滚动条消失还会让整表横向重排，两件事叠起来就是肉眼可见的「抖动」。
>
> 所以服务端 `renderAdmin` **不再按筛选裁行**：`rows` 一次给全量（含墓碑），同时算出 `visibleIds` 让模板给不匹配的行打 `row-hidden`（首屏和刷新后与服务端口径一致，也不会闪一下再隐藏）。
> 只有**上传成功**仍整页刷新（新行要插进正确的排序位置，交给服务端重排最稳）。

**前端不许做的三件事**：

1. 不拼绝对 URL（`http://IP:8080/...`）——内网多网卡、IP 会变，一律相对路径
2. 不把文件读进内存（`FileReader`）——上传直接交 `FormData`，让浏览器流式发
3. 不给 `admin.js` / `admin.css` 加长缓存——文件名无指纹，改了样式用户会一直拿旧的

### 7.5 IE 兜底

管理页不要求兼容 IE11，但必须给提示，否则发版人误用 IE 会看到一片空白，第一反应是「服务挂了」。

方案是**打标记 + CSS 隐藏**（`<head>` 里中止渲染做不到）：

```html
<html class="js-ok">
<head><script>if (!window.Promise || !window.fetch) { document.documentElement.className = 'ie-blocked' }</script></head>
```

```css
.ie-tip { display: none }
.ie-blocked .app { display: none }
.ie-blocked .ie-tip { display: block }
```

脚本必须**内联、同步、在所有资源之前**。检测 `Promise` + `fetch` 两个就够了，不要去 feature-detect ES2020 语法——那些检测不出来。

这段内联脚本在 `views/partials/head.ejs` 里，按 `page === 'admin'` 条件输出。`partials/` 归 A，改这里要通知。

---

## 8. 部署

### 8.1 Dockerfile 逐条理由

| 行 | 理由 |
|---|---|
| `ARG NODE_IMAGE` + `FROM ${NODE_IMAGE}` | 默认指向 `docker.m.daocloud.io/library/node:24-alpine`（Docker Hub 国内代理）。构建机**不需要**预配 `daemon.json` 就能拉；要换官方或自有加速用 `--build-arg` |
| `sed -i 's#dl-cdn…#mirrors.aliyun.com#g'` | Alpine 官方 CDN 在国内常年几十 KB/s，不换源 `apk add` 会卡几分钟 |
| `apk add tzdata` | alpine 默认**没有时区文件**，不装 `TZ=Asia/Shanghai` 无效，页面差 8 小时 |
| `apk add su-exec` | 入口脚本从 root 降回 node 用它，比 `gosu` 小一个数量级，alpine 官方源直接装 |
| 先 `COPY package*.json` 再 `npm ci --omit=dev` | 只改代码时复用依赖层，构建 2 分钟 → 5 秒 |
| `npm ci --registry=https://registry.npmmirror.com` | 国内装 npm 依赖也慢；用 `--build-arg NPM_REGISTRY=` 可切公司私服（npm 会把 lock 里的 npmjs 主机名替换成配置的 registry） |
| `npm ci` 不是 `install` | 严格按 lock 装，可复现；`install` 可能偷升次版本 |
| `--omit=dev` | nodemon 不进镜像（所以容器里 `npm run dev` 必然失败，这是预期） |
| **不写 `USER node`** + `ENTRYPOINT docker-entrypoint.sh` | 见下方「为什么入口脚本要在 root 下起」 |
| `HEALTHCHECK` 用 `node -e fetch` | alpine 的 busybox wget 能用但参数坑多，node 自带 fetch 更稳 |
| 不用多阶段构建 | 纯 JS 无编译产物，多阶段只是多一层 `node_modules` 复制 |

**为什么入口脚本要在 root 下起**

镜像里 `USER node` 是对的（业务进程不该是 root），但它和 `-v 宿主目录:/data` 天然冲突：挂载点的属主由**宿主机**决定，宿主机只要没 `chown 1000:1000`，容器内 uid 1000 就写不了，启动直接：

```
[startup] 启动失败：
EACCES: permission denied, mkdir '/data/releases'
```

这类错误的责任在部署命令，不在代码，但让部署者对着 `EACCES` 猜代价太高。于是改成：

```
root 进入 → 测 /data 对 uid 1000 是否可写
  ├─ 可写            → su-exec 1000:1000 直接执行（不扫目录，快路径）
  ├─ 不可写、chown 成功 → 改完再降权
  └─ chown 也失败     → 告警后以 root 跑（Windows 盘 / NFS / 只读挂载走这条）
```

权限模型没有放松：**业务进程仍然不是 root**，只有入口脚本那一瞬间是。`docker exec -u 1000` 进去看到的照样是 node 用户。

> 第三档（退回 root）是刻意的取舍：容器起不来 → 服务完全不可用；带告警跑起来 → 至少能用，日志里也留了怎么修。真要严格非 root，就在 `docker run` 加 `--user 1000:1000`，此时入口脚本第一行判断 `id -u != 0` 会直接透传，不尝试 chown。

> 三个网络源（镜像站 / apk / npm）都写死在 Dockerfile 里，是刻意的：构建机往往是临时机器，
> 让人先改 `daemon.json` 再构建，等于把「能不能构建」这件事托付给环境配置。宁可默认国内、用 build-arg 回退。

`.dockerignore` 必须含 `data/`、`node_modules/`、`.git/`、`docs/`、`*.md`。`node_modules` 最要紧——本地依赖会覆盖镜像里 `npm ci` 装好的那份，而本地可能少装生产依赖。`data/` 不排掉等于把开发机的版本包打进镜像。

### 8.2 `docker run` 六个关键参数

仓库里**不放 `docker-compose.yml`**，部署只有一条 `docker run`。原因很实际：`docker save` 只搬镜像，compose 文件本来就不会跟着 tar 走，服务器上十有八九没有它；与其维护两套（compose 和 run）还容易漂移，不如只留一套。下面这张表就是那一条长命令的逐项理由：

| 参数 | 值 | 为什么 |
|---|---|---|
| `--network host` | — | bridge + `-p` 在部分环境下把源 IP 换成 docker 网关，`ADMIN_ALLOW_CIDR` 与 `uploaded_ip` 同时失真。这俩是本方案仅有的两道「谁能操作 / 谁传的」防线 |
| `--stop-timeout 45` | `45`（秒） | 必须 > shutdown 里等 inflight 的 30s，Docker 默认只等 10s 就 SIGKILL |
| `-v /srv/online_exe/data:/data` | — | 不挂卷 = `docker rm` 后版本全丢 |
| `--restart unless-stopped` | — | 宿主机重启后自动拉起 |
| `--log-driver json-file --log-opt max-size=20m --log-opt max-file=3` | — | 容器日志默认无限增长，几个月能把盘写满——「莫名其妙磁盘满了」的常见来源 |
| `-e ADMIN_ALLOW_CIDR=…` | 实例网段 | **必须包含构建机网段**，否则 CI 上传被自己挡成 403；本地 WSL 调试一般填 `172.24.0.0/16` |

host 模式的代价：`-p` 映射失效（应用自己 `listen(8080)`）、8080 被占就起不来、隔离性下降、Docker Desktop 上半残。部署目标是 Linux 服务器，都无所谓。

升级做法：`docker rm -f online-exe`，再用新 tag 跑同一条 `docker run`。数据在卷里，版本记录和包都不丢（也就没有 compose 那种「改 `IMAGE_TAG` 再 `up -d`」的便利，代价换来的是不用在服务器上放仓库文件）。

### 8.3 离线导入流程

**构建机（PowerShell 也能跑，有外网的那台）**

```powershell
docker build -t online-exe:1.0.0 .
docker save online-exe:1.0.0 -o online-exe-1.0.0.tar
Get-Item online-exe-1.0.0.tar | Select-Object Name, Length
```

**内网服务器（Linux，这一步必须是 sh）**

```bash
docker load -i online-exe-1.0.0.tar
mkdir -p /srv/online_exe/data
```

`chown` 不是必须的：入口脚本会以 root 进来先试写、不行再 `chown -R 1000:1000 /data` 然后降权。手动做的好处是省掉一次启动时的目录扫描。

> **Windows 盘别当数据目录**。`/mnt/c`、`/mnt/f` 这类 9p/drvfs 挂载点上 `chown` 不生效（权限由 Windows ACL 决定），入口脚本会打「chown 失败 → 改用 root 运行」。要修就换命名卷 `-v online_exe_data:/data`，或把目录放到 WSL 的 ext4（`~/online_exe-data`）。

启动就一条命令（仓库里没有 compose 文件，也不必往服务器上拷任何配置）：

```bash
docker run -d --name online-exe --network host --restart unless-stopped \
  --stop-timeout 45 -e TZ=Asia/Shanghai -e PORT=8080 -e DATA_DIR=/data \
  -e MAX_UPLOAD_MB=800 -e KEEP_PER_PLATFORM=5 -e ADMIN_ALLOW_CIDR=10.20.0.0/16 \
  -v /srv/online_exe/data:/data \
  --log-driver json-file --log-opt max-size=20m --log-opt max-file=3 \
  online-exe:1.0.0
```

查看状态与日志：

```bash
docker ps --filter name=online-exe        # STATUS 里应出现 (healthy)
docker logs -f online-exe
curl -i http://127.0.0.1:8080/healthz
```

> Windows 上 `docker save -o` 生成的是 tar 文件，直接拷进内网服务器 `docker load` 即可，不用转换。

镜像版本号（`1.0.0`）是**服务端程序版本**，与客户端 `1.3.0` 无关，别混着叫。

### 8.4 上线前必须实测的三件事

| # | 测什么 | 命令 | 期望 |
|---|---|---|---|
| 1 | 源 IP 真实性 | `docker exec -it online-exe node -e "require('http').createServer((q,s)=>{console.log(q.socket.remoteAddress);s.end()}).listen(9999)"` 后从另一台机器访问 | 打印那台机器的 IP，不是 `172.17.0.1` |
| 2 | CIDR 不误伤 | 浏览器开 `/admin`、`curl -v` 打 `/healthz` | 前者 200 / 503 因配置而定，后者 200 |
| 3 | 构建机不被挡 | 从 CI 机器 `curl -X POST` 传个小文件 | 201，不是 403 |

---

## 9. 自测清单（B 的 17 条）

**先跑自动化**：`npm test`（`scripts/test-b.mjs`，74 条断言）。它起真进程、写真磁盘、打真 HTTP，覆盖了上传/查重/并发/超限/墓碑/对账/孤儿/CIDR 的全部接口行为。

**手工用例逐条清单见 [`testing.md`](./testing.md)**（A–I 共 67 条，PowerShell 命令 + 期望输出 + 排错速查）。

它替代不了的是这四类：真浏览器、真容器、真大包、真网络。所以下面这些还得手工过一遍。带 ★ 的是硬伤用例，不过就别上线。

| # | 用例 | 怎么验 |
|---|---|---|
| 3 | 上传成功列表立即出现新行，大小与 sha256 前 8 位正确 | 上传后看行 + `sha256sum 包` 对比 |
| 5 | 同版本重复上传一律 409，磁盘不产生多余文件 | `curl` 两次 + `find data/releases -name '*.tmp'` |
| 6 | 并发同版本：一个 201 一个 409 | §5.8 的并发脚本 |
| 8 | 8 个平台并发全部成功，总耗时接近单包 | 8 个 `curl &` + `time` |
| 9 | 400MB 不 OOM | `docker stats` 内存恒定百兆内 |
| 10 | 传输超 5 分钟不中断 | `curl --limit-rate 1M` 传 400MB |
| 14 | 孤儿文件在管理页可见：状态条个数/大小正确，点开能看路径、能单个删、能全部清 | 已实现，见 `src/catalog/orphan.js` 与管理页孤儿面板 |
| 17 | 挂载目录改只读 → `/healthz` 503、容器 unhealthy | `chmod -R a-w /srv/online_exe/data` |
| 21 | `docker rm -f` 后重跑 `docker run`，记录与文件都在 | — |
| 22 | 宿主机重启自动拉起 | `reboot` |
| 24 | 中文文件名不乱码 | 传 `测试包.exe`，看 `filename` 字段 |
| 26 | `.exe` 后缀 + 随机字节，sha256 与页面一致 | `dd if=/dev/urandom of=x.exe bs=1M count=10` |
| 33 | `-F file=@...` 放第一个依然成功 | 元数据确实走 query |
| 34 | 一次传两个文件 → 400 | §5.8 |
| ★36 | 上传中途断开，服务不退出（连做 10 次，`RestartCount` 仍 0） | §5.8 |
| ★37 | 删除后同版本重传 409，墓碑在「已删除」筛选可见 | — |
| ★39 | 源 IP 真实，`uploaded_ip` 与之一致 | §8.4 |

共同 7 条里与我相关的是 **2、12、15、23、38**：平台分块正确、`docker stop` 不砍断上传、`file_missing` 重传后 id 不变计数不归零、页面时间与宿主机一致、8 并发大包的空间预检（部分 507 部分成功，不能集体 ENOSPC）。

---

## 10. 缺口清单与处理结果

第一轮实现后按现码对齐过一遍，8 条缺口里 7 条已修，1 条只剩文档工作。

| # | 缺口 | 影响 | 处理 |
|---|---|---|---|
| 1 | 冻结表的 `POST /api/releases/:id/yank`、`/unyank` 不存在，只有 `PATCH {status}` | A 或 CI 按冻结表调用会 404 | ✅ 已加两条别名路由，与 `PATCH` 共用 `setStatus()` 一份实现 |
| 2 | `DELETE /api/orphans` 不存在，状态条只有数字、没有路径列表 | 验收 #14 过不了；`orphan/` 会悄悄涨满盘 | ✅ 新增 `src/catalog/orphan.js` + `GET /api/orphans` + `DELETE /api/orphans?path=`，管理页面板可展开、可单删、可清空 |
| 3 | `?status=乱写` 落不进任何分支 → 连墓碑一起返回 | 已删除记录泄露 | ✅ 改白名单查表：接口层非法值 400，页面层回落 `all` |
| 4 | `adminGuard` 的 403 是纯文本 | CI 里 `JSON.parse` 直接抛，排查方向被带偏 | ✅ 改 `{ error }` JSON |
| 5 | `catalog` 实际签名 `get/getById/apply/withRecord/latest`，冻结表写 `has/find/add/setStatus` | 新人照文档写必踩空 | ⏳ 代码为准，需更新 `docs/api-contract.md`（纯文档工作，不阻塞开发） |
| 6 | `yanked + file_missing` 仍渲染可点的「恢复」 | 点了才 409，多一次失败 | ✅ 模板里禁用并加 `title` 说明补救路径 |
| 7 | `engines >= 20.11` / 方案 `>=24` / 镜像 `node:24-alpine` 三处打架 | 口径不清 | ✅ 统一为 `>=22`（代码真实下限 + 本地开发版本），生产镜像仍固定 24 |
| 8 | `config.appName` 默认值曾是模板遗留值 | 忘记传 `APP_NAME` 时标题与 JSON 元信息都是错的 | ✅ 已随产品更名统一为 `llm-wiki / 客户端`（2026-11-05）；改名只改这一处或传环境变量 |

另外顺手修掉两处文档承诺与实际行为不符的地方：

- 列表接口此前**不排序**（返回插入顺序），而文档写的是「按版本号降序」→ 现在 `sortReleases()` 统一排序，页面与接口共用。
- 并发竞态下 `commit()` 抛 `DUPLICATE` 会把英文标识符直接吐给前端 → 现在返回中文文案 + `existing`，前端仍能自动 +1。

**仍待办（与 B 相关、需要环境或其它角色配合）**

| 项 | 说明 |
|---|---|
| `/healthz` 503 用例 | 需要只读挂载或 `chmod a-w`，本机是管理员权限跑不出来，留到容器验收（#17） |
| 优雅退出 | Windows 下 `kill` 是 `TerminateProcess`，验证不了 SIGTERM 路径，留到 Linux 容器验（#12） |
| 400MB 压测 | 需要真实大包与限速链路（#9 / #10 / #36） |
| `docs/api-contract.md` | 需要 A 一起确认签名后统一改（缺口 5） |

---

## 11. 提交纪律

| 项 | 约定 |
|---|---|
| 分支 | `feat/admin-page`，小步合并，`main` 保护 |
| 粒度 | 一个功能一个提交，别攒一天 |
| 同改文件 | `src/constants.js`、`package.json`、`package-lock.json`、`public/base.css` — 改前先说 |
| 加依赖 | 必须两人同意，`package.json` 与 `package-lock.json` 同时更新 |
| 接口变更 | 「先说 → 同改 → 通知」，同时更新 `docs/zxp/api.md` |
| 代码评审 | 我审 A 的下载页（ES5 / 无 CDN / 不 import dto.js），A 审我的上传（文件有没有进内存、有没有绕过 DTO） |

评审线为什么交叉：按页面切最大的风险是「我自己的页面我说了算」。所以评审必须由**不用这个页面的人**做，他看约束不看功能。
