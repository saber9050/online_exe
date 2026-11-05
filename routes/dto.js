// HTTP 响应结构与磁盘结构分离。磁盘格式在 lib/catalog，响应格式在这里。
import { archLabel, platformLabel, comboLabel } from '../lib/constants.js'

/** @param {any} rec */
export function toReleaseDto(rec) {
  return {
    id: rec.id,
    version: rec.version,
    major: rec.major,
    minor: rec.minor,
    patch: rec.patch,
    prerelease: rec.prerelease,
    is_prerelease: rec.is_prerelease,
    platform: rec.platform,
    platformLabel: platformLabel(rec.platform),
    arch: rec.arch,
    archLabel: archLabel(rec.platform, rec.arch),
    comboLabel: comboLabel(rec.platform, rec.arch),
    filename: rec.filename,
    size: rec.size,
    sha256: rec.sha256,
    changelog: rec.changelog,
    status: rec.status,
    file_missing: rec.file_missing,
    uploaded_at: rec.uploaded_at,
    uploaded_ip: rec.uploaded_ip,
    download_url: `/dl/${rec.version}/${rec.platform}-${rec.arch}`,
  }
}
