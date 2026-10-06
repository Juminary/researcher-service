// 文件 rewind 机制事件审计（#782 · D8「观测面 journal/attic/reconcile 计数进审计域——静默
// 失败不可接受」）：复用 TextTraceLog（teammate-mail:<id> 先例），traceId 前缀 file-journal:。
// 事件种类（kind）：revert_complete / reconcile / gc / attic_quota_reject / degraded /
// exec_crossing。写失败 = 调用方 console.warn 留痕不放大（机制观测非安全判定路径——与审批
// 审计的 fail-closed 纪律区分：机制事件丢失不构成信任面破坏）。

import { createHash, randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../generated/prisma/client'
import { JOURNAL_AUDIT_TRACE_PREFIX } from './values'

export type JournalAuditKind = 'revert_complete' | 'reconcile' | 'gc' | 'attic_quota_reject' | 'degraded' | 'exec_crossing'

export interface JournalAuditEvent {
  readonly kind: JournalAuditKind
  readonly sessionId: string
  /** 事件主体（REST 面调用者）；缺省 = 解析 session.ownerId（机制事件无用户上下文——
   *  TextTraceLog.userId 是 User FK，不可写占位值） */
  readonly userId?: string
  readonly username?: string
  readonly detail: Record<string, unknown>
}

export class JournalAudit {
  constructor(private readonly prisma: PrismaClient) {}

  async record(e: JournalAuditEvent): Promise<void> {
    let userId = e.userId
    let username = e.username
    if (userId === undefined || username === undefined) {
      const s = await this.prisma.session.findUnique({
        where: { id: e.sessionId },
        select: { owner: { select: { id: true, username: true } } },
      })
      if (!s) {
        // eslint-disable-next-line no-console
        console.warn(`[filejournal] audit skipped (session missing): kind=${e.kind} session=${e.sessionId}`)
        return
      }
      userId = s.owner.id
      username = s.owner.username
    }
    const now = new Date()
    const inputText = JSON.stringify({ kind: e.kind, ...e.detail })
    const outputText = e.sessionId
    try {
      await this.prisma.textTraceLog.create({
        data: {
          // 随机段防同毫秒碰撞：rewindFiles 尾部 gc→revert_complete 顺序双记在 SQLite 亚毫秒
          // 常态下同 ms 概率高，traceId @unique 相撞 = P2002 静默丢事件。
          traceId: `${JOURNAL_AUDIT_TRACE_PREFIX}:${e.sessionId}:${now.getTime()}:${randomUUID().slice(0, 8)}`,
          userId,
          username,
          ipAddress: 'internal',
          sessionKey: e.sessionId,
          status: 'success',
          createdAt: now,
          inputText,
          outputText,
          outputHash: createHash('sha256').update(outputText).digest('hex'),
        },
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[filejournal] audit write failed: kind=${e.kind} session=${e.sessionId}: ${String(err)}`)
    }
  }
}
