import { parseSlash, SYSTEM_COMMANDS } from '../officialContent/catalog'
import type { ModelRef } from '../runner/providerRegistry'
import { snapshotRunCapabilities } from '../runner/capabilities'
import { mergeCommandDirectories } from '../plugins/commandResolution'
import type { PluginRuntime } from '../plugins/surface'
import { snapshotOfficialContent } from '../officialContent/runtime'
// 会话域业务服务（#778 · #747 C 节会话 REST 全件）：扁平挂用户（容器维度退役）、创建/列表/
// 改标题（story 5 自动生成+可改）、发消息（story 7 32-hex 幂等）、abort（story 8 by:user）、
// resume、历史投影 GET、删会话级联删沙箱（#776 契约「消费方 = #778」）。
//
// 多端门禁（story 13 · #747 C 节）：running 全端禁输入（50005）/ interrupted 全端须先审批
//（50003，内核防御面在 RunService，此处 REST 前置即时反馈）/ resume 先到先得（50001，
// buildResumeCommand 预检 + executeRun 权威面双层）。事件扇出经 StreamHub 单例 → 该 user
// 全部连接同帧（多端广播一致由 hub.fanOut 保证，eventsHub.test.ts 锁）。
//
// 回放零差异（story 3）：SessionService.recordTurn 是 RunService 的 recordTurn 注入缝生产实现
// （server.ts 经 runner.service.setRecordTurn 回接）——run 域事件流经 TurnReducer 聚合，终态
// （completed/interrupted/aborted/failed 任一）落一条 assistant 行（attachmentsJson v1）；投影
// GET 反序列化回同形状。事件流归约 ≡ 投影行（sessionsApi.test.ts 逐字节断言）。

import { randomUUID } from 'node:crypto'
import type { PrismaClient, PrismaPromise, Session, SessionMessage } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { fail, EnvelopeError } from '../envelope'
import { CODE } from '../codes'
import { SANDBOX_CONTAINER_PREFIX } from '../sandboxes/values'
import { getSessionForUser } from '../sandboxes/service'
import type { SandboxRemoveOutcome } from '../sandboxes/lifecycle'
import type { EventPublisher, InFlightProjection, RunCommand, RunSnapshot } from '../runner/runtime/runService'
import { serializeAttachments, type RecordTurnPayload } from './reducer'
import { ancestorChainOf, loadCheckpointParentOf, visibleRowIds, type HistoryRowLite } from '../checkpointChain'
import {
  abandonedCheckpointIds,
  resolveRewindAnchor,
} from './rewind'
import { TITLE_AUTO_MAX, TITLE_MAX, type RewindScope } from './values'
import type { TeammateStatus } from '../runner/teammates/service'
import type { ApprovalInterruptPayload } from '../runner/approval/funnel'
import type { RewindPreview as FileRewindPreview } from '../runner/filejournal/preview'

// 会话摘要（session.created/updated 载荷 + 列表行 + 创建/PATCH 返回——同一形状）。
export interface SessionSummary {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
}

// 投影消息行（GET /messages 输出；前端单管线渲染的输入形状——实时事件归约同构）。
export interface ProjectionMessage {
  readonly id: string
  readonly turn: number
  readonly role: string
  readonly content: string
  readonly thinking?: string
  readonly tools?: unknown[]
  readonly anchorCheckpointId: string | null
  readonly createdAt: string
}

export interface SessionProjection {
  readonly sessionId: string
  readonly title: string
  readonly messages: ProjectionMessage[]
  /** in-flight 投影（story 11 · #779）：有进行中 run 时带出（从 checkpoint blob 反序列化重建，
   *  即焚 token 事件的补偿真相源）；无在飞 = 字段缺省。多端重拉同帧（同一内存态）。 */
  readonly inFlight?: InFlightProjection
  readonly teammates?: TeammateProjection[]
  readonly approvals?: Array<ApprovalInterruptPayload & { teammateId?: string }>
}

export interface TeammateProjection {
  readonly id: string
  readonly name: string
  readonly task: string
  readonly status: TeammateStatus
  readonly messages: ProjectionMessage[]
  readonly mailbox: Array<{ id: string; senderTeammateId: string | null; recipientTeammateId: string | null; kind: string; content: string; createdAt: string }>
  readonly inFlight?: InFlightProjection
}

export interface SystemCommandResult {
  readonly name: 'new' | 'model'
  readonly sessionId?: string
  readonly model?: ModelRef | null
  readonly models?: readonly ModelRef[]
  readonly appliesTo?: 'next-run'
}
export interface SendMessageResult {
  readonly command?: SystemCommandResult
  readonly messageId: string
  readonly turn: number
  readonly runId: string | null // 重放（replay=true）时 run 在首次请求已入队，此处 null
  readonly replay: boolean
}

// RunService 的结构子集（门禁观测 + 配额预检 + 命令构造 + abort）——测试注入同形 fake/真
// 实例，不依赖具体类。
export interface SessionRunGateway {
  readonly pendingApprovalProjection?: (threadId: string) => Promise<ApprovalInterruptPayload[]>
  readonly resolveApproval?: (params: { sessionId: string; ownerId: string; username: string; escalationId: string; decision: 'allow' | 'deny'; reason?: string }) => Promise<void>
  readonly resolveModelSelection?: (ownerId: string, args: string) => Promise<Omit<SystemCommandResult, 'name'>>
  readonly stateOf: (sessionId: string) => RunSnapshot | undefined
  readonly abort: (runId: string, by?: 'user' | 'system') => boolean
  /** 额度满预检（#777 注释契约「额度即时反馈面归 #778 REST」；只读不占额） */
  readonly quotaFull: (ownerId: string, sessionId?: string) => Promise<boolean>
  readonly buildMessageCommand: (p: {
    sessionId: string
    ownerId: string
    username: string
    content: string
    attachmentIds?: readonly string[]
  }) => Promise<RunCommand>
  readonly buildResumeCommand: (p: {
    sessionId: string
    ownerId: string
    username: string
    decisions?: unknown
  }) => RunCommand
  /** in-flight 投影（#779 story 11）：重拉投影的补偿重建面（running 从 checkpoint 重建/queued 空 turn） */
  readonly inFlightProjection: (sessionId: string) => Promise<InFlightProjection | undefined>
  /** teammate 级联作废（#781 缺口顺带接线；#786 AC4 演进：锚点祖先链判定 + 归档 + 未读留言
   *  失效 + 停跑/事件，由 RunService 统一面完成） */
  readonly teammatesForRewind?: (sessionId: string, checkpointId: string) => Promise<void>
  /** C1 通知面（#782 拆面：作废归 teammatesForRewind、逆放前先行；本方法在 rewindFiles 后调——
   *  degradedFiles 分文案，/lab 未动时如实报「回退未完成」） */
  readonly teammatesNotifyFileRewind?: (sessionId: string, checkpointId: string, degradedFiles: boolean) => Promise<void>
}

// run 命令发射口（submit 入队 ack 语义）：生产 = BullMQ submit（resolve = job 已入队；
// reject = 入队失败——调用方回滚落行，见 sendMessage），执行体错误在 run 域事件面表达
//（#779 补偿兜底 job 已入队形态）。50001/50003 等预检在 REST 面完成，dispatch 后的异步
// 失败经 run 域事件/日志表达。
export type RunDispatcher = (cmd: RunCommand) => Promise<void>

export interface SessionServiceDeps {
  readonly prisma: PrismaClient
  readonly hub: EventPublisher
  readonly runService: SessionRunGateway
  readonly dispatch: RunDispatcher
  /** 删会话级联删沙箱（#776；缺省 no-op——测试不注则不删）。fork（#781 · #768 D7）：
   *  源沙箱字面复制 → 'copied'；源不存在 → 'source-missing'（调用方空起步 + 系统消息）。
   *  缺省不注 = 恒 'source-missing'（纯 DB fork，测试面可控）。 */
  readonly sandboxes?: {
    readonly remove: (sessionId: string) => Promise<SandboxRemoveOutcome>
    readonly fork: (sourceSessionId: string, newSessionId: string) => Promise<'copied' | 'source-missing'>
  }
  /** #780 附件链接（≤4 件 + 归属/session 校验；缺省不注 = 发消息不接受附件引用） */
  readonly attachments?: {
    readonly linkToMessage: (
      user: Pick<AuthUser, 'id' | 'role'>,
      sessionId: string,
      messageId: string,
      attachmentIds: readonly string[],
    ) => Promise<void>
  }
  /** 文件 rewind（#782 · D8）：rewindFiles 逆放 + 预览。缺省不注 = 文件面 no-op（测试可控）。 */
  readonly fileRewind?: {
    readonly rewindFiles: (p: {
      sessionId: string
      anchor: string
      userId: string
      username: string
    }) => Promise<{ reverted: number; skippedMissing: number; degraded: boolean }>
    /** 锁内直呼面（rewindSession 持 runRewindExclusive 同一围栏——外层 rewindFiles 重入即
     *  死锁；与 runRewindExclusive 成对注入，缺后者时 rewindSession 走无锁 rewindFiles） */
    readonly rewindFilesCore: (p: {
      sessionId: string
      anchor: string
      userId: string
      username: string
    }) => Promise<{ reverted: number; skippedMissing: number; degraded: boolean }>
    /** rewind 会话级互斥（「锚点校验→归档事务→逆放」整段 FIFO 串行化——双端并发 rewind 面） */
    readonly runRewindExclusive?: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>
    readonly preview: (p: {
      sessionId: string
      anchor: string
      caller?: { userId: string; username: string }
    }) => Promise<FileRewindPreview>
  }
  /** 插件运行时（#788 · #752 §2.3）：插件命令 {inject}/{execute} 在 sendMessage 命令构造点
   *  消费（启用集 per-command 现读快照）。缺省不注 = 无插件命令源（两源合并退化为单源）。 */
  readonly plugins?: PluginRuntime
}

// 恢复菜单三态 REWIND_SCOPES/RewindScope 单点在 ./values（zod schema 同源派生）。

export interface RewindResult {
  readonly sessionId: string
  /** scope=all/chat = 新锚点；scope=files = 指针不变（对话未动） */
  readonly activeCheckpointId: string | null
  readonly scope: RewindScope
  /** 文件面结果（scope=chat 缺省——未执行逆放） */
  readonly files?: { readonly reverted: number; readonly skippedMissing: number; readonly degraded: boolean }
}

// RunService recordTurn 注入缝的载荷（RecordTurnPayload）单一声明于 './reducer'。

function summary(s: Session): SessionSummary {
  return { id: s.id, title: s.title, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() }
}

// turn 序号分配 + 落行打包进 interactive transaction：read-then-write 在 SQLite 单连接事务内
// 原子（并发写排队），消除交错窗口——run 终态 recordTurn 与门禁放行的新 sendMessage 落行
// 曾可重叠（completed 置位于 finally recordTurn 之前），裸 read-then-write 下产生同 turn 双行，
// 投影 (turn asc, createdAt asc) 排序下答先于问（R3 评审）。
async function insertWithNextTurn(
  prisma: PrismaClient,
  sessionId: string,
  data: {
    role: string
    content: string
    clientKey?: string
    anchorCheckpointId?: string | null
    attachmentsJson?: string
  },
): Promise<SessionMessage> {
  return prisma.$transaction(async (tx) => {
    const last = await tx.sessionMessage.findFirst({
      where: { sessionId },
      orderBy: { turn: 'desc' },
      select: { turn: true },
    })
    return tx.sessionMessage.create({
      data: { sessionId, turn: (last?.turn ?? 0) + 1, ...data },
    })
  })
}

// 投影行组装：content 独立列 + attachmentsJson 聚合面（v 版本字段不外露）；assistant 行
// thinking/tools 仅在有内容时出现（与 TurnReducer.snapshot 缺省纪律一致）。
function toProjectionMessage(row: SessionMessage): ProjectionMessage {
  let aggregate: { thinking?: string; tools?: unknown[] } = {}
  if (row.role === 'assistant') {
    try {
      const parsed = JSON.parse(row.attachmentsJson) as { v?: number; thinking?: string; tools?: unknown[] }
      const { v: _v, ...rest } = parsed
      aggregate = rest
    } catch {
      aggregate = {} // 坏 JSON 不炸读路径（写面恒经 serializeAttachments，防御面）
    }
  }
  return {
    id: row.id,
    turn: row.turn,
    role: row.role,
    content: row.content,
    ...aggregate,
    anchorCheckpointId: row.anchorCheckpointId,
    createdAt: row.createdAt.toISOString(),
  }
}

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  // ---- 创建（扁平挂用户；containerId = 预言名 researcher-sandbox-<id>，沙箱本体惰性创建
  // 由 #776 ensure 在首次 run/上传时落地）+ session.created{source:new} 广播 ----
  async createSession(user: Pick<AuthUser, 'id'>, title = ''): Promise<SessionSummary> {
    const fresh = await this.deps.prisma.$transaction(async (tx) => {
      // 两跳打包事务：预言名 PREFIX+id 依赖 create 生成的 id——打包消除 containerId 空值
      // 中间态（并发列表/详情读不可见）。
      const created = await tx.session.create({
        data: { ownerId: user.id, containerId: '', title },
      })
      return tx.session.update({
        where: { id: created.id },
        data: { containerId: `${SANDBOX_CONTAINER_PREFIX}${created.id}` },
      })
    })
    this.publishSessionEvent(user.id, 'session.created', { source: 'new', session: summary(fresh) }, fresh.id)
    return summary(fresh)
  }

  // ---- 列表：本人会话（扁平挂用户；updatedAt DESC 最新在前）----
  async listSessions(user: Pick<AuthUser, 'id'>): Promise<{ sessions: SessionSummary[] }> {
    const rows = await this.deps.prisma.session.findMany({
      where: { ownerId: user.id, archivedAt: null, isTeammate: false },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    })
    return { sessions: rows.map(summary) }
  }

  // ---- 改标题（story 5 可改面；归属门同码 50002）+ session.updated 广播 ----
  async renameSession(user: Pick<AuthUser, 'id' | 'role'>, sessionId: string, title: string): Promise<SessionSummary> {
    await getSessionForUser(this.deps.prisma, user, sessionId)
    const fresh = await this.deps.prisma.session.update({ where: { id: sessionId }, data: { title } })
    this.publishSessionEvent(user.id, 'session.updated', { session: summary(fresh) }, sessionId)
    return summary(fresh)
  }

  // ---- 删会话（级联：沙箱容器+网络 → DB 行 onDelete Cascade 清 messages/checkpoints/
  // attachments/fileJournal）。先删沙箱（失败保留行可重试——remove 'not-found' 幂等）再删行，
  // 防孤儿容器（sweeper 只 stop 不 remove）。
  // 在飞 run 互斥（R3 评审）：非终态（queued/running/interrupted）挡删 50005——删 = 沙箱随删
  //（在飞工具全失败）+ 行删后 run 域事件成无主引用 + recordTurn FK 失败。先 abort/等终态再
  // 删；stateOf 内存缺失（本进程无该会话 run 记录——worker 同进程模型）= 可删。----
  async deleteSession(user: Pick<AuthUser, 'id' | 'role'>, sessionId: string): Promise<void> {
    await getSessionForUser(this.deps.prisma, user, sessionId)
    this.requireTerminal(sessionId)
    const teammates = await this.deps.prisma.teammate.findMany({
      where: { parentSessionId: sessionId },
      select: { threadId: true, status: true },
    })
    for (const teammate of teammates) {
      const state = this.deps.runService.stateOf(teammate.threadId)?.state
      const executing = state === 'queued' || state === 'running'
      const live = teammate.status !== 'archived' && (state
        ? !['completed', 'aborted', 'failed'].includes(state)
        : ['queued', 'running', 'waiting', 'suspended'].includes(teammate.status))
      if (executing || live) {
        throw fail(CODE.RUN_IN_PROGRESS)
      }
    }
    await this.deps.sandboxes?.remove(sessionId)
    await this.deps.prisma.$transaction(async (tx) => {
      const teammateThreads = await tx.teammate.findMany({
        where: { parentSessionId: sessionId },
        select: { threadId: true },
      })
      if (teammateThreads.length > 0) {
        await tx.session.deleteMany({ where: { id: { in: teammateThreads.map((row) => row.threadId) } } })
      }
      await tx.session.delete({ where: { id: sessionId } })
    })
  }

  // ---- 终态门禁（#778 多端互斥的 rewind/fork/删 共用面）：queued/running/interrupted/suspended
  // → 50005（rewind 换锚会作废在飞 checkpoint 链；fork 复制源沙箱要求导出快照静止——run 进行
  // 中导出文件系统在变）。stateOf 内存缺失 = 可操作（worker 同进程模型）。----
  private requireTerminal(sessionId: string): void {
    const snap = this.deps.runService.stateOf(sessionId)
    const terminal =
      snap === undefined ||
      snap.state === 'completed' ||
      snap.state === 'aborted' ||
      snap.state === 'failed'
    if (!terminal) throw fail(CODE.RUN_IN_PROGRESS)
  }

  // ---- 发消息（story 7 幂等 + 多端门禁）。顺序：归属 → 幂等 → 门禁 → 配额预检 → 命令构造
  // → 落 user 行 → dispatch（ack 失败回滚删行）。
  // 幂等查先于门禁：断网重发的首个请求可能已把 run 推入 running——重发必须拿 replay 应答
  //（200）而非 50005 门禁错误（「断网重发不重复入列」的语义面：已收的消息不应答错误）。
  // 并发同 key 单落：先查 + 唯一约束 P2002 兜底重查（bootstrap 先例）——约束是单落权威，
  // 双请求都越过先查时后落者撞约束回读既有行（replay 形态返回，不重复 dispatch）。----
  async sendMessage(
    user: Pick<AuthUser, 'id' | 'role' | 'username'>,
    sessionId: string,
    p: { content: string; clientKey: string; attachmentIds?: readonly string[] },
  ): Promise<SendMessageResult> {
    // 归属门（50002 同码防探测）先行；此后本体不再消费入口快照（残留清理在函数内重读指针——
    // 入口快照可能落后于上一轮 completed 的指针推进，R 评审）。
    await getSessionForUser(this.deps.prisma, user, sessionId)
    // 斜杠识别/幂等/门禁全部作用于**原始输入**：落行存用户所发原文，官方模板展开只在命令
    // 构造点进行——模板发版改文不改变已存内容，同 key 重发恒 replay（#778 story 7；50007 只对
    // 真正异 content 的输入触发）。系统命令（/new /compact /model）为保留名（catalog 构造期
    // 拒绝同名官方命令），恒以原文穿过 expand。
    const slash = parseSlash(p.content)
    const existing = await this.deps.prisma.sessionMessage.findUnique({
      where: { sessionId_clientKey: { sessionId, clientKey: p.clientKey } },
    })
    if (existing) return this.replayOrConflict(existing, p.content)
    if (slash?.name === 'new' || slash?.name === 'model') return this.executeSystemCommand(user, sessionId, p, slash)
    if (slash?.name === 'compact' && slash.args) throw fail(CODE.VALIDATION_FAILED, '/compact 不接受参数')

    // 多端门禁（#747 C 节）：queued/running → 50005 禁新输入；interrupted → 50003 须先审批
    //（内核面 RunService.execute 同挡，此处 REST 即时反馈——入队前拒绝，不产生 queued 幽灵）。
    // 观测窗口（已知边界）：dispatch=BullMQ 异步入队，submit→worker 拾取间 stateOf 尚无记录，
    // 窗口内新输入穿透 50005 沿串行链排队（顺序保证不丢，仅门禁反馈弱化；S1 Inline 同步
    // 执行无此窗口——测试面与生产行为在此点的分叉已认知）。
    const snap = this.deps.runService.stateOf(sessionId)
    if (snap?.state === 'running' || snap?.state === 'queued') throw fail(CODE.RUN_IN_PROGRESS)
    if (snap?.state === 'interrupted') throw fail(CODE.RUN_INTERRUPT_PENDING)

    // 配额即时反馈（#777 注释契约「额度即时反馈面归 #778 REST」）：满 → 40043。预检只读不占
    // 额——紧邻并发仍可能双双穿透，权威判定在 worker 的 gate.acquire（job failed 面，#779
    // 兜底该形态：job 已入队故可观测）。
    if (await this.deps.runService.quotaFull(user.id, sessionId)) throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED)

    // 命令构造先于落行：构造失败（caller 缺失/50002 面）不落行——幂等键只在「run 确已被
    // 接受」后锁定（失败请求锁死幂等键 = story 7 语义反转：重发恒 replay 而消息从未被处理）。
    // 官方命令展开在此处（唯一消费方 = run）：/research x → 模板正文 $ARGUMENTS 插值；非官方
    // 输入恒等返回。落行 content 列仍存原始输入（见 sendMessage 头注）。
    // 插件命令（#788 · #752 §2.3 R4/R9）：两源合并序 = 系统含官方 > 插件（无遮蔽——注册期
    // 校验保证不撞名）。slash 命中启用集内插件命令 → handler 产出 outcome：{inject} 以
    // user message 注入（官方命令同形）；{execute} 直达本插件工具执行面（operation=
    // plugin-execute，不经 agent）。启用集 per-command 现读快照（禁用即下个命令不生效）。
    let runContent = snapshotOfficialContent().expand(p.content)
    let pluginExecute: { tool: string; args: unknown } | undefined
    if (slash && !(SYSTEM_COMMANDS as readonly string[]).includes(slash.name) && this.deps.plugins) {
      const enabled = await snapshotRunCapabilities(this.deps.prisma, user.id)
      const commandDirectory = mergeCommandDirectories({
        official: snapshotOfficialContent().commands,
        plugin: this.deps.plugins.surface([...enabled.enabledPluginIds]).commands,
      })
      const resolved = slash ? commandDirectory.get(slash.name) : undefined
      // 官方命中 → runContent 已是展开产物（上方 expand）；插件命中 → handler outcome 覆盖
      //（{inject} 以 user message 注入；{execute} 直达本插件工具执行面，不经 agent）。
      if (resolved?.source === 'plugin') {
        const outcome = await resolved.entry.command.handler(slash.args, { logger: { info: () => {}, warn: () => {} } })
        if ('inject' in outcome) runContent = outcome.inject
        else pluginExecute = outcome.execute
      }
    }
    let cmd = await this.deps.runService.buildMessageCommand({
      sessionId,
      ownerId: user.id,
      username: user.username,
      content: runContent,
      attachmentIds: p.attachmentIds,
    })

    if (slash?.name === 'compact') cmd = { ...cmd, operation: 'compact' }
    else if (pluginExecute) cmd = { ...cmd, operation: 'plugin-execute', pluginTool: pluginExecute.tool, pluginArgs: pluginExecute.args }

    // rewind 残留清理（#781 story 16）：rewind 态（指针非空）时，锚点之后的残留行归档（#770
    // 软删）——落新 user 行前清场，防「失败轮 + 重开轮」双 user 并列投影。指针在清理函数内
    // 重读（见 archiveRowsOffAnchor）；未 rewind 会话（指针恒 null）全量历史保留。
    await this.archiveRowsOffAnchor(sessionId)

    // 落行先于 dispatch：dispatch 后 run 域事件（run.started 起）才可见，用户行必已在投影中
    //（刷新窗口无「事件先于消息」跳变）。
    let row: SessionMessage
    try {
      row = await insertWithNextTurn(this.deps.prisma, sessionId, {
        role: 'user',
        content: p.content,
        clientKey: p.clientKey,
      })
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        // 已知毫秒窗口（R4 记录备查）：败方经此分支拿 replay 应答后，若胜方 dispatch ack
        // 失败回滚删行，败方应答与实况相悖——需 dispatch 故障叠加并发窗口，刷新自愈。
        const winner = await this.deps.prisma.sessionMessage.findUnique({
          where: { sessionId_clientKey: { sessionId, clientKey: p.clientKey } },
        })
        if (!winner) throw e
        return this.replayOrConflict(winner, p.content)
      }
      throw e
    }

    // #780：附件引用链接（≤4 件 + 归属/session 校验在 linkToMessage）。失败 → 消息行回滚
    //（引用与消息同生共死——校验失败的消息不应留下无引用的幽灵行）。链接先于 dispatch：
    // worker 拾取 run 时按消息行读附件（片 2 ingestion），引用必须在 run 事件前就位。
    if (p.attachmentIds && p.attachmentIds.length > 0 && this.deps.attachments) {
      try {
        await this.deps.attachments.linkToMessage(user, sessionId, row.id, p.attachmentIds)
      } catch (e) {
        await this.deps.prisma.sessionMessage.delete({ where: { id: row.id } }).catch(() => {})
        throw e
      }
    }

    // dispatch = submit 入队 ack：失败 → 回滚删行。行残留的后果不可补偿——submit 失败无 job、
    // 无事件（#779 补偿只覆盖 job 已入队形态），重发同 key 将恒 replay 而消息永不执行。回滚
    // 后幂等键随行消失，重发重走全流程。回滚自身失败 best-effort（行残留概率 = DB 已故障，
    // 此时告警面在日志）。附件链接随行回滚（messageId → null，字节与临时区不动）。
    try {
      await this.deps.dispatch(cmd)
    } catch {
      await this.deps.prisma.sessionMessage.delete({ where: { id: row.id } }).catch(() => {})
      if (p.attachmentIds && p.attachmentIds.length > 0) {
        await this.deps.prisma.attachment
          .updateMany({ where: { id: { in: [...p.attachmentIds] }, sessionId }, data: { messageId: null } })
          .catch(() => {})
      }
      throw fail(CODE.INTERNAL, 'run 入队失败，请稍后重试')
    }
    return { messageId: row.id, turn: row.turn, runId: cmd.runId, replay: false }
  }

  private replayOrConflict(existing: SessionMessage, content: string): SendMessageResult {
    if (existing.content !== content) throw fail(CODE.MESSAGE_KEY_CONFLICT)
    // 坏 JSON 不炸 replay 路径（写面恒经 serializeAttachments，防御面同 toProjectionMessage）
    let command: SystemCommandResult | undefined
    try {
      command = (JSON.parse(existing.attachmentsJson || '{}') as { command?: SystemCommandResult }).command
    } catch {
      command = undefined
    }
    return { messageId: existing.id, turn: existing.turn, runId: null, replay: true, ...(command ? { command } : {}) }
  }

  private async executeSystemCommand(
    user: Pick<AuthUser, 'id'>, sessionId: string, p: { content: string; clientKey: string }, slash: { name: string; args: string },
  ): Promise<SendMessageResult> {
    if (slash.name === 'new' && slash.args) throw fail(CODE.VALIDATION_FAILED, '/new 不接受参数')
    const selection = slash.name === 'model'
      ? await this.deps.runService.resolveModelSelection?.(user.id, slash.args)
      : undefined
    if (slash.name === 'model' && !selection) throw fail(CODE.INTERNAL, '模型选择能力未接线')
    const result = await this.deps.prisma.$transaction(async tx => {
      const previous = await tx.sessionMessage.findUnique({ where: { sessionId_clientKey: { sessionId, clientKey: p.clientKey } } })
      if (previous) return { response: this.replayOrConflict(previous, p.content) }
      let created: Session | undefined
      let command: SystemCommandResult
      if (slash.name === 'new') {
        const fresh = await tx.session.create({ data: { ownerId: user.id, containerId: '', title: '' } })
        created = await tx.session.update({ where: { id: fresh.id }, data: { containerId: `${SANDBOX_CONTAINER_PREFIX}${fresh.id}` } })
        command = { name: 'new', sessionId: created.id }
      } else {
        if (selection && 'model' in selection) await tx.session.update({ where: { id: sessionId }, data: { preferredModelJson: selection.model ? JSON.stringify(selection.model) : null } })
        command = { name: 'model', ...selection }
      }
      // turn 分配与幂等查同处一个 interactive transaction：better-sqlite3 单连接下事务体
      // 串行执行（写排队），read-then-write 无交错窗口——无需常规路径的 P2002 兜底重查
      //（该兜底防的是「先查在事务外」的间隙，此处查/写同事务，约束撞不上）。
      const last = await tx.sessionMessage.findFirst({ where: { sessionId }, orderBy: { turn: 'desc' }, select: { turn: true } })
      const row = await tx.sessionMessage.create({
        data: { sessionId, turn: (last?.turn ?? 0) + 1, role: 'user', content: p.content, clientKey: p.clientKey, attachmentsJson: serializeAttachments({ command }) },
      })
      return { created, response: { messageId: row.id, turn: row.turn, runId: null, replay: false, command } }
    })
    if (result.created) this.publishSessionEvent(user.id, 'session.created', { source: 'new', session: summary(result.created) }, result.created.id)
    // session.updated 只随「偏好真实落定」（含 /model default 重置）广播——/model 无参纯列清单
    // 不发事件（列清单是查询不是变更，广播 model:undefined 是噪音）。
    const command = result.response.command
    if (command?.name === 'model' && 'model' in command && !result.response.replay) {
      this.publishSessionEvent(user.id, 'session.updated', { sessionId, model: command.model, appliesTo: 'next-run' }, sessionId)
    }
    return result.response
  }

  // ---- 中断（story 8，by:user）。仅 running 在飞 run 可中断（RunService.abort 只对 aborts
  // 条目生效——queued/interrupted/终态 → 50006）。run.aborted{by:user} 事件由 RunService 发。----
  async abortRun(user: Pick<AuthUser, 'id' | 'role'>, sessionId: string): Promise<{ runId: string }> {
    await getSessionForUser(this.deps.prisma, user, sessionId)
    const snap = this.deps.runService.stateOf(sessionId)
    if (snap?.state !== 'running' || !this.deps.runService.abort(snap.runId, 'user')) {
      throw fail(CODE.RUN_NOT_ABORTABLE)
    }
    return { runId: snap.runId }
  }

  // ---- resume（interrupt 全端可审批面；#783 审批漏斗接 decisions 构造，本票机制面直通）。
  // 先到先得：buildResumeCommand 预检 50001（executeRun 权威面兜底并发窗口）。配额即时反馈同
  // sendMessage（quotaFull → 40043）——resume 是 interrupted 会话唯一可用入口（sendMessage 被
  // 50003 挡），缺预检时配额满期间 REST 200 → worker 40043 → 无 run 域事件，会话停 interrupted
  // 用户零信号（R4 评审）。
  // REST 应答语义边界（已知）：两端紧邻并发时败方预检仍过（先到者尚未把 state 推离 interrupted）→
  // REST 200 + runId，权威 50001 在内核面拒绝且无该 runId 的任何事件——最终一致由赢家的
  // run.resumed 同帧扇出保证（多端事件面同一真相），REST 应答在窗口内有误导性。
  // dispatch await 入队 ack：失败（state 仍 interrupted 未变）→ 90000，重试 resume 即可。----
  async resumeRun(
    user: Pick<AuthUser, 'id' | 'role' | 'username'>,
    sessionId: string,
    decisions?: unknown,
  ): Promise<{ runId: string }> {
    await getSessionForUser(this.deps.prisma, user, sessionId)
    const cmd = this.deps.runService.buildResumeCommand({
      sessionId,
      ownerId: user.id,
      username: user.username,
      decisions,
    })
    if (await this.deps.runService.quotaFull(user.id, sessionId)) throw fail(CODE.CONCURRENCY_QUOTA_EXCEEDED)
    await this.deps.dispatch(cmd)
    return { runId: cmd.runId }
  }

  // ---- 历史投影 GET（story 3 回放面；turn 升序）。50002 同码防探测。
  // inFlight（#779 story 11）：有进行中 run 时同响应带出「从 checkpoint blob 反序列化重建」
  // 的进行中 turn——断线补偿 = 重拉投影 + in-flight 重建一次完成（前端以投影为锚重挂视图）。
  // archivedAt 过滤（#781 rewind 软删）：被放弃路线行产品面不可读（#770「无恢复入口」——
  // 比较路线 = fork 并存多开）。
  async getProjection(user: Pick<AuthUser, 'id' | 'role'>, sessionId: string): Promise<SessionProjection> {
    const session = await getSessionForUser(this.deps.prisma, user, sessionId)
    const rows = await this.deps.prisma.sessionMessage.findMany({
      where: { sessionId, archivedAt: null },
      orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }],
    })
    const inFlight = await this.deps.runService.inFlightProjection(sessionId)
    const peers = await this.deps.prisma.teammate.findMany({
      where: { parentSessionId: sessionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { thread: { include: { messages: { orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }] } } } },
    })
    const mail = peers.length > 0 ? await this.deps.prisma.teammateMailboxMessage.findMany({
      where: { parentSessionId: sessionId, invalidatedAt: null, OR: [{ readAt: { not: null } }, { expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }) : []
    const teammates = await Promise.all(peers.map(async peer => {
      const active = await this.deps.runService.inFlightProjection(peer.threadId)
      return {
        id: peer.id, name: peer.name, task: peer.task, status: peer.status as TeammateStatus,
        messages: peer.thread.messages.map(toProjectionMessage),
        mailbox: mail.filter(message => message.senderTeammateId === peer.id || message.recipientTeammateId === peer.id).map(message => ({
          id: message.id, senderTeammateId: message.senderTeammateId, recipientTeammateId: message.recipientTeammateId,
          kind: message.kind, content: message.content, createdAt: message.createdAt.toISOString(),
        })),
        ...(active !== undefined ? { inFlight: active } : {}),
      }
    }))
    const approvals = this.deps.runService.pendingApprovalProjection ? [
      ...await this.deps.runService.pendingApprovalProjection(sessionId),
      ...(await Promise.all(peers.filter(peer => peer.archivedAt === null).map(async peer =>
        (await this.deps.runService.pendingApprovalProjection!(peer.threadId)).map(approval => ({ ...approval, teammateId: peer.id })),
      ))).flat(),
    ] : []
    return {
      sessionId,
      title: session.title,
      messages: rows.map(toProjectionMessage),
      ...(inFlight !== undefined ? { inFlight } : {}),
      ...(teammates.length > 0 ? { teammates } : {}),
      ...(approvals.length > 0 ? { approvals } : {}),
    }
  }

  async resolveApproval(user: Pick<AuthUser, 'id' | 'role' | 'username'>, sessionId: string, escalationId: string, decision: 'allow' | 'deny', reason?: string): Promise<void> {
    const session = await getSessionForUser(this.deps.prisma, user, sessionId)
    if (!this.deps.runService.resolveApproval) throw fail(CODE.APPROVAL_NOT_FOUND)
    await this.deps.runService.resolveApproval({ sessionId, ownerId: session.ownerId, username: user.username, escalationId, decision, reason })
  }

  // ---- RunService recordTurn 注入缝（生产实现）：终态聚合落 assistant 行（含终态 checkpoint
  // 锚点 anchorCheckpointId——issue 点名列；aborted/failed 路径 null）+ 自动标题（story 5）。
  // attachmentsJson 走 serializeAttachments（唯一序列化实现——单一来源），字段序稳定
  //（回放零差异断言的前提）。----
  async recordTurn(p: RecordTurnPayload): Promise<void> {
    await insertWithNextTurn(this.deps.prisma, p.sessionId, {
      role: 'assistant',
      content: p.aggregate.content,
      anchorCheckpointId: p.anchorCheckpointId,
      attachmentsJson: serializeAttachments(p.aggregate),
    })
    await this.autoTitle(p.sessionId)
    const child = await this.deps.prisma.teammate.findUnique({ where: { threadId: p.sessionId }, select: { parentSessionId: true } })
    const parent = await this.deps.prisma.session.findUnique({ where: { id: child?.parentSessionId ?? p.sessionId }, select: { ownerId: true } })
    if (parent) this.publishSessionEvent(parent.ownerId, 'session.updated', { projectionChanged: true }, child?.parentSessionId ?? p.sessionId)
  }

  // 自动标题（story 5）：首个 run 终态时 title 仍空 → 首条 user 消息截断派生 + session.updated。
  private async autoTitle(sessionId: string): Promise<void> {
    const session = await this.deps.prisma.session.findUnique({
      where: { id: sessionId },
      select: { title: true, ownerId: true },
    })
    if (!session || session.title !== '') return
    const firstUser = await this.deps.prisma.sessionMessage.findFirst({
      where: { sessionId, role: 'user' },
      orderBy: { turn: 'asc' },
      select: { content: true },
    })
    if (!firstUser?.content) return
    const title = firstUser.content.slice(0, TITLE_AUTO_MAX)
    const fresh = await this.deps.prisma.session.update({ where: { id: sessionId }, data: { title } })
    this.publishSessionEvent(session.ownerId, 'session.updated', { session: summary(fresh) }, sessionId)
  }

  // ---- rewind（story 16 · #770 三操作模型 + #782 三态）：换 activeCheckpointId 指针重开 +
  // 被放弃路线软删存档（checkpoint/journal/消息行 archivedAt——行不物理删，产品面不可读无恢复
  // 入口，「比较路线」= fork 并存多开）。锚点以消息行表达（产品面选历史消息），解析 + 挂靠判定
  // 在纯逻辑（./rewind）。完成后 session.invalidated{reason:rewind} 广播（多端重拉投影）。
  //
  // 三态（#747 UX · scope）：all（缺省）= 对话面 + 文件逆放（file_journal 全局序逆放恢复 /lab
  // 至锚点时刻，含 anchor 后用户上传一并回退；exec 显式降级不入账）；chat = 只回对话（文件保持
  // 现状永久化——水位推进至当前 max(seq)，行不再拾起）；files = 只回文件（journal 归档 + 逆放，
  // 对话面零改动、指针不动）。teammate 面：跨派生点作废（#781 缺口顺带接线）+ 存活者信箱通知
  //（scope≠chat——C1）。----
  async rewindSession(
    user: Pick<AuthUser, 'id' | 'role'>,
    sessionId: string,
    p: { messageId: string; scope?: RewindScope },
  ): Promise<RewindResult> {
    const scope: RewindScope = p.scope ?? 'all'
    const session = await getSessionForUser(this.deps.prisma, user, sessionId)
    this.requireTerminal(sessionId)

    // 会话级互斥（双端并发 rewind 面）：「锚点校验→归档事务→逆放」整段 FIFO 串行化——两端
    // 各持视图交错会写悬空指针（锚已被先行 rewind 归档仍被写为 activeCheckpointId）+ chain
    // 截断过度逆放。锁内重跑 anchorForRewind：被先行 rewind 归档的锚点同拒 90002。
    // fileRewind 未注 runRewindExclusive（旧装配面）= 无锁直跑（单端语义不变）。
    const run = async (): Promise<RewindResult> => {
      // 锁内重验 run 终态（排队等锁期间新 run 可插入——sendMessage 门禁放行、checkpoint 随
      // 执行落账；获锁后归档其中间 checkpoint = 误撤在飞 run 面）。锁外首验为便宜拒绝。
      this.requireTerminal(sessionId)
      const rows = await this.listHistoryRows(sessionId)
      const { anchor, parentOf } = await this.anchorForRewind(sessionId, rows, p.messageId)
      const anchorChain = ancestorChainOf((id) => parentOf.get(id) ?? null, anchor)

      // 被放弃 checkpoint（未归档全体 − 锚点链）——共享前缀（锚点之前）一律不打标记。
      const abandoned = abandonedCheckpointIds([...parentOf.keys()], anchorChain)
      const now = new Date()

      if (scope === 'files') {
        // 只回文件：journal 行归档（投影/继承面）+ 逆放；checkpoint/消息行与指针零改动
        if (abandoned.size > 0) {
          await this.deps.prisma.fileJournal.updateMany({
            where: { sessionId, checkpointId: { in: [...abandoned] } },
            data: { archivedAt: now },
          })
        }
      } else {
        const maxSeq = await this.deps.prisma.fileJournal.findFirst({
          where: { sessionId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        })
        const writes: PrismaPromise<unknown>[] = [
          ...(abandoned.size > 0
            ? [
                this.deps.prisma.checkpoint.updateMany({
                  where: { threadId: sessionId, checkpointId: { in: [...abandoned] } },
                  data: { archivedAt: now },
                }),
                this.deps.prisma.fileJournal.updateMany({
                  where: { sessionId, checkpointId: { in: [...abandoned] } },
                  data: { archivedAt: now },
                }),
              ]
            : []),
          ...this.archiveRowWrites(sessionId, rows, anchorChain, now),
          this.deps.prisma.session.update({
            where: { id: sessionId },
            data: {
              activeCheckpointId: anchor,
              // scope=chat：文件保持现状永久化——水位推进至当前 max(seq)（行不逆放不再拾起）
              ...(scope === 'chat' ? { fileJournalAnchorSeq: maxSeq?.seq ?? 0 } : {}),
            },
          }),
        ]
        await this.deps.prisma.$transaction(writes)
      }

      // teammate 作废面 + 文件逆放（对话面事务已提交——事实已发生）：异常终态补偿统一在此
      // try 内（作废失败 survivor 未停跑继续 running，无补偿则重试撞 50005 收敛卡死）——事件
      // 与 C1 通知照发（degraded 语义如实）后重抛，REST 错误信封驱动重试，残行由重试/boot
      // 续放收敛。已持互斥锁时走 rewindFilesCore 直呼（外层 rewindFiles 重入 fence 即死锁）
      let files: RewindResult['files']
      const fileRewind = this.deps.fileRewind
      try {
        await this.deps.runService.teammatesForRewind?.(sessionId, anchor)
        if (scope !== 'chat' && fileRewind) {
          const owner = await this.deps.prisma.user.findUnique({
            where: { id: session.ownerId },
            select: { username: true },
          })
          const rewindInput = {
            sessionId,
            anchor,
            userId: session.ownerId,
            username: owner?.username ?? '',
          }
          files = await (fileRewind.runRewindExclusive !== undefined
            ? fileRewind.rewindFilesCore(rewindInput)
            : fileRewind.rewindFiles(rewindInput))
        }
      } catch (err) {
        this.publishSessionEvent(session.ownerId, 'session.invalidated', { reason: 'rewind' }, sessionId)
        try {
          await this.deps.runService.teammatesNotifyFileRewind?.(sessionId, anchor, true)
        } catch (notifyErr) {
          // 通知失败不吞原始错误（REST 归因保真）——warn 留痕
          // eslint-disable-next-line no-console
          console.warn(`[sessions] rewind 补偿通知失败: session=${sessionId}: ${String(notifyErr)}`)
        }
        throw err
      }
      // C1 通知面（逆放完成后——文案「已逆放恢复」在事实之后）；degraded（容器缺失/深度
      // 超限——/lab 未动）如实报「回退未完成」；机制未接线（fileRewind 缺省）= 文件未动，
      // 同 degraded 语义
      if (scope !== 'chat') {
        await this.deps.runService.teammatesNotifyFileRewind?.(sessionId, anchor, files?.degraded ?? true)
      }

      this.publishSessionEvent(session.ownerId, 'session.invalidated', { reason: 'rewind' }, sessionId)
      // scope=files 返回指针锁内重读（并发串行化后锁外快照可能已被先行 rewind 归档失效）
      const currentPointer =
        scope === 'files'
          ? (
              await this.deps.prisma.session.findUniqueOrThrow({
                where: { id: sessionId },
                select: { activeCheckpointId: true },
              })
            ).activeCheckpointId
          : null
      return {
        sessionId,
        activeCheckpointId: scope === 'files' ? currentPointer : anchor,
        scope,
        ...(files !== undefined ? { files } : {}),
      }
    }

    return this.deps.fileRewind?.runRewindExclusive !== undefined
      ? await this.deps.fileRewind.runRewindExclusive(sessionId, run)
      : await run()
  }

  // 锚点解析（rewind/preview 共用——同码同判定）：resolveRewindAnchor + checkpoint 存在性
  // 兜底（归档 checkpoint 不可作锚点——#770 无恢复入口；「行未归档但 checkpoint 已归档」
  // 机制性不一致态两入口同拒，preview 判定 ≡ 执行判定）。fork 切点文案不同不复用。
  private async anchorForRewind(
    sessionId: string,
    rows: Parameters<typeof resolveRewindAnchor>[0],
    messageId: string,
  ): Promise<{ anchor: string; parentOf: Map<string, string | null> }> {
    const anchor = resolveRewindAnchor(rows, messageId)
    if (anchor === null) {
      throw fail(CODE.VALIDATION_FAILED, '该消息不可作为回退锚点（无更早的可回退 state）')
    }
    const parentOf = await this.checkpointParentLookup(sessionId)
    if (!parentOf.has(anchor)) {
      throw fail(CODE.VALIDATION_FAILED, '锚点 checkpoint 缺失或已归档')
    }
    return { anchor, parentOf }
  }

  // rewind 预览（#782 · D8）：逆放集摘要 + exec 跨越清单（复用轨迹聚合，零新增存储）。
  // 只读不写——产品面确认门（恢复菜单）的输入。
  async rewindPreview(
    user: Pick<AuthUser, 'id' | 'role' | 'username'>,
    sessionId: string,
    p: { messageId: string },
  ): Promise<{ anchor: string } & FileRewindPreview> {
    await getSessionForUser(this.deps.prisma, user, sessionId) // 归属校验（50002 同码防探测）
    this.requireTerminal(sessionId) // 与执行面同门禁——执行不可达（50005）时预览不预告可行
    const rows = await this.listHistoryRows(sessionId)
    const { anchor } = await this.anchorForRewind(sessionId, rows, p.messageId)
    return this.deps.fileRewind
      ? await this.deps.fileRewind.preview({
          sessionId,
          anchor,
          caller: { userId: user.id, username: user.username },
        })
      : // 机制未接线（fileRewind 缺省）——空预览本地构造（跨域运行时 import 走注入缝纪律）
        { anchor, revertOps: 0, pathSample: [], pathTotal: 0, execCrossed: [] }
  }

  // ---- fork（story 18/20 · #768 D7 修订）：唯一复制原语。新 Session 行（parentSessionKey +
  // forkSourceJson 溯源）+ checkpoint 祖先链行复制（blob 自包含，新 thread 直读——「切点 state
  // 起步」的机制面，保锚点引用有效）+ 消息行挂靠截断复制 + 沙箱整容器字面复制（docker
  // export→import，含墓碑目录；源已删 → 空起步 + 系统消息）+ file_journal 切点截断继承
  //（seq 保留原值接续）+ attachments 行全量复制（#768 D7 字面；attachmentId 不改，messageId
  // 挂靠复制行映射新 id、其余置 null——跨会话 FK 级联删除面）。
  // teammate（#786 定案）：不跟随——teammate 行按 parentSessionId 挂源会话（新 id 天然无
  // teammate），源会话 teammate 原样不动；fork 是对话状态探索，teammate 属于源会话执行上下文。
  // 顺序：session 行先落（拿 id）→ 沙箱复制（Docker 成功才落数据行）→ 数据复制事务（含系统
  // 消息）；任一步失败补偿删 session 行（cascade 清子行）+ 删沙箱尽力——fork 可整体重试。
  async forkSession(
    user: Pick<AuthUser, 'id' | 'role'>,
    sessionId: string,
    p: { messageId?: string; title?: string },
  ): Promise<{ session: SessionSummary }> {
    const session = await getSessionForUser(this.deps.prisma, user, sessionId)
    this.requireTerminal(sessionId)

    // 切点解析：缺省 = 当前活跃头（指针或最新锚点；皆无 = 空会话 fork，纯新会话 + 沙箱复制）
    const rows = await this.listHistoryRows(sessionId)
    let anchor: string | null
    if (p.messageId !== undefined) {
      anchor = resolveRewindAnchor(rows, p.messageId)
      if (anchor === null) {
        throw fail(CODE.VALIDATION_FAILED, '该消息不可作为 fork 切点（无更早的可回退 state）')
      }
    } else {
      anchor = session.activeCheckpointId ?? this.latestAnchoredId(rows)
    }
    // 切点有效性前置校验（R 评审）：归档 checkpoint 不可作切点——否则新会话指针悬空、
    // checkpoint 零复制。校验先于 session 行落库（失败零残留）。
    if (anchor !== null) {
      const cp = await this.deps.prisma.checkpoint.findFirst({
        where: { threadId: sessionId, checkpointId: anchor, archivedAt: null },
        select: { checkpointId: true },
      })
      if (!cp) throw fail(CODE.VALIDATION_FAILED, '切点 checkpoint 缺失或已归档')
    }

    // 新 session 行先行（containerId 预言名两跳，同 createSession）
    const fresh = await this.deps.prisma.$transaction(async (tx) => {
      const created = await tx.session.create({
        data: {
          ownerId: session.ownerId,
          containerId: '',
          title: p.title ?? (session.title !== '' ? `${session.title} (fork)`.slice(0, TITLE_MAX) : ''),
          parentSessionKey: session.id,
          forkSourceJson: JSON.stringify({
            sourceSessionId: session.id,
            ...(anchor !== null ? { sourceCheckpointId: anchor } : {}),
            sourceMessageId: p.messageId ?? null,
            forkedAt: new Date().toISOString(),
          }),
          ...(anchor !== null ? { activeCheckpointId: anchor } : {}),
        },
      })
      return tx.session.update({
        where: { id: created.id },
        data: { containerId: `${SANDBOX_CONTAINER_PREFIX}${created.id}` },
      })
    })

    // 沙箱字面复制先行（Docker 成功才落数据行；失败走补偿，fork 可整体重试）。Docker 层错误
    // 包 INTERNAL 信封（R 评审：不漏裸错误出路由）；已是信封错误（理论上不存在）原样放行。
    let sandboxOutcome: 'copied' | 'source-missing' = 'source-missing'
    try {
      sandboxOutcome = await this.deps.sandboxes?.fork(session.id, fresh.id) ?? 'source-missing'
    } catch (e) {
      await this.compensateFork(fresh.id)
      if (e instanceof EnvelopeError) throw e
      // eslint-disable-next-line no-console
      console.warn(`[sessions] fork 沙箱复制失败: source=${session.id} target=${fresh.id}: ${(e as Error).message}`)
      throw fail(CODE.INTERNAL, 'fork 沙箱复制失败，请稍后重试')
    }

    // 数据复制事务（#770 截断口径：checkpoint = 锚点祖先链、消息 = 挂靠可见行、journal =
    // checkpointId ∈ 祖先链；attachments 全量 [FK 交集]）
    try {
      await this.copyForkData(session, fresh.id, anchor, sandboxOutcome === 'source-missing')
    } catch (e) {
      await this.compensateFork(fresh.id)
      if (e instanceof EnvelopeError) throw e
      // eslint-disable-next-line no-console
      console.warn(`[sessions] fork 数据复制失败: source=${session.id} target=${fresh.id}: ${(e as Error).message}`)
      throw fail(CODE.INTERNAL, 'fork 数据复制失败，已回滚')
    }

    this.publishSessionEvent(
      session.ownerId,
      'session.created',
      { source: 'fork', session: summary(fresh) },
      fresh.id,
    )
    return { session: summary(fresh) }
  }

  // fork 补偿：删 session 行（cascade 清已复制子行）+ 删沙箱尽力（Docker 失败不掩盖原始错误）
  private async compensateFork(forkedSessionId: string): Promise<void> {
    await this.deps.prisma.session.delete({ where: { id: forkedSessionId } }).catch(() => {})
    await this.deps.sandboxes?.remove(forkedSessionId).catch(() => {})
  }

  // fork 数据复制（单事务）：checkpoint 祖先链 + checkpoint_writes + 消息行 + attachments +
  // file_journal + 系统消息（源沙箱缺失时）。行面输入在事务外一次性读取（事务内不混用非 tx
  // client 读——R 评审）。切点链缺失（理论上已由前置校验挡下）→ 抛错整滚，绝不落「指针悬空」
  // 的半成品 fork。
  private async copyForkData(
    source: Session,
    forkedSessionId: string,
    anchor: string | null,
    sourceSandboxMissing: boolean,
  ): Promise<void> {
    const rows = anchor !== null ? await this.listHistoryRows(source.id) : []
    await this.deps.prisma.$transaction(async (tx) => {
      // 复制消息行 id 映射（源 id → 新 id）：attachments.messageId 挂靠改指用。
      const messageIdMap = new Map<string, string>()
      if (anchor !== null) {
        const checkpoints = await tx.checkpoint.findMany({
          where: { threadId: source.id, archivedAt: null },
        })
        const parentOf = new Map(checkpoints.map((c) => [c.checkpointId, c.parentCheckpointId]))
        const chain = ancestorChainOf((id) => parentOf.get(id) ?? null, anchor)
        const chainRows = checkpoints.filter((c) => chain.has(c.checkpointId))
        const chainIds = [...chain]
        if (chainRows.length === 0) {
          throw fail(CODE.VALIDATION_FAILED, '切点 checkpoint 链缺失（机制数据不一致）')
        }
        await tx.checkpoint.createMany({
          data: chainRows.map((c) => ({ ...c, threadId: forkedSessionId })),
        })
        const writes = await tx.checkpointWrite.findMany({
          where: { threadId: source.id, checkpointId: { in: chainIds } },
        })
        if (writes.length > 0) {
          await tx.checkpointWrite.createMany({
            data: writes.map((w) => ({ ...w, threadId: forkedSessionId })),
          })
        }
        const journals = await tx.fileJournal.findMany({
          where: { sessionId: source.id, archivedAt: null, checkpointId: { in: chainIds } },
        })
        if (journals.length > 0) {
          // seq 保留原值（新会话内唯一 ✓），后续写入从 max(seq)+1 接续（写入面归 #782）
          await tx.fileJournal.createMany({
            data: journals.map((j) => ({
              id: randomUUID(),
              sessionId: forkedSessionId,
              checkpointId: j.checkpointId,
              seq: j.seq,
              op: j.op,
              path: j.path,
              beforeSha256: j.beforeSha256,
              afterSha256: j.afterSha256,
              tombstoneKey: j.tombstoneKey,
              toolCallId: j.toolCallId,
              applied: j.applied,
            })),
          })
        }

        // 消息行挂靠截断复制：turn/createdAt/clientKey 原样，id 新生成（全局主键，复制体是
        // 独立行）——attachments.messageId 随映射改指新行。
        const visible = visibleRowIds(rows, chain)
        const rowsToCopy = await tx.sessionMessage.findMany({
          where: { sessionId: source.id, id: { in: [...visible] } },
        })
        if (rowsToCopy.length > 0) {
          for (const r of rowsToCopy) messageIdMap.set(r.id, randomUUID())
          await tx.sessionMessage.createMany({
            data: rowsToCopy.map((r) => ({
              id: messageIdMap.get(r.id)!,
              sessionId: forkedSessionId,
              turn: r.turn,
              role: r.role,
              content: r.content,
              clientKey: r.clientKey,
              attachmentsJson: r.attachmentsJson,
              anchorCheckpointId: r.anchorCheckpointId,
              createdAt: r.createdAt,
            })),
          })
        }
      }

      // attachments 全量复制（#768 D7 定案「attachments 行全量复制」，R2 评审回归字面）：
      // attachmentId 不改（PK (sessionId,id) 复合 → 会话内唯一；下载面按 id + owner 过滤，
      // 多行同 id 语义安全）；messageId 挂靠复制行 → 映射新 id（FK 同会话），挂切点后消息/
      // 无主行 → 置 null——message FK onDelete: Cascade，跨会话保留原值会让本行随源会话
      // 删除被级联清掉（静默丢数据）。路径在沙箱 /lab/uploads/——字面复制后继续有效。
      const attachments = await tx.attachment.findMany({ where: { sessionId: source.id } })
      if (attachments.length > 0) {
        await tx.attachment.createMany({
          data: attachments.map((a) => ({
            sessionId: forkedSessionId,
            id: a.id,
            ownerId: a.ownerId,
            messageId:
              a.messageId !== null && messageIdMap.has(a.messageId) ? messageIdMap.get(a.messageId)! : null,
            fileName: a.fileName,
            mimeType: a.mimeType,
            size: a.size,
            sha256: a.sha256,
            path: a.path,
          })),
        })
      }

      // 源沙箱已删 → 空起步 + 系统消息（#768 D7「源已删则空起步+系统消息」）
      if (sourceSandboxMissing) {
        const last = await tx.sessionMessage.findFirst({
          where: { sessionId: forkedSessionId },
          orderBy: { turn: 'desc' },
          select: { turn: true },
        })
        await tx.sessionMessage.create({
          data: {
            sessionId: forkedSessionId,
            turn: (last?.turn ?? 0) + 1,
            role: 'system',
            content: '源会话的沙箱不存在，新会话从空白文件环境开始。',
          },
        })
      }
    })
  }

  // 活跃行读取（rewind/fork/残留清理共用投影判定输入）：只取未归档行——归档行产品面不可读、
  // 不可作锚点/切点（#770 无恢复入口；R 评审：连续/向前 rewind 到被放弃分支须 90002 而非
  // 把指针指进归档区）。挂靠判定在未归档集内自洽（归档行不再参与可见性传播）。
  private async listHistoryRows(sessionId: string): Promise<HistoryRowLite[]> {
    const rows = await this.deps.prisma.sessionMessage.findMany({
      where: { sessionId, archivedAt: null },
      orderBy: [{ turn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, turn: true, role: true, anchorCheckpointId: true, createdAt: true },
    })
    return rows
  }

  // thread 的未归档 checkpointId → parentCheckpointId 查找表（rewind/fork/残留清理共用）：
  // 链行走只在活跃（未归档）图上进行——归档行不参与祖先链（被放弃分叉不复活）。
  private async checkpointParentLookup(sessionId: string): Promise<Map<string, string | null>> {
    return loadCheckpointParentOf(this.deps.prisma, sessionId)
  }

  // 活跃行里最新带锚 assistant 锚点（fork 缺省切点解析面；无 → null）
  private latestAnchoredId(rows: readonly HistoryRowLite[]): string | null {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!
      if (r.role === 'assistant' && r.anchorCheckpointId !== null) return r.anchorCheckpointId
    }
    return null
  }

  // 锚点链之外的活跃行归档写操作（rewind 与 sendMessage 残留清理共用）
  private archiveRowWrites(
    sessionId: string,
    rows: readonly HistoryRowLite[],
    anchorChain: ReadonlySet<string>,
    now: Date,
  ): PrismaPromise<unknown>[] {
    const visible = visibleRowIds(rows, anchorChain)
    if (visible.size === rows.length) return []
    const stale = rows.filter((r) => !visible.has(r.id)).map((r) => r.id)
    return [
      this.deps.prisma.sessionMessage.updateMany({
        where: { sessionId, id: { in: stale } },
        data: { archivedAt: now },
      }),
    ]
  }

  // sendMessage 残留清理（rewind 态专属，R 评审重写）：指针在函数内重读（入口快照可能落后于
  // 上一轮 completed 的指针推进——按旧链归档会误伤刚完成的成功轮）；参照链取「指针 ∪ 行面最新
  // 锚点」中的较新者（recordTurn 已落行、指针推进未至的窗口内以行面锚为准，同步消除误伤）。
  // 未 rewind 会话（指针 null）不清理——全量历史保留（回放零差异）。只清消息行不扫 checkpoint：
  // 失败轮超步残留（checkpoint 面）由下一次 rewind 的差集归档收口（sendMessage 时点在 completed
  // 观测窗口内扫 checkpoint 会误伤刚完成轮的落盘行，故不扫——残留只影响缺省寻址的「最新」，而
  // 新轮 checkpoint 恒更新）。
  private async archiveRowsOffAnchor(sessionId: string): Promise<void> {
    const current = await this.deps.prisma.session.findUnique({
      where: { id: sessionId },
      select: { activeCheckpointId: true },
    })
    const pointer = current?.activeCheckpointId ?? null
    if (pointer === null) return
    const [rows, parentOf] = await Promise.all([
      this.listHistoryRows(sessionId),
      this.checkpointParentLookup(sessionId),
    ])
    const parentOfFn = (id: string) => parentOf.get(id) ?? null
    const rowHead = this.latestAnchoredId(rows)
    const ref =
      rowHead !== null && rowHead !== pointer && ancestorChainOf(parentOfFn, rowHead).has(pointer)
        ? rowHead
        : pointer
    const writes = this.archiveRowWrites(sessionId, rows, ancestorChainOf(parentOfFn, ref), new Date())
    if (writes.length > 0) await this.deps.prisma.$transaction(writes)
  }

  private publishSessionEvent(
    userId: string,
    type: 'session.created' | 'session.updated' | 'session.invalidated',
    payload: Record<string, unknown>,
    sessionId: string,
  ): void {
    this.deps.hub.publish(userId, { type, sessionId, payload })
  }
}
