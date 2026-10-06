// fileTabs store —— 会话沙箱 lab 树数据 + 只读文件 tab 状态机（#626 T1 / #627 T2 / #618 规格 §3，
// 决议 A：与 useChatStore 同级 Pinia store，不扩进 chatStore）。#793 story 61 数据源换轨：树数据
// 从「容器 workspace」改「当前会话沙箱 lab」（root=lab，:name 段 = sessionId）——**生命周期差异**：
// lab 随会话生灭（workspace 曾随容器持久），切会话即 reset（树重拉 + tab 清空）。
// 树数据（tree）与 tab 数据同住本 store：二者同属「文件面板」关注点、同 per-session 生命周期。
//
// T1：手动浏览端到端（树点击开只读 tab、切会话清空）。
// T2：agent live 写工具事件自动弹 tab（onToolEvent，useChatSession bridgeFileTabs 单点调）+ pending
// 骨架 → done 拉全文 + 行级高亮（loadAndHighlight）→ error 收起 pending（closeIfPending）。历史回放
// 路径不经 onToolEvent，天然不开 tab（决议 B，无额外代码）。会话 id 经 useChatStore().selectedSession 取。
import { defineStore } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { ApiError } from '@/api/client'
import { listLabTree, readLabFile, type DirListing, type FileReading } from '@/api/files'
import { resolveToolCallKind, resolveToolCallTargetPaths, readEditPairs } from '@/chat/toolRender/tool-call-view'
import { buildWriteDiffLines } from '@/chat/toolRender/tool-call-diff'
import { parsePatchView } from '@/chat/toolRender/tool-call-patch'

export interface FileTab {
  path: string // workspace 相对路径；唯一 key（同路径复用单 tab）
  state: 'pending' | 'loaded' | 'error' // pending=agent running 骨架；loaded=全文（含 binary/oversized）；error=fetch 失败
  content: string | null // 全文（loaded 且非 binary/oversized）；pending / fetch 中 / error 为 null
  lineMarks: number[] // 高亮行号（1-based）；树点击 / 未映射 / pending 恒 []，agent done 写入
  binary: boolean
  oversized: boolean
  errorMessage?: string // error 态文案（fetch 失败 / 文件不存在）
  // #628 T3：agent 开路上下文——loadAndHighlight 入口记下 input+kind，供 error 态重试复刻高亮。
  // tree 开路的 tab 无此字段 → retry 走无高亮重拉（reloadFromTree）。
  retryCtx?: { input: unknown; kind: 'edit' | 'write' }
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return '读取失败'
}

// ---- 行级高亮定位纯函数（best-effort + 优雅降级；规格 §5）----

// lab 相对路径：非空、非绝对（agent 偶发传 /abs/path 不属 lab 树，跳过免污染 tab）
function isLabRel(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/')
}

// 切 new 文本为 needle 行数组，去单个尾空行（"foo\n" → ["foo"]，对齐 tool-call-diff splitDiffLines 语义）
function needleLines(text: string): string[] {
  const parts = text.split('\n')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

// 在 haystack 行数组中定位 needle 行序列的**首次连续出现**；返回 1-based 行号区间；找不到 → []（降级不报错）
function locateLines(haystack: string[], needle: string[]): number[] {
  if (needle.length === 0 || haystack.length < needle.length) return []
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false
        break
      }
    }
    if (ok) {
      const marks: number[] = []
      for (let k = 0; k < needle.length; k++) marks.push(i + k + 1)
      return marks
    }
  }
  return []
}

function dedupeSorted(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b)
}

// 解析 parsePatchView 的 section 标签（"Update/Add/Delete path" / "Move src → dst"）取该段 path
function parseSectionPath(label: string): string | null {
  let m = label.match(/^(?:Update|Add|Delete) (.+)$/)
  if (m) return m[1] ?? null
  m = label.match(/^Move .+ → (.+)$/)
  return m ? (m[1] ?? null) : null
}

// 多文件 patch：取 target 文件段的 add 行文本（单文件无 file marker，全 add 属该唯一文件）
function patchAddLineTextsForPath(lines: { kind: string; text: string }[], pathCount: number, target: string): string[] {
  if (pathCount <= 1) {
    return lines.filter((l) => l.kind === 'add').map((l) => l.text)
  }
  const texts: string[] = []
  let current: string | null = null
  for (const l of lines) {
    if (l.kind === 'file') {
      current = parseSectionPath(l.text)
      continue
    }
    if (l.kind === 'add' && current === target) texts.push(l.text)
  }
  return texts
}

// 据 tool input + fetched 全文算高亮行号（best-effort；规格 §5.1）。write 全行精确；edit/patch 取 new 文本/
// 片段在 fetched 首次出现定位，找不到 → []（全文照常展示，不报错）。kind 由 onToolEvent 经 resolveToolCallKind
// 钉死，此处不重判。
function computeLineMarks(input: unknown, kind: 'edit' | 'write', path: string, content: string): number[] {
  if (kind === 'write') {
    // buildWriteDiffLines(∞) = 全 add 行 lineNo 1..N（与 fetched 实际行号对齐）；复用，零重复实现
    return buildWriteDiffLines(content, Infinity)
      .map((d) => d.lineNo)
      .filter((n): n is number => typeof n === 'number')
  }
  // edit：先 patch（apply_patch 经 resolveToolCallKind 归 edit），后 str_replace 单/多 edit
  const patch = parsePatchView(input)
  if (patch && patch.paths.includes(path)) {
    return locateLines(content.split('\n'), patchAddLineTextsForPath(patch.lines, patch.paths.length, path))
  }
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const { pairs } = readEditPairs(args)
  const haystack = content.split('\n')
  const marks: number[] = []
  for (const p of pairs) marks.push(...locateLines(haystack, needleLines(p.newText)))
  return dedupeSorted(marks)
}

export const useFileTabsStore = defineStore('fileTabs', {
  state: () => ({
    tree: null as DirListing | null, // workspace 递归树（基线 3）
    treeLoading: false as boolean,
    treeTruncated: false as boolean,
    treeError: null as string | null, // 树拉取失败文案（§4.3：失败 → tree=null + 错误空态）
    tabs: [] as FileTab[],
    activePath: null as string | null,
  }),
  actions: {
    // 拉 lab 递归树（切到「文件」分段 / 会话变更触发）。中途切会话丢弃迟到响应。
    // 沙箱未建（纯浏览无执行会话）→ 50002/20040：降级空树 + 错误文案，不炸分段。
    async loadTree(): Promise<void> {
      const chat = useChatStore()
      const sessionId = chat.selectedSession
      if (!sessionId) return
      this.treeLoading = true
      this.treeError = null
      try {
        const listing = await listLabTree(sessionId)
        if (chat.selectedSession !== sessionId) return // 切走了：丢弃旧会话响应
        this.tree = listing
        this.treeTruncated = listing.truncated
      } catch (e) {
        if (chat.selectedSession !== sessionId) return
        this.tree = null
        this.treeError = describeError(e)
      } finally {
        this.treeLoading = false
      }
    },

    // 树点击开只读 tab（基线 6：无高亮，与 agent 触发同面板同机制）。同路径复用 → 仅切 active 不重拉。
    async openFromTree(path: string): Promise<void> {
      if (this.tabs.some((t) => t.path === path)) {
        this.activePath = path
        return
      }
      this.tabs.push({
        path,
        state: 'loaded',
        content: null, // fetch 完成前置 null（查看器出「正在读取…」轻提示）
        lineMarks: [],
        binary: false,
        oversized: false,
      })
      this.activePath = path
      await this.loadPlain(path)
    },

    // 无高亮拉取已存在 tab 的全文（openFromTree 首载 + #628 T3 retry 的 tree 开路分支共用；与
    // loadAndHighlight 的差异仅在 lineMarks）。成功 → loaded + content；失败 → error + errorMessage。
    // await 中途切会话 / 用户关 tab → 静默丢弃。
    async loadPlain(path: string): Promise<void> {
      const chat = useChatStore()
      const sessionId = chat.selectedSession
      if (!sessionId) return
      try {
        const fr = await readLabFile(sessionId, path)
        if (chat.selectedSession !== sessionId) return // 切走了：丢弃旧会话响应
        const tab = this.tabs.find((t) => t.path === path)
        if (!tab) return // await 中途用户已关掉 → 静默丢弃
        tab.content = fr.content
        tab.binary = fr.binary
        tab.oversized = fr.oversized
        tab.state = 'loaded'
        tab.errorMessage = undefined
      } catch (e) {
        if (chat.selectedSession !== sessionId) return
        const tab = this.tabs.find((t) => t.path === path)
        if (!tab) return
        tab.state = 'error'
        tab.content = null
        tab.errorMessage = describeError(e)
      }
    },

    // #628 T3：error 态重试按钮——据开路上下文复刻「对应 fetch」。agent 开路（有 retryCtx）→ loadAndHighlight
    // 含行级高亮；tree 开路（无 retryCtx）→ loadPlain 无高亮。无 tab / 找不到 → noop。
    async retry(path: string): Promise<void> {
      const tab = this.tabs.find((t) => t.path === path)
      if (!tab) return
      if (tab.retryCtx) await this.loadAndHighlight(path, tab.retryCtx.input, tab.retryCtx.kind)
      else await this.loadPlain(path)
    },

    // onToolEvent —— live 写工具事件唯一入口（useChatSession.bridgeFileTabs 单点调；决议 A）。
    // 自筛 kind∈{edit,write}（决议 C：apply_patch 经 resolveToolCallKind 归 edit 故覆盖；
    // read/search/command/fetch 不弹）+ lab 相对路径 + dedupe；按 state 分派。
    onToolEvent(tool: { name: string; state: 'running' | 'done' | 'error'; input: unknown; result: unknown }): void {
      const kind = resolveToolCallKind(tool.name, tool.input)
      if (kind !== 'edit' && kind !== 'write') return
      const paths = resolveToolCallTargetPaths(tool.name, tool.input).filter(isLabRel)
      if (paths.length === 0) return
      const seen = new Set<string>()
      for (const path of paths) {
        if (seen.has(path)) continue // dedupe：同路径只处理一次（多文件 patch / 重复 edits）
        seen.add(path)
        if (tool.state === 'running') this.openPending(path)
        else if (tool.state === 'done') void this.loadAndHighlight(path, tool.input, kind)
        else this.closeIfPending(path) // error result（含审批拒绝）
      }
    },

    // tool running：开 pending 骨架 tab + active（基线 4「start 即弹」）。已存在 tab（loaded/pending/error）
    // 不降级、不重开——避免内容闪烁 / 抢焦点（已 loaded 的后续 running 仅在 done 时刷新）。
    openPending(path: string): void {
      if (this.tabs.some((t) => t.path === path)) return
      this.tabs.push({ path, state: 'pending', content: null, lineMarks: [], binary: false, oversized: false })
      this.activePath = path
    },

    // tool done：fetch 全文 + 行级高亮（§5）。tab 任意态（pending/loaded/error）均刷新；await 中途切容器
    // 或用户关 tab → 静默丢弃。binary/oversized → loaded + content:null + []（查看器出空态）。
    async loadAndHighlight(path: string, input: unknown, kind: 'edit' | 'write'): Promise<void> {
      const chat = useChatStore()
      const sessionId = chat.selectedSession
      if (!sessionId) return
      let fr: FileReading
      try {
        fr = await readLabFile(sessionId, path)
      } catch (e) {
        if (chat.selectedSession !== sessionId) return // 切走了：丢弃旧会话回填
        const tab = this.tabs.find((t) => t.path === path)
        if (!tab) return // await 中途用户已关掉 → 静默
        // 记 agent 开路上下文：error 态重试按钮据此复刻高亮（#628 T3；仅 fetch 失败时种值）
        tab.retryCtx = { input, kind }
        tab.state = 'error'
        tab.content = null
        tab.lineMarks = []
        tab.binary = false
        tab.oversized = false
        tab.errorMessage = describeError(e)
        return
      }
      if (chat.selectedSession !== sessionId) return
      const tab = this.tabs.find((t) => t.path === path)
      if (!tab) return
      tab.binary = fr.binary
      tab.oversized = fr.oversized
      tab.content = fr.content
      tab.lineMarks = fr.content === null ? [] : computeLineMarks(input, kind, path, fr.content)
      tab.state = 'loaded'
      tab.errorMessage = undefined
    },

    // tool error result：仅收起本 run 所开、仍未 loaded 的 pending tab（基线 4「error 收起」）。
    // 已 loaded（先前成功内容）保留——失败编辑未改文件；无 tab 不开（什么都不做）。
    closeIfPending(path: string): void {
      const tab = this.tabs.find((t) => t.path === path)
      if (!tab || tab.state !== 'pending') return
      this.closeTab(path)
    },

    // 关单 tab；删的是 active → 切前一个相邻或 null（变体 A 原型 closeTab 语义）
    closeTab(path: string): void {
      const idx = this.tabs.findIndex((t) => t.path === path)
      if (idx === -1) return
      this.tabs.splice(idx, 1)
      if (this.activePath === path) {
        const next = this.tabs[Math.max(0, idx - 1)] ?? null
        this.activePath = next ? next.path : null
      }
    },

    // 清全部 tab + active（保留 tree）—— 会话内清 tab 语义
    closeAll(): void {
      this.tabs = []
      this.activePath = null
    },

    // 全清（含 tree）—— 切会话语义（lab 随会话生灭：tree 清空后下次进「文件」分段触发 loadTree）
    reset(): void {
      this.tabs = []
      this.activePath = null
      this.tree = null
      this.treeTruncated = false
      this.treeError = null
    },
  },
})
