// 上传文件类型闸门：只接受「安装包 / 可分发软件产物」，图片、视频、PDF、文档等一律拒绝。
//
// 为什么必须在服务端做：
//   1. <input accept> 只是文件选择器的过滤，拖拽、改后缀、curl 都能绕过去；
//   2. 裸流上传（application/octet-stream）没有可信的 Content-Type，multipart 的
//      Content-Type 也是客户端随便写的，唯一能用的信息只有文件名后缀。
// 所以判定只看后缀，且以这张白名单为准 —— 白名单比黑名单可靠：
// 黑名单永远漏掉新格式，白名单漏了再补一条即可。
//
// 为什么不再「按平台切分」：
//   产物格式本身是跨平台的。Windows 上打的 .zip 绿色包、macOS 临时给的 .tar.gz、
//   Linux 回退的 .zip 都是常态；把白名单绑到平台只会在正常上传时误拒，
//   用户还很难理解「为什么同一个 .tar.gz 换个平台就不行」。
//   平台的职责是决定这条记录归属哪个下载区块，不是决定文件能不能传。

/**
 * 允许上传的安装包后缀（全部平台通用，顺序即管理页的提示顺序）。
 * 判定时统一小写，所以 `.AppImage` / `.EXE` 这类写法同样放行。
 */
export const PACKAGE_EXTS = [
  '.exe',
  '.msi',
  '.msix',
  '.msixbundle',
  '.appx',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
  '.appimage',
  '.run',
  '.sh',
  '.tar.gz',
  '.tar.xz',
  '.tgz',
  '.zip',
  '.7z',
]

/** 展示用的写法：有个别后缀的通行写法带大写，提示文案照通行写法写更像人话 */
const PRETTY = { '.appimage': '.AppImage' }

/** 后缀 → 展示写法 */
export function extLabel(ext) {
  const e = String(ext || '').toLowerCase()
  return PRETTY[e] || e
}

/** 提示文案里的一句话白名单，例如 `.exe / .msi / … / .7z` */
export const PACKAGE_EXT_TEXT = PACKAGE_EXTS.map(extLabel).join(' / ')

/** 紧凑写法（异常提示里用）：`.exe/.msi/…/.7z`，少 30 多个字符，尽量不折行 */
export const PACKAGE_EXT_TEXT_COMPACT = PACKAGE_EXTS.map(extLabel).join('/')

/**
 * 平台 id → 允许的后缀。
 * 现在所有平台共用同一份白名单，保留这个结构是为了不改动调用方的取数方式，
 * 将来真出现「某格式只在某平台成立」的需求时也有地方落。
 * @type {Record<string, string[]>}
 */
export const PACKAGE_EXTS_BY_PLATFORM = {
  windows7: PACKAGE_EXTS,
  windows10: PACKAGE_EXTS,
  macos: PACKAGE_EXTS,
  linux: PACKAGE_EXTS,
}

/** 所有允许的后缀（给前端 <input accept> 用） */
export const ALL_PACKAGE_EXTS = PACKAGE_EXTS

/**
 * 多段后缀必须优先匹配，否则 `x.tar.gz` 会被切成 `.gz`（不在白名单里，误拒）。
 * 顺序按长度从长到短，保证 `.tar.bz2` 不会被 `.bz2` 抢先。
 */
const MULTI_EXTS = ['.tar.gz', '.tar.xz', '.tar.bz2']

/** 明确的「非安装包」类型，只用于把错误提示写得更具体，不参与放行判断 */
const BLOCKED = [
  { label: '图片', exts: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tif', '.tiff', '.heic', '.avif', '.psd', '.raw'] },
  { label: '视频', exts: ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.rmvb', '.3gp'] },
  { label: '音频', exts: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.ape'] },
  { label: '文档', exts: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf', '.odt', '.ods', '.epub'] },
  { label: '源码/网页', exts: ['.js', '.mjs', '.ts', '.jsx', '.vue', '.py', '.java', '.c', '.cpp', '.cs', '.go', '.rs', '.php', '.html', '.htm', '.css', '.json', '.xml', '.yml', '.yaml', '.sql'] },
  { label: '手机安装包', exts: ['.apk', '.ipa', '.aab'] },
  { label: '镜像/虚拟磁盘', exts: ['.iso', '.img', '.vhd', '.vhdx', '.vmdk', '.qcow2'] },
]

const BLOCKED_LABEL = new Map()
for (const group of BLOCKED) {
  for (const ext of group.exts) BLOCKED_LABEL.set(ext, group.label)
}

/**
 * 取文件名后缀（小写，含点）。没有后缀、或以点开头的隐藏文件名一律返回 ''。
 * @param {string} name
 */
export function fileExt(name) {
  const n = String(name || '').trim().toLowerCase()
  if (!n) return ''
  for (const ext of MULTI_EXTS) {
    if (n.endsWith(ext)) return ext
  }
  const dot = n.lastIndexOf('.')
  if (dot <= 0 || dot === n.length - 1) return ''
  return n.slice(dot)
}

/** 后缀 → 人类可读的类型名（图片 / 视频 …），未知返回 '' */
export function blockedLabelOf(ext) {
  return BLOCKED_LABEL.get(String(ext || '').toLowerCase()) || ''
}

/**
 * 校验一个上传文件名是否是可接受的软件安装包。
 * 只认后缀，与平台无关 —— 平台只决定记录归属，不决定能不能传。
 * @param {string|null|undefined} filename 客户端原始文件名
 * @returns {{ ok:true, ext:string } | { ok:false, ext:string, error:string }}
 */
export function validatePackageName(filename) {
  const name = String(filename || '').trim()

  if (!name) {
    return { ok: false, ext: '', error: `缺少文件名，无法判断是否为安装包（仅接受 ${PACKAGE_EXT_TEXT}）` }
  }

  const ext = fileExt(name)
  if (!ext) {
    return { ok: false, ext, error: `文件「${name}」没有扩展名，无法判断是否为安装包（仅接受 ${PACKAGE_EXT_TEXT}）` }
  }
  if (PACKAGE_EXTS.includes(ext)) return { ok: true, ext }

  const label = blockedLabelOf(ext)
  if (label) {
    return { ok: false, ext, error: `不允许上传${label}文件（${ext}），这不是安装包。仅接受 ${PACKAGE_EXT_TEXT}` }
  }
  return { ok: false, ext, error: `不支持的文件类型（${ext}），仅接受 ${PACKAGE_EXT_TEXT}` }
}
