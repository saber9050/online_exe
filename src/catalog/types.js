// 磁盘结构定义（releases.json 的格式），只给编辑器和 JSDoc 用，不参与运行。
//
// 与 HTTP 响应结构（src/routes/dto.js 的 toReleaseDto）严格分离：
//   - 改这里 = 改 releases.json 的落盘格式，要配 schema 迁移
//   - 改 dto.js = 改接口返回，前端跟着改
// 展示字段（下载链接、平台中文名、格式化后的大小）一律不进这里。

/**
 * 版本状态，表示「发版人的意图」。
 * 文件是否还在磁盘上由 {@link Release.file_missing} 单独表达，两者正交。
 * - `active`  在架
 * - `yanked`  已撤回（文件保留，直链仍可下）
 * - `deleted` 墓碑（文件已删、记录保留，版本号作废）
 * @typedef {'active'|'yanked'|'deleted'} ReleaseStatus
 */

/**
 * 一条版本记录。唯一键是 (platform, arch, version)，不含渠道。
 * @typedef {object} Release
 * @property {string} id           UTC 时间戳 + 8 位随机，同时是 stats.json 的 key
 * @property {string} version      归一化后的 semver（已剥 `v` 前缀）
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {string} prerelease   semver 的 prerelease 段，正式版为空串
 * @property {boolean} is_prerelease  同时承担「渠道」语义：false = 正式版，true = 预发布
 * @property {'windows7'|'windows10'|'macos'|'linux'} platform
 * @property {'x64'|'ia32'|'arm64'} arch
 * @property {string} filename     用户上传时的原始文件名，只用于展示与 Content-Disposition
 * @property {string} object_key   磁盘相对路径，程序生成：`{version}/{platform}-{arch}/package.bin`
 * @property {number} size         实际字节数
 * @property {string} sha256       包内容哈希，同时用作下载 ETag
 * @property {string} changelog    更新说明
 * @property {ReleaseStatus} status
 * @property {boolean} file_missing 对账发现文件不在时为 true
 * @property {string} uploaded_at  ISO 时间，一律 UTC（`Z` 结尾），渲染时按 TZ 转本地
 * @property {string} uploaded_ip  来源 IP，内网无账号，靠这条留痕
 */

/**
 * releases.json 的顶层结构。
 * @typedef {object} ReleaseFile
 * @property {number} schema     当前为 3；大于 3 拒绝启动
 * @property {{ name:string, description:string }} app
 * @property {Release[]} releases
 */

export {}
