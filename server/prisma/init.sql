-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "maxContainers" INTEGER NOT NULL DEFAULT 3,
    "maxConcurrentRuns" INTEGER NOT NULL DEFAULT 2,
    "approvalMode" TEXT NOT NULL DEFAULT 'standard',
    "oidcSubject" TEXT,
    "oidcIssuer" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "text_trace_logs" (
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

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "replacedByTokenId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "containers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "ownerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "homeDir" TEXT NOT NULL,
    "containerId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "image" TEXT NOT NULL,
    "upgradeAttempts" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "containers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "pairings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL DEFAULT '',
    "publicKeyPem" TEXT NOT NULL DEFAULT '',
    "privateKeyPem" TEXT NOT NULL DEFAULT '',
    "privateKeyPemEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "deviceToken" TEXT NOT NULL DEFAULT '',
    "deviceTokenEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "scopesJson" TEXT NOT NULL DEFAULT '[]',
    "pairingRequestId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'unpaired',
    "attemptVersion" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "pairings_containerId_fkey" FOREIGN KEY ("containerId") REFERENCES "containers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "model_providers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "lcProvider" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "credentialEnvId" TEXT,
    "credentialCipher" TEXT,
    "authHeader" BOOLEAN NOT NULL DEFAULT true,
    "modelsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_providers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "figures" (
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

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "figureId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "generation_jobs_figureId_fkey" FOREIGN KEY ("figureId") REFERENCES "figures" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "parentSessionKey" TEXT,
    "forkSourceJson" TEXT,
    "activeCheckpointId" TEXT,
    "fileJournalAnchorSeq" INTEGER,
    "preferredModelJson" TEXT,
    "archivedAt" DATETIME,
    "isTeammate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sessions_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "teammates" (
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

-- CreateTable
CREATE TABLE "teammate_mailbox_messages" (
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

-- CreateTable
CREATE TABLE "teammate_mailbox_waits" (
    "waitId" TEXT NOT NULL PRIMARY KEY,
    "parentSessionId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "recipientTeammateId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "teammate_mailbox_waits_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teammate_mailbox_waits_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teammate_mailbox_waits_recipientTeammateId_fkey" FOREIGN KEY ("recipientTeammateId") REFERENCES "teammates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "session_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "clientKey" TEXT,
    "attachmentsJson" TEXT NOT NULL DEFAULT '{"v":1}',
    "anchorCheckpointId" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "session_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "checkpoints" (
    "threadId" TEXT NOT NULL,
    "checkpointNs" TEXT NOT NULL DEFAULT '',
    "checkpointId" TEXT NOT NULL,
    "parentCheckpointId" TEXT,
    "type" TEXT NOT NULL,
    "blob" BLOB NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("threadId", "checkpointNs", "checkpointId"),
    CONSTRAINT "checkpoints_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "checkpoint_writes" (
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

-- CreateTable
CREATE TABLE "memory_items" (
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("namespace", "key")
);

-- CreateTable
CREATE TABLE "tool_approval_logs" (
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

-- CreateTable
CREATE TABLE "provider_endpoints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheme" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "config_meta" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1
);

-- CreateTable
CREATE TABLE "llm_usage_records" (
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

-- CreateTable
CREATE TABLE "plugin_enablements" (
    "ownerId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabledAt" DATETIME NOT NULL,

    PRIMARY KEY ("ownerId", "pluginId"),
    CONSTRAINT "plugin_enablements_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "attachments" (
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

-- CreateTable
CREATE TABLE "file_journal" (
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

-- CreateTable
CREATE TABLE "file_overwrite_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "overwriterThreadId" TEXT NOT NULL,
    "overwrittenThreadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_oidcIssuer_oidcSubject_key" ON "users"("oidcIssuer", "oidcSubject");

-- CreateIndex
CREATE UNIQUE INDEX "text_trace_logs_traceId_key" ON "text_trace_logs"("traceId");

-- CreateIndex
CREATE INDEX "text_trace_logs_userId_idx" ON "text_trace_logs"("userId");

-- CreateIndex
CREATE INDEX "text_trace_logs_ipAddress_idx" ON "text_trace_logs"("ipAddress");

-- CreateIndex
CREATE INDEX "text_trace_logs_createdAt_idx" ON "text_trace_logs"("createdAt");

-- CreateIndex
CREATE INDEX "text_trace_logs_status_idx" ON "text_trace_logs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "containers_name_key" ON "containers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "containers_port_key" ON "containers"("port");

-- CreateIndex
CREATE INDEX "containers_ownerId_idx" ON "containers"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "pairings_containerId_key" ON "pairings"("containerId");

-- CreateIndex
CREATE UNIQUE INDEX "model_providers_ownerId_providerId_key" ON "model_providers"("ownerId", "providerId");

-- CreateIndex
CREATE INDEX "figures_ownerId_idx" ON "figures"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "figures_ownerId_idempotencyKey_key" ON "figures"("ownerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "generation_jobs_figureId_key" ON "generation_jobs"("figureId");

-- CreateIndex
CREATE INDEX "sessions_ownerId_idx" ON "sessions"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "teammates_threadId_key" ON "teammates"("threadId");

-- CreateIndex
CREATE INDEX "teammates_parentSessionId_status_idx" ON "teammates"("parentSessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "teammates_parentSessionId_name_key" ON "teammates"("parentSessionId", "name");

-- CreateIndex
CREATE INDEX "teammate_mailbox_messages_parentSessionId_recipientTeammateId_createdAt_idx" ON "teammate_mailbox_messages"("parentSessionId", "recipientTeammateId", "createdAt");

-- CreateIndex
CREATE INDEX "teammate_mailbox_messages_recipientTeammateId_readAt_invalidatedAt_idx" ON "teammate_mailbox_messages"("recipientTeammateId", "readAt", "invalidatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "teammate_mailbox_waits_threadId_key" ON "teammate_mailbox_waits"("threadId");

-- CreateIndex
CREATE INDEX "teammate_mailbox_waits_parentSessionId_recipientTeammateId_idx" ON "teammate_mailbox_waits"("parentSessionId", "recipientTeammateId");

-- CreateIndex
CREATE INDEX "session_messages_sessionId_turn_idx" ON "session_messages"("sessionId", "turn");

-- CreateIndex
CREATE UNIQUE INDEX "session_messages_sessionId_clientKey_key" ON "session_messages"("sessionId", "clientKey");

-- CreateIndex
CREATE INDEX "checkpoints_threadId_checkpointNs_idx" ON "checkpoints"("threadId", "checkpointNs");

-- CreateIndex
CREATE INDEX "checkpoint_writes_threadId_checkpointNs_idx" ON "checkpoint_writes"("threadId", "checkpointNs");

-- CreateIndex
CREATE INDEX "tool_approval_logs_traceId_idx" ON "tool_approval_logs"("traceId");

-- CreateIndex
CREATE INDEX "tool_approval_logs_userId_createdAt_idx" ON "tool_approval_logs"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "provider_endpoints_scheme_host_port_key" ON "provider_endpoints"("scheme", "host", "port");

-- CreateIndex
CREATE INDEX "llm_usage_records_userId_createdAt_idx" ON "llm_usage_records"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "llm_usage_records_model_createdAt_idx" ON "llm_usage_records"("model", "createdAt");

-- CreateIndex
CREATE INDEX "llm_usage_records_runId_idx" ON "llm_usage_records"("runId");

-- CreateIndex
CREATE INDEX "attachments_ownerId_idx" ON "attachments"("ownerId");

-- CreateIndex
CREATE INDEX "attachments_sessionId_idx" ON "attachments"("sessionId");

-- CreateIndex
CREATE INDEX "file_journal_sessionId_checkpointId_idx" ON "file_journal"("sessionId", "checkpointId");

-- CreateIndex
CREATE UNIQUE INDEX "file_journal_sessionId_seq_key" ON "file_journal"("sessionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "file_journal_sessionId_toolCallId_key" ON "file_journal"("sessionId", "toolCallId");

-- CreateIndex
CREATE INDEX "file_overwrite_logs_sessionId_path_idx" ON "file_overwrite_logs"("sessionId", "path");

-- CreateIndex
CREATE INDEX "file_overwrite_logs_createdAt_idx" ON "file_overwrite_logs"("createdAt");

