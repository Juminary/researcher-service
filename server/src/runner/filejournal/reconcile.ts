// roll-forward reconcile（#782 · #766 D8「启动/restore 双路」）：
//   启动路（sessionsNeedingReconcile + 调用方 FileJournalService.reconcileOnBoot）：进程重启
//   后全表扫 applied=false 行 + 水位 session 续放残集——沙箱容器不存在的 session 跳过（启动
//   期不批量 ensure 容器；该 session 的 rewind/run 前置 restore 路兜底），计数上行（静默
//   跳过不可接受——审计面）。
//   restore 路（reconcileSession）：rewind 逆放前对目标 session 调用（容器 ensure 由调用方
//   决定——sessions 域 rewind 面容器恒在或惰性创建语义同 #776 run 前 ensure）。
//
// roll-forward：applied=false 行按 seq 升序重放 apply（journal-first 管线的②③崩溃残留）——
//   write/edit：afterSha blob 覆盖写（失联 → 行按「文件现状即真相」置位 + missing 计数）
//   delete：幂等 rm
// 续放（崩溃的 rewind 逆放）：session.fileJournalAnchorSeq 非 null → 残集 = seq > 水位 ∧
//   fileRevertedAt=null → executeRevert（判定式见 replay.ts——keepMark 已在 rewind 事务内
//   打标，残集恒为 toRevert 真子集，逆放幂等）。

import type { PrismaClient } from '../../generated/prisma/client'
import { executeRevert, parentDirOf, type RevertIo } from './replay'

export interface ReconcileOutcome {
  readonly rolledForward: number
  readonly rolledMissing: number
  readonly resumedReverted: number
  readonly resumedMissing: number
  /** 续放深度超限跳过式处置计数（对齐 planRevert degraded——「文件保持现状」+ 审计域明示） */
  readonly resumedDegraded: number
  readonly containerMissing: boolean
}

export interface ReconcilerDeps {
  readonly prisma: PrismaClient
  readonly io: RevertIo
  readonly containerOf: (sessionId: string) => Promise<string | null>
  /** 续放深度护栏（config 注入——boot 续放面跳过式降级，对齐 planRevert degraded 语义） */
  readonly depthLimit: number
}

export interface RollForwardOutcome {
  readonly rolledForward: number
  readonly rolledMissing: number
}

export class Reconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  // restore 路（rewindFilesCore 前置）：仅 rollForward——journal-first 崩溃残留补 apply。
  // 续放**不在此**：生产 rewind 流水 tx1 先归档 abandoned 行，归档面拾起会命中本流水刚归档
  // 行 → 无护栏全量逆放结构性绕过 depthLimit；上次 rewind 中断残行由本次 planRevert 自然
  // 拾起（水位不越线后判据完备；abandoned 分叉恒 ∉ 新锚链）。容器缺失返回 null（调用方跳过）。
  async rollForwardPending(sessionId: string): Promise<RollForwardOutcome | null> {
    const container = await this.deps.containerOf(sessionId)
    if (container === null) return null
    return this.rollForward(sessionId, container)
  }

  // boot 路单 session reconcile（容器缺失返回 containerMissing 标志）。chain = 指针重建链
  //（activeCheckpointId——boot 串行遍历期间新 run 可完成落账，chain 过滤防锚链内新写误撤）；
  // null = 不滤（指针缺失的罕见组合，保守现状面）。
  async reconcileSession(sessionId: string, chain: ReadonlySet<string> | null = null): Promise<ReconcileOutcome> {
    const container = await this.deps.containerOf(sessionId)
    if (container === null) {
      return { rolledForward: 0, rolledMissing: 0, resumedReverted: 0, resumedMissing: 0, resumedDegraded: 0, containerMissing: true }
    }
    const rolled = await this.rollForward(sessionId, container)
    const resumed = await this.resumeRevert(sessionId, container, chain)
    return { ...rolled, ...resumed, containerMissing: false }
  }
  // 启动路待处理清单：applied=false（journal-first 崩溃残留）+ 水位 session 续放 + 水位 null
  // 且有 journal 行的 session（tx1 后 tx2 前崩溃窗口的归档决策行 + teammate/pending 保守向
  // 行——teammate 行恒不入归档集，只捞归档面则该窗口无自动路径且零审计）。执行互斥与
  // blob 防剪由调用方装配（FileJournalService.reconcileOnBoot——围栏 + replay lease；容器
  // 缺失 session 在 reconcileSession 跳过并计数）。
  async sessionsNeedingReconcile(): Promise<string[]> {
    const sessions = await this.deps.prisma.session.findMany({
      where: {
        OR: [
          { fileJournalAnchorSeq: { not: null } },
          { fileJournal: { some: { applied: false } } },
          { fileJournal: { some: {} }, fileJournalAnchorSeq: null },
        ],
      },
      select: { id: true },
    })
    return sessions.map((s) => s.id)
  }

  private async rollForward(sessionId: string, container: string): Promise<{ rolledForward: number; rolledMissing: number }> {
    const pending = await this.deps.prisma.fileJournal.findMany({
      where: { sessionId, applied: false },
      orderBy: { seq: 'asc' },
    })
    let rolledForward = 0
    let rolledMissing = 0
    for (const row of pending) {
      let ok = true
      if (row.op === 'delete') {
        await this.deps.io.removeFile(container, row.path)
      } else if (row.afterSha256 !== null) {
        const tar = await this.deps.io.getBlob(container, row.afterSha256)
        if (tar === null) {
          ok = false // blob 失联：文件现状即真相（重放无法复现——审计面计数）
          rolledMissing += 1
        } else {
          await this.deps.io.putTar(container, parentDirOf(row.path), tar)
        }
      } else {
        ok = false // write/edit 无 afterSha = 行损坏（防御面）
        rolledMissing += 1
      }
      await this.deps.prisma.fileJournal.updateMany({
        where: { sessionId, seq: row.seq },
        data: { applied: true },
      })
      if (ok) rolledForward += 1
    }
    return { rolledForward, rolledMissing }
  }

  // 续放（boot 路专用）：残集两分支——
  //   归档 ∧ 未处置（∧ 水位 null ∨ seq > 水位）：行级 rewind 决策面（tx1 abandoned 归档即
  //     落盘表达），**无 chain 过滤**——scope=files 指针不动（可留在被放弃分支），chain(指针)
  //     会把归档待逆放行错排；chat 面归档遗留由 seq ≤ 水位天然排除（chat 水位 = maxSeq）。
  //   未归档 ∧ seq > 水位 ∧ ∉ chain：中断续放面——chain 过滤防 (tN,tN+1] 锚链内新写误撤；
  //     teammate 行（checkpointId 恒 ∉ leader chain）与 pending '' 行在此被 boot 拾起（恒
  //     逆放保守向提前收口 + 审计留痕）。
  // 水位 null：归档决策面 + 未归档 ∉ chain 面（从未 rewind 会话水位恒 null——chain 过滤
  // 保护链内正常行，无水位短路）。
  // 深度护栏：残集超限 → 跳过式处置（markReverted 打标，续放不再拾起——对齐 planRevert
  // degraded 语义「文件保持现状」）+ 计数入审计域（ReconcilerDeps.depthLimit）。
  private async resumeRevert(
    sessionId: string,
    container: string,
    chain: ReadonlySet<string> | null,
  ): Promise<{ resumedReverted: number; resumedMissing: number; resumedDegraded: number }> {
    const session = await this.deps.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { fileJournalAnchorSeq: true },
    })
    const watermark = session.fileJournalAnchorSeq
    const residual = (
      await this.deps.prisma.fileJournal.findMany({
        where: {
          sessionId,
          fileRevertedAt: null,
          ...(watermark !== null ? { seq: { gt: watermark } } : {}),
        },
        orderBy: { seq: 'desc' },
      })
      // 无水位短路：归档行恒拾起（决策面）；未归档行恒交 chain 判定（∈ chain 正常行保护——
      // 从未 rewind 会话水位恒 null，短路会把链内 completed 行全量逆放 = 数据破坏）
    ).filter((r) => r.archivedAt !== null || chain === null || !chain.has(r.checkpointId))
    if (residual.length === 0) return { resumedReverted: 0, resumedMissing: 0, resumedDegraded: 0 }
    if (residual.length > this.deps.depthLimit) {
      await this.deps.io.markReverted(sessionId, residual.map((r) => r.seq), new Date())
      return { resumedReverted: 0, resumedMissing: 0, resumedDegraded: residual.length }
    }
    const outcome = await executeRevert(sessionId, container, residual, this.deps.io)
    return { resumedReverted: outcome.reverted, resumedMissing: outcome.skippedMissing, resumedDegraded: 0 }
  }
}
