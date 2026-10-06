// S1 端到端（#782）：agent 工具调用打点（journaling backend + ALS toolCallId + runId 回填）→
// rewind 三态 REST（all/chat/files）→ 逆放恢复一致性 + preview exec 跨越清单 + C1 信箱通知。
// 基建对齐 sessionsHistoryApi.test.ts（ScriptedChatModel + fakePrimitives + 真 StreamHub + 临时 SQLite）。

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import supertest, { type SuperTest, type Test } from 'supertest'
import { AIMessage } from '@langchain/core/messages'
import { createPrismaClient } from '../src/prisma'
import { createApp } from '../src/app'
import type { PrismaClient } from '../src/generated/prisma/client'
import { StreamHub, type StreamSink } from '../src/events/hub'
import { seedUser, login, bearer, waitFor } from './helpers'
import { ScriptedChatModel, toolCallAi, type ScriptEntry } from './runnerFakes'
import { fakeFs } from './fileJournalTestkit'
import { RunService } from '../src/runner/runtime/runService'
import { ProviderRegistry } from '../src/runner/providerRegistry'
import { ConcurrencyGate } from '../src/runner/concurrency'
import { PrismaCheckpointSaver } from '../src/runner/persistence/prismaCheckpointSaver'
import { SessionService } from '../src/sessions/service'
import { FileJournalService } from '../src/runner/filejournal/service'
import { PENDING_CHECKPOINT_ID } from '../src/runner/filejournal/values'
import { CODE } from '../src/codes'
import { installAbortRejectionGuard } from '../src/runner/runtime/abortGuard'

const LAB = 'researcher-sandbox-fjapi'

function makeSink(): { sink: StreamSink; frames: string[] } {
  const frames: string[] = []
  return {
    sink: {
      send: (w) => {
        frames.push(w)
        return true
      },
      close: () => {},
    },
    frames,
  }
}

function frameEvents(frames: string[]): Array<{ type: string; payload: unknown }> {
  return frames
    .filter((f) => f.startsWith('id: '))
    .map((f) => JSON.parse(/^data: (.+)$/m.exec(f)![1]))
}

describe('文件 rewind 端到端（S1，#782）', () => {
  let prisma: PrismaClient
  let request: SuperTest<Test>
  let hub: StreamHub
  let sink: { sink: StreamSink; frames: string[] }
  let access: string
  let runService: RunService
  let sessions: SessionService
  let fileJournal: FileJournalService
  let owner: { id: string; username: string }
  const cleanupDirs: string[] = []
  let currentScript: ScriptEntry[] = []
  let keySeq = 0x500
  const hexKey = () => (keySeq++).toString(16).padStart(32, '0')
  const labFs = fakeFs()
  // 慢执行开关（running 窗口制造——对齐 sessionsApi 手法；exec 前 200ms 延迟，afterEach 复位）
  let slowExec = false
  const baseExec = labFs.primitives.exec.bind(labFs.primitives)
  labFs.primitives.exec = async (container, cmd, opts) => {
    if (slowExec) await new Promise((r) => setTimeout(r, 200))
    return baseExec(container, cmd, opts)
  }

  // session 沙箱预言容器名（createSession 面非 LAB 常量——backend targets 随 session 行）
  // 图缓存失效（每轮换脚本数组 → 须换 configVersion 键——否则缓存图持旧 model、脚本耗尽）
  async function bumpVersion(): Promise<void> {
    await prisma.configMeta.upsert({
      where: { id: 1 },
      update: { version: { increment: 1 } },
      create: { id: 1, version: 2 },
    })
  }

  async function containerIdOf(sid: string): Promise<string> {
    return (await prisma.session.findUniqueOrThrow({ where: { id: sid }, select: { containerId: true } })).containerId
  }
  async function labFile(sid: string, rel: string): Promise<string | undefined> {
    return labFs.trees.get(await containerIdOf(sid))?.get(`/lab/${rel}`)?.toString()
  }

  beforeAll(async () => {
    installAbortRejectionGuard()
    const dir = mkdtempSync(path.join(tmpdir(), 'filejournal-api-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'fjapi-user1', 'pw-fjapi1-secure')
    owner = { id: user.id, username: user.username }
    await prisma.session.create({ data: { id: 'sess-fjapi-seed', ownerId: user.id, containerId: LAB, title: '' } })
    await prisma.modelProvider.create({
      data: {
        ownerId: user.id,
        providerId: 'prov-1',
        lcProvider: 'openai',
        baseUrl: 'https://llm.example.edu/v1',
        credentialEnvId: 'LLM_API_KEY',
        authHeader: true,
        modelsJson: JSON.stringify([{ id: 'model-x' }]),
      },
    })
    await prisma.providerEndpoint.create({
      data: { scheme: 'https', host: 'llm.example.edu', port: null, createdBy: 'seed' },
    })

    hub = new StreamHub()
    sink = makeSink()
    hub.register(user.id, sink.sink)

    fileJournal = new FileJournalService({
      prisma,
      primitives: labFs.primitives,
      quotaBytes: 16 * 1024 * 1024,
      depthLimit: 1000,
      fenceTimeoutMs: 200,
      containerOf: async (sessionId) =>
        (await prisma.session.findUniqueOrThrow({ where: { id: sessionId }, select: { containerId: true } })).containerId,
      checkpointParentOf: async (sessionId) => {
        const rows = await prisma.checkpoint.findMany({
          where: { threadId: sessionId, archivedAt: null },
          select: { checkpointId: true, parentCheckpointId: true },
        })
        return new Map(rows.map((r) => [r.checkpointId, r.parentCheckpointId]))
      },
    })

    const registry = new ProviderRegistry(prisma, {
      llmApiKey: 'test-key',
      modelFactory: async () => new ScriptedChatModel(currentScript),
    })
    const { TeammateService } = await import('../src/runner/teammates/service')
    const teammates = new TeammateService(prisma)
    runService = new RunService({
      prisma,
      registry,
      saver: new PrismaCheckpointSaver(prisma),
      gate: new ConcurrencyGate({ globalLimit: 8, loadUserLimit: async () => 8 }),
      hub,
      primitives: labFs.primitives,
      resolveWikiContainer: () => 'researcher-wiki-u1',
      fileJournal,
      teammates,
      clock: (() => {
        let t = 0
        return () => (t += 10)
      })(),
    })
    sessions = new SessionService({
      prisma,
      hub,
      runService,
      dispatch: (cmd) => {
        void runService.execute(cmd).catch(() => {})
        return Promise.resolve()
      },
      fileRewind: {
        rewindFiles: (p) => fileJournal.rewindFiles(p),
        rewindFilesCore: (p) => fileJournal.rewindFilesCore(p),
        runRewindExclusive: (sessionId, fn) => fileJournal.runRewindExclusive(sessionId, fn),
        preview: (p) => fileJournal.preview(p),
      },
    })
    runService.setRecordTurn((p) => sessions.recordTurn(p))

    const app = createApp({ prisma, events: { hub }, sessions: { service: sessions } })
    request = supertest(app) as unknown as SuperTest<Test>

    const res = await login(request, 'fjapi-user1', 'pw-fjapi1-secure')
    access = res.access!
  }, 30_000)

  afterAll(async () => {
    await prisma.$disconnect()
  })

  afterEach(async () => {
    currentScript = []
    slowExec = false
    // config version bump：图缓存键失效（同 session 下轮重建图——新 ScriptedChatModel 实例）
    await prisma.configMeta.upsert({
      where: { id: 1 },
      update: { version: { increment: 1 } },
      create: { id: 1, version: 2 },
    })
    await prisma.session.deleteMany({ where: { isTeammate: false, id: { not: 'sess-fjapi-seed' } } })
    await prisma.fileJournal.deleteMany({})
    for (const t of labFs.trees.values()) t.clear()
  })

  it('agent 写工具全量打点：journal 行（toolCallId 幂等键 + runId + pending checkpointId）→ 终态回填', async () => {
    currentScript = [
      toolCallAi('call-w1', 'write_file', { path: '/lab/dot.txt', content: 'hello' }, '写文件。'),
      new AIMessage({ content: '写好了。' }),
    ]
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: '打点会话' })
    const sid = created.body.data.id as string
    const res = await request
      .post(`/api/v1/sessions/${sid}/messages`)
      .set(bearer(access))
      .set('Idempotency-Key', hexKey())
      .send({ content: '写' })
    expect(res.body.code).toBe(CODE.OK)
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')

    const rows = await prisma.fileJournal.findMany({ where: { sessionId: sid } })
    expect(rows.length).toBe(1)
    const row = rows[0]!
    expect(row).toMatchObject({ op: 'write', path: 'dot.txt', applied: true, archivedAt: null })
    expect(row.toolCallId).toBe('call-w1') // ALS 真实 tool_call_id（幂等键）
    expect(row.runId).toBeTruthy()
    expect(row.checkpointId).not.toBe(PENDING_CHECKPOINT_ID) // 终态回填已发生
    // 文件落盘 + attic after blob
    expect(await labFile(sid, 'dot.txt')).toBe('hello')
    const { AtticStore } = await import('../src/runner/filejournal/attic')
    const attic = new AtticStore(labFs.primitives, { quotaBytes: 1 })
    expect(await attic.hasBlob(await containerIdOf(sid), row.afterSha256!)).toBe(true)
  })

  it('scope=all：逆放恢复 /lab 至锚点时刻（两轮写 → 回退第一轮）+ files 结果面', async () => {
    // 轮1 写 a.txt=hello；轮2 覆盖 a.txt=world
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: '逆放会话' })
    const sid = created.body.data.id as string
    const anchors: string[] = []
    for (const v of ['hello', 'world']) {
      currentScript = [toolCallAi(`call-${v}`, 'write_file', { path: '/lab/a.txt', content: v }, '写。'), new AIMessage({ content: '好。' })]
      await bumpVersion()
      const res = await request
        .post(`/api/v1/sessions/${sid}/messages`)
        .set(bearer(access))
        .set('Idempotency-Key', hexKey())
        .send({ content: `写 ${v}` })
      expect(res.body.code).toBe(CODE.OK)
      await waitFor(() => runService.stateOf(sid)?.state === 'completed')
      // recordTurn 异步落行（run.completed 后 fail-soft 面）——行存在且带锚才算轮终态齐
      await waitFor(async () => {
        const r = await prisma.sessionMessage.findFirst({ where: { sessionId: sid, role: 'assistant' }, select: { anchorCheckpointId: true } })
        return r !== null && r.anchorCheckpointId !== null
      })
      const row = await prisma.sessionMessage.findFirst({ where: { sessionId: sid, role: 'assistant' }, orderBy: { turn: 'desc' } })
      anchors.push(row!.anchorCheckpointId!)
    }
    expect(await labFile(sid, 'a.txt')).toBe('world')

    const rw = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: (await prisma.sessionMessage.findFirstOrThrow({ where: { sessionId: sid, role: 'assistant' }, orderBy: { turn: 'asc' } })).id })
    expect(rw.body.code).toBe(CODE.OK)
    expect(rw.body.data).toMatchObject({ sessionId: sid, scope: 'all', activeCheckpointId: anchors[0] })
    expect(rw.body.data.files).toMatchObject({ degraded: false })
    // /lab 恢复至锚点时刻 = hello
    expect(await labFile(sid, 'a.txt')).toBe('hello')
    // 水位推进 + 行处置
    const sess = await prisma.session.findUniqueOrThrow({ where: { id: sid } })
    expect(sess.fileJournalAnchorSeq).toBe(1) // 轮1 行 ∈ 锚链
    // invalidated 帧
    const frames = frameEvents(sink.frames).filter((f) => f.type === 'session.invalidated')
    expect(frames.at(-1)).toMatchObject({ payload: { reason: 'rewind' } })
  })

  it('scope=chat：只回对话——文件保持现状 + 水位永久化', async () => {
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: 'chat 三态' })
    const sid = created.body.data.id as string
    for (const v of ['v1', 'v2']) {
      currentScript = [toolCallAi(`call-c-${v}`, 'write_file', { path: '/lab/c.txt', content: v }, ''), new AIMessage({ content: '好。' })]
      await bumpVersion()
      await request
        .post(`/api/v1/sessions/${sid}/messages`)
        .set(bearer(access))
        .set('Idempotency-Key', hexKey())
        .send({ content: v })
      await waitFor(() => runService.stateOf(sid)?.state === 'completed')
    }
    const firstAssistant = await prisma.sessionMessage.findFirstOrThrow({ where: { sessionId: sid, role: 'assistant' }, orderBy: { turn: 'asc' } })
    const rw = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: firstAssistant.id, scope: 'chat' })
    expect(rw.body.code).toBe(CODE.OK)
    expect(rw.body.data.files).toBeUndefined() // chat 无文件面
    expect(await labFile(sid, 'c.txt')).toBe('v2') // 保持现状
    const sess = await prisma.session.findUniqueOrThrow({ where: { id: sid } })
    expect(sess.fileJournalAnchorSeq).toBe(2) // 水位推进 = max seq
  })

  it('scope=files：只回文件——/lab 恢复 + 对话投影与指针不动', async () => {
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: 'files 三态' })
    const sid = created.body.data.id as string
    for (const v of ['f1', 'f2']) {
      currentScript = [toolCallAi(`call-f-${v}`, 'write_file', { path: '/lab/f.txt', content: v }, ''), new AIMessage({ content: '好。' })]
      await bumpVersion()
      await request
        .post(`/api/v1/sessions/${sid}/messages`)
        .set(bearer(access))
        .set('Idempotency-Key', hexKey())
        .send({ content: v })
      await waitFor(() => runService.stateOf(sid)?.state === 'completed')
    }
    const before = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    const firstAssistant = await prisma.sessionMessage.findFirstOrThrow({ where: { sessionId: sid, role: 'assistant' }, orderBy: { turn: 'asc' } })
    const beforePtr = (await prisma.session.findUniqueOrThrow({ where: { id: sid } })).activeCheckpointId

    const rw = await request
      .post(`/api/v1/sessions/${sid}/rewind`)
      .set(bearer(access))
      .send({ messageId: firstAssistant.id, scope: 'files' })
    expect(rw.body.code).toBe(CODE.OK)
    expect(rw.body.data.files).toMatchObject({ degraded: false })
    expect(await labFile(sid, 'f.txt')).toBe('f1') // 文件恢复
    // 对话面不动：指针不变、投影不变、消息行未归档
    const afterPtr = (await prisma.session.findUniqueOrThrow({ where: { id: sid } })).activeCheckpointId
    expect(afterPtr).toBe(beforePtr)
    const after = await request.get(`/api/v1/sessions/${sid}/messages`).set(bearer(access))
    expect(after.body.data.messages.length).toBe(before.body.data.messages.length)
  })

  it('preview：逆放摘要 + exec 跨越清单（复用轨迹聚合零新增存储）', async () => {
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: '预览会话' })
    const sid = created.body.data.id as string
    // 轮1：写文件（锚前基线）；轮2：exec + 写文件
    currentScript = [toolCallAi('call-p0', 'write_file', { path: '/lab/p.txt', content: 'base' }, ''), new AIMessage({ content: '好。' })]
    await request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey()).send({ content: '1' })
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')
    currentScript = [
      toolCallAi('call-ex', 'execute', { command: 'rm -rf /lab/p.txt' }, ''),
      toolCallAi('call-p1', 'write_file', { path: '/lab/q.txt', content: 'q' }, ''),
      new AIMessage({ content: '好。' }),
    ]
    await bumpVersion()
    await request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey()).send({ content: '2' })
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')

    const firstAssistant = await prisma.sessionMessage.findFirstOrThrow({ where: { sessionId: sid, role: 'assistant' }, orderBy: { turn: 'asc' } })
    const both = await prisma.sessionMessage.findMany({ where: { sessionId: sid, role: 'assistant' }, orderBy: { turn: 'asc' } })
    const anchor1 = both[0]!.anchorCheckpointId!
    const anchor2 = both[1]!.anchorCheckpointId!

    // teammate 面：共享 /lab 的 exec 副作用同不可逆放——存活跨派生点（派生点 = 轮2 锚 ∉
    // chain(轮1 锚)）的 exec 入清单；锚前派生（派生点 = 轮1 锚 ∈ chain）不入。
    await prisma.session.create({ data: { id: 'tm-prev-crossed', ownerId: owner.id, containerId: LAB, isTeammate: true } })
    await prisma.session.create({ data: { id: 'tm-prev-safe', ownerId: owner.id, containerId: LAB, isTeammate: true } })
    await prisma.teammate.createMany({
      data: [
        { id: 'tm-prev-crossed', parentSessionId: sid, threadId: 'tm-prev-crossed', name: '越线预览', task: 'x', status: 'running', spawnedAtCheckpointId: anchor2 },
        { id: 'tm-prev-safe', parentSessionId: sid, threadId: 'tm-prev-safe', name: '锚前预览', task: 'y', status: 'running', spawnedAtCheckpointId: anchor1 },
      ],
    })
    for (const tid of ['tm-prev-crossed', 'tm-prev-safe']) {
      await prisma.sessionMessage.create({
        data: {
          sessionId: tid, turn: 1, role: 'assistant',
          anchorCheckpointId: tid === 'tm-prev-crossed' ? anchor2 : anchor1,
          attachmentsJson: JSON.stringify({ v: 1, tools: [{ toolCallId: `tm-ex-${tid}`, name: 'execute', input: 'ls /lab' }] }),
        },
      })
    }

    const res = await request
      .post(`/api/v1/sessions/${sid}/rewind/preview`)
      .set(bearer(access))
      .send({ messageId: firstAssistant.id })
    expect(res.body.code).toBe(CODE.OK)
    expect(res.body.data.anchor).toBe(anchor1)
    expect(res.body.data.revertOps).toBe(1) // 基线行 ∈ 锚链保留；exec 轮的 q.txt ∉ chain 逆放
    expect(res.body.data.pathTotal).toBe(1)
    // exec 跨越清单：轮2 的 execute 调用 + 跨派生点 teammate 的 execute + 锚前派生存活者
    //（时间面：其种子行 createdAt 晚于锚1 checkpoint 落盘时刻 → 保守入清单——宁多列不漏列）
    const crossed = res.body.data.execCrossed as Array<{ toolCallId: string; input: string }>
    expect(crossed.some((c) => c.toolCallId === 'call-ex' && c.input.includes('rm -rf'))).toBe(true)
    expect(crossed.some((c) => c.toolCallId === 'tm-ex-tm-prev-crossed')).toBe(true)
    expect(crossed.some((c) => c.toolCallId === 'tm-ex-tm-prev-safe')).toBe(true)
  })

  it('preview 锚点 checkpoint 已归档（行未归档机制性不一致态）：与执行面同拒', async () => {
    currentScript = [new AIMessage({ content: '好。' })]
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: '预览兜底' })
    const sid = created.body.data.id as string
    await request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey()).send({ content: '1' })
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')
    const assistant = await prisma.sessionMessage.findFirstOrThrow({ where: { sessionId: sid, role: 'assistant' } })
    // checkpoint 行归档、消息行不动——listHistoryRows 滤不到的机制性不一致态
    await prisma.checkpoint.updateMany({ where: { threadId: sid }, data: { archivedAt: new Date() } })
    const res = await request
      .post(`/api/v1/sessions/${sid}/rewind/preview`)
      .set(bearer(access))
      .send({ messageId: assistant.id })
    expect(res.body.code).toBe(CODE.VALIDATION_FAILED)
  })

  it('preview 门禁与执行面同形：run 非终态时 50005（执行不可达时预览不预告可行）', async () => {
    slowExec = true
    currentScript = [toolCallAi('call-slow', 'execute', { command: 'slow' }, ''), new AIMessage({ content: '好。' })]
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: '预览门禁' })
    const sid = created.body.data.id as string
    await request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey()).send({ content: '1' })
    await waitFor(() => runService.stateOf(sid)?.state === 'running')
    const res = await request.post(`/api/v1/sessions/${sid}/rewind/preview`).set(bearer(access)).send({ messageId: 'any' })
    expect(res.body.code).toBe(CODE.RUN_IN_PROGRESS)
    slowExec = false
    await waitFor(() => runService.stateOf(sid)?.state === 'completed')
  })

  it('双端并发 rewind：会话级互斥串行化——指针恒指向未归档 checkpoint、被归档锚点 90002', async () => {
    // 两轮产生锚 A（轮1）、B（轮2）
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: '并发 rewind' })
    const sid = created.body.data.id as string
    for (const v of ['1', '2']) {
      currentScript = [toolCallAi(`call-cc-${v}`, 'write_file', { path: `/lab/cc${v}.txt`, content: v }, ''), new AIMessage({ content: '好。' })]
      await bumpVersion()
      await request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey()).send({ content: v })
      await waitFor(() => runService.stateOf(sid)?.state === 'completed')
    }
    const both = await prisma.sessionMessage.findMany({ where: { sessionId: sid, role: 'assistant' }, orderBy: { turn: 'asc' } })
    // 并发双端：回退轮2（锚 B）+ 回退轮1（锚 A）——完成顺序不定。A ∈ chain(B) 恒合法；
    // A 先完成则 B 已被归档 → B 端锁内 90002（无锁视图交错会写悬空指针）
    const [r1, r2] = await Promise.all([
      request.post(`/api/v1/sessions/${sid}/rewind`).set(bearer(access)).send({ messageId: both[1]!.id }),
      request.post(`/api/v1/sessions/${sid}/rewind`).set(bearer(access)).send({ messageId: both[0]!.id }),
    ])
    const codes = [r1.body.code, r2.body.code]
    expect(codes).toContain(CODE.OK) // A 锚恒合法（∈ 任何 chain）
    for (const c of codes) {
      expect([CODE.OK, CODE.VALIDATION_FAILED]).toContain(c) // 非预期码 = 互斥面破
    }
    // 指针不悬空：activeCheckpointId 必在未归档 checkpoint 集内
    const sess = await prisma.session.findUniqueOrThrow({ where: { id: sid }, select: { activeCheckpointId: true } })
    if (sess.activeCheckpointId !== null) {
      const ck = await prisma.checkpoint.findFirst({
        where: { threadId: sid, checkpointId: sess.activeCheckpointId, archivedAt: null },
      })
      expect(ck).not.toBeNull()
    }
  })

  it('C1：存活 teammate 在 scope=all rewind 后收信箱系统消息', async () => {
    // teammates deps 已在 beforeAll 注入 RunService——直接驱动 C1 方法面
    const created = await request.post('/api/v1/sessions').set(bearer(access)).send({ title: 'C1 会话' })
    const sid = created.body.data.id as string
    for (const v of ['1', '2']) {
      currentScript = [toolCallAi(`call-t-${v}`, 'write_file', { path: '/lab/t.txt', content: v }, ''), new AIMessage({ content: '好。' })]
      await bumpVersion()
      await request.post(`/api/v1/sessions/${sid}/messages`).set(bearer(access)).set('Idempotency-Key', hexKey()).send({ content: v })
      await waitFor(() => runService.stateOf(sid)?.state === 'completed')
      await waitFor(async () => (await prisma.sessionMessage.count({ where: { sessionId: sid, role: 'assistant' } })) === Number(v))
    }
    const rows = await prisma.sessionMessage.findMany({ where: { sessionId: sid, role: 'assistant' }, orderBy: { turn: 'asc' } })
    const anchor = rows[0]!.anchorCheckpointId!
    const laterAnchor = rows[1]!.anchorCheckpointId!

    // 种存活 teammate（派生点 = 回退锚 ∈ chain → 存活）+ 跨派生点 teammate（派生点 = 第二轮锚 ∉
    // chain(回退锚) → 作废；threadId FK → Session 行）
    await prisma.session.create({ data: { id: 'tm-thread-1', ownerId: owner.id, containerId: LAB, isTeammate: true } })
    await prisma.session.create({ data: { id: 'tm-thread-2', ownerId: owner.id, containerId: LAB, isTeammate: true } })
    const tm1 = await prisma.teammate.create({
      data: { id: 'tm-survivor', parentSessionId: sid, threadId: 'tm-thread-1', name: '幸存者', task: 'x', status: 'running', spawnedAtCheckpointId: anchor },
    })
    await prisma.teammate.create({
      data: { id: 'tm-doomed', parentSessionId: sid, threadId: 'tm-thread-2', name: '越线者', task: 'y', status: 'running', spawnedAtCheckpointId: laterAnchor },
    })

    // 生产装配序（rewindSession）：作废面先行（逆放前）→ 通知面（逆放后——此处方法面直驱同序）
    await runService.teammatesForRewind(sid, anchor)
    await runService.teammatesNotifyFileRewind(sid, anchor, false)
    // 存活者收信箱；越线者被作废（archivedAt）且无信箱
    const mail = await prisma.teammateMailboxMessage.findMany({ where: { parentSessionId: sid, recipientTeammateId: tm1.id, invalidatedAt: null } })
    expect(mail.length).toBe(1)
    expect(mail[0]!.kind).toBe('system')
    expect(mail[0]!.content).toContain('文件状态已回退至锚点')
    const doomed = await prisma.teammate.findUniqueOrThrow({ where: { id: 'tm-doomed' } })
    expect(doomed.archivedAt).not.toBeNull()
  })
})
