// seam: useEventStream 传输面薄封装（#726 事件模型 / #730 §4.1）。
// 覆盖：named-event 订阅 + 坏帧丢弃、serverSeq 去重与 gap 检测（Last-Event-ID 只检测不重放）、
// stream.opened 状态迁移、session.terminated（per-user 广播无 sessionId）停重连、
// 401（EventSource 不可见）经 REST 刷新链探测：活 → 手动重开（原生重连放弃时）/ 死 → close 终态。
// stub 全局 EventSource（贴 TeamSessionsView.test.ts 先例）；apiJson 经 vi.mock 注入。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useEventStream, type SessionEvent } from './useEventStream'

const apiJsonMock = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ apiJson: apiJsonMock }))

class FakeEventSource extends EventTarget {
  // IDL 静态常量（真 EventSource 接口面）：useEventStream 以 EventSource.CLOSED 判连接终态
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []
  static last(): FakeEventSource | undefined {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]
  }
  url: string
  readyState = 0 // 0 connecting / 1 open / 2 closed
  closed = false
  onerror: ((e: Event) => void) | null = null
  constructor(url: string) {
    super()
    this.url = url
    FakeEventSource.instances.push(this)
    this.readyState = 1
  }
  close(): void {
    this.closed = true
    this.readyState = 2
  }
  emit(type: string, event: SessionEvent, lastEventId?: string): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(event), lastEventId }))
  }
  // 真 EventSource 的 onerror 是 IDL handler——plain EventTarget 的 dispatchEvent 不回调
  // 同名属性，此处显式调用以建模「error 事件触发 onerror」语义。
  fail(): void {
    this.onerror?.(new Event('error'))
  }
}

const STREAM_OPENED = { type: 'stream.opened', payload: { protocolV: 1, serverSeq: 0, serverTime: '' } }

beforeEach(() => {
  setActivePinia(createPinia())
  useAuthStore().token = 'jwt-test'
  FakeEventSource.instances = []
  apiJsonMock.mockReset().mockResolvedValue({ id: 'u1' })
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useEventStream', () => {
  it('打开即建 EventSource(/api/v1/events)；事件按名分派且 payload 透传', () => {
    const seen: SessionEvent[] = []
    useEventStream({ onEvent: (e) => seen.push(e) })
    const src = FakeEventSource.last()!
    expect(src.url).toBe('/api/v1/events')
    src.emit('text.delta', { type: 'text.delta', sessionId: 's1', runId: 'r1', payload: { delta: 'hi' } }, '1')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'text.delta', payload: { delta: 'hi' } })
  })

  it('坏 JSON 帧 / 缺 payload / 缺 type 的帧丢弃不炸', () => {
    const seen: SessionEvent[] = []
    useEventStream({ onEvent: (e) => seen.push(e) })
    const src = FakeEventSource.last()!
    src.dispatchEvent(new MessageEvent('text.delta', { data: '{not-json' }))
    src.emit('text.delta', { type: 'text.delta', payload: undefined } as unknown as SessionEvent)
    src.emit('text.delta', { payload: {} } as unknown as SessionEvent)
    expect(seen).toHaveLength(0)
  })

  it('seq 去重：lastEventId 回退/重复帧丢弃；gap（跳号）→ onGap', () => {
    const seen: SessionEvent[] = []
    const gaps = vi.fn()
    useEventStream({ onEvent: (e) => seen.push(e), onGap: gaps })
    const src = FakeEventSource.last()!
    src.emit('text.delta', { type: 'text.delta', payload: { delta: '1' } }, '1')
    src.emit('text.delta', { type: 'text.delta', payload: { delta: '1-dup' } }, '1') // 重复
    src.emit('text.delta', { type: 'text.delta', payload: { delta: '3' } }, '3') // 跳过 2 → gap
    src.emit('text.delta', { type: 'text.delta', payload: { delta: '4' } }, '4')
    expect(seen.map((e) => e.payload.delta)).toEqual(['1', '3', '4'])
    expect(gaps).toHaveBeenCalledTimes(1)
  })

  it('stream.opened → status open + onOpen；断线 error → status disconnected + onDisconnect', () => {
    const opened = vi.fn()
    const dropped = vi.fn()
    const stream = useEventStream({ onEvent: () => {}, onOpen: opened, onDisconnect: dropped })
    expect(stream.status.value).toBe('connecting')
    const src = FakeEventSource.last()!
    src.emit('stream.opened', STREAM_OPENED)
    expect(stream.status.value).toBe('open')
    expect(opened).toHaveBeenCalledTimes(1)
    src.fail()
    expect(stream.status.value).toBe('disconnected')
    expect(dropped).toHaveBeenCalledTimes(1)
  })

  it('session.terminated（per-user 广播，无 sessionId）→ close 终态停重连，事件不再上抛', () => {
    const seen: SessionEvent[] = []
    const stream = useEventStream({ onEvent: (e) => seen.push(e) })
    const src = FakeEventSource.last()!
    src.emit('session.terminated', { type: 'session.terminated', payload: { reason: 'revoked' } })
    expect(stream.status.value).toBe('closed')
    expect(src.closed).toBe(true)
    const before = seen.length
    src.emit('text.delta', { type: 'text.delta', payload: { delta: 'late' } }, '9')
    expect(seen).toHaveLength(before)
  })

  it('带 sessionId 的 session.terminated 不关流（非 per-user 广播）', () => {
    const stream = useEventStream({ onEvent: () => {} })
    const src = FakeEventSource.last()!
    src.emit('session.terminated', { type: 'session.terminated', sessionId: 's1', payload: { reason: 'x' } })
    expect(stream.status.value).not.toBe('closed')
  })

  it('401 探测：REST 刷新链活（/auth/me 成功）且 EventSource 已彻底 CLOSED → 手动重开新连接', async () => {
    const stream = useEventStream({ onEvent: () => {} })
    const first = FakeEventSource.last()!
    first.emit('stream.opened', STREAM_OPENED)
    first.readyState = 2 // 原生重连已放弃（readyState CLOSED）
    first.fail()
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2))
    const second = FakeEventSource.last()!
    expect(second).not.toBe(first)
    expect(stream.status.value).toBe('connecting')
  })

  it('401 探测：刷新链死（refreshExhausted）→ close 终态（#726 REST 刷新链死则前端主动关流）', async () => {
    apiJsonMock.mockRejectedValue(new Error('未登录'))
    useAuthStore().refreshExhausted = true
    const stream = useEventStream({ onEvent: () => {} })
    const src = FakeEventSource.last()!
    src.fail()
    await vi.waitFor(() => expect(stream.status.value).toBe('closed'))
    expect(apiJsonMock).toHaveBeenCalledWith('/api/v1/auth/me')
  })

  it('401 探测：连接仍在原生重连（readyState 非 CLOSED）→ 不手动重开（交给原生机制）', async () => {
    useEventStream({ onEvent: () => {} })
    const first = FakeEventSource.last()!
    first.fail() // readyState 保持 1（CONNECTING——原生重连中）
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(FakeEventSource.instances.length).toBe(1)
  })

  it('close() 手动关闭：终态 + 不再上抛', () => {
    const seen: SessionEvent[] = []
    const stream = useEventStream({ onEvent: (e) => seen.push(e) })
    stream.close()
    expect(stream.status.value).toBe('closed')
    const src = FakeEventSource.last()!
    src.emit('text.delta', { type: 'text.delta', payload: { delta: 'late' } }, '1')
    expect(seen).toHaveLength(0)
  })
})
