// 逆放引擎（#782 · #766 D8/C1）：session-global 文件日志逆放恢复 /lab 至锚点时刻。
//
// 判定式（单一）：
//   逆放集 toRevert = fileRevertedAt=null ∧ checkpointId ∉ chain(anchor)——seq 降序执行
//   （全局序逆放：后发生的先撤销，跨 thread 行同序——C1 多 thread 全局一致）
//   保留集 keepMark = fileRevertedAt=null ∧ checkpointId ∈ chain(anchor) ∧ seq > 旧水位
//   ——跳过式处置（仅打 reverted 标记不回退）：中断续放（残集 = seq > 水位 ∧ !reverted）
//   才不会误逆放锚点之前的变更。
//   新水位 = min(chain(anchor) 行最大 seq，未处置 toRevert 最小 seq − 1)（无 chain 行 = 0）
//   ——交错不越线（水位越过未处置 toRevert 行 = 中断续放永久漏逆放）；scope=chat「保持现状」
//   由水位推进单独表达（行不处置、永不再拾起）。
//
// 逆操作映射（op 逆）：
//   write  before=null → remove（文件是新建的，回退即删；rm 幂等——shell 旁路可能已删）
//          before=sha  → restore sha（恢复前像）
//   edit   → restore before（编辑前全文）
//   delete → restore before（墓碑字节恢复；before=null = 删不存在文件的防御面 → noop）
//
// 执行面约束：全会话写围栏内（fence.ts——rewind 持有，稳态写排队）；replay lease 覆盖逆放
// 涉及全部 sha（防 GC 剪枝 use-after-free）；blob 失联（getBlob null——shell 破坏/GC 竞态/
// rename 失联）→ 该行跳过仍打标（文件现状即真相）+ missing 计数（审计面，静默失败不可接受）。
// 逐行处置即时打标（单行粒度崩溃窗口 = 重放幂等无害）；深度上限降级 = toRevert 全体跳过式
// 打标（「对话照回退、文件保持现状」——残集空，续放不再拾起）。

import type { FileJournal } from '../../generated/prisma/client'
import { shaRefsOf } from './values'

// 逆放计划（纯逻辑判定输出；S3 直锁）。
export interface RevertPlan {
  /** 跳过式处置（保留现状——∈ chain 或降级面）：只打 reverted 标记 */
  readonly keepMark: readonly FileJournal[]
  /** 逆放执行集：seq 降序（全局序逆放） */
  readonly toRevert: readonly FileJournal[]
  /** 新水位（chain 内最大 seq；无 = 0） */
  readonly watermark: number
  /** toRevert 超 depthLimit → 降级（toRevert 整体转 keepMark 语义） */
  readonly degraded: boolean
}

export function planRevert(
  rows: readonly FileJournal[],
  chain: ReadonlySet<string>,
  currentWatermark: number | null,
  depthLimit: number,
): RevertPlan {
  // 水位面：seq ≤ 旧水位的行已处置或被「保持现状」决策永久越过（scope=chat）——恒排除
  const pending = rows.filter((r) => r.fileRevertedAt === null && (currentWatermark === null || r.seq > currentWatermark))
  const inChain = pending.filter((r) => chain.has(r.checkpointId))
  const toRevert = pending
    .filter((r) => !chain.has(r.checkpointId))
    .sort((a, b) => b.seq - a.seq)
  // 水位单调不减：chain 内 pending 空时不得清零已推进水位（scope=chat 越线面）。
  // 上界收敛（交错面）：水位不得越过未处置 toRevert 行——journal seq 为会话全局序，teammate
  // 行与锚链行交错（C1 固有）时 chainMax 可大于低 seq toRevert 行；先推水位后逆放，中断/
  // 容器缺失降级后低 seq 行落入 seq ≤ 水位区被一切拾起判据（planRevert pending / resumeRevert
  // 残集）永久排除。min(chainMax, toRevertMin−1)：非交错 = chainMax 现状不变；交错 = 全部
  // toRevert 行保持在水位之上可续放。
  const chainMax = inChain.length > 0 ? Math.max(...inChain.map((r) => r.seq)) : 0
  const toRevertMin = toRevert.length > 0 ? Math.min(...toRevert.map((r) => r.seq)) : Infinity
  const watermark = currentWatermark !== null ? Math.max(currentWatermark, Math.min(chainMax, toRevertMin - 1)) : Math.min(chainMax, toRevertMin - 1)
  const degraded = toRevert.length > depthLimit
  return { keepMark: inChain, toRevert, watermark, degraded }
}

// 单行逆操作（纯函数；S3 直锁）。
export type RevertAction = { kind: 'restore'; sha256: string } | { kind: 'remove' } | { kind: 'noop' }

export function revertActionOf(row: Pick<FileJournal, 'op' | 'beforeSha256'>): RevertAction {
  if (row.beforeSha256 !== null) return { kind: 'restore', sha256: row.beforeSha256 }
  if (row.op === 'write') return { kind: 'remove' }
  return { kind: 'noop' } // delete/edit 无前像 = 防御面（正常管线不会产生）
}

// replay lease 的 sha 集（逆放行全部引用——GC 排除面）。
export function leaseShasOf(rows: readonly FileJournal[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) for (const sha of shaRefsOf(r)) out.add(sha)
  return out
}

// 逆放执行的依赖面（IO 壳注入；生产 = FileJournalService 组装，测试注 fake）。
// blob 字节 = 恢复用 tar（单文件 createTarFile / 目录树 createTarTree——JournalingBackend
// 打点侧同构产出），restore 恒 putArchive 解包。
export interface RevertIo {
  /** blob 字节读取（attic getBlob；null = 失联） */
  getBlob(container: string, sha256: string): Promise<Buffer | null>
  /** tar 解包写回（putArchive 进父目录；dir = /lab 相对父目录，'' = /lab 根） */
  putTar(container: string, dir: string, tar: Buffer): Promise<void>
  /** 幂等删除（rm -rf；path = /lab 相对路径） */
  removeFile(container: string, path: string): Promise<void>
  /** 行处置标记 */
  markReverted(sessionId: string, seqs: readonly number[], at: Date): Promise<void>
}

// /lab 相对路径 → 父目录相对路径（journal path 列恒无前导斜杠：'f.txt' → ''；'a/b.txt' → 'a'）。
export function parentDirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx <= 0 ? '' : relPath.slice(0, idx)
}

export interface RevertOutcome {
  readonly reverted: number
  readonly skippedMissing: number
}

// 逆放执行（调用方保证已持围栏与 lease；本函数不碰 fence/GC——层次单一）。
export async function executeRevert(
  sessionId: string,
  container: string,
  toRevert: readonly FileJournal[],
  io: RevertIo,
  onProgress?: (done: number, total: number) => void,
): Promise<RevertOutcome> {
  const now = new Date()
  let reverted = 0
  let skippedMissing = 0
  let done = 0
  const total = toRevert.length
  for (const row of toRevert) {
    const action = revertActionOf(row)
    if (action.kind === 'restore') {
      const tar = await io.getBlob(container, action.sha256)
      if (tar === null) {
        skippedMissing += 1
      } else {
        await io.putTar(container, parentDirOf(row.path), tar)
        reverted += 1
      }
    } else if (action.kind === 'remove') {
      await io.removeFile(container, row.path)
      reverted += 1
    } else {
      reverted += 1 // noop = 语义已满足（防御面）
    }
    await io.markReverted(sessionId, [row.seq], now)
    done += 1
    onProgress?.(done, total)
  }
  return { reverted, skippedMissing }
}
