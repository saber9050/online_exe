// 版本记录的构造。单包上传与分片上传各写一份会漂移（漏字段、字段名不一致），
// 所以只留这一份，两边都 import。
import { randomBytes } from 'node:crypto'

/** 20261105T021000-1f3a9c7e */
export function newId() {
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')
  return `${ts}-${randomBytes(4).toString('hex')}`
}

/** 上传会话的 id：只当 URL 段用，必须 URL 安全 */
export function newUploadId() {
  return randomBytes(12).toString('hex')
}

/**
 * 同一个版本号还能不能再传。
 *
 * 只有「这条记录还在用」时才拦，两种状态放行：
 *   ① file_missing === true —— 记录在、文件丢了，允许补齐（沿用原 id，下载计数不归零）
 *   ② status === 'deleted'  —— 墓碑。删除的语义是「这个版本作废、东西没了」，
 *      既然文件已经删了，就不该再拿它挡住重新发布；否则用户只能改版本号来绕，
 *      而他要发的本来就是同一个版本。
 *
 * 在架（active）和已撤回（yanked）仍然一律 409：这两种状态下文件还在，
 * 覆盖等于「同一个 URL 换内容」，客户端缓存和版本追溯都会失效。
 *
 * @param {any} rec
 * @returns {boolean} true = 已被占用，拒绝上传
 */
export function isVersionTaken(rec) {
  if (!rec) return false
  if (rec.file_missing === true) return false
  if (rec.status === 'deleted') return false
  return true
}

/**
 * @param {{ id:string, parsed:any, platform:string, arch:string,
 *           filename:string, size:number, sha256:string,
 *           changelog:string, ip:string }} p
 */
export function buildRecord({ id, parsed, platform, arch, filename, size, sha256, changelog, ip }) {
  return {
    id,
    version: parsed.version,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease,
    is_prerelease: parsed.is_prerelease,
    platform,
    arch,
    filename,
    object_key: `${parsed.version}/${platform}-${arch}/package.bin`,
    size,
    sha256,
    changelog,
    status: 'active',
    file_missing: false,
    uploaded_at: new Date().toISOString(),
    uploaded_ip: ip,
  }
}
