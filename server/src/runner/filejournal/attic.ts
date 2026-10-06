// attic —— 墓碑/前后像字节的内容寻址仓库（#782 · #766 D8）。
//
// 物理形态：沙箱容器内 /.attic/blobs/<sha256>（daemon 侧 root 写 0700 root-owned——容器
// 非 root(1000) + cap_drop ALL 使 agent 结构性不可读写删，shell 旁路同失效；exec 原语
// user:'0' 面）。blob 键 = 内容 sha256：put 幂等（同键覆盖写无妨——内容相同），journal 行的
// beforeSha256/afterSha256/tombstoneKey 三列引用同一键域，refcount GC（gc.ts）剪枝无引用者。
//
// 配额（per-session，对称 100MB checkpoint 护栏纪律）：put 前列目录求和用量，超限拒绝
// （写 op 整体失败错误回流 agent 自纠——拒绝打点会破「file_journal 覆盖完备」，静默降级
// 不可接受）。用量求和每次 put 直查（无本地缓存——单飞围栏下量级可接受；S4 基准锁开销）。
//
// 失联（rename 失联 reconcile 检出）：getBlob 对已知 sha 返回 null = blob 失联（shell 破坏
// 或 GC 竞态）——调用方记审计计数后按「文件现状即真相」降级，不阻塞主流程。

import { createHash } from 'node:crypto'
import { createTarFile, normalizeTarName, parseTar } from '../../files/tar'
import type { SandboxFilePrimitives } from '../backend/primitives'
import { ATTIC_BLOBS_DIR, atticBlobPath } from './values'

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export interface AtticUsage {
  readonly bytes: number
  readonly blobs: number
}

export class AtticStore {
  constructor(
    private readonly primitives: SandboxFilePrimitives,
    private readonly opts: { quotaBytes: number },
  ) {}

  // 建置 root 0700 目录（幂等：mkdir -p + chmod；chown 0:0——import 镜像的 /.attic 若带
  // 旧属主同样归位）。每次 rewind 流程前调用即可（journalWriter 首次 put 前懒触发由调用方
  // 决定——restore/reconcile 面容器可能不在，ensure 失败向上抛由调用方分诊）。
  async ensureRoot(container: string): Promise<void> {
    const r = await this.primitives.exec(
      container,
      ['sh', '-c', 'mkdir -p "$1" && chmod 700 "$1" && chown 0:0 "$1"', 'sh', ATTIC_BLOBS_DIR],
      { user: '0' },
    )
    if (r.exitCode !== 0) {
      throw new Error(`attic ensureRoot failed: exit ${r.exitCode} ${r.stderr.trim()}`)
    }
  }

  // put blob（幂等）。返回是否新写（同键已存在 = false——配额求和前先探存在性，dedup 写零增）。
  async putBlob(container: string, buf: Buffer): Promise<{ sha256: string; created: boolean }> {
    const sha = sha256Of(buf)
    if ((await this.primitives.getArchive(container, atticBlobPath(sha))) !== null) {
      return { sha256: sha, created: false }
    }
    const usage = await this.usage(container)
    if (usage.bytes + buf.length > this.opts.quotaBytes) {
      throw new AtticQuotaExceededError(usage.bytes, buf.length, this.opts.quotaBytes)
    }
    await this.primitives.putArchive(container, ATTIC_BLOBS_DIR, createTarFile(sha, buf))
    return { sha256: sha, created: true }
  }

  // 取 blob 字节；不存在（未写/失联）→ null。
  async getBlob(container: string, sha256: string): Promise<Buffer | null> {
    const tar = await this.primitives.getArchive(container, atticBlobPath(sha256))
    if (tar === null) return null
    const entries = parseTar(tar, { collectData: true, maxDataBytes: Number.MAX_SAFE_INTEGER })
    const entry = entries.find((e) => e.type === 'file' && e.data !== null)
    return entry?.data ?? null
  }

  // blob 键存在性（观测面——测试断言用；生产 GC 走 listBlobShas 差集、失联检出走 getBlob null）。
  async hasBlob(container: string, sha256: string): Promise<boolean> {
    return (await this.primitives.getArchive(container, atticBlobPath(sha256))) !== null
  }

  // 用量统计（配额与 GC 观测面）：列 /.attic/blobs 子树求和。目录不存在 = 空。
  async usage(container: string): Promise<AtticUsage> {
    const tar = await this.primitives.getArchive(container, ATTIC_BLOBS_DIR)
    if (tar === null) return { bytes: 0, blobs: 0 }
    const entries = parseTar(tar, { collectData: false })
    let bytes = 0
    let blobs = 0
    for (const e of entries) {
      if (e.type !== 'file') continue
      bytes += e.size
      blobs += 1
    }
    return { bytes, blobs }
  }

  // 全部 blob 键列举（GC 差集面：存量 − refcount − lease = 剪枝集）。键序确定性（排序）。
  // getArchive 目录 tar 的条目名带 base 前缀（blobs/<sha>）——剥前缀还原纯 sha 键。
  async listBlobShas(container: string): Promise<string[]> {
    const tar = await this.primitives.getArchive(container, ATTIC_BLOBS_DIR)
    if (tar === null) return []
    const entries = parseTar(tar, { collectData: false })
    const shas: string[] = []
    for (const e of entries) {
      if (e.type !== 'file') continue
      const name = normalizeTarName(e.name)
      if (name === null) continue
      shas.push(name.startsWith('blobs/') ? name.slice('blobs/'.length) : name)
    }
    return shas.sort()
  }

  // GC 剪枝面：按键列表删除（root exec rm）。返回成功删除键数（批失败不计入——失败 warn
  // 留痕：GC 审计 freed 偏小不可静默）。
  async deleteBlobs(container: string, shas: readonly string[]): Promise<number> {
    if (shas.length === 0) return 0
    // 分批防 argv 过长（sha64 × N；500/批远低于 ARG_MAX 量级）
    let removed = 0
    for (let i = 0; i < shas.length; i += 500) {
      const batch = shas.slice(i, i + 500).map(atticBlobPath)
      const r = await this.primitives.exec(
        container,
        ['sh', '-c', 'rm -f -- "$@"', 'sh', ...batch],
        { user: '0' },
      )
      if (r.exitCode === 0) {
        removed += batch.length
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[filejournal] attic GC batch rm failed: container=${container} batch=${batch.length} exit=${r.exitCode}`)
      }
    }
    return removed
  }
}

export class AtticQuotaExceededError extends Error {
  constructor(
    readonly usedBytes: number,
    readonly incomingBytes: number,
    readonly quotaBytes: number,
  ) {
    super(`attic quota exceeded: used=${usedBytes} incoming=${incomingBytes} quota=${quotaBytes}`)
    this.name = 'AtticQuotaExceededError'
  }
}
