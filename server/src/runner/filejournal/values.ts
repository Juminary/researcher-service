// 文件 rewind 机制常量（#782 · #766 D8）：op 值集、attic 容器内路径、幂等键前缀。
// 配额/深度/围栏超时的可调值走 config（FILE_JOURNAL_* env），此处只放机制常量。

import type { FileJournal } from '../../generated/prisma/client'

// journal op 值集（V1：rename 不在工具面——schema.prisma FileJournal.op 注释锁定）。
export const JOURNAL_OPS = ['write', 'edit', 'delete'] as const
export type JournalOp = (typeof JOURNAL_OPS)[number]

// checkpointId 的 pending 哨兵：打点时点终态锚未定（工具执行在 super-step 中），行先记 ''
// 并带 runId；run 终态（completed/interrupted 有 anchor）按 runId 精确回填 anchorCheckpointId
//（RunService 终态面——'' 按会话回填会误伤并发 thread 的新 pending 行）。崩溃未回填的 '' 行
// ∉ 任何 chain → 恒逆放（保守方向：被放弃/崩溃 turn 的 op 随下次 rewind 逆放正确；锚不可能
// 落在无终态行上——'' 永不作锚）。
export const PENDING_CHECKPOINT_ID = ''

// attic 容器内路径（daemon 侧 root 写 0700；容器根 / 下——agent 工具路径恒 /lab|/wiki 双根，
// routePath 结构性拒达，files API root=lab 映射 /lab 子树同不可达——「files API / ls / glob /
// grep 过滤」由结构性隔离满足，无需显式过滤代码）。fork 字面复制（docker export→import）
// 含 /.attic 整树，继承面零特判。
export const ATTIC_DIR = '/.attic'
export const ATTIC_BLOBS_DIR = `${ATTIC_DIR}/blobs`

// 内容寻址 blob 的容器内绝对路径。
export function atticBlobPath(sha256: string): string {
  return `${ATTIC_BLOBS_DIR}/${sha256}`
}

// 幂等键命名空间（非 agent 工具调用的确定性打点键；agent 工具调用用真实 tool_call_id）。
export const IDEMPOTENCY_INGEST_PREFIX = 'ingest-'
export const IDEMPOTENCY_MEDIA_PREFIX = 'media-'

// 机制事件审计（TextTraceLog）traceId 前缀（teammate-mail:<id> 先例延伸）。
export const JOURNAL_AUDIT_TRACE_PREFIX = 'file-journal'

// 逆放摘要给前端的路径采样上限（不做全树 diff——D8；仅摘要面）。
export const PREVIEW_PATH_SAMPLE_MAX = 20

// journal 行的 attic sha 引用（before/after/墓碑三列——GC refcount 与 replay lease 共用
// 收集面；引用列变更单点改）。
export function shaRefsOf(
  row: Pick<FileJournal, 'beforeSha256' | 'afterSha256' | 'tombstoneKey'>,
): string[] {
  const out: string[] = []
  if (row.beforeSha256 !== null) out.push(row.beforeSha256)
  if (row.afterSha256 !== null) out.push(row.afterSha256)
  if (row.tombstoneKey !== null) out.push(row.tombstoneKey)
  return out
}

// /lab 根与 rel↔abs 对偶（journal 行 path 列 = /lab 相对路径；引用点变更单点改）。
export const LAB_ROOT = '/lab'

/** journal 相对路径（'' = 根本身）→ 容器内绝对路径 */
export function labAbsOf(rel: string): string {
  return rel === '' ? LAB_ROOT : `${LAB_ROOT}/${rel}`
}

/** /lab 绝对路径 → journal 相对路径（'' = 根本身；调用方保证 routePath 已判定 /lab 前缀） */
export function labRelOf(absPath: string): string {
  const rel = absPath.slice(LAB_ROOT.length)
  return rel.startsWith('/') ? rel.slice(1) : rel
}
