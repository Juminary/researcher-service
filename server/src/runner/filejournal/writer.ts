// journal-first 打点管线（#782 · #766 D8）：pre-image → attic+sha → journal tx → apply →
// applied。崩溃窗口语义：
//   ① pre/attic 间崩溃：文件未动、journal 无行——无残留
//   ② journal tx 后 apply 前（applied=false）：行在账，roll-forward reconcile（reconcile.ts）
//      重放 apply 补齐；agent resume 重放同 toolCallId 幂等命中同防线
//   ③ apply 后 applied 置位前：applied=false 残留，同 ②（apply 幂等覆盖写，重放无害）
//
// toolCallId 幂等键：(sessionId, toolCallId) UNIQUE。打点前先查键：
//   命中 applied=true → 前次执行已完整落账，仅 apply（重放覆盖写）不重复打点不重读 pre
//   命中 applied=false → 前次打点后崩溃，本次执行补全——apply 后置位已有行
//   未命中 → 正常管线（tx insert 撞唯一 = 防御面兜底同命中处置——围栏单飞下理论不可达）
// 可达窗口（backend 前置校验先于本查询——edit 的字符串替换 / delete 的 pre 快照）：
// write 全程可达；edit/delete 在 applied 前窗口可达（apply 未执行 → 文件处旧态 → 前置
// 校验通过 → 命中补全）；applied 后重放 edit/delete 在前置校验即以 error 回 agent（文件
// 已处新态、oldString/路径失配——agent 自纠，无重复行）。
// agent 工具调用键 = 真实 tool_call_id（ALS，context.ts）；runner 物化 = 确定性键
//（ingest-<attachmentId> / media-<attachmentId>）；ALS 缺席降级随机 UUID（无重放去重，
// 管线完整性与正确性不受损）。
//
// seq 全序：事务内 (sessionId, seq) UNIQUE 取 max+1。正确性前提 = 会话写围栏单飞
//（fence.ts——agent 写面/ingestion/逆放三条路径全部在围栏内到达本模块），不做 seq 冲突重试。

import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../generated/prisma/client'
import type { SandboxFilePrimitives } from '../backend/primitives'
import { AtticStore, sha256Of, AtticQuotaExceededError } from './attic'
import type { JournalAudit } from './audit'
import { PENDING_CHECKPOINT_ID, type JournalOp } from './values'

export interface JournalWriteEntry {
  readonly seq: number
  readonly idempotentReplay: boolean // 幂等键命中（重放路径）——审计与测试断言面
}

export interface JournalWriteParams {
  readonly sessionId: string
  readonly container: string
  /** normalizeFilePath 后的 /lab 相对路径（journal 行 path 列语义） */
  readonly path: string
  readonly op: JournalOp
  /** pre-image 惰性读取（管线第一步执行；幂等命中路径不触） */
  readonly readPreImage: () => Promise<Buffer | null>
  /** 新字节（write/edit 全文；delete 恒 null） */
  readonly afterBytes: Buffer | null
  /** 真实写/删动作（attic 与 journal 落账后执行；重放语义 = 覆盖写幂等） */
  readonly apply: () => Promise<void>
  /** op 生效锚点 checkpoint：打点时点未知（终态未定）——恒记 PENDING_CHECKPOINT_ID，行带
   *  runId 待 run 终态按 runId 回填（RunService 终态面） */
  readonly runId?: string
  /** 打点时点锚点已知的物化面直盖（media 物化在 run completed 分支——checkpointId 回填
   *  updateMany 已执行完，不直盖则行恒 pending 恒逆放误撤产物）；缺省走回填路 */
  readonly checkpointId?: string
  readonly toolCallId?: string
}

const isP2002 = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002'

export class JournalWriter {
  private readonly attic: AtticStore

  constructor(
    private readonly prisma: PrismaClient,
    primitives: SandboxFilePrimitives,
    opts: { quotaBytes: number },
    /** 配额拒绝审计（#782 观测面——attic_quota_reject kind；缺省 = 不记，测试面） */
    private readonly audit?: JournalAudit,
  ) {
    this.attic = new AtticStore(primitives, { quotaBytes: opts.quotaBytes })
  }

  async write(p: JournalWriteParams): Promise<JournalWriteEntry> {
    const toolCallId = p.toolCallId ?? randomUUID()

    // ⓪ 幂等键命中（重放路径）：不重读 pre-image / 不写 attic——直接补 apply
    const existing = await this.prisma.fileJournal.findUnique({
      where: { sessionId_toolCallId: { sessionId: p.sessionId, toolCallId } },
      select: { seq: true, applied: true, runId: true },
    })
    if (existing !== null) return this.replayExisting(p, existing)

    // ① pre-image
    const pre = await p.readPreImage()
    const beforeSha256 = pre !== null ? sha256Of(pre) : null
    const afterSha256 = p.afterBytes !== null ? sha256Of(p.afterBytes) : null

    // ② attic+sha（ensureRoot 懒触发；put 幂等，同内容 dedup；超配额抛 AtticQuotaExceededError）
    await this.attic.ensureRoot(p.container)
    try {
      if (pre !== null) await this.attic.putBlob(p.container, pre)
      if (p.afterBytes !== null) await this.attic.putBlob(p.container, p.afterBytes)
    } catch (e) {
      if (e instanceof AtticQuotaExceededError) {
        // fail-closed 上抛前的旁路观测（配额拒绝回 agent 自纠，但拒绝事件不静默；
        // userId/username 缺省由 JournalAudit 按 session.ownerId 解析——机制事件无用户上下文）
        await this.audit?.record({
          kind: 'attic_quota_reject',
          sessionId: p.sessionId,
          detail: { op: p.op, path: p.path, toolCallId },
        })
      }
      throw e
    }

    // ③ journal tx：seq 分配 + insert（applied=false；P2002 = 并发防御兜底，转幂等处置）
    let seq: number
    try {
      seq = await this.prisma.$transaction(async (tx) => {
        const last = await tx.fileJournal.findFirst({
          where: { sessionId: p.sessionId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        })
        const nextSeq = (last?.seq ?? 0) + 1
        await tx.fileJournal.create({
          data: {
            sessionId: p.sessionId,
            checkpointId: p.checkpointId ?? PENDING_CHECKPOINT_ID,
            seq: nextSeq,
            op: p.op,
            path: p.path,
            beforeSha256,
            afterSha256,
            ...(p.op === 'delete' && beforeSha256 !== null ? { tombstoneKey: beforeSha256 } : {}),
            toolCallId,
            ...(p.runId !== undefined ? { runId: p.runId } : {}),
            applied: false,
          },
        })
        return nextSeq
      })
    } catch (e) {
      if (!isP2002(e)) throw e
      const raced = await this.prisma.fileJournal.findUniqueOrThrow({
        where: { sessionId_toolCallId: { sessionId: p.sessionId, toolCallId } },
        select: { seq: true, applied: true, runId: true },
      })
      return this.replayExisting(p, raced)
    }

    // ④ apply
    await p.apply()

    // ⑤ applied 置位
    await this.prisma.fileJournal.updateMany({
      where: { sessionId: p.sessionId, seq },
      data: { applied: true },
    })
    return { seq, idempotentReplay: false }
  }

  // 幂等命中处置（⓪查询命中与 ③P2002 raced 共用）：补 apply + 补置位；跨 run 复用迁移
  // runId（行归最后驱动该物化的 run——failed run 的上传物化行被重发 run 幂等命中复用时，
  // 不迁移则新 run 终态回填 where runId 不命中、行恒 pending 被误逆放）
  private async replayExisting(
    p: JournalWriteParams,
    row: { seq: number; applied: boolean; runId: string | null },
  ): Promise<JournalWriteEntry> {
    await p.apply()
    const migrateRun = p.runId !== undefined && row.runId !== p.runId
    if (!row.applied || migrateRun) {
      await this.prisma.fileJournal.updateMany({
        where: { sessionId: p.sessionId, seq: row.seq },
        data: {
          ...(row.applied ? {} : { applied: true }),
          ...(migrateRun ? { runId: p.runId } : {}),
        },
      })
    }
    return { seq: row.seq, idempotentReplay: true }
  }

  // attic 访问面（GC/配额观测共用同一 store 实例——单例纪律）。
  get atticStore(): AtticStore {
    return this.attic
  }
}
