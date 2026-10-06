// runner 生产装配（#777 · #747 A 节「集中式 runner」）：
// PrismaCheckpointSaver + ProviderRegistry + ConcurrencyGate + StreamHub + DockerPrimitives
// → RunService → BullMqRunQueue（worker 消费）。REST 入队面归 #778 会话域（本票生产接线 =
// 进程内就绪 + 事件经 hub 扇出）。装配失败语义对齐 fleet 队列先例：BullMQ 连接 lazy，
// Redis 不可达不挂控制面（add 超时兜底在队列层）。

import type { PrismaClient } from '../generated/prisma/client'
import type { StreamHub } from '../events/hub'
import type { RunServiceDeps } from './runtime/runService'
import { DockerPrimitives } from './backend/dockerPrimitives'
import { PrismaCheckpointSaver } from './persistence/prismaCheckpointSaver'
import { ProviderRegistry } from './providerRegistry'
import { ConcurrencyGate } from './concurrency'
import { RunService } from './runtime/runService'
import { BullMqRunQueue } from './bullmqRunQueue'
import { disableLangsmithTracing } from './runtime/tracing'
import { installAbortRejectionGuard } from './runtime/abortGuard'
import { config } from '../config'
import { loadCheckpointParentOf } from '../checkpointChain'
import { wikiContainerName } from '../wikiContainers/runtime'
import { sandboxContainerName } from '../sandboxes/runtime'
import { createDownloadNode } from './runtime/downloadNode'
import { createPrismaApprovalAuditSink } from './approval/audit'
import { ToolCallJudgeClient } from './approval/judge'
import { ApprovalFunnel, type ApprovalFunnelDeps } from './approval/funnel'
import { JUDGE_POLICY_MARKDOWN } from './approval/values'
import { WriteLockRegistry } from './writelock/registry'
import { withLockedPuts } from './writelock/lockedBackend'
import { TeammateService } from './teammates/service'
import { FileJournalService } from './filejournal/service'
import { TEAMMATE_TOOL_NAMES } from './teammates/tools'
import { FILE_TOOLS, EXEC_TOOLS } from './approval/values'
import { PLUGIN_MANIFESTS } from '../../../plugins/index'
import { assertPluginEnv, assertValidPluginCatalog } from '../plugins/registry'
import { createPluginRuntime, resolvePluginConfig, type PluginRuntime } from '../plugins/surface'
import { SYSTEM_COMMANDS } from '../officialContent/catalog'
import { snapshotOfficialContent } from '../officialContent/runtime'

export interface RunnerAssembly {
  readonly service: RunService
  readonly queue: BullMqRunQueue
  /** #790 通道③独立 run 的装配复用面（WikiUpdateRunService 共享同一 registry/primitives） */
  readonly registry: ProviderRegistry
  readonly primitives: DockerPrimitives
  /** 文件 rewind 机制（#782）：SessionService fileRewind 面与启动 reconcile 的共用单例 */
  readonly fileJournal: FileJournalService
  /** 插件运行时（#788）：SessionService 命令构造点消费（{inject}/{execute} outcome 面） */
  readonly plugins: PluginRuntime
  close: () => Promise<void>
}

export async function assembleRunner(opts: {
  prisma: PrismaClient
  hub: StreamHub
  redisUrl: string
  maxConcurrentRuns: number
  recursionLimit?: number
  /** 沙箱生命周期（#776 契约「消费方 = #777 runner ensure/touch」；类型面复用 RunServiceDeps） */
  sandboxes?: NonNullable<RunServiceDeps['sandboxes']>
  /** wiki 容器生命周期（#784 契约「run 前 ensure」；server.ts 注入 WikiContainerLifecycle 子集） */
  wikis?: NonNullable<RunServiceDeps['wikis']>
  /** 审批漏斗 judge 模型（测试注入 fake；缺省按 config.runner.judge 构造，未配置 = 无 judge） */
  judge?: NonNullable<ApprovalFunnelDeps['judge']>
  /** #780 附件 ingestion（片 2：run 首步物化到沙箱 + 图片内联；server.ts 注入 AttachmentsService） */
  attachments?: NonNullable<RunServiceDeps['attachments']>
  /** #782 沙箱 ensure 解析（rewindFiles 前置；server.ts 注入 sandboxes.lifecycle.ensure） */
  ensureSandbox?: (sessionId: string) => Promise<{ containerId: string }>
  /** 插件运行时（#788；测试注入覆盖缺省目录装配——V1 目录为空时缺省装配即 no-op 面） */
  plugins?: PluginRuntime
}): Promise<RunnerAssembly> {
  // tracing 显式关（启动期第一路；RunService 构造期第二路兜底）
  disableLangsmithTracing()
  // LangGraph abortPromise 泄漏守门（用户 abort run 的进程级 crash 面，见 abortGuard.ts）
  installAbortRejectionGuard()

  const saver = new PrismaCheckpointSaver(opts.prisma)
  const registry = new ProviderRegistry(opts.prisma)
  const gate = new ConcurrencyGate({
    globalLimit: opts.maxConcurrentRuns,
    // users.maxConcurrentRuns 即读（admin 可改即时生效；坏列值 gate 层按 0 拒绝保护面）
    loadUserLimit: async (ownerId) => {
      const u = await opts.prisma.user.findUnique({
        where: { id: ownerId },
        select: { maxConcurrentRuns: true },
      })
      return u?.maxConcurrentRuns ?? 0
    },
  })
  const primitives = new DockerPrimitives()
  const teammates = new TeammateService(opts.prisma)
  // 插件运行时（#788 · #752）：启动期强校验（fail-fast——R2/R7 编译期信任下无「装了一半」）
  // + 全目录 env 完备性（R7 不看启用位：任何用户随时可启用 = 面板必须永远备好）。校验注
  // opts.plugins 缺省路径只跑——测试注入自备 runtime 时不重复校验。
  const plugins = opts.plugins ?? await (async () => {
    await assertValidPluginCatalog({
      manifests: PLUGIN_MANIFESTS,
      coreToolNames: [...FILE_TOOLS, ...EXEC_TOOLS, 'task', 'read_official_skill', ...TEAMMATE_TOOL_NAMES],
      reservedCommandNames: [...SYSTEM_COMMANDS, ...snapshotOfficialContent().commands.map((c) => c.name)],
    })
    assertPluginEnv(PLUGIN_MANIFESTS, {
      env: process.env,
      production: process.env.NODE_ENV === 'production',
      warn: (message) => {
        // eslint-disable-next-line no-console
        console.warn(`[plugins] ${message}`)
      },
    })
    return createPluginRuntime({ manifests: PLUGIN_MANIFESTS, config: resolvePluginConfig(PLUGIN_MANIFESTS, process.env) })
  })()
  // #785 per-path 写锁（互斥域 = 沙箱所属 parent session；有界等待超时 → agent 报错含
  // path 与持有者。覆盖 ingestion/校验节点 putArchive 写面——下方下载节点闭包内包装）。
  const writeLocks = new WriteLockRegistry({ timeoutMs: config.runner.writeLockTimeoutMs })

  // 文件 rewind 机制（#782 · D8）：JournalingBackend 打点接缝 + ingestion/D9 物化打点 +
  // rewind 逆放 + reconcile。journal sessionId 归属 parent（teammate 写共享 session-global
  // 日志）——containerOf 面按 session id 直呼（teammate 调用方传 parent id）。
  // 探在语义（null = 容器缺失/未运行）：reconcileOnBoot 的「容器缺失跳过」契约前提
  // （inspect 只读，启动期不批量 ensure——restore 路兜底）。经 DockerPrimitives 单客户端
  // inspectRunning（对齐 clientFactory 懒缓存先例——不裸 new Docker 双通道）。
  const fileJournal = new FileJournalService({
    prisma: opts.prisma,
    primitives,
    quotaBytes: config.runner.fileJournal.quotaBytes,
    depthLimit: config.runner.fileJournal.depthLimit,
    fenceTimeoutMs: config.runner.fileJournal.fenceTimeoutMs,
    containerOf: async (sessionId) => {
      const name = sandboxContainerName(sessionId)
      return (await primitives.inspectRunning(name)) ? name : null
    },
    ...(opts.ensureSandbox
      ? { ensureContainerOf: async (sessionId) => (await opts.ensureSandbox!(sessionId)).containerId }
      : {}),
    checkpointParentOf: async (sessionId) => loadCheckpointParentOf(opts.prisma, sessionId),
  })

  // #780 下载校验节点（片 3）：file 写类工具（write/edit）成功后校验声明路径 → 物化
  // Attachment 行 + 下载引用追加进 tool 输出（tool.end details 承载）；失败 → 错误回喂
  // agent loop 重新生成。ownerId 按 session 解析（工具调用面无身份参数——ctx 身份纪律）。
  const attachmentsForNode = opts.attachments
  const downloadNode = attachmentsForNode
    ? createDownloadNode({
        materialize: async (p) => {
          const teammate = await opts.prisma.teammate.findUnique({ where: { threadId: p.sessionId } })
          const sessionId = teammate?.parentSessionId ?? p.sessionId
          const session = await opts.prisma.session.findUnique({
            where: { id: sessionId },
            select: { ownerId: true },
          })
          if (!session) return null
          return attachmentsForNode.materializeAgentMedia({
            sessionId,
            ownerId: session.ownerId,
            declaredPath: p.declaredPath,
            mime: p.mime,
            container: p.container,
            // 校验节点物化写面入锁（#785）：互斥域 = 解析后的 parent session；
            // runId 在此闭包不可得（label-only holder）→ 不接覆盖审计（detect 无 run
            // 归属恒不落行）；清理靠 materialize 内 try/finally 纪律。
            primitives: withLockedPuts(primitives, writeLocks, () => ({
              session: sessionId,
              threadId: p.sessionId,
              holder: { label: `thread ${p.sessionId}` },
            })),
          })
        },
        resolveContainer: async (threadId) => {
          const teammate = await opts.prisma.teammate.findUnique({ where: { threadId } })
          return sandboxContainerName(teammate?.parentSessionId ?? threadId)
        },
        audit: (info) => {
          // eslint-disable-next-line no-console
          console.warn(`[runner] download node: session=${info.sessionId} path=${info.path} outcome=${info.outcome}`)
        },
      })
    : undefined

  // 审批三层漏斗（#783）：judge 按部署配置构造（独立小模型，与用户主模型解耦）；审计三层
  // 全量同步写 tool_approval_logs（ADR 0015）。judge 未配置 → 灰区一律升级人工（fail-closed）。
  const judge =
    opts.judge ??
    (config.runner.judge.model !== '' && config.runner.judge.baseUrl !== ''
      ? createJudgeClient()
      : undefined)
  const funnel = new ApprovalFunnel({
    judge,
    audit: createPrismaApprovalAuditSink(opts.prisma),
    // 插件 category 路由（#788 · §3）：domain 短路不进漏斗；file 类以声明 pathParams 过
    // 路径白名单；exec 类过命令黑名单——与核心工具同一闸门，无平行审批路径。
    pluginToolSpecs: (name) => plugins.toolSpecByName.get(name),
  })

  const service = new RunService({
    prisma: opts.prisma,
    registry,
    saver,
    gate,
    hub: opts.hub,
    primitives,
    // wiki 容器命名（#784 起经 wikiContainerName 单一来源派生——每用户一台
    // researcher-wiki-<ownerId>；与 wikiContainers/assembly 的创建面同源）。
    resolveWikiContainer: wikiContainerName,
    recursionLimit: opts.recursionLimit,
    sandboxes: opts.sandboxes,
    wikis: opts.wikis,
    approvals: funnel,
    teammates,
    approvalTimeoutMs: config.runner.approvalTimeoutMs,
    writeLocks,
    attachments: opts.attachments,
    downloadNode,
    fileJournal,
    plugins,
  })
  void service.recoverSuspensions() // 重启恢复：超时未落定的审批升级 → suspended（异步，不挂启动）

  const queue = new BullMqRunQueue({
    redisUrl: opts.redisUrl,
    execute: (cmd) => service.execute(cmd),
    // worker 并发 = 全局在飞上限（与 gate 同源同值）：gate 是拒绝式（满 → 40043），worker
    // 超领会把本可在 Redis 排队的 run 变成 40043 job failed（attempts:1 不重试、无 run 事件）
    // ——40043 是 Inline/#778 REST 的即时反馈面，不由 worker 面必然触发。
    concurrency: opts.maxConcurrentRuns,
  })
  service.setTeammateDispatcher((cmd, delayMs) => queue.submit(cmd, { delayMs }))
  teammates.setWakeHandler((threadId, teammateId, waitId) => service.wakeMailbox(threadId, teammateId, waitId))

  return {
    service,
    queue,
    registry,
    primitives,
    fileJournal,
    plugins,
    close: async () => {
      service.dispose()
      await queue.close()
    },
  }
}

// judge 客户端（部署级独立小模型；729 §2.5）：initChatModel 构造 + 共享 LLM_API_KEY。
// 出口不走 provider_endpoints 白名单——env 是 admin 信任面（config.runner.judge 注释同源）。
function createJudgeClient(): InstanceType<typeof ToolCallJudgeClient> {
  const { model, baseUrl, lcProvider } = config.runner.judge
  return new ToolCallJudgeClient(
    {
      async invoke(messages: unknown[]) {
        const { initChatModel } = await import('langchain/chat_models/universal')
        // temperature 0（729 §2.3：判定确定性面）；JSON mode 不依赖 provider response_format
        //（MiniMax/DeepSeek 兼容面支持参差）——输出契约由 ToolCallJudgeClient 的 zod 校验 +
        // 重试一次 + fail-closed 兑现（同语义，跨端点可移植）。
        const m = await initChatModel(model, {
          modelProvider: lcProvider,
          apiKey: config.runner.llmApiKey,
          temperature: 0,
          ...(lcProvider === 'openai'
            ? { baseUrl, configuration: { fetch: globalThis.fetch } }
            : { clientOptions: { baseURL: baseUrl, fetch: globalThis.fetch } }),
        })
        return m.invoke(messages as never)
      },
    },
    { policy: JUDGE_POLICY_MARKDOWN },
  )
}
