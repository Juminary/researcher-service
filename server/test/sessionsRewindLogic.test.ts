// S3 纯逻辑（#781 · #747 story 16/18 · #770 软删存档）：rewind/fork 的三个判定函数。
// 锚点解析（消息行 → rewind 锚点 checkpoint）、被放弃集合（换锚后旧 head 链的独有前缀）、
// 可见行挂靠（锚点链上每条消息行的归属判定——rewind 归档与 fork 截断复制的共用判据）。
// 不触库、不发布事件（接缝纪律对齐 TurnReducer）。

import { describe, it, expect } from 'vitest'
import {
  resolveRewindAnchor,
  abandonedCheckpointIds,
} from '../src/sessions/rewind'
import {
  visibleRowIds,
  type HistoryRowLite,
} from '../src/checkpointChain'

// 行工厂：(turn, role, anchor) —— createdAt 不参与判定（排序由调用方保证），给固定值。
function row(turn: number, role: string, anchor: string | null): HistoryRowLite {
  return { id: `m${turn}-${role}`, turn, role, anchorCheckpointId: anchor, createdAt: new Date(0) }
}

describe('resolveRewindAnchor（锚点解析）', () => {
  it('assistant 行 → 自身 anchorCheckpointId', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null),
      row(4, 'assistant', 'cp-2'),
    ]
    expect(resolveRewindAnchor(rows, 'm2-assistant')).toBe('cp-1')
  })

  it('user 行 → 前驱最近 assistant 行的锚点（改 prompt 重来 = 该消息入图之前的 state）', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null),
      row(4, 'assistant', 'cp-2'),
    ]
    expect(resolveRewindAnchor(rows, 'm3-user')).toBe('cp-1')
  })

  it('首条 user 行无前驱 assistant 锚点 → null（无更早 state 可回退）', () => {
    const rows = [row(1, 'user', null), row(2, 'assistant', 'cp-1')]
    expect(resolveRewindAnchor(rows, 'm1-user')).toBeNull()
  })

  it('assistant 行锚点为 null（aborted/failed 轮）→ 挂靠前驱带锚 assistant 锚点（重开到失败前）', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null),
      row(4, 'assistant', null),
      row(5, 'user', null),
    ]
    // 失败轮无自身 state 可回退 → 挂靠更早的 cp-1（与 user 行同一「入图之前」语义）
    expect(resolveRewindAnchor(rows, 'm4-assistant')).toBe('cp-1')
    // 失败轮后的 user 行 → 前驱带锚 assistant 是 cp-1（null 锚跳过）
    expect(resolveRewindAnchor(rows, 'm5-user')).toBe('cp-1')
  })

  it('system 行挂靠前驱带锚 assistant；不存在的 messageId → null', () => {
    const rows = [row(1, 'user', null), row(2, 'assistant', 'cp-1'), row(3, 'system', null)]
    expect(resolveRewindAnchor(rows, 'm3-system')).toBe('cp-1')
    expect(resolveRewindAnchor(rows, 'no-such')).toBeNull()
  })
})

describe('abandonedCheckpointIds（被放弃集 = 未归档全体 − 锚点链）', () => {
  it('链外全部入集；共享前缀（锚点链）不打标记', () => {
    // 线性链 a ← b ← c ← d，锚点 b → 被放弃 = {c, d}
    expect(abandonedCheckpointIds(['a', 'b', 'c', 'd'], new Set(['a', 'b']))).toEqual(new Set(['c', 'd']))
  })

  it('锚点链覆盖全体 → 空集（no-op rewind）', () => {
    expect(abandonedCheckpointIds(['a', 'b'], new Set(['a', 'b']))).toEqual(new Set())
  })

  it('不经旧 head 的死亡分叉（失败轮超步残留）一并入集（R 评审：差集取代 head 链行走）', () => {
    // 分叉树 a ← b 与 a ← c ← d：head 走在 b 线上时，c/d 残留也须随 rewind 归档
    expect(abandonedCheckpointIds(['a', 'b', 'c', 'd'], new Set(['a', 'b']))).toEqual(new Set(['c', 'd']))
    // 反向：锚点链在 c 线上 → b 线残留（含 b 自身）入集
    expect(abandonedCheckpointIds(['a', 'b', 'c', 'd'], new Set(['a', 'c', 'd']))).toEqual(new Set(['b']))
  })

  it('空输入（无 checkpoint）→ 空集', () => {
    expect(abandonedCheckpointIds([], new Set(['x']))).toEqual(new Set())
  })
})

describe('visibleRowIds（可见行挂靠）', () => {
  it('assistant 行：anchor ∈ 锚点链 → 可见；不在 → 不可见', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null),
      row(4, 'assistant', 'cp-2'),
    ]
    // 锚点链 = {cp-1}（rewind 到第一轮回复）
    expect(visibleRowIds(rows, new Set(['cp-1']))).toEqual(new Set(['m1-user', 'm2-assistant']))
  })

  it('锚点链之后的 user 行（无后继 assistant）→ 可见（活跃头部新输入）', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null), // 触发 run 失败/进行中，无 assistant 后继
    ]
    expect(visibleRowIds(rows, new Set(['cp-0', 'cp-1']))).toEqual(new Set(['m1-user', 'm2-assistant', 'm3-user']))
  })

  it('锚点链之外的孤儿 user 行（后继 assistant 不可见）→ 不可见（被放弃轮整体消失）', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null), // 旧分支（cp-2 轮，rewind 后被放弃）
      row(4, 'assistant', 'cp-2'),
      row(5, 'user', null), // 分叉后的新输入（cp-3 轮）
      row(6, 'assistant', 'cp-3'),
    ]
    // rewind 到 cp-1：3/4 被放弃；5 挂靠 cp-3（不可见）→ 不可见；6 不可见
    expect(visibleRowIds(rows, new Set(['cp-0', 'cp-1']))).toEqual(new Set(['m1-user', 'm2-assistant']))
  })

  it('锚点链之后的新 user 行挂靠锚点前驱（成功轮）→ 可见', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null), // rewind 到 cp-1 后发的新消息（run 进行中）
    ]
    expect(visibleRowIds(rows, new Set(['cp-0', 'cp-1']))).toEqual(new Set(['m1-user', 'm2-assistant', 'm3-user']))
  })

  it('anchor=null 的 assistant 行挂靠后继 assistant：后继 ∈ 链 → 失败轮随分支保留', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null),
      row(4, 'assistant', null), // 失败轮（无锚）
      row(5, 'user', null),
      row(6, 'assistant', 'cp-2'), // 新一轮（成功）
    ]
    // 链含 cp-1/cp-2：失败轮（3/4）是 cp-2 轮的历史（其 user 消息入了图）→ 随分支可见
    expect(visibleRowIds(rows, new Set(['cp-0', 'cp-1', 'cp-2']))).toEqual(
      new Set(['m1-user', 'm2-assistant', 'm3-user', 'm4-assistant', 'm5-user', 'm6-assistant']),
    )
  })

  it('失败轮后继被放弃（链止于 cp-1）→ 失败轮整体不可见（R 评审：旧前驱挂靠会让锚点后失败恒可见）', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null),
      row(4, 'assistant', null), // 失败轮（无锚）
      row(5, 'user', null),
      row(6, 'assistant', 'cp-2'), // cp-1 之后的新轮（被放弃）
    ]
    // rewind 到 cp-1：失败轮（3/4）在锚点之后 → 与 5/6 一并不可见（投影 ≡ 锚点时刻）
    expect(visibleRowIds(rows, new Set(['cp-0', 'cp-1']))).toEqual(new Set(['m1-user', 'm2-assistant']))
  })

  it('锚点之后的失败尾部（无后继 assistant）→ 不可见（rewind 归档收口）', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null),
      row(4, 'assistant', null), // 失败尾部：无后继
    ]
    expect(visibleRowIds(rows, new Set(['cp-0', 'cp-1']))).toEqual(new Set(['m1-user', 'm2-assistant']))
  })

  it('会话头部（无任何带锚 assistant 前）的行 → 可见（空会话起步消息）', () => {
    const rows = [row(1, 'system', null), row(2, 'user', null)]
    expect(visibleRowIds(rows, new Set(['cp-9']))).toEqual(new Set(['m1-system', 'm2-user']))
  })

  it('anchor=null assistant 在被放弃分支尾部（无后继）→ 挂靠链上锚点 → 不可见', () => {
    const rows = [
      row(1, 'user', null),
      row(2, 'assistant', 'cp-1'),
      row(3, 'user', null),
      row(4, 'assistant', 'cp-2'),
      row(5, 'user', null),
      row(6, 'assistant', null), // 旧分支失败行（rewind 回 cp-1 后）
    ]
    // m6 挂靠前驱带锚 = cp-2 ∉ {cp-0,cp-1} → 不可见（旧分支失败痕迹随分支隐藏）
    expect(visibleRowIds(rows, new Set(['cp-0', 'cp-1']))).toEqual(new Set(['m1-user', 'm2-assistant']))
  })
})
