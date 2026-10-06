import { createServer } from 'node:http'
import path from 'node:path'
import { createApp } from './app'
import { getPrisma } from './prisma'
import { bootstrap } from './auth/bootstrap'
import { config } from './config'
import { assembleFleet } from './containers/fleetAssembly'
import { assembleSandboxes } from './sandboxes/assembly'
import { assembleWikiContainers } from './wikiContainers/assembly'
import { assembleAutoFigureRuntime } from './figures/assembly'
import { assembleTunnelServer } from './chat/tunnelAssembly'
import { assembleRunner } from './runner/assembly'
import { WikiUpdateRunService } from './wiki/updateRun'
import { StreamHub } from './events/hub'
import { SessionService } from './sessions/service'
import { AttachmentsService } from './attachments/service'
import { ATTACHMENT_TMP_DIR } from './attachments/values'
import './types'
import { PLUGIN_MANIFESTS } from '../../plugins/index'

async function main(): Promise<void> {
  const prisma = getPrisma()
  await bootstrap(prisma) // B1 惰性首启（空表生成 admin）
  // SSE 事件扇出注册表（#773，#747 C 节）：单进程单例，REST 路由与（后续票的）runner
  // 事件桥共享；logout/吊销终止经它广播 session.terminated。
  const eventHub = new StreamHub()
  // 容器编排（#334 M2）：真 DockerRuntime + BullMQ(Redis) 队列 + worker 并发默认 2。
  const fleet = assembleFleet(prisma)
  // 会话沙箱生命周期（#776 · story 58/59）：惰性创建/闲置 30min 回收/级联删 Port +
  // 周期 sweeper（真正消费方 = #777 runner ensure/touch 与 #778 会话 REST 删 session 级联）。
  const sandboxes = assembleSandboxes()
  // wiki 容器生命周期（#784 · #747 E 节 wiki 列）：每用户一台、永久、零出网文件仓库。
  // ensure 消费方 = wiki 域 REST（每操作前置）与 runner（run 前）；remove = 用户级联删/T0
  // 清理面（用户删除端点未落地）；永久容器无闲置 sweeper。
  const wikiContainers = assembleWikiContainers()
  // AutoFigure 生成运行时（T07）：config → 生产 HTTP adapter（私有 sidecar）→ T03 runner。
  // flag 关 → null（不构造 adapter、不启动 pump；面板启动/health 独立于 sidecar）。enabled →
  // 构造 adapter + 启动 runner pump（queue 由 T03 runner 内部创建）。handle 供优雅关闭 await。
  // T04 超时（config.autofigure.jobTimeoutMs）在此显式传入——T07 不引入 adapter-local timeout。
  const autofigure = assembleAutoFigureRuntime({
    enabled: config.autofigure.enabled,
    prisma,
    sidecarUrl: config.autofigure.sidecarUrl,
    llmKey: config.autofigure.llmKey,
    jobTimeoutMs: config.autofigure.jobTimeoutMs,
  })
  // 集中式 runner（#777 · #747 A 节）：RunService + BullMQ worker。事件经 eventHub 扇出
  //（run 域事件目录）；REST 入队面归 #778 会话域（本装配 = 进程内就绪）。BullMQ 连接 lazy
  //（Redis 不可达不挂控制面，add 超时兜底在队列层——fleet 队列先例同形态）。
  // #780 附件域服务：上传（控制面临时区 <fleetRoot>/attachments，REST 不直写沙箱）+ 下载（沙箱
  // readLabBytes 字节通道，files 域 fleet.archive 复用）+ run 首步 ingestion（片 2，runner 注入）。
  // 临时区须在 multer destination 前存在（createAttachmentsRouter 工厂期 mkdirSync 兜底）。
  const attachmentTmpRoot = path.join(config.fleet.root, ATTACHMENT_TMP_DIR)
  const attachmentsService = new AttachmentsService({
    prisma,
    tmpRoot: attachmentTmpRoot,
    archive: fleet.archive,
  })
  const runner = await assembleRunner({
    prisma,
    hub: eventHub,
    redisUrl: config.redisUrl,
    maxConcurrentRuns: config.runner.maxConcurrentRuns,
    recursionLimit: config.runner.recursionLimit,
    // #776 契约接线：runner = 沙箱 ensure/touch 的真 activity 源（run 前 ensure——闲置 stop
    // 后 re-ensure；事件流 touch——长 run 不被闲置 sweep stop）。
    sandboxes: {
      ensure: (id) => sandboxes.lifecycle.ensure(id),
      touch: (id) => sandboxes.lifecycle.touch(id),
    },
    // #784 契约接线：runner run 前 ensure 用户 wiki 容器（/wiki/ 工具根就绪——沙箱 ensure
    // 同款接缝；/wiki 惰性创建 + stopped 复启，永久容器无 touch 面）。
    wikis: {
      ensure: async (ownerId) => {
        await wikiContainers.lifecycle.ensure(ownerId)
      },
    },
    // #780 附件 ingestion（片 2）：run 首步物化附件到沙箱 + 图片内联多模态。
    attachments: attachmentsService,
    // #782 文件 rewind：rewindFiles 前置沙箱 ensure（stopped 复启/惰性创建——run 前同语义）。
    ensureSandbox: (id) => sandboxes.lifecycle.ensure(id),
  })
  // 插件域 REST（#788）：编译期目录 + per-user 启用位（8xxxx 段）。
  const pluginsRouter = { prisma, manifests: PLUGIN_MANIFESTS }
  // 会话域（#778 · #747 C 节会话 REST 全件）：SessionService（门禁观测/配额预检/命令构造复用
  // runner.service；dispatch = BullMQ submit 透传——ack 失败由 SessionService 回滚/上报，
  // 执行体错误走 run 域事件面与 #779 补偿）+ recordTurn 注入缝回接 runner（session_messages
  // 落库 + 自动标题；构造顺序晚于 RunService 故走 setter）。
  const sessions = new SessionService({
    prisma,
    hub: eventHub,
    runService: runner.service,
    dispatch: (cmd) => runner.queue.submit(cmd),
    plugins: runner.plugins,
    sandboxes: {
      remove: (id) => sandboxes.lifecycle.remove(id),
      // #781 fork 字面复制（#768 D7）：源容器 export→import（源缺 → 'source-missing' 空起步）
      fork: (source, target) => sandboxes.lifecycle.forkSandbox(source, target),
    },
    // #780 附件链接（≤4 件 + 归属/session 校验）——上传/下载走独立 AttachmentsService
    attachments: attachmentsService,
    // #782 文件 rewind（D8）：逆放 + 预览 + 会话级互斥（FileJournalService 结构面）
    fileRewind: {
      rewindFiles: (p) => runner.fileJournal.rewindFiles(p),
      rewindFilesCore: (p) => runner.fileJournal.rewindFilesCore(p),
      runRewindExclusive: (sessionId, fn) => runner.fileJournal.runRewindExclusive(sessionId, fn),
      preview: (p) => runner.fileJournal.preview(p),
    },
  })
  runner.service.setRecordTurn((p) => sessions.recordTurn(p))
  // wiki 全量更新独立 run（#790 · 三通道③）：复用 runner 装配的 registry/primitives（#731
  // 单出口纪律）+ 事件经同一 StreamHub 扇出 wiki_run.* 五类事件；全局串行锁/在飞互斥在服务内。
  const wikiUpdateRuns = new WikiUpdateRunService({
    registry: runner.registry,
    primitives: runner.primitives,
    hub: eventHub,
  })
  // #782 启动 reconcile（roll-forward + 续放）：异步不挂启动；单 session 故障 Reconciler
  // 内部 warn 不中断全批，容器缺失 session 跳过（rewindFiles 前置 restore 路兜底）；摘要
  // 计数上行（观测面——静默不可接受）。
  void runner.fileJournal
    .reconcileOnBoot()
    .then((outcomes) => {
      if (outcomes.size === 0) return
      const missing = [...outcomes.values()].filter((o) => o.containerMissing).length
      // eslint-disable-next-line no-console
      console.warn(`[filejournal] boot reconcile: sessions=${outcomes.size} containerMissing=${missing}`)
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[filejournal] boot reconcile crashed: ${String(err)}`)
    })
  const app = createApp({
    prisma,
    orchestrator: fleet.orchestrator,
    // approve 端点 docker exec 通道（#374）：容器内 `openclaw devices approve <requestId>`。
    runtime: fleet.runtime,
    // wiki（#335 → #784 换轨）：存储面 = 新 wiki 容器（ensure 经 wikiContainers 注入）；
    // compile 触发不注入（busybox 级容器无 openclaw 运行时，索引归 OpenWiki 工具形态 #737，
    // routes 缺省 noop）。#790：全量更新独立 run 触发面（POST /wiki/update）注入。
    wiki: {
      wikiContainers: {
        ensure: async (ownerId) => {
          await wikiContainers.lifecycle.ensure(ownerId)
        },
      },
      updateRunner: {
        start: async (params) => wikiUpdateRuns.start(params),
      },
    },
    // models（#336；#775 写盘链退役）：事务 = DB mutation + config_meta version bump（热生效
    // 信号），不再 putArchive 重渲染 openclaw.json——TemplateModelConfigWriter 装配退役
    //（configWriter/configBuilder 两文件留待 T0 清退 #801）；models/providerEndpoints 路由
    // 无条件挂载，装配层无注入。
    // files（#589 · ADR 0012）：统一文件 CRUD 经 Docker getArchive/putArchive/exec rm。
    files: { archive: fleet.archive },
    // figures（AutoFigure T01）：flag 开才装配（config.autofigure.enabled）——flag 关不注入 →
    // 路由未挂载（/api/v1/figures → 90005）。FiguresRouterDeps 为空（路由只依赖 req.prisma +
    // 认证身份），装配形态 `{}` 表达「已启用」。生成 runner（T03）与生产 HTTP adapter（T07）的
    // 接线不走 app deps——见下方 assembleAutoFigureRuntime（config → adapter → T03 runner 启动）。
    figures: config.autofigure.enabled ? {} : undefined,
    // docs（#761）：flag 开才装配（config.apiDocs.enabled）——flag 关不注入 → 路由未挂载
    //（/api/docs → 90005）。DocsRouterDeps 为空（文档启动期静态构建，路由只依赖认证身份），
    // 装配形态 `{}` 表达「已启用」（对齐 figures 装配注释先例）。
    docs: config.apiDocs.enabled ? {} : undefined,
    // events（#773）：SSE 事件流（/api/v1/events）。StreamHub 单例注入；
    // 心跳 20s 用缺省（HEARTBEAT_MS，路由层唯一默认值声明处）。
    events: { hub: eventHub },
    // sessions（#778）：会话 REST 域（/api/v1/sessions）。SessionService 单例注入。
    sessions: { service: sessions },
    // attachments（#780）：上传/下载 REST（挂 /api/v1）。AttachmentsService 单例注入。
    attachments: { service: attachmentsService, tmpRoot: attachmentTmpRoot },
    // plugins（#788）：目录 + 启用位（/api/v1/plugins，8xxxx 段）。编译期目录注入。
    plugins: pluginsRouter,
  })

  // M0 同进程单端口分流：createServer(expressApp) + server.on('upgrade') 分流。
  // M5 隧道（#337 · ADR 0006）：/ws/chat/ 由隧道接管（JWT subprotocol 握手 + 归属门 + 原始帧透传
  // 到容器网关）；其余 upgrade 请求拒绝（避免裸挂导致悬空连接）。
  const tunnel = assembleTunnelServer({
    prisma,
    // #385：隧道连容器网关携带面板 origin（生产 PANEL_PUBLIC_ORIGIN；真网关 2026.7.1 校验
    // Origin 须在容器 allowedOrigins 内——该值同时由 ConfigRenderer 强制进容器 openclaw.json）。
    panelOrigin: config.fleet.panelOrigin,
    gatewayHost: config.fleet.healthHost,
    gatewayScheme: config.fleet.healthScheme,
  })
  const server = createServer(app)
  server.on('upgrade', (req, socket, head) => {
    if (!tunnel.handleUpgrade(req, socket, head)) socket.destroy()
  })

  // 优雅关闭：drain BullMQ worker（在飞 provisioning 完成或标 ERROR）；runner 队列 drain
  //（在飞 run 完成或 job failed——run 执行错误已在 RunService 消化为终态事件）；AutoFigure
  // runner（T07：停 pump + 等待在飞生成 settle——T03 close 语义，见 runner.ts）。
  const shutdown = async (): Promise<void> => {
    await fleet.close().catch(() => {})
    await sandboxes.close().catch(() => {})
    await wikiContainers.close().catch(() => {})
    await autofigure?.close().catch(() => {})
    await runner.close().catch(() => {})
    // 先终止活动隧道（http.Server.close 会等升级后的 WS 连接自然断开——有浏览器持隧道时挂起）
    tunnel.close()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] 控制面 listening on :${config.port}`)
  })
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[server] 启动失败', e)
  process.exit(1)
})
