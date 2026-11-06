// 生成演示数据：8 组合 × 2 版本 + 预发布 / 已撤回 / 缺文件 / 墓碑，便于页面验收。
// 用法：npm run seed
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { cfg } from '../src/config.js'
import { ensureDirs, writeAtomic, serialize } from '../src/catalog/persist.js'

const COMBOS = [
  ['windows7', 'x64', '.exe'],
  ['windows7', 'ia32', '.exe'],
  ['windows10', 'x64', '.exe'],
  ['windows10', 'ia32', '.exe'],
  ['macos', 'arm64', '.dmg'],
  ['macos', 'x64', '.dmg'],
  ['linux', 'x64', '.AppImage'],
  ['linux', 'arm64', '.AppImage'],
]

const records = []
const NOW = Date.now()

function idFor(iso) {
  const ts = iso.slice(0, 19).replace(/[-:]/g, '')
  return `${ts}-${randomBytes(4).toString('hex')}`
}

function makeContent(seed) {
  const buf = Buffer.alloc(48 * 1024)
  let x = 0
  for (let i = 0; i < seed.length; i++) x = (x * 31 + seed.charCodeAt(i)) >>> 0
  for (let i = 0; i < buf.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    buf[i] = x & 0xff
  }
  return buf
}

async function add({
  version,
  platform,
  arch,
  ext,
  status = 'active',
  prerelease = '',
  daysAgo = 0,
  changelog = '',
  missing = false,
}) {
  const isPrerelease = Boolean(prerelease)
  const fullVersion = prerelease ? `${version}-${prerelease}` : version
  const [major, minor, patch] = version.split('.').map(Number)

  const dir = path.join(cfg.releasesDir, fullVersion, `${platform}-${arch}`)
  const objectKey = `${fullVersion}/${platform}-${arch}/package.bin`

  let size = 0
  let sha256 = ''

  if (!missing && status !== 'deleted') {
    await fs.mkdir(dir, { recursive: true })
    const buf = makeContent(`${fullVersion}-${platform}-${arch}`)
    await fs.writeFile(path.join(dir, 'package.bin'), buf)
    size = buf.length
    sha256 = createHash('sha256').update(buf).digest('hex')
  }

  const uploadedAt = new Date(NOW - daysAgo * 24 * 3600 * 1000).toISOString()

  records.push({
    id: idFor(uploadedAt),
    version: fullVersion,
    major,
    minor,
    patch,
    prerelease,
    is_prerelease: isPrerelease,
    platform,
    arch,
    filename: `CoreRunner-${fullVersion}-${platform}-${arch}${ext}`,
    object_key: objectKey,
    size: size || 48 * 1024,
    sha256: sha256 || '0'.repeat(64),
    changelog,
    status,
    file_missing: missing,
    uploaded_at: uploadedAt,
    uploaded_ip: '10.20.3.51',
  })
}

async function main() {
  await ensureDirs()

  const changelogs = {
    '1.3.0': '修复登录闪退；启动速度优化 30%。',
    '1.2.0': '新增成绩榜；修复手柄热插拔失效。',
    '1.4.0-beta.1': '预发布：新角色系统，欢迎内测反馈。',
    '1.1.0': '修复 macOS 全屏退出异常。',
    '1.0.0': '首个内测版本。',
    '0.9.0': '历史版本，已删除。',
  }

  // 8 组合 × 1.3.0 / 1.2.0
  for (const [platform, arch, ext] of COMBOS) {
    await add({
      version: '1.3.0', platform, arch, ext,
      daysAgo: 1, changelog: changelogs['1.3.0'],
    })
  }
  for (const [platform, arch, ext] of COMBOS) {
    await add({
      version: '1.2.0', platform, arch, ext,
      daysAgo: 21, changelog: changelogs['1.2.0'],
    })
  }

  // 预发布：Win10 x64
  await add({
    version: '1.4.0', platform: 'windows10', arch: 'x64', ext: '.exe',
    prerelease: 'beta.1', daysAgo: 2, changelog: changelogs['1.4.0-beta.1'],
  })

  // 已撤回：macOS arm64
  await add({
    version: '1.1.0', platform: 'macos', arch: 'arm64', ext: '.dmg',
    status: 'yanked', daysAgo: 30, changelog: changelogs['1.1.0'],
  })

  // 缺文件：Linux arm64 1.0.0（记录在、文件没了）
  await add({
    version: '1.0.0', platform: 'linux', arch: 'arm64', ext: '.AppImage',
    daysAgo: 45, changelog: changelogs['1.0.0'], missing: true,
  })

  // 墓碑：Win7 ia32 0.9.0
  await add({
    version: '0.9.0', platform: 'windows7', arch: 'ia32', ext: '.exe',
    status: 'deleted', daysAgo: 60, changelog: changelogs['0.9.0'],
  })

  const json = serialize(records)
  await writeAtomic(cfg.jsonPath, json)

  const fixturesDir = path.join(cfg.root, 'fixtures')
  await fs.mkdir(fixturesDir, { recursive: true })
  await fs.writeFile(path.join(fixturesDir, 'releases.sample.json'), json)

  console.log(`[seed] 已生成 ${records.length} 条版本记录 → ${cfg.jsonPath}`)
  console.log(`[seed] 演示产物位于 ${cfg.releasesDir}`)
}

main().catch((e) => {
  console.error('[seed] 失败：', e)
  process.exit(1)
})
