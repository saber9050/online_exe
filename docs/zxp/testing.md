# 成员 B 手工测试手册（PowerShell 版）

> 配套：`docs/zxp/development.md`（实现细节）、`docs/zxp/api.md`（接口契约）  
> 适用分支：`dev-zxp`　目录结构：与方案 4.2 一致（代码在 `src/` 下）  
> **本文所有命令都在 PowerShell 5.1（Windows 自带）里执行**，第 11 节的容器用例除外（那组在 Linux 服务器上跑）  
> 用法：从第 0 节开始按顺序做，每条填「结果」列。**P0 不过就别往下走。**

---

## 0. 十分钟快速自查（先做这个）

```powershell
cd F:\qysc_project\MY\online_exe
node -v          # 必须 v22 或更高
npm test         # 期望最后一行：全部通过：74 条断言
```

- 绿了 → 接口层没问题，去第 3 节开始手工验收
- 红了一 → 先修。失败项会打印用例名，对到本文对应编号排查

> `npm test` 用临时目录，不碰你的 `data\`，可以反复跑。

---

## 1. 准备

### 1.1 PowerShell 三个必知事项

| # | 坑                                                                 | 正确写法                                           |
| - | ----------------------------------------------------------------- | ---------------------------------------------- |
| 1 | **`curl` 在 PowerShell 里是 `Invoke-WebRequest` 的别名**，`-F`、`-w` 全都不认 | 一律写 **`curl.exe`**                             |
| 2 | PS 5.1 不支持 `&&`、`? :`、`??`                                        | 多条命令用 `;` 分隔或分行写                               |
| 3 | 换行续行符是**反引号** `` ` ``，不是 `\`                                      | 行尾写一个 `` ` ``                                  |
| 4 | 给原生程序传**带引号的 JSON**，PS 5.1 会把引号吃掉                                 | body 先写文件，再用 `--data-binary "@文件"`（D-05 有现成写法） |

本文的两种取数方式分工是固定的：

| 用途                           | 用什么                 | 原因                                  |
| ---------------------------- | ------------------- | ----------------------------------- |
| 带 `-F` 上传、看状态码、看原始 body      | `curl.exe`          | `Invoke-RestMethod` 做 multipart 太麻烦 |
| GET 取 JSON、PATCH 传 JSON body | `Invoke-RestMethod` | 直接拿到对象，不用手动解析                       |

### 1.2 中文乱码：只 `chcp` 不够（**必做**）

PS 5.1 有个坑：`chcp 65001` 只改了控制台代码页，**PowerShell 解码原生程序的输出用的是 `[Console]::OutputEncoding`**，两者不是一回事。只 `chcp` 的话，`curl.exe` 返回的中文会被按 GBK 解码，显示成 `娴嬭瘯鍖?exe` ——而服务端存的数据其实是好的。

```powershell
chcp 65001
[Console]::OutputEncoding = [Text.Encoding]::UTF8   # 原生程序输出按 UTF-8 解码
$OutputEncoding = [Text.Encoding]::UTF8             # 传给原生程序的参数按 UTF-8 编码
```

顺带记住：`Get-Content` 默认按 ANSI 读文件，读 JSON 要显式指定：

```powershell
Get-Content F:\tmp\oe-test\releases.json -Encoding UTF8
```

> **判定纪律**：看到乱码先别报 bug。中文文件名/说明的正确性以 `Invoke-RestMethod` 读回的结果为准（它按响应头 `charset=utf-8` 解码，不受控制台影响）。详见 B-12。

### 1.3 准备隔离的测试数据目录

**不要拿 `data\` 直接测**，删版本、删孤儿都是真删。用独立目录：

```powershell
$env:DATA_DIR = "F:\tmp\oe-test"
$env:PORT = "8080"
npm start
```

期望输出：

```
[online-exe] listening http://0.0.0.0:8080  data=F:\tmp\oe-test
```

> 这套环境变量只对**当前这个 PowerShell 窗口**有效，另开窗口要重设。想清除：`Remove-Item Env:DATA_DIR`。
>
> ⚠️ **A-01 会临时把 `DATA_DIR` 改成 `oe-empty`**，测完必须改回 `oe-test`，否则后面 C/D/E/F 组找文件会全部对不上（数据跑到另一个目录去了）。启动日志里那行 `data=...` 就是用来确认这件事的——**每换一次目录都瞄一眼**。

### 1.4 生成测试文件

```powershell
New-Item -ItemType Directory -Force -Path F:\tmp\pkg | Out-Null

# 小文件（几十字节）
Set-Content -Path F:\tmp\pkg\small.bin -Value "hello-exe-1.3.0" -NoNewline -Encoding ascii

# 5MB 随机内容（并发、413 用例用）
$buf = New-Object byte[] 5242880
(New-Object System.Random).NextBytes($buf)
[System.IO.File]::WriteAllBytes("F:\tmp\pkg\5mb.bin", $buf)

# 400MB（大文件与中断用例用；全 0，够用且快）
fsutil file createnew F:\tmp\pkg\400mb.bin 419430400

Get-ChildItem F:\tmp\pkg | Select-Object Name, Length
```

### 1.5 准备演示数据（页面用例需要）

**另开一个 PowerShell 窗口**，同样设好 `DATA_DIR` 再执行：

```powershell
cd F:\qysc_project\MY\online_exe
$env:DATA_DIR = "F:\tmp\oe-test"
npm run seed
```

会生成 8 组合 × 2 版本 + 预发布 + 已撤回 + 缺文件 + 墓碑，共 **20 条**记录。

> ⚠️ `seed` 会同时覆盖 `fixtures\releases.sample.json`，跑完 `git status` 会看到它被改动。  
> 想保留现场先 `git stash`；不想脏就测完按第 14 节还原（**`git checkout --` 会丢掉你自己在这个文件上的改动**，先确认）。

---

## 2. 用例总览

| 组 | 覆盖                    | 条数 | 优先级 |
| - | --------------------- | -- | --- |
| A | 启动 / 健康检查             | 5  | P0  |
| B | 上传（正常 + 边界 + 并发 + 中断） | 14 | P0  |
| C | 列表与筛选                 | 6  | P0  |
| D | 撤回 / 恢复 / 删除墓碑        | 8  | P0  |
| E | 缺文件对账与重传              | 4  | P1  |
| F | 孤儿文件                  | 6  | P1  |
| G | 来源网段限制                | 4  | P1  |
| H | 管理页 UI（浏览器）           | 12 | P0  |
| I | 容器与部署（Linux shell）    | 8  | P1  |

---

## 3. A 组：启动与健康检查

### A-01 空目录首启 P0

**操作**：指向一个全新的空目录启动。

```powershell
$env:DATA_DIR = "F:\tmp\oe-empty"
$env:PORT = "8080"
npm start
```

**期望**：

- 日志出现 `listening http://0.0.0.0:8080  data=F:\tmp\oe-empty`
- 自动生成 `releases.json`、`releases\`、`orphan\` 三样东西

```powershell
Get-Content F:\tmp\oe-empty\releases.json -Encoding UTF8
```

> `-Encoding UTF8` 不能省：去掉它会按 ANSI 读，中文显示成 `鏍稿績鍔涢噺`，看着像文件损坏，其实文件是好的（用 `od -c` 或浏览器打开都能验证）。

内容应为：

```json
{
  "schema": 3,
  "app": { "name": "核心力量", "description": "少儿跑酷客户端" },
  "releases": []
}
```

**测完必须切回主数据目录**，否则后面所有用例都写进 `oe-empty`：

```powershell
# Ctrl+C 停服务，然后
$env:DATA_DIR = "F:\tmp\oe-test"
Get-ChildItem F:\tmp\oe-test\releases.json    # 确认这个目录里是 seed 数据（20 条）
npm start
```

**失败先看**：目录权限；`src/server.js` 的 `initStore()` 把 ENOENT 当成了损坏。

**结果**：☐ 通过　☐ 失败　备注：\__________

### A-02 healthz 正常 P0

```powershell
curl.exe -i http://127.0.0.1:8080/healthz
```

**期望**：

```
HTTP/1.1 200 OK
...
ok
```

**结果**：☐ 通过　☐ 失败　备注：\__________

### A-03 healthz 是真探针 P1

让写盘探针失败，healthz 必须变 503。

**做法一（推荐，任何文件系统都有效）：把数据目录改名**

`storage.probe()` 是往 `DATA_DIR` 写 `.health.tmp`，目录不在了自然写不进去：

```powershell
Rename-Item F:\tmp\oe-test F:\tmp\oe-test-moved
curl.exe -i http://127.0.0.1:8080/healthz
# 期望：503 storage unavailable

Rename-Item F:\tmp\oe-test-moved F:\tmp\oe-test
curl.exe -i http://127.0.0.1:8080/healthz
# 期望：恢复 200 ok
```

这招比改 ACL 好在：不改权限、不用管理员、不依赖盘符格式，改完立刻能恢复。

**做法二（只对 NTFS 有效）：icacls 去写权限**

```powershell
Get-Volume -DriveLetter F | Select-Object DriveLetter, FileSystem
# exFAT / FAT32 上 ACL 不生效：icacls 会显示"成功处理"，但写入照样成功，healthz 还是 200
icacls F:\tmp\oe-test /deny "$($env:USERNAME):(W)"
curl.exe -i http://127.0.0.1:8080/healthz
icacls F:\tmp\oe-test /remove:d "$env:USERNAME"
```

**做法三（最贴近生产）：容器只读挂载，见 I-06**

**结果**：☐ 通过　☐ 失败　备注：\__________

### A-04 端口被占 P2

两个窗口都 `$env:PORT = "8080"` 起服务。

**期望**：第二个进程报 `EADDRINUSE` 并退出，**不能**假装启动成功。

**结果**：☐ 通过　☐ 失败　备注：\__________

### A-05 重启后数据还在 P0

传一个包 → 服务窗口按 `Ctrl+C` → 重新 `npm start` → 再查列表。

```powershell
(Invoke-RestMethod http://127.0.0.1:8080/api/releases).releases |
  Select-Object version, platform, arch, sha256
```

**期望**：记录还在，`sha256` 与停止前一致。

**结果**：☐ 通过　☐ 失败　备注：\__________

---

## 4. B 组：上传

> 下面统一用 `curl.exe`。文件路径用**正斜杠**（`F:/tmp/...`），避免反斜杠被当成转义。

### B-01 正常上传 P0

```powershell
curl.exe -i -X POST "http://127.0.0.1:8080/api/releases?version=1.3.0&platform=windows10&arch=x64" `
  -F "changelog=fix login crash" `
  -F "file=@F:/tmp/pkg/small.bin"
```

**期望**：`201`，body 里：

| 字段                              | 期望值                           |
| ------------------------------- | ----------------------------- |
| `version` / `platform` / `arch` | `1.3.0` / `windows10` / `x64` |
| `sha256`                        | 64 位小写 hex，与 B-02 一致          |
| `size`                          | 15（`hello-exe-1.3.0` 共 15 字节，别按 16 判）    |
| `download_url`                  | `/dl/1.3.0/windows10-x64`     |
| `status` / `file_missing`       | `active` / `false`            |
| `uploaded_ip`                   | 本机访问就是 `127.0.0.1`；从另一台机器访问才应是那台的内网 IP；容器里看到 `172.17.0.x` 说明源 IP 被改写   |

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-02 sha256 与本地一致 P0

```powershell
(Get-FileHash F:\tmp\pkg\small.bin -Algorithm SHA256).Hash.ToLower()
```

与 B-01 响应里的 `sha256` **逐字符对比**。不一致说明传输或哈希实现有问题，后面所有用例都别做了。

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-03 磁盘落点正确 P0

```powershell
# 只看这一个文件，别列整个 releases/ —— 有 seed 数据时那儿本来就有一堆包
$p = "F:\tmp\oe-test\releases\1.3.0\windows10-x64\package.bin"
Get-Item $p | Select-Object FullName, Length      # 期望 Length = 15
Get-ChildItem -Recurse F:\tmp\oe-test\releases -Filter *.tmp    # 期望：无输出
```

**期望**：
- 该路径存在，`Length` 与 B-01 响应里的 `size` 一致（15）
- 全库**没有任何 `.tmp`**

> 前面跑过 `npm run seed` 的话，`releases\` 下会有 19 个 `package.bin`，那是正常的，不要按「只有一条」判。

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-04 元数据在 query，字段顺序无关 P1

把 `-F file` 放到最前面：

```powershell
curl.exe -X POST "http://127.0.0.1:8080/api/releases?version=1.4.0&platform=linux&arch=x64" `
  -F "file=@F:/tmp/pkg/small.bin" `
  -F "changelog=file-first-order"
```

**期望**：`201`；再查列表，`1.4.0 / linux / x64` 这条的 `changelog` 是 `file-first-order`（说明确实不依赖 multipart 顺序）。

```powershell
(Invoke-RestMethod "http://127.0.0.1:8080/api/releases?platform=linux").releases |
  Where-Object version -eq '1.4.0' | Select-Object version, changelog
```

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-05 同版本重复上传 409 P0

再执行一次 B-01 的命令。

**期望**：`409`，body：

```json
{ "error": "1.3.0 / windows10 / x64 已存在，请改用新版本号", "existing": { "...": "完整记录" } }
```

磁盘上不能多出任何文件——**先记数，再重传，再比对**（不同机器已有条数不同，别按绝对值判）：

```powershell
$before = (Get-ChildItem -Recurse F:\tmp\oe-test\releases -File -Filter package.bin).Count
# 重新执行上面的重复上传（期望 409）
$after  = (Get-ChildItem -Recurse F:\tmp\oe-test\releases -File -Filter package.bin).Count
"before=$before after=$after  没变？$($before -eq $after)"
```

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-06 Win7 / Win10 同版本共存 P0

```powershell
curl.exe -X POST "http://127.0.0.1:8080/api/releases?version=1.3.0&platform=windows7&arch=x64" `
  -F "file=@F:/tmp/pkg/small.bin"
```

**期望**：`201`。这是常态不是重复——Win7 和 Win10 是两个独立平台。

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-07 并发上传同一版本 P0（硬伤）

```powershell
$jobs = 1..2 | ForEach-Object {
  Start-Job -ScriptBlock {
    curl.exe -s -o NUL -w '%{http_code}' -X POST `
      "http://127.0.0.1:8080/api/releases?version=2.0.0&platform=linux&arch=x64" `
      -F "file=@F:/tmp/pkg/5mb.bin"
  }
}
$codes = $jobs | Wait-Job | Receive-Job
$jobs | Remove-Job
"返回码：$($codes -join ',')"
```

**期望**：`201,409` 或 `409,201`（顺序不定）。  
**绝不能两个都 201**——那说明 `inflight` 占位失效，磁盘上两份内容却只有一条记录。

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-08 并发上传 8 个不同平台 P1

```powershell
$combos = @(
  @("windows7","x64"),  @("windows7","ia32"),
  @("windows10","x64"), @("windows10","ia32"),
  @("macos","arm64"),   @("macos","x64"),
  @("linux","x64"),     @("linux","arm64")
)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$jobs = foreach ($c in $combos) {
  Start-Job -ScriptBlock {
    param($p, $a)
    curl.exe -s -o NUL -w '%{http_code}' -X POST `
      "http://127.0.0.1:8080/api/releases?version=3.0.0&platform=$p&arch=$a" `
      -F "file=@F:/tmp/pkg/5mb.bin"
  } -ArgumentList $c[0], $c[1]
}
$codes = $jobs | Wait-Job | Receive-Job
$jobs | Remove-Job
$sw.Stop()
"返回码：$($codes -join ',')  总耗时：$([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒"
```

**期望**：8 个全是 `201`；总耗时接近**单个包**的时间，不是 8 倍（说明没被串行化）。

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-09 非法版本号 400 P0

```powershell
curl.exe -i -X POST "http://127.0.0.1:8080/api/releases?version=1.3&platform=linux&arch=x64" `
  -F "file=@F:/tmp/pkg/small.bin"
```

**期望**：`400` + `{"error":"版本号格式不合法，应为 MAJOR.MINOR.PATCH[-prerelease]"}`。

注意：`v1.3.0` 是**合法**的（前缀会被剥掉），`1.3` 才不合法。顺手验一次：

```powershell
curl.exe -s -X POST "http://127.0.0.1:8080/api/releases?version=v1.5.0&platform=linux&arch=x64" `
  -F "file=@F:/tmp/pkg/small.bin" | ConvertFrom-Json | Select-Object version
# 期望 version = 1.5.0（没有 v）
```

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-10 白名单外的平台组合 400 P0

```powershell
curl.exe -i -X POST "http://127.0.0.1:8080/api/releases?version=1.6.0&platform=windows10&arch=arm64" `
  -F "file=@F:/tmp/pkg/small.bin"
```

**期望**：`400` + `{"error":"平台与架构组合不受支持：windows10-arm64"}`（文案要带出具体组合）。

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-11 没有文件 / 两个文件 P0

```powershell
# 只带字段、不带文件
curl.exe -i -X POST "http://127.0.0.1:8080/api/releases?version=1.7.0&platform=linux&arch=x64" `
  -F "changelog=no-file-here"
# 期望 400「请求中没有文件，请用 file 字段上传」

# 两个 file part
curl.exe -i -X POST "http://127.0.0.1:8080/api/releases?version=1.7.0&platform=linux&arch=x64" `
  -F "file=@F:/tmp/pkg/small.bin" `
  -F "file=@F:/tmp/pkg/5mb.bin"
# 期望 400「一次只能上传一个文件」
```

第二条尤其重要——**不能静默只存第一个**。

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-12 中文文件名不乱码 P1

```powershell
Copy-Item F:\tmp\pkg\small.bin "F:\tmp\pkg\测试包.exe" -Force

# 1) 上传（这里用 curl.exe 发，中文路径 PS 5.1 一般能正确处理）
curl.exe -s -o NUL -w 'upload=%{http_code}' -X POST `
  "http://127.0.0.1:8080/api/releases?version=1.8.0&platform=windows10&arch=x64" `
  -F "file=@F:/tmp/pkg/测试包.exe"

# 2) ★ 用 Invoke-RestMethod 读回判定（它按响应头 charset=utf-8 解码，不受控制台影响）
(Invoke-RestMethod "http://127.0.0.1:8080/api/releases?platform=windows10").releases |
  Where-Object version -eq '1.8.0' | Select-Object filename

# 3) 双保险：直接看磁盘上的 JSON（必须加 -Encoding UTF8）
Select-String -Path F:\tmp\oe-test\releases.json -Pattern '1\.8\.0' -Context 0,6 |
  Out-String -Width 200
```

**期望**：`filename` = `测试包.exe`。

**关键**：判定必须走 `Invoke-RestMethod` 或 `Get-Content -Encoding UTF8`。
如果用 `curl.exe ... | ConvertFrom-Json` 看到 `娴嬭瘯鍖?exe` / `æµ‹è¯•åŒ….exe`，**那是 PowerShell 解码显示的问题，不是服务端的 bug**——
判别方法：直接读 `releases.json`（加 `-Encoding UTF8`），里面的 `filename` 是对的，就说明只是显示问题。

> 两种情况下这条会「失败」但服务端没问题：① 没做 §1.2 的 `[Console]::OutputEncoding` 设置；② 用 `curl.exe | ConvertFrom-Json` 判定。
> 真正要报 bug 的判据是：`Invoke-RestMethod` 读回也是乱码，或磁盘 JSON 里就是乱码。

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-13 超过 MAX_UPLOAD_MB → 413 P1

**操作**：停掉服务，把上限改成 1MB 再起。

```powershell
$env:MAX_UPLOAD_MB = "1"
npm start
```

另一个窗口用 5MB 文件上传：

```powershell
curl.exe -i -X POST "http://127.0.0.1:8080/api/releases?version=1.9.0&platform=linux&arch=x64" `
  -F "file=@F:/tmp/pkg/5mb.bin"
```

**期望**：

- `413` + `{"error":"文件超过单包上限 1MB"}`
- 目录里**不留 `.tmp`**：`Get-ChildItem -Recurse F:\tmp\oe-test\releases -Filter *.tmp` 无输出
- 紧接着 `curl.exe -i http://127.0.0.1:8080/healthz` 仍 `200`（进程没被打死）

测完 `Remove-Item Env:MAX_UPLOAD_MB` 并重启。

**结果**：☐ 通过　☐ 失败　备注：\__________

### B-14 上传中途断开，服务不退出 P0（硬伤）

> ⚠️ **前置检查**：如果你刚改过 `MAX_UPLOAD_MB=1`，必须先 `Remove-Item Env:MAX_UPLOAD_MB` 并**重启服务**。
> 否则 400MB 会在几秒内直接 413，根本没有「中途断开」这回事，测了等于没测。
> 重启后先 `curl.exe -s -o NUL -w '%{http_code}' .../healthz` 确认服务在，再看日志首行 `data=` 是不是 `oe-test`。

```powershell
# 后台起一个限速上传（400MB 约需 7 分钟，留足打断时间）
$j = Start-Job -ScriptBlock {
  curl.exe --limit-rate 1M -X POST `
    "http://127.0.0.1:8080/api/releases?version=9.9.9&platform=linux&arch=x64" `
    -F "file=@F:/tmp/pkg/400mb.bin"
}
Start-Sleep -Seconds 3
Stop-Job $j; Remove-Job $j -Force
Start-Sleep -Seconds 2

curl.exe -s -o NUL -w 'healthz=%{http_code}' http://127.0.0.1:8080/healthz
""
Get-ChildItem -Recurse F:\tmp\oe-test\releases -Filter *.tmp -ErrorAction SilentlyContinue
```

**怎么确认这次真的传起来过**（不然可能又是 413 秒退）：

```powershell
# 打断之后，9.9.9 目录不该有完整的 package.bin，也不该留 .tmp
Get-ChildItem -Recurse F:\tmp\oe-test\releases\9.9.9 -ErrorAction SilentlyContinue
(Invoke-RestMethod http://127.0.0.1:8080/api/releases).releases.version   # 期望不含 9.9.9
```

**期望**：

- `healthz=200`
- 服务端日志**没有** `UnhandledPromiseRejection` / `uncaughtException`
- `.tmp` 已被清掉（可能延迟 1–2 秒等 pipeline 收尾）
- 列表里没有 `9.9.9`（半截包不会变成一条记录）

**连做 3 次**，进程必须还活着。这条不过就别上线。

**结果**：☐ 通过　☐ 失败　备注：\__________

---

## 5. C 组：列表与筛选

### C-01 默认列表 P0

```powershell
$r = Invoke-RestMethod http://127.0.0.1:8080/api/releases
"条数：$($r.releases.Count)"
$r.releases | Select-Object version, platform, arch, status, downloads
```

**期望**：

- 按版本号**降序**（不是插入顺序）
- 每项都有 `downloads`（数字）
- **不含** `status=deleted` 的记录

**结果**：☐ 通过　☐ 失败　备注：\__________

### C-02 六种筛选逐个过 P0

```powershell
foreach ($s in 'all','stable','prerelease','yanked','missing','deleted') {
  $x = Invoke-RestMethod "http://127.0.0.1:8080/api/releases?status=$s"
  "{0,-11} {1} 条" -f $s, $x.releases.Count
}
```

**期望**（seed 数据下）：

| status       | 期望                          |
| ------------ | --------------------------- |
| `all`        | 不含墓碑（`deleted`）             |
| `stable`     | 只有 `active` 且非预发布           |
| `prerelease` | 只有预发布（1 条）                  |
| `yanked`     | 只有 `yanked`                 |
| `missing`    | 只有 `file_missing=true`（1 条） |
| `deleted`    | 只有墓碑（1 条）                   |

**结果**：☐ 通过　☐ 失败　备注：\__________

### C-03 平台筛选 P1

```powershell
(Invoke-RestMethod "http://127.0.0.1:8080/api/releases?platform=windows7").releases |
  Select-Object version, platform, arch
```

**期望**：只返回 `platform=windows7` 的记录。

**结果**：☐ 通过　☐ 失败　备注：\__________

### C-04 非法 status 必须 400 P0

```powershell
curl.exe -i "http://127.0.0.1:8080/api/releases?status=whatever"
```

**期望**：`400`，文案列出全部可选值。

**关键**：这条以前是「返回全部含墓碑」。若这里返回 200 且能看到 `deleted` 记录，就是老 bug 复发。

**结果**：☐ 通过　☐ 失败　备注：\__________

### C-05 下载计数 P1

```powershell
$one = (Invoke-RestMethod "http://127.0.0.1:8080/api/releases?status=stable").releases[0]
"id=$($one.id) downloads=$($one.downloads)"
# 下载一次（走 A 的 /dl 接口）
curl.exe -s -o NUL "http://127.0.0.1:8080$($one.download_url)"
# 等 30 秒（STATS_FLUSH_SEC）或重启服务，再查
Start-Sleep -Seconds 31
(Invoke-RestMethod "http://127.0.0.1:8080/api/releases?status=stable").releases |
  Where-Object id -eq $one.id | Select-Object version, downloads
```

**期望**：对应那条 `downloads` +1。

**结果**：☐ 通过　☐ 失败　备注：\__________

### C-06 排序稳定性 P2

连续取两次列表对比顺序：

```powershell
$a = (Invoke-RestMethod http://127.0.0.1:8080/api/releases).releases.id
$b = (Invoke-RestMethod http://127.0.0.1:8080/api/releases).releases.id
if (Compare-Object $a $b -SyncWindow 0) { "顺序不一致" } else { "顺序一致" }
```

**期望**：`顺序一致`（同版本按 `uploaded_at` 降序兜底）。

**结果**：☐ 通过　☐ 失败　备注：\__________

---

## 6. D 组：撤回 / 恢复 / 删除

先把一个 id 抓到变量里（**下面每条都复用 `$id`，换了窗口要重新取**）：

```powershell
$id = (Invoke-RestMethod "http://127.0.0.1:8080/api/releases?status=stable").releases[0].id
"id = $id"
```

### D-01 撤回（PATCH 形态）P0

```powershell
$r = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/releases/$id" `
  -Method Patch -ContentType "application/json" -Body '{"status":"yanked"}'
"status = $($r.status)"
```

**期望**：`status = yanked`；文件**仍在**磁盘上（撤回不删文件）。

> 万一 `-Method Patch` 在你的 PS 版本上报「找不到方法」，改用 D-05 的 body 文件 + `curl.exe` 写法，效果一样。

```powershell
Test-Path "F:\tmp\oe-test\releases\$($r.version)\$($r.platform)-$($r.arch)\package.bin"
# 期望 True
```

**结果**：☐ 通过　☐ 失败　备注：\__________

### D-02 撤回（冻结表 POST 别名）P0

```powershell
curl.exe -s -X POST "http://127.0.0.1:8080/api/releases/$id/yank" | ConvertFrom-Json |
  Select-Object version, status
```

**期望**：`status = yanked`，与 D-01 结果一致（两条路由是同一份实现）。

**结果**：☐ 通过　☐ 失败　备注：\__________

### D-03 撤回幂等 P1

对已 `yanked` 的记录再 `yank` 一次。

**期望**：仍 `200`、`status` 还是 `yanked`，不报错、不写坏 JSON。

**结果**：☐ 通过　☐ 失败　备注：\__________

### D-04 恢复 P0

```powershell
curl.exe -s -X POST "http://127.0.0.1:8080/api/releases/$id/unyank" | ConvertFrom-Json |
  Select-Object version, status
```

**期望**：`status = active`。

**结果**：☐ 通过　☐ 失败　备注：\__________

### D-05 PATCH 参数校验 P1

> PS 5.1 有个坑：给原生程序传带引号的 JSON，引号会被吃掉（`'{"a":"b"}'` 到 curl 那儿变成 `{a:b}`）。  
> 所以下面**把 body 先写成文件**，再用 `--data-binary @文件` 发，绕开参数解析。

```powershell
'{"status":"deleted"}' | Set-Content F:\tmp\body-bad.json -Encoding ascii -NoNewline
curl.exe -i -X PATCH "http://127.0.0.1:8080/api/releases/$id" `
  -H "Content-Type: application/json" --data-binary "@F:/tmp/body-bad.json"
# 期望 400「status 只能是 active 或 yanked」

curl.exe -i -X PATCH "http://127.0.0.1:8080/api/releases/not-exist" `
  -H "Content-Type: application/json" --data-binary "@F:/tmp/body-bad.json"
# 期望 404「版本记录不存在」
```

**期望**：`400` 与 `404` 各一条，body 是 `{"error":"…"}`。  
如果 404 那条变成了 400，说明 JSON 没发对（引号被吃了），按上面的写法重来。

**结果**：☐ 通过　☐ 失败　备注：\__________

### D-06 删除是墓碑 P0

```powershell
# 先记下版本/平台/架构，后面要用来查路径
$rel = (Invoke-RestMethod http://127.0.0.1:8080/api/releases).releases |
  Where-Object id -eq $id
$pkg = "F:\tmp\oe-test\releases\$($rel.version)\$($rel.platform)-$($rel.arch)\package.bin"

$d = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/releases/$id" -Method Delete
"status=$($d.status)  file_missing=$($d.file_missing)"
"文件还在吗：$(Test-Path $pkg)"
(Invoke-RestMethod "http://127.0.0.1:8080/api/releases?status=deleted").releases.id -contains $id
```

**期望**：

- `status=deleted`，`file_missing=False`（**不是 True**）
- `文件还在吗：False`（磁盘已删）
- 最后一行 `True`（墓碑记录还在，`status=deleted` 查得到）
- 默认列表（`all`）里**看不到**它

**结果**：☐ 通过　☐ 失败　备注：\__________

### D-07 重复删除 409 P1

```powershell
curl.exe -i -X DELETE "http://127.0.0.1:8080/api/releases/$id"
```

**期望**：`409`「该版本已删除」。

**结果**：☐ 通过　☐ 失败　备注：\__________

### D-08 删除后同版本重传 409 P0（硬伤）

用 D-06 那条记录的版本号重传：

```powershell
curl.exe -i -X POST "http://127.0.0.1:8080/api/releases?version=$($rel.version)&platform=$($rel.platform)&arch=$($rel.arch)" `
  -F "file=@F:/tmp/pkg/small.bin"
```

**期望**：`409`「… 已存在，请改用新版本号」。

这条是墓碑机制存在的唯一理由：**删除后版本号永久作废**。否则「删了再传」等于给同一个 URL 换内容，`immutable` 缓存和版本追溯同时失效。

**结果**：☐ 通过　☐ 失败　备注：\__________

---

## 7. E 组：缺文件对账与重传

### E-01 手工删文件 → 重启 → 标 file_missing P0

```powershell
# 1. 挑一条 active 且文件存在的记录
$e = (Invoke-RestMethod "http://127.0.0.1:8080/api/releases?status=stable").releases[0]
$ePath = "F:\tmp\oe-test\releases\$($e.version)\$($e.platform)-$($e.arch)\package.bin"
"目标：$($e.version) / $($e.platform) / $($e.arch)  id=$($e.id)"

# 2. 删掉它的文件
Remove-Item $ePath -Force

# 3. 重启服务（回到服务窗口按 Ctrl+C，再 npm start）

# 4. 查缺文件列表
(Invoke-RestMethod "http://127.0.0.1:8080/api/releases?status=missing").releases |
  Select-Object version, platform, arch, status, file_missing
```

**期望**：

- 这条出现在 `missing` 列表里
- `file_missing = True`
- **`status` 仍是 `active`**（对账只动文件事实，不动发版人意图）

**结果**：☐ 通过　☐ 失败　备注：\__________

### E-02 缺文件记录允许同版本重传 P0

```powershell
$fix = curl.exe -s -X POST "http://127.0.0.1:8080/api/releases?version=$($e.version)&platform=$($e.platform)&arch=$($e.arch)" `
  -F "file=@F:/tmp/pkg/5mb.bin" | ConvertFrom-Json
"新 id=$($fix.id)  原 id=$($e.id)  相同？$($fix.id -eq $e.id)"
"file_missing=$($fix.file_missing)  size=$($fix.size)"
```

**期望**：`201`（**不是 409**）；`id` **与原来完全一样**（`stats.json` 的 key 不能换，否则下载计数归零）；`file_missing=False`；`size=5242880`。

**结果**：☐ 通过　☐ 失败　备注：\__________

### E-03 已撤回 + 缺文件：恢复必须 409 P1

```powershell
# 1. 撤回
curl.exe -s -X POST "http://127.0.0.1:8080/api/releases/$($e.id)/yank" | Out-Null
# 2. 删文件
Remove-Item "F:\tmp\oe-test\releases\$($e.version)\$($e.platform)-$($e.arch)\package.bin" -Force
# 3. 重启服务
# 4. 尝试恢复
curl.exe -i -X POST "http://127.0.0.1:8080/api/releases/$($e.id)/unyank"
# 5. 确认状态没被改回 active
(Invoke-RestMethod "http://127.0.0.1:8080/api/releases?status=yanked").releases |
  Where-Object id -eq $e.id | Select-Object version, status, file_missing
```

**期望**：`409`「文件缺失，请先重新上传后再恢复」；记录仍是 `yanked` + `file_missing=True`（**不能变回 active**）。

**结果**：☐ 通过　☐ 失败　备注：\__________

### E-04 墓碑不参与对账 P1

删掉一个已删除版本的文件（本来就不存在），重启。

**期望**：墓碑的 `file_missing` **必须仍是 `False`**。

```powershell
(Invoke-RestMethod "http://127.0.0.1:8080/api/releases?status=deleted").releases |
  Select-Object version, status, file_missing
```

若变成 `True`，说明对账没跳过墓碑，查重会放行，**不可变保护被击穿**。

**结果**：☐ 通过　☐ 失败　备注：\__________

---

## 8. F 组：孤儿文件

### F-01 造孤儿 → 重启 → 移入 orphan P1

```powershell
New-Item -ItemType Directory -Force -Path F:\tmp\oe-test\releases\7.7.7\linux-x64 | Out-Null
Set-Content -Path F:\tmp\oe-test\releases\7.7.7\linux-x64\package.bin -Value "orphan-bytes" -NoNewline

# 重启服务
Get-ChildItem F:\tmp\oe-test\orphan -File | Select-Object Name, Length
Test-Path F:\tmp\oe-test\releases\7.7.7\linux-x64\package.bin    # 期望 False
```

**期望**：文件被**移动**（不是删除）到 `orphan\`，名字形如 `7.7.7__linux-x64__package.bin.1762300000000`。

**结果**：☐ 通过　☐ 失败　备注：\__________

### F-02 接口能列出孤儿 P0

```powershell
$o = Invoke-RestMethod http://127.0.0.1:8080/api/orphans
"count=$($o.count)  bytes=$($o.bytes)"
$o.orphans | Select-Object path, size, mtime
```

**期望**：`count` 与实际文件数一致；`path` 用**正斜杠**、不带 `orphan/` 前缀。

**结果**：☐ 通过　☐ 失败　备注：\__________

### F-03 删单个 P0

```powershell
$target = $o.orphans[0].path
curl.exe -s -X DELETE "http://127.0.0.1:8080/api/orphans?path=$target"
""
(Invoke-RestMethod http://127.0.0.1:8080/api/orphans).count
```

**期望**：返回 `{"removed":1,"bytes":…,"path":"…"}`；再查 `count` 少一个。

**结果**：☐ 通过　☐ 失败　备注：\__________

### F-04 路径穿越必须 400 P0（安全）

```powershell
curl.exe -i -X DELETE "http://127.0.0.1:8080/api/orphans?path=../releases.json"
curl.exe -i -X DELETE "http://127.0.0.1:8080/api/orphans?path=/windows/win.ini"
Test-Path F:\tmp\oe-test\releases.json    # 期望 True：文件还在
```

**期望**：两条都 `400` + `{"error":"path 非法：必须位于 data/orphan/ 之内"}`。

**结果**：☐ 通过　☐ 失败　备注：\__________

### F-05 删除不存在 / 空 path P1

```powershell
curl.exe -i -X DELETE "http://127.0.0.1:8080/api/orphans?path=nope.bin"   # 404
curl.exe -i -X DELETE "http://127.0.0.1:8080/api/orphans?path="           # 400
```

**期望**：`404`「该孤儿文件不存在（可能已被删除）」；`400`「path 不能为空」。

**结果**：☐ 通过　☐ 失败　备注：\__________

### F-06 清空 P0

```powershell
curl.exe -s -X DELETE http://127.0.0.1:8080/api/orphans
""
(Invoke-RestMethod http://127.0.0.1:8080/api/orphans).count     # 期望 0
Test-Path F:\tmp\oe-test\orphan                                 # 期望 True（目录重建过）
```

**期望**：返回 `{"removed":N,"bytes":X}`；`count=0`；`orphan\` 目录**仍存在**，不影响下次对账。

**结果**：☐ 通过　☐ 失败　备注：\__________

---

## 9. G 组：来源网段限制

**另开一个 PowerShell 窗口**，白名单设成**不含本机**的网段：

```powershell
cd F:\qysc_project\MY\online_exe
$env:DATA_DIR = "F:\tmp\oe-cidr"
$env:PORT = "8081"
$env:ADMIN_ALLOW_CIDR = "10.99.0.0/16"
npm start
```

### G-01 网段外访问接口 403 P0

在**另一个**窗口：

```powershell
curl.exe -i http://127.0.0.1:8081/api/releases
```

**期望**：`403`，**JSON**：

```json
{ "error": "该来源网段无权访问管理页" }
```

> 必须是 JSON。以前是纯文本，CI 里 `JSON.parse` 会抛错，排查方向被带偏成「服务挂了」。


**结果**：☐ 通过　☐ 失败　备注：__________

### G-02 管理页也 403 P0

浏览器打开 `http://127.0.0.1:8081/admin`。

**期望**：403，页面上显示那段 JSON 文本（不是白屏、不是 500）。

**结果**：☐ 通过　☐ 失败　备注：__________

### G-03 healthz 不受限 P0

```powershell
curl.exe -i http://127.0.0.1:8081/healthz
```

**期望**：`200`。受限的话 Docker 会一直把容器标成 unhealthy。

**结果**：☐ 通过　☐ 失败　备注：__________

### G-04 网段放行后恢复正常 P1

关掉窗口重开，改成 `127.0.0.1/32`：

```powershell
$env:ADMIN_ALLOW_CIDR = "127.0.0.1/32"
```

重新 `npm start`，再访问 `/api/releases`。

**期望**：`200`。若仍 403，检查 `remoteAddress` 是不是 `::ffff:127.0.0.1`（双栈监听）或容器端口映射改了源 IP。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 10. H 组：管理页 UI（Chrome / Edge）

浏览器打开 `http://127.0.0.1:8080/admin`，用 1.5 的 seed 数据。逐条打勾。

### H-01 状态条 P0

| 检查项 | 期望 | 结果 |
|---|---|---|
| 磁盘可用 / 总量 | 与 `Get-PSDrive F` 的 `Free` 量级一致 | ☐ |
| 版本总数 | **不含墓碑**（删一个版本后刷新，数字要变小） | ☐ |
| 占用合计 | 不含墓碑、缺文件按 0 计 | ☐ |
| 孤儿文件 | 显示「N 个 / X MB」+「查看」按钮 | ☐ |

### H-02 上传区交互 P0

| 检查项 | 操作 | 期望 | 结果 |
|---|---|---|---|
| 平台下拉 | 逐一切换 | 架构选项跟着变（Win7 只有 x64/ia32，macOS 是 arm64/x64，Linux 是 x64/arm64） | ☐ |
| 渠道标签 | 填 `1.4.0` | 显示「正式」 | ☐ |
| 渠道标签 | 填 `1.4.0-beta.1` | 显示「预发布 Beta」并变橙 | ☐ |
| 覆盖度 | 填已发过的版本号 | 「已覆盖 N/8 组合，缺少：…」 | ☐ |
| 覆盖度 | 填没发过的版本号 | 「尚未覆盖任何组合（共 8 组）」 | ☐ |
| 拖拽 | 拖文件进虚线框 | 框变蓝，显示「文件名 · 大小」 | ☐ |
| 进度条 | 传 400MB | 有百分比、已传/总量、速率 | ☐ |
| **中文文件名** | 拖 `测试包.exe` 上传 | 列表里文件名不乱码（B-12 的浏览器版） | ☐ |

### H-03 上传成功 P0

传一个新版本。

**期望**：进度到 100% → 提示「已发布 x / 平台 / 架构」+ sha256 前 8 位 → 页面**自动刷新** → 新行**高亮 3 秒**（淡黄底）→ 再刷新高亮消失。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-04 409 自动 +1 P0

传一个已存在的版本（如 `1.3.0 / windows10 / x64`）。

**期望**：红色提示「…已存在，请改用新版本号」，**版本号输入框自动变成 `1.3.1`**，覆盖度提示同步刷新。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-05 表单记忆 P1

填好「版本号 + 平台 + 架构」后按 `F5`。

**期望**：三个字段都还在（`sessionStorage`，关标签页才清）。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-06 按钮矩阵 P0（重点）

用 seed 数据分别看这 5 种行，**按钮按组合给，不是每行一套**：

| 行状态 | 该有的按钮 | 不该有的 | 结果 |
|---|---|---|---|
| `active` + 文件在 | 撤回 / 删除 | 恢复、重新上传 | ☐ |
| `active` + 缺文件 | 重新上传 / 删除 | 撤回 | ☐ |
| `yanked` + 文件在 | 恢复 / 删除 | 撤回、重新上传 | ☐ |
| `yanked` + 缺文件 | 重新上传 / **灰掉的恢复** / 删除 | 可点的恢复 | ☐ |
| `deleted`（墓碑） | 只有「—」 | 任何按钮 | ☐ |

灰掉的「恢复」鼠标悬停要有提示：「文件缺失：请先用『重新上传』补齐同版本文件，再恢复」。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-07 撤回 / 恢复 P0

点「撤回」→ 行**原地**变成「已撤回」徽章，行闪一下黄色，**页面不刷新、不跳回顶部**；点「恢复」→ 原地变回「在架」。

三个判定点：

| 检查 | 期望 | 结果 |
|---|---|---|
| 不弹确认框（撤回可逆） | 单击直接生效 | ☐ |
| **页面不刷新** | 滚动条位置不动，筛选条件不变 | ☐ |
| 当前筛选是「正式」/「预发布」时撤回 | 行**淡化但仍在**，鼠标悬停提示「已撤回，不在当前筛选内，刷新后不再显示」 | ☐ |

> 以前是整页刷新：既把滚动打回顶部，又因为重新过滤让撤回的行在「正式」筛选下消失，看着像被删了。现在改成行内更新，就是为了让「撤回」这个动作用户当场看得见。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-08 删除二次确认 P0

点「删除」→ 弹一个确认框（**不需要输入任何东西**），文案必须写清三件事：

```
确定删除 1.3.0（Windows 10 / 11 · 64 位 (x64)）？

· 文件立即从磁盘删除，不可恢复
· 该版本号作废，以后不能再上传同版本号
· 如果只是想下架，请点「撤回」——撤回可逆，文件也保留
```

| 操作 | 期望 | 结果 |
|---|---|---|
| 点取消 | 什么都不发生，行还在 | ☐ |
| 点确定 | 行**直接从表格消失，不整页刷新、滚动不动**；状态条「版本总数」-1、「占用合计」减去该包大小 | ☐ |
| 切到「已删除」筛选 | 能查到墓碑 | ☐ |
| 删完再传同版本号 | 409（版本号已作废） | ☐ |

核对点：弹框里的**版本号 + 平台 + 架构**要和点的那一行完全一致——这是替代「手打版本号」的唯一防呆手段，写错了就等于没有确认。

### H-09 筛选 P0

平台下拉 + 状态下拉（全部/正式/预发布/已撤回/缺文件/已删除），选完**立刻生效**。

筛选是**纯前端显隐**，不再提交表单、不刷新页面。判定如下：

| 检查 | 期望 | 结果 |
|---|---|---|
| 切换筛选 | 行**瞬间**显示/隐藏，地址栏同步变成 `/admin?status=…&platform=…` | ☐ |
| 切换筛选 | **页面绝对不动**：不闪白、不回到顶部、不抖动 | ☐ |
| 页面只有几行时切筛选 | 滚动条不出现/消失导致的横向位移**不存在**（滚动条常驻） | ☐ |
| 连切 5 次 | 每次结果一致，无闪烁 | ☐ |
| 刷新页面（F5） | 仍停在同一筛选结果（服务端按 URL 参数渲染） | ☐ |
| 手改 URL `?status=乱写` 回车 | 回落成「全部」，不报错、不白屏 | ☐ |
| 筛选后一行不剩 | 显示「当前筛选下没有版本。」而不是只剩表头 | ☐ |

> 如果切换时页面还是重新加载（浏览器转圈、滚动条跳回顶部），说明 `admin.js` 没加载成功——F12 → Network 看 `/admin.js` 是不是 200。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-10 孤儿面板 P0

点状态条「孤儿文件 → 查看」。

**期望**：
- 首次点击才发请求（F12 → Network 里能看到 `GET /api/orphans`）
- 表格列出 路径 / 大小 / 移入时间 / 操作
- 点「删除」有确认框，确认后该行消失，状态条个数同步变小
- 点「收起」再展开，**不重复请求**
- 「全部清理」二次确认后整页刷新，数字归 0

**结果**：☐ 通过　☐ 失败　备注：__________

### H-11 清理建议 P1

滚到底部「清理建议」。

**期望**：按**组合**（8 个）列出超出 `KEEP_PER_PLATFORM=5` 的旧包，按占用降序，**只有列表没有删除按钮**（版本包不可再生，不能自动删）。

**结果**：☐ 通过　☐ 失败　备注：__________

### H-12 IE 兜底 P1

没有 IE11 就用 DevTools 模拟，Console 执行：

```javascript
document.documentElement.className = 'ie-blocked'
// 期望：正常内容整体隐藏，只剩一行「请用 Chrome / Edge 打开本页」
document.documentElement.className = 'js-ok'   // 恢复
```

真 IE11（Win7 机器）留到交叉验收。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 11. I 组：容器与部署

> **这一组在 Linux 服务器上执行，命令是 bash**，不是 PowerShell。Windows 本机跑 Docker Desktop 时把 `/srv/online_exe/data` 换成你的挂载目录即可。

### I-01 镜像能构建 P0

```bash
cd /path/to/online_exe
docker build -t online-exe:1.0.0 .
docker images | grep online-exe
```

**期望**：构建成功；体积约 140MB 量级（`node:24-alpine` 基础层占大头）。
镜像里跑的是 `node src/server.js`（Dockerfile 的 `CMD`）。

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

从别处传一个包，然后：

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
# 终端 1：限速传 400MB（约 7 分钟）
curl --limit-rate 1M -X POST \
  "http://127.0.0.1:8080/api/releases?version=9.8.0&platform=linux&arch=x64" \
  -F "file=@/tmp/pkg/400mb.bin"
# 终端 2：传了 30 秒后
docker stop online-exe
```

**期望**：
- 容器等上传结束（或 30 秒超时）才退出，日志出现 `[shutdown] 收到 SIGTERM`
- `stats.json` 计数没丢
- **不是**立刻断开（默认只等 10 秒就是没配 `stop_grace_period: 45s`）

**结果**：☐ 通过　☐ 失败　备注：__________

### I-08 源 IP 真实 P0

```bash
docker exec -it online-exe node -e "require('http').createServer((q,s)=>{console.log(q.socket.remoteAddress);s.end()}).listen(9999)"
# 另一台内网机器上：curl http://<服务器IP>:9999
```

**期望**：打印那台机器的真实 IP，**不是** `172.17.0.1`。
再传一个包，检查 `uploaded_ip` 与之一致。

**结果**：☐ 通过　☐ 失败　备注：__________

---

## 12. 结果记录表

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
| B-12 | 中文文件名 | | |
| B-13 | 超限 413 | | |
| B-14 | 中断不断进程 | | |
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

共 67 条。

---

## 13. 排错速查

| 症状 | 先查什么 | 常见原因 |
|---|---|---|
| 中文全变成 `鏍稿績鍔涢噺` / `娴嬭瘯鍖?` | 有没有设 `[Console]::OutputEncoding`；`Get-Content` 加没加 `-Encoding UTF8` | PS 5.1 的解码问题，**数据本身没坏**（见 §1.2 / B-12） |
| `icacls` 显示"成功处理"但 healthz 仍 200 | `Get-Volume -DriveLetter F \| Select FileSystem` | exFAT/FAT32 上 ACL 不生效，改用 A-03 做法一（改名） |
| 后面用例的文件路径全对不上 | 启动日志那行 `data=` | A-01 用完没把 `DATA_DIR` 切回 `oe-test` |
| `curl` 报「参数无法识别」 | 是不是写了 `curl` | PowerShell 里必须 `curl.exe` |
| 启动崩，`ERR_MODULE_NOT_FOUND` | 是不是手敲了 `node server.js` | 用 `npm start`（内部是 `node src/server.js`） |
| 启动崩，`Cannot find package 'express'` | `node_modules` 在不在 | 先 `npm ci` |
| 上传 403 | `ADMIN_ALLOW_CIDR` | 本机或**构建机**网段没进白名单 |
| 上传 500「创建存储目录失败」 | `Get-Acl F:\tmp\oe-test` | 目录权限不对 / 属主不是容器内 `node`(1000) |
| 上传 500「写盘失败（ENOSPC）」 | `Get-PSDrive F` | 磁盘或 inode 满 |
| 上传 507 | 剩余空间 + 并发数 | 8 个 400MB 同时传要预留 3.5GB |
| 上传卡住不返回，healthz 还正常 | `docker logs` 有无 `UnhandledPromiseRejection` | 失败路径漏了 `.catch`，按 bug 处理 |
| 大文件传到一半断 | 服务怎么起的 | `requestTimeout` 没关成 `0`（Node 默认 300s） |
| 页面时间差 8 小时 | 容器里 `date` | 没装 tzdata 或没传 `TZ` |
| 管理页全 403 但日志 IP 看着对 | `uploaded_ip` 是不是一堆 `172.17.0.x` | Docker bridge 改了源 IP，改 `network_mode: host` |
| 改了 CSS/JS 没生效 | `Ctrl+F5` | 静态资源不该设长缓存，确认没加 `immutable` |
| 拖拽上传没反应 | F12 Console 报错 | `admin.js` 没加载，检查 `/admin.js` 是否 200 |
| 孤儿数字一直涨 | `GET /api/orphans` | 有人手工往 `releases/` 塞文件；确认无用后清理 |
| 删掉的版本又冒出来 | `?status=deleted` 查一下 | 正常：墓碑保留，只是默认列表不显示 |
| `Invoke-RestMethod` 抛 403/404 | 换 `curl.exe -i` 看原始响应 | IRM 遇 4xx 直接抛异常，看不到 body |

---

## 14. 测完清理

```powershell
# 还原被 seed 改过的 fixture（先确认这个文件上没有你自己的改动）
git diff --stat fixtures/releases.sample.json
git checkout -- fixtures/releases.sample.json

# 删临时数据目录
Remove-Item -Recurse -Force F:\tmp\oe-test, F:\tmp\oe-cidr, F:\tmp\oe-empty -ErrorAction SilentlyContinue

# 清环境变量
Remove-Item Env:DATA_DIR, Env:PORT, Env:MAX_UPLOAD_MB, Env:ADMIN_ALLOW_CIDR -ErrorAction SilentlyContinue
```

容器测过的再补一句（Linux）：

```bash
docker compose down
```

最后确认 `git status` 只剩你自己的代码改动。

---

## 附录：bash → PowerShell 对照（本项目用得到的部分）

| 用途 | bash | PowerShell |
|---|---|---|
| 设环境变量 | `export A=b` | `$env:A = "b"` |
| 删环境变量 | `unset A` | `Remove-Item Env:A` |
| 串联命令 | `a && b` | `a; b`（PS 5.1 不支持 `&&`） |
| 续行 | 行尾 `\` | 行尾反引号 |
| 递归删除 | `rm -rf dir` | `Remove-Item -Recurse -Force dir` |
| 列出文件 | `find . -type f` | `Get-ChildItem -Recurse -File` |
| 按名字过滤 | `find . -name "*.tmp"` | `Get-ChildItem -Recurse -Filter *.tmp` |
| 看文本内容 | `cat f` | `Get-Content f` |
| 搜索文本计数 | `grep -c x f` | `(Select-String -Path f -Pattern x).Count` |
| 哈希 | `sha256sum f` | `(Get-FileHash f -Algorithm SHA256).Hash` |
| 造指定大小文件 | `head -c N /dev/zero > f` | `fsutil file createnew f N` |
| 计时 | `time cmd` | `Measure-Command { cmd }` |
| 后台并行 | `cmd &` | `Start-Job { cmd }` + `Wait-Job` |
| 目录权限 | `chmod -R a-w d` | `icacls d /deny "$env:USERNAME:(W)"` |
| 磁盘剩余 | `df -h` | `Get-PSDrive` |
| GET 取 JSON | `curl -s url \| jq` | `Invoke-RestMethod url` |
| 只看状态码 | `curl -s -o /dev/null -w '%{http_code}'` | `curl.exe -s -o NUL -w '%{http_code}'` |
