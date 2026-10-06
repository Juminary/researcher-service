// seam: ChatView 编排壳挂载测试（#793 REST+SSE 三件套接线）。
// 覆盖：会话扁平列表渲染 + 自动选中；发送链（composer → conn.send 幂等 POST + 乐观回显）；
// 流式渲染 + 中断按钮（story 8）；run.failed 错误分类红显（story 10）；断线横幅 + 排队；
// 标题改名（story 5）；空态新建；lab 文件 tab（story 61）。api/sessions、api/files 全 mock，
// EventSource stub 全局（贴 useChatSession.test.ts 同款工具）。
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiJsonMock = vi.hoisted(() => vi.fn())
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
vi.mock('@/api/files', () => ({
  listLabTree: vi.fn(),
  readLabFile: vi.fn(),
}))
vi.mock('@/api/client', () => ({
  ApiError: class extends Error {
    status?: number
    code?: number
    constructor(statusOrMessage: number | string, message?: string, code?: number) {
      super(typeof statusOrMessage === 'number' ? (message ?? '') : statusOrMessage)
      if (typeof statusOrMessage === 'number') this.status = statusOrMessage
      this.code = code
    }
  },
  apiJson: apiJsonMock,
}))
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  ElMessageBox: {
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => ({ value: '改名后标题' })),
  },
}))

import * as api from '@/api/sessions'
import * as filesApi from '@/api/files'
import { ElMessageBox } from 'element-plus'
import ChatView from '@/views/ChatView.vue'

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
  fail(): void {
    this.onerror?.(new Event('error'))
  }
}

const S1 = { id: 'sess-1', title: '文献综述', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' }
const S2 = { id: 'sess-2', title: '实验记录', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' }

const PROJECTION = {
  sessionId: 'sess-1',
  title: '文献综述',
  messages: [
    { id: 'm1', turn: 1, role: 'user', content: '第一问', anchorCheckpointId: null, createdAt: '2026-10-06T00:00:00Z' },
    { id: 'm2', turn: 2, role: 'assistant', content: '第一答', anchorCheckpointId: 'ck1', createdAt: '2026-10-06T00:00:01Z' },
  ],
}

async function mountChat() {
  const wrapper = mount(ChatView, { global: { plugins: [createPinia()] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  FakeEventSource.instances = []
  sessionStorage.clear()
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.clearAllMocks()
  apiJsonMock.mockReset().mockResolvedValue({ id: 'u1' })
  vi.mocked(api.listSessions).mockResolvedValue([S1, S2])
  vi.mocked(api.getSessionProjection).mockResolvedValue(PROJECTION)
  vi.mocked(api.sendSessionMessage).mockResolvedValue({ messageId: 'm9', turn: 3, runId: 'r1', replay: false })
  vi.mocked(api.abortSession).mockResolvedValue({ runId: 'r1' })
  vi.mocked(api.renameSession).mockResolvedValue({ ...S1, title: '改名后标题' })
  vi.mocked(api.createSession).mockResolvedValue({ id: 'sess-new', title: '', createdAt: '', updatedAt: '' })
  vi.mocked(filesApi.listLabTree).mockResolvedValue({ kind: 'dir', path: '', files: [{ path: 'notes/a.md', type: 'file', size: 3, modified: '' }], truncated: false })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ChatView（REST+SSE 三件套接线）', () => {
  it('挂载：会话扁平列表渲染 + 自动选中最近会话 + 投影回放渲染 + 标题', async () => {
    const w = await mountChat()
    expect(w.find('[data-test="session-sess-1"]').exists()).toBe(true)
    expect(w.find('[data-test="session-sess-2"]').exists()).toBe(true)
    expect(w.find('[data-test="container-demo"]').exists()).toBe(false) // 容器维度退役
    expect(w.get('[data-test="chat-title"]').text()).toBe('文献综述')
    expect(w.text()).toContain('第一问')
    expect(w.text()).toContain('第一答')
  })

  it('发送：composer 输入 → 发送按钮 → 幂等 POST + 乐观回显 + 输入清空', async () => {
    const w = await mountChat()
    await w.find('[data-test="input"]').setValue('新问题')
    await w.find('[data-test="send"]').trigger('click')
    expect(api.sendSessionMessage).toHaveBeenCalledWith('sess-1', '新问题', expect.stringMatching(/^[0-9a-f]{32}$/), undefined)
    expect(w.text()).toContain('新问题')
    expect((w.find('[data-test="input"]').element as HTMLTextAreaElement).value).toBe('')
  })

  it('流式 + 中断（story 8）：run.started/text.delta 渲染 overlay；中断按钮 → POST /abort', async () => {
    const w = await mountChat()
    const src = FakeEventSource.last()!
    src.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r1', payload: {} })
    src.emit('text.delta', { type: 'text.delta', sessionId: 'sess-1', runId: 'r1', payload: { delta: '正在生成…' } }, '1')
    await flushPromises()
    expect(w.text()).toContain('正在生成…')
    expect(w.get('[data-test="execution-status"]').text()).toContain('模型正在回答')
    await w.get('[data-test="abort"]').trigger('click')
    expect(api.abortSession).toHaveBeenCalledWith('sess-1')
  })

  it('错误分类红显（story 10）：run.failed → 分类横幅；随新 run 剥落', async () => {
    const w = await mountChat()
    const src = FakeEventSource.last()!
    src.emit('run.failed', { type: 'run.failed', sessionId: 'sess-1', runId: 'r1', payload: { errorKind: 'infra' } })
    await flushPromises()
    const banner = w.get('[data-test="run-error"]')
    expect(banner.text()).toContain('infra')
    expect(banner.text()).toContain('运行环境异常')
    src.emit('run.started', { type: 'run.started', sessionId: 'sess-1', runId: 'r2', payload: {} })
    await flushPromises()
    expect(w.find('[data-test="run-error"]').exists()).toBe(false)
  })

  it('断线：横幅 + 排队；重连（stream.opened）自动注入待发', async () => {
    const w = await mountChat()
    const src = FakeEventSource.last()!
    src.fail()
    await flushPromises()
    expect(w.find('[data-test="reconnect-bar"]').exists()).toBe(true)
    await w.find('[data-test="input"]').setValue('断线消息')
    // 断线时发送按钮禁用（ChatComposer 门）——Enter 键是断线排队入口（composer → onSend → conn.send 排队）
    await w.find('[data-test="input"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(api.sendSessionMessage).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem('chat.restOutbox.v1')!).sessions['sess-1']).toHaveLength(1)
    opened()
    await flushPromises()
    expect(api.sendSessionMessage).toHaveBeenCalledWith('sess-1', '断线消息', expect.any(String))
    expect(sessionStorage.getItem('chat.restOutbox.v1')).toBeNull()
  })

  it('标题改名（story 5）：改名牌 → prompt 确认 → PATCH', async () => {
    const w = await mountChat()
    await w.get('[data-test="rename-session"]').trigger('click')
    expect(ElMessageBox.prompt).toHaveBeenCalled()
    expect(api.renameSession).toHaveBeenCalledWith('sess-1', '改名后标题')
  })

  it('空态：无会话 → 空态视图 + 新建入口 → createSession', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([])
    const w = await mountChat()
    expect(w.findAll('[data-test="empty-state"]').length).toBe(1)
    await w.get('[data-test="empty-new-session"]').trigger('click')
    await flushPromises()
    expect(api.createSession).toHaveBeenCalled()
  })

  it('lab 文件 tab（story 61）：切「文件」分段 → root=lab 树拉取（:name = sessionId）', async () => {
    const w = await mountChat()
    await w.find('[data-test="side-tab-files"]').trigger('click')
    await flushPromises()
    expect(filesApi.listLabTree).toHaveBeenCalledWith('sess-1')
    // WorkspaceTree 按路径段分节点渲染（notes 目录 + a.md 文件）
    expect(w.text()).toContain('a.md')
  })
})

// opened() 需在文件作用域可用的辅助（挂载后开流补偿）
function opened(): void {
  FakeEventSource.last()!.emit('stream.opened', { type: 'stream.opened', payload: { protocolV: 1, serverSeq: 0, serverTime: '' } })
}
