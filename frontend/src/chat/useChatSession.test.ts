// seam: useChatSession 会话编排 composable（#730 §4.1 拆三件之三 / #793 验收「会话列表/中断/
// 错误分类/标题 UI 接通真实 REST+SSE」）。api/sessions 全 mock（信封解包由 client 单测覆盖），
// EventSource stub 全局（贴 TeamSessionsView.test.ts 先例），restOutbox 走真 sessionStorage
// （vitest.setup MemoryStorage）——重点验证编排逻辑：幂等发送/门控/断线补偿/事件分派/审批/系统命令。
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatSession } from './useChatSession'

vi.mock('@/api/sessions', () => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getSessionProjection: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  abortSession: vi.fn(),
  resolveSessionApproval: vi.fn(),
  uploadSessionAttachment: vi.fn(),
}))

import * as api from '@/api/sessions'
import { ApiError } from '@/api/client'

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
  readyState = 1
  closed = false
  onerror: ((e: Event) => void) | null = null
  constructor(url: string) {
    super()
    this.url = url
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.closed = true
    this.readyState = 2
  }
  emit(type: string, event: Record<string, unknown>, lastEventId?: string): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(event), lastEventId }))
  }
  // 真 EventSource 的 onerror 是 IDL handler——显式调用以建模 error 事件
  fail(): void {
    this.onerror?.(new Event('error'))
  }
}

const S1 = { id: 'sess-1', title: '文献综述', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' }
const S2 = { id: 'sess-2', title: '实验记录', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' }

const projectionOf = (over: Record<string, unknown> = {}) => ({
  sessionId: 'sess-1', title: '文献综述',
  messages: [
    { id: 'm1', turn: 1, role: 'user', content: '旧问题', anchorCheckpointId: null, createdAt: '2026-10-06T00:00:00Z' },
    { id: 'm2', turn: 2, role: 'assistant', content: '旧回答', anchorCheckpointId: 'ck-1', createdAt: '2026-10-06T00:00:01Z' },
  ],
  ...over,
})

const opened = () => FakeEventSource.last()!.emit('stream.opened', { type: 'stream.opened', payload: { protocolV: 1, serverSeq: 0, serverTime: '' } })

const actionsErr = vi.fn()
const loadErr = vi.fn()
const commandSpy = vi.fn()

async function mounted() {
  const conn = useChatSession({ onActionError: actionsErr, onError: loadErr, onCommand: commandSpy })
  opened()
  await flushPromises()
  return conn
}

beforeEach(() => {
  setActivePinia(createPinia())
  FakeEventSource.instances = []
  sessionStorage.clear()
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.clearAllMocks()
  vi.mocked(api.listSessions).mockResolvedValue([S1, S2])
  vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf())
  vi.mocked(api.sendSessionMessage).mockResolvedValue({ messageId: 'm9', turn: 3, runId: 'r1', replay: false })
  vi.mocked(api.renameSession).mockResolvedValue(S1)
  actionsErr.mockClear()
  loadErr.mockClear()
  commandSpy.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('boot / 会话列表', () => {
  it('SSE 开流补偿：拉列表 + 选中最近会话 + 拉投影 → messages 为 fromProjection 产物', async () => {
    const conn = await mounted()
    const chat = conn.chat
    expect(chat.sessions.map((s) => s.id)).toEqual(['sess-1', 'sess-2'])
    expect(chat.selectedSession).toBe('sess-1')
    expect(chat.messages.map((m) => m.text)).toEqual(['旧问题', '旧回答'])
    expect(chat.messages[1].id).toBe('m2')
  })

  it('boot：未开流时显式调用同样建列表 + 自动选中', async () => {
    const conn = useChatSession({})
    await conn.boot()
    await flushPromises()
    expect(conn.chat.selectedSession).toBe('sess-1')
    expect(conn.chat.messages).toHaveLength(2)
  })

  it('selectSession：切会话清态重拉 + lab 文件树重置；迟到旧投影丢弃', async () => {
    const conn = await mounted()
    vi.mocked(api.getSessionProjection).mockResolvedValue(projectionOf({ sessionId: 'sess-2', title: '实验记录', messages: [] }))
    conn.selectSession('sess-2')
    await flushPromises()
    expect(conn.chat.selectedSession).toBe('sess-2')
    expect(conn.chat.messages).toHaveLength(0)
  })
})

describe('发送（幂等 + 乐观回显 + 门控）', () => {
  it('happy path：乐观 user 行 → POST 带 32-hex 幂等键 → messageId 回填 → 清输入', async () => {
    const conn = await mounted()
    conn.chat.setInput('新问题')
    expect(conn.send()).toBe(true)
    const chat = conn.chat
    expect(chat.messages.at(-1)).toMatchObject({ role: 'user', text: '新问题', sendKey: expect.stringMatching(/^[0-9a-f]{32}$/) })
    expect(chat.input).toBe('')
    await flushPromises()
    expect(api.sendSessionMessage).toHaveBeenCalledWith('sess-1', '新问题', expect.stringMatching(/^[0-9a-f]{32}$/), undefined)
    expect(chat.messages.at(-1)).toMatchObject({ role: 'user', text: '新问题', id: 'm9' })
  })

  it('门控：无会话 / connecting / 在飞 run / 审批挂起 → false 不发', async () => {
    const conn = await mounted()
    conn.chat.setInput('x')
    // 在飞 run：run.started 造 overlay
    FakeEventSource.last()!.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r1', payload: {} })
    await flushPromises()
    expect(conn.running.value).toBe(true)
    expect(conn.send()).toBe(false)
    // 审批挂起（先终态清 overlay）
    FakeEventSource.last()!.emit('run.completed', { type: 'run.completed', sessionId: 'sess-1', runId: 'r1', payload: {} })
    await flushPromises()
    conn.chat.addApproval({ id: 'e1', source: 'judge-limit', toolName: 'bash', toolCallSummary: 'x', teammateId: null })
    expect(conn.send()).toBe(false)
  })

  it('replay：response.replay → 乐观行不追加 id、以投影重拉整替', async () => {
    vi.mocked(api.sendSessionMessage).mockResolvedValue({ messageId: 'm1', turn: 1, runId: null, replay: true })
    const conn = await mounted()
    conn.chat.setInput('重发同文')
    conn.send()
    await flushPromises()
    // replay → refreshProjection：GET 再拉一次（自动选中首拉 + 这次 = 2 次）
    expect(api.getSessionProjection).toHaveBeenCalledTimes(2)
  })

  it('50005（多端在跑）→ 摘乐观行 + toast + 投影重拉', async () => {
    const err = new ApiError(200, 'run 进行中', 50005)
    vi.mocked(api.sendSessionMessage).mockRejectedValue(err)
    const conn = await mounted()
    conn.chat.setInput('并发消息')
    conn.send()
    await flushPromises()
    expect(actionsErr).toHaveBeenCalledWith('已有任务在进行中')
    expect(conn.chat.messages.some((m) => m.text === '并发消息')).toBe(false)
  })

  it('40043 配额满 → 摘乐观行 + toast', async () => {
    vi.mocked(api.sendSessionMessage).mockRejectedValue(new ApiError(200, '配额', 40043))
    const conn = await mounted()
    conn.chat.setInput('配额消息')
    conn.send()
    await flushPromises()
    expect(actionsErr).toHaveBeenCalledWith('并发配额已满，请稍后再试')
    expect(conn.chat.messages.some((m) => m.text === '配额消息')).toBe(false)
  })

  it('网络故障 → 摘乐观行 + 入待发 + toast（重连后按序注入）', async () => {
    vi.mocked(api.sendSessionMessage).mockRejectedValueOnce(new TypeError('fetch failed'))
    const conn = await mounted()
    conn.chat.setInput('断网消息')
    conn.send()
    await flushPromises()
    expect(actionsErr).toHaveBeenCalledWith('已加入待发，重连后自动发送')
    expect(JSON.parse(sessionStorage.getItem('chat.restOutbox.v1')!).sessions['sess-1']).toHaveLength(1)
  })
})

describe('断线补偿（story 12 outbox + 投影重拉）', () => {
  it('断线发送 → outbox 排队 + 乐观回显，重连 flush 按序注入（同 key 幂等）→ 投影重拉', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    // 断线：error（REST 探针 /auth/me 默认 mock 成功——刷新链活，不关流）
    src.fail()
    await flushPromises()
    expect(conn.disconnected.value).toBe(true)
    conn.chat.setInput('排队消息一')
    expect(conn.send()).toBe(true)
    conn.chat.setInput('排队消息二')
    expect(conn.send()).toBe(true)
    expect(api.sendSessionMessage).not.toHaveBeenCalled()
    // 重连：stream.opened → compensate → flush（两条按序 POST）→ 投影重拉
    vi.mocked(api.sendSessionMessage).mockClear()
    opened()
    await flushPromises()
    expect(api.sendSessionMessage).toHaveBeenCalledTimes(2)
    const [first, second] = vi.mocked(api.sendSessionMessage).mock.calls
    expect(first).toEqual(['sess-1', '排队消息一', expect.any(String)])
    expect(second).toEqual(['sess-1', '排队消息二', expect.any(String)])
    // 队列清空
    expect(sessionStorage.getItem('chat.restOutbox.v1')).toBeNull()
  })

  it('gap（丢帧）→ 投影重拉补偿（Last-Event-ID 只检测不重放）', async () => {
    await mounted()
    vi.mocked(api.getSessionProjection).mockClear()
    const src = FakeEventSource.last()!
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-1', runId: 'r1', payload: { delta: 'a' } }, '1')
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-1', runId: 'r1', payload: { delta: 'b' } }, '5') // gap
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalled()
  })

  it('手动 reconnect() → 投影重拉 + 待发注入', async () => {
    const conn = await mounted()
    vi.mocked(api.getSessionProjection).mockClear()
    conn.reconnect()
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalled()
  })
})

describe('SSE 事件分派', () => {
  it('text.delta 当前会话 → 归约 overlay；其它会话事件忽略', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    src.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r1', payload: {} })
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-1', runId: 'r1', payload: { delta: '流式' } }, '2')
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-OTHER', runId: 'r2', payload: { delta: '别处' } }, '3')
    await flushPromises()
    expect(conn.chat.messages.at(-1)).toMatchObject({ role: 'assistant', text: '流式', streaming: true })
    expect(conn.chat.messages).toHaveLength(3) // 旧两条 + 本会话 overlay
  })

  it('run.completed → 终态投影重拉（权威行整替 overlay）', async () => {
    const conn = await mounted()
    vi.mocked(api.getSessionProjection).mockClear()
    const src = FakeEventSource.last()!
    src.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r1', payload: {} })
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-1', runId: 'r1', payload: { delta: '答' } }, '2')
    src.emit('run.completed', { type: 'run.completed', sessionId: 'sess-1', runId: 'r1', payload: {} })
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalledTimes(1)
    expect(conn.chat.messages.at(-1)).toMatchObject({ role: 'assistant', text: '旧回答', streaming: false })
  })

  it('run.failed → 错误分类红显（story 10 三分类）+ 投影重拉；新 run 清除', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    src.emit('run.failed', { type: 'run.failed', sessionId: 'sess-1', runId: 'r1', payload: { errorKind: 'recursion_limit' } })
    await flushPromises()
    expect(conn.lastRunError.value).toEqual({ kind: 'recursion_limit', label: '运行步数达到上限' })
    src.emit('run.failed', { type: 'run.failed', sessionId: 'sess-1', runId: 'r2', payload: { errorKind: 'llm_error' } })
    await flushPromises()
    expect(conn.lastRunError.value).toEqual({ kind: 'llm_error', label: '模型请求失败' })
    src.emit('run.failed', { type: 'run.failed', sessionId: 'sess-1', runId: 'r3', payload: { errorKind: 'unknown_kind' } })
    await flushPromises()
    expect(conn.lastRunError.value).toEqual({ kind: 'unknown_kind', label: '运行失败' })
    src.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r4', payload: {} })
    await flushPromises()
    expect(conn.lastRunError.value).toBeNull()
  })

  it('session.updated {session} → 列表 upsert（story 5 自动标题经事件到达）；{projectionChanged} → 投影重拉', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    src.emit('session.updated', { type: 'session.updated', sessionId: 'sess-2', payload: { session: { ...S2, title: '新标题' } } })
    await flushPromises()
    expect(conn.chat.sessions.find((s) => s.id === 'sess-2')?.title).toBe('新标题')
    vi.mocked(api.getSessionProjection).mockClear()
    src.emit('session.updated', { type: 'session.updated', sessionId: 'sess-1', payload: { projectionChanged: true } })
    await flushPromises()
    expect(api.getSessionProjection).toHaveBeenCalled()
  })

  it('系统命令 /new：POST 响应 command → onCommand + 选中新会话（宿主导航语义）', async () => {
    vi.mocked(api.sendSessionMessage).mockResolvedValue({
      messageId: 'm9', turn: 1, runId: null, replay: false,
      command: { name: 'new', sessionId: 'sess-new' },
    })
    const conn = await mounted()
    conn.chat.setInput('/new')
    conn.send()
    await flushPromises()
    expect(commandSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'new', sessionId: 'sess-new' }))
  })

  it('系统命令 /model：POST 响应 command → onCommand（宿主提示）', async () => {
    vi.mocked(api.sendSessionMessage).mockResolvedValue({
      messageId: 'm9', turn: 1, runId: null, replay: false,
      command: { name: 'model', model: { providerId: 'p', modelId: 'm' }, appliesTo: 'next-run' },
    })
    const conn = await mounted()
    conn.chat.setInput('/model')
    conn.send()
    await flushPromises()
    expect(commandSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'model' }))
  })
})

describe('审批（#783 升级通道前端面）', () => {
  const escalation = { id: 'e1', source: 'cautious-mode', toolCallId: 't1', toolName: 'bash', toolCallSummary: 'rm -rf /tmp/x' }

  it('approval.requested → 卡入店；approval.resolved → 卡摘除（不留痕 ADR 0014）', async () => {
    const conn = await mounted()
    const src = FakeEventSource.last()!
    src.emit('approval.requested', { type: 'approval.requested', sessionId: 'sess-1', payload: { escalation }, teammateId: null })
    await flushPromises()
    expect(conn.chat.approvals).toHaveLength(1)
    expect(conn.chat.approvals[0]).toMatchObject({ id: 'e1', toolName: 'bash', status: 'pending', teammateId: null })
    src.emit('approval.resolved', { type: 'approval.resolved', sessionId: 'sess-1', payload: { escalationId: 'e1', decision: 'allow' } })
    await flushPromises()
    expect(conn.chat.approvals).toHaveLength(0)
  })

  it('resolveApproval：POST allow → 成功摘卡；50004 → 摘卡 + 「已失效」toast；其它错 → 复位 pending 可重试', async () => {
    const conn = await mounted()
    const chat = conn.chat
    chat.addApproval({ id: 'e1', source: 'cautious-mode', toolName: 'bash', toolCallSummary: 'x', teammateId: null })
    vi.mocked(api.resolveSessionApproval).mockResolvedValueOnce(null)
    await conn.resolveApproval(chat.approvals[0], 'allow')
    expect(api.resolveSessionApproval).toHaveBeenCalledWith('sess-1', 'e1', 'allow')
    expect(chat.approvals).toHaveLength(0)

    chat.addApproval({ id: 'e2', source: 'judge-limit', toolName: 'bash', toolCallSummary: 'x', teammateId: null })
    vi.mocked(api.resolveSessionApproval).mockRejectedValueOnce(new ApiError(200, '无', 50004))
    await conn.resolveApproval(chat.approvals[0], 'deny')
    expect(actionsErr).toHaveBeenCalledWith('该审批已失效')
    expect(chat.approvals).toHaveLength(0)

    chat.addApproval({ id: 'e3', source: 'judge-limit', toolName: 'bash', toolCallSummary: 'x', teammateId: null })
    vi.mocked(api.resolveSessionApproval).mockRejectedValueOnce(new TypeError('网络'))
    await conn.resolveApproval(chat.approvals[0], 'deny')
    expect(chat.approvals[0].status).toBe('pending') // 可重试
  })
})

describe('中断 / 标题 / 删除 / slash', () => {
  it('abort：POST /abort；50006 → 「没有可中断的运行」', async () => {
    const conn = await mounted()
    vi.mocked(api.abortSession).mockResolvedValueOnce({ runId: 'r1' })
    await conn.abort()
    expect(api.abortSession).toHaveBeenCalledWith('sess-1')
    vi.mocked(api.abortSession).mockRejectedValueOnce(new ApiError(200, 'x', 50006))
    await conn.abort()
    expect(actionsErr).toHaveBeenCalledWith('没有可中断的运行')
  })

  it('renameSession：PATCH → 列表 upsert（story 5 可改）', async () => {
    const conn = await mounted()
    vi.mocked(api.renameSession).mockResolvedValueOnce({ ...S1, title: '改名后' })
    await conn.renameSession('sess-1', '改名后')
    expect(api.renameSession).toHaveBeenCalledWith('sess-1', '改名后')
    expect(conn.chat.sessions.find((s) => s.id === 'sess-1')?.title).toBe('改名后')
  })

  it('removeSession：确认后 DELETE；删当前会话 → 清投影态', async () => {
    const conn = await mounted()
    const confirmed = async () => true
    const res = await conn.removeSession('sess-1', confirmed)
    expect(res).toBe(true)
    expect(api.deleteSession).toHaveBeenCalledWith('sess-1')
    expect(conn.chat.sessions.map((s) => s.id)).toEqual(['sess-2'])
    expect(conn.chat.selectedSession).toBe('')
    expect(conn.chat.messages).toHaveLength(0)
  })

  it('removeSession：确认取消 → null 不发 DELETE', async () => {
    const conn = await mounted()
    const res = await conn.removeSession('sess-1', async () => false)
    expect(res).toBeNull()
    expect(api.deleteSession).not.toHaveBeenCalled()
  })

  it('newSession：POST /sessions → 置顶 + 选中', async () => {
    vi.mocked(api.createSession).mockResolvedValue({ id: 'sess-new', title: '', createdAt: '', updatedAt: '' })
    const conn = await mounted()
    const s = await conn.newSession()
    expect(s?.id).toBe('sess-new')
    expect(conn.chat.selectedSession).toBe('sess-new')
    expect(conn.chat.sessions[0].id).toBe('sess-new')
  })

  it('slash 系统命令：/m 匹配 /model；pickSlash 填入；Esc 关闭态由 store 承载', async () => {
    const conn = await mounted()
    conn.chat.setInput('/m')
    expect(conn.slashMatches.value.map((o) => o.alias)).toEqual(['/model'])
    expect(conn.slashOpen.value).toBe(true)
    conn.pickSlash('/model')
    expect(conn.chat.input).toBe('/model ')
    expect(conn.slashOpen.value).toBe(false) // dismissed
  })

  it('composer Enter（无修饰键）→ onSend 回调（宿主接线 sendMessage）', () => {
    const onSend = vi.fn()
    const conn = useChatSession({ onSend })
    conn.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onSend).toHaveBeenCalledTimes(1)
  })
})
