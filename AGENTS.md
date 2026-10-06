# AGENTS.md

This file provides guidance to Qoder (qoder.com) / Claude Code when working with code in this repository.

## Project overview

**天津大学科研智能体平台**——多 OpenClaw 容器管理面板（产品显示名 #758 Q13 / #760；内部标识 researcher-service 系不动）。Vue3(TypeScript) 前端 + TS/Express 控制面，前后端分离。
控制面经 Docker SDK 直接增/删/查 OpenClaw 容器，每容器内跑一个 `main` agent；面板提供对话、
wiki 编辑、model 配置等管理能力。交接规格见 `docs/research/320`（wayfinder #308 汇编）。

> 旧 Django(DRF + Channels) 后端已退役（#341 M9 收尾），当前为 Express + ws 同进程控制面。

## Layout

```
server/     TS/Express 控制面（Express 5 + ws + Prisma 7 + SQLite + BullMQ/Redis + dockerode）
frontend/   Vue 3 + Vite + TypeScript + Pinia + Router + Element Plus
deploy/     编排契约：单容器 compose 模板 + openclaw.json（配置单一来源）+ 生产 compose
docs/       research/ + prototypes/ + adr/
```

## Commands

```bash
# ---- server（TS/Express 控制面）----
cd server
npm install
npm run prisma:generate                        # 生成 Prisma client（fresh checkout 必须）
npm run db:apply                               # 落表（better-sqlite3 直连 prisma/init.sql）
npm run dev                                    # tsx watch 宿主直跑（仅纯逻辑调试——摸不到 named volume；起服务/真编排走下方容器化 dev 栈）
npm run typecheck                              # tsc --noEmit
npm test                                       # vitest 全量（containers-smoke 需真 docker daemon）
npm run build                                  # tsc + prisma generate 产物拷贝

# ---- frontend（Vue3 + Vite）----
cd frontend
npm install
npm run dev                                    # Vite dev server（proxy /api、/ws → :8001，指向容器化 server）
npm run test                                   # vitest
npm run build                                  # vue-tsc 类型检查 + vite build

# ---- dev 控制面（容器化，与 prod 同形态；issue #594 / ADR 0013）----
# 起服务 / 真编排 OpenClaw 容器（named volume 拓扑）一律走此；纯逻辑迭代仍用上方宿主 npm test/typecheck。
docker compose -f deploy/docker-compose.dev.yml up -d --build   # server+redis，挂 docker.sock，server:8001
# 前置：researcher 克隆到仓库根（build context template=../researcher，或设 RESEARCHER_DIR）；
#       真编排另需派生镜像（构建须打成 Dockerfile FROM 基线版本 tag，命令见 deploy/README.md）
#       + export LLM_API_KEY。
```

## 架构总览

```
浏览器 (Vue3 + TS)
    │ HTTP/REST (JWT Bearer)        │ WebSocket (JWT subprotocol)
    ▼                               ▼
Express 控制面 (server/, localhost:8001)
    │ auth / users / containers / wiki / models / chat  (路由按域)
    │ 全局 #312 信封（HTTP 200 + {code,message,data}）+ jose HS256 认证
    ▼
Docker SDK 控制面 (containers)          网关隧道 (chat，浏览器直连网关)
    │ dockerode 挂 docker.sock             │ 隧道只做握手 4401 + 原始帧透传
    ▼                                     ▼
OpenClaw 容器 fleet (openclaw-gw-<name>，每容器独立 home/openclaw.json/宿主端口)
```

## server 模块边界（`server/src/`）

| 域 | 职责 | 关键模块 |
|-----|------|----------|
| `auth/` | 双角色账号 + JWT 签发/刷新（R1 旋转）+ bootstrap B1 + C1 强制改密 | `tokens.ts` `authenticate.ts` `bootstrap.ts` `userService.ts` |
| `containers/` | Docker SDK 编排（增/删/查容器、端口池、config 渲染、5 态机） | `orchestrator.ts` `dockerRuntime.ts` `ports.ts` `configRenderer.ts` `fleetAssembly.ts` |
| `wiki/` | wiki 树 + CRUD + graph（`WikiFileSystem` Port + 纯逻辑；#784 存储换轨 = 每用户 wiki 容器 `researcher-wiki-<ownerId>` 树根 `/wiki`，每操作前置 ensure，compile 触发退役归 OpenWiki 工具形态；#789 OKF 适配 = SKIP_FILES += log.md/INSTRUCTIONS.md、SKIP_DIRS += .claims、graph 派生加 markdown 相对链接边[复用 ghost，story 43]、claims 只读 API[页路径→.claims 镜像旁车 + pageVersion 漂移，story 42]、okf 徽章入页数据[status/stale_after/generated，story 41]、POST /wiki/update = #790 三通道③独立 run 触发面（updateRunner 注入缺省 90005；updateEvents 纯映射 wiki_run 五类[debug 丢弃/input ≤1k 截断]）） | `service.ts` `logic.ts` `nodeFs.ts` `compile.ts` `routes.ts` |
| `models/` | model provider CRUD（#775：行挂 ownerId；事务 = mutation + config_meta version bump 热生效；白名单第一层校验 origin 精确匹配 + DNS 私网拒绝 → 90002 字段级）+ 端点白名单 admin REST（`/api/v1/provider-endpoints`，731 §3.1）；写盘链（configWriter/configBuilder 两文件）已退役不再接线，物理删除留待 T0 #801 | `service.ts` `routes.ts` `endpoints.ts` `values.ts` |
| `chat/` | 网关隧道（JWT 握手 4401 + 原始帧透传，ADR 0006 浏览器直连） | `tunnelAssembly.ts` `subprotocol.ts` `values.ts` |
| `files/` | 统一文件 CRUD（root 契约 #776：wiki\|workspace(legacy 只读)\|lab；写面收敛 wiki；经 Docker getArchive/putArchive/exec rm，ADR 0012；lab 为沙箱只读 GET 面 readLab） | `fsPort.ts` `dockerArchive.ts` `paths.ts` `tar.ts` `routes.ts` |
| `events/` | SSE 事件流（#773，替代 WS 的传输面）：StreamHub per-user 扇出 + per-user 连续单调 serverSeq + 事件桥薄投影（LangChain streamEvents → 自有目录，不透传） | `hub.ts` `logic.ts` `routes.ts` `bridge.ts` `values.ts` |
| `sandboxes/` | 会话沙箱生命周期（#776 · story 58/59：1 session:1，容器名 `researcher-sandbox-<sessionId>`，对容器列表隐身）：惰性创建 ensure/闲置 30min 自动 stop（文件保留）/级联删（容器+独立 bridge 网络）；资源 limit Memory 4GB·4 核·PidsLimit 512 + MemorySwap=Memory 禁 swap（OOM 杀进程不杀容器的前提）；非 root(1000) + CapDrop ALL + no-new-privileges + RestartPolicy no；kind 标签三值 legacy\|wiki\|sandbox（#784 起完整分派，见 containers/kind.ts）；消费方 = #777 runner ensure/touch + #778 删 session 级联 + #781 fork 字面复制（`forkSandbox`：createSandboxFromSource 容器 export→import 整 FS，源已删空起步兜底） | `values.ts` `runtime.ts` `dockerRuntime.ts` `lifecycle.ts` `service.ts` `assembly.ts` |
| `wikiContainers/` | wiki 容器生命周期（#784 · E 节 wiki 列：每用户一台 `researcher-wiki-<userId>`、永久、零初始化零骨架、NetworkMode none 零出网、Memory 256MB/PidsLimit 128、非 root + CapDrop ALL + no-new-privileges、无具名卷——备份 = docker export 全树 tar，还原 = docker import 成镜像后重建；活性 = docker inspect Running 无探针无端口；对 fleet 列表隐身 kind=wiki + owner 标签；镜像 = deploy/wiki-image busybox 级 + WIKI_IMAGE 钉版） | `values.ts` `runtime.ts` `dockerRuntime.ts` `lifecycle.ts` `assembly.ts` |
| `runner/` | LangGraph 运行时侧（#747 换轨；backend/ = DockerArchiveBackend——deepagents BackendProtocolV2 本地镜像 → 双根 /wiki/+/lab/ Docker 原语映射，S2 接缝 Port 注入可 fake，协议同形镜像不引 deepagents 依赖；persistence/ = #774 持久化双件——PrismaCheckpointSaver 五方法落 checkpoints/checkpoint_writes + PrismaMemoryStore 五方法落 memory_items，继承 @langchain/langgraph-checkpoint ~1.1.5 基类零侵入接入，WRITES_IDX_MAP 仅从 checkpoint 包导出，PrismaClient 构造注入；根五件 = #775 F 节——ProviderRegistry（initChatModel 构造、缓存 key (ownerId,providerId,configVersion)、热生效 = run 启动读 config_meta.version 判等 + run 粒度快照、白名单第二层复验 40042 + fetch wrapper 验最终请求 origin/redirect manual）、allowlist（纯逻辑）、concurrency（per-user+全局信号量 40043 + wouldReject 只读预检[#778 REST 即时反馈]）、usage（usage_metadata 全量采数落 llm_usage_records + 核算查询）、providerDefaults（minimax 默认 provider 三方同源常量 + 惰性物化）；runtime/ = #777 runner 内核——RunService（per-thread 串行链 + run 状态机 queued→running⇄interrupted→终态(+suspended #783) + 图实例缓存 key=(thread,configVersion,policy,backend 双根) + resume 互斥 50001 + 新栈从 checkpoint 推导 interrupted + 沙箱 ensure/touch 接线[#776 契约「消费方 = #777」] + recordTurn 注入缝[#778 会话行落库] + normalizeReplay 重放归一（checkpoint 判据 message=human id 盖印/resume=__error__ write → recover null 续跑[#779 story 14] + inFlightProjection 在飞投影[running 从 checkpoint blob 重建 turn，story 11]））、projector（v3 protocol events → run 域目录薄投影，details 4KB/input 1k 截断）、checkpointTurn（#779 checkpoint blob messages → TurnSnapshot 纯函数反序列化——in-flight 投影与 recover 落行共用单一实现）、errorKind（三分类 llm_error/recursion_limit/infra + cause 链剥离）、tracing（显式关 langsmith 双路覆盖）、abortGuard（LangGraph abortPromise 泄漏进程级守门）、bullmqRunQueue（自包含 RunCommand job，attempts:1 不重试——控制面崩溃后的 BullMQ stalled 自动重放由 RunService.normalizeReplay 以 checkpoint 判据拦截转 recover[#779 story 14]）、graphFactory（createDeepAgent 纯函数工厂，拓扑可由持久化状态推导 + middleware 透传）、wikisearch（#789 三通道①常驻检索——openwiki ~0.6.1 deep-import 直调 searchWiki/readWikiSections[绕开 MCP 层 git 硬依赖]，wiki 容器 /wiki 树逐调用拉控制面临时镜像 <tmp>/openwiki/**[与轻写一致，SKIP 集过滤]，模型面 schema 裁 root/wiki/workspace，Result {ok}|{ok:false,error} 永不 throw；漏斗归文件类[无路径参数→规则层放行，开放点 5 首验结论在 approval/values.ts]）、wikigen/ = #790 治理生成双路径（三通道②③——mirror 落地副本[整树 pull 不过 SKIP 集 + git init + sources/ 证据语料 + treeHash 单一口径 + pushBack 只归档 openwiki/** 子树 diff rm 先 put 后 rm]、lifecycleTools 包装 HostSessionManager 六生命周期工具[begin root 注入、Result 增 conflict]、backend 组合 CompositeBackend(DockerArchiveBackend,{'/wiki/':FilesystemBackend}) 经 withWriteLocks 整体包裹；②teammates.kind='wiki-update' RunService 跳缓存装配 + finish base-hash 复检推回/冲突弃镜像 + wiki-conflict 信箱邮件 + finally dispose=中断作废；③wiki/updateRun.ts 独立 run runNativeRepositoryGeneration 完整边界 + wiki_run 五类事件 + SerialRunGate 全局串行锁起步 + 30042 在飞互斥，全流程占锁）；approval/ = #783 审批三层漏斗——rules（S3 纯逻辑：路径白名单 wiki|lab|tmp 前缀 + shell-quote 词法拆解四条黑名单 [rm 根族/设备写/fork bomb/容器逃逸]，V1 硬编码测试锁定）、judge（输入构造 ≤8k tokens 截断 + 输出契约 zod + 重试一次 fail-closed + 版本化列拒四类政策 markdown）、funnel（langchain wrapToolCall 中间件：规则层→judge→升级三分，interrupt 升级带 escalationMemo 重放幂等，reject 回喂 ToolMessage、同 hash ≥3 升级、audit 同步写 fail-closed）、audit（tool_approval_logs 三层全量同步写，judge 存 hash）、auditRoutes（admin 全量检索 REST，含 #785 file-overwrite-logs 路由）——升级触发源 = 谨慎模式 users.approvalMode/judge 超限 20/重复拒绝 ≥3/输出畸形，RunService 侧 approval.requested/resolved 事件 + 48h→suspended（可 resume/abort，restart 靠 checkpoint createdAt 推导恢复）；writelock/ = #785 per-path 写锁（#769 锁方案：registry 进程内 FIFO 锁表 key=(sandbox parent session, 根相对 path)，有界等待超时 {error} 回喂 agent 含 path 与持有者，releaseRun 持锁者死随 task 取消自动释放；lockedBackend 装饰器锁 backend write/edit/delete 全方法[edit 读改写序整体在锁内] + withLockedPuts 按 tar 内单文件名锁 ingestion/校验节点 putArchive 写面；读/bash 旁路；跨会话 wiki 锁 V1 不做）+ overwriteAudit（write-after-write 合法覆盖审计：锁内查 file_journal 最新 applied 未归档行经 checkpoint.threadId 解析上家 writer ≠ 本 thread → 记一次落 file_overwrite_logs，fail-soft warn 留痕，不做运行时提示；journal 写入面归 #782——writer 落地前审计自然静默） | `backend/dockerArchiveBackend.ts` `backend/primitives.ts` `backend/dockerPrimitives.ts` `backend/paths.ts` `backend/semantics.ts` `persistence/prismaCheckpointSaver.ts` `persistence/prismaMemoryStore.ts` `providerRegistry.ts` `allowlist.ts` `concurrency.ts` `usage.ts` `providerDefaults.ts` `runtime/runService.ts` `runtime/projector.ts` `runtime/checkpointTurn.ts` `runtime/errorKind.ts` `runtime/graphFactory.ts` `wikisearch.ts` `runtime/tracing.ts` `runtime/abortGuard.ts` `bullmqRunQueue.ts` `approval/rules.ts` `approval/judge.ts` `approval/funnel.ts` `approval/audit.ts` `approval/values.ts` `writelock/registry.ts` `writelock/lockedBackend.ts` `writelock/overwriteAudit.ts` `wikigen/values.ts` `wikigen/mirror.ts` `wikigen/lifecycleTools.ts` `wikigen/backend.ts` `auditRoutes.ts` `assembly.ts` |
| `sessions/` | 会话 REST 域（#778 · #747 C 节会话 REST 全件：扁平挂用户（容器维度退役）、创建/列表/改标题（story 5 首轮自动生成+可改）、发消息 32-hex Idempotency-Key 幂等（story 7，P2002 唯一约束兜底并发单落，同 key 异 content → 50007）、abort by:user（story 8，仅 running 在飞 → 否则 50006）、resume 先到先得（50001 预检 + 内核权威面双层）、多端门禁（queued/running 禁新输入 50005·非终态拒删；幂等查先于门禁——重发已收消息必得 replay；sendMessage/resume 双入口配额预检 40043）、历史投影 GET（story 3 回放零差异——TurnReducer 双入口同构：RunService recordTurn 终态落行 ≡ 投影 GET 反序列化行，attachmentsJson v1 = serializeAttachments 单一来源；#781 起 archivedAt 过滤）、inFlight 投影（#779 story 11：GET 附带 inFlight 字段——queued 空 turn/running 从 checkpoint blob 重建，多端同形，终态缺省）、session.created/updated 事件、50002 session_not_found 同码防探测、删会话级联删沙箱[#776 契约]；#781 rewind/fork（#770 三操作模型——branch-switch 机制取消）：rewind = 换 Session.activeCheckpointId 指针 + 被放弃路线软删（checkpoint/消息/file_journal 三表 archivedAt，行不物理删、不可再作锚点/切点[无恢复入口]）+ session.invalidated{reason:rewind}，消息行重开后从锚点 time-travel 分叉（invocation configurable.checkpoint_id）+ completed 终态指针推进（终态锚祖先链含指针才推进，防 stalled 重放拽进旧分支）+ sendMessage 残留清理（指针内重读，锚点后失败轮随重试归档）；fork = 新 Session 行（parentSessionKey/forkSourceJson 溯源）+ checkpoint 祖先链行复制（blob 自包含——切点 state 起步）+ 消息行挂靠截断复制（新 id + attachments.messageId 映射）+ 沙箱整容器字面复制（docker export→import 含墓碑，#768 D7）+ file_journal 切点截断继承（seq 接续）+ attachments 行全量复制（attachmentId 不改；messageId 挂靠复制行映射新 id、其余置 null——FK 级联面）+ 源沙箱已删则空起步+系统消息；#787 起 sendMessage 入口截斜杠命令：幂等/门禁/落行全作用于**原始输入**（落行存 /命令原文——模板发版改文不破 replay），官方命令展开只在命令构造点（$ARGUMENTS 插值进 run）；系统命令 /new（事务建会话）/compact（cmd.operation=compact 转内核）/model（resolveModelSelection + sessions.preferredModelJson 落列，next-run 生效；命令结果经 serializeAttachments 的 command 聚合面挂行，幂等 replay 复原；列清单不发 session.updated）；锚点/挂靠判定 = rewind.ts 纯逻辑） | `values.ts` `reducer.ts` `rewind.ts` `service.ts` `routes.ts` |

| `officialContent/` | 官方内容目录（#787 · #758 Q1/Q2/Q6 修订：always-on 无表）：源 = 仓库根 `official/`（commands/*.md + skills/<name>/SKILL.md，frontmatter name/description），`scripts/build-official-content.mjs` 编译期产 `generated.ts`（**提交入库**——fresh checkout typecheck 不依赖生成钩子；predev/pretest/prebuild + Docker additional context `official/` + cd.yml build-contexts 全接线）。always-on：无启用位、无 DB 表、无 REST 域（per-user command_defs/skill_defs 整域不建），管理面 = git 发版评审。commands = markdown 模板 + `$ARGUMENTS` 插值 → 作为 user message 注入（expand 在 sendMessage 命令构造点——幂等/落行存原文，agent 视作用户输入可追问）；系统命令 V1 = /new /compact /model（保留名，官方目录禁占用），/compact = RunService.compactThread 薄封装——deepagents summarization middleware 由阈值触发不可强制，故按其状态语义直写 `_summarizationEvent`（{cutoffIndex, summaryMessage[lc_source=summarization], filePath=null}，raw messages 不重写，effective = [summary, ...raw.slice(cutoff)]，保留窗 6 = FALLBACK_KEEP 同值，cutoff 落 ToolMessage 前移整对）。skills = 目录行注入 system prompt（≤4KB）+ `read_official_skill` 工具按需渐进披露正文（≤64KB；护栏 50 个/名称/单行 description，catalog 构造期 throw），目录快照 per-run（version = sha256 入图缓存键）；teammate（GENERAL_PURPOSE_SUBAGENT subagent）默认全继承目录提示（story 47） | `catalog.ts` `runtime.ts` `generated.ts` |

配置集中在 `src/config.ts`（env 读取 + 生产 fail-fast）。Prisma schema 在 `prisma/schema.prisma`
（建表 SQL 由 `scripts/apply-schema.mjs` 落库，不经 prisma CLI——规避 Prisma 7 AI 守卫）。

## API / 路由

- `GET /api/health`（公开）。
- `/api/v1/auth/*` — 登录/refresh(R1 旋转)/logout/me/password/change + OIDC `oauth/<p>/login|callback`（未配 provider 时 90001）。
- `/api/v1/users` — admin 账号管理（GET 连带 containerCount / POST / PATCH / reset-password；码段 1xxxx）。
- `/api/v1/containers/*` — 容器列表/新建（同步返 creating 快照）/删除（异步信封）。
- `/api/v1/containers/<name>/pairing/` — 设备配对查询/触发/approve。
- `/api/v1/containers/<name>/wiki/{tree,page,graph,categories}` — wiki 文件树/读写/图谱
  （#784 存储换轨：数据源 = 该容器行 owner 的 wiki 容器，每操作前置 ensure（惰性创建/stopped
  复启），归属校验先于 ensure——越权探测不建容器）。
- `/api/v1/containers/<name>/wiki/claims?path=` — 页 claims 旁车只读面（#789 story 42 数据面：
  论断 evidence + 页级漂移 fresh|drifted|null；页缺失 30040、旁车缺失 200+空 claims）。
- `/api/v1/containers/<name>/models/providers[/<pid>]` — model provider CRUD（#775：事务 = mutation +
  config_meta version bump 热生效；白名单第一层校验未命中 → 90002 字段级 base_url）。
- `/api/v1/provider-endpoints[/<id>]` — 端点白名单 admin CRUD（#775 · 731 §3.1，origin 精确匹配；
  GET/POST/DELETE，非 admin → 10004）。
- `/api/v1/approval-logs` — 审批全量审计检索 admin REST（#783 · ADR 0015；过滤
  userId/runId/layer/decision/from/to + 分页；judge 输入只露 hash）。
- `/api/v1/file-overwrite-logs` — 覆盖审计检索 admin REST（#785；过滤 sessionId/path/from/to
  + 分页；行 = 一次 write-after-write 覆盖 path/覆盖者/被覆盖者）。
- `/api/v1/containers/<name>/files?root=<wiki|workspace|lab>&path=&recursive=` — 统一文件 CRUD（#776
  root 契约换轨：wiki = legacy 容器树（读写面暂留，退役归 T0）；workspace = legacy **只读消费值**
  （现存前端 fileTabs 硬发此值，#793 迁 lab 后退役；写面 90002）；lab = 会话沙箱 /lab 只读 GET 面——
  <name> 为 sessionId，50002 同码防探测；写面收敛：PUT/POST/DELETE 仅 wiki 放行，lab/workspace →
  90002；binary/oversized 不返回内容）。
- `/api/v1/sessions[/<id>]` — 会话 REST 域（#778：POST 创建/GET 列表/PATCH 改标题/DELETE（级联删
  沙箱）；`/<id>/messages` POST 发消息（`Idempotency-Key` 32-hex header 幂等，重发 replay）+
  GET 历史投影（回放零差异面；#781 起 archivedAt 过滤——被放弃路线行不可读）；`/<id>/abort`、
  `/<id>/resume`；#781 增 `/<id>/rewind`（换 activeCheckpointId 指针重开 + 被放弃路线软删 +
  `session.invalidated{reason:rewind}` 事件）、`/<id>/fork`（新会话复制全件 + 沙箱字面复制 +
  `session.created{source:fork}` 事件）；#782 增 rewind body `scope` 三态（`all` 缺省=对话+文件
  同回[逆放 /lab 至锚点时刻]·`chat`=只回对话[水位推进保持文件现状]·`files`=只回文件[对话投影与
  指针不动]；files 面结果挂 `files` 字段{reverted,skippedMissing,degraded}）+ `/<id>/rewind/preview`
  （逆放摘要 + 锚后 exec 跨越清单——POST 同 body，只读）；
  50002 同码防探测）。
- `/api/v1/containers/<name>/chat/{sessions,approval/resolve,commands}` — chat REST 代理。
- 对话 WS 走 `/ws/chat/` 隧道（JWT subprotocol 握手；先 accept 再 close(4401) 拒未认证）。
- `GET /api/v1/events` — SSE 事件流（#773，panel_stream cookie 认证，替代 WS 的传输面先行）。

全局 #312 信封：所有 REST 一律 HTTP 200，错误信号在 body `{code,message,data}`；「不存在 vs 越权」
同码防探测（20040/30040/40040/60040）。例外：二进制成功路径直发原生字节（`GET /figures/:id/png` 成功
返 `image/png` 字节，不包信封、不 base64-in-JSON；错误面仍走信封）；SSE 流端点（`/api/v1/events`）
连接级认证失败走 **HTTP 401** + 信封体（#726 钉死「不入事件」，EventSource 看不见状态码——REST 刷新链
死信号让路；其余响应仍 HTTP 200+信封）。码段：`0` 成功 · `1xxxx` 通用/鉴权 ·
`2xxxx` 容器 · `3xxxx` wiki ·
`4xxxx` models（40042 端点不在白名单[运行时第二层，仅 runner 侧] · 40043 并发配额已满[per-user
maxConcurrentRuns 或全局 RUNNER_MAX_CONCURRENT_RUNS]）· `5xxxx` chat/pairing 的 WS close codes 为另一传输面；信封面 5xxxx = 会话/run 域（#747 C 节，
  #776 起 50002 session_not_found；#777 起 50003 审批挂起（#778 补 REST 前置面与码表）；#783 起
  50004 approval_not_found 同码防探测；#778 增（50004 让位 #783，顺移起）50005 run 进行中禁输入·
  非终态拒删 / 50006 无在飞可中断 / 50007 幂等 key 同 key 异 content；#782 起 50008 文件状态
  重放中[写围栏等待超时，报当前持有者]）· `6xxxx` files ·
`7xxxx` figures（AutoFigure，70040 不存在/越权同码防探测（T05 读路径，PNG 复用同一归属门）· 70041 幂等冲突 ·
70042 PNG 未就绪（queued/running）· 70043 PNG 不可用（failed/产物缺失））·
`9xxxx` 系统/校验。

## frontend 结构（`frontend/src/`）

- `router/index.ts` — 路由表 + 导航守卫（未登录重定向 `/login`，`auth.hydrate()` 恢复登录态；
  `meta.requiresAdmin` 守卫 admin users 页）。
- `stores/` — Pinia：`auth.ts`（JWT access token + role/mustChangePassword）、`wiki.ts`、`chat.ts`
  （对话页响应式投影：纯 mutation；视图模型类型经 `chat/projection.ts` 再导出）、`fileTabs.ts`
  （会话沙箱 lab 文件 tab，#793 起 root=lab、切会话即换树）。
- `api/` — REST client 封装（`client.ts` 信封解析 + 401 刷新链 + 并发去抖；`sessions/containers/files/wiki/models/users.ts` 按域）。
- `chat/` — chat 核心三件套（#793 · #730 §4.1，REST+SSE 换轨；网关协议机/设备配对/升级编排死区已删）：
  `projection.ts`（投影归约器纯函数——`applyEvent` 事件增量 / `fromProjection` 投影行双入口同形状，
  事件聚合语义镜像 server sessions/reducer.ts，一致性由 projection.test.ts 零差异组锁死）/
  `useChatSession.ts`（会话编排 composable——发送幂等/门控/断线补偿/审批/slash 系统命令）/
  `useEventStream.ts`（SSE 薄封装——原生重连 + seq gap 检测 + 401 经刷新链关流 + session.terminated 停重连）/
  `restOutbox.ts`（#779 story 12 断线排队：sessionStorage 落盘、50 上限丢最旧、按序幂等 flush）/
  `attachments.ts`（采集/校验纯函数，发送经 multipart 上传换 attachmentIds）；
  `teamProjection.ts`（#786 teammate 投影，TeamSessionsView 用）。
- `views/` — 六页：`LoginView` / `ContainersView` / `ChatView`（REST+SSE 编排壳）/ `WikiView` / `ModelView` / `AdminUsersView`。
- `components/` — `FileTree` / `MdEditor`（Typora 式实时渲染）/ `WikiGraph`（obsidian 风格图谱）/
  ChatView 哑组件族（props-in/emits-out，零协议 import：`ChatSidebar`（会话扁平列表 + lab 文件树）/
  `ChatHeader`/`ChatStream`/`ChatComposer`/`ChatMessageItem`/`ThinkingCard`/`ToolLine`/`ApprovalCard`/`ApprovalDock`
  + `SessionTimeline`/`SessionTurn`（teammate 面））。

## 关键机制与约束

- **配置单一来源**：`deploy/openclaw.json` 是全面板共享模板；`ConfigRenderer` 渲染每容器配置并强制
  安全不变量（port/bind/token 占位）。`GATEWAY_TOKEN` 每容器独立生成、经 env 注入，真值落盘为 AES 密文。
- **端口池**：宿主侧池 `19000–19999`（容器内统一 18789，靠 Docker 网络命名空间隔离；池避开单容器
  compose 占用的 18789），创建取最小空闲、删除回收（`containers/ports.ts`）。
- **设备配对**：chat/审批/补全/工具事件须先完成 Ed25519 设备配对（签名 challenge → 宿主 approve →
  deviceToken 持久化）。A3 双层状态机 `PAIRING_REQUIRED→APPROVING→PAIRED`（可重试无 FAILED 终态），
  宿主 approve 由控制面在容器内 `openclaw devices approve` 编排（ADR 0006）。
- **docker.sock 安全**：控制面挂 `/var/run/docker.sock` = 等价 root（spec §5.4 明示风险）。本地/可信
  部署可接受；生产应限制控制面网络面或改用 rootless / 远程 TLS daemon。
- **输入 0 信任**：所有写操作经 zod schema 强制校验（`validation/schemas.ts`），禁裸读 `req.body`。
- **凭证**：LLM key 全面板共享（`LLM_API_KEY` env 注入容器，不落盘）；`CREDENTIAL_ENCRYPTION_KEYS`
  加密 gateway token 落盘密文。
- **生产部署**：`deploy/docker-compose.deploy.yml`（frontend nginx + server + redis 三服务），
  CD 经 GitHub Actions 构建 `server`/`frontend` 镜像推 GHCR 并部署宝塔宿主（见 `deploy/DEPLOY.md`）。
- **测试**：
  - server：`cd server && npm test`（vitest；接缝 1–5：wiki Port / 信封 REST / WS 桥 / hostDeps /
    编排器 Port；events 域测试按 #747 Testing Decisions 的 S 编号标注：S1 信封级集成 /
    S3 纯逻辑单测）。容器编排集成 smoke 需真 docker daemon（自动探测门控）；BullMQ 用例需真 Redis（门控）。
  - frontend：`cd frontend && npm run test`（vitest）；`npm run build` 跑 vue-tsc 类型检查。

## Issue tracker / triage

Issues 跟踪在 GitHub `ACautomata/researcher-service`（`gh` CLI）。见 `docs/agents/issue-tracker.md`、
`docs/agents/triage-labels.md`（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。
