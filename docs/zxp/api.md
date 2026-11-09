# API 文档（成员 B：管理接口 + 健康检查）

> 对应方案：`docs/release-platform-design.md`（v3.4）
> 归属：**B** — `src/routes/upload.js`、`src/routes/releases.js`、`src/routes/dto.js`、`src/middleware/errors.js`
> 开发细节见 [`development.md`](./development.md)；下载接口 `/dl/*` 与下载页由 A 维护，不在本文范围

---

## 1. 通用约定

| 项 | 约定 |
|---|---|
| Base URL | `http://<内网IP>:8080`（host 网络，端口由应用监听） |
| 认证 | **没有账号体系**。`/admin` 与 `/api/*` 由 `ADMIN_ALLOW_CIDR` 做来源网段限制，空值 = 不限制 |
| 字符集 | 请求与响应一律 UTF-8；上传中文文件名依赖 busboy `defParamCharset: 'utf8'` |
| 时间 | 响应里的时间**全部是 UTC**（`2026-11-05T02:10:00.000Z`），页面按 `TZ` 转本地 |
| 请求体 | 只有 `PATCH` 用 `application/json`；`POST /api/releases` 支持 `multipart/form-data`（CI）和 `application/octet-stream`（管理页，body 即文件）；版本号/平台/架构**必须走 query** |
| 相对路径 | 响应里的 `download_url` 是相对路径（`/dl/...`），调用方自己拼 host |
| 错误格式 | 业务错误统一 `{ "error": "中文说明" }`；**例外见 §1.1** |

> **本文示例统一用 PowerShell 写**（Windows 本机验证）：`curl.exe` 负责 multipart 与看状态码，`Invoke-RestMethod` 负责取 JSON。
> 记住三点：PowerShell 里 `curl` 是别名，必须写 **`curl.exe`**；续行是反引号不是 `\`；PS 5.1 没有 `&&`。
> CI 在 Linux 上跑，用 §12 的 sh 片段。

### 1.1 一个格式例外

| 场景 | 实际响应 | 说明 |
|---|---|---|
| 路由未命中 | `404` + 纯文本 `not found` | 由 `notFound` 中间件产出，通常意味着 URL 写错了 |

除此之外全部是 JSON：`403`（来源网段不符）、`409`、`413`、`507`、`500` 都带 `{ "error": "中文说明" }`，CI 脚本可以无条件 `JSON.parse`。

### 1.2 状态码总表

| 码 | 含义 | 出现位置 |
|---|---|---|
| `200` | 成功 | `GET /api/releases`、`PATCH`、`DELETE`、`/healthz` |
| `201` | 上传成功，返回新记录 | `POST /api/releases` |
| `400` | 参数不合法 / multipart 结构不合法 / 没有文件 | `POST`、`PATCH` |
| `403` | 来源网段不在白名单 | `/admin`、`/api/*` 全部 |
| `404` | 记录不存在 | `PATCH`、`DELETE` |
| `409` | 版本已存在 / 正在上传 / 状态不允许 | `POST`、`PATCH`、`DELETE` |
| `413` | 超过 `MAX_UPLOAD_MB` | `POST` |
| `499` | 客户端主动断开（Nginx 惯例码，**客户端自身看不到**） | `POST` |
| `500` | 建目录失败 / 写盘失败 / 写 JSON 失败 | `POST`、`PATCH`、`DELETE` |
| `503` | 存储不可用（写盘探针失败） | `/healthz` |
| `507` | 磁盘空间不足 | `POST` |

---

## 2. 端点总表

| # | 方法 | 路径 | 用途 | 鉴权范围 | 状态 |
|---|---|---|---|---|---|
| 1 | `GET` | `/healthz` | 健康检查（写盘探针） | **不受 CIDR 限制** | ✅ |
| 2 | `GET` | `/api/releases` | 版本列表（筛选） | CIDR | ✅ |
| 3 | `POST` | `/api/releases` | 上传产物 | CIDR | ✅ |
| 4 | `PATCH` | `/api/releases/:id` | 撤回 / 恢复（body 传 status） | CIDR | ✅ |
| 5 | `DELETE` | `/api/releases/:id` | 删除（墓碑） | CIDR | ✅ |
| 6 | `POST` | `/api/releases/:id/yank` | 撤回（冻结表形态，与 #4 等价） | CIDR | ✅ |
| 7 | `POST` | `/api/releases/:id/unyank` | 恢复（冻结表形态，与 #4 等价） | CIDR | ✅ |
| 8 | `GET` | `/api/orphans` | 列出孤儿文件 | CIDR | ✅ |
| 9 | `DELETE` | `/api/orphans` | 清空孤儿目录（带 `?path=` 则删单个） | CIDR | ✅ |
| 10 | `POST` | `/api/uploads` | 开分片上传会话（管理页用） | CIDR | ✅ |
| 11 | `GET` | `/api/uploads/:id` | 查会话进度（哪些片没到） | CIDR | ✅ |
| 12 | `PUT` | `/api/uploads/:id/chunks?offset=` | 传一片 | CIDR | ✅ |
| 13 | `POST` | `/api/uploads/:id/complete` | 校验并提交 | CIDR | ✅ |
| 14 | `DELETE` | `/api/uploads/:id` | 放弃会话，清 tmp | CIDR | ✅ |

---

## 3. `GET /healthz`

Docker `HEALTHCHECK` 与运维巡检用。**不是** `res.send('ok')` 那种假健康——它会真的往 `DATA_DIR` 写一个 `.health.tmp` 再删掉。

| 项 | 值 |
|---|---|
| 鉴权 | 无（不受 `ADMIN_ALLOW_CIDR` 限制） |
| 成功 | `200`，body 就是 `ok` |
| 失败 | `503`，body 是 `storage unavailable` |

> `Content-Type` 是 `text/html; charset=utf-8`（Express `res.send('字符串')` 的默认行为），不是 `text/plain`。
> 判健康只看**状态码**，别按 content-type 判。

```powershell
curl.exe -i http://127.0.0.1:8080/healthz
```

**失败判据**：`DATA_DIR` 不存在、只读、磁盘满、属主不对（`EACCES`）。探针文件写在 `DATA_DIR` 根下，不写进 `releases/`——写进去会被启动对账当成孤儿文件。

---

## 4. `GET /api/releases`

管理页列表用，也可给运维做状态查询。

### 4.1 查询参数

| 参数 | 类型 | 默认 | 取值 |
|---|---|---|---|
| `status` | string | `all` | `all` / `stable` / `prerelease` / `yanked` / `missing` / `deleted` |
| `platform` | string | `all` | `all` / `windows7` / `windows10` / `macos` / `linux` |

筛选用的是**两个维度**（发版意图 + 磁盘事实），不是枚举互斥：

| `status` | SQL 等价的过滤条件 |
|---|---|
| `all` | `status != 'deleted'` |
| `stable` | `status == 'active' && !is_prerelease` |
| `prerelease` | `status == 'active' && is_prerelease` |
| `yanked` | `status == 'yanked'` |
| `missing` | `status != 'deleted' && file_missing == true` |
| `deleted` | `status == 'deleted'` |

> `status` 走白名单校验：非法值直接 `400`，错误文案会列出全部可选值。
> 早期实现里「未知值落不进任何分支」等于完全不过滤，会把墓碑一起返回；现在这条路已经堵死。

### 4.2 响应

`200`，按版本号降序（同版本按 `uploaded_at` 降序）：

```json
{
  "releases": [
    {
      "id": "20261105T021000-1f3a9c7e",
      "version": "1.3.0",
      "major": 1, "minor": 3, "patch": 0,
      "prerelease": "",
      "is_prerelease": false,
      "platform": "windows10",
      "platformLabel": "Windows 10 / 11",
      "arch": "x64",
      "archLabel": "64 位 (x64)",
      "comboLabel": "Windows 10 / 11 · 64 位 (x64)",
      "filename": "CoreRunner-1.3.0-win10-x64.exe",
      "size": 48234496,
      "sha256": "9f2c1b7d…（64 位小写 hex）",
      "changelog": "修复登录闪退；启动速度优化 30%",
      "status": "active",
      "file_missing": false,
      "uploaded_at": "2026-11-05T02:10:00.000Z",
      "uploaded_ip": "10.20.3.51",
      "download_url": "/dl/1.3.0/windows10-x64",
      "downloads": 42
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `downloads` | **只在列表响应里出现**，来自 `stats.json`，按 `id` 合并 |
| `download_url` | 相对路径，直链可直接给浏览器/客户端 |
| 其余字段 | 见 §9 Release DTO |

### 4.3 示例

```powershell
# 全部（不含墓碑）
(Invoke-RestMethod http://127.0.0.1:8080/api/releases).releases.Count

# 只看缺文件的
(Invoke-RestMethod "http://127.0.0.1:8080/api/releases?status=missing").releases.version

# 只看 Win7 正式版
(Invoke-RestMethod "http://127.0.0.1:8080/api/releases?platform=windows7&status=stable").releases |
  Select-Object version, arch, size, downloads
```

---

## 5. `POST /api/releases` ← 核心接口

构建机 / CI / 管理页共用同一个接口。**流式接收，进程内存恒定 50–80MB，与包大小无关。**

接口按 `Content-Type` 分流，两条路落到同一套「校验 → 查重 → 占位 → 空间预检 → 落盘 → 提交」逻辑：

| 协议 | 谁在用 | body 形态 |
|---|---|---|
| `multipart/form-data` | CI / 脚本 / `curl -F` | 文件在 `file` 字段，`changelog` 在另一字段 |
| `application/octet-stream` | 管理页 | **body 就是文件本身**，文件名和 `changelog` 走请求头 |

> 为什么留着两套：部分运营商/企业网关的 DPI 会按 `Content-Type` 丢弃上传体。
> 2026-11-09 实测（同一 5MB 文件、同一出口、同一 URL，唯一变量是 Content-Type）：multipart 的 body 一个包都到不了服务器网卡，octet-stream 正常。管理页因此改走裸流，CI 的 `curl -F` 不受影响。

### 5.1 请求

**裸流（管理页用，推荐）**

```http
POST /api/releases?version=1.3.0&platform=windows10&arch=x64
Content-Type: application/octet-stream
X-Filename: CoreRunner-1.3.0-win10-x64.exe
X-Changelog: %E4%BF%AE%E5%A4%8D%E7%99%BB%E5%BD%95%E9%97%AA%E9%80%80%EF%BC%9B%E5%90%AF%E5%8A%A8%E9%80%9F%E5%BA%A6%E4%BC%98%E5%8C%96%2030%25
Content-Length: 104857600

<二进制>
```

**multipart（CI 兼容）**

```http
POST /api/releases?version=1.3.0&platform=windows10&arch=x64
Content-Type: multipart/form-data; boundary=----x

------x
Content-Disposition: form-data; name="changelog"

修复登录闪退；启动速度优化 30%
------x
Content-Disposition: form-data; name="file"; filename="CoreRunner-1.3.0-win10-x64.exe"
Content-Type: application/octet-stream

<二进制>
------x--
```

### 5.2 参数

| 位置 | 字段 | 必填 | 约束 |
|---|---|---|---|
| query | `version` | ✅ | 严格 semver `MAJOR.MINOR.PATCH[-prerelease]`，允许 `v` 前缀（服务端剥掉后入库） |
| query | `platform` | ✅ | `windows7` / `windows10` / `macos` / `linux` |
| query | `arch` | ✅ | `x64` / `arm64` / `ia32`，且必须落在 8 组白名单内 |
| header | `Content-Type` | ✅ | 必须是 `multipart/form-data` 或 `application/octet-stream`，其余一律 `400` |
| multipart | `file` | ✅ | **恰好一个**；超过 `MAX_UPLOAD_MB`（默认 800MB）→ `413` |
| multipart | `changelog` | | 多行文本，`fieldSize` 上限 64KB |
| header | `X-Filename` | | 裸流专用；**必须 `encodeURIComponent`**（HTTP 头只吃 ASCII）。缺省为 `package-<version>-<platform>-<arch>.bin` |
| header | `X-Changelog` | | 裸流专用；同样要 `encodeURIComponent`。整个请求头上限 16KB，管理页限制在编码后 8000 字符内 |
| header | `Content-Length` | 建议 | 有值时做空间预检 + 裸流的单包上限预检；chunked 时跳过预检，靠写入期计数兜底（超限同样 `413`，不会写脏盘） |

**为什么元数据必须走 query**：body 是流式的，服务端在收到第一个字节前就要知道唯一键和临时文件路径。query 在请求行里，**一定先于 body 到达**，所以「校验 → 查重 → 占位 → 空间预检」全部能在收第一个字节之前完成。裸流协议下这条更重要——body 里除了文件字节没有任何结构可解析。

字段顺序无关：`-F "file=@a" -F "changelog=x"`（文件在前）同样成功。

### 5.3 唯一键与不可变

唯一键 = **`(platform, arch, version)`**，不含渠道。

| 情况 | 结果 |
|---|---|
| 同组合同版本已存在且 `file_missing=false` | `409`，带 `existing` |
| 同组合同版本已存在但 `file_missing=true` | **允许重传**，沿用原 `id`，下载计数不归零 |
| 同组合同版本是墓碑（`status=deleted`） | **允许重传**（删除后重新发布同一版本号），沿用原 `id`，状态回到 `active` |
| 同 key 正在上传 | `409`「该版本正在上传」 |
| `windows7` 与 `windows10` 同版本 | 两条独立记录，**这是常态不是重复** |

没有 `overwrite` / `channel` / `force_update` 参数。渠道由版本号的 prerelease 段自动派生（`1.3.0-beta.1` → `is_prerelease=true`）。

### 5.4 成功响应 `201`

Body 是一条 Release DTO（**不含** `downloads`）：

```json
{
  "id": "20261105T021000-1f3a9c7e",
  "version": "1.3.0",
  "major": 1, "minor": 3, "patch": 0,
  "prerelease": "",
  "is_prerelease": false,
  "platform": "windows10",
  "platformLabel": "Windows 10 / 11",
  "arch": "x64",
  "archLabel": "64 位 (x64)",
  "comboLabel": "Windows 10 / 11 · 64 位 (x64)",
  "filename": "CoreRunner-1.3.0-win10-x64.exe",
  "size": 48234496,
  "sha256": "9f2c1b7d…",
  "changelog": "修复登录闪退；启动速度优化 30%",
  "status": "active",
  "file_missing": false,
  "uploaded_at": "2026-11-05T02:10:00.000Z",
  "uploaded_ip": "10.20.3.51",
  "download_url": "/dl/1.3.0/windows10-x64"
}
```

`sha256` 与 `size` 是**服务端实际收到的字节**算出来的，不是客户端声明的——拿它和本地 `sha256sum` 对比就能确认传输完整。

### 5.5 错误响应

| 码 | `error` 文案 | 触发条件 |
|---|---|---|
| `400` | `版本号格式不合法，应为 MAJOR.MINOR.PATCH[-prerelease]` | `version` 缺失 / 非法 |
| `400` | `平台与架构组合不受支持：<platform>-<arch>` | 不在 8 组白名单 |
| `400` | `Content-Type 必须是 multipart/form-data（file 字段）或 application/octet-stream（body 即文件）` | 两种协议都不是 |
| `400` | `multipart 解析失败，请检查 Content-Type` | 声明了 multipart 但结构坏了 |
| `400` | `一次只能上传一个文件` | 两个 `file` part |
| `400` | `字段数超出限制` | field 数 > 10 |
| `400` | `请求中没有文件，请用 file 字段上传` | 没有 `file` part |
| `409` | `<version> / <platform> / <arch> 已存在，请改用新版本号` + `existing` | 同步查重命中 |
| `409` | `该版本正在上传，请稍后再试` | `inflight` 占位 |
| `413` | `文件超过单包上限 800MB` | 超过 `MAX_UPLOAD_MB` |
| `499` | `客户端已断开` | 客户端主动断（服务端侧记录，调用方收不到） |
| `500` | `创建存储目录失败` | 权限 / 磁盘 |
| `500` | `写盘失败，请检查磁盘后重试` | 写入过程 IO 错误 |
| `507` | `磁盘空间不足，无法接收该文件` | 可用 − 已预留 < `1.1 × Content-Length` |

`409` 带 `existing` 时前端会自动把版本号 patch +1（`1.3.0` → `1.3.1`），CI 请自己处理这个分支。

### 5.6 curl 示例（PowerShell）

> PowerShell 里 `curl` 是别名，必须写 **`curl.exe`**；续行用反引号。

```powershell
# 标准上传
curl.exe -X POST "http://10.20.3.10:8080/api/releases?version=1.3.0&platform=windows10&arch=x64" `
  -F "changelog=fix login crash" `
  -F "file=@F:/tmp/pkg/CoreRunner-1.3.0-win10-x64.exe"

# 只看状态码（脚本里判成功）
$code = curl.exe -s -o NUL -w '%{http_code}' -X POST `
  "http://10.20.3.10:8080/api/releases?version=$V&platform=$P&arch=$A" `
  -F "file=@$PKG"
if ($code -ne '201') { "上传失败 HTTP $code" }

# 带进度（大包手动传）
curl.exe --progress-bar -X POST "http://10.20.3.10:8080/api/releases?version=1.4.0&platform=macos&arch=arm64" `
  -F "file=@F:/tmp/pkg/app-1.4.0-arm64.dmg"
```

CI 里跑的是 Linux，用 sh 版（见 §12）。

### 5.7 分片上传（`/api/uploads`）——管理页走这条

**为什么存在**：400MB 单连接在这条链路上**传不完** —— 实测连接会在 24–45 秒被掐断
（服务端只看到 `request_error` / ECONNRESET），而 400MB 就算跑满速也要 80 秒以上。
切成 8MB 一片，单片 1–2 秒结束，天然躲开那个时长阈值；
再配上单片重试，断哪片补哪片，不用整包重来。

**并发默认是 1，别乱调大**。2026-11-09 在同一台机器、同一个 48MB 文件上实测：

| 并发 | 吞吐 |
|---|---|
| 1 | **4.58 MB/s** |
| 2 | 4.52 MB/s |
| 3 | 4.15 MB/s |
| 4 | 3.35 MB/s |
| 6 | 2.78 MB/s |

并发越多越慢（这条链路上多连接会互相拖累）。真要调，用地址栏参数，不用改代码：
`/admin?c=4`（1–8）、`/admin?chunk=16`（分片大小 MB，1–32）。

`POST /api/releases` 保持原样，CI / 脚本继续用；管理页走这套。

**流程**

```
① POST   /api/uploads?version=&platform=&arch=&total=[&chunkSize=]
   → 201 { id, chunkSize, chunks, total }
   服务端在这里做完 查重 / 占位 / 磁盘预检 / 建目录 / 预建 tmp（truncate 到 total）

② PUT    /api/uploads/:id/chunks?offset=<片起始字节>
   Content-Type: application/octet-stream
   Content-Length 必须严格等于 min(chunkSize, total - offset)
   → 200 { received, chunks }（重复传同一片返回 duplicate:true，幂等）

③ POST   /api/uploads/:id/complete
   → 201 + 版本记录 DTO（服务端 fsync + 整读算 sha256 + 落 releases.json）

失败/放弃  DELETE /api/uploads/:id → 204（立刻清 tmp 和占位，不用等 GC）
断线重连  GET    /api/uploads/:id → { received, chunks, missing:[...], expiresInMs }
```

**关键约束**

| 项 | 说明 |
|---|---|
| `offset` | 必须是 `chunkSize` 的整数倍且 `< total`，否则 `400` |
| 分片长度 | 必须严格等于 `min(chunkSize, total - offset)`，短一个字节都 `400` |
| 并发 | 同一片并发重试 → `409`；不同片随便并发，服务端各开各的 fd 定位写 |
| 会话存活 | 内存态，闲置 10 分钟被 GC，进程重启即失效。客户端拿到 `410` 就重新 init |
| 提交前置 | 所有分片到齐才允许 `complete`，否则 `400` 并告诉你还差几片 |
| 提交失败 | 会话退回 `open`，可以直接重试 `complete`，**不用重传分片** |
| 唯一键 | 与 `POST /api/releases` 共用同一套查重与 `inflight` 占位，两条路不会互相踩 |

**为什么 tmp 要 `truncate(total)` 预分配**：分片是乱序定位写，不预分配的话最后一片之前是一片空洞，
`stat.size` 会小于 `total`，提交时的长度校验会误判。

**sha256 为什么在最后算**：分片乱序到达，没法边传边累加，只能 commit 时整读一遍。
400MB 在 2C 的 ECS 上约 2 秒，一次的事情，不影响上传速度。

---

## 6. `PATCH /api/releases/:id` — 撤回 / 恢复

| 项 | 值 |
|---|---|
| 鉴权 | CIDR |
| Content-Type | `application/json` |
| Body | `{ "status": "active" \| "yanked" }` |
| 撤回 | `{"status":"yanked"}` — 文件保留，下载页灰显，**直链仍可下** |
| 恢复 | `{"status":"active"}` — 要求文件在 |

### 6.1 成功 `200`

返回更新后的完整 DTO。

```powershell
# 撤回（成功路径用 Invoke-RestMethod 最省事：直接拿到解析后的对象）
$id = '20261105T021000-1f3a9c7e'
$r = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/releases/$id" `
  -Method Patch -ContentType "application/json" -Body '{"status":"yanked"}'
$r.status        # yanked

# 恢复
(Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/releases/$id" `
  -Method Patch -ContentType "application/json" -Body '{"status":"active"}').status
```

> 想看 400/404 的原始响应，`Invoke-RestMethod` 不行（遇 4xx 直接抛异常，看不到 body）。
> PS 5.1 还有第二个坑：给原生程序传带引号的 JSON 会掉引号。**把 body 写成文件**再发最稳：
>
> ```powershell
> '{"status":"x"}' | Set-Content F:\tmp\body.json -Encoding ascii -NoNewline
> curl.exe -i -X PATCH "http://127.0.0.1:8080/api/releases/$id" `
>   -H "Content-Type: application/json" --data-binary "@F:/tmp/body.json"
> ```

### 6.2 冻结表里的 POST 别名

方案 7.4 冻结的是 `POST /:id/yank`、`POST /:id/unyank`。这两条路由已实现，与 `PATCH` **共用同一份实现**，返回体完全一致：

```powershell
curl.exe -s -X POST "http://127.0.0.1:8080/api/releases/$id/yank"   # 等同 PATCH {"status":"yanked"}
curl.exe -s -X POST "http://127.0.0.1:8080/api/releases/$id/unyank" # 等同 PATCH {"status":"active"}
```

管理页前端用 `PATCH`（一次请求同时表达两个方向），CI 或脚本按冻结表用 `POST` 也行。两条路都留着不是历史包袱，是为了让「契约以冻结表为准」和「前端不必跟着改一轮」同时成立。

### 6.3 幂等性

目标状态与当前状态相同时，直接返回 `200` + 当前快照，**不写盘、不占写队列**。所以脚本重试（网络抖动、超时重发）是安全的，不会因为重复撤回而报错。

### 6.4 错误

| 码 | 文案 | 条件 |
|---|---|---|
| `404` | `版本记录不存在` | `id` 不存在，**或该记录已删除（墓碑）** |
| `400` | `status 只能是 active 或 yanked` | body 缺失 / 值非法 |
| `409` | `文件缺失，请先重新上传后再恢复` | `file_missing=true` 时想恢复 |

撤回是**可逆**操作，不要加二次确认；恢复不是——文件都不在了还恢复，等于给下载页一条 410 链接，所以直接 409。

---

## 7. `DELETE /api/releases/:id` — 删除（墓碑）

**物理删文件、逻辑删记录。** 记录不消失，`status` 置 `deleted`，`object_key` 保留指向已不存在的路径。

| 项 | 值 |
|---|---|
| 成功 | `200` + DTO（`status: "deleted"`，`file_missing: false`） |
| 副作用 | 删掉 `data/releases/{version}/{platform}-{arch}/package.bin`，目录不主动删 |
| 不可恢复 | 记录**留痕**（可在「已删除」筛选里查到），但**同版本号可以重新发布**，见 §7.2 |

### 7.1 错误

| 码 | 文案 | 条件 |
|---|---|---|
| `404` | `版本记录不存在` | `id` 不存在 |
| `409` | `该版本已删除` | 重复删除 |

```powershell
# 删除（成功路径）
(Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/releases/$id" -Method Delete).status   # deleted

# 重复删除看 409 原文
curl.exe -i -X DELETE "http://127.0.0.1:8080/api/releases/$id"
```

### 7.2 为什么记录不真删，但允许重发

记录留着是为了**留痕**：谁在什么时候删过哪个版本，事后还能在「已删除」筛选里翻到，`object_key` 也保留（指向已不存在的文件）。文件本身是立即删掉的。

但「留痕」不等于「永久封号」——删除的语义是「这个版本作废、东西没了」，既然文件都没了，再拿「已存在」挡住重新上传同一个版本号只会逼用户去改版本号。所以查重放行 `status=deleted` 的记录（见 §5.3）。

配套改动：`/dl/` 的缓存从 `Cache-Control: immutable` 退成 `no-cache` + ETag。否则删掉重发之后，浏览器一年内都不会回源，用户会「下了但程序没变」，且从现象上查不到原因。

墓碑默认不出现在 `GET /api/releases`（`all` 已排除），用 `status=deleted` 查；一旦用同版本号重传成功，它就从「已删除」里消失、回到 `active`。

---

## 8. 孤儿文件：`GET /api/orphans` 与 `DELETE /api/orphans`

孤儿 = **磁盘上有、`releases.json` 里没有**的文件。启动对账把它们从 `data/releases/` **移动**（不是删除）到 `data/orphan/`，命名形如 `1.3.0__windows10-x64__package.bin.1762300000000`。

这个目录不会自动清理 —— 只清不展示等于把磁盘慢性写满，所以必须有一组接口让管理页能看见路径、能判断、能删。

### 8.1 `GET /api/orphans`

`200`，按移入时间倒序：

```json
{
  "count": 2,
  "bytes": 812345,
  "orphans": [
    { "path": "1.3.0__windows10-x64__package.bin.1762300000000", "size": 48234496, "mtime": "2026-11-05T02:10:00.000Z" },
    { "path": "9.9.9__linux-x64__package.bin.1762290000000", "size": 1024, "mtime": "2026-11-05T01:00:00.000Z" }
  ]
}
```

`path` 是**相对 `data/orphan/` 的路径，统一用正斜杠**。用正斜杠是刻意的：Windows 下的反斜杠拼进查询串会被转义成 `%5C`，回传时删不掉。

### 8.2 `DELETE /api/orphans`

| 用法 | 语义 | 成功响应 |
|---|---|---|
| `DELETE /api/orphans` | 清空整个 `orphan/` 目录 | `{ "removed": 2, "bytes": 812345 }` |
| `DELETE /api/orphans?path=<相对路径>` | 只删一个 | `{ "removed": 1, "bytes": 48234496, "path": "…" }` |

| 错误 | 条件 |
|---|---|
| `400` | `path` 为空，或解析后不在 `data/orphan/` 之内（挡住 `?path=../releases.json` 这种路径穿越） |
| `400` | `path` 指向的是目录（只允许删文件，递归删目录破坏面太大） |
| `404` | 文件不存在（可能已被另一个标签页删掉） |

```powershell
# 列出（count / bytes / 明细）
Invoke-RestMethod http://127.0.0.1:8080/api/orphans

# 删单个（path 用 GET 里拿到的原值）
curl.exe -s -X DELETE "http://127.0.0.1:8080/api/orphans?path=9.9.9__linux-x64__package.bin.1762290000000"

# 清空
curl.exe -s -X DELETE http://127.0.0.1:8080/api/orphans
```

**调用方注意**：这两个接口删的是真文件，没有墓碑、不能恢复。管理页对单个删除和清空都做了二次确认；脚本调用请自己保证 `path` 是从 `GET` 里拿到的原值，不要自己拼。

---

## 9. Release DTO 字段表

`src/routes/dto.js` 是**唯一**的响应形状来源。磁盘结构（`releases.json`）与它刻意分开：API 想加 `download_url` 不会污染磁盘文件，想藏 `uploaded_ip` 也不会少历史字段。

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `id` | string | 磁盘 | `20261105T021000-1f3a9c7e`（UTC 时间戳 + 8 位随机），也是 `stats.json` 的 key |
| `version` | string | 磁盘 | 已归一化，**不带 `v` 前缀** |
| `major` / `minor` / `patch` | number | 磁盘 | 拆成整数存，`1.10.0` 与 `1.9.0` 才能正确比大小 |
| `prerelease` | string | 磁盘 | 空串或 `beta.1` |
| `is_prerelease` | boolean | 磁盘 | **渠道语义**：false = 正式，true = 预发布。没有独立 `channel` 字段 |
| `platform` | string | 磁盘 | `windows7` / `windows10` / `macos` / `linux` |
| `platformLabel` | string | **派生** | 中文展示名 |
| `arch` | string | 磁盘 | `x64` / `arm64` / `ia32` |
| `archLabel` | string | **派生** | 如 `64 位 (x64)` / `Apple Silicon (arm64)` |
| `comboLabel` | string | **派生** | `平台 · 架构` 一行展示 |
| `filename` | string | 磁盘 | 用户原始文件名，**只用于展示**，绝不参与拼路径 |
| `size` | number | 磁盘 | 服务端实际写入字节数 |
| `sha256` | string | 磁盘 | 64 位小写 hex |
| `changelog` | string | 磁盘 | 可多行 |
| `status` | string | 磁盘 | **发版人的意图**：`active` / `yanked` / `deleted` |
| `file_missing` | boolean | 磁盘 | **磁盘的客观事实**，与 `status` 正交 |
| `uploaded_at` | string | 磁盘 | UTC ISO 8601 |
| `uploaded_ip` | string | 磁盘 | 真实源 IP（依赖 `network_mode: host`） |
| `download_url` | string | **派生** | 相对路径 `/dl/{version}/{platform}-{arch}` |
| `downloads` | number | `stats.json` | **仅列表响应**有 |

派生字段永远不进 `releases.json`——写进去就等于把 HTTP 层语义焊死在磁盘格式上。

---

## 10. 枚举与白名单

### 10.1 平台 × 架构（固定 8 组，之外一律 400）

| `platform` | 可用 `arch` | 展示名 | 备注 |
|---|---|---|---|
| `windows7` | `x64` / `ia32` | Windows 7 | 与 Win10 **是两个独立平台**，版本号各自推进 |
| `windows10` | `x64` / `ia32` | Windows 10 / 11 | Win11 归这里 |
| `macos` | `arm64` / `x64` | macOS | Apple Silicon / Intel |
| `linux` | `x64` / `arm64` | Linux | — |

### 10.2 `status` 三态

| 值 | 含义 | 下载页 | 列表默认 | `latest()` |
|---|---|---|---|---|
| `active` | 在架 | 显示 | 显示 | 参与 |
| `yanked` | 已撤回（文件保留） | 灰显折叠，直链可下 | 显示 | 排除 |
| `deleted` | 墓碑（文件已删） | **完全不显示** | 排除 | 排除 |

`file_missing = true` 与上面三态**互相独立**：一个 `yanked` 记录也可能缺文件。UI 上两个标记各自渲染。

---

## 11. 错误码排错表

| 码 | 先看什么 | 常见原因 |
|---|---|---|
| `403` | `ADMIN_ALLOW_CIDR` 有没有包含本机 / **构建机**网段 | 填错网段、只填了一个网段、源 IP 被 Docker 改成 `172.17.0.1` |
| `404` | `id` 是不是当前记录 | 用了短 id、记录已被删除 |
| `409` 已存在 | `existing.version` | 真重复；删过没换版本号 |
| `409` 正在上传 | 是否有另一个 CI job 在传同一组合 | 上次客户端拔网线，`inflight` 最长 30 分钟才超时 |
| `413` | `MAX_UPLOAD_MB` | 包超过 800MB |
| `500` 创建目录失败 | `ls -ld /srv/online_exe/data` | 宿主机目录属主不是 `1000:1000`，容器内 `node` 用户无写权限 |
| `500` 写盘失败 | `df -h` / `docker logs` | 磁盘满、inode 满、挂载只读 |
| `503` `/healthz` | 同上 | `DATA_DIR` 不可写；容器会被标 unhealthy |
| `507` | `df -h` + 并发数 | 8 个 400MB 同时传要预留 3.5GB |
| 请求挂住不返回 | `docker logs` 有没有 `UnhandledPromiseRejection` | 正常情况下不会；出现就是失败路径漏了 `.catch`，按 bug 处理 |

---

## 12. CI 集成片段

```bash
#!/bin/sh
# 环境：ADMIN_ALLOW_CIDR 必须包含本机网段，否则 403
BASE="http://10.20.3.10:8080"
VER="1.3.0"
CHANGELOG="修复登录闪退；启动速度优化 30%"

upload() {  # $1=platform $2=arch $3=file
  code=$(curl -s -o /tmp/r.json -w '%{http_code}' -X POST \
    "$BASE/api/releases?version=$VER&platform=$1&arch=$2" \
    -F "changelog=$CHANGELOG" -F "file=@$3")
  case "$code" in
    201) echo "OK   $1-$2 $(jq -r .sha256 /tmp/r.json | cut -c1-8)" ;;
    409) echo "SKIP $1-$2 已存在（$(jq -r .error /tmp/r.json)）" ;;
    *)   echo "FAIL $1-$2 HTTP $code $(cat /tmp/r.json)"; return 1 ;;
  esac
}

upload windows10 x64  dist/CoreRunner-$VER-win10-x64.exe
upload windows7  x64  dist/CoreRunner-$VER-win7-x64.exe
upload macos     arm64 dist/CoreRunner-$VER-arm64.dmg
```

三个注意点：

1. **`ADMIN_ALLOW_CIDR` 必须包含构建机网段**，否则 CI 拿到的是 `403 {"error":"该来源网段无权访问管理页"}`，而脚本第一反应是「服务没起来」
2. `409` 在 CI 里应当视为「已发布过」而不是失败，按需 `SKIP`
3. `changelog` 含中文时确保脚本文件 UTF-8，`curl -F` 会按原字节发出
4. 本机手动验时用 PowerShell（见 §5.6/§6.1），CI 里用下面这段 sh

### 12.1 本地自测

```powershell
npm test        # = node scripts/test-b.mjs
```

`scripts/test-b.mjs` 起真进程、写真磁盘、打真 HTTP，74 条断言覆盖本文档的全部端点与错误码（含 CIDR 403、413 超限、并发 409、墓碑、孤儿子路径穿越）。改完任何一条接口先跑它，比手点管理页快且不漏。

---

## 13. 与方案冻结路由表的对齐结果

方案 7.4 冻结的路由与现码已经对齐，三处差异全部补齐：

| 冻结表 | 原状态 | 现在 |
|---|---|---|
| `POST /api/releases/:id/yank` | 只有 `PATCH {status}` | `POST` 别名已加，与 `PATCH` 共用实现 |
| `POST /api/releases/:id/unyank` | 同上 | 同上 |
| `DELETE /api/orphans` | 路由不存在 | 已实现，另加 `GET /api/orphans` 与 `?path=` 单删 |

补别名只改了 `src/routes/index.js`（该文件归 A，本次改动已同步），`releases.js` 的业务逻辑没有为此重写一遍。

还有一处**语义层面**的差异保留着：`catalog` 的实际签名是 `get/getById/apply/withRecord/latest`，方案冻结表写的是 `has/find/add/setStatus`。代码是唯一事实来源，契约文档（`docs/api-contract.md`）需要按代码修正，否则新人照文档写会踩空。

---

## 14. 变更流程

接口一改，三处必须同步：

1. `src/routes/dto.js` 或 handler 的返回值
2. 本文档（`docs/zxp/api.md`）
3. 管理页前端（`public/admin.js` 消费的字段）

顺序是「**先说 → 同改 → 通知**」。禁止「我先改了你跟上」——下载页与 CI 都可能在消费这个接口，静默改字段名不会有任何报错，只会让对面某天突然空值。
