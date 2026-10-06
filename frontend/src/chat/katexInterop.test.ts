// 回归测试：生产 rolldown interop 下 katex 插件必须是可调用函数。
// 背景（生产事故）：dev（esbuild）与 prod（rolldown）对带 __esModule 的 CJS 包
// （@vscode/markdown-it-katex）互操作语义不一致——rolldown 的 __toESM(mod,1) 会把 default
// 硬设为整个 exports 对象（rolldown#8061 同型），导致 renderMarkdown 模块顶层
// md.use(katexPlugin) 抛 `TypeError: e.apply is not a function`
// （ChatView 构建产物 13:28645 / 277:39494），对话页白屏。
// 修复：源码显式解包 CJS default，使两种互操作语义下插件都是函数。
import { describe, expect, it, vi } from 'vitest'
/// <reference types="node" />
import { createRequire } from 'node:module'
import MarkdownIt from 'markdown-it'
import type { MarkdownIt as MarkdownItType } from 'markdown-it'

describe('katex 插件生产 rolldown interop 兼容（生产崩溃回归）', () => {
  it('CJS 原始导出 default 是函数（包形状没变）', () => {
    const require = createRequire(import.meta.url)
    const mod = require('@vscode/markdown-it-katex')
    expect(mod.__esModule).toBe(true)
    expect(typeof mod.default).toBe('function')
  })

  it('renderMarkdown 在 rolldown interop（katex 导入为命名空间对象）下仍能加载渲染', async () => {
    const require = createRequire(import.meta.url)
    const realMod = require('@vscode/markdown-it-katex') as { default: unknown }

    vi.resetModules()
    // 模拟 rolldown __toESM(mod,1)：default 被硬设为 exports 对象（而非函数本身）。
    // 修复前源码 `import katexPlugin from ...` 直接 md.use → e.apply is not a function；
    // 修复后源码显式解包 default → 拿到真实插件函数。
    vi.doMock('@vscode/markdown-it-katex', () => ({
      __esModule: true,
      default: { default: realMod.default },
    }))
    const { renderMarkdown } = await import('./renderMarkdown')
    const html = renderMarkdown('残差映射 $\\mathbf{y}=\\mathcal{F}(\\mathbf{x})+\\mathbf{x}$')
    expect(html).toContain('class="katex"')
  })
})

describe('markdown-it use() 语义（用户症状 e.apply is not a function 的机制）', () => {
  it('use 接收非函数插件时抛 TypeError，与生产报错一致', () => {
    const md = new MarkdownIt()
    const objectPlugin = { default: () => md }
    expect(() => md.use(objectPlugin as never)).toThrow(TypeError)
    expect(() => md.use(objectPlugin as never)).toThrow('is not a function')
  })

  it('use 接收解包后的函数插件时正常', () => {
    const md = new MarkdownIt()
    const plugin = (m: MarkdownItType) => m
    expect(() => md.use(plugin)).not.toThrow()
  })
})
