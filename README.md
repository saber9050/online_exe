# online_exe · 内网客户端发版平台

给内网用的小型发版服务：**传包 → 管版本 → 别人下载**。一个 Node 进程、一个 Docker 容器、一个挂载目录，不依赖数据库、不依赖外网。

- 下载页 `/` 面向所有内网用户，只读，按平台分组，支持断点续传
- 管理页 `/admin` 面向发版人，上传 / 撤回 / 删除 / 清理孤儿文件，一页完成
- 8 个「平台 + 架构」组合独立发版：`windows7-x64`、`windows7-ia32`、`windows10-x64`、`windows10-ia32`、`macos-arm64`、`macos-x64`、`linux-x64`、`linux-arm64`

> 详细设计见 [`docs/release-platform-design.md`](docs/release-platform-design.md)，接口契约见 [`docs/zxp/api.md`](docs/zxp/api.md)。

---

## 1. 功能一览

**上传**

- 流式接收，单包上限默认 800MB，进程内存恒定 50–80MB（不随包大小涨）
- 元数据（版本号 / 平台 / 架构）走 query，文件走 body，字段顺序无关
- 两种 body 协议，按 `Content-Type` 分流：管理页用 `application/octet-stream`（body 即文件），CI 用 `multipart/form-data`。原因是部分运营商/企业网关会按 Content-Type 丢弃 multipart 上传体（2026-11-09 实测）
- 管理页实际走**分片上传**：默认 40MB 一片、**单连接串行**、每片独立重试。分片不是为了提速，是因为 400MB 单连接在这条链路上传不完（实测连接 24–45 秒被掐断）；并发反而越开越慢（实测 1 并发 4.58 MB/s，6 并发 2.78 MB/s）。要调可以加 `?c=4`、`?chunk=8`
- 同版本号重复上传回 409；并发同一版本只有一个能成功
- 上传前做磁盘空间预检（按 1.1 倍预留），空间不足直接 507，不会传到一半炸
- 客户端中途断线不杀进程，临时文件自动清理

**版本管理**

- 严格 semver，`v` 前缀自动剥掉；排序按 `major → minor → patch` 降序
- 撤回（`yanked`）：文件保留、下载页灰显，直链仍可下
- 删除：文件立即删、记录留墓碑；**删除后可以重新上传同一版本号**（详见 §8）
- 缺文件自动对账：重启时发现「记录在、文件没了」标 `file_missing`，不删记录
- 孤儿文件（磁盘有、记录无）移入 `data/orphan/`，管理页可查看、可逐个删除、可清空

**下载**

- 按平台分块 + 锚点导航（JS 禁用也能用），Win7 / Win10 是两个独立区块
- `sendFile` 原生支持 Range，断点续传、条件请求（ETag = 内容 sha256）
- 缓存策略 `private, no-store`：不给浏览器/代理留缓存。下载次数靠服务端计数，
  一旦被内网 nginx 或公司代理缓存，第二次点击根本到不了 Node，统计就永远是 0

**运维**

- `/healthz` 是**真探针**（真往数据盘写一个文件再删），存储不可写直接 503
- `SIGTERM` 优雅退出：等正在传的包收尾（最多 30s）再落盘退出
- 管理页状态条常驻显示磁盘可用量、版本总数、占用合计、孤儿文件数

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js **≥ 22**（镜像用 `node:24-alpine`） |
| Web | Express 5 |
| multipart | busboy（流式，不用 multer） |
| 模板 | EJS（服务端渲染，无构建步骤） |
| 存储 | JSON 文件 + 内存索引（几百条记录，不需要数据库） |
| 前端 | 原生 JS：下载页 ES5（兼容 IE11）、管理页现代语法 |

生产依赖只有三个：`express`、`busboy`、`ejs`。

---

## 3. 目录结构

```
online_exe/
├── src/                      # 服务端源码
│   ├── server.js             # 入口：启动自检 → HTTP Server（四个超时）→ 优雅退出
│   ├── app.js                # Express 实例、中间件顺序
│   ├── config.js             # 环境变量与派生路径
│   ├── constants.js          # 8 组合白名单、平台/架构标签
│   ├── format.js             # 字节数 / 时间格式化（只喂模板）
│   ├── semver.js             # 版本解析、比较
│   ├── catalog/              # 数据侧
│   │   ├── catalog.js        #   内存索引、latest、唯一键
│   │   ├── persist.js        #   原子写、三态加载、tmp 清理、启动对账
│   │   ├── stats.js          #   下载计数（内存累加 + 定时落盘）
│   │   ├── orphan.js         #   孤儿文件枚举/删除
│   │   └── types.js          #   JSDoc 类型（不参与运行）
│   ├── storage/              # 文件存储：storage.js 门面 + local.js 实现
│   ├── middleware/           # cidr.js（来源网段）、errors.js（统一错误）
│   └── routes/               # index.js 路由表 + upload/releases/download/dto + pages/
├── views/                    # EJS 模板（download.ejs / admin.ejs / partials/）
├── public/                   # 静态资源（base.css、download.*、admin.*）
├── scripts/                  # seed-demo.js（演示数据）、test-b.mjs（接口测试）
├── fixtures/                 # 页面开发用的假数据
├── data/                     # 运行时数据（挂载点，不进镜像、不进 git）
├── docs/                     # 设计与文档
├── Dockerfile
├── docker-entrypoint.sh      # 容器入口：修 /data 属主后降权到 uid 1000
└── start.bat / start.sh      # 懒人启动脚本（自动 npm install）
```

数据目录结构：

```
data/
├── releases.json      # 版本记录（schema 3）
├── releases.json.bak  # 写盘前的上一份
├── stats.json         # 下载计数 { "<id>": 42 }
├── releases/          # 版本包：{version}/{platform}-{arch}/package.bin
└── orphan/            # 孤儿文件待确认
```

---

## 4. 快速开始（本地）

### 4.1 准备

```powershell
node -v          # 需要 v22 或更高
npm ci
```

### 4.2 起服务

```powershell
# 默认数据目录 ./data，端口 8080
npm start
```

也可以双击 `start.bat`（Windows）/ `./start.sh`（Linux/macOS），它们会自动装依赖。

用独立数据目录（推荐，避免污染默认 `data/`）：

```powershell
$env:DATA_DIR = "F:\tmp\oe-test"
$env:PORT = "8080"
npm start
```

启动成功会打印：

```
[online-exe] listening http://0.0.0.0:8080  data=F:\tmp\oe-test
```

### 4.3 打开页面

| 页面 | 地址 | 用途 |
|---|---|---|
| 下载页 | `http://127.0.0.1:8080/` | 内网所有人下载 |
| 管理页 | `http://127.0.0.1:8080/admin` | 发版人上传 / 管理 |

### 4.4 造点演示数据（可选）

```powershell
npm run seed
```

生成 8 组合 × 2 版本 + 预发布 + 已撤回 + 缺文件 + 墓碑，共 20 条记录。

> `seed` 会同时覆盖 `fixtures/releases.sample.json`，跑完注意 `git status`。

---

## 5. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口（host 网络下由应用自己监听） |
| `DATA_DIR` | `<项目>/data` | 数据目录；容器内固定 `/data` |
| `MAX_UPLOAD_MB` | `800` | 单包上限；实际产物 300–400MB，留 2 倍余量 |
| `KEEP_PER_PLATFORM` | `5` | 清理建议的保留数（只提示，不自动删） |
| `APP_NAME` | `llm-wiki` | 页面标题；仅首次初始化 `releases.json` 时写入 |
| `APP_DESCRIPTION` | `客户端` | 顶部导航副标题 |
| `TZ` | `Asia/Shanghai` | 页面渲染与日志时区 |
| `ADMIN_ALLOW_CIDR` | 空 | 空=不限制；填 `10.20.0.0/16` 则只允许该网段访问 `/admin` 与 `/api/*`，支持逗号分隔多个 |
| `STATS_FLUSH_SEC` | `30` | 下载计数落盘间隔 |

**`ADMIN_ALLOW_CIDR` 是这套系统唯一的访问控制**（没有账号体系）。填写时别忘了把**构建机 / CI 的网段**算进去，否则 CI 上传会被自己的防护挡成 403。

---

## 6. API 一览

完整参数、响应体、错误码见 [`docs/zxp/api.md`](docs/zxp/api.md)。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/healthz` | 健康检查（写盘探针，不鉴权） |
| `GET` | `/api/releases` | 版本列表，支持 `status` / `platform` 筛选 |
| `POST` | `/api/releases?version=&platform=&arch=` | 上传（两种：管理页裸流 `octet-stream`，CI 用 multipart `file` + `changelog`） |
| `POST` | `/api/uploads?version=&platform=&arch=&total=` | 开分片会话（管理页实际走这条，见下） |
| `PUT` | `/api/uploads/:id/chunks?offset=` | 传一片（`application/octet-stream`） |
| `POST` | `/api/uploads/:id/complete` | 校验并提交分片 |
| `DELETE` | `/api/uploads/:id` | 放弃分片会话 |
| `DELETE` | `/api/uploads?version=&platform=&arch=` | 按业务键强制释放上次中断残留的占位 |
| `PATCH` | `/api/releases/:id` | 撤回 / 恢复（body `{"status":"yanked"\|"active"}`） |
| `POST` | `/api/releases/:id/yank` | 撤回（等价写法） |
| `POST` | `/api/releases/:id/unyank` | 恢复（等价写法） |
| `DELETE` | `/api/releases/:id` | 删除（墓碑，可重发同版本） |
| `GET` | `/api/orphans` | 列出孤儿文件 |
| `DELETE` | `/api/orphans` | 清空孤儿（带 `?path=` 则删单个） |
| `GET` | `/dl/:version/:combo` | 下载直链，如 `/dl/1.3.0/windows10-x64`（每次请求都给计数 +1） |
| `GET` | `/api/stats` | 各版本下载计数 `{counts:{id:n}}`，管理页每 10 秒轮询它刷新「下载」列 |

CI 上传示例：

```powershell
curl.exe -X POST "http://10.20.3.10:8080/api/releases?version=1.3.0&platform=windows10&arch=x64" `
  -F "changelog=fix login crash" `
  -F "file=@F:/dist/CoreRunner-1.3.0-win10-x64.exe"
```

> PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，必须写 **`curl.exe`**；续行是反引号不是 `\`。

**上传只收安装包**：文件名后缀必须在白名单内
（`.exe` `.msi` `.msix` `.msixbundle` `.appx` `.dmg` `.pkg` `.deb` `.rpm` `.AppImage`
`.run` `.sh` `.tar.gz` `.tar.xz` `.tgz` `.zip` `.7z`），**所有平台通用**，不按平台切分。
图片、视频、音频、PDF/文档、源码、手机包、镜像等一律 `400 bad_filetype`，详见 `docs/zxp/api.md` §5.8。
白名单只有一份（`src/filetypes.js`），管理页的 `accept` 过滤与即时提示都从它生成。

---

## 7. 页面说明

### 下载页 `/`

- 4 个平台区块垂直排列 + 顶部锚点导航，**不用 Tab**（Tab 依赖 JS，IE11 一挂就全废）
- 读 UA 自动滚到对应平台区块，滚不动也不影响使用
- 每个组合一张卡片：版本、大小、时间、下载按钮
- 预发布版本标 `Beta`；已撤回的灰显但仍可下（老用户回滚不断链）；缺文件的红标且按钮置灰
- 底部版本历史表

### 管理页 `/admin`

- **状态条**：磁盘可用 / 总量、版本总数、占用合计、孤儿文件（可展开）
- **上传区**：拖拽或选择文件、进度与速率、覆盖度提示（`1.3.0 已覆盖 5/8 组合`）、表单记忆、409 时自动把版本号 +1
- **版本列表**：按状态给不同按钮（在架=撤回/删除，已撤回=恢复/删除，缺文件=重新上传/删除），筛选与操作**全部前端完成，不刷新页面**

---

## 8. 几个需要知道的行为

| 行为 | 说明 |
|---|---|
| **没有登录** | 内网即信任。要限制访问范围就配 `ADMIN_ALLOW_CIDR`，别指望它挡得住同网段的人 |
| **删除是墓碑** | 文件立即删，记录保留（可在「已删除」筛选里查到）。**删除后可以重新上传同一版本号**，会沿用原 `id`，下载计数不清零 |
| **在架版本不可覆盖** | 想换内容只能先删再传，或者发新版本号 |
| **下载缓存是 `private, no-store`** | 一是同版本号可能被重发、URL 内容会变；二是下载计数只在服务端做，任何一层缓存都会让「点了下载但没统计上」 |
| **孤儿文件不会自动删** | 对账只把它们挪进 `data/orphan/`，需要人在管理页确认后清理 |
| **没有请求日志** | 只有启动/退出/对账/5xx 会打日志；上传下载的成功与失败都不落日志，排查靠页面提示 + 浏览器 Network |
| **单进程** | 上传提交、JSON 写盘都靠单线程串行保证一致性，**不要横向扩多副本**（会互相覆盖 `releases.json`） |

---

## 9. 测试

```powershell
npm test        # = node scripts/test-b.mjs
```

起真进程、写真磁盘、打真 HTTP，**82 条断言**覆盖：

- 空 `data/` 首启、healthz、上传 sha256/size/中文文件名
- 重复 409、并发 201+409、非法参数 400、超限 413
- 列表筛选、撤回/恢复/幂等、墓碑、删除后重发
- 重启对账标 `file_missing`、缺文件重传沿用 id
- 孤儿列出/单删/清空/路径穿越防护
- CIDR 403、下载缓存头

跑完自动清理临时目录，不碰你的 `data/`。

手工逐条验收清单（PowerShell 版，67 条）见 [`docs/zxp/testing.md`](docs/zxp/testing.md)。

---

## 10. Docker 部署

前提（都已就绪，这里不重复）：构建机能上外网并装好 Docker；服务器已装 Docker；`/srv/online_exe/data` 已建好。

> 目录属主不用手动 `chown`——镜像的入口脚本会以 root 进来把 `/data` 改成 uid 1000 再降权运行。若挂载点位于 Windows 盘（`/mnt/c`、`/mnt/f`）或 NFS，`chown` 不可能生效，脚本会退回 root 运行并打印告警，此时请改用命名卷（`-v online_exe_data:/data`）或 WSL 的 ext4 路径。

### 1. 构建（构建机）

```bash
docker build -t online-exe:1.0.0 .
```

> 基础镜像、Alpine 包源、npm 源都已在 Dockerfile 里指向国内镜像站，**不需要提前配 daemon.json 或 `.npmrc`**。
> 万一镜像站不可用，换回官方源：`docker build --build-arg NODE_IMAGE=node:24-alpine -t online-exe:1.0.0 .`

### 2. 导出（构建机）

```bash
docker save online-exe:1.0.0 -o online-exe-1.0.0.tar
```

把 `online-exe-1.0.0.tar` 拷到内网服务器。

### 3. 导入（服务器）

```bash
docker load -i online-exe-1.0.0.tar
```

### 4. 运行（服务器）

**只用 `docker run`，仓库里没有 compose 文件**（`docker save/load` 也只搬镜像，配置文件本来就不会跟着走）：

```bash
docker run -d --name online-exe \
  --network host \
  --restart unless-stopped \
  --stop-timeout 45 \
  -e TZ=Asia/Shanghai \
  -e PORT=8080 \
  -e DATA_DIR=/data \
  -e MAX_UPLOAD_MB=800 \
  -e KEEP_PER_PLATFORM=5 \
  -v /srv/online_exe/data:/data \
  --log-driver json-file --log-opt max-size=20m --log-opt max-file=3 \
  online-exe:1.0.0
```

确认起来了：

```bash
docker ps --filter name=online-exe      # STATUS 里应出现 (healthy)
```

升级 = 导入新 tag 的镜像后重跑一遍：

```bash
docker rm -f online-exe
docker run -d --name online-exe ...（同上，只换最后的 tag）
```

数据在卷里，版本记录和包都不会丢。每个参数的含义见 [`docs/zxp/development.md`](docs/zxp/development.md) §8。

---

## 11. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `docker build` 卡在 `FROM node:24-alpine`、几分钟不动甚至 `Canceled` | 拉 Docker Hub 慢，配 Docker 镜像加速；或用 `--build-arg NODE_IMAGE=<加速地址>/node:24-alpine`（Dockerfile 已留参数） |
| `/admin` 全 403 | `ADMIN_ALLOW_CIDR` 没含本机网段；容器里若 `uploaded_ip` 全是 `172.17.0.x`，说明源 IP 被 Docker 改写，改用 host 网络 |
| 上传 413 | 超过 `MAX_UPLOAD_MB`；若前面加了 Nginx，还要改 `client_max_body_size` |
| 上传 507 | 磁盘可用空间不足（8 个 400MB 并发要预留约 3.5GB） |
| 容器起不来，日志报 `EACCES: permission denied, mkdir '/data/releases'` | 挂载目录属主不是 uid 1000。新版镜像的入口脚本会自动 `chown` 后降权；若仍报错看下一行 |
| 入口脚本打印「chown 失败」「改用 root 运行」 | 挂载点在 Windows 盘（`/mnt/*`）、NFS 或只读。换命名卷 `-v online_exe_data:/data`，或把目录放到 WSL 的 ext4（`~/online_exe-data`） |
| 上传 500「创建存储目录失败」 | 宿主机目录属主不是 `1000:1000`，且容器以只读挂载运行 |
| 大文件传到一半断 | 确认 `server.requestTimeout = 0`（代码里已设）；前面有代理也要放开超时 |
| 页面时间差 8 小时 | 容器没装 tzdata 或没传 `TZ` |
| 改了 CSS/JS 不生效 | `Ctrl+F5`；静态资源不设长缓存，理论上不会卡住 |
| 删掉的版本又出现 | 用同版本号重传过，属于设计行为 |
| 想查某次失败的原因 | 目前没日志。开浏览器 Network 看 Response，或按 [`docs/zxp/api.md`](docs/zxp/api.md) §11 错误码表反查 |

---

## 12. 文档索引

| 文档 | 内容 | 读者 |
|---|---|---|
| [`docs/release-platform-design.md`](docs/release-platform-design.md) | 完整设计方案：需求、选型、数据模型、上传/下载/页面细节、部署、分工 | 所有人 |
| [`docs/zxp/development.md`](docs/zxp/development.md) | 运行时 / 上传 / 版本管理 / 管理页 / 部署的实现说明与踩坑 | 后端开发 |
| [`docs/zxp/api.md`](docs/zxp/api.md) | 接口契约：参数、响应体、错误码、curl 示例 | 前后端、CI |
| [`docs/zxp/testing.md`](docs/zxp/testing.md) | 67 条手工验收用例（PowerShell 命令 + 期望输出 + 排错） | 测试 / 验收 |

---

## 13. 开发约定（多人协作时）

- `src/routes/index.js`（路由表）只由一个人改，避免合并冲突
- 改 `releases.json` 结构要同步改 `src/catalog/types.js` 和文档
- 加任何 `dependencies` 需评审，`package.json` 与 `package-lock.json` 一起提交
- 一个功能一个提交，别攒一天
- 提交前跑 `npm test`
