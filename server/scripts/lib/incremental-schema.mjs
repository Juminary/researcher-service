// 增量 SQLite schema 收敛 —— apply-schema.mjs（初始化后收敛）与 upgrade-schema.mjs
// （entrypoint 每次启动调用）共享本过程，保证两条路径对同一 DB 收敛到同一形状。
//
// 铁律（#771 验收）：
//   - 全程幂等可重跑 —— CREATE 系 IF NOT EXISTS；ADD COLUMN 经 PRAGMA table_info guard
//     （SQLite 无 ADD COLUMN IF NOT EXISTS）；种子 INSERT OR IGNORE。
//   - 只做 additive —— 不 ALTER/DROP 既有旧表；旧形状 model_providers / pairings 留待
//     T0 清退（#801），检测到旧形状只告警。
//   - DDL 与 prisma/init.sql 逐字节同源（镜像其 CREATE 形状），init.sql 由
//     prisma migrate diff 从 schema.prisma 派生 —— 单一来源，此处镜像。
export const SCHEMA_VERSION = 13

export function runIncrementalSchema(db) {
  const hasSessions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get()
  if (hasSessions && !db.prepare('PRAGMA table_info("sessions")').all().some(c => c.name === 'preferredModelJson')) {
    db.exec('ALTER TABLE "sessions" ADD COLUMN "preferredModelJson" TEXT')
  }
  // #782（#747·12）：sessions 水位列（files rewind 的 planRevert 判定下界——scope=chat 保持
  // 现状永久化面）。ADD COLUMN 非幂等，PRAGMA guard 先查再补（对齐 preferredModelJson 模式）。
  if (hasSessions && !db.prepare('PRAGMA table_info("sessions")').all().some(c => c.name === 'fileJournalAnchorSeq')) {
    db.exec('ALTER TABLE "sessions" ADD COLUMN "fileJournalAnchorSeq" INTEGER')
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS "text_trace_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "containerName" TEXT,
    "sessionKey" TEXT,
    "runId" TEXT,
    "inputText" TEXT NOT NULL DEFAULT '',
    "outputText" TEXT NOT NULL DEFAULT '',
    "outputHash" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'success',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "text_trace_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "text_trace_logs_traceId_key" ON "text_trace_logs"("traceId");
CREATE INDEX IF NOT EXISTS "text_trace_logs_userId_idx" ON "text_trace_logs"("userId");
CREATE INDEX IF NOT EXISTS "text_trace_logs_ipAddress_idx" ON "text_trace_logs"("ipAddress");
CREATE INDEX IF NOT EXISTS "text_trace_logs_createdAt_idx" ON "text_trace_logs"("createdAt");
CREATE INDEX IF NOT EXISTS "text_trace_logs_status_idx" ON "text_trace_logs"("status");

CREATE TABLE IF NOT EXISTS "figures" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "xml" TEXT,
    "png" BLOB,
    "evaluation" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "figures_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "generation_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "figureId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "generation_jobs_figureId_fkey" FOREIGN KEY ("figureId") REFERENCES "figures" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "figures_ownerId_idx" ON "figures"("ownerId");
CREATE UNIQUE INDEX IF NOT EXISTS "generation_jobs_figureId_key" ON "generation_jobs"("figureId");
`)

  // T02 幂等（grilling §17）：既有 figures 表（T01 前已建）缺 idempotencyKey 列。ADD COLUMN
  // 非天然幂等（重复执行报 duplicate column），先查 PRAGMA table_info 再补；唯一索引本身
  // 幂等（IF NOT EXISTS）。fresh 库（上方 CREATE TABLE 已带列）此处列存在 → guard 跳过。
  const figureCols = db.prepare(`PRAGMA table_info("figures")`).all()
  if (!figureCols.some((c) => c.name === 'idempotencyKey')) {
    db.exec(`ALTER TABLE "figures" ADD COLUMN "idempotencyKey" TEXT`)
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS "figures_ownerId_idempotencyKey_key" ON "figures"("ownerId", "idempotencyKey")`,
  )

  // T03（docs/autofigure/tickets/T03-single-worker-generation-lifecycle.md）：generation_jobs
  // 增加执行生命周期时间戳。列语义：startedAt = 原子领取（queued→running）时刻置位，running 期间
  // 非空；finishedAt = 终态（succeeded|failed）写入时刻置位，queued/running 恒 null。两列均
  // nullable（不迁移旧行、不给旧 queued 伪造时间）；ADD COLUMN 非幂等，PRAGMA guard 先查再补
  //（对齐 T02 idempotencyKey 模式）。fresh 库（上方 CREATE TABLE 已带列）此处列存在 → guard 跳过。
  const jobCols = db.prepare(`PRAGMA table_info("generation_jobs")`).all()
  if (!jobCols.some((c) => c.name === 'startedAt')) {
    db.exec(`ALTER TABLE "generation_jobs" ADD COLUMN "startedAt" DATETIME`)
  }
  if (!jobCols.some((c) => c.name === 'finishedAt')) {
    db.exec(`ALTER TABLE "generation_jobs" ADD COLUMN "finishedAt" DATETIME`)
  }

  // T06（docs/autofigure/tickets/T06-artifact-persistence-png.md · grilling §6）：figures 增加产物
  // 三列——xml（文本）+ png（SQLite BLOB）+ evaluation（文本 JSON）。全 nullable：仅在 Job 提交
  // succeeded 终态时由 runner 原子写入，queued/running/failed 恒 null（不迁移旧行、不给旧
  // succeeded 伪造产物）。ADD COLUMN 非幂等，PRAGMA guard 先查再补（对齐 T02/T03 模式）。
  // 本脚本上方 CREATE TABLE（既有部署早于 T01 前已建表，走 ALTER 分支）也随 init.sql 同步带三列，
  // 保持 fresh 与 upgrade 两路径列集一致——此处列存在 → guard 跳过。
  const figCols = db.prepare(`PRAGMA table_info("figures")`).all()
  if (!figCols.some((c) => c.name === 'xml')) {
    db.exec(`ALTER TABLE "figures" ADD COLUMN "xml" TEXT`)
  }
  if (!figCols.some((c) => c.name === 'png')) {
    db.exec(`ALTER TABLE "figures" ADD COLUMN "png" BLOB`)
  }
  if (!figCols.some((c) => c.name === 'evaluation')) {
    db.exec(`ALTER TABLE "figures" ADD COLUMN "evaluation" TEXT`)
  }

  // #699 容器升级编排（spec §2.2）：containers 增加 upgradeAttempts 列（连续失败计数，成功清零；
  // ≥3 → upgrade_failed 终态）。ADD COLUMN 非幂等，PRAGMA guard 先查再补（对齐 T02/T03/T06 模式）。
  // fresh 库（init.sql CREATE TABLE 已带列）此处列存在 → guard 跳过；表不存在（异常/极旧部署）→ 跳过
  // 防 ALTER no such table。
  const containerTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='containers'`)
    .get()
  if (containerTable) {
    const containerCols = db.prepare(`PRAGMA table_info("containers")`).all()
    if (!containerCols.some((c) => c.name === 'upgradeAttempts')) {
      db.exec(`ALTER TABLE "containers" ADD COLUMN "upgradeAttempts" INTEGER NOT NULL DEFAULT 0`)
    }
  }

  runLanggraphFoundation(db)
}

// #771（#747·01）Prisma 新表地基：#747 B 节全表 + users 加列 + 旧形状 model_providers 检测。
// DDL 镜像 prisma/init.sql（schema.prisma 派生）同形状，全 IF NOT EXISTS。
function runLanggraphFoundation(db) {
  // ---- users 加列（731 §3.3 / 729 §3.5）——既有库表已存在，ADD COLUMN 经 PRAGMA guard ----
  const usersTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`).get()
  if (usersTable) {
    const userCols = db.prepare(`PRAGMA table_info("users")`).all()
    if (!userCols.some((c) => c.name === 'maxConcurrentRuns')) {
      db.exec(`ALTER TABLE "users" ADD COLUMN "maxConcurrentRuns" INTEGER NOT NULL DEFAULT 2`)
    }
    if (!userCols.some((c) => c.name === 'approvalMode')) {
      db.exec(`ALTER TABLE "users" ADD COLUMN "approvalMode" TEXT NOT NULL DEFAULT 'standard'`)
    }
  }

  // ---- 会话历史域新表（#747 B 节 / #727）----
  db.exec(`
CREATE TABLE IF NOT EXISTS "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "parentSessionKey" TEXT,
    "forkSourceJson" TEXT,
    "activeCheckpointId" TEXT,
    "preferredModelJson" TEXT,
    "fileJournalAnchorSeq" INTEGER,
    "archivedAt" DATETIME,
    "isTeammate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sessions_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "teammates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentSessionId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "modelProviderId" TEXT,
    "spawnedAtCheckpointId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    CONSTRAINT "teammates_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teammates_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "teammate_mailbox_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentSessionId" TEXT NOT NULL,
    "senderTeammateId" TEXT,
    "recipientTeammateId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'message',
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    "invalidatedAt" DATETIME,
    "expiresAt" DATETIME,
    CONSTRAINT "teammate_mailbox_messages_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teammate_mailbox_messages_senderTeammateId_fkey" FOREIGN KEY ("senderTeammateId") REFERENCES "teammates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "teammate_mailbox_waits" (
    "waitId" TEXT NOT NULL PRIMARY KEY,
    "parentSessionId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL UNIQUE,
    "recipientTeammateId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "teammate_mailbox_waits_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teammate_mailbox_waits_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teammate_mailbox_waits_recipientTeammateId_fkey" FOREIGN KEY ("recipientTeammateId") REFERENCES "teammates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "session_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "clientKey" TEXT,
    "attachmentsJson" TEXT NOT NULL DEFAULT '{"v":1}',
    "anchorCheckpointId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "session_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "checkpoints" (
    "threadId" TEXT NOT NULL,
    "checkpointNs" TEXT NOT NULL DEFAULT '',
    "checkpointId" TEXT NOT NULL,
    "parentCheckpointId" TEXT,
    "type" TEXT NOT NULL,
    "blob" BLOB NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("threadId", "checkpointNs", "checkpointId"),
    CONSTRAINT "checkpoints_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "checkpoint_writes" (
    "threadId" TEXT NOT NULL,
    "checkpointNs" TEXT NOT NULL DEFAULT '',
    "checkpointId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "blob" BLOB NOT NULL,

    PRIMARY KEY ("threadId", "checkpointNs", "checkpointId", "taskId", "idx"),
    CONSTRAINT "checkpoint_writes_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "memory_items" (
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("namespace", "key")
);

CREATE TABLE IF NOT EXISTS "tool_approval_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "traceId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolCall" TEXT NOT NULL,
    "policyClass" TEXT,
    "reason" TEXT,
    "judgeInputHash" TEXT,
    "latencyMs" INTEGER,
    "judgeTokens" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "attachments" (
    "sessionId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "messageId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "path" TEXT NOT NULL,

    PRIMARY KEY ("sessionId", "id"),
    CONSTRAINT "attachments_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attachments_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "session_messages" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "file_journal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "beforeSha256" TEXT,
    "afterSha256" TEXT,
    "tombstoneKey" TEXT,
    "toolCallId" TEXT NOT NULL,
    "runId" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "fileRevertedAt" DATETIME,
    "archivedAt" DATETIME,
    CONSTRAINT "file_journal_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`)

  // #782（#747·12）：file_journal 生命周期三列（runId = 终态回填键；fileRevertedAt = 逆放
  // 处置标；archivedAt = 被放弃路线软删）。镜像部署早于本票的库已建出无列表——CREATE IF NOT
  // EXISTS 对既有表 no-op，PRAGMA guard 先查再补（对齐 T02/T03 模式）。fresh 库（上方
  // CREATE TABLE 已带列）→ guard 跳过。**guard 必须先于下方索引创建**（#778 clientKey 同型
  // 坑，#818 CD 崩溃回归生产实锤）。
  const hasFileJournal = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_journal'").get()
  if (hasFileJournal) {
    const fjCols = db.prepare('PRAGMA table_info("file_journal")').all()
    if (!fjCols.some((c) => c.name === 'runId')) {
      db.exec('ALTER TABLE "file_journal" ADD COLUMN "runId" TEXT')
    }
    if (!fjCols.some((c) => c.name === 'fileRevertedAt')) {
      db.exec('ALTER TABLE "file_journal" ADD COLUMN "fileRevertedAt" DATETIME')
    }
    if (!fjCols.some((c) => c.name === 'archivedAt')) {
      db.exec('ALTER TABLE "file_journal" ADD COLUMN "archivedAt" DATETIME')
    }
  }

  db.exec(`
CREATE INDEX IF NOT EXISTS "file_journal_sessionId_checkpointId_idx" ON "file_journal"("sessionId", "checkpointId");
CREATE UNIQUE INDEX IF NOT EXISTS "file_journal_sessionId_seq_key" ON "file_journal"("sessionId", "seq");
CREATE UNIQUE INDEX IF NOT EXISTS "file_journal_sessionId_toolCallId_key" ON "file_journal"("sessionId", "toolCallId");
`)

  // #786 teammate thread flags: existing session rows default to leader; teammate threads are hidden
  // from the user's session list while remaining valid LangGraph checkpoint threads.
  const sessionsTable = db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'sessions')
  if (sessionsTable) {
    const sessionCols = db.prepare('PRAGMA table_info("sessions")').all()
    if (!sessionCols.some((c) => c.name === 'isTeammate')) {
      db.exec('ALTER TABLE "sessions" ADD COLUMN "isTeammate" BOOLEAN NOT NULL DEFAULT false')
    }
  }

  // #790（#747·20 · G 节三通道②）teammates 补 kind 列（generic 缺省 / wiki-update = 治理生成
  // teammate——RunService 据此装配落地副本 backend + 生命周期工具；拓扑可由持久化状态推导）。
  // ADD COLUMN 非幂等，PRAGMA guard 先查再补（对齐 isTeammate 模式）。fresh 库（上方 CREATE
  // TABLE 已带列）此处列存在 → guard 跳过。
  const teammatesTable = db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'teammates')
  if (teammatesTable) {
    const teammateCols = db.prepare('PRAGMA table_info("teammates")').all()
    if (!teammateCols.some((c) => c.name === 'kind')) {
      db.exec(`ALTER TABLE "teammates" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'generic'`)
    }
  }

  // #778（#747·08 · story 7）：session_messages 补 clientKey 列（32-hex 幂等 key，仅 user 行
  // 携带）——(sessionId, clientKey) 唯一索引 = 断网重发不重复入列的约束面。ADD COLUMN 非幂等，
  // PRAGMA guard 先查再补（对齐 T02 模式）。fresh 库（上方 CREATE TABLE 已带列）此处列存在
  // → guard 跳过。
  //
  // **guard 必须先于下方索引创建**（#818 CD 崩溃回归，生产实锤）：#778 之前的镜像（≤#777
  // 部署）已在此建出**无 clientKey** 的 session_messages——CREATE IF NOT EXISTS 对既有表
  // no-op，若 (sessionId, clientKey) 唯一索引先于补列执行，`no such column: "clientKey"`
  // 令 entrypoint 崩溃循环、health gate 永不过。故 guard 独立于索引块之前：既有库先 ALTER
  // 再建索引，fresh 库两分支自然正确（索引块全部语句只引用 CREATE TABLE 自带列 + 本 guard
  // 补的列）。
  const smCols = db.prepare(`PRAGMA table_info("session_messages")`).all()
  if (smCols.length > 0 && !smCols.some((c) => c.name === 'clientKey')) {
    db.exec(`ALTER TABLE "session_messages" ADD COLUMN "clientKey" TEXT`)
  }

  // #781（#747·11 · #770 rewind 软删）：session_messages / checkpoints / file_journal 三表
  // 补 archivedAt 软删列——被放弃原路线行打标记（投影过滤/逆放跳过/GC 回收对象），行不物理删。
  // ADD COLUMN 非幂等，PRAGMA guard 先查再补（三处 nullable，无回填需求）。
  if (smCols.length > 0 && !smCols.some((c) => c.name === 'archivedAt')) {
    db.exec(`ALTER TABLE "session_messages" ADD COLUMN "archivedAt" DATETIME`)
  }
  const cpCols = db.prepare(`PRAGMA table_info("checkpoints")`).all()
  if (cpCols.length > 0 && !cpCols.some((c) => c.name === 'archivedAt')) {
    db.exec(`ALTER TABLE "checkpoints" ADD COLUMN "archivedAt" DATETIME`)
  }
  const fjCols = db.prepare(`PRAGMA table_info("file_journal")`).all()
  if (fjCols.length > 0 && !fjCols.some((c) => c.name === 'archivedAt')) {
    db.exec(`ALTER TABLE "file_journal" ADD COLUMN "archivedAt" DATETIME`)
  }

  // ---- B 节索引（在全部 B 节表 + 补列 guard 之后统一创建；IF NOT EXISTS 幂等）----
  db.exec(`
CREATE INDEX IF NOT EXISTS "sessions_ownerId_idx" ON "sessions"("ownerId");
CREATE UNIQUE INDEX IF NOT EXISTS "teammates_threadId_key" ON "teammates"("threadId");
CREATE UNIQUE INDEX IF NOT EXISTS "teammates_parentSessionId_name_key" ON "teammates"("parentSessionId", "name");
CREATE INDEX IF NOT EXISTS "teammates_parentSessionId_status_idx" ON "teammates"("parentSessionId", "status");
CREATE INDEX IF NOT EXISTS "teammate_mailbox_messages_parentSessionId_recipientTeammateId_createdAt_idx" ON "teammate_mailbox_messages"("parentSessionId", "recipientTeammateId", "createdAt");
CREATE INDEX IF NOT EXISTS "teammate_mailbox_messages_recipientTeammateId_readAt_invalidatedAt_idx" ON "teammate_mailbox_messages"("recipientTeammateId", "readAt", "invalidatedAt");
CREATE INDEX IF NOT EXISTS "teammate_mailbox_waits_parentSessionId_recipientTeammateId_idx" ON "teammate_mailbox_waits"("parentSessionId", "recipientTeammateId");
CREATE INDEX IF NOT EXISTS "session_messages_sessionId_turn_idx" ON "session_messages"("sessionId", "turn");
CREATE UNIQUE INDEX IF NOT EXISTS "session_messages_sessionId_clientKey_key" ON "session_messages"("sessionId", "clientKey");
CREATE INDEX IF NOT EXISTS "checkpoints_threadId_checkpointNs_idx" ON "checkpoints"("threadId", "checkpointNs");
CREATE INDEX IF NOT EXISTS "checkpoint_writes_threadId_checkpointNs_idx" ON "checkpoint_writes"("threadId", "checkpointNs");
CREATE INDEX IF NOT EXISTS "tool_approval_logs_traceId_idx" ON "tool_approval_logs"("traceId");
CREATE INDEX IF NOT EXISTS "tool_approval_logs_userId_createdAt_idx" ON "tool_approval_logs"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "attachments_ownerId_idx" ON "attachments"("ownerId");
CREATE INDEX IF NOT EXISTS "attachments_sessionId_idx" ON "attachments"("sessionId");
CREATE INDEX IF NOT EXISTS "file_journal_sessionId_checkpointId_idx" ON "file_journal"("sessionId", "checkpointId");
CREATE UNIQUE INDEX IF NOT EXISTS "file_journal_sessionId_seq_key" ON "file_journal"("sessionId", "seq");
CREATE UNIQUE INDEX IF NOT EXISTS "file_journal_sessionId_toolCallId_key" ON "file_journal"("sessionId", "toolCallId");
`)

  // ---- 配置域新表（731 §3：provider_endpoints / config_meta · 752 §4.2：plugin_enablements）----
  db.exec(`
CREATE TABLE IF NOT EXISTS "provider_endpoints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheme" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "config_meta" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS "plugin_enablements" (
    "ownerId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabledAt" DATETIME NOT NULL,

    PRIMARY KEY ("ownerId", "pluginId"),
    CONSTRAINT "plugin_enablements_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "provider_endpoints_scheme_host_port_key" ON "provider_endpoints"("scheme", "host", "port");
`)

  // #774（#747·04）：memory_items 补 createdAt 列（BaseStore Item 契约必填，#771 地基遗漏）。
  // ADD COLUMN 非天然幂等，PRAGMA guard 先查再补。注意默认值处理不适用 T02/T03/T06 先例——
  // 那几处全为 nullable 或常量默认，而 SQLite 禁 ADD COLUMN 非常量默认值（CURRENT_TIMESTAMP
  // 仅 CREATE TABLE 可用）+ NOT NULL 必须有非 NULL 默认，故占位常量 + UPDATE 回填：guard 块内
  // 列刚加，全部既有行该列必为占位值，无条件回填安全（记忆成形时刻不可考，取迁移时刻——
  // 本票前无生产消费者，无脏数据）。占位 DEFAULT 残留列定义无害：Prisma client 对
  // @default(now()) 在 INSERT 显式传值，不触发表级 default。
  // fresh 库（上方 CREATE TABLE 已带列）此处列存在 → guard 跳过。
  const miCols = db.prepare(`PRAGMA table_info("memory_items")`).all()
  if (!miCols.some((c) => c.name === 'createdAt')) {
    db.exec(
      `ALTER TABLE "memory_items" ADD COLUMN "createdAt" DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00'`,
    )
    db.exec(`UPDATE "memory_items" SET "createdAt" = CURRENT_TIMESTAMP`)
  }

  // config_meta 单行种子（id=1, version=1）：INSERT OR IGNORE 幂等；provider/endpoint CRUD
  // 同事务 +1（热生效信号，731 §4）自 version=1 起步。fresh 库（init.sql CREATE 空表）同样
  // 经此路径补种子，与既有库一致。
  db.exec(`INSERT OR IGNORE INTO "config_meta" ("id", "version") VALUES (1, 1)`)

  // 731 §3.1 seed：迁移脚本把 deploy/openclaw.json 模板既有端点写入白名单（对齐 ConfigRenderer
  // 「空 providers → 模板默认 minimax」语义的显式 seed）。createdBy 无用户语境（面板级 seed，
  // users 表可能为空）→ ''（该列无 FK，不伪造 users.id）；幂等 = 固定 seed id + INSERT OR
  // IGNORE——#775 迁移存量用户 minimax provider 行时遇已存在条目自然跳过。
  db.exec(`
INSERT OR IGNORE INTO "provider_endpoints" ("id", "scheme", "host", "port", "note", "createdBy", "createdAt")
VALUES ('seed-minimax-endpoint', 'https', 'api.minimaxi.com', NULL,
        'seed（731 §3.1）：deploy/openclaw.json 模板默认 minimax 端点', '', CURRENT_TIMESTAMP)
`)

  // ---- #785（#747·15 · #769 锁方案）：file_overwrite_logs（write-after-write 覆盖审计）----
  // 取锁写 path 时存在已 applied 且上家 writer ≠ 本 thread 的 file_journal 行 → 记一次
  // （path/覆盖者/被覆盖者，不限时窗）。弱关联无 FK（审计快照纪律）；D8「观测面进审计域」。
  db.exec(`
CREATE TABLE IF NOT EXISTS "file_overwrite_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "overwriterThreadId" TEXT NOT NULL,
    "overwrittenThreadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "file_overwrite_logs_sessionId_path_idx" ON "file_overwrite_logs"("sessionId", "path");
CREATE INDEX IF NOT EXISTS "file_overwrite_logs_createdAt_idx" ON "file_overwrite_logs"("createdAt");
`)

  // ---- 旧形状 model_providers 检测（#771 验收「旧表不动，留待 T0 清退」）----
  // 存量库旧形状（containerId/api/apiKeyEnvId 列）本票不做任何 ALTER/迁移：legacy models 域
  // 对该库离线（Prisma client 已按新形状生成），处置归 T0（#801）或重建库（删库重跑 db:apply）。
  const mpTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='model_providers'`).get()
  const mpLegacy =
    !!mpTable &&
    db.prepare(`PRAGMA table_info("model_providers")`).all().some((c) => c.name === 'containerId')
  if (mpTable && mpLegacy) {
    // eslint-disable-next-line no-console
    console.warn(
      '[db:schema] 检测到旧形状 model_providers（containerId/api/apiKeyEnvId）——#771 本票不动旧表（留待 T0 清退 #801），' +
        'legacy models 域对该库离线；开发库请删除后重跑 npm run db:apply 重建。',
    )
  }

  // ---- #775（#747 F 节）：llm_usage_records（usage 全量采数，story 57 成本核算数据源）----
  db.exec(`
CREATE TABLE IF NOT EXISTS "llm_usage_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "lcProvider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "llm_usage_records_userId_createdAt_idx" ON "llm_usage_records"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "llm_usage_records_model_createdAt_idx" ON "llm_usage_records"("model", "createdAt");
CREATE INDEX IF NOT EXISTS "llm_usage_records_runId_idx" ON "llm_usage_records"("runId");
`)

  // ---- #775 minimax 默认 provider seed（731 §6 逐字段映射末行：「空 providers → 模板默认」
  // 的显式 seed 化）——每存量用户（当前零 provider 行）一行 minimax，幂等三保险：
  //   ① NOT EXISTS（用户已有任意 provider 行——新形状表 (ownerId, providerId) 唯一键构造上
  //     已无同 owner 重复行，「归属按 ownerId 折叠去重」在本表范围内即此语义）→ 跳过
  //   ② 确定性 seed id（'seed-mp-minimax-' || userId，重跑 INSERT OR IGNORE 命中同主键）
  //   ③ unique(ownerId, providerId) 兜底
  // 旧形状库（mpLegacy）跳过 seed——「同 owner 多容器重复行折叠为一条（冲突取 createdAt
  // 最早）」的旧表→新表折叠迁移归 T0 清退窗（#801；#771 验收④钉死「旧表不动」，#803 落地），
  // 与本段 seed 不冲突：T0 时旧表连同行折叠一并处置。
  // 模板漂移由 providerDefaults.test.ts 双向锁定（deploy/openclaw.json ↔ 本处内联 JSON ↔
  // runner/providerDefaults.ts 常量）。
  if (mpTable && !mpLegacy) {
    db.exec(`
INSERT OR IGNORE INTO "model_providers"
  ("id", "ownerId", "providerId", "lcProvider", "baseUrl", "credentialEnvId", "authHeader", "modelsJson", "createdAt")
SELECT 'seed-mp-minimax-' || u."id", u."id", 'minimax', 'anthropic',
       'https://api.minimaxi.com/anthropic', 'LLM_API_KEY', 1,
       '[{"id":"MiniMax-M3","name":"MiniMax M3","reasoning":true,"input":["text","image"],"cost":{"input":0.3,"output":1.2,"cacheRead":0.06,"cacheWrite":0.375},"contextWindow":1048576,"maxTokens":524288}]',
       CURRENT_TIMESTAMP
FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "model_providers" mp WHERE mp."ownerId" = u."id")
`)
  }
}
