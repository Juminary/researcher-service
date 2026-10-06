import { describe, expect, it } from 'vitest'
import { SessionWriteFence } from '../src/runner/filejournal/fence'
import { CODE } from '../src/codes'
import { EnvelopeError } from '../src/envelope'

describe('SessionWriteFence', () => {
  it('空闲即得；release 幂等', async () => {
    const f = new SessionWriteFence()
    expect(f.holderOf('s1')).toBeNull()
    const lease = await f.acquire('s1', { holder: 'replay', timeoutMs: 0 })
    expect(f.holderOf('s1')).toBe('replay')
    lease.release()
    expect(f.holderOf('s1')).toBeNull()
    expect(() => lease.release()).not.toThrow()
  })

  it('互斥：持有期间后到排队，release 按 FIFO 授权', async () => {
    const f = new SessionWriteFence()
    const order: string[] = []
    const first = await f.acquire('s1', { holder: 'a', timeoutMs: 0 })

    const p2 = f.acquire('s1', { holder: 'b', timeoutMs: 0 }).then((l) => {
      order.push('b')
      return l
    })
    const p3 = f.acquire('s1', { holder: 'c', timeoutMs: 0 }).then((l) => {
      order.push('c')
      return l
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual([])
    first.release()
    await p2
    expect(order).toEqual(['b'])
    expect(f.holderOf('s1')).toBe('b')
    // 队列里 c 还在等——单独释放 b 的 lease 再取
    ;(await p2).release()
    await p3
    expect(order).toEqual(['b', 'c'])
  })

  it('等待有界：超时 50008 且报当前持有者，弃权不阻塞后续', async () => {
    const f = new SessionWriteFence()
    const held = await f.acquire('s1', { holder: 'rewind-replay', timeoutMs: 0 })

    await expect(f.acquire('s1', { holder: 'writer', timeoutMs: 20 })).rejects.toMatchObject({
      code: CODE.FILE_REPLAY_IN_PROGRESS,
    })
    try {
      await f.acquire('s1', { holder: 'writer2', timeoutMs: 20 })
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeError)
      expect((e as EnvelopeError).message).toContain('rewind-replay')
    }
    // 弃权后释放，新来者直接得
    held.release()
    const next = await f.acquire('s1', { holder: 'next', timeoutMs: 0 })
    expect(f.holderOf('s1')).toBe('next')
    next.release()
  })

  it('超时与授权竞态：grant 先于超时触发时不误拒', async () => {
    const f = new SessionWriteFence()
    const held = await f.acquire('s1', { holder: 'a', timeoutMs: 0 })
    const pending = f.acquire('s1', { holder: 'b', timeoutMs: 5 })
    await new Promise((r) => setTimeout(r, 1))
    held.release() // 立即授权 b（timer 尚未触发）
    const lease = await pending
    expect(f.holderOf('s1')).toBe('b')
    lease.release()
  })

  it('runExclusive：fn 抛错仍释放', async () => {
    const f = new SessionWriteFence()
    await expect(
      f.runExclusive('s1', { holder: 'x', timeoutMs: 0 }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(f.holderOf('s1')).toBeNull()
  })

  it('不同会话互不阻塞', async () => {
    const f = new SessionWriteFence()
    const a = await f.acquire('s1', { holder: 'a', timeoutMs: 0 })
    const b = await f.acquire('s2', { holder: 'b', timeoutMs: 0 })
    expect(f.holderOf('s1')).toBe('a')
    expect(f.holderOf('s2')).toBe('b')
    a.release()
    b.release()
  })
})
