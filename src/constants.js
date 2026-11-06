// 平台与架构白名单。Windows 7 与 Windows 10 是两个独立平台，不是同一平台的两种标签。
// 固定 8 个组合，上传时白名单之外一律拒绝。

/**
 * @typedef {{ id:string, label:string, short:string, anchor:string, note?:string,
 * mac?:boolean, arches:Array<{id:string,label:string}> }} PlatformGroup
 */

/** @type {PlatformGroup[]} */
export const PLATFORM_GROUPS = [
  {
    id: 'windows7',
    label: 'Windows 7',
    short: 'Win7',
    anchor: 'win7',
    note: '需 Windows 7 SP1；安装失败请先安装 VC++ 2015-2019 运行库。',
    arches: [
      { id: 'x64', label: '64 位 (x64)' },
      { id: 'ia32', label: '32 位 (x86)' },
    ],
  },
  {
    id: 'windows10',
    label: 'Windows 10 / 11',
    short: 'Win10',
    anchor: 'win10',
    note: 'Windows 10 与 Windows 11 通用。',
    arches: [
      { id: 'x64', label: '64 位 (x64)' },
      { id: 'ia32', label: '32 位 (x86)' },
    ],
  },
  {
    id: 'macos',
    label: 'macOS',
    short: 'macOS',
    anchor: 'macos',
    mac: true,
    arches: [
      { id: 'arm64', label: 'Apple Silicon (arm64)' },
      { id: 'x64', label: 'Intel (x64)' },
    ],
  },
  {
    id: 'linux',
    label: 'Linux',
    short: 'Linux',
    anchor: 'linux',
    arches: [
      { id: 'x64', label: '64 位 (x64)' },
      { id: 'arm64', label: 'ARM64' },
    ],
  },
]

/**
 * 下载页的 OS 大类。Windows 下再分 Win7 / Win10·11 两个子组，
 * macOS 与 Linux 各自只有一个子组，渲染时不再重复子组标题。
 * @typedef {{ id:string, label:string, anchor:string, mac?:boolean, platforms:string[] }} OsFamily
 */

/** @type {OsFamily[]} */
export const OS_FAMILIES = [
  { id: 'windows', label: 'Windows', anchor: 'windows', platforms: ['windows7', 'windows10'] },
  { id: 'macos', label: 'macOS', anchor: 'macos', mac: true, platforms: ['macos'] },
  { id: 'linux', label: 'Linux', anchor: 'linux', platforms: ['linux'] },
]

/** 平台 id → 所属 OS 大类 id */
const PLATFORM_FAMILY = new Map()
for (const f of OS_FAMILIES) {
  for (const p of f.platforms) PLATFORM_FAMILY.set(p, f.id)
}

/** @param {string} platform 返回 'windows' | 'macos' | 'linux'，未知平台返回 '' */
export function osFamilyOf(platform) {
  return PLATFORM_FAMILY.get(platform) || ''
}

/** 8 组合白名单：`platform-arch` */
export const PLATFORM_ARCH_SET = new Set(
  PLATFORM_GROUPS.flatMap((g) => g.arches.map((a) => `${g.id}-${a.id}`)),
)

/** 所有平台 id */
export const PLATFORM_IDS = PLATFORM_GROUPS.map((g) => g.id)

const PLATFORM_LABEL = new Map(PLATFORM_GROUPS.map((g) => [g.id, g.label]))
const ARCH_LABEL = new Map()
for (const g of PLATFORM_GROUPS) {
  for (const a of g.arches) ARCH_LABEL.set(`${g.id}-${a.id}`, a.label)
}

/** @param {string} platform */
export function platformLabel(platform) {
  return PLATFORM_LABEL.get(platform) || platform
}

/** @param {string} platform @param {string} arch */
export function archLabel(platform, arch) {
  return ARCH_LABEL.get(`${platform}-${arch}`) || arch
}

/** @param {string} platform @param {string} arch */
export function comboLabel(platform, arch) {
  return `${platformLabel(platform)} · ${archLabel(platform, arch)}`
}
