import { resolveModelRef, type ModelRef } from '../providerRegistry'
import { teammateDelegation } from '../teammates/delegation'
import { snapshotRunCapabilities, type RunCapabilities } from '../capabilities'
import type { PluginRuntime } from '../../plugins/surface'
import { toLangChainTools, contentToText } from '../../plugins/tools'
import type { AnyPluginToolDefinition } from '../../plugins/api'
// RunService —— 集中式 runner 内核（#777 · #747 A 节「runner 编排」）。
//
// 职责（BullMQ 传输面之外的全部 run 机制）：
//   ① 同 thread 严格串行：进程内 per-thread promise 链（#723 风险条目「BullMQ per-thread
//      串行是全部责任」——BullMQ OSS 无 per-group 限流，worker 可并发领同 thread job，
//      顺序性在本层保证；串行链同时是 resume 互斥的原语：同 thread 命令天然全序）。
//   ② run 状态机：queued → running ⇄ interrupted → completed|failed|aborted（#747 C 节；
//      suspended 归 #783 审批）。观测面 stateOf 供 #778 门禁消费。
//   ③ 图实例缓存：key = (threadId, configVersion, interruptPolicy, backend 双根)——拓扑因子
//      全在键内，「图拓扑可由持久化状态推导」的缓存面表达；版本/policy/沙箱重建自然重建。
//   ④ 事件发射：run.started → 投影事件（RunProjector）→ 终态三分类，全部经 hub.publish
//      扇出该 user 全部连接（多端广播语义 #726）。
//   ⑤ 错误三分类（story 10）与 abort（story 8，by:user/system）。
//   ⑥ resume 互斥权威判定：executeRun 开头 state 必须为 interrupted（先到者已把它置为
//      running/终态，后到者 50001）。
//   ⑦ tracing 显式关闭（构造期兜底 + 装配层调用，见 tracing.ts）。
//   ⑧ usage 采数接线（#775 createUsageCallbackHandler；默认链主身份记账——V1 局限：
//      fallback 链切换后的 per-call 身份不追踪，采数不 fail run）。
//   ⑨ 沙箱执行前提（#776 契约「消费方 = #777 runner ensure/touch」）：run 前 ensure
//      （闲置自动 stop 后 re-ensure，文件保留语义）/ 事件流 touch（真 activity 源，
//      长 run 中途不被闲置 sweep）。
//
// 硬约束（PoC 坑 2）：streamEvents 的 version+configurable+recursionLimit+signal 必须同一
// 参数对象（buildStreamEventsInvocation 产出基座，就地展开合并字段）。
// 副作用纪律：interrupt 前 backend 工具未执行（探针实测 exec=0），resume 后恰执行一次
// （S4 快照锁定）——「interrupt 前副作用幂等或后置」。
//
// 信封错误面：额度 40043 / 会话不存在 50002 / resume 竞态败方 50001 以 EnvelopeError 抛出
// ——Inline 路径直接到达调用方（REST/#778 转信封）；BullMQ 路径表现为 job failed，
// run 域事件不受影响（未开始执行的 run 不发事件）。

import { randomUUID } from 'node:crypto'
import { HumanMessage, ToolMessage, type BaseMessage, type ContentBlock } from '@langchain/core/messages'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import type { AnyAgentMiddleware } from 'langchain'
import { Command, END } from '@langchain/langgraph'
import { ERROR, INTERRUPT } from '@langchain/langgraph-checkpoint'
import {
  ApprovalFunnel,
  isApprovalInterruptPayload,
  type ApprovalInterruptPayload,
  type RejectionNotice,
} from '../approval/funnel'
import { APPROVAL_EVENT_REQUESTED, APPROVAL_EVENT_RESOLVED, APPROVAL_TIMEOUT_MS } from '../approval/values'
import { ancestorChainOf } from '../../checkpointChain'
import type { PrismaClient } from '../../generated/prisma/client'
import { CODE } from '../../codes'
import { fail } from '../../envelope'
import { getSessionForUser } from '../../sandboxes/service'
import type { CatalogEvent } from '../../events/logic'
import type { StreamHub } from '../../events/hub'
import type { SandboxFilePrimitives } from '../backend/primitives'
import { DockerArchiveBackend } from '../backend/dockerArchiveBackend'
import { WriteLockRegistry, DEFAULT_WRITE_LOCK_TIMEOUT_MS } from '../writelock/registry'
import { withWriteLocks, withLockedPuts, type WriteLockContext } from '../writelock/lockedBackend'
import { OverwriteAuditor, createPrismaJournalWriterReader, createPrismaOverwriteAuditSink } from '../writelock/overwriteAudit'
import type { PrismaCheckpointSaver } from '../persistence/prismaCheckpointSaver'
import type { ProviderRegistry, ProviderConfigSnapshot } from '../providerRegistry'
import type { ConcurrencyGate } from '../concurrency'
import { createUsageCallbackHandler } from '../usage'
import { buildStreamEventsInvocation } from '../../events/bridge'
import { RunProjector } from './projector'
import { classifyRunError, type RunErrorKind } from './errorKind'
import { buildLeaderAgent, interruptPolicyKey, type DeepAgentLike, type InterruptPolicy, type LeaderAgentParams } from './graphFactory'
import { COMPACT_KEEP, COMPACT_SUMMARY_PROMPT, DEFAULT_RECURSION_LIMIT, DEFAULT_RESUME_DECISIONS, GRAPH_CACHE_MAX_INSTANCES, LEADER_SYSTEM_PROMPT, TOOL_DETAILS_MAX_BYTES, TOOL_INPUT_MAX_BYTES, TRUNCATED_FLAG } from './values'
import { truncateUtf8 } from './projector'
import { disableLangsmithTracing } from './tracing'
import { lastMessage, scanMediaBlocks } from './mediaBlocks'
import { turnFromCheckpointMessages } from './checkpointTurn'
import { TurnReducer, isEmptyTurnSnapshot, type RecordTurnPayload, type TurnSnapshot } from '../../sessions/reducer'
import { TeammateService, type TeammateSummary } from '../teammates/service'
import { createTeammateTools } from '../teammates/tools'
import type { FileJournalService } from '../filejournal/service'
import { createToolCallContextMiddleware, runWithRunContext } from '../filejournal/context'
import { IDEMPOTENCY_INGEST_PREFIX, IDEMPOTENCY_MEDIA_PREFIX } from '../filejournal/values'
import { createWikiRetrievalTools } from '../wikisearch'
import {
  pullWikiGenerationMirror,
  pushBackWikiGenerationMirror,
  readContainerWikiTree,
  type WikiGenerationMirror,
} from '../wikigen/mirror'
import { createWikiLifecycleTools } from '../wikigen/lifecycleTools'
import { buildWikiUpdateBackend, wikiMirrorRouteRootDir } from '../wikigen/backend'
import {
  WIKI_CONFLICT_MAIL_KIND,
  WIKI_UPDATE_HOST_ID,
  WIKI_UPDATE_TEAMMATE_KIND,
  WIKI_UPDATE_TEAMMATE_PROMPT,
} from '../wikigen/values'
import type { WikiToolResult } from '../wikisearch'
import { HostSessionManager } from 'openwiki/dist/integrations/core/session-manager.js'
import { FilesystemBackend } from 'deepagents'

// recordTurn 注入缝（#778）：run 终态（completed/interrupted/aborted/failed 任一）的单 turn
// 聚合落库回调。anchorCheckpointId = 终态 checkpoint 锚点（issue 点名列；aborted/failed 路径
// 无可靠 state → null）。生产实现 = SessionService.recordTurn（落 session_messages + 自动标题）；
// 测试注收集器。setter 注入原因：SessionService 依赖本 service 实例（门禁/命令面），构造顺序
// 晚于 RunService——constructor 注入会成环。载荷 RecordTurnPayload 单一声明于 sessions/reducer。
export type RecordTurnFn = (p: RecordTurnPayload) => Promise<void>

// run 命令（BullMQ job data 契约：纯 JSON 可序列化，无内存句柄——进程内状态全弃后凭 DB
// 重投可从头重跑，副作用幂等约束在案；重放归一化面见 normalizeReplay）。
export interface RunCommand {
  readonly runId: string
  readonly sessionId: string
  readonly ownerId: string
  readonly username: string
  readonly kind: 'message' | 'resume' | 'recover'
  /** #787 story 45：kind=message 的系统命令形态（/compact 显式压缩——REST 侧已校验无参）；
   *  #788：'plugin-execute' = 插件命令 {execute} outcome（直达本插件工具执行面，不经 agent） */
  readonly operation?: 'compact' | 'plugin-execute'
  /** operation='plugin-execute'：目标插件工具名（启用集内）与 zod 解析前参数 */
  readonly pluginTool?: string
  readonly pluginArgs?: unknown
  readonly teammateId?: string
  readonly parentSessionId?: string
  readonly mailWaitId?: string
  readonly mailWakeReason?: 'message' | 'timeout'
  readonly mailBroadcastOnTimeout?: boolean
  /** kind=message：用户消息文本 */
  readonly content?: string
  /** kind=message：#780 附件引用（雪花 attachmentId 列表；ingestion 节点消费，片 2） */
  readonly attachmentIds?: readonly string[]
  /** kind=resume：HITL 决策（{decisions:[...]} 形态，PoC 实测） */
  readonly decisions?: unknown
  /** kind=resume：abort 语义（#783 story 15——suspended/interrupted run 的终态出路：
   *  Command({resume, goto: END}) 终止图执行，run 落 aborted 终态而非续跑） */
  readonly abort?: boolean
}

// suspended（#783 story 15）：审批升级 48h 未落定——非终态（interrupted ⇄ suspended），
// 可 resume / abort。仅审批漏斗升级会进入（deepagents interruptOn 的 V1 测试面不计时）。
export type RunState = 'queued' | 'running' | 'interrupted' | 'suspended' | 'completed' | 'failed' | 'aborted'

export interface RunSnapshot {
  readonly runId: string
  readonly state: RunState
  readonly errorKind?: RunErrorKind
  readonly by?: 'user' | 'system'
}

// stream.hub 的结构子集——runner 只需要 publish，不感知连接管理。
export type EventPublisher = Pick<StreamHub, 'publish'>

export interface RunServiceDeps {
  readonly prisma: PrismaClient
  readonly registry: ProviderRegistry
  readonly saver: PrismaCheckpointSaver
  readonly gate: ConcurrencyGate
  readonly hub: EventPublisher
  /** runner backend 的 Docker 原语（S2 接缝；生产 dockerode 适配，测试 fake） */
  readonly primitives: SandboxFilePrimitives
  /** wiki 容器名解析（#784 起经 wikiContainerName 单一来源派生；测试注入同名 fake） */
  readonly resolveWikiContainer: (ownerId: string) => string
  /** 沙箱生命周期（#776；SandboxLifecycle 结构子集）。缺省回退 session.containerId（测试）。 */
  readonly sandboxes?: {
    ensure: (sessionId: string) => Promise<{ containerId: string }>
    touch: (sessionId: string) => void
  }
  /** wiki 容器生命周期（#784；WikiContainerLifecycle 结构子集）。run 前 ensure——/wiki/
   * 工具根就绪（惰性创建零初始化 + stopped 复启，永久容器无 touch 面）。缺省不 ensure（测试）。
   * 返回 void：/wiki/ 容器名经 resolveWikiContainer 单一来源派生，ensure 的快照无消费面。 */
  readonly wikis?: {
    ensure: (ownerId: string) => Promise<void>
  }
  /** interrupt 策略源（拓扑因子；V1 无审批恒 undefined，#783 由持久化维度派生——测试注入） */
  readonly interruptPolicyFor?: (sessionId: string) => InterruptPolicy | undefined
  /** #780 附件 ingestion（片 2）：run 首步确定性物化附件到沙箱 + 图片内联多模态。缺省不注 =
   * message 命令带附件时跳过物化（测试无附件面）；装配层注入 AttachmentsService。 */
  readonly attachments?: {
    readonly ingestAttachments: (p: {
      sessionId: string
      attachmentIds: readonly string[]
      container: string // 沙箱容器名（/lab 工具根）
      primitives: Pick<SandboxFilePrimitives, 'exec' | 'putArchive'>
    }) => Promise<Array<{ attachmentId: string; mimeType: string }>>
    readonly readTempBytes: (attachmentId: string) => Promise<Buffer>
    /** #780 D9 agent→用户媒体物化（片 3）：校验/拷进 uploads/建行；null = 校验失败（降级面） */
    readonly materializeAgentMedia: (p: {
      sessionId: string
      ownerId: string
      declaredPath: string
      mime: string
      container: string
      primitives: Pick<SandboxFilePrimitives, 'exec' | 'getArchive' | 'putArchive'>
    }) => Promise<{ attachmentId: string; fileName: string; mimeType: string; size: number } | null>
  }
  /** 审批三层漏斗（#783）。与 interruptPolicyFor（V1 测试面）可并存，生产只接前者。 */
  readonly approvals?: ApprovalFunnel
  readonly teammates?: TeammateService
  /** 插件运行时（#788 · #752 §4.2）：per-run 启用集静态过滤 → 插件工具/prompt 进图；
   *  目录版本进图缓存键。缺省不注 = 无插件维度（测试）。 */
  readonly plugins?: PluginRuntime
  /** #780 下载校验节点（片 3：file 写类工具成功后校验声明路径 → 物化 + 下载引用进 tool 输出；
   * 失败 → 错误回喂 agent 重新生成）。缺省不注 = 工具产物面关闭（测试）。 */
  readonly downloadNode?: { readonly middleware: AnyAgentMiddleware }
  /** 审批升级超时（默认 48h，729 附录 B；测试注入缩短） */
  readonly approvalTimeoutMs?: number
  /** 文件 rewind 机制（#782 · D8）：JournalingBackend 打点接缝 + ingestion/D9 物化打点 +
   *  journal checkpointId 终态回填。缺省不注 = backend 直用 DockerArchiveBackend、物化直写
   *  （journaling 关闭——测试/降级面）。 */
  readonly fileJournal?: FileJournalService
  /** #785 per-path 写锁注册表（缺省进程内新建——测试无注入也全量生效；生产由装配层注入
   *  config.runner.writeLockTimeoutMs 形态）。有界等待默认见 DEFAULT_WRITE_LOCK_TIMEOUT_MS。 */
  readonly writeLocks?: WriteLockRegistry
  /** 挂起清扫定时器间隔（毫秒；缺省 5min，0 = 不启动定时器——测试手动调 sweepSuspensions） */
  readonly sweepIntervalMs?: number
  readonly recursionLimit?: number
  /** 毫秒时钟（durationMs 计时；缺省 Date.now，测试注入步进时钟） */
  readonly clock?: () => number
}

// getState 快照的结构子集（PoC 实测：agent.graph.getState）。
interface GraphStateLike {
  next?: string[]
  tasks?: { interrupts?: unknown[] }[]
  // LangGraph StateSnapshot.values（channel 值）——终态 messages（#780 D9 媒体块扫描源）；
  // /compact（#787 story 45）另读 summarization middleware 的私有压缩态
  //（deepagents SummarizationEvent：{cutoffIndex, summaryMessage, filePath}）。
  values?: {
    messages?: BaseMessage[]
    _summarizationEvent?: { cutoffIndex: number; summaryMessage: BaseMessage }
  }
  // LangGraph StateSnapshot.config.configurable.checkpoint_id——终态 checkpoint 锚点
  //（#778 session_messages.anchorCheckpointId 落值来源；issue 正文点名该列）。
  config?: { configurable?: { checkpoint_id?: string } }
}

// LangGraph interrupt 的 putWrites channel：上游一等导出 INTERRUPT/RESUME/ERROR（checkpoint
// 包 WRITES_IDX_MAP 的负 idx 通道键，prismaCheckpointSaver「不自造」同纪律）——三包升级
// 通道名漂移时此处类型红，推导面不会静默失效。
const INTERRUPT_CHANNEL = INTERRUPT
// resume 重放判据用：__error__ = 上一次 super-step 有任务异常中断（normalizeReplay 用）。
const ERROR_CHANNEL = ERROR

// story 11 · in-flight 投影（投影 GET inFlight 字段）：重连补偿的进行中 turn 重建面。
export interface InFlightProjection {
  readonly runId: string
  readonly state: 'queued' | 'running'
  readonly turn: TurnSnapshot
}

// 审批升级挂起记录（#783）：interrupt 检出时落（事件 + 48h 死线），resume/落定时清。
type RunEventContext = Pick<RunCommand, 'sessionId' | 'runId' | 'ownerId' | 'parentSessionId' | 'teammateId'>

interface PendingApproval extends Omit<RunEventContext, 'sessionId'> {
  readonly escalationId: string
  readonly deadlineAt: number
}

export class RunService {
  private readonly graphs = new Map<string, DeepAgentLike>()
  private readonly runs = new Map<string, RunSnapshot>()
  private readonly aborts = new Map<string, { controller: AbortController; by: 'user' | 'system' }>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly resolvingApprovals = new Set<string>()
  /** 在飞 run 命令（threadId → cmd；拒绝红显事件的归属盖印源） */
  private readonly activeCmds = new Map<string, RunEventContext>()
  private readonly sessionLeases = new Map<string, { ownerId: string; threads: Set<string>; lease: Promise<Awaited<ReturnType<ConcurrencyGate['acquire']>>> }>()
  private readonly recursionLimit: number
  private readonly approvalTimeoutMs: number
  private readonly clock: () => number
  /** #785 per-path 写锁 + 覆盖审计（构造期装配——deps 缺省也生效，行为面无开关） */
  private readonly writeLocks: WriteLockRegistry
  private readonly overwriteAuditor: OverwriteAuditor
  private recordTurn: RecordTurnFn | undefined
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private queuedDispatch = false
  private dispatch: (cmd: RunCommand, delayMs?: number) => Promise<void> = (cmd) => this.execute(cmd)

  constructor(private readonly deps: RunServiceDeps) {
    this.recursionLimit = deps.recursionLimit ?? DEFAULT_RECURSION_LIMIT
    this.approvalTimeoutMs = deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS
    this.clock = deps.clock ?? (() => Date.now())
    // #785 写锁（缺省新建 = 测试零注入也生效；生产经装配层注入 config 超时形态）+ 覆盖审计
    //（journal 上家 writer 读取 + file_overwrite_logs sink，同 prisma 实例）。
    this.writeLocks = deps.writeLocks ?? new WriteLockRegistry({ timeoutMs: DEFAULT_WRITE_LOCK_TIMEOUT_MS })
    this.overwriteAuditor = new OverwriteAuditor(
      createPrismaJournalWriterReader(deps.prisma),
      createPrismaOverwriteAuditSink(deps.prisma),
    )
    // 构造期兜底：任何 runner 实例化路径都覆盖 env 误开（装配层亦显式调用，双保险）
    disableLangsmithTracing()
    // 拒绝红显事件接线：漏斗判定时回调（同步），按在飞 cmd 盖印发布
    this.deps.approvals?.setRejectionSink((notice) => this.publishRejection(notice))
    // 挂起清扫定时器（48h 死线 → suspended；测试可 0 关闭手动 sweep）
    const sweepInterval = deps.sweepIntervalMs ?? 300_000
    if (deps.approvals && sweepInterval > 0) {
      this.sweepTimer = setInterval(() => this.sweepSuspensions(), sweepInterval)
      this.sweepTimer.unref?.()
    }
  }

  // 停清扫定时器（装配层 close 调用；幂等）
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
  }

  // 装配期注入 session_messages 落库缝（见 RecordTurnFn 注；幂等——重复注入覆盖前者）。
  setRecordTurn(fn: RecordTurnFn | undefined): void {
    this.recordTurn = fn
  }

  setTeammateDispatcher(dispatch: (cmd: RunCommand, delayMs?: number) => Promise<void>): void {
    this.queuedDispatch = true
    this.dispatch = dispatch
  }

  // ---- 命令构造（REST/传输面用；runId 单点生成）----

  buildCommand(params: {
    sessionId: string
    ownerId: string
    username: string
    kind: 'message' | 'resume'
    content?: string
    attachmentIds?: readonly string[]
    decisions?: unknown
  }): RunCommand {
    return { runId: randomUUID(), ...params }
  }

  // ---- 发消息入口（story 7 的 runner 侧；幂等 key/落 session_messages 归 #778）----
  // 归属判定复用 #776 getSessionForUser（admin 全放行 / user 仅本人；「不存在 vs 越权」
  // 同码 50002 防探测，区分仅进服务端日志——#312⑤；#778 落地后保留为内核防御面（REST 面
  // #778 已前置同判定——双层对齐 50004/50003 门禁先例：REST 即时反馈 + 内核权威兜底）。
  // 额度即时反馈面归 #778 REST（读 gate.inFlight），权威判定在 executeNow 的 gate.acquire
  //（满 → 40043）。
  async buildMessageCommand(params: {
    sessionId: string
    ownerId: string
    username: string
    content: string
    attachmentIds?: readonly string[]
  }): Promise<RunCommand> {
    const caller = await this.deps.prisma.user.findUnique({
      where: { id: params.ownerId },
      select: { role: true },
    })
    if (!caller) {
      // eslint-disable-next-line no-console
      console.warn(`[runner] message caller not_found: id=${params.ownerId} session=${params.sessionId}`)
      throw fail(CODE.SESSION_NOT_FOUND)
    }
    await getSessionForUser(this.deps.prisma, { id: params.ownerId, role: caller.role }, params.sessionId)
    return this.buildCommand({ ...params, kind: 'message' })
  }

  async resolveModelSelection(ownerId: string, args: string): Promise<{ model?: ModelRef | null; models?: readonly ModelRef[]; appliesTo?: 'next-run' }> {
    const snapshot = await this.deps.registry.getSnapshot(ownerId)
    if (!args) return { models: snapshot.providers.flatMap(provider => provider.models.map(model => ({ providerId: provider.providerId, modelId: model.id }))) }
    if (args === 'default') return { model: null, appliesTo: 'next-run' }
    const match = /^([^\s/]+)\/(\S+)$/.exec(args)
    if (!match) throw fail(CODE.VALIDATION_FAILED, '用法：/model providerId/modelId，或 /model default')
    return { model: resolveModelRef(snapshot, { providerId: match[1]!, modelId: match[2]! }), appliesTo: 'next-run' }
  }

  // ---- resume 命令构造：interrupted 态预检（权威互斥判定在 executeRun）----
  // 预检只拒内存面权威可知的失败（state 已被先到者推离 interrupted）。内存缺失（控制面
  // 重启/跨进程 resume）不在此误报 50001——放行至 executeRun，由 checkpoint 推导
  //（threadInterruptedFromCheckpoint）权威判定；S4 A2「断线」场景的入口面。
  buildResumeCommand(params: {
    sessionId: string
    ownerId: string
    username: string
    decisions?: unknown
  }): RunCommand {
    const snap = this.runs.get(params.sessionId)
    if (snap && snap.state !== 'interrupted') throw fail(CODE.RUN_ALREADY_RESUMED)
    return this.buildCommand({
      sessionId: params.sessionId,
      ownerId: params.ownerId,
      username: params.username,
      kind: 'resume',
      decisions: params.decisions ?? DEFAULT_RESUME_DECISIONS,
    })
  }

  // ---- 中断（story 8；REST 面归 #778）----
  // 仅对 running 在飞 run 有效（aborts 条目随 executeRun finally 清除——interrupted/终态
  // run 返 false）。interrupted run 的「不审批直接终止」面归 #783 审批漏斗/#778——既有
  // 出路 = reject 决策 resume（50003 文案同源）。
  abort(runId: string, by: 'user' | 'system' = 'user'): boolean {
    const a = this.aborts.get(runId)
    if (!a) return false
    a.by = by
    a.controller.abort()
    return true
  }

  // ---- 状态观测面（#778 门禁/回放消费）----
  stateOf(sessionId: string): RunSnapshot | undefined {
    return this.runs.get(sessionId)
  }

  async pendingApprovalProjection(threadId: string): Promise<ApprovalInterruptPayload[]> {
    const state = this.runs.get(threadId)?.state
    if (state && state !== 'interrupted' && state !== 'suspended') return []
    const tuple = await this.latestTuple(threadId)
    const pending: ApprovalInterruptPayload[] = []
    for (const [, channel, raw] of tuple?.pendingWrites ?? []) {
      if (channel !== INTERRUPT_CHANNEL) continue
      const value = (raw as { value?: unknown } | null)?.value ?? raw
      if (isApprovalInterruptPayload(value)) pending.push(value)
    }
    return pending
  }

  // 额度满预检（#778 REST 即时反馈；#777 注释契约「额度即时反馈面归 #778」）——只读不占额，
  // 权威判定仍在 executeNow 的 gate.acquire。
  quotaFull(ownerId: string, sessionId?: string): Promise<boolean> {
    if (sessionId && this.sessionLeases.get(sessionId)?.ownerId === ownerId) return Promise.resolve(false)
    return this.deps.gate.wouldReject(ownerId)
  }

  // ---- 执行（传输面调用点：Inline 直调 / BullMQ worker processor）----
  // 同 thread 串行链：任意时刻同 thread 至多一个 executeRun 在跑，其余按提交序排队。
  // executeNow 的信封错误（40043/50002）向上传播；run 执行体错误在 executeRun 内消化
  //（终态事件已发，对传输面表现为正常完成）。
  async execute(cmd: RunCommand): Promise<void> {
    // Each command is a root graph, even when dispatched from another graph's tool.
    // Inheriting the caller's Pregel config makes teammate interrupts bubble into the leader.
    return AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => this.executeCommand(cmd))
  }

  private async executeCommand(cmd: RunCommand): Promise<void> {
    // 重放归一化（story 14）：BullMQ v6 stalled job 绕过 attempts 自动重放（#779 探针实测）
    // ——「message 重复 append / resume 50001」的重放风险在内核单点拦截，checkpoint 判据
    // 见 normalizeReplay。Inline/测试路径判据不命中即原样（零行为差异）。
    cmd = await this.normalizeReplay(cmd)
    // 入队面 fast-fail：interrupted/suspended 态 message 拒绝（queued 覆盖之前——#747 C 节
    // 「interrupt 全端可审批」，见 executeRun 权威面）。recover 不拒（恢复面权威——判据已在
    // normalizeReplay 核验，重放的 message 语义已由 checkpoint 承接）。
    const entryState = this.runs.get(cmd.sessionId)?.state
    if (cmd.kind === 'message' && (entryState === 'interrupted' || entryState === 'suspended')) {
      throw fail(CODE.RUN_INTERRUPT_PENDING)
    }
    // queued 只标 message/recover 命令的新 run，且仅在无活跃条目时落——running/queued 不被
    // 新排队命令覆盖（stateOf 是 #778「running 全端禁输入」门禁 + #779 inFlight 投影的观测
    // 面，覆盖即门禁失效）；resume 延续既有 run（interrupted 保持到 running，否则 executeRun
    // 的互斥权威判定会被覆盖态误伤）。interrupted 态已在上方 fast-fail 拒绝，不会走到覆盖。
    if (cmd.kind === 'message' || cmd.kind === 'recover') {
      const prev = this.runs.get(cmd.sessionId)
      const active =
        prev !== undefined &&
        (prev.state === 'running' || prev.state === 'queued' || prev.state === 'interrupted' || prev.state === 'suspended')
      if (!active) this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'queued' })
    }
    const prev = this.chains.get(cmd.sessionId) ?? Promise.resolve()
    const task = prev.then(
      () => this.executeNow(cmd),
      () => this.executeNow(cmd),
    )
    const tail = task.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(cmd.sessionId, tail)
    void tail.then(() => {
      if (this.chains.get(cmd.sessionId) === tail) this.chains.delete(cmd.sessionId)
    })
    return task
  }

  // ---- 重放归一化（story 14）：BullMQ stalled 自动重放的「重放 vs 首次执行」判别 ----
  //
  // #779 探针实测的行为基线：崩溃的在飞 job 被新 worker stalled check 移回 wait 重新执行
  //（attempts:1 不拦——stalled 是独立恢复机制）。重放 message 会重复 append 用户消息、
  // 重放 resume 会被互斥判定误拒 50001——两类都把 run 卡死。判据全部 checkpoint 面（无
  // BullMQ API 依赖，Inline 路径零影响）：
  //   message：checkpoint messages 存在 id=runId 的消息（executeRun 构造 HumanMessage 时
  //            以 runId 盖印——命令→消息的持久锚）⇔ 该命令已入图 → 转 recover（null input
  //            从 checkpoint 续跑）。
  //   resume：pendingWrites 无 interrupt 且带 __error__（节点异常崩溃必落 error write，
  //            #779 探针实测）⇔ 上一次执行异常中断 → 转 recover。有 interrupt = 未执行 →
  //            原样重放（resume 重试，负 idx RESUME 覆盖幂等）；两者皆无（已完成会话的
  //            终态 checkpoint 无 writes）= 用户乱调 → 原样走 executeRun 权威 50001，
  //            不放大为续跑（API 语义保留）。已知边界：SIGKILL 窗口（RESUME 消费后、
  //            error write 落盘前崩）不可判别 → 50001 卡死，重放 job failed——窗口毫秒级，
  //            实害 = 该 run 不自动续跑（数据无损），重试面归用户重新发消息。
  //
  // #779 探针验证的 LangGraph null-input 三形态（recover 的执行语义依据）：
  //   checkpoint 带 pending interrupt → no-op（不误触发审批消费）
  //   图中途崩溃（error write 在）→ 从 checkpoint 续跑剩余节点（失败任务重试）
  //   图已完成 → no-op（流空结束，落 completed；防双行见 executeRun finally）
  //
  // 成本：每条 message/resume 命令一次 getTuple（SQLite 本地读，与 message 门禁
  // threadInterruptedFromCheckpoint 同量级——人机尺度可忽略）。
  private async normalizeReplay(cmd: RunCommand): Promise<RunCommand> {
    if (cmd.kind !== 'message' && cmd.kind !== 'resume') return cmd
    let tuple: LatestCheckpointTuple | undefined
    try {
      tuple = await this.latestTuple(cmd.sessionId)
    } catch {
      return cmd // checkpoint 故障不拦——原路径的门禁/互斥/错误面兜底
    }
    if (cmd.kind === 'message') {
      const messages = channelMessages(tuple)
      const replayed = messages.some((m) => (m as { id?: unknown } | null)?.id === cmd.runId)
      return replayed ? { ...cmd, kind: 'recover' } : cmd
    }
    const pendingWrites = tuple?.pendingWrites ?? []
    const hasInterrupt = pendingWrites.some(([, channel]) => channel === INTERRUPT_CHANNEL)
    if (hasInterrupt) return cmd
    const hasErrorWrite = pendingWrites.some(([, channel]) => channel === ERROR_CHANNEL)
    return hasErrorWrite ? { ...cmd, kind: 'recover' } : cmd
  }

  // ---- in-flight 投影（story 11）：投影 GET 的补偿重建面（重拉投影同帧带出）----
  // running：从 checkpoint blob 反序列化重建进行中 turn（即焚 token 事件的补偿真相源——
  // 「最后一条 human 之后」切片，见 checkpointTurn.ts）。queued：消息未入图，无内容可重建
  //（空 turn）。checkpoint 读故障降级空 turn（补偿面不炸投影——终态行兜底回放）。仅内存
  // 观测态（stateOf）判定在飞：控制面重启窗口（内存丢、job 未重放）秒级缺失，恢复后可见。
  async inFlightProjection(sessionId: string): Promise<InFlightProjection | undefined> {
    const snap = this.runs.get(sessionId)
    if (!snap || (snap.state !== 'queued' && snap.state !== 'running')) return undefined
    if (snap.state === 'queued') return { runId: snap.runId, state: 'queued', turn: { content: '' } }
    let turn: TurnSnapshot
    try {
      turn = await this.turnSnapshotFromCheckpoint(sessionId)
    } catch {
      turn = { content: '' }
    }
    return { runId: snap.runId, state: 'running', turn }
  }

  private publish(
    ownerId: string,
    ev: Omit<CatalogEvent, 'sessionId' | 'runId'>,
    cmd: Omit<RunEventContext, 'ownerId'>,
  ): void {
    this.deps.hub.publish(ownerId, {
      ...ev,
      sessionId: cmd.parentSessionId ?? cmd.sessionId,
      runId: cmd.runId,
      ...(cmd.teammateId ? { teammateId: cmd.teammateId } : {}),
    })
  }

  private async executeNow(cmd: RunCommand): Promise<void> {
    const parentId = cmd.parentSessionId ?? cmd.sessionId
    let shared = this.sessionLeases.get(parentId)
    if (!shared) {
      shared = { ownerId: cmd.ownerId, threads: new Set(), lease: this.deps.gate.acquire(cmd.ownerId) }
      this.sessionLeases.set(parentId, shared)
    }
    shared.threads.add(cmd.sessionId)
    try {
      if (shared.ownerId !== cmd.ownerId) throw fail(CODE.SESSION_NOT_FOUND)
      await shared.lease
      await this.executeRun(cmd)
    } catch (e) {
      // pre-start 失败回滚 queued 占位（40043/50003 等——「未开始执行的 run 不发事件」
      // 同纪律：不留观测态）。回滚只认本命令的 queued 条目（runId 匹配），不碰后继命令的。
      const snap = this.runs.get(cmd.sessionId)
      if (snap?.state === 'queued' && snap.runId === cmd.runId) this.runs.delete(cmd.sessionId)
      throw e
    } finally {
      if (cmd.kind === 'resume') this.resolvingApprovals.delete(cmd.sessionId)
      shared.threads.delete(cmd.sessionId)
      if (shared.threads.size === 0) {
        this.sessionLeases.delete(parentId)
        await shared.lease.then(lease => lease.release(), () => {})
      }
    }
  }

  private async executeRun(cmd: RunCommand): Promise<void> {
    // resume 互斥权威判定：先到者已把 state 推离 interrupted（串行链保证本检查原子于
    // 同 thread 的其它命令），后到者 50001。message 命令不做此检查（queued 态可覆盖）。
    // 内存态缺失（控制面重启/跨进程 resume）→ 从持久化状态推导（#747 A 节硬约束：
    // 「图拓扑必须可由持久化状态推导」——最新 checkpoint 带 pending interrupt ⇔ interrupted）。
    // recover 跳过两者（恢复面权威：重放判据已在 normalizeReplay 核验）。
    if (cmd.kind === 'resume') {
      let snap = this.runs.get(cmd.sessionId)
      if (!snap) {
        const interrupted = await this.threadInterruptedFromCheckpoint(cmd.sessionId)
        if (interrupted) {
          snap = { runId: cmd.runId, state: 'interrupted' }
          this.runs.set(cmd.sessionId, snap)
        }
      }
      // suspended 可 resume（#783 story 15：48h 超时非终态）
      if (!snap || (snap.state !== 'interrupted' && snap.state !== 'suspended')) {
        throw fail(CODE.RUN_ALREADY_RESUMED)
      }
      this.pendingApprovals.delete(cmd.sessionId) // 升级落定，48h 死线随清
    } else if (cmd.kind === 'message') {
      // #747 C 节「running 全端禁输入、interrupt 全端可审批」的内核权威面：interrupted 态
      // message 会作废 pending interrupt（静默丢审批）——拒绝之（#778 REST 门禁之外的第二
      // 道，接线遗漏不丢 interrupt）。queued/内存缺失态（排队窗口撞上前序 run 中断、重启后
      // 首条消息）走 checkpoint 推导同挡——每条消息一次 getTuple，SQLite 本地读，人机尺度可忽略。
      const snap = this.runs.get(cmd.sessionId)
      const threadInterrupted =
        snap?.state === 'interrupted' ||
        snap?.state === 'suspended' ||
        ((snap === undefined || snap.state === 'queued') &&
          (await this.threadInterruptedFromCheckpoint(cmd.sessionId)))
      if (threadInterrupted) throw fail(CODE.RUN_INTERRUPT_PENDING)
    }

    const session = await this.deps.prisma.session.findUnique({ where: { id: cmd.sessionId } })
    if (!session) throw fail(CODE.SESSION_NOT_FOUND)
    if (cmd.teammateId) {
      const teammate = await this.deps.prisma.teammate.findUnique({ where: { id: cmd.teammateId } })
      if (!teammate || teammate.archivedAt || teammate.threadId !== cmd.sessionId || teammate.parentSessionId !== cmd.parentSessionId || session.ownerId !== cmd.ownerId) throw fail(CODE.SESSION_NOT_FOUND)
    }

    // 沙箱执行前提（#776 契约「消费方 = #777 runner ensure/touch」）：闲置自动 stop 后
    // re-ensure（stopped → start，文件保留），返回容器即 /lab/ 工具根（可能 ≠
    // session.containerId 陈旧值）。失败按 pre-start 面向上传播（job failed / Inline 调用方；
    // 未开始执行的 run 不发 run 域事件——文件头信封错误面，registry 故障同先例）。
    const sandboxSessionId = cmd.parentSessionId ?? cmd.sessionId
    const sandbox = this.deps.sandboxes ? await this.deps.sandboxes.ensure(sandboxSessionId) : undefined
    const labContainer = sandbox?.containerId ?? session.containerId
    // #785 ingestion/校验节点写面入锁：putArchive 按 tar 内单文件名取文件级锁（互斥域 =
    // 沙箱所属 parent session；图缓存跨 run，每次 op 经 ctx 现取 holder）。覆盖审计与
    // backend 层同形接线（detect/record 两段式）。
    const runPrimitives = withLockedPuts(
      this.deps.primitives,
      this.writeLocks,
      () => this.writeLockContext(sandboxSessionId, cmd.sessionId),
      this.overwriteAuditor,
    )
    // wiki 容器执行前提（#784 契约）：run 前 ensure 用户 wiki 容器——/wiki/ 工具根就绪
    //（不存在惰性创建零初始化、stopped 复启；永久容器随用户生命周期，无 touch 面）。失败
    // 同沙箱：pre-start 面向上传播，不发 run 域事件。
    await this.deps.wikis?.ensure(cmd.ownerId)

    const snapshot = await this.deps.registry.getSnapshot(cmd.ownerId)
    const capabilities = await snapshotRunCapabilities(this.deps.prisma, cmd.ownerId)
    const actor = cmd.teammateId
      ? await this.deps.teammates?.get(cmd.parentSessionId ?? cmd.sessionId, cmd.teammateId)
      : undefined
    const preferred: ModelRef | undefined = session.preferredModelJson ? JSON.parse(session.preferredModelJson) : undefined
    const model = actor?.modelProviderId
      ? await this.deps.registry.getModel(snapshot, actor.modelProviderId)
      : await this.deps.registry.getDefaultModel(snapshot, preferred)
    const policy = this.deps.interruptPolicyFor?.(cmd.sessionId)
    const tools = this.deps.teammates
      ? createTeammateTools({
          parentSessionId: cmd.parentSessionId ?? cmd.sessionId,
          actorTeammateId: cmd.teammateId ?? null,
          service: this.deps.teammates,
          checkpointId: async () => {
            const tuple = await this.deps.saver.getTuple({ configurable: { thread_id: cmd.parentSessionId ?? cmd.sessionId } })
            return tuple?.config.configurable?.checkpoint_id as string | undefined ?? null
          },
          start: (teammate) => this.startTeammate(cmd, teammate),
          scheduleTimeout: (input) => this.scheduleMailboxTimeout(cmd, input),
          abort: async (teammate) => { this.stopTeammate(cmd, teammate) },
        })
      : []

    // ---- wiki 治理生成路径（#790 三通道②：kind=wiki-update 的 teammate run）----
    // 落地副本执行模型：run 开始（wikis ensure 之后）把 wiki 容器整树 pull 到控制面临时镜像；
    // 生命周期工具的 finish 触发「base-hash 复检 → 推回 → 冲突信箱邮件」（finishWikiGeneration）；
    // executeRun finally dispose 镜像——中断/失败 = 作废不推回，只有 finish 推回。镜像随 run
    // 生命周期存活：resume/recover 重建 = 新镜像 + 新 HostSessionManager（openwiki durable
    // .run.json 不跨镜像；与「中断 = 作废」语义一致），故图构建跳缓存（镜像根 per-run 必新，
    // 命中旧缓存 = backend 指向已 dispose 的临时目录）。
    // pull 失败 = pre-start 面（同上方 wikis.ensure）：running 迁移之前向上传播、不发 run 域
    // 事件，queued 占位由 executeNow catch 回滚（不残留非终态）；镜像临时目录由 mirror.ts
    // 自清（pull 的 catch rm root）。
    const wikiContainer = this.deps.resolveWikiContainer(cmd.ownerId)
    const wikiUpdate = actor?.kind === WIKI_UPDATE_TEAMMATE_KIND
    const wikiMirror = wikiUpdate ? await pullWikiGenerationMirror(this.deps.primitives, wikiContainer) : undefined
    const lifecycleTools =
      wikiUpdate && wikiMirror
        ? createWikiLifecycleTools({
            manager: HostSessionManager.create({ host: WIKI_UPDATE_HOST_ID }),
            mirrorRoot: wikiMirror.root,
            onFinished: () => this.finishWikiGeneration(cmd, wikiMirror, wikiContainer),
          })
        : []

    const modelKey = actor?.modelProviderId ? `provider:${actor.modelProviderId}` : session.preferredModelJson ?? 'default'
    // 插件工具/prompt（#788 §4.2）：run 粒度启用集静态过滤——禁用 = 新 run 装配不纳入；
    // 进行中 run 不中断（工具集已随本次装配入图）。wiki-update 治理 run 不接插件面
    //（治理通道计划自拟 + 生命周期工具面，与「治理通道自我防护」同口径；且其图跳缓存
    // per-run 重建，插件目录版本入键的失效面不适用）。
    const pluginSurface = this.deps.plugins?.surface(capabilities.enabledPluginIds)
    const agent = wikiUpdate && wikiMirror
      ? this.buildWikiUpdateAgent({
          threadId: cmd.sessionId,
          sandboxSessionId,
          labContainer,
          wikiContainer,
          mirror: wikiMirror,
          policy,
          model,
          teammateTools: tools,
          lifecycleTools,
          capabilities,
        })
      : this.getOrBuildGraph(cmd.sessionId, snapshot.version, policy, model, cmd.ownerId, sandboxSessionId, labContainer, modelKey, tools, capabilities, sandboxSessionId, pluginSurface?.tools ?? [], pluginSurface?.prompt ?? '')

    // Mailbox recover has already consumed its interrupt; only a fresh resume must match the wait.
    if (cmd.kind === 'resume' && cmd.mailWaitId) {
      const state = await this.graphState(agent, cmd.sessionId)
      const matched = (state.tasks ?? []).some((task) => (task.interrupts ?? []).some((raw) => {
        const value = (raw as { value?: unknown } | null)?.value ?? raw
        return typeof value === 'object' && value !== null &&
          (value as { kind?: unknown }).kind === 'teammate-mail-wait' &&
          (value as { waitId?: unknown }).waitId === cmd.mailWaitId
      }))
      if (!matched) throw fail(CODE.RUN_ALREADY_RESUMED)
    }

    // 漏斗运行面（#783）：谨慎模式读 session owner 的 users.approvalMode（会话级开关，跨设备
    // 跟随）；message run 重置计数器 + 落审计身份（runId/ownerId/traceId），resume 延续计数
    // （同一逻辑 run 的 judge 超限/重复拒绝护栏跨 resume 连续）。审计身份归属 session owner
    // （approvalMode 是 owner 的会话级偏好；admin 代跑他人会话时漏斗判定仍记 owner——V1 简化）。
    if (this.deps.approvals) {
      const ownerRow = await this.deps.prisma.user.findUnique({
        where: { id: session.ownerId },
        select: { approvalMode: true },
      })
      const cautious = ownerRow?.approvalMode === 'cautious'
      if (cmd.kind === 'message') {
        this.deps.approvals.beginRun(cmd.sessionId, {
          cautious,
          identity: { runId: cmd.runId, userId: session.ownerId, traceId: cmd.runId },
        })
      } else {
        this.deps.approvals.refreshRun(cmd.sessionId, { cautious })
      }
    }

    this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'running' })
    this.activeCmds.set(cmd.sessionId, cmd)
    // 新 run = run.started；interrupted 后的续跑（resume）/恢复续跑（recover，story 14）=
    // run.resumed（#747 C 节目录二者并列——消费方按事件类型区分首轮/续跑轮）
    this.publish(
      cmd.ownerId,
      { type: cmd.kind === 'message' ? 'run.started' : 'run.resumed', payload: {} },
      cmd,
    )

    // usage 身份：默认链主 provider（snapshot.providers[0] 首模型）。fallback 链切换后的
    // per-call 身份不追踪（#775 usage.ts 声明的 #777 接线局限；采数不 fail run）。
    const providerId = actor?.modelProviderId ?? preferred?.providerId
    const identity = providerId ? snapshot.providers.find(provider => provider.providerId === providerId) : snapshot.providers[0]
    const usageHandler = createUsageCallbackHandler(
      {
        prisma: this.deps.prisma,
        userId: cmd.ownerId,
        username: cmd.username,
        runId: cmd.runId,
        sessionId: cmd.sessionId,
      },
      {
        providerId: identity?.providerId ?? '',
        lcProvider: identity?.lcProvider ?? '',
        model: (actor?.modelProviderId ? undefined : preferred?.modelId) ?? String(identity?.models[0]?.id ?? ''),
      },
    )

    const controller = new AbortController()
    const abortEntry = { controller, by: 'user' as 'user' | 'system' }
    this.aborts.set(cmd.runId, abortEntry)

    const projector = new RunProjector()
    // 单 turn 聚合（#778 回放零差异的实时面）：与 publish 同源同序消费投影事件——归约快照即
    // SSE 事件流终态（前端 #730 消费同一目录）。
    const turn = new TurnReducer()
    // rewind time-travel（#781 story 16）：仅 kind=message 且会话指针非空时从锚点 checkpoint
    // 分叉续跑（resume/recover 恒链头——interrupt/recover 点必在锚点链上，getTuple 缺省寻址
    // 即命中；指针非空时从锚点 input 重新起步，旧 checkpoint 走 archivedAt 软删）。
    const invocation = buildStreamEventsInvocation(
      cmd.sessionId,
      cmd.kind === 'message' && session.activeCheckpointId !== null ? session.activeCheckpointId : undefined,
    )

    // 终态 checkpoint 锚点（#778 anchorCheckpointId）：成功路径从终态 state 取；
    // aborted/failed 路径无可靠 state → null（回放面锚点缺位不阻断落行）。
    let anchorCheckpointId: string | null = null
    let input: unknown = null
    try {
      if (cmd.kind === 'resume' && cmd.mailWaitId) {
        await this.deps.teammates?.clearWait(cmd.sessionId, cmd.mailWaitId)
        if (cmd.mailWakeReason === 'timeout' && this.deps.teammates) {
          const parentSessionId = cmd.parentSessionId ?? cmd.sessionId
          const followUp = 'A teammate mailbox wait timed out. Send a follow-up request for updates and keep working.'
          await this.deps.teammates.sendMail({
            parentSessionId,
            recipientTeammateId: cmd.teammateId ?? null,
            kind: 'timeout',
            content: followUp,
          })
          if (cmd.mailBroadcastOnTimeout) {
            const peers = (await this.deps.teammates.list(parentSessionId))
              .filter((peer) => peer.id !== cmd.teammateId && peer.status !== 'archived')
            await Promise.all(peers.map((peer) => this.deps.teammates!.sendMail({
              parentSessionId, senderTeammateId: cmd.teammateId ?? null,
              recipientTeammateId: peer.id, kind: 'timeout-follow-up', content: followUp,
            })))
            if (cmd.teammateId) {
              await this.deps.teammates.sendMail({
                parentSessionId, senderTeammateId: cmd.teammateId,
                recipientTeammateId: null, kind: 'timeout-follow-up', content: followUp,
              })
            }
          }
        }
      }
      if (cmd.kind === 'message' && cmd.operation === 'compact') {
        // /compact 薄封装（#787 story 45）：不走 agent loop、无投影事件——压缩态直写 checkpoint
        //（见 compactThread 注释），终态恒 completed（中断在 REST/内核门前已被 50003 挡住）。
        // 不进 #780 ingestion/媒体扫描面（系统命令恒无附件、无 assistant 产物）。
        anchorCheckpointId = await this.compactThread(cmd, agent, model, usageHandler, controller.signal)
        this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'completed' })
        this.publish(cmd.ownerId, { type: 'run.completed', payload: {} }, cmd)
      } else if (cmd.kind === 'message' && cmd.operation === 'plugin-execute') {
        // 插件命令 {execute}（#788 · #752 §2.3 R9）：直达本插件工具执行面，不经 agent 自由裁量
        //（两条触发面一条执行面，/figure 先例 #744）。标准 tool.start/tool.end 事件 + TurnReducer
        // 聚合入会话（单管线渲染，实时 ≡ 回放）。无 agent loop → 无 checkpoint（锚点 null，
        // 挂靠语义同无终态轮）；占用户 run 额度（#747 F 节「figure 随会话 run 占额度」同语义）。
        await this.executePluginToolRun(cmd, capabilities, controller.signal, turn)
        this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'completed' })
        this.publish(cmd.ownerId, { type: 'run.completed', payload: {} }, cmd)
      } else {
        // #780 ingestion（片 2）：message 命令带附件 → run 首步确定性物化（runner 调度权，非 agent
        // 工具；LangGraph 图拓扑约束下作 runner 侧幂等预步骤——putArchive 覆盖写 + sha256 校验，
        // resume/重投安全）。校验失败 → throw → 下方 catch → run.failed（ingestion 错误，不进入
        // agent loop）。图片读字节 → 多模态 block 内联进输入（前端已降采样长边 ≤1568px，data URL
        // 满足 provider 内联限制）；文件类只物化、由常规 fs 工具自读（漏斗白名单 lab/** 覆盖）。
        // #782：journaling 开启时物化改经 journalMaterialize（journal-first——打点先于落盘；
        // 确定性幂等键 ingest-<attachmentId>）。沙箱惰性创建由该步触发（story 58 语义不变）。
        let imageBlocks: ContentBlock[] = []
        if (cmd.kind === 'message' && cmd.attachmentIds && cmd.attachmentIds.length > 0 && this.deps.attachments) {
          const fj = this.deps.fileJournal
          const metas = await this.deps.attachments.ingestAttachments({
            sessionId: cmd.sessionId,
            attachmentIds: cmd.attachmentIds,
            container: labContainer,
            primitives: runPrimitives,
            ...(fj
              ? {
                  journalWrite: async (row: { id: string; fileName: string; mimeType: string }, bytes: Buffer) => {
                    await fj.journalMaterialize({
                      sessionId: sandboxSessionId,
                      container: labContainer,
                      path: `uploads/${row.id}/${row.fileName}`,
                      bytes,
                      toolCallId: `${IDEMPOTENCY_INGEST_PREFIX}${row.id}`,
                      runId: cmd.runId,
                    })
                  },
                }
              : {}),
          })
          for (const m of metas) {
            if (m.mimeType.startsWith('image/')) {
              const buf = await this.deps.attachments.readTempBytes(m.attachmentId)
              imageBlocks.push({ type: 'image_url', image_url: { url: `data:${m.mimeType};base64,${buf.toString('base64')}` } })
            }
          }
        }
        // HumanMessage 显式 id = runId：命令→checkpoint 消息的持久锚（normalizeReplay 重放判据）。
        // kind=recover：input = null —— LangGraph 从 checkpoint 续跑（三形态见 normalizeReplay 注）。
        input =
          cmd.kind === 'message'
            ? {
                messages: [
                  new HumanMessage({
                    ...(imageBlocks.length > 0
                      ? { content: [{ type: 'text', text: cmd.content ?? '' }, ...imageBlocks] }
                      : { content: cmd.content ?? '' }),
                    id: cmd.runId,
                  }),
                ],
              }
            : cmd.kind === 'resume'
              ? new Command({
                  resume: cmd.mailWaitId ? { kind: 'mail', waitId: cmd.mailWaitId } : (cmd.decisions ?? DEFAULT_RESUME_DECISIONS),
                  // abort（#783 story 15）：回执决策 + goto END——interrupt 回执后图立即终止，
                  // run 落 aborted 终态（探针验证：resume 值仍送达 interrupt 点，工具不执行）
                  ...(cmd.abort ? { goto: END } : {}),
                })
              : null

        // #782 run 上下文（ALS 外层）：journal 行 runId 盖印源（checkpointId 终态回填键）——
        // 覆盖流创建与消费全程（backend 打点在流内发生）
        await runWithRunContext(cmd.runId, async () => {
          const stream = await agent.streamEvents(input, {
            ...invocation,
            recursionLimit: this.recursionLimit,
            signal: controller.signal,
            callbacks: [usageHandler],
            metadata: { ownerId: capabilities.ownerId, ownerPluginIds: [...capabilities.enabledPluginIds], officialContentVersion: capabilities.official.version },
          })
          for await (const raw of stream) {
            // 工具/推理活动刷新沙箱闲置计时（#776 真 activity 源——长 run 中途不被 sweep stop）
            this.deps.sandboxes?.touch(sandboxSessionId)
            for (const ev of projector.feed(raw, this.clock())) {
              turn.feed(ev)
              this.publish(cmd.ownerId, ev, cmd)
            }
          }
        })
        // 流正常结束：判定停在 interrupt（PoC 形态：next 非空或 tasks 带 interrupts）
        const state = await this.graphState(agent, cmd.sessionId)
        anchorCheckpointId = state.config?.configurable?.checkpoint_id ?? null
        // #782 journal checkpointId 终态回填（completed/interrupted 有锚；aborted/failed 保持
        // pending ''——被放弃 turn 的 op 恒逆放，保守方向）。fail-soft：回填失败不放大终态。
        if (anchorCheckpointId !== null) {
          try {
            await this.deps.prisma.fileJournal.updateMany({
              where: { sessionId: sandboxSessionId, runId: cmd.runId },
              data: { checkpointId: anchorCheckpointId },
            })
          } catch (err) {
            console.warn(`[runner] journal checkpointId 回填失败: run=${cmd.runId}: ${String(err)}`)
          }
        }
        const interrupted =
          (state.next?.length ?? 0) > 0 || (state.tasks?.some((t) => (t.interrupts?.length ?? 0) > 0) ?? false)
        if (interrupted) {
          this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'interrupted' })
          // interrupted 不发终态事件（#777 契约「interrupted 态无终态事件」，S4 锁；恢复面 =
          // run.resumed 起新轮）
          // 审批升级检出（#783）：漏斗 interrupt → approval.requested 事件 + 48h 死线落表；
          // deepagents 内建 interruptOn（V1 测试面）载荷无 kind 标记，不触发审批事件。
          const escalations = this.extractApprovalInterrupts(state)
          for (const payload of escalations) {
            this.publish(
              cmd.ownerId,
              {
                type: APPROVAL_EVENT_REQUESTED,
                payload: { escalation: payload.escalation, actionRequests: payload.actionRequests, teammateId: cmd.teammateId ?? null },
              },
              cmd,
            )
          }
          if (escalations.length > 0) {
            this.pendingApprovals.set(cmd.sessionId, {
              ownerId: cmd.ownerId,
              runId: cmd.runId,
              escalationId: escalations[0]!.escalation.id,
              deadlineAt: this.clock() + this.approvalTimeoutMs,
              parentSessionId: cmd.parentSessionId,
              teammateId: cmd.teammateId,
            })
          }
        } else if ((cmd.kind === 'resume' || cmd.kind === 'recover') && cmd.abort) {
          // abort 落定（story 15）：goto END 终止，aborted 为终态。recover 重放保留 abort 语义
          //（RESUME 已消费后崩溃的重放：no-op 或走完 END 路径，终态同 aborted）
          this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'aborted', by: 'user' })
          this.publish(cmd.ownerId, { type: 'run.aborted', payload: { by: 'user' } }, cmd)
        } else {
          // #780 D9 媒体块归约（片 3）：run 完成前扫描终态 assistant 回复的媒体块 → 校验（存在性/
          // mime 白名单）/拷进 /lab/uploads/ 物化/建 Attachment 行 → `attachment` 事件（实时面）+
          // turn.feed（回放同形状——attachmentsJson media 数组，单管线渲染零差异）。校验失败块
          // 降级文本占位（占位进事件流与回放聚合）+ 审计计数 warn（不 fail run）。仅 completed
          // 路径扫（interrupted/aborted 的回复未终稿，不做产物面）。
          if (this.deps.attachments) {
            const scan = scanMediaBlocks(lastMessage(state.values?.messages ?? []))
            const degrade = (declaredPath: string, reason: string): void => {
              const placeholder = `[媒体产物不可用：${declaredPath}]`
              turn.feed({ type: 'text.delta', payload: { delta: placeholder } })
              this.publish(cmd.ownerId, { type: 'text.delta', payload: { delta: placeholder } }, cmd)
              // eslint-disable-next-line no-console
              console.warn(`[runner] media block degraded: session=${cmd.sessionId} path=${declaredPath} reason=${reason}`)
            }
            for (const block of scan.materializable) {
              const fj = this.deps.fileJournal
              const meta = await this.deps.attachments.materializeAgentMedia({
                sessionId: sandboxSessionId,
                ownerId: session.ownerId,
                declaredPath: block.declaredPath,
                mime: block.mime,
                container: labContainer,
                primitives: runPrimitives,
                ...(fj
                  ? {
                      journalWrite: async (row: { attachmentId: string; fileName: string }, bytes: Buffer) => {
                        await fj.journalMaterialize({
                          sessionId: sandboxSessionId,
                          container: labContainer,
                          path: `uploads/${row.attachmentId}/${row.fileName}`,
                          bytes,
                          toolCallId: `${IDEMPOTENCY_MEDIA_PREFIX}${row.attachmentId}`,
                          runId: cmd.runId,
                          // 直盖终态锚：本 run 的 checkpointId 回填 updateMany（stream 结束处）
                          // 已执行完、先于本次物化 insert——不直盖则 media 行恒 pending 恒逆放
                          ...(anchorCheckpointId !== null ? { checkpointId: anchorCheckpointId } : {}),
                        })
                      },
                    }
                  : {}),
              })
              if (meta) {
                const ref = {
                  attachmentId: meta.attachmentId,
                  mime: meta.mimeType,
                  size: meta.size,
                  fileName: meta.fileName,
                }
                turn.feed({ type: 'attachment', payload: ref })
                this.publish(cmd.ownerId, { type: 'attachment', payload: ref }, cmd)
              } else {
                degrade(block.declaredPath, 'materialize_failed')
              }
            }
            for (const d of scan.degraded) degrade(d.declaredPath, d.reason)
          }
          this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'completed' })
          this.publish(cmd.ownerId, { type: 'run.completed', payload: {} }, cmd)
        }
      }
    } catch (e) {
      // 用户中断唯一权威判据 = signal.aborted（provider 自身 timeout AbortError 不误判——
      // 那是 llm_error，见 errorKind.ts 头注）
      if (controller.signal.aborted) {
        this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'aborted', by: abortEntry.by })
        this.publish(cmd.ownerId, { type: 'run.aborted', payload: { by: abortEntry.by } }, cmd)
      } else {
        const kind = classifyRunError(e)
        this.runs.set(cmd.sessionId, { runId: cmd.runId, state: 'failed', errorKind: kind })
        this.publish(cmd.ownerId, { type: 'run.failed', payload: { errorKind: kind } }, cmd)
      }
    } finally {
      this.aborts.delete(cmd.runId)
      this.activeCmds.delete(cmd.sessionId)
      // #785 持锁者死亡随 task 取消自动释放：本 run 残余持锁释放 + 其排队等待取消（正常路径
      // 锁已由包装层 try/finally 先行释放——此处是 abort/异常路径的兜底；幂等 no-op 无害）
      this.writeLocks.releaseRun(cmd.runId)
      // 终态清理漏斗运行槽（interrupted/suspended 保留——resume 延续同一逻辑 run 的护栏计数）
      const finalState = this.runs.get(cmd.sessionId)?.state
      if (cmd.teammateId && this.deps.teammates) {
        const parentSessionId = cmd.parentSessionId ?? cmd.sessionId
        try {
          const teammate = await this.deps.teammates.get(parentSessionId, cmd.teammateId)
          if (teammate.status !== 'archived') {
            const status = finalState === 'completed' ? 'completed'
              : finalState === 'failed' || finalState === 'aborted' ? 'failed'
              : finalState === 'suspended' || (finalState === 'interrupted' && this.pendingApprovals.has(cmd.sessionId)) ? 'suspended'
              : finalState === 'interrupted' ? 'waiting'
              : 'running'
            const updated = await this.deps.teammates.updateStatus(parentSessionId, cmd.teammateId, status)
            if (updated.status !== 'archived' && (status === 'completed' || status === 'failed' || status === 'suspended')) {
              this.publish(cmd.ownerId, {
                type: `teammate.${status}`,
                payload: { teammateId: cmd.teammateId, name: teammate.name },
              }, cmd)
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[runner] teammate status update failed: teammate=${cmd.teammateId}: ${(err as Error).message}`)
        }
      }
      if (
        this.deps.approvals &&
        (finalState === 'completed' || finalState === 'failed' || finalState === 'aborted')
      ) {
        this.deps.approvals.dropRun(cmd.sessionId)
      }
      // 终态聚合落 session_messages（#778 回放零差异的实时面；interrupted/aborted/failed 也落
      // ——刷新回放须含已流出部分，story 3「零差异」）。空聚合不落（failed 立即等场景）。
      // recover run 的聚合以终态 checkpoint 为准（story 14：断点前内容只在 blob，reducer 只有
      // 断点后事件——checkpointTurn 单一真相 + anchor 幂等防「processor 完成后 ack 前崩溃」
      // 的重放双落 + 本 run 残留链整删防「中途行 + 全量行」双行重叠）。落库失败不放大为 run
      // 故障（终态事件已发）：告警留痕。
      // 已知边界（用例锁定）：recover 非 completed 终态走常规 reducer 落行——真实崩溃后
      // reducer 内存丢失，断点前内容缺位（blob∪reducer 结构化合并归后续；纯串拼接在
      // interrupted 形态下 blob 与 reducer 前缀重叠必重影，故不做）。后续 resume 的常规
      // 落行同样只含 resume 段，缺口固化。
      if (this.recordTurn && cmd.kind === 'recover' && finalState === 'completed') {
        const anchor = anchorCheckpointId
        if (anchor !== null && !(await this.turnAlreadyRecorded(cmd.sessionId, anchor))) {
          try {
            const aggregate = await this.turnSnapshotFromCheckpoint(cmd.sessionId)
            if (!isEmptyTurnSnapshot(aggregate)) {
              await this.deleteRunResidues(cmd.sessionId)
              await this.recordTurn({
                sessionId: cmd.sessionId,
                runId: cmd.runId,
                anchorCheckpointId: anchor,
                aggregate,
              })
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[runner] recover recordTurn failed: session=${cmd.sessionId} run=${cmd.runId}: ${(err as Error).message}`)
          }
        }
      } else if (this.recordTurn && !turn.isEmpty()) {
        try {
          await this.recordTurn({
            sessionId: cmd.sessionId,
            runId: cmd.runId,
            anchorCheckpointId,
            aggregate: turn.snapshot(),
          })
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[runner] recordTurn failed: session=${cmd.sessionId} run=${cmd.runId}: ${(err as Error).message}`)
        }
      }
      // 活跃指针推进（#781 story 16 + R 评审守卫）：仅会话处于 rewind 态（指针非空）且本轮
      // completed 时，指针前移到本轮终态 checkpoint（锚点链延伸头）——投影 archivedAt 过滤的
      // 链基准随之推进，下次 message 从新头分叉。NULL 指针（从未 rewind）不写（免全量写放大，
      // NULL ≡ 链头）；interrupted/failed/aborted 不推进（指针保持锚点：failed/aborted 轮由
      // sendMessage 的残留清理归档后从锚点重开；interrupted 走 resume 从链头续跑）。
      // 推进前提校验（R 评审）：指针实时重读 + 本轮终态锚的祖先链须含该指针——崩溃后 BullMQ
      // stalled 重放（recover 不带 checkpoint_id）若续跑进被放弃分支，其终态锚不含指针 → 不
      // 推进（防指针被拽进旧分支致会话永久复跑）。校验/更新失败一律不放大（终态已发）。
      if (finalState === 'completed' && anchorCheckpointId !== null) {
        try {
          const current = await this.deps.prisma.session.findUnique({
            where: { id: cmd.sessionId },
            select: { activeCheckpointId: true },
          })
          const pointer = current?.activeCheckpointId ?? null
          if (
            pointer !== null &&
            (await this.checkpointLineageContains(cmd.sessionId, anchorCheckpointId, pointer))
          ) {
            await this.deps.prisma.session.update({
              where: { id: cmd.sessionId },
              data: { activeCheckpointId: anchorCheckpointId },
            })
          } else if (pointer !== null) {
            // eslint-disable-next-line no-console
            console.warn(`[runner] activeCheckpointId 推进跳过（终态锚不在指针链下）: session=${cmd.sessionId}`)
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[runner] activeCheckpointId 推进失败: session=${cmd.sessionId}: ${(err as Error).message}`)
        }
      }
      // 治理镜像 dispose（#790）：completed（finish 已推回）/ interrupted / failed / aborted
      // 全路径作废——「中断 = 作废不推回」（AC③），推回后的副本亦无用。
      await wikiMirror?.dispose()
    }
  }

  // 祖先链包含判定（#781 指针推进前提）：from 出发沿 parentCheckpointId 上溯（含 from 自身）是否
  // 命中 target。行走下沉共享内核 checkpointChain.ts（与 sessions/rewind 单一实现）；读失败向上
  // 抛由调用方吞（宁可不推进）。刻意不过滤 archivedAt（与 service 侧 checkpointParentLookup 的
  // 产品面口径不同）：守卫只判「终态锚含指针」，归档与否不改判定结果，全量图上溯在崩溃恢复
  // 窗口下最保守（不因软删口径产生假阴性而漏推进）。
  private async checkpointLineageContains(threadId: string, from: string, target: string): Promise<boolean> {
    const cps = await this.deps.prisma.checkpoint.findMany({
      where: { threadId },
      select: { checkpointId: true, parentCheckpointId: true },
    })
    const parentOf = new Map(cps.map((c) => [c.checkpointId, c.parentCheckpointId]))
    return ancestorChainOf((id) => parentOf.get(id) ?? null, from).has(target)
  }

  // ---- /compact 显式上下文压缩（#787 story 45：compact = deepagents 压缩薄封装）----
  // deepagents summarization middleware 的压缩态不重写 messages——一次压缩 = 图状态里的
  // _summarizationEvent {cutoffIndex, summaryMessage, filePath}，此后每次模型调用前
  // effective = [summaryMessage, ...raw.slice(cutoffIndex)]（getEffectiveMessages）。该
  // middleware 由阈值谓词触发且 createDeepAgent 默认栈不可注入 trigger，手动 /compact 无法
  // 强制其开火——故按同形态直写事件状态：与自动压缩共用同一重建逻辑，后续 run（含其自动
  // 压缩）零感知。filePath 恒 null：被压缩全文已由平台自有面持久化（session_messages 投影），
  // 不另落沙箱 /conversation_history（deepagents 卸载面的冗余副本）。
  // ---- 插件命令 {execute} 运行体（#788 · #752 §2.3 R9）----
  // 工具必须在本 run 启用集（owner per-run 快照）内——REST 面预检之外的内核权威面，
  // 越权/禁用 → 80040 同码防探测。事件形状与 projector 产出同形（截断常量单一来源），
  // turn 聚合与实时发布同源同序（#778 回放零差异纪律）。
  private async executePluginToolRun(
    cmd: RunCommand,
    capabilities: RunCapabilities,
    signal: AbortSignal,
    turn: TurnReducer,
  ): Promise<void> {
    const surface = this.deps.plugins?.surface(capabilities.enabledPluginIds)
    const def = surface?.tools.find((tool) => tool.name === cmd.pluginTool)
    if (!surface || !def) throw fail(CODE.PLUGIN_NOT_FOUND)
    const toolCallId = randomUUID()
    const { text: inputText, truncated: inputTruncated } = truncateUtf8(JSON.stringify(cmd.pluginArgs ?? {}), TOOL_INPUT_MAX_BYTES)
    const start = {
      type: 'tool.start' as const,
      payload: { toolCallId, name: def.name, input: inputText, ...(inputTruncated ? { [TRUNCATED_FLAG]: true } : {}) },
    }
    turn.feed(start)
    this.publish(cmd.ownerId, start, cmd)
    const startedAt = this.clock()
    try {
      const result = await def.execute(toolCallId, cmd.pluginArgs as never, { signal, ctx: this.deps.plugins!.toolContext })
      const durationMs = Math.max(0, this.clock() - startedAt)
      // details 数据源与 projector 同语义（R5）：artifact（渲染面）优先，缺省回落 content
      // 序列化（模型/审计面文本不丢——结果卡可见）。
      const detailsSource = result.details !== undefined
        ? JSON.stringify(result.details, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
        : contentToText(result.content)
      const details = truncateUtf8(detailsSource, TOOL_DETAILS_MAX_BYTES)
      const end = {
        type: 'tool.end' as const,
        payload: {
          toolCallId,
          name: def.name,
          state: 'success' as const,
          durationMs,
          ...(details.text !== '' ? { details: details.text } : {}),
          ...(details.truncated ? { [TRUNCATED_FLAG]: true } : {}),
        },
      }
      turn.feed(end)
      this.publish(cmd.ownerId, end, cmd)
    } catch (e) {
      const end = {
        type: 'tool.end' as const,
        payload: { toolCallId, name: def.name, state: 'error' as const, durationMs: Math.max(0, this.clock() - startedAt) },
      }
      turn.feed(end)
      this.publish(cmd.ownerId, end, cmd)
      throw e
    }
  }

  private async compactThread(
    cmd: RunCommand,
    agent: DeepAgentLike,
    model: LeaderAgentParams['model'],
    usageHandler: ReturnType<typeof createUsageCallbackHandler>,
    signal: AbortSignal,
  ): Promise<string | null> {
    const config = { configurable: { thread_id: cmd.sessionId } }
    const state = (await agent.getState(config)) as GraphStateLike
    const current = state.config?.configurable?.checkpoint_id ?? null
    const raw = state.values?.messages ?? []
    const prev = state.values?._summarizationEvent
    const effective = prev ? [prev.summaryMessage, ...raw.slice(prev.cutoffIndex)] : raw
    // 有效消息未超保留窗 → 无可压缩余量，no-op（终态照常 completed，状态不动）
    if (effective.length <= COMPACT_KEEP + (prev ? 1 : 0)) return current
    // 截断点：保留尾部 COMPACT_KEEP 条；cutoff 落在 ToolMessage 上时前移跨过整对
    //（deepagents findSafeCutoffPoint 的前进策略——被截集合保持完整 AI/tool 对）
    let cutoff = effective.length - COMPACT_KEEP
    while (cutoff < effective.length && ToolMessage.isInstance(effective[cutoff])) cutoff += 1
    const summary = await this.summarizeMessages(model, effective.slice(0, cutoff), signal, usageHandler)
    // summaryMessage 形态对齐 deepagents isSummaryMessage（HumanMessage + lc_source=
    // 'summarization'）——后续自动压缩的识别/重建依赖该标记，缺了会双重摘要。
    const summaryMessage = new HumanMessage({ content: summary, additional_kwargs: { lc_source: 'summarization' } })
    // raw 坐标换算：no-op 门保证 cutoff ≥ 1，旧 summary 恒落在被截集合内 → 保留尾部全在 raw
    const keptCount = effective.length - cutoff
    const updated = await agent.updateState(config, {
      _summarizationEvent: { cutoffIndex: raw.length - keptCount, summaryMessage, filePath: null },
    })
    return updated.configurable?.checkpoint_id ?? current
  }

  private async summarizeMessages(
    model: LeaderAgentParams['model'],
    messages: BaseMessage[],
    signal: AbortSignal,
    usageHandler: ReturnType<typeof createUsageCallbackHandler>,
  ): Promise<string> {
    const transcript = messages
      .map((m) => `[${m.getType()}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n\n')
    const res = await model.invoke(
      [new HumanMessage(COMPACT_SUMMARY_PROMPT.replace('{conversation}', transcript))],
      { signal, callbacks: [usageHandler] },
    )
    const text = typeof res.content === 'string' ? res.content.trim() : ''
    return text || '（对话上下文已压缩为摘要。）'
  }

  // ---- 审批升级检出（interrupt payload → approval.requested 事件面）----
  private extractApprovalInterrupts(state: GraphStateLike): ApprovalInterruptPayload[] {
    const out: ApprovalInterruptPayload[] = []
    for (const task of state.tasks ?? []) {
      for (const interrupt of task.interrupts ?? []) {
        const value = (interrupt as { value?: unknown } | null)?.value ?? interrupt
        if (isApprovalInterruptPayload(value)) out.push(value)
      }
    }
    return out
  }

  // ---- 拒绝红显事件（漏斗 onRejection 回调接线）：tool.start + tool.end{error, rejection} ----
  private publishRejection(notice: RejectionNotice): void {
    const cmd = this.activeCmds.get(notice.threadId)
    if (!cmd) return
    this.publish(
      cmd.ownerId,
      { type: 'tool.start', payload: { toolCallId: notice.toolCallId, name: notice.name, input: notice.argsSummary } },
      cmd,
    )
    this.publish(
      cmd.ownerId,
      {
        type: 'tool.end',
        payload: {
          toolCallId: notice.toolCallId,
          name: notice.name,
          state: 'error',
          durationMs: 0,
          details: notice.reason,
          rejection: { source: notice.source, reason: notice.reason },
        },
      },
      cmd,
    )
  }

  // ---- 48h 挂起清扫（#783 story 15）：死线过 → suspended（非终态）+ run.suspended 事件 ----
  sweepSuspensions(now?: number): void {
    const t = now ?? this.clock()
    for (const [sessionId, pending] of this.pendingApprovals) {
      if (pending.deadlineAt > t) continue
      this.pendingApprovals.delete(sessionId)
      const snap = this.runs.get(sessionId)
      if (!snap || snap.state !== 'interrupted') continue
      this.runs.set(sessionId, { runId: snap.runId, state: 'suspended' })
      this.publish(pending.ownerId, { type: 'run.suspended', payload: {} }, { ...pending, sessionId, runId: snap.runId })
    }
  }

  // ---- 重启恢复（装配层启动调用）：checkpoint 推导超时未落定的审批升级 → suspended ----
  // 死线源 = 该 thread 最新 checkpoint 行的 createdAt（interrupt 后无新 checkpoint，两者差
  // 一个节点执行时长——48h 尺度下可忽略）；仅标内存观测态，不发事件（重启不重放历史）。
  async recoverSuspensions(): Promise<void> {
    if (!this.deps.approvals) return
    const threads: { threadId: string }[] = []
    try {
      const groups = await this.deps.prisma.checkpointWrite.groupBy({
        by: ['threadId'],
        where: { channel: INTERRUPT_CHANNEL },
        orderBy: [{ threadId: 'asc' }], // groupBy 变体要求 orderBy/take 其一；顺带确定性序
      })
      for (const g of groups) threads.push({ threadId: g.threadId })
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[runner] 挂起恢复扫描失败（跳过）: ' + (e as Error).message)
      return
    }
    for (const { threadId } of threads) {
      if (this.runs.has(threadId)) continue // 内存已有权威态
      if (!(await this.threadInterruptedFromCheckpoint(threadId))) continue // 已 resume/落定
      const cp = await this.deps.prisma.checkpoint.findFirst({
        where: { threadId },
        orderBy: [{ createdAt: 'desc' }],
        select: { createdAt: true },
      })
      if (!cp) continue
      if (this.clock() - cp.createdAt.getTime() < this.approvalTimeoutMs) continue
      this.runs.set(threadId, { runId: '', state: 'suspended' })
    }
  }

  // ---- 审批落定（#783 story 33：allow-once/deny 二选；story 15：suspended 可 resume/abort）----
  // 落定 = approval.resolved 事件（卡片落定即撤）→ resume 命令入串行链（abort = goto END 终态）。
  async resolveApproval(params: {
    sessionId: string
    ownerId: string
    username: string
    escalationId: string
    decision: 'allow' | 'deny'
    reason?: string
    abort?: boolean
  }): Promise<void> {
    // 归属判定（「不存在 vs 越权」同码 50002 防探测——与 message 入口同源）
    const caller = await this.deps.prisma.user.findUnique({
      where: { id: params.ownerId },
      select: { role: true },
    })
    if (!caller) throw fail(CODE.SESSION_NOT_FOUND)
    await getSessionForUser(this.deps.prisma, { id: params.ownerId, role: caller.role }, params.sessionId)

    // Approval cards are rendered on the parent timeline, but a teammate owns its checkpoint.
    // Route by escalation id to that child thread so one approval never resumes the leader graph.
    const children = await this.deps.prisma.teammate.findMany({
      where: { parentSessionId: params.sessionId, archivedAt: null },
      select: { id: true, threadId: true },
    })
    let child: (typeof children)[number] | undefined
    for (const candidate of children) {
      const inMemoryMatch = this.pendingApprovals.get(candidate.threadId)?.escalationId === params.escalationId ||
        this.deps.approvals?.pendingEscalation(candidate.threadId)?.escalation.id === params.escalationId
      if (inMemoryMatch || await this.checkpointHasApproval(candidate.threadId, params.escalationId)) {
        child = candidate
        break
      }
    }
    const targetSessionId = child?.threadId ?? params.sessionId
    const targetTeammateId = child?.id

    // 权威 pending 判定：内存态 / checkpoint 推导（重启形态）
    let snap = this.runs.get(targetSessionId)
    if (!snap) {
      const interrupted = await this.threadInterruptedFromCheckpoint(targetSessionId)
      if (interrupted) {
        snap = { runId: this.pendingApprovals.get(targetSessionId)?.runId ?? '', state: 'interrupted' }
        this.runs.set(targetSessionId, snap)
      }
    }
    if (!snap || (snap.state !== 'interrupted' && snap.state !== 'suspended')) {
      throw fail(CODE.APPROVAL_NOT_FOUND)
    }
    // Restart loses the funnel memo; persisted interrupts remain authoritative for the id.
    const escalation = this.deps.approvals?.pendingEscalation(targetSessionId)
    if (escalation ? escalation.escalation.id !== params.escalationId : !(await this.checkpointHasApproval(targetSessionId, params.escalationId))) {
      throw fail(CODE.APPROVAL_NOT_FOUND)
    }

    const runId = this.pendingApprovals.get(targetSessionId)?.runId ?? snap.runId
    if (this.resolvingApprovals.has(targetSessionId)) throw fail(CODE.RUN_ALREADY_RESUMED)
    if (await this.quotaFull(params.ownerId, params.sessionId)) throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED)
    if (this.resolvingApprovals.has(targetSessionId)) throw fail(CODE.RUN_ALREADY_RESUMED)
    this.resolvingApprovals.add(targetSessionId)
    const acknowledge = () => this.publish(
      params.ownerId,
      {
        type: APPROVAL_EVENT_RESOLVED,
        payload: {
          escalationId: params.escalationId,
          decision: params.decision,
          reason: params.reason ?? null,
          teammateId: targetTeammateId ?? null,
        },
      },
      { sessionId: targetSessionId, parentSessionId: targetTeammateId ? params.sessionId : undefined, teammateId: targetTeammateId, runId },
    )

    const cmd = this.buildCommand({
      sessionId: targetSessionId,
      ownerId: params.ownerId,
      username: params.username,
      kind: 'resume',
      ...(targetTeammateId ? { teammateId: targetTeammateId, parentSessionId: params.sessionId } : {}),
      decisions: {
        decisions: [
          {
            type: params.decision === 'allow' ? 'approve' : 'reject',
            ...(params.reason !== undefined && params.reason !== '' ? { message: params.reason } : {}),
          },
        ],
      },
      ...(params.abort ? { abort: true } : {}),
    })
    const accepted = () => {
      acknowledge()
      if (this.pendingApprovals.get(targetSessionId)?.escalationId === params.escalationId) this.pendingApprovals.delete(targetSessionId)
    }
    // Inline execution accepts immediately; a durable queue accepts only after add succeeds.
    if (!this.queuedDispatch) accepted()
    try { await this.dispatch(cmd) }
    catch (cause) { this.resolvingApprovals.delete(targetSessionId); throw cause }
    if (this.queuedDispatch) accepted()
  }

  // 运行期中间件装配（非拓扑因子——不入缓存键）：#786 teammate 委派 + #783 审批漏斗 +
  // #780 下载校验节点（file 写类工具成功后物化产物 + 下载引用进 tool 输出；跨 run 状态由
  // 各中间件 per-thread 槽管理）。leader 缓存路径与 #790 wiki-update 跳缓存路径共享。
  // 中间件（运行期行为非拓扑因子——不入缓存键）：#782 工具调用上下文盖印（journal 幂等键
  // ALS 源，链首位——journaling 开启恒注入）+ teammate delegation + #783 审批漏斗 + #780 下载
  // 校验节点（file 写类工具成功后物化产物 + 下载引用进 tool 输出；跨 run 状态由各中间件
  // per-thread 槽管理，同参数必同拓扑的纯函数约束不受影响）。四依赖全缺 = 空数组（调用点
  // 不挂 middleware）——leader 图与 wiki-update 图共用本单一来源。
  private runtimeMiddleware(): AnyAgentMiddleware[] {
    if (!this.deps.teammates && !this.deps.approvals && !this.deps.downloadNode && !this.deps.fileJournal) return []
    return [
      createToolCallContextMiddleware(),
      ...(this.deps.teammates ? [teammateDelegation] : []),
      ...(this.deps.approvals ? [this.deps.approvals.middleware] : []),
      ...(this.deps.downloadNode ? [this.deps.downloadNode.middleware] : []),
    ]
  }

  // ---- 图实例缓存（拓扑因子全在键内：thread | configVersion | policy | backend 双根）----
  private getOrBuildGraph(
    threadId: string,
    configVersion: number,
    policy: InterruptPolicy | undefined,
    model: LeaderAgentParams['model'],
    ownerId: string,
    sandboxSessionId: string,
    labContainer: string,
    modelKey: string,
    tools: NonNullable<LeaderAgentParams['tools']>,
    capabilities: RunCapabilities,
    journalSessionId: string,
    pluginToolDefs: readonly AnyPluginToolDefinition[],
    pluginPrompt: string,
  ): DeepAgentLike {
    // 双根入键：docker 实例变更（沙箱 remove/recreate、#784 wiki 容器接管后改名）时缓存图
    // 持旧 backend 会指向已删容器——backend 双根都是拓扑因子。（journaling backend 无新键
    // 成分：journal sessionId 与 labContainer 一一对应——researcher-sandbox-<journalSessionId>。）
    const official = capabilities.official
    const wikiContainer = this.deps.resolveWikiContainer(ownerId)
    // 插件目录版本入键（#788）：启用集（capabilities.key）管「哪些插件开」，目录版本管
    // 「开着的插件长什么样」——任一变更都触发图重建（拓扑因子 = 工具面 + prompt 面）。
    const key = `${threadId}|${configVersion}|${interruptPolicyKey(policy)}|${labContainer}|${wikiContainer}|${capabilities.key}|${modelKey}|${this.deps.plugins?.catalogVersion ?? 'none'}`
    const cached = this.graphs.get(key)
    if (cached) return cached
    // #782 × #785 接缝：journaling 开启时 backendFor 产出打点装饰器（其 apply 经 putBuffer
    // 直达原语层）——会话写围栏（fence）已提供 journaling 路径的串行保证，#785 per-path 锁
    // 面覆盖 journaling off（直用 DockerArchiveBackend）路径。
    const baseBackend = this.deps.fileJournal
      ? this.deps.fileJournal.backendFor({
          sessionId: journalSessionId,
          targets: { wiki: wikiContainer, lab: labContainer },
        })
      : new DockerArchiveBackend(this.deps.primitives, {
          wiki: wikiContainer,
          lab: labContainer,
        })
    const backend = withWriteLocks(
      baseBackend,
      { wiki: wikiContainer, lab: labContainer },
      this.writeLocks,
      () => this.writeLockContext(sandboxSessionId, threadId),
      this.overwriteAuditor,
    )
    // wiki 常驻检索工具（#789 三通道①）：openwiki_search/read 进装配——模型面 schema 裁剪 +
    // Result 永不 throw（见 wikisearch.ts 文件头）。输入因子都在缓存键内（wikiContainer 在键、
    // primitives 进程级单例），同键必同工具面——「同参数必同拓扑」纯函数约束保持。
    // 检索只读（getArchive 拉镜像），不经写锁面（#785 锁只覆盖 putArchive/破坏性 op）。
    const wikiTools = createWikiRetrievalTools({ primitives: this.deps.primitives, wikiContainer })
    const middleware = this.runtimeMiddleware()
    const agent = buildLeaderAgent({
      model,
      backend,
      checkpointer: this.deps.saver,
      systemPrompt: LEADER_SYSTEM_PROMPT,
      official,
      interruptPolicy: policy,
      tools: [...wikiTools, ...tools],
      // 插件工具进图（#788）：LangChain 适配（zod → StructuredTool）；prompt 段并入
      // system prompt 与 teammate subagent 继承（graphFactory 内拼接）。
      ...(pluginToolDefs.length > 0 && this.deps.plugins
        ? { pluginTools: toLangChainTools(pluginToolDefs, this.deps.plugins.toolContext) }
        : {}),
      ...(pluginPrompt !== '' ? { pluginPrompt } : {}),
      // 中间件（运行期行为非拓扑因子——不入缓存键，见 runtimeMiddleware()）。
      ...(middleware.length > 0 ? { middleware } : {}),
    })
    // 图实例数护栏（正确性由键保证，此处防长期运行退化；超限整表清——重建成本 =
    // 一次 createDeepAgent 编译，进行中 run 持既有实例引用不受影响）。
    if (this.graphs.size >= GRAPH_CACHE_MAX_INSTANCES) this.graphs.clear()
    this.graphs.set(key, agent)
    return agent
  }

  // ---- wiki-update teammate 图（#790 · 三通道②）：跳缓存 per-run 重建 ----
  // 镜像根 per-run 必新（finally dispose）——命中旧缓存 = backend 指向已 dispose 的临时目录，
  // 故不入图缓存。systemPrompt 追加治理驱动提示；backend = 组合 backend（/lab 照旧容器面 +
  // /wiki/ 落镜像；withWriteLocks 整体包裹——/lab 写不丢 #785 写锁，/wiki/ 镜像写也入锁）；
  // 生命周期工具（六件）+ 常驻检索（#789）+ teammate 工具同图。
  private buildWikiUpdateAgent(p: {
    readonly threadId: string
    readonly sandboxSessionId: string
    readonly labContainer: string
    readonly wikiContainer: string
    readonly mirror: WikiGenerationMirror
    readonly policy: InterruptPolicy | undefined
    readonly model: LeaderAgentParams['model']
    readonly teammateTools: NonNullable<LeaderAgentParams['tools']>
    readonly lifecycleTools: NonNullable<LeaderAgentParams['tools']>
    readonly capabilities: RunCapabilities
  }): DeepAgentLike {
    const backend = buildWikiUpdateBackend({
      // /lab 腿（default leg）带 #782 journaling：teammate 的 lab 写与 leader 图同入
      // file_journal（journalSessionId = 沙箱所属 session，1:1 对应容器）；/wiki/ 腿走
      // 镜像副本不 journal（临时目录随 run dispose，落容器只有 finish 单次推回）。
      defaultBackend: this.deps.fileJournal
        ? this.deps.fileJournal.backendFor({
            sessionId: p.sandboxSessionId,
            targets: { wiki: p.wikiContainer, lab: p.labContainer },
          })
        : new DockerArchiveBackend(this.deps.primitives, {
            wiki: p.wikiContainer,
            lab: p.labContainer,
          }),
      wikiRouteBackend: new FilesystemBackend({ rootDir: wikiMirrorRouteRootDir(p.mirror.root), virtualMode: true }),
      targets: { wiki: p.wikiContainer, lab: p.labContainer },
      locks: this.writeLocks,
      ctx: () => this.writeLockContext(p.sandboxSessionId, p.threadId),
      auditor: this.overwriteAuditor,
    })
    const wikiTools = createWikiRetrievalTools({ primitives: this.deps.primitives, wikiContainer: p.wikiContainer })
    const middleware = this.runtimeMiddleware()
    return buildLeaderAgent({
      model: p.model,
      backend,
      checkpointer: this.deps.saver,
      systemPrompt: [LEADER_SYSTEM_PROMPT, WIKI_UPDATE_TEAMMATE_PROMPT].join('\n\n'),
      official: p.capabilities.official,
      interruptPolicy: p.policy,
      tools: [...wikiTools, ...p.teammateTools, ...p.lifecycleTools],
      ...(middleware.length > 0 ? { middleware } : {}),
    })
  }

  // ---- finish 治理副作用（#790 通道②推回钩子）：base-hash 复检 → 推回 / 冲突信箱邮件 ----
  // 复检与 pull 同一实现同一口径（readContainerWikiTree）；复检 ≠ 基线（或树不可读——无法
  // 核验）→ 不推回 + leader 信箱邮件（conflict 不静默覆盖）；一致 → pushBack（putArchive +
  // diff rm）。
  private async finishWikiGeneration(
    cmd: RunCommand,
    mirror: WikiGenerationMirror,
    wikiContainer: string,
  ): Promise<WikiToolResult> {
    let current: Awaited<ReturnType<typeof readContainerWikiTree>> = null
    try {
      current = await readContainerWikiTree(this.deps.primitives, wikiContainer)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[runner] wiki base-hash recheck failed: session=${cmd.sessionId}: ${(e as Error).message}`)
    }
    if (current === null || current.hash !== mirror.baselineHash) {
      // 冲突：弃镜像不推回（executeRun finally dispose），leader 信箱通知是父会话时间线上
      // 的用户可见面。邮件失败不放大——conflict Result 始终是工具回传权威。
      try {
        await this.deps.teammates?.sendMail({
          parentSessionId: cmd.parentSessionId ?? cmd.sessionId,
          senderTeammateId: cmd.teammateId ?? null,
          recipientTeammateId: null,
          kind: WIKI_CONFLICT_MAIL_KIND,
          content: JSON.stringify({
            reason: 'base-hash-conflict',
            runId: cmd.runId,
            message: 'The wiki changed while the wiki-update teammate was running; the update was discarded without overwriting.',
          }),
        })
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[runner] wiki conflict mail failed: session=${cmd.sessionId}: ${(e as Error).message}`)
      }
      return {
        ok: false,
        error: {
          code: 'conflict',
          message: 'The real wiki changed while this update was running; nothing was published. Report the conflict to the leader.',
        },
      }
    }
    const push = await pushBackWikiGenerationMirror(this.deps.primitives, wikiContainer, mirror.root)
    return { ok: true, data: push }
  }

  // 写锁上下文现取（#785）：图实例跨 run 缓存，holder 不可构造期固化——每次加锁时从在飞
  // cmd 解析（activeCmds 以 threadId 为键；缺失 = 非 run 语境，label-only 兜底，清理靠
  // try/finally 纪律）。互斥域 = 沙箱所属 parent session（teammate /lab 写落 parent 沙箱，
  // 互斥随容器不随 thread；跨会话 wiki 锁 V1 不做——#747 230 行钉死）。
  private writeLockContext(sandboxSessionId: string, threadId: string): WriteLockContext {
    const cmd = this.activeCmds.get(threadId)
    return {
      session: sandboxSessionId,
      threadId,
      holder: cmd
        ? { runId: cmd.runId, label: `run ${cmd.runId}（thread ${threadId}）` }
        : { label: `thread ${threadId}` },
    }
  }

  private async startTeammate(parent: RunCommand, teammate: TeammateSummary): Promise<void> {
    const parentSessionId = parent.parentSessionId ?? parent.sessionId
    await this.deps.teammates?.updateStatus(parentSessionId, teammate.id, 'running')
    this.publish(parent.ownerId, {
      type: 'teammate.started',
      payload: { teammateId: teammate.id, name: teammate.name },
    }, { ...parent, parentSessionId, teammateId: teammate.id })
    await this.dispatch({
      runId: randomUUID(), sessionId: teammate.threadId, parentSessionId,
      ownerId: parent.ownerId, username: parent.username, kind: 'message',
      teammateId: teammate.id, content: teammate.task,
    })
  }

  private async scheduleMailboxTimeout(parent: RunCommand, input: {
    waitId: string; recipientTeammateId: string | null; delayMs: number; broadcastOnTimeout: boolean
  }): Promise<void> {
    const parentSessionId = parent.parentSessionId ?? parent.sessionId
    const threadId = input.recipientTeammateId
      ? (await this.deps.teammates?.get(parentSessionId, input.recipientTeammateId))?.threadId
      : parentSessionId
    if (!threadId) throw new Error('teammate mailbox thread not found')
    await this.dispatch({
      runId: `mail-timeout-${input.waitId}`, sessionId: threadId, parentSessionId,
      ownerId: parent.ownerId, username: parent.username, kind: 'resume',
      ...(input.recipientTeammateId ? { teammateId: input.recipientTeammateId } : {}),
      mailWaitId: input.waitId, mailWakeReason: 'timeout',
      mailBroadcastOnTimeout: input.broadcastOnTimeout,
    }, input.delayMs)
  }

  /** Resume only a thread parked at a mailbox interrupt. Checkpoint payload is the durable wait id. */
  async wakeMailbox(threadId: string, teammateId: string | null, waitId: string): Promise<void> {
    const teammate = teammateId
      ? await this.deps.prisma.teammate.findUnique({ where: { id: teammateId } })
      : null
    const parentSessionId = teammate?.parentSessionId ?? threadId
    const parent = await this.deps.prisma.session.findUnique({ where: { id: parentSessionId }, select: { ownerId: true } })
    const user = parent ? await this.deps.prisma.user.findUnique({ where: { id: parent.ownerId } }) : null
    if (!user) return
    await this.dispatch({
      runId: `mail-wake-${waitId}`, sessionId: threadId, parentSessionId,
      ownerId: user.id, username: user.username, kind: 'resume',
      ...(teammateId ? { teammateId } : {}), mailWaitId: waitId, mailWakeReason: 'message',
    })
  }

  async teammatesForRewind(sessionId: string, checkpointId: string): Promise<void> {
    const teammates = this.deps.teammates
    if (!teammates) return
    const parent = await this.deps.prisma.session.findUnique({ where: { id: sessionId }, select: { ownerId: true } })
    const ids = await teammates.rewind(sessionId, checkpointId)
    if (!parent) return
    for (const id of ids) {
      this.stopTeammate({ sessionId, ownerId: parent.ownerId }, await teammates.get(sessionId, id))
    }
  }

  // C1（#782 · #766）拆两面（时序错配修复）：作废面 rewindFiles **前**调（teammatesForRewind
  // 复用——防被唤醒 survivor 与逆放竞争围栏 FIFO：survivor 先获围栏的新写 checkpointId='' 会被
  // 本次逆放撤销）；通知面 rewindFiles **后**调（文案「已逆放恢复」在事实之后——先发信即虚假
  // 陈述）。degradedFiles（容器缺失/深度超限降级——/lab 未动）→ 文案如实「回退未完成」，不
  // 虚报「已逆放恢复」。对话面 rewind（scope=chat，文件未动）只走作废面。
  async teammatesNotifyFileRewind(sessionId: string, checkpointId: string, degradedFiles: boolean): Promise<void> {
    const teammates = this.deps.teammates
    if (!teammates) return
    const survivors = (await teammates.list(sessionId)).filter((t) => t.status !== 'archived')
    // degraded 文案中性化（scope=files 对话面零改动——「会话已回退至锚点」断言在此组合下
    // 虚假；半逆放中间态同理）：只述文件面未完成事实，不做对话面/终态承诺
    const content = degradedFiles
      ? `文件状态回退未完成——/lab 处于中间态（可重试回退收敛）`
      : `文件状态已回退至锚点 ${checkpointId.slice(0, 12)}（/lab 已逆放恢复，重放期间写入已排队）`
    for (const peer of survivors) {
      await teammates.sendMail({
        parentSessionId: sessionId,
        senderTeammateId: null,
        recipientTeammateId: peer.id,
        kind: 'system',
        content,
      })
    }
  }

  private stopTeammate(parent: Pick<RunCommand, 'sessionId' | 'ownerId' | 'parentSessionId'>, teammate: TeammateSummary): void {
    this.pendingApprovals.delete(teammate.threadId)
    const snap = this.runs.get(teammate.threadId)
    if (!snap || ['completed', 'failed', 'aborted'].includes(snap.state)) return
    if (this.abort(snap.runId, 'system')) return
    // Parked threads have no AbortController; retire scheduling while retaining their checkpoint.
    this.runs.set(teammate.threadId, { runId: snap.runId, state: 'aborted', by: 'system' })
    this.publish(parent.ownerId, { type: 'run.aborted', payload: { by: 'system' } }, {
      sessionId: teammate.threadId, runId: snap.runId,
      parentSessionId: parent.parentSessionId ?? parent.sessionId, teammateId: teammate.id,
    })
  }

  private async graphState(agent: DeepAgentLike, threadId: string): Promise<GraphStateLike> {
    return (await agent.getState({ configurable: { thread_id: threadId } })) as GraphStateLike
  }

  // 最新 checkpoint tuple 读取（四消费面共用：重放判据/in-flight 投影/recover 落行/interrupt
  // 推导；故障语义由调用面各自定义——不拦/降级空 turn/抛出/按无 interrupt）。
  private latestTuple(sessionId: string): Promise<LatestCheckpointTuple> {
    return this.deps.saver.getTuple({ configurable: { thread_id: sessionId } })
  }

  // recover 终态落行的双落防御：同 anchor 的 assistant 行已存在（processor 完成后 ack 前
  // 崩溃 → stalled 重放形态）→ 跳过。anchor = 终态 checkpoint id（同 run 恒同值）。
  private async turnAlreadyRecorded(sessionId: string, anchorCheckpointId: string): Promise<boolean> {
    const row = await this.deps.prisma.sessionMessage.findFirst({
      where: { sessionId, role: 'assistant', anchorCheckpointId },
      select: { id: true },
    })
    return row !== null
  }

  // recover 全量落行前的本 run 残留清理：本 run（message 及其 resume 链）中途终态的落行
  //（interrupted anchor=中断点 / failed、aborted anchor=null）turn 都晚于最近 user 行——
  // 同 thread 串行链保证这些行只能是本 run 的残留；blob 全量聚合（「最后 human 之后」切片）
  // 覆盖其内容 → 整链删除后由 recordTurn 落全量顶位，防「中途行 + 全量行」双行重叠。
  // 更早轮的 completed 行（turn ≤ 最近 user 行）不触碰。
  private async deleteRunResidues(sessionId: string): Promise<void> {
    const lastUser = await this.deps.prisma.sessionMessage.findFirst({
      where: { sessionId, role: 'user' },
      orderBy: [{ turn: 'desc' }, { createdAt: 'desc' }],
      select: { turn: true },
    })
    await this.deps.prisma.sessionMessage.deleteMany({
      where: { sessionId, role: 'assistant', turn: { gt: lastUser?.turn ?? 0 } },
    })
  }

  private async turnSnapshotFromCheckpoint(sessionId: string): Promise<TurnSnapshot> {
    return turnFromCheckpointMessages(channelMessages(await this.latestTuple(sessionId)))
  }

  // 从持久化状态推导「thread 停在 interrupt」（#747 A 节硬约束的内存缺失 fallback 面）：
  // 最新 checkpoint 的 pendingWrites 带 __interrupt__ channel（LangGraph interrupt 的标准
  // putWrites 通道，WRITES_IDX_MAP 负 idx）。blob 反序列化不做——pendingWrites 面足够。
  private async threadInterruptedFromCheckpoint(threadId: string): Promise<boolean> {
    let tuple: LatestCheckpointTuple | undefined
    try {
      tuple = await this.latestTuple(threadId)
    } catch {
      return false // checkpoint 读取故障按「无 interrupt」处理——resume 判定 50001，不放大
    }
    return (tuple?.pendingWrites ?? []).some(([, channel]) => channel === INTERRUPT_CHANNEL)
  }

  private async checkpointHasApproval(threadId: string, escalationId: string): Promise<boolean> {
    try {
      const tuple = await this.deps.saver.getTuple({ configurable: { thread_id: threadId } })
      return (tuple?.pendingWrites ?? []).some(([, channel, raw]) => {
        if (channel !== INTERRUPT_CHANNEL) return false
        const candidate = (raw as { value?: unknown } | null)?.value ?? raw
        return isApprovalInterruptPayload(candidate) && candidate.escalation.id === escalationId
      })
    } catch {
      return false
    }
  }
}

// checkpoint tuple 类型（Awaited：await latestTuple 后的形态）——四消费面共用单一别名。
type LatestCheckpointTuple = Awaited<ReturnType<PrismaCheckpointSaver['getTuple']>>

// checkpoint tuple → messages 通道（防御式：blob 形状漂移时返回空数组，调用面降级不炸）。
function channelMessages(tuple: LatestCheckpointTuple): unknown[] {
  const values = (tuple?.checkpoint as { channel_values?: { messages?: unknown } } | undefined)?.channel_values
  return Array.isArray(values?.messages) ? values.messages : []
}

// 快照类型的导出面（#778 消费；避免消费方反向 import 内部形状）
export type { ProviderConfigSnapshot }
