// 全局内容寻址 refcount GC（#782 · #766 D8）：attic blob 键 = sha256，journal 行的前后像/
// 墓碑三列引用同一键域。活跃引用集 = 未归档行（archivedAt=null）的全部 sha——rewind 归档
// 后被放弃路线的 blob 失去引用，逆放完成（lease 释放）后剪枝。多会话共享？不——attic 在
// 沙箱容器内（per-session 容器），GC 范围天然 per-session；「全局」指 session-global 日志
// 的键域（非跨会话去重）。
//
// 剪枝集 = 存量 blob − 活跃 refcount − replay lease（逆放进行中的行已归档、失去 refcount，
// lease 挡住 use-after-free）。GC 时机：rewindFiles 尾部恒跑一次（restore reconcile 与逆放
// 完成后）——boot reconcile 处置行的 blob 滞留至下次 rewind 剪枝（启动面不批量 IO；被动触发，
// 无定时器）。

import type { PrismaClient } from '../../generated/prisma/client'
import type { AtticStore } from './attic'
import { shaRefsOf } from './values'

export interface GcOutcome {
  readonly scanned: number
  readonly freed: number
}

export class AtticGc {
  // per-session replay lease（进程内；rewind 逆放窗口持有——Service 层接线，此处只读）
  private readonly leases = new Map<string, Set<string>>()

  constructor(
    private readonly prisma: PrismaClient,
    private readonly attic: AtticStore,
  ) {}

  acquireLease(sessionId: string, shas: Iterable<string>): void {
    let s = this.leases.get(sessionId)
    if (!s) {
      s = new Set()
      this.leases.set(sessionId, s)
    }
    for (const sha of shas) s.add(sha)
  }

  releaseLease(sessionId: string): void {
    this.leases.delete(sessionId)
  }

  // 活跃 refcount：未归档 ∧ 未处置行全部引用键。fileRevertedAt 过滤不可省（refcount 泄漏
  // 面）：已处置行的 blob 无再读面（planRevert/续放/boot 全滤已处置行），而 pending '' 行与
  // scope=files keepMark 行结构性永不可归档（'' 匹配不到 abandoned 集 / keepMark ∈ chain
  // 零改动 checkpoint）——不过滤则死 blob 单调累积耗尽 attic 配额，会话写面 fail-closed。
  async activeShas(sessionId: string): Promise<Set<string>> {
    const rows = await this.prisma.fileJournal.findMany({
      where: { sessionId, archivedAt: null, fileRevertedAt: null },
      select: { beforeSha256: true, afterSha256: true, tombstoneKey: true },
    })
    const out = new Set<string>()
    for (const r of rows) for (const sha of shaRefsOf(r)) out.add(sha)
    return out
  }

  // 会话 GC：剪枝 lease 外的无引用 blob。
  async gc(container: string, sessionId: string): Promise<GcOutcome> {
    const existing = await this.attic.listBlobShas(container)
    const keep = await this.activeShas(sessionId)
    const lease = this.leases.get(sessionId) ?? new Set<string>()
    const doomed = existing.filter((sha) => !keep.has(sha) && !lease.has(sha))
    const freed = await this.attic.deleteBlobs(container, doomed)
    return { scanned: existing.length, freed }
  }
}
