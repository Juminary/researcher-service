// checkpoint 父链行走 + 挂靠可见性（共享内核）：纯逻辑（链行走/挂靠判定）+ 单点 IO 查询
//（loadCheckpointParentOf）——sessions/rewind（归档/复制判定）、runner/filejournal（preview
// 确认门、指针推进守卫）的单一实现——CONTEXT.md「无 IO 纯函数下沉共享内核……在 context 间
// 不得复制共享内核纯知识」。环与超深链 guard 兜底（脏数据不炸、不死循环）。

import type { PrismaClient } from './generated/prisma/client'

const MAX_CHAIN_DEPTH = 10_000

// start 出发沿 parentOf 上溯的祖先集（含 start 自身）。
export function ancestorChainOf(parentOf: (id: string) => string | null, start: string): Set<string> {
  const seen = new Set<string>()
  let cur: string | null = start
  while (cur !== null && !seen.has(cur) && seen.size < MAX_CHAIN_DEPTH) {
    seen.add(cur)
    cur = parentOf(cur)
  }
  return seen
}

// thread 未归档 checkpoint → parent 查找表（sessions checkpointParentLookup 与 runner 装配
// 注入闭包单一来源——滤集若双处手写，一处调整 archivedAt 语义会让归档链与逆放/preview 链
// 静默分叉）。
export async function loadCheckpointParentOf(
  prisma: PrismaClient,
  sessionId: string,
): Promise<Map<string, string | null>> {
  const rows = await prisma.checkpoint.findMany({
    where: { threadId: sessionId, archivedAt: null },
    select: { checkpointId: true, parentCheckpointId: true },
  })
  return new Map(rows.map((r) => [r.checkpointId, r.parentCheckpointId]))
}

// ---- 可见行挂靠（rewind 归档 / fork 截断 / preview 确认门共用判据）----

export interface HistoryRowLite {
  readonly id: string
  readonly turn: number
  readonly role: string
  readonly anchorCheckpointId: string | null
  readonly createdAt: Date
}

export function byTurnCreatedAt(a: HistoryRowLite, b: HistoryRowLite): number {
  return a.turn - b.turn || a.createdAt.getTime() - b.createdAt.getTime()
}

// 单遍右→左：带锚 assistant 按链归属解出后作为后继基准；null 锚 assistant 与 user/system
// 行都挂靠「后继最近 assistant 的已解可见性」（null 锚链式前推）；无后继时 null 锚 assistant
// 不可见（锚点之后的失败尾部）、user/system 可见（活跃头部新输入）。
export function visibleRowIds(rows: readonly HistoryRowLite[], anchorChain: ReadonlySet<string>): Set<string> {
  const sorted = [...rows].sort(byTurnCreatedAt)
  const n = sorted.length
  const visible = new Array<boolean>(n)

  let nextAssistantVisible: boolean | undefined // undefined = 后方尚无 assistant 行
  for (let i = n - 1; i >= 0; i--) {
    const r = sorted[i]!
    if (r.role === 'assistant') {
      visible[i] =
        r.anchorCheckpointId !== null ? anchorChain.has(r.anchorCheckpointId) : (nextAssistantVisible ?? false)
      nextAssistantVisible = visible[i]
    } else {
      visible[i] = nextAssistantVisible ?? true
    }
  }

  const out = new Set<string>()
  for (let i = 0; i < n; i++) if (visible[i]) out.add(sorted[i]!.id)
  return out
}
