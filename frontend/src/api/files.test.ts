// seam: files API —— 会话沙箱 lab 文件树 + 单文件只读全文（#776 root 契约 / #793 story 61）。
// 对齐 api/containers.test.ts 接缝：mock fetch 返回 #312 信封，断言 apiJson 解包 + path 拼接
//（:name 段 = sessionId，root=lab）+ 错误码（50002 会话不存在/越权）+ binary/oversized
// content:null 透传。v1 只读，无 PUT/POST/DELETE。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { listLabTree, readLabFile } from '@/api/files'

// 默认 application/json——后端 #312 信封响应经 res.json() 恒带该头；apiFetch 现按 Content-Type 决定
// 是否做信封 sniff，mock 须建模真实响应头（否则非 JSON 200 会误走「跳过 sniff」分支）。
function mockResp(body: unknown, status = 200, contentType = 'application/json'): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
  } as unknown as Response
}

describe('files api', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().token = 't'
    vi.stubGlobal('fetch', vi.fn())
  })

  it('listWorkspaceTree GETs recursive workspace tree and unwraps envelope data', async () => {
    const data = {
      kind: 'dir' as const,
      path: '',
      files: [
        { path: 'README.md', type: 'file' as const, size: 12, modified: '2026-08-12T00:00:00Z' },
        { path: 'src', type: 'directory' as const, size: 0, modified: '2026-08-12T00:00:00Z' },
      ],
      truncated: false,
    }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data }),
    )
    const tree = await listLabTree('demo')
    expect(tree).toEqual(data)
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/demo/files?root=lab&recursive=true')
  })

  it('listWorkspaceTree encodes container name', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data: { kind: 'dir', path: '', files: [], truncated: false } }),
    )
    await listLabTree('my/session')
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/my%2Fsession/files?root=lab&recursive=true')
  })

  it('listWorkspaceTree surfaces truncated flag from envelope', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({
        code: 0,
        message: 'ok',
        data: { kind: 'dir', path: '', files: [], truncated: true },
      }),
    )
    const tree = await listLabTree('demo')
    expect(tree.truncated).toBe(true)
  })

  it('readWorkspaceFile GETs single file with path query and unwraps envelope', async () => {
    const data = {
      kind: 'file' as const,
      path: 'notes/plan.md',
      content: '# plan\n',
      size: 7,
      modified: '2026-08-12T00:00:00Z',
      binary: false,
      oversized: false,
    }
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 0, message: 'ok', data }),
    )
    const file = await readLabFile('demo', 'notes/plan.md')
    expect(file).toEqual(data)
    const [path] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toBe('/api/v1/containers/demo/files?root=lab&path=notes%2Fplan.md')
  })

  it('readWorkspaceFile passes through binary content:null flag', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({
        code: 0,
        message: 'ok',
        data: {
          kind: 'file',
          path: 'out.bin',
          content: null,
          size: 9999,
          modified: '2026-08-12T00:00:00Z',
          binary: true,
          oversized: false,
        },
      }),
    )
    const file = await readLabFile('demo', 'out.bin')
    expect(file.binary).toBe(true)
    expect(file.content).toBeNull()
  })

  it('readWorkspaceFile passes through oversized content:null flag', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({
        code: 0,
        message: 'ok',
        data: {
          kind: 'file',
          path: 'big.log',
          content: null,
          size: 5_000_000,
          modified: '2026-08-12T00:00:00Z',
          binary: false,
          oversized: true,
        },
      }),
    )
    const file = await readLabFile('demo', 'big.log')
    expect(file.oversized).toBe(true)
    expect(file.content).toBeNull()
  })

  it('readWorkspaceFile throws ApiError(60040) on envelope not-found', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 60040, message: '文件不存在', data: null }),
    )
    await expect(readLabFile('demo', 'missing.md')).rejects.toMatchObject({ code: 60040 })
  })

  it('readWorkspaceFile throws ApiError(20040) on envelope forbidden', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp({ code: 50002, message: '会话不存在或无权访问', data: null }),
    )
    await expect(readLabFile('demo', 'x.md')).rejects.toMatchObject({ code: 50002 })
  })
})
