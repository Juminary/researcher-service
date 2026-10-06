// seam: fileTabs store —— 会话沙箱 lab 树数据 + 只读 tab 状态机（#626 T1 / #618 规格 §3，#793 root=lab 换轨）。
// T1 子集直测：loadTree（成功/失败/截断/空容器名/中途切会话丢弃）、openFromTree（新建/复用只切 active/
// binary/oversized/error/中途关 tab）、closeTab（删 active 切相邻）、closeAll（保留 tree）、reset（清 tree）。
// T2 子集：onToolEvent（决议 C 触发集/绝对路径过滤/不降级/pending→done 高亮/error 收起/同路径刷新/切容器丢弃）。
// T3 子集（#628）：retry 双路径（agent 开路复刻高亮 / tree 开路无高亮）、重试仍失败、不存在 path noop。
// 仅测外部状态转移，mock api/files（信封解包由 api/ 单测覆盖，此处不重复）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useChatStore } from '@/stores/chat'
import { useFileTabsStore } from '@/stores/fileTabs'
import type { FileEntry, FileReading } from '@/api/files'
import * as filesApi from '@/api/files'

vi.mock('@/api/files', () => ({
  listLabTree: vi.fn(),
  readLabFile: vi.fn(),
}))

const dir = (files: FileEntry[] = [], truncated = false) => ({
  kind: 'dir' as const,
  path: '',
  files,
  truncated,
})

const file = (path: string, over: Partial<FileReading> = {}): FileReading => ({
  kind: 'file',
  path,
  content: '# hi\n',
  size: 5,
  modified: '2026-08-12T00:00:00Z',
  binary: false,
  oversized: false,
  ...over,
})

describe('fileTabs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(filesApi.listLabTree).mockReset()
    vi.mocked(filesApi.readLabFile).mockReset()
  })

  // ---- loadTree ----
  it('loadTree：成功落 tree + treeTruncated，清 treeLoading', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.listLabTree).mockResolvedValue(dir([{ path: 'a.md', type: 'file', size: 1, modified: '' }], false))
    const ft = useFileTabsStore()
    await ft.loadTree()
    expect(ft.tree?.files).toHaveLength(1)
    expect(ft.treeTruncated).toBe(false)
    expect(ft.treeLoading).toBe(false)
    expect(ft.treeError).toBeNull()
  })

  it('loadTree：truncated 标志透传', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.listLabTree).mockResolvedValue(dir([], true))
    const ft = useFileTabsStore()
    await ft.loadTree()
    expect(ft.treeTruncated).toBe(true)
  })

  it('loadTree：失败落 treeError + tree=null，不抛', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.listLabTree).mockRejectedValue(new Error('boom'))
    const ft = useFileTabsStore()
    await expect(ft.loadTree()).resolves.toBeUndefined()
    expect(ft.tree).toBeNull()
    expect(ft.treeError).toBe('boom')
    expect(ft.treeLoading).toBe(false)
  })

  it('loadTree：无选中容器早退（不发请求）', async () => {
    const ft = useFileTabsStore()
    await ft.loadTree()
    expect(filesApi.listLabTree).not.toHaveBeenCalled()
  })

  it('loadTree：中途切会话丢弃迟到响应', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('a')
    vi.mocked(filesApi.listLabTree).mockResolvedValue(dir([{ path: 'a.md', type: 'file', size: 1, modified: '' }]))
    const ft = useFileTabsStore()
    const p = ft.loadTree()
    chat.setSelectedSession('b') // await 前切走
    await p
    expect(ft.tree).toBeNull() // 旧容器响应被丢弃
  })

  // ---- openFromTree ----
  it('openFromTree：新文件 → 新 loaded tab + active，lineMarks 空（无高亮）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('notes/a.md'))
    const ft = useFileTabsStore()
    await ft.openFromTree('notes/a.md')
    expect(ft.tabs).toHaveLength(1)
    expect(ft.tabs[0]).toMatchObject({ path: 'notes/a.md', state: 'loaded', lineMarks: [], binary: false, oversized: false })
    expect(ft.tabs[0].content).toBe('# hi\n')
    expect(ft.activePath).toBe('notes/a.md')
  })

  it('openFromTree：同路径复用 → 仅切 active，不重拉不新开', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('notes/a.md'))
    const ft = useFileTabsStore()
    await ft.openFromTree('notes/a.md')
    await ft.openFromTree('notes/a.md') // 复用
    expect(ft.tabs).toHaveLength(1)
    expect(filesApi.readLabFile).toHaveBeenCalledTimes(1)
    expect(ft.activePath).toBe('notes/a.md')
  })

  it('openFromTree：多文件各开各 tab，active 切到最后开的', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockImplementation(async (_n, p) => file(p))
    const ft = useFileTabsStore()
    await ft.openFromTree('a.md')
    await ft.openFromTree('b.md')
    expect(ft.tabs.map((t) => t.path)).toEqual(['a.md', 'b.md'])
    expect(ft.activePath).toBe('b.md')
  })

  it('openFromTree：binary 文件 → loaded + content:null + binary 标志', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('out.bin', { content: null, binary: true, size: 9999 }))
    const ft = useFileTabsStore()
    await ft.openFromTree('out.bin')
    expect(ft.tabs[0]).toMatchObject({ state: 'loaded', binary: true, content: null })
  })

  it('openFromTree：oversized 文件 → loaded + content:null + oversized 标志', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('big.log', { content: null, oversized: true, size: 5_000_000 }))
    const ft = useFileTabsStore()
    await ft.openFromTree('big.log')
    expect(ft.tabs[0]).toMatchObject({ state: 'loaded', oversized: true, content: null })
  })

  it('openFromTree：fetch 失败 → error 态 + errorMessage，不抛', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockRejectedValue(new Error('不存在'))
    const ft = useFileTabsStore()
    await expect(ft.openFromTree('x.md')).resolves.toBeUndefined()
    expect(ft.tabs[0]).toMatchObject({ state: 'error', errorMessage: '不存在' })
    expect(ft.tabs[0].content).toBeNull()
  })

  it('openFromTree：await 中途用户关掉 tab → 不崩（回填找不到 tab 静默）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md'))
    const ft = useFileTabsStore()
    const p = ft.openFromTree('a.md')
    ft.closeTab('a.md') // fetch 完成前关闭
    await p
    expect(ft.tabs).toHaveLength(0) // 回填静默丢弃，不留空 tab
  })

  // ---- closeTab ----
  it('closeTab：删非 active 不改 active', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockImplementation(async (_n, p) => file(p))
    const ft = useFileTabsStore()
    await ft.openFromTree('a.md')
    await ft.openFromTree('b.md')
    ft.closeTab('a.md') // active 是 b.md
    expect(ft.tabs.map((t) => t.path)).toEqual(['b.md'])
    expect(ft.activePath).toBe('b.md')
  })

  it('closeTab：删 active → 切前一个相邻', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockImplementation(async (_n, p) => file(p))
    const ft = useFileTabsStore()
    await ft.openFromTree('a.md')
    await ft.openFromTree('b.md')
    await ft.openFromTree('c.md')
    ft.closeTab('c.md') // active 是末位
    expect(ft.activePath).toBe('b.md')
  })

  it('closeTab：删唯一 active tab → active 为 null', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md'))
    const ft = useFileTabsStore()
    await ft.openFromTree('a.md')
    ft.closeTab('a.md')
    expect(ft.tabs).toHaveLength(0)
    expect(ft.activePath).toBeNull()
  })

  // ---- closeAll / reset ----
  it('closeAll：清 tab + active，保留 tree', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.listLabTree).mockResolvedValue(dir([{ path: 'a.md', type: 'file', size: 1, modified: '' }]))
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md'))
    const ft = useFileTabsStore()
    await ft.loadTree()
    await ft.openFromTree('a.md')
    ft.closeAll()
    expect(ft.tabs).toHaveLength(0)
    expect(ft.activePath).toBeNull()
    expect(ft.tree?.files).toHaveLength(1) // 树保留（切会话语义）
  })

  it('reset：清 tab + active + tree + treeTruncated + treeError（切会话语义）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.listLabTree).mockResolvedValue(dir([{ path: 'a.md', type: 'file', size: 1, modified: '' }], true))
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md'))
    const ft = useFileTabsStore()
    await ft.loadTree()
    await ft.openFromTree('a.md')
    ft.reset()
    expect(ft.tabs).toHaveLength(0)
    expect(ft.activePath).toBeNull()
    expect(ft.tree).toBeNull()
    expect(ft.treeTruncated).toBe(false)
    expect(ft.treeError).toBeNull()
  })

  // ---- onToolEvent：决议 C 触发集（#627 T2）----
// （入参形状 = useChatSession.bridgeFileTabs 桥接后的 {name,state,input,result}；lab 相对路径。）
  it('onToolEvent running edit → 开 pending tab + active（lineMarks 空 / content null）', () => {
    const ft = useFileTabsStore()
    ft.onToolEvent({ name: 'edit', state: 'running', input: { file_path: 'a.md', old_string: 'x', new_string: 'y' }, result: null })
    expect(ft.tabs).toHaveLength(1)
    expect(ft.tabs[0]).toMatchObject({ path: 'a.md', state: 'pending', content: null, lineMarks: [], binary: false, oversized: false })
    expect(ft.activePath).toBe('a.md')
  })

  it('onToolEvent running write → 开 pending tab', () => {
    const ft = useFileTabsStore()
    ft.onToolEvent({ name: 'write', state: 'running', input: { file_path: 'a.md', content: 'hi\n' }, result: null })
    expect(ft.tabs[0]).toMatchObject({ path: 'a.md', state: 'pending' })
  })

  it('onToolEvent running apply_patch（多文件）→ 每路径各开 pending tab（dedupe）', () => {
    const ft = useFileTabsStore()
    const input = { patch: '*** Begin Patch\n*** Add File: a.md\n+hello\n*** Add File: b.md\n+foo\n*** End Patch' }
    ft.onToolEvent({ name: 'apply_patch', state: 'running', input, result: null })
    expect(ft.tabs.map((t) => t.path).sort()).toEqual(['a.md', 'b.md'])
    expect(ft.tabs.every((t) => t.state === 'pending')).toBe(true)
  })

  it('onToolEvent read/command/search/fetch 不开 tab（决议 C）', () => {
    const ft = useFileTabsStore()
    ft.onToolEvent({ name: 'read', state: 'running', input: { file_path: 'a.md' }, result: null })
    ft.onToolEvent({ name: 'bash', state: 'running', input: { command: 'ls' }, result: null })
    ft.onToolEvent({ name: 'grep', state: 'running', input: { pattern: 'x' }, result: null })
    ft.onToolEvent({ name: 'web_fetch', state: 'running', input: { url: 'http://x' }, result: null })
    expect(ft.tabs).toHaveLength(0)
  })

  it('onToolEvent 绝对路径过滤（非 lab，不开 tab）', () => {
    const ft = useFileTabsStore()
    ft.onToolEvent({ name: 'write', state: 'running', input: { file_path: '/etc/passwd', content: 'x' }, result: null })
    expect(ft.tabs).toHaveLength(0)
  })

  it('running 命中已 loaded tab → 保持 loaded 不降级骨架', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md'))
    const ft = useFileTabsStore()
    await ft.openFromTree('a.md') // loaded
    ft.onToolEvent({ name: 'edit', state: 'running', input: { file_path: 'a.md', old_string: 'x', new_string: 'y' }, result: null })
    expect(ft.tabs).toHaveLength(1)
    expect(ft.tabs[0].state).toBe('loaded') // 不降级 pending
  })

  // ---- done → loaded + 行级高亮 ----
  it('done write → loaded + 全行高亮（行号与 fetched 对齐）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('w.md', { content: 'line1\nline2\nline3\n' }))
    const ft = useFileTabsStore()
    const input = { file_path: 'w.md', content: 'line1\nline2\nline3\n' }
    ft.onToolEvent({ name: 'write', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'write', state: 'done', input, result: { changed: true } })
    await flushPromises()
    expect(ft.tabs[0].state).toBe('loaded')
    expect(ft.tabs[0].content).toBe('line1\nline2\nline3\n')
    expect(ft.tabs[0].lineMarks).toEqual([1, 2, 3])
  })

  it('done edit → loaded + new_string 首次出现处高亮', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    // fetched 是编辑后状态：含 NEW
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md', { content: 'keep\nNEW\nmore\n' }))
    const ft = useFileTabsStore()
    const input = { file_path: 'a.md', old_string: 'old', new_string: 'NEW' }
    ft.onToolEvent({ name: 'edit', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'edit', state: 'done', input, result: null })
    await flushPromises()
    expect(ft.tabs[0].state).toBe('loaded')
    expect(ft.tabs[0].lineMarks).toEqual([2]) // NEW 在第 2 行
  })

  it('done edit：new 文本在 fetched 找不到 → lineMarks 空（降级不报错，全文照常展示）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md', { content: 'a\nb\nc\n' }))
    const ft = useFileTabsStore()
    const input = { file_path: 'a.md', old_string: 'x', new_string: 'XYZ-not-in-file' }
    ft.onToolEvent({ name: 'edit', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'edit', state: 'done', input, result: null })
    await flushPromises()
    expect(ft.tabs[0].state).toBe('loaded')
    expect(ft.tabs[0].lineMarks).toEqual([])
    expect(ft.tabs[0].content).toBe('a\nb\nc\n')
  })

  it('done 多 edit（edits[]）→ 各 new 文本各自定位并合并', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md', { content: 'A\nB\n' }))
    const ft = useFileTabsStore()
    const input = { file_path: 'a.md', edits: [{ old_string: 'x', new_string: 'A' }, { old_string: 'y', new_string: 'B' }] }
    ft.onToolEvent({ name: 'edit', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'edit', state: 'done', input, result: null })
    await flushPromises()
    expect(ft.tabs[0].lineMarks).toEqual([1, 2])
  })

  it('done 单文件 apply_patch → add 行定位高亮', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('p.md', { content: 'line1\nline2\n' }))
    const ft = useFileTabsStore()
    const input = { patch: '*** Begin Patch\n*** Add File: p.md\n+line1\n+line2\n*** End Patch' }
    ft.onToolEvent({ name: 'apply_patch', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'apply_patch', state: 'done', input, result: null })
    await flushPromises()
    expect(ft.tabs[0].state).toBe('loaded')
    expect(ft.tabs[0].lineMarks).toEqual([1, 2])
  })

  it('done 多文件 apply_patch → 每文件 tab 各取本段 add 行定位（dedupe 不串文件）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    // a.md 段 add hello；b.md 段 add foo / bar
    const input = { patch: '*** Begin Patch\n*** Add File: a.md\n+hello\n*** Add File: b.md\n+foo\n+bar\n*** End Patch' }
    vi.mocked(filesApi.readLabFile).mockImplementation(async (_n, p) => file(p, p === 'a.md' ? { content: 'hello\n' } : { content: 'foo\nbar\n' }))
    const ft = useFileTabsStore()
    ft.onToolEvent({ name: 'apply_patch', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'apply_patch', state: 'done', input, result: null })
    await flushPromises()
    const a = ft.tabs.find((t) => t.path === 'a.md')
    const b = ft.tabs.find((t) => t.path === 'b.md')
    expect(a?.lineMarks).toEqual([1]) // 仅 hello，未串入 b 段
    expect(b?.lineMarks).toEqual([1, 2]) // foo+bar
  })

  it('done fetch 失败（60040 等）→ error 态 + errorMessage', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockRejectedValue(new Error('文件不存在'))
    const ft = useFileTabsStore()
    const input = { file_path: 'a.md', old_string: 'x', new_string: 'y' }
    ft.onToolEvent({ name: 'edit', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'edit', state: 'done', input, result: null })
    await flushPromises()
    expect(ft.tabs[0]).toMatchObject({ state: 'error', content: null, lineMarks: [], errorMessage: '文件不存在' })
  })

  it('done binary 文件 → loaded + content null + []（查看器出空态）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('out.bin', { content: null, binary: true, size: 9 }))
    const ft = useFileTabsStore()
    const input = { file_path: 'out.bin', content: 'x' }
    ft.onToolEvent({ name: 'write', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'write', state: 'done', input, result: null })
    await flushPromises()
    expect(ft.tabs[0]).toMatchObject({ state: 'loaded', binary: true, content: null, lineMarks: [] })
  })

  it('同路径后续 done → 复用单 tab 重拉刷新（不新开）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    const ft = useFileTabsStore()
    const input = { file_path: 'a.md', old_string: 'x', new_string: 'V1' }
    vi.mocked(filesApi.readLabFile).mockResolvedValueOnce(file('a.md', { content: 'V1\n' }))
    ft.onToolEvent({ name: 'edit', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'edit', state: 'done', input, result: null })
    await flushPromises()
    expect(ft.tabs).toHaveLength(1)
    expect(ft.tabs[0].content).toBe('V1\n')
    // 第二次 done：新内容刷新
    vi.mocked(filesApi.readLabFile).mockResolvedValueOnce(file('a.md', { content: 'V2\n' }))
    const input2 = { file_path: 'a.md', old_string: 'x', new_string: 'V2' }
    ft.onToolEvent({ name: 'edit', state: 'done', input: input2, result: null })
    await flushPromises()
    expect(ft.tabs).toHaveLength(1) // 仍单 tab
    expect(ft.tabs[0].content).toBe('V2\n')
    expect(ft.tabs[0].lineMarks).toEqual([1])
  })

  it('done 中途切容器 → 旧容器回填丢弃', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('a')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md', { content: 'x\n' }))
    const ft = useFileTabsStore()
    const input = { file_path: 'a.md', old_string: 'x', new_string: 'y' }
    ft.onToolEvent({ name: 'edit', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'edit', state: 'done', input, result: null })
    chat.setSelectedSession('b') // await 前切走
    await flushPromises()
    expect(ft.tabs[0].state).toBe('pending') // 未被回填成 loaded
    expect(ft.tabs[0].content).toBeNull()
  })

  it('done await 中途用户关 tab → 静默不崩（回填找不到 tab）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md', { content: 'x\n' }))
    const ft = useFileTabsStore()
    const input = { file_path: 'a.md', old_string: 'x', new_string: 'y' }
    ft.onToolEvent({ name: 'edit', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'edit', state: 'done', input, result: null })
    ft.closeTab('a.md') // fetch 完成前关闭
    await flushPromises()
    expect(ft.tabs).toHaveLength(0) // 不留空 tab、不崩
  })

  // ---- error result 收起语义 ----
  it('error result + tab 仍 pending → 收起（active 切相邻或空）', () => {
    const ft = useFileTabsStore()
    ft.onToolEvent({ name: 'edit', state: 'running', input: { file_path: 'a.md', old_string: 'x', new_string: 'y' }, result: null })
    ft.onToolEvent({ name: 'edit', state: 'error', input: { file_path: 'a.md', old_string: 'x', new_string: 'y' }, result: null })
    expect(ft.tabs).toHaveLength(0)
    expect(ft.activePath).toBeNull()
  })

  it('error result + tab 已 loaded → 保留（失败编辑未改文件）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    vi.mocked(filesApi.readLabFile).mockResolvedValue(file('a.md', { content: 'keep\n' }))
    const ft = useFileTabsStore()
    const input = { file_path: 'a.md', old_string: 'x', new_string: 'y' }
    ft.onToolEvent({ name: 'edit', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'edit', state: 'done', input, result: null })
    await flushPromises()
    expect(ft.tabs[0].state).toBe('loaded')
    ft.onToolEvent({ name: 'edit', state: 'error', input, result: null })
    expect(ft.tabs).toHaveLength(1) // 保留
    expect(ft.tabs[0].state).toBe('loaded')
  })

  it('error result + 无 tab → 不开（noop）', () => {
    const ft = useFileTabsStore()
    ft.onToolEvent({ name: 'edit', state: 'error', input: { file_path: 'a.md', old_string: 'x', new_string: 'y' }, result: null })
    expect(ft.tabs).toHaveLength(0)
  })

  // ---- retry（#628 T3：error 态重试按钮，复刻「对应 fetch」）----
  it('retry：agent-opened error tab → 复刻 loadAndHighlight（重拉 + 行级高亮恢复）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    const ft = useFileTabsStore()
    const input = { file_path: 'a.md', old_string: 'x', new_string: 'NEW' }
    // done 时 fetch 失败 → error
    vi.mocked(filesApi.readLabFile).mockRejectedValueOnce(new Error('暂时失败'))
    ft.onToolEvent({ name: 'edit', state: 'running', input, result: null })
    ft.onToolEvent({ name: 'edit', state: 'done', input, result: null })
    await flushPromises()
    expect(ft.tabs[0]).toMatchObject({ state: 'error', content: null })
    // 重试：fetch 现在成功 → loaded + 高亮恢复（NEW 在第 2 行）
    vi.mocked(filesApi.readLabFile).mockResolvedValueOnce(file('a.md', { content: 'keep\nNEW\nmore\n' }))
    await ft.retry('a.md')
    await flushPromises()
    expect(ft.tabs[0].state).toBe('loaded')
    expect(ft.tabs[0].content).toBe('keep\nNEW\nmore\n')
    expect(ft.tabs[0].lineMarks).toEqual([2]) // agent 开路 → 重试复刻高亮
    expect(ft.tabs[0].errorMessage).toBeUndefined()
  })

  it('retry：tree-opened error tab → 走无高亮重拉（lineMarks 恒空）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    const ft = useFileTabsStore()
    vi.mocked(filesApi.readLabFile).mockRejectedValueOnce(new Error('暂时失败'))
    await ft.openFromTree('a.md') // tree 开路 → fetch 失败 → error
    expect(ft.tabs[0]).toMatchObject({ state: 'error' })
    vi.mocked(filesApi.readLabFile).mockResolvedValueOnce(file('a.md', { content: 'x\ny\n' }))
    await ft.retry('a.md')
    await flushPromises()
    expect(ft.tabs[0].state).toBe('loaded')
    expect(ft.tabs[0].content).toBe('x\ny\n')
    expect(ft.tabs[0].lineMarks).toEqual([]) // tree 开路 → 无高亮
  })

  it('retry：重试仍失败 → 维持 error 态（可再次重试）', async () => {
    const chat = useChatStore()
    chat.setSelectedSession('demo')
    const ft = useFileTabsStore()
    vi.mocked(filesApi.readLabFile).mockRejectedValue(new Error('还是失败'))
    await ft.openFromTree('a.md')
    await ft.retry('a.md')
    await flushPromises()
    expect(ft.tabs[0]).toMatchObject({ state: 'error', errorMessage: '还是失败' })
  })

  it('retry：不存在的 path → noop（不崩不新开）', async () => {
    const ft = useFileTabsStore()
    await expect(ft.retry('nope.md')).resolves.toBeUndefined()
    expect(filesApi.readLabFile).not.toHaveBeenCalled()
    expect(ft.tabs).toHaveLength(0)
  })
})
