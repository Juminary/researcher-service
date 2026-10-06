// rewind 预览（#782 · D8）：逆放集摘要 + exec 跨越清单——「exec 显式降级（shell 副作用
// 不入日志；rewind 预览列出跨越 exec 调用清单——复用轨迹/审计数据零新增存储；不做全树
// diff）」。exec 清单源 = 锚后 assistant 行 attachmentsJson 的 tools 聚合（ToolLine——
// TurnReducer 落行面，零新增存储）；锚后判定 = checkpointChain.visibleRowIds 挂靠判定
//（null 锚 assistant 行〔aborted/failed 轮〕经后继传递——与 rewind 归档判据共享内核单一实现）。

import type { PrismaClient } from '../../generated/prisma/client'
import { visibleRowIds } from '../../checkpointChain'
import { EXEC_TOOLS } from '../approval/values'
import { planRevert } from './replay'
import { PREVIEW_PATH_SAMPLE_MAX } from './values'

export interface ExecCrossed {
  readonly toolCallId: string
  readonly input: string
}

export interface RewindPreview {
  readonly anchor: string
  readonly revertOps: number
  readonly pathSample: string[]
  readonly pathTotal: number
  readonly execCrossed: ExecCrossed[]
}

// 纯逻辑：tools 聚合 → exec 清单（S3 直锁；input 截 ≤400 字符预览面）。
export function extractExecCrossed(tools: unknown): ExecCrossed[] {
  if (!Array.isArray(tools)) return []
  const out: ExecCrossed[] = []
  for (const t of tools) {
    if (typeof t !== 'object' || t === null) continue
    const line = t as { name?: unknown; toolCallId?: unknown; input?: unknown }
    if (typeof line.name !== 'string' || !EXEC_TOOLS.includes(line.name)) continue
    out.push({
      toolCallId: typeof line.toolCallId === 'string' ? line.toolCallId : '',
      input: typeof line.input === 'string' ? line.input.slice(0, 400) : '',
    })
  }
  return out
}

export async function buildRewindPreview(
  prisma: PrismaClient,
  sessionId: string,
  anchor: string,
  chain: ReadonlySet<string>,
): Promise<RewindPreview> {
  // 判定式 = planRevert 单一来源（确认门数字 ≡ 实际逆放集——自实现双处必漂移；深度上限
  // 传 MAX_SAFE_INTEGER（恒不触发降级）：preview 只报面不降级，逆放面深度处置在 rewindFiles）
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { fileJournalAnchorSeq: true },
  })
  const watermark = session?.fileJournalAnchorSeq ?? null
  const rows = await prisma.fileJournal.findMany({
    where: { sessionId, fileRevertedAt: null },
    orderBy: { seq: 'desc' },
  })
  const toRevert = planRevert(rows, chain, watermark, Number.MAX_SAFE_INTEGER).toRevert
  const paths = [...new Set(toRevert.map((r) => r.path))]

  // 锚后 assistant 行（未归档）→ tools 聚合 → exec 清单；外加存活跨派生点 teammate threads
  //（teammate 共享 /lab、exec 副作用同不可逆放——派生点 ∉ chain = 锚后派生，其全部 exec 在锚后；
  // 锚前派生的副作用在锚前不入清单）。锚后判定 = visibleRowIds 单一来源（挂靠判据与 rewind
  // 归档同源——null 锚 assistant 行〔aborted/failed 轮〕挂靠后方最近 assistant 传递，简化
  // 非空过滤会把这批行的 exec 轨迹漏在确认门外，而归档面会将其一并软删）。
  const messages = await prisma.sessionMessage.findMany({
    where: { sessionId, role: 'assistant', archivedAt: null },
    select: { id: true, turn: true, role: true, anchorCheckpointId: true, createdAt: true, attachmentsJson: true },
  })
  const execCrossed: ExecCrossed[] = []
  const harvest = (rows: Array<{ attachmentsJson: string }>): void => {
    for (const m of rows) {
      try {
        const agg = JSON.parse(m.attachmentsJson) as { tools?: unknown }
        execCrossed.push(...extractExecCrossed(agg.tools))
      } catch {
        // 坏 JSON 不炸预览（serializeAttachments 恒产出合法 JSON——防御面）
      }
    }
  }
  const visible = visibleRowIds(messages, chain)
  harvest(messages.filter((m) => !visible.has(m.id)))
  const teammates = await prisma.teammate.findMany({
    where: { parentSessionId: sessionId, archivedAt: null },
    select: { threadId: true, spawnedAtCheckpointId: true },
  })
  // 跨越面（宁多列不漏列——exec 副作用不可逆放，清单是确认门唯一补偿面）：
  //   锚后派生（spawnedAtCheckpointId ∉ chain）：全部 exec 恒在锚后。
  //   锚前派生存活者（∈ chain）：「派生时点在锚前」不等于「exec 在锚前」——survivor 跨锚点
  //     干活，其锚后 exec 同不可逆放。跨 thread 锚序不可判定（teammate 恒逆放留票同根），
  //     时间代理：thread 最新消息行晚于锚 checkpoint 落盘时刻 → 保守入清单（宁多列不漏列；
  //     execCrossed 条数无界是确认门完整展示语义的有意取舍——采样会漏报丢失面）。
  const anchorCheckpoint = await prisma.checkpoint.findFirst({
    where: { threadId: sessionId, checkpointId: anchor },
    select: { createdAt: true },
  })
  const survivorThreads = teammates
    .filter((t) => t.spawnedAtCheckpointId !== null && chain.has(t.spawnedAtCheckpointId))
    .map((t) => t.threadId)
  const survivorLatest = new Map<string, Date>(
    survivorThreads.length > 0
      ? (
          await prisma.sessionMessage.groupBy({
            by: ['sessionId'],
            where: { sessionId: { in: survivorThreads }, archivedAt: null },
            _max: { createdAt: true },
          })
        ).map((g) => [g.sessionId, g._max.createdAt!])
      : [],
  )
  const crossedThreads = teammates
    .filter((t) => {
      if (t.spawnedAtCheckpointId === null) return false
      if (!chain.has(t.spawnedAtCheckpointId)) return true
      const latest = survivorLatest.get(t.threadId)
      return latest !== undefined && anchorCheckpoint !== null && latest > anchorCheckpoint.createdAt
    })
    .map((t) => t.threadId)
  if (crossedThreads.length > 0) {
    harvest(
      await prisma.sessionMessage.findMany({
        where: { sessionId: { in: crossedThreads }, role: 'assistant', archivedAt: null },
        select: { attachmentsJson: true },
      }),
    )
  }

  return {
    anchor,
    revertOps: toRevert.length,
    pathSample: paths.slice(0, PREVIEW_PATH_SAMPLE_MAX),
    pathTotal: paths.length,
    execCrossed,
  }
}
