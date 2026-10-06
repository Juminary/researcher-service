// pre-image 打包（#782）：journal blob 的字节语义 = 「恢复用 tar」——单文件 createTarFile、
// 目录树 createTarTree（定序稳定重打包，symlink 等非常规条目不入树 = 降级面——链不携带数据
// 副本，丢失面轻）。JournalingBackend（write/edit 的文件级 pre）与 delete 面（含目录 rm -rf）
// 共用。目录含超限子文件 → throw fail-closed（与 /lab 根 delete 拒绝同构：「要么完整恢复面
// 要么不打点」——部分树打点让行声称可恢复而逆放静默丢数据；调用方 catch 回 agent 自纠：
// 逐文件删除走文件级超限降级面）。
// mode 降级（知情取舍，parseTar 的 TarEntry 无 mode 字段——保真需改 files/tar.ts 共享内核）：
// 文件条目恢复为 0644 常权（可执行位丢失）；目录条目显式 0755（可遍历语义保留）。

import { createTarFile, createTarTree, parseTar } from '../../files/tar'
import type { SandboxFilePrimitives } from '../backend/primitives'

// 文件级 pre tar（write/edit：guardedFile 已收集的字节）。
export function filePreTar(basename: string, buf: Buffer): Buffer {
  return createTarFile(basename, buf)
}

// delete 面现状快照（文件/目录统一）：null = 不存在；单文件超限 → null（调用方 super 直删
// 不打点 = 文件级降级）；目录含超限子文件 → throw。
export async function snapshotAsTar(
  primitives: SandboxFilePrimitives,
  container: string,
  absPath: string,
  opts: { maxDataBytes: number },
): Promise<Buffer | null> {
  const raw = await primitives.getArchive(container, absPath)
  if (raw === null) return null
  const parsed = parseTar(raw, { collectData: true, maxDataBytes: opts.maxDataBytes })
  const root = parsed[0]
  if (!root) return null
  const basename = absPath.split('/').pop() ?? 'file'
  if (root.type !== 'directory') {
    if (root.data === null) return null // 超限：不保 pre → 调用方（JournalingBackend.delete）super 直删不打点 = delete 降级为无恢复面
    return createTarFile(basename, root.data)
  }
  const entries: Array<{ name: string; type: 'file' | 'directory'; content?: Buffer; modeOctal?: string }> = [
    { name: `${basename}/`, type: 'directory', modeOctal: '0000755' },
  ]
  for (const t of parsed.slice(1)) {
    let rel = t.name.startsWith('./') ? t.name.slice(2) : t.name
    while (rel.endsWith('/')) rel = rel.slice(0, -1)
    if (rel === '' || rel === '.') continue
    if (rel.startsWith(`${basename}/`)) rel = rel.slice(basename.length + 1)
    if (t.type === 'file') {
      if (t.data === null) {
        throw new Error(
          `directory '${absPath}' contains file exceeding snapshot limit (${opts.maxDataBytes} bytes) — delete files individually instead`,
        )
      }
      entries.push({ name: rel, type: 'file', content: t.data })
    } else if (t.type === 'directory') {
      entries.push({ name: `${rel}/`, type: 'directory', modeOctal: '0000755' })
    }
  }
  return createTarTree(entries)
}
