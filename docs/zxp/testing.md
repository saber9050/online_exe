# 成员 B 手工测试手册

> 配套：`docs/zxp/development.md`（实现细节）、`docs/zxp/api.md`（接口契约）
> 适用分支：`dev-zxp`　环境：Windows 10/11 本机 + Linux 容器
> 用法：从第 0 节开始按顺序做，每条用例填「结果」列（通过 / 失败 / 跳过）。**P0 不过就别往下走。**

---

## 0. 十分钟快速自查（先做这个）

自动化脚本已经把接口层跑完了，先确认它绿，再动手点页面。

```bash
cd F:/qysc_project/MY/online_exe
node -v          # 必须 >= 22
npm test         # 期望最后一行：全部通过：74 条断言
```

- 通过 → 接口层基本没问题，直接跳到第 3 节做手工用例
- 失败 → 先修，别继续。失败项会打印用例名，对到本文对应编号排查

> `npm test` 用的是临时目录，不碰你的 `data/`，可以反复跑。

---

## 1. 环境准备

### 1.1 确认 Node 版本

```bash
node -v
```

期望 `v22.x` 或更高。本项目用了 `fs.statfs`、`import.meta.dirname`，Node 20.11 以下会直接起不来。

### 1.2 准备一份隔离的测试数据目录

**不要拿 `data/` 直接测**，删版本、删孤儿都是真删。用独立目录：

| 终端 | 命令 |
|---|---|
| CMD | `set DATA_DIR=F:\tmp\oe-test && set PORT=8080` |
| PowerShell | `$env:DATA_DIR="F:\tmp\oe-test"; $env:PORT="8080"` |
| Git Bash | `export DATA_DIR=/f/tmp/oe-test PORT=8080` |

然后：

```bash
npm start
```

期望输出：

```
[online-exe] listening http://0.0.0.0:8080  data=F:\tmp\oe-test
```

### 1.3 各终端里 curl 的写法（很重要）

| 终端 | 注意 |
|---|---|
| **PowerShell** | `curl` 是 `Invoke-WebRequest` 的别名，**必须写 `curl.exe`**，否则 `-F` 报参数错 |
| CMD / Git Bash | `curl` 正常可用 |

本文命令默认 **Git Bash** 写法。PowerShell 用户把 `curl` 换成 `curl.exe`，`@文件` 路径用双引号包住。

### 1.4 生成测试文件

```bash
mkdir -p /tmp/pkg
printf 'hello-exe-1.3.0' > /tmp/pkg/small.bin
head -c 5242880 /dev/urandom > /tmp/pkg/5mb.bin      # 5MB
```

CMD 没有 `head`，用：

```cmd
fsutil file createnew F:\tmp\pkg\5mb.bin 5242880
```

400MB 大包（后面大文件用例才用）：

```bash
head -c 419430400 /dev/urandom > /tmp/pkg/400mb.bin
```

```cmd
fsutil file createnew F:\tmp\pkg\400mb.bin 419430400
```

### 1.5 准备一套演示数据（页面用例需要）

新开一个终端（同样设好 `DATA_DIR`），执行：

```bash
npm run seed
```

会生成 8 组合 × 2 版本 + 预发布 + 已撤回 + 缺文件 + 墓碑，共 **20 条**记录。

> ⚠️ `seed` 会同时覆盖 `fixtures/releases.sample.json`，跑完 `git status` 会看到它被改动。
> 想保留现场就先用 `git stash` 或复制一份；不想脏就测完按第 14 节还原（**注意 `git checkout` 会丢掉你自己在这个文件上的改动**，先确认没有）。

---

## 2. 用例总览

| 组 | 覆盖 | 条数 | 优先级 |
|---|---|---|---|
| A | 启动 / 健康检查 | 5 | P0 |
| B | 上传（正常 + 边界 + 并发 + 中断） | 13 | P0 |
| C | 列表与筛选 | 6 | P0 |
| D | 撤回 / 恢复 / 删除墓碑 | 8 | P0 |
| E | 缺文件对账与重传 | 4 | P1 |
| F | 孤儿文件 | 6 | P1 |
| G | 来源网段限制 | 4 | P1 |
| H | 管理页 UI（浏览器） | 12 | P0 |
| I | 容器与部署 | 8 | P1 |

---

## 3. A 组：启动与健康检查

### A-01 空目录首启 P0

**操作**：指向一个全新的空目录启动（比如 `F:\tmp\oe-empty`）。

**期望**：
- 进程正常监听，日志出现 `listening http://0.0.0.0:8080`
- 自动生成 `F:\tmp\oe-empty\releases.json`、`releases\`、`orphan\` 三个东西
- `releases.json` 内容：

```json
{ "schema": 3, "app": { "name": "核心力量", "description": "少儿跑酷客户端" }, "releases": [] }
```

**失败先看**：`/data` 权限；`initStore()` 里三态加载把 ENOENT 当成了损坏。

**结果**：☐ 通过　☐ 失败　备注：__________

### A-02 healthz 正常 P0

```bash
curl -i http://127.0.0.1:8080/healthz
```

**期望**：`HTTP/1.1 200`，body 就是 `ok`（纯文本）。

**结果**：☐ 通过　☐ 失败　备注：__________

### A-03 healthz 是真探针，不是假 200 P1

**操作**：把数据目录改只读（Linux/WSL）：

```bash
chmod -R a-w /f/tmp/oe-test
curl -i http://127.0.0.1:8080/healthz
```

**期望**：`503`，body `storage unavailable`。恢复权限后回到 200。

> Windows 上 `chmod` 不生效，这条在容器或 WSL 里测（容器版见 I-06）。

**结果**：☐ 通过　☐ 失败　备注：__________

### A-04 端口被占 P2

**操作**：两个进程用同一个 `PORT`。

**期望**：第二个进程直接报 `EADDRINUSE` 退出，**不能**静默假装启动成功。

**结果**：☐ 通过　☐ 失败　备注：__________

### A-05 重启后数据还在 P0

**操作**：传一个包 → `Ctrl+C` 停服务 → 重新 `npm start` → 打开 `/api/releases`。

**期望**：记录还在，`id`、`sha256`、`size` 与停止前一致。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 4. B 组：上传

### B-01 正常上传 P0

```bash
curl -i -X POST "http://127.0.0.1:8080/api/releases?version=1.3.0&platform=windows10&arch=x64" \
  -F "changelog=修复登录闪退；启动速度优化 30%" \
  -F "file=@/tmp/pkg/small.bin"
```

**期望**：`201`，body 里：
- `version` = `1.3.0`，`platform` = `windows10`，`arch` = `x64`
- `sha256` 是 64 位小写 hex，**与本地一致**（见 B-02）
- `download_url` = `/dl/1.3.0/windows10-x64`
- `status` = `active`，`file_missing` = `false`
- `uploaded_ip` 是**你自己机器的内网 IP**，不是 `172.17.0.1`

**结果**：☐ 通过　☐ 失败　备注：__________

### B-02 sha256 与本地一致 P0

```bash
# Git Bash
sha256sum /tmp/pkg/small.bin
# Windows CMD
certutil -hashfile F:\tmp\pkg\small.bin SHA256
```

与 B-01 响应里的 `sha256` 逐字符对比。**不一致说明传输或哈希实现有问题，后面所有用例都别做了。**

**结果**：☐ 通过　☐ 失败　备注：__________

### B-03 磁盘落点正确 P0

```bash
find F:/tmp/oe-test/releases -type f
```

**期望**：只有一条 `releases/1.3.0/windows10-x64/package.bin`，**没有任何 `.tmp` 残留**。

**结果**：☐ 通过　☐ 失败　备注：__________

### B-04 元数据必须在 query（字段顺序无关）P1

把 `-F file` 放到最前面：

```bash
curl -X POST "http://127.0.0.1:8080/api/releases?version=1.4.0&platform=linux&arch=x64" \
  -F "file=@/tmp/pkg/small.bin" \
  -F "changelog=文件在前的顺序"
```

**期望**：`201`，`changelog` 也正确写入（说明确实不依赖 multipart 顺序）。

**结果**：☐ 通过　☐ 失败　备注：__________

### B-05 同版本重复上传 409 P0

再执行一次 B-01 的命令。

**期望**：`409`，body：

```json
{ "error": "1.3.0 / windows10 / x64 已存在，请改用新版本号", "existing": { ...完整记录... } }
```

并且 `find releases -type f` 的**文件数量不变**（不能多出个 `.tmp` 或第二份 `package.bin`）。

**结果**：☐ 通过　☐ 失败　备注：__________

### B-06 Win7 / Win10 同版本共存 P0

```bash
curl -X POST "http://127.0.0.1:8080/api/releases?version=1.3.0&platform=windows7&arch=x64" \
  -F "file=@/tmp/pkg/small.bin"
```

**期望**：`201`。这是常态不是重复——Win7 和 Win10 是两个独立平台。

**结果**：☐ 通过　☐ 失败　备注：__________

### B-07 并发上传同一版本 P0（硬伤）

```bash
for i in 1 2; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST "http://127.0.0.1:8080/api/releases?version=2.0.0&platform=linux&arch=x64" \
    -F "file=@/tmp/pkg/5mb.bin" &
done; wait
```

**期望**：两行输出，一个是 `201`，一个是 `409`（文案「该版本正在上传，请稍后再试」）。
**绝不能两个都 201**——那说明 `inflight` 占位失效，磁盘上会出现两份内容但只有一条记录。

**结果**：☐ 通过　☐ 失败　备注：__________

### B-08 并发上传 8 个不同平台 P1

```bash
time ( for p in "windows7 x64" "windows7 ia32" "windows10 x64" "windows10 ia32" \
                "macos arm64" "macos x64" "linux x64" "linux arm64"; do
  set -- $p
  curl -s -o /dev/null -X POST "http://127.0.0.1:8080/api/releases?version=3.0.0&platform=$1&arch=$2" \
    -F "file=@/tmp/pkg/5mb.bin" &
done; wait )
```

**期望**：8 个全部成功；总耗时接近单个包，**不是 8 倍**（说明没被串行化）。

**结果**：☐ 通过　☐ 失败　备注：__________

### B-09 非法版本号 400 P0

```bash
curl -i -X POST "http://127.0.0.1:8080/api/releases?version=1.3&platform=linux&arch=x64" \
  -F "file=@/tmp/pkg/small.bin"
```

**期望**：`400` + `{"error":"版本号格式不合法，应为 MAJOR.MINOR.PATCH[-prerelease]"}`。
注意：`v1.3.0` 是**合法**的（前缀会被剥掉），`1.3` 才是不合法。

**结果**：☐ 通过　☐ 失败　备注：__________

### B-10 白名单外的平台组合 400 P0

```bash
curl -i -X POST "http://127.0.0.1:8080/api/releases?version=1.5.0&platform=windows10&arch=arm64" \
  -F "file=@/tmp/pkg/small.bin"
```

**期望**：`400` + `{"error":"平台与架构组合不受支持：windows10-arm64"}`（文案要带出具体组合）。

**结果**：☐ 通过　☐ 失败　备注：__________

### B-11 没有文件 / 两个文件 400 P0

```bash
# 没有 file part
curl -i -X POST "http://127.0.0.1:8080/api/releases?version=1.6.0&platform=linux&arch=x64"

# 两个 file part
curl -i -X POST "http://127.0.0.1:8080/api/releases?version=1.6.0&platform=linux&arch=x64" \
  -F "file=@/tmp/pkg/small.bin" -F "file=@/tmp/pkg/5mb.bin"
```

**期望**：第一条 `400`「请求中没有文件，请用 file 字段上传」；第二条 `400`「一次只能上传一个文件」。
第二个尤其重要——不能静默只存第一个。

**结果**：☐ 通过　☐ 失败　备注：__________

### B-12 超过 MAX_UPLOAD_MB → 413 P1

用一个小上限重启服务：`set MAX_UPLOAD_MB=1`（或 `$env:MAX_UPLOAD_MB="1"`），然后用 5MB 文件上传。

**期望**：`413` + `{"error":"文件超过单包上限 1MB"}`；
`data/releases/版本/组合/` 目录里**不留 `.tmp`**；
紧接着 `curl /healthz` 仍 `200`（进程没被打死）。

**结果**：☐ 通过　☐ 失败　备注：__________

### B-13 上传中途断开，服务不退出 P0（硬伤）

```bash
# 传到一半杀掉 curl（400MB 包 + 限速，保证有时间杀）
curl --limit-rate 1M -X POST \
  "http://127.0.0.1:8080/api/releases?version=9.9.9&platform=linux&arch=x64" \
  -F "file=@/tmp/pkg/400mb.bin" &
sleep 2; kill %1; wait

curl -s -o /dev/null -w "healthz=%{http_code}\n" http://127.0.0.1:8080/healthz
find F:/tmp/oe-test/releases/9.9.9 -name "*.tmp" 2>/dev/null
```

**期望**：
- `healthz=200`
- 服务端日志**没有** `UnhandledPromiseRejection` / `uncaughtException`
- `.tmp` 已被清掉（可能延迟 1–2 秒，等 pipeline 收尾后自动删）

**连做 3 次**，进程必须还活着。这条不过就别上线。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 5. C 组：列表与筛选

先确保 B-01 / B-06 / seed 数据在位。取一个 id 备用：

```bash
curl -s "http://127.0.0.1:8080/api/releases" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).releases[0].id))"
```

### C-01 默认列表 P0

```bash
curl -s "http://127.0.0.1:8080/api/releases"
```

**期望**：
- `releases` 是数组
- **按版本号降序**（不是插入顺序）
- 每项带 `downloads`（数字）
- **不含** `status=deleted` 的记录

**结果**：☐ 通过　☐ 失败　备注：__________

### C-02 六种筛选逐个过 P0

```bash
for s in all stable prerelease yanked missing deleted; do
  echo -n "$s: "
  curl -s "http://127.0.0.1:8080/api/releases?status=$s" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).releases.length+' 条'))"
done
```

**期望**（用 seed 数据时）：

| status | 期望 |
|---|---|
| `all` | 不含墓碑（deleted） |
| `stable` | 只有 `active && !is_prerelease` |
| `prerelease` | 只有 `active && is_prerelease`（1 条） |
| `yanked` | 只有 `yanked` |
| `missing` | 只有 `file_missing=true`（1 条） |
| `deleted` | 只有墓碑（1 条） |

**结果**：☐ 通过　☐ 失败　备注：__________

### C-03 平台筛选 P1

```bash
curl -s "http://127.0.0.1:8080/api/releases?platform=windows7" | head -c 300
```

**期望**：只返回 `platform=windows7` 的记录。

**结果**：☐ 通过　☐ 失败　备注：__________

### C-04 非法 status 必须 400 P0

```bash
curl -i "http://127.0.0.1:8080/api/releases?status=whatever"
```

**期望**：`400`，文案列出全部可选值。

**关键**：这条以前是「返回全部含墓碑」。如果这里返回 200 且能看到 `deleted` 记录，就是老 bug 复发了。

**结果**：☐ 通过　☐ 失败　备注：__________

### C-05 下载计数 P1

```bash
ID=<上面取的 id>
curl -s "http://127.0.0.1:8080/api/releases" | grep -o '"downloads":[0-9]*' | head -3
# 下载一次（走 A 的 /dl 接口）
curl -s -o /dev/null "http://127.0.0.1:8080/dl/1.3.0/windows10-x64"
# 等 30 秒（STATS_FLUSH_SEC）或重启服务后，再看 downloads
```

**期望**：对应那条 `downloads` +1。

**结果**：☐ 通过　☐ 失败　备注：__________

### C-06 排序稳定性 P2

连续请求两次列表，对比顺序。

**期望**：完全一致（同版本按 `uploaded_at` 降序兜底）。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 6. D 组：撤回 / 恢复 / 删除

### D-01 撤回（PATCH 形态）P0

```bash
ID=<某个 active 的 id>
curl -s -X PATCH "http://127.0.0.1:8080/api/releases/$ID" \
  -H "Content-Type: application/json" -d '{"status":"yanked"}'
```

**期望**：`200`，响应里 `status` = `yanked`；文件**仍在**磁盘上（撤回不删文件）。

**结果**：☐ 通过　☐ 失败　备注：__________

### D-02 撤回（冻结表 POST 别名）P0

```bash
curl -s -X POST "http://127.0.0.1:8080/api/releases/$ID/yank"
```

**期望**：`200`，与 D-01 结果一致。两条路由是同一份实现。

**结果**：☐ 通过　☐ 失败　备注：__________

### D-03 撤回幂等 P1

对已 `yanked` 的记录再 `yank` 一次。

**期望**：仍 `200`、`status` 还是 `yanked`，不报错、不写坏 JSON。

**结果**：☐ 通过　☐ 失败　备注：__________

### D-04 恢复 P0

```bash
curl -s -X POST "http://127.0.0.1:8080/api/releases/$ID/unyank"
```

**期望**：`200`，`status` 回到 `active`。

**结果**：☐ 通过　☐ 失败　备注：__________

### D-05 PATCH 参数校验 P1

```bash
curl -i -X PATCH "http://127.0.0.1:8080/api/releases/$ID" \
  -H "Content-Type: application/json" -d '{"status":"deleted"}'
curl -i -X PATCH "http://127.0.0.1:8080/api/releases/not-exist" \
  -H "Content-Type: application/json" -d '{"status":"yanked"}'
```

**期望**：第一条 `400`「status 只能是 active 或 yanked」；第二条 `404`「版本记录不存在」。

**结果**：☐ 通过　☐ 失败　备注：__________

### D-06 删除是墓碑 P0

```bash
curl -s -X DELETE "http://127.0.0.1:8080/api/releases/$ID"
ls F:/tmp/oe-test/releases/1.3.0/windows10-x64/   # 文件应该没了
curl -s "http://127.0.0.1:8080/api/releases?status=deleted" | grep -c "$ID"
```

**期望**：
- 响应 `200`，`status` = `deleted`，`file_missing` = `false`（**不是 true**）
- 磁盘文件已删
- 记录还在，`status=deleted` 能查到
- 默认列表（`all`）里**看不到**

**结果**：☐ 通过　☐ 失败　备注：__________

### D-07 重复删除 409 P1

```bash
curl -i -X DELETE "http://127.0.0.1:8080/api/releases/$ID"
```

**期望**：`409`「该版本已删除」。

**结果**：☐ 通过　☐ 失败　备注：__________

### D-08 删除后同版本重传 409 P0（硬伤）

```bash
curl -i -X POST "http://127.0.0.1:8080/api/releases?version=1.3.0&platform=windows10&arch=x64" \
  -F "file=@/tmp/pkg/small.bin"
```

**期望**：`409`「1.3.0 / windows10 / x64 已存在，请改用新版本号」。

这条是墓碑机制存在的唯一理由：**删除后版本号永久作废**，否则「删了再传」等于给同一个 URL 换内容，`immutable` 缓存和版本追溯同时失效。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 7. E 组：缺文件对账与重传

### E-01 手工删文件 → 重启 → 标 file_missing P0

```bash
# 1. 挑一条 active 且文件存在的记录，记下 id / version / platform / arch
# 2. 删掉它的文件
rm F:/tmp/oe-test/releases/1.2.0/windows7-x64/package.bin
# 3. 重启服务（Ctrl+C 后 npm start）
curl -s "http://127.0.0.1:8080/api/releases?status=missing"
```

**期望**：
- 这条记录出现在 `status=missing` 里
- `file_missing` = `true`
- **`status` 仍是 `active`**（对账只动文件事实，不动发版人意图）

**结果**：☐ 通过　☐ 失败　备注：__________

### E-02 缺文件记录允许同版本重传 P0

对着 E-01 那条记录重传同版本。

**期望**：`201`（**不是 409**），而且 `id` **与原来完全一样**（`stats.json` 的 key 不能换，否则下载计数归零），`file_missing` 回到 `false`。

**结果**：☐ 通过　☐ 失败　备注：__________

### E-03 已撤回 + 缺文件：恢复必须 409 P1

```bash
# 撤回 → 删文件 → 重启 → 恢复
curl -s -X POST "http://127.0.0.1:8080/api/releases/$ID2/yank"
rm F:/tmp/oe-test/releases/<version>/<platform>-<arch>/package.bin
# 重启
curl -i -X POST "http://127.0.0.1:8080/api/releases/$ID2/unyank"
```

**期望**：`409`「文件缺失，请先重新上传后再恢复」；记录仍是 `yanked` + `file_missing=true`（**不能变回 active**）。

**结果**：☐ 通过　☐ 失败　备注：__________

### E-04 墓碑不参与对账 P1

删掉一个已删除版本的文件（本来就没有），重启。

**期望**：墓碑的 `file_missing` **必须仍是 `false`**。若变成 `true`，说明对账没跳过墓碑，查重会放行，不可变保护被击穿。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 8. F 组：孤儿文件

### F-01 造孤儿 → 重启 → 移入 orphan P1

```bash
mkdir -p F:/tmp/oe-test/releases/7.7.7/linux-x64
printf 'orphan-bytes' > F:/tmp/oe-test/releases/7.7.7/linux-x64/package.bin
# 重启服务
find F:/tmp/oe-test/orphan -type f
```

**期望**：文件被**移动**（不是删除）到 `orphan/`，名字形如 `7.7.7__linux-x64__package.bin.1762300000000`；`releases/` 下不再有它。

**结果**：☐ 通过　☐ 失败　备注：__________

### F-02 接口能列出孤儿 P0

```bash
curl -s http://127.0.0.1:8080/api/orphans
```

**期望**：

```json
{ "count": 2, "bytes": 324, "orphans": [ { "path": "7.7.7__linux-x64__package.bin.…", "size": 12, "mtime": "2026-11-06T…Z" } ] }
```

`path` 用**正斜杠**、不带 `orphan/` 前缀。

**结果**：☐ 通过　☐ 失败　备注：__________

### F-03 删单个 P0

```bash
curl -s -X DELETE "http://127.0.0.1:8080/api/orphans?path=7.7.7__linux-x64__package.bin.1762300000000"
```

**期望**：`200` + `{"removed":1,"bytes":12,"path":"…"}`；再 `GET` 少一个。

**结果**：☐ 通过　☐ 失败　备注：__________

### F-04 路径穿越必须 400 P0（安全）

```bash
curl -i -X DELETE "http://127.0.0.1:8080/api/orphans?path=../releases.json"
curl -i -X DELETE "http://127.0.0.1:8080/api/orphans?path=/etc/passwd"
```

**期望**：两条都 `400` + `{"error":"path 非法：必须位于 data/orphan/ 之内"}`，并且 `releases.json` 还在。

**结果**：☐ 通过　☐ 失败　备注：__________

### F-05 删除不存在 / 删目录 P1

```bash
curl -i -X DELETE "http://127.0.0.1:8080/api/orphans?path=nope.bin"
curl -i -X DELETE "http://127.0.0.1:8080/api/orphans?path="
```

**期望**：`404`「该孤儿文件不存在（可能已被删除）」；`400`「path 不能为空」。

**结果**：☐ 通过　☐ 失败　备注：__________

### F-06 清空 P0

```bash
curl -s -X DELETE http://127.0.0.1:8080/api/orphans
curl -s http://127.0.0.1:8080/api/orphans
```

**期望**：`{"removed":N,"bytes":X}`；再查 `count: 0`，`orphan/` 目录**仍存在**（重建过），不影响下次对账。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 9. G 组：来源网段限制

单独起一个实例，把白名单设成**不含本机**的网段：

```bash
PORT=8081 DATA_DIR=F:/tmp/oe-cidr ADMIN_ALLOW_CIDR=10.99.0.0/16 npm start
```

### G-01 网段外访问接口 403 P0

```bash
curl -i http://127.0.0.1:8081/api/releases
```

**期望**：`403`，**JSON**：

```json
{ "error": "该来源网段无权访问管理页" }
```

> 这里必须是 JSON。以前是纯文本，CI 里 `JSON.parse` 会抛错，排查方向被带偏成「服务挂了」。

**结果**：☐ 通过　☐ 失败　备注：__________

### G-02 管理页也 403 P0

浏览器打开 `http://127.0.0.1:8081/admin`。

**期望**：403，页面上是那段 JSON 文本（不是白屏、不是 500）。

**结果**：☐ 通过　☐ 失败　备注：__________

### G-03 healthz 不受限 P0

```bash
curl -i http://127.0.0.1:8081/healthz
```

**期望**：`200`。受限的话 Docker 会一直把容器标成 unhealthy。

**结果**：☐ 通过　☐ 失败　备注：__________

### G-04 网段放行后恢复正常 P1

改成 `ADMIN_ALLOW_CIDR=127.0.0.1/32` 重启，访问 `/api/releases`。

**期望**：`200`。若仍 403，检查 `remoteAddress` 是不是 `::ffff:127.0.0.1`（双栈监听问题）或容器端口映射改了源 IP。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 10. H 组：管理页 UI（Chrome / Edge）

打开 `http://127.0.0.1:8080/admin`，用 seed 数据。逐条打勾。

### H-01 状态条 P0

| 检查项 | 期望 | 结果 |
|---|---|---|
| 磁盘可用 / 总量 | 与 `df`/资源管理器量级一致 | ☐ |
| 版本总数 | **不含墓碑**（删一个版本后数字要立刻变小） | ☐ |
| 占用合计 | 不含墓碑、缺文件按 0 计 | ☐ |
| 孤儿文件 | 显示「N 个 / X MB」+「查看」按钮 | ☐ |

### H-02 上传区交互 P0

| 检查项 | 操作 | 期望 | 结果 |
|---|---|---|---|
| 平台下拉 | 逐一切换 | 架构选项跟着变（Win7 只有 x64/ia32，macOS 是 arm64/x64，Linux 是 x64/arm64） | ☐ |
| 渠道标签 | 填 `1.4.0` | 显示「正式」 | ☐ |
| 渠道标签 | 填 `1.4.0-beta.1` | 显示「预发布 Beta」且变橙色 | ☐ |
| 覆盖度 | 填一个已发过的版本号 | 显示「已覆盖 N/8 组合，缺少：…」 | ☐ |
| 覆盖度 | 填一个没发过的版本号 | 显示「尚未覆盖任何组合（共 8 组）」 | ☐ |
| 拖拽 | 拖一个文件进虚线框 | 框变蓝、显示「文件名 · 大小」 | ☐ |
| 进度条 | 上传 400MB | 有百分比、已传/总量、速率 | ☐ |

### H-03 上传成功 P0

传一个新版本。

**期望**：进度条到 100% → 提示「已发布 x / 平台 / 架构」+ sha256 前 8 位 → 页面**自动刷新** → 新行**高亮 3 秒**（淡黄底）→ 刷新后高亮消失。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-04 409 自动 +1 P0

传一个已存在的版本（比如 `1.3.0 / windows10 / x64`）。

**期望**：红色提示「…已存在，请改用新版本号」，**版本号输入框自动变成 `1.3.1`**，覆盖度提示同步刷新。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-05 表单记忆 P1

填好「版本号 + 平台 + 架构」后按 F5 刷新。

**期望**：三个字段都还在（`sessionStorage`，关标签页才清）。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-06 按钮矩阵 P0（重点）

用 seed 数据分别看这 5 种行，**按钮必须按组合给，不是每行一套**：

| 行状态 | 该有的按钮 | 不该有的 | 结果 |
|---|---|---|---|
| `active` + 文件在 | 撤回 / 删除 | 恢复、重新上传 | ☐ |
| `active` + 缺文件 | 重新上传 / 删除 | 撤回（文件都没了） | ☐ |
| `yanked` + 文件在 | 恢复 / 删除 | 撤回、重新上传 | ☐ |
| `yanked` + 缺文件 | 重新上传 / **灰掉的恢复** / 删除 | 可点的恢复 | ☐ |
| `deleted`（墓碑） | 只有「—」 | 任何按钮 | ☐ |

灰掉的「恢复」鼠标悬停要有提示：「文件缺失：请先用『重新上传』补齐同版本文件，再恢复」。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-07 撤回 / 恢复 P0

点「撤回」→ 行状态变「已撤回」，**不弹确认框**（可逆操作）；点「恢复」→ 变回「在架」。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-08 删除二次确认 P0

点「删除」→ 弹框要求**输入版本号**。

| 操作 | 期望 | 结果 |
|---|---|---|
| 点取消 | 什么都不发生 | ☐ |
| 输入错的版本号 | 提示「版本号不一致，已取消」 | ☐ |
| 输入正确版本号 | 行消失，切到「已删除」筛选能查到 | ☐ |

**结果**：☐ 通过　☐ 失败　备注：__________

### H-09 筛选 P0

平台下拉 + 状态下拉（全部/正式/预发布/已撤回/缺文件/已删除），选完**立即提交**（不用点按钮）。

**期望**：URL 变成 `/admin?platform=…&status=…`，行数正确。
手改 URL 成 `?status=乱写` → 页面**回落成全部**，不报错、不白屏。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-10 孤儿面板 P0

点状态条「孤儿文件 → 查看」。

**期望**：
- 首次点击才请求（Network 里能看到 `GET /api/orphans`）
- 表格列出 路径 / 大小 / 移入时间 / 操作
- 点「删除」有确认框，确认后该行消失，状态条个数同步变小
- 点「收起」再展开，不重复请求
- 「全部清理」二次确认后整页刷新，数字归 0

**结果**：☐ 通过　☐ 失败　备注：__________

### H-11 清理建议 P1

滚到底部「清理建议」。

**期望**：按**组合**（8 个）列出超出 `KEEP_PER_PLATFORM=5` 的旧包，按占用大小降序，**只有列表没有删除按钮**（版本包不可再生，不能自动删）。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-12 IE 兜底 P1

没有 IE11 就用 DevTools 模拟：

```js
// 浏览器 Console 执行
document.documentElement.className = 'ie-blocked'
```

**期望**：正常内容整体隐藏，只剩一行「请用 Chrome / Edge 打开本页」。
执行 `document.documentElement.className = 'js-ok'` 恢复。

真 IE11（Win7 机器）验证留到交叉验收。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 11. I 组：容器与部署

### I-01 镜像能构建 P0

```bash
docker build -t online-exe:1.0.0 .
docker images | grep online-exe
```

**期望**：构建成功，体积约 140MB 量级（`node:24-alpine` 基础层占大头）。

**结果**：☐ 通过　☐ 失败　备注：__________

### I-02 挂卷起容器 P0

```bash
mkdir -p /srv/online_exe/data && chown -R 1000:1000 /srv/online_exe/data
docker compose up -d
docker compose ps
docker compose logs -f
```

**期望**：容器 `Up` 且 `healthy`（30–60 秒内）；日志出现 `listening`。

**结果**：☐ 通过　☐ 失败　备注：__________

### I-03 上传落点与权限 P0

从宿主机传一个包，然后：

```bash
ls -ln /srv/online_exe/data/releases/*/*/
```

**期望**：文件属主是 `1000`，不出现 `EACCES`。

**结果**：☐ 通过　☐ 失败　备注：__________

### I-04 删容器重建，数据还在 P0

```bash
docker rm -f online-exe
docker compose up -d
curl -s http://127.0.0.1:8080/api/releases | head -c 200
```

**期望**：记录全在。

**结果**：☐ 通过　☐ 失败　备注：__________

### I-05 宿主机重启自动拉起 P1

```bash
sudo reboot
# 起来后
docker compose ps
```

**期望**：容器自动 `Up`（`restart: unless-stopped`）。

**结果**：☐ 通过　☐ 失败　备注：__________

### I-06 只读挂载 → healthz 503 + unhealthy P1

```bash
chmod -R a-w /srv/online_exe/data
curl -i http://127.0.0.1:8080/healthz          # 期望 503
sleep 95                                        # 等 3 次 * 30s 探测
docker ps --format "{{.Names}}\t{{.Status}}"    # 期望 unhealthy
chmod -R u+w /srv/online_exe/data
```

**结果**：☐ 通过　☐ 失败　备注：__________

### I-07 docker stop 不砍断上传 P1

```bash
# 终端 1：传 400MB（限速 1M，约 7 分钟）
curl --limit-rate 1M -X POST \
  "http://127.0.0.1:8080/api/releases?version=9.8.0&platform=linux&arch=x64" \
  -F "file=@/tmp/pkg/400mb.bin"
# 终端 2：传了 30 秒后
docker stop online-exe
```

**期望**：
- 容器等上传结束（或 30 秒超时）才退出，日志出现 `[shutdown] 收到 SIGTERM`
- `stats.json` 计数没丢
- **不是**立刻断开（默认 10 秒就 SIGKILL 是没配 `stop_grace_period: 45s`）

**结果**：☐ 通过　☐ 失败　备注：__________

### I-08 源 IP 真实 P0

在容器里起个临时端口，从**另一台内网机器**访问：

```bash
docker exec -it online-exe node -e "require('http').createServer((q,s)=>{console.log(q.socket.remoteAddress);s.end()}).listen(9999)"
# 另一台机器上：curl http://<服务器IP>:9999
```

**期望**：打印那台机器的真实 IP，**不是** `172.17.0.1`。
再传一个包，检查 `uploaded_ip` 与之一致。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 12. 结果记录表

复制到 issue 或文档里逐行填：

| 编号 | 用例 | 结果 | 备注 |
|---|---|---|---|
| A-01 | 空目录首启 | | |
| A-02 | healthz 正常 | | |
| A-03 | healthz 探针失败 503 | | |
| A-04 | 端口占用 | | |
| A-05 | 重启数据还在 | | |
| B-01 | 正常上传 | | |
| B-02 | sha256 一致 | | |
| B-03 | 磁盘落点 | | |
| B-04 | 字段顺序无关 | | |
| B-05 | 重复 409 | | |
| B-06 | Win7/Win10 共存 | | |
| B-07 | 并发 201+409 | | |
| B-08 | 8 并发 | | |
| B-09 | 非法版本 400 | | |
| B-10 | 白名单外 400 | | |
| B-11 | 无文件/双文件 400 | | |
| B-12 | 超限 413 | | |
| B-13 | 中断不断进程 | | |
| C-01 | 默认列表 | | |
| C-02 | 六种筛选 | | |
| C-03 | 平台筛选 | | |
| C-04 | 非法 status 400 | | |
| C-05 | 下载计数 | | |
| C-06 | 排序稳定 | | |
| D-01 | PATCH 撤回 | | |
| D-02 | POST 别名撤回 | | |
| D-03 | 撤回幂等 | | |
| D-04 | 恢复 | | |
| D-05 | 参数校验 | | |
| D-06 | 删除墓碑 | | |
| D-07 | 重复删除 409 | | |
| D-08 | 删后重传 409 | | |
| E-01 | 对账标 file_missing | | |
| E-02 | 缺文件重传沿用 id | | |
| E-03 | 已撤回+缺文件 409 | | |
| E-04 | 墓碑不参与对账 | | |
| F-01 | 孤儿移入 | | |
| F-02 | 列出孤儿 | | |
| F-03 | 删单个 | | |
| F-04 | 路径穿越 400 | | |
| F-05 | 不存在/空 path | | |
| F-06 | 清空 | | |
| G-01 | 接口 403 JSON | | |
| G-02 | 管理页 403 | | |
| G-03 | healthz 不受限 | | |
| G-04 | 放行恢复 | | |
| H-01 | 状态条 | | |
| H-02 | 上传区交互 | | |
| H-03 | 上传成功高亮 | | |
| H-04 | 409 自动 +1 | | |
| H-05 | 表单记忆 | | |
| H-06 | 按钮矩阵 | | |
| H-07 | 撤回/恢复 | | |
| H-08 | 删除二次确认 | | |
| H-09 | 筛选 | | |
| H-10 | 孤儿面板 | | |
| H-11 | 清理建议 | | |
| H-12 | IE 兜底 | | |
| I-01 | 镜像构建 | | |
| I-02 | 挂卷启动 | | |
| I-03 | 权限 | | |
| I-04 | 重建不丢数据 | | |
| I-05 | 重启自拉 | | |
| I-06 | 只读 503 | | |
| I-07 | stop 优雅 | | |
| I-08 | 源 IP 真实 | | |

---

## 13. 排错速查

| 症状 | 先查什么 | 常见原因 |
|---|---|---|
| 启动就崩，报 `ERR_MODULE_NOT_FOUND` | `node -v` | Node 版本过低 / 没 `npm ci` |
| 上传 403 | `ADMIN_ALLOW_CIDR` | 本机或**构建机**网段没进白名单 |
| 上传 500「创建存储目录失败」 | `ls -ld data` | 目录属主不是容器内 `node`(1000) |
| 上传 500「写盘失败（ENOSPC）」 | `df -h` | 磁盘/inode 满 |
| 上传 507 | `df -h` + 并发数 | 8 个 400MB 同时传要预留 3.5GB |
| 上传卡住不返回、healthz 还正常 | `docker logs` 有无 `UnhandledPromiseRejection` | 失败路径漏了 `.catch`，按 bug 处理 |
| 大文件传到一半断 | 服务是怎么起的 | `requestTimeout` 没关成 `0`（Node 默认 300s） |
| 页面时间差 8 小时 | `echo $TZ` / 镜像里 `date` | 没装 tzdata 或 TZ 没传 |
| 管理页全 403 但日志 IP 看着对 | `uploaded_ip` 是不是一堆 `172.17.0.x` | Docker bridge 改写了源 IP，改 `network_mode: host` |
| 改了 CSS/JS 没生效 | 强刷 | 静态资源不该设长缓存，确认没加 `immutable` |
| 孤儿数字一直涨 | `GET /api/orphans` | 有人手工往 `releases/` 塞文件；确认无用后清理 |
| 删掉的版本又冒出来 | `status=deleted` 查一下 | 正常：墓碑保留，只是默认列表不显示 |

---

## 14. 测完清理

```bash
# 还原被 seed 改过的 fixture（先确认这个文件上没有你自己的改动）
git diff --stat fixtures/releases.sample.json
git checkout fixtures/releases.sample.json

# 删临时数据目录
rm -rf /f/tmp/oe-test /f/tmp/oe-cidr /f/tmp/oe-empty

# 容器（如果测过）
docker compose down
```

确认 `git status` 只剩你自己的代码改动。
