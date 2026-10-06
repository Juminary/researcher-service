// 工具调用上下文（AsyncLocalStorage）：wrapToolCall 中间件在 agent 工具执行外层盖印
// {toolCallId, threadId}，JournalingBackend 的写方法内读取——backend 协议面无身份参数
//（同 approval funnel 的 runtime 读取面），ALS 是唯一非侵入通道。
//
// ingestion/D9 物化（runner 侧调度，非 agent 工具）不走 ALS：显式传确定性幂等键
//（ingest-<attachmentId> / media-<attachmentId>，见 writer.ts）。
// ALS 无值（装配遗漏/非工具路径）→ 写打点降级随机 UUID 键——每次执行唯一 = 无重放去重，
// 退化为普通行（幂等性损失可接受，正确性无损：journal-first 管线本身仍完整）。

import { AsyncLocalStorage } from 'node:async_hooks'
import { createMiddleware } from 'langchain'

// AnyAgentMiddleware 结构面（langchain 类型随版本泛型漂移——downloadNode.ts:88 同纪律，宽化返回）
type AnyAgentMiddleware = ReturnType<typeof createMiddleware>

export interface ToolCallContext {
  readonly toolCallId: string
  readonly threadId: string
}

const storage = new AsyncLocalStorage<ToolCallContext>()

// run 上下文（journal 行 runId 回填键——checkpointId 终态回填按 runId 精确命中）：RunService
// 在 run 执行体外层盖印，与 per-toolCall ALS 独立（两层嵌套）。
const runStorage = new AsyncLocalStorage<string>()

export function runWithToolCallContext<T>(ctx: ToolCallContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

export function currentToolCallContext(): ToolCallContext | undefined {
  return storage.getStore()
}

export function runWithRunContext<T>(runId: string, fn: () => T): T {
  return runStorage.run(runId, fn)
}

export function currentRunId(): string | undefined {
  return runStorage.getStore()
}

// ---- langchain middleware（RunService middleware 链首位：deepagents wrapToolCall 先例）----

// 工具调用上下文盖印（#782）：toolCallId = 真实 tool_call_id（journal 幂等键）、threadId 透传。
// 无运行期闭包状态（拓扑推导约束同 approval funnel——纯 ALS 置位/复位）。
export function createToolCallContextMiddleware(): AnyAgentMiddleware {
  return createMiddleware({
    name: 'journal-tool-call-context',
    wrapToolCall: async (request, handler) => {
      const toolCallId = String(request.toolCall.id ?? '')
      const threadId = String(
        (request.runtime as { configurable?: { thread_id?: unknown } } | undefined)?.configurable?.thread_id ?? '',
      )
      return runWithToolCallContext({ toolCallId, threadId }, () => handler(request))
    },
  })
}
