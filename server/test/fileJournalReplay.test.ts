// 逆放计划纯逻辑（S3）：planRevert 判定式 / revertActionOf 逆操作映射 / leaseShasOf。

import { describe, expect, it } from 'vitest'
import type { FileJournal } from '../src/generated/prisma/client'
import { leaseShasOf, planRevert, revertActionOf } from '../src/runner/filejournal/replay'

function row(over: Partial<FileJournal> & { seq: number }): FileJournal {
  return {
    id: `j-${over.seq}`,
    sessionId: 's1',
    checkpointId: 'c',
    op: 'write',
    path: `f${over.seq}.txt`,
    beforeSha256: null,
    afterSha256: null,
    tombstoneKey: null,
    toolCallId: `tc-${over.seq}`,
    applied: true,
    archivedAt: null,
    fileRevertedAt: null,
    ...over,
  } as FileJournal
}

describe('planRevert', () => {
  it('逆放集 = 未处置 ∧ ∉ chain；seq 降序；保留集只补标越线行；水位 = min(chainMax, toRevertMin−1)（交错不越线）', () => {
    const rows = [
      row({ seq: 1, checkpointId: 'A' }), // ∈ chain、≤ 旧水位——不动
      row({ seq: 2, checkpointId: 'A' }), // ∈ chain、> 旧水位——补标
      row({ seq: 3, checkpointId: 'X', archivedAt: new Date() }), // ∉ chain（已归档行也逆放——字节影响在）
      row({ seq: 4, checkpointId: 'Y', fileRevertedAt: new Date() }), // 已处置——恒排除
      row({ seq: 5, checkpointId: 'B', fileRevertedAt: null }), // ∈ chain——水位面
      row({ seq: 6, checkpointId: 'Z' }), // ∉ chain
    ]
    const plan = planRevert(rows, new Set(['A', 'B']), 1, 100)
    expect(plan.toRevert.map((r) => r.seq)).toEqual([6, 3]) // 全局序降序（归档行在内）
    expect(plan.keepMark.map((r) => r.seq)).toEqual([2, 5])
    // 交错（toRevert 低 seq 3 < chainMax 5）：水位收敛 toRevertMin−1=2——中断后 seq 3 行仍
    // 在水位之上可续放（水位越过未处置 toRevert 行 = 永久漏逆放面）
    expect(plan.watermark).toBe(2)
    expect(plan.degraded).toBe(false)
  })

  it('chain 内无行 → 水位 0（锚点早于全部 journal）', () => {
    const rows = [row({ seq: 1, checkpointId: 'X' })]
    const plan = planRevert(rows, new Set(['A']), null, 100)
    expect(plan.watermark).toBe(0)
    expect(plan.toRevert.map((r) => r.seq)).toEqual([1])
    expect(plan.keepMark).toEqual([])
  })

  it('深度超限 → degraded（toRevert 转跳过式处置语义，判定不改）', () => {
    const rows = [row({ seq: 1, checkpointId: 'X' }), row({ seq: 2, checkpointId: 'Y' }), row({ seq: 3, checkpointId: 'Z' })]
    const plan = planRevert(rows, new Set([]), null, 2)
    expect(plan.degraded).toBe(true)
    expect(plan.toRevert.length).toBe(3)
  })

  it('C1 多 thread：teammate 行（checkpointId 不在 leader chain 域）恒入逆放集', () => {
    const rows = [
      row({ seq: 1, checkpointId: 'leader-ck' }), // ∈ chain
      row({ seq: 2, checkpointId: 'teammate-thread-ck' }), // 不在 leader chain 域
    ]
    const plan = planRevert(rows, new Set(['leader-ck']), null, 100)
    expect(plan.toRevert.map((r) => r.seq)).toEqual([2])
    expect(plan.keepMark.map((r) => r.seq)).toEqual([1])
  })
})

describe('revertActionOf', () => {
  it('write 新文件（before=null）→ remove；有前像 → restore', () => {
    expect(revertActionOf({ op: 'write', beforeSha256: null })).toEqual({ kind: 'remove' })
    expect(revertActionOf({ op: 'write', beforeSha256: 'aa' })).toEqual({ kind: 'restore', sha256: 'aa' })
  })
  it('edit/delete → restore before；before=null 防御面 → noop', () => {
    expect(revertActionOf({ op: 'edit', beforeSha256: 'bb' })).toEqual({ kind: 'restore', sha256: 'bb' })
    expect(revertActionOf({ op: 'delete', beforeSha256: 'cc' })).toEqual({ kind: 'restore', sha256: 'cc' })
    expect(revertActionOf({ op: 'delete', beforeSha256: null })).toEqual({ kind: 'noop' })
    expect(revertActionOf({ op: 'edit', beforeSha256: null })).toEqual({ kind: 'noop' })
  })
})

describe('leaseShasOf', () => {
  it('收集前后像与墓碑全部 sha（GC 排除面）', () => {
    const shas = leaseShasOf([
      row({ seq: 1, beforeSha256: 'b1', afterSha256: 'a1' }),
      row({ seq: 2, beforeSha256: 'b2', tombstoneKey: 't2' }),
      row({ seq: 3 }),
    ])
    expect(shas).toEqual(new Set(['b1', 'a1', 'b2', 't2']))
  })
})
