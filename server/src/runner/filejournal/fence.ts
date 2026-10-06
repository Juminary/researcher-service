// 会话级文件写围栏（#782 · #766 C1/D8）：rewind 逆放期间全会话文件写排队——全局序重放的
// 一致性前提（逆放进行中若插入新写，重放结果不可预期）。#769 per-path 写锁管稳态并发
//（他票），本围栏只管「重放期间全会话写互斥」：rewindFiles 持围栏执行逆放；JournalingBackend
// 的写面（write/edit/delete）与 runner 物化打点（ingestion/D9）在打点前 acquire——journal
// seq 全序（事务内 max+1）的正确性同样依赖单飞。
//
// 公平 FIFO（队列序即授权序）；等待有界——超时抛 50008（报当前持有者，agent 自行重试），
// 弃权者自摘队列防僵尸链位。release 幂等；持有者崩溃由调用方 finally 兜底。

import { CODE } from '../../codes'
import { fail } from '../../envelope'

interface Waiter {
  readonly holder: string
  resolve?: () => void
  reject?: (e: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

interface FenceState {
  holder: string
  queue: Waiter[]
}

export class SessionWriteFence {
  private readonly state = new Map<string, FenceState>()

  async acquire(sessionId: string, opts: { holder: string; timeoutMs: number }): Promise<WriteFenceLease> {
    let s = this.state.get(sessionId)
    if (!s) {
      s = { holder: '', queue: [] }
      this.state.set(sessionId, s)
    }
    if (s.holder === '') {
      s.holder = opts.holder
      return this.makeLease(sessionId, opts.holder)
    }
    const waiter: Waiter = { holder: opts.holder }
    s.queue.push(waiter)
    if (opts.timeoutMs > 0) {
      const timer = setTimeout(() => {
        const idx = s!.queue.indexOf(waiter)
        if (idx < 0) return // 已授权（竞态：grant 先于超时触发）——不拒绝
        s!.queue.splice(idx, 1)
        waiter.reject?.(
          fail(CODE.FILE_REPLAY_IN_PROGRESS, `文件状态重放中，请稍后重试（当前操作：${s!.holder}）`),
        )
      }, opts.timeoutMs)
      timer.unref?.()
      waiter.timer = timer
    }
    await new Promise<void>((resolve, reject) => {
      waiter.resolve = () => {
        if (waiter.timer) clearTimeout(waiter.timer)
        resolve()
      }
      waiter.reject = (e) => {
        if (waiter.timer) clearTimeout(waiter.timer)
        reject(e)
      }
    })
    return this.makeLease(sessionId, opts.holder)
  }

  // 便捷封装：acquire → fn → finally release（漏释放防线）。
  async runExclusive<T>(sessionId: string, opts: { holder: string; timeoutMs: number }, fn: () => Promise<T>): Promise<T> {
    const lease = await this.acquire(sessionId, opts)
    try {
      return await fn()
    } finally {
      lease.release()
    }
  }

  private makeLease(sessionId: string, holder: string): WriteFenceLease {
    let done = false
    return {
      release: () => {
        if (done) return
        done = true
        const s = this.state.get(sessionId)
        if (!s || s.holder !== holder) return
        const next = s.queue.shift()
        if (next) {
          s.holder = next.holder
          next.resolve?.()
        } else {
          s.holder = ''
          // 空条目清理（会话删除后长驻进程 Map 累积面）；再 acquire 时重建
          if (s.queue.length === 0) this.state.delete(sessionId)
        }
      },
    }
  }

  // 观测面（测试）：当前持有者；空闲返回 null。
  holderOf(sessionId: string): string | null {
    const s = this.state.get(sessionId)
    return s && s.holder !== '' ? s.holder : null
  }
}

export interface WriteFenceLease {
  release(): void
}
