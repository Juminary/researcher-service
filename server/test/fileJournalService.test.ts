// FileJournalService 集成（#782 · S2 fake-primitives + 真 SQLite）：JournalingBackend 打点
// 行为 / 逆放恢复一致性（含上传回退）/ scope 三态 / C1 多 thread / reconcile / GC / 围栏。

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { FileJournalService } from '../src/runner/filejournal/service'
import { PENDING_CHECKPOINT_ID } from '../src/runner/filejournal/values'
import { MAX_COLLECT_BYTES } from '../src/runner/backend/values'
import { fakeFs } from './fileJournalTestkit'
import { seedUser } from './helpers'

const CONTAINER = 'researcher-sandbox-fj'
const SESSION = 'sess-fj'

// lab 树读取快照（逆放一致性断言面）：path → 文本内容（/lab 根直读 fake 树）。
function labSnapshot(fs: ReturnType<typeof fakeFs>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [p, v] of fs.trees.get(CONTAINER) ?? []) {
    if (!p.startsWith('/lab/') || v === 'dir') continue
    out[p.slice('/lab/'.length)] = v.toString('utf8')
  }
  return out
}

describe('FileJournalService（#782）', () => {
  let prisma: PrismaClient
  let svc: FileJournalService
  const cleanupDirs: string[] = []
  const fs = fakeFs()

  async function seedSession(partial: Partial<{ fileJournalAnchorSeq: number | null; activeCheckpointId: string | null }> = {}): Promise<void> {
    const user = await prisma.user.findFirstOrThrow()
    await prisma.session.create({
      data: {
        id: SESSION,
        ownerId: user.id,
        containerId: CONTAINER,
        fileJournalAnchorSeq: partial.fileJournalAnchorSeq ?? null,
        activeCheckpointId: partial.activeCheckpointId ?? null,
      },
    })
  }

  // checkpoint 父链种子：root → A → B → C（线性；teammate ck 不入表）
  const parentOf = new Map<string, string | null>([
    ['root', null],
    ['ckA', 'root'],
    ['ckB', 'ckA'],
    ['ckC', 'ckB'],
  ])

  // JournalingBackend 写助手（模拟 agent 工具调用；checkpointId = pending）
  function backend() {
    return svc.backendFor({ sessionId: SESSION, targets: { wiki: 'w-1', lab: CONTAINER } })
  }

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'filejournal-svc-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'fj-user', 'pw-fj1-secure')
    await prisma.session.create({ data: { id: 'sess-other', ownerId: user.id, containerId: 'c-other' } })
    svc = new FileJournalService({
      prisma,
      primitives: fs.primitives,
      quotaBytes: 10 * 1024 * 1024,
      depthLimit: 1000,
      fenceTimeoutMs: 200,
      containerOf: async (id) => (id === SESSION ? CONTAINER : null),
      checkpointParentOf: async () => parentOf,
    })
  })

  afterEach(async () => {
    await prisma.fileJournal.deleteMany({})
    await prisma.sessionMessage.deleteMany({})
    await prisma.session.deleteMany({ where: { id: SESSION } })
    await prisma.textTraceLog.deleteMany({})
    fs.trees.get(CONTAINER)?.clear()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // JournalingBackend 打点行为
  // ---------------------------------------------------------------------------

  it('write/edit/delete 全量打点：pending checkpointId、前后像、tombstone、seq 全序', async () => {
    await seedSession()
    const b = backend()
    expect((await b.write('/lab/a.txt', 'v1')).error).toBeUndefined()
    expect((await b.edit('/lab/a.txt', 'v1', 'v2')).error).toBeUndefined()
    expect((await b.write('/lab/b.txt', 'g')).error).toBeUndefined()
    expect((await b.delete('/lab/a.txt')).error).toBeUndefined()

    const rows = await prisma.fileJournal.findMany({ where: { sessionId: SESSION }, orderBy: { seq: 'asc' } })
    expect(rows.map((r) => [r.op, r.path])).toEqual([
      ['write', 'a.txt'],
      ['edit', 'a.txt'],
      ['write', 'b.txt'],
      ['delete', 'a.txt'],
    ])
    expect(rows.every((r) => r.checkpointId === PENDING_CHECKPOINT_ID && r.applied && r.runId === null)).toBe(true)
    const del = rows[3]!
    expect(del.beforeSha256).not.toBeNull()
    expect(del.afterSha256).toBeNull()
    expect(del.tombstoneKey).toBe(del.beforeSha256)
    // /lab 状态：a.txt 已删、b.txt 在
    expect(labSnapshot(fs)).toEqual({ 'b.txt': 'g' })
  })

  it('/wiki 写不打点；幂等键 ALS 缺席降级唯一键；edit 错误面（多命中）不打点', async () => {
    await seedSession()
    const b = backend()
    expect((await b.write('/wiki/page.md', 'w')).error).toBeUndefined()
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(0)

    const r1 = await b.write('/lab/x.txt', '1')
    const r2 = await b.write('/lab/x.txt', '2')
    const rows = await prisma.fileJournal.findMany({ where: { sessionId: SESSION }, orderBy: { seq: 'asc' } })
    expect(rows.length).toBe(2)
    expect(rows[0]!.toolCallId).not.toBe(rows[1]!.toolCallId)
    void r1
    void r2

    // edit 多命中 → {error}，无新行
    await b.write('/lab/y.txt', 'aaa')
    const before = await prisma.fileJournal.count({ where: { sessionId: SESSION } })
    expect((await b.edit('/lab/y.txt', 'a', 'b', true)).error).toBeUndefined()
    expect((await b.edit('/lab/y.txt', 'nope', 'z')).error).toBeDefined()
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(before + 1)
  })

  it('attic 配额超限：op 拒绝（fail-closed）、journal 零行、文件不动', async () => {
    await seedSession()
    const tight = new FileJournalService({
      prisma,
      primitives: fs.primitives,
      quotaBytes: 1024, // 1KB——大内容超限
      depthLimit: 100,
      fenceTimeoutMs: 200,
      containerOf: async () => CONTAINER,
      checkpointParentOf: async () => parentOf,
    })
    const b = tight.backendFor({ sessionId: SESSION, targets: { wiki: 'w-1', lab: CONTAINER } })
    const big = 'x'.repeat(4000)
    const r = await b.write('/lab/big.txt', big)
    expect(r.error).toBeDefined()
    expect(r.error).toContain('quota')
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(0)
    expect(fs.trees.get(CONTAINER)?.get('/lab/big.txt')).toBeUndefined()
    // 观测面：attic_quota_reject 审计事件落账（静默拒绝不可接受；record 在上抛前 await）
    const auditRow = await prisma.textTraceLog.findFirstOrThrow({ where: { sessionKey: SESSION } })
    expect(auditRow.traceId).toContain('file-journal:')
    expect(auditRow.inputText).toContain('attic_quota_reject')
    expect(auditRow.inputText).toContain('big.txt')
  })

  it('delete 目录快照：干净目录完整打点可逆放；含超限子文件 fail-closed 拒绝（部分树打点即误导）', async () => {
    await seedSession()
    const tree = fs.trees.get(CONTAINER)!
    const b = backend()
    // 干净目录：全树入快照
    await b.write('/lab/dir/a.txt', 'a')
    await b.write('/lab/dir/b.txt', 'b')
    const countBefore = await prisma.fileJournal.count({ where: { sessionId: SESSION } })
    expect((await b.delete('/lab/dir')).error).toBeUndefined()
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(countBefore + 1)
    const delRow = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, op: 'delete' } })
    expect(delRow.path).toBe('dir')
    expect(delRow.beforeSha256).not.toBeNull()
    // 含超限子文件：快照不完整 → 拒绝（零新行、树不动）
    tree.set('/lab/bigdir', 'dir')
    tree.set('/lab/bigdir/huge.bin', Buffer.alloc(MAX_COLLECT_BYTES + 1, 7))
    tree.set('/lab/bigdir/small.txt', Buffer.from('s'))
    const r = await b.delete('/lab/bigdir')
    expect(r.error).toBeDefined()
    expect(r.error).toContain('delete files individually')
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(countBefore + 1)
    expect(tree.get('/lab/bigdir/huge.bin')).toBeDefined()
    expect(tree.get('/lab/bigdir/small.txt')).toBeDefined()
  })

  it('write 覆写超限既有文件：降级不打点直写（打点而逆操作错——beforeSha=null + op=write 逆放 remove——比无恢复面更危险）', async () => {
    await seedSession()
    const tree = fs.trees.get(CONTAINER)!
    tree.set('/lab/big.txt', Buffer.alloc(MAX_COLLECT_BYTES + 1, 7))
    const b = backend()
    expect((await b.write('/lab/big.txt', 'small')).error).toBeUndefined()
    // 降级面：零 journal 行（不误导「可恢复」）+ 文件已直写
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(0)
    expect(tree.get('/lab/big.txt')?.toString()).toBe('small')
    // not-found 仍新建语义打点（回归锚）
    expect((await b.write('/lab/new.txt', 'v')).error).toBeUndefined()
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(1)
  })

  it('journalMaterialize：checkpointId 直盖（media 物化面——回填已执行完，不直盖则恒 pending 误逆放）', async () => {
    await seedSession()
    await svc.journalMaterialize({
      sessionId: SESSION, container: CONTAINER, path: 'uploads/a1/img.png',
      bytes: Buffer.from('media-bytes'), toolCallId: 'media-a1', runId: 'run-1', checkpointId: 'ckB',
    })
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, toolCallId: 'media-a1' } })
    expect(row.checkpointId).toBe('ckB')
    // 缺省 → pending（ingestion 面——run 开始时终态未知，靠终态回填）
    await svc.journalMaterialize({
      sessionId: SESSION, container: CONTAINER, path: 'uploads/a2/f.bin',
      bytes: Buffer.from('upload'), toolCallId: 'ingest-a2', runId: 'run-1',
    })
    const row2 = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, toolCallId: 'ingest-a2' } })
    expect(row2.checkpointId).toBe(PENDING_CHECKPOINT_ID)
    expect(labSnapshot(fs)).toMatchObject({ 'uploads/a1/img.png': 'media-bytes', 'uploads/a2/f.bin': 'upload' })
  })

  it('/lab 根 delete 拒绝（fail-closed——全树删除无 rewind 恢复面）', async () => {
    await seedSession()
    const b = backend()
    await b.write('/lab/keep.txt', 'k')
    const r = await b.delete('/lab')
    expect(r.error).toBeDefined()
    // 树不动、不产生 journal 行
    expect(labSnapshot(fs)).toEqual({ 'keep.txt': 'k' })
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(1)
  })

  it('审计 traceId 防同毫秒碰撞：并发双事件都落账', async () => {
    await seedSession()
    const user = await prisma.user.findFirstOrThrow()
    await Promise.all([
      svc.preview({ sessionId: SESSION, anchor: 'root', caller: { userId: user.id, username: user.username } }),
      svc.preview({ sessionId: SESSION, anchor: 'root', caller: { userId: user.id, username: user.username } }),
    ])
    expect(await prisma.textTraceLog.count({ where: { sessionKey: SESSION } })).toBe(2)
  })

  // ---------------------------------------------------------------------------
  // 逆放恢复一致性（核心验收）
  // ---------------------------------------------------------------------------

  // 「run 终态回填」模拟：按 seq 集合回填 checkpointId（生产面按 runId——RunService 终态接线）。
  async function backfill(seqs: number[], checkpointId: string): Promise<void> {
    await prisma.fileJournal.updateMany({ where: { sessionId: SESSION, seq: { in: seqs } }, data: { checkpointId } })
  }

  it('逆放恢复 /lab 至锚点时刻：写/改/删混合 + 上传一并回退 + 非常规序', async () => {
    await seedSession()
    const b = backend()

    // —— 锚点 ckA 时刻的状态：f.txt = v0（历史 op，ckA 前的 run——行 checkpointId 回填 ckA 之前的 root）
    await b.write('/lab/f.txt', 'v0')
    await backfill([1], 'root')

    // —— 锚点之后的变更（ckB / ckC 两个 run）：
    // run-1 (ckB)：edit f.txt v0→v1；上传 uploads/att-1/doc.txt；write g.txt
    await b.edit('/lab/f.txt', 'v0', 'v1')
    await svc.journalMaterialize({ sessionId: SESSION, container: CONTAINER, path: 'uploads/att-1/doc.txt', bytes: Buffer.from('upload-bytes'), toolCallId: 'ingest-att-1', runId: 'run-1' })
    await b.write('/lab/g.txt', 'g1')
    // run-2 (ckC)：delete f.txt；write g.txt v2 覆盖
    await b.delete('/lab/f.txt')
    await b.write('/lab/g.txt', 'g2')

    const counts = await prisma.fileJournal.count({ where: { sessionId: SESSION } })
    expect(counts).toBe(6)

    // 锚点 ckA 时刻 = {f.txt: v0}；回退后应与之完全一致（含上传回退）
    const all = await prisma.fileJournal.findMany({ where: { sessionId: SESSION }, orderBy: { seq: 'asc' } })
    await backfill(all.slice(1, 4).map((r) => r.seq), 'ckB')
    await backfill(all.slice(4).map((r) => r.seq), 'ckC')
    const user = await prisma.user.findFirstOrThrow()
    const result = await svc.rewindFiles({ sessionId: SESSION, anchor: 'ckA', userId: user.id, username: user.username })
    expect(result.degraded).toBe(false)
    expect(result.reverted).toBe(5) // root 行保留；ckB×3 + ckC×2 逆放
    expect(labSnapshot(fs)).toEqual({ 'f.txt': 'v0' })
    // 水位推进至 chain 内最大 seq（root 行的 seq=1）
    const sess = await prisma.session.findUniqueOrThrow({ where: { id: SESSION } })
    expect(sess.fileJournalAnchorSeq).toBe(1)
    // 全部行已处置
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION, fileRevertedAt: null } })).toBe(0)
  })

  it('scope 语义面（rewindFiles 只管文件；水位推进使 chat 型保持现状永久化）', async () => {
    await seedSession()
    const b = backend()
    await b.write('/lab/keep.txt', 'before') // seq1 —— 未来锚点前的状态（回填 ∈ chain）
    await b.write('/lab/late.txt', 'after') // seq2 —— 锚后
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: 1 } }, data: { checkpointId: 'root' } })

    // scope=chat 型：调用方不调 rewindFiles、自行推进水位——此处直接模拟（对齐 sessions 面事务）
    const now = new Date()
    await prisma.fileJournal.updateMany({ where: { sessionId: SESSION, seq: { gt: 1 } }, data: { archivedAt: now } })
    await prisma.session.update({ where: { id: SESSION }, data: { fileJournalAnchorSeq: 2 } })
    // 文件保持现状
    expect(labSnapshot(fs)).toEqual({ 'keep.txt': 'before', 'late.txt': 'after' })

    // 随后 rewind 到更早锚（seq1 前——root 链）也只逆放未处置行：late.txt 已被水位越过 → 保持
    const user = await prisma.user.findFirstOrThrow()
    await svc.rewindFiles({ sessionId: SESSION, anchor: 'root', userId: user.id, username: user.username })
    expect(labSnapshot(fs)).toEqual({ 'keep.txt': 'before', 'late.txt': 'after' })
  })

  it('preview 判定式与逆放同形：水位已越过的行不进 revertOps', async () => {
    await seedSession()
    const b = backend()
    await b.write('/lab/p1.txt', '1')
    await b.write('/lab/p2.txt', '2')
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: 1 } }, data: { checkpointId: 'ckB' } })
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: 2 } }, data: { checkpointId: 'ckC' } })
    // scope=chat 型水位推进：seq1 未处置但被永久越过
    await prisma.session.update({ where: { id: SESSION }, data: { fileJournalAnchorSeq: 1 } })

    const out = await svc.preview({ sessionId: SESSION, anchor: 'root' })
    expect(out.revertOps).toBe(1) // 仅 seq2（ckC ∉ chain(root) 且 > 水位）；seq1 被水位排除
    expect(out.pathSample).toEqual(['p2.txt'])
    expect(out.pathTotal).toBe(1)
  })

  it('C1 多 thread：teammate 行（checkpointId 不在 leader chain）恒逆放；降级路径有测试', async () => {
    await seedSession()
    const b = backend()
    await b.write('/lab/base.txt', 'b1') // ckA 前（回填 root）
    // leader 后续 run + teammate 并发写交错
    await b.write('/lab/l1.txt', 'l1')
    await svc.journalMaterialize({ sessionId: SESSION, container: CONTAINER, path: 'uploads/att-2/m.png', bytes: Buffer.from('m'), toolCallId: 'ingest-att-2', runId: 'run-t' })
    await b.write('/lab/l2.txt', 'l2')
    // teammate 行 checkpointId 回填 teammate thread 域 id（不在 leader parentOf）
    const rows = await prisma.fileJournal.findMany({ where: { sessionId: SESSION }, orderBy: { seq: 'asc' } })
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: rows[0]!.seq } }, data: { checkpointId: 'root' } })
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: rows[1]!.seq } }, data: { checkpointId: 'ckB' } })
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: rows[2]!.seq } }, data: { checkpointId: 'teammate-ck-x' } })
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: rows[3]!.seq } }, data: { checkpointId: 'ckC' } })

    const user = await prisma.user.findFirstOrThrow()
    const result = await svc.rewindFiles({ sessionId: SESSION, anchor: 'ckA', userId: user.id, username: user.username })
    expect(result.reverted).toBe(3) // ckB + teammate-ck-x + ckC
    expect(labSnapshot(fs)).toEqual({ 'base.txt': 'b1' })
  })

  it('深度上限降级：超限 → 文件保持现状、行跳过式处置、degraded=true', async () => {
    await seedSession()
    const tiny = new FileJournalService({
      prisma,
      primitives: fs.primitives,
      quotaBytes: 10 * 1024 * 1024,
      depthLimit: 2,
      fenceTimeoutMs: 200,
      containerOf: async () => CONTAINER,
      checkpointParentOf: async () => parentOf,
    })
    const b = tiny.backendFor({ sessionId: SESSION, targets: { wiki: 'w-1', lab: CONTAINER } })
    for (let i = 0; i < 3; i++) await b.write(`/lab/d${i}.txt`, `v${i}`)
    const rows = await prisma.fileJournal.findMany({ where: { sessionId: SESSION } })
    for (const r of rows) await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: r.seq } }, data: { checkpointId: 'ckC' } })

    const user = await prisma.user.findFirstOrThrow()
    const result = await tiny.rewindFiles({ sessionId: SESSION, anchor: 'root', userId: user.id, username: user.username })
    expect(result.degraded).toBe(true)
    // 文件保持现状
    expect(labSnapshot(fs)).toEqual({ 'd0.txt': 'v0', 'd1.txt': 'v1', 'd2.txt': 'v2' })
    // 行全部处置（续放不再拾起）
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION, fileRevertedAt: null } })).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // reconcile（roll-forward + 续放）
  // ---------------------------------------------------------------------------

  it('roll-forward：applied=false 残留行在 rewindFiles 前置补 apply', async () => {
    await seedSession()
    // 预置一个 crash 残留（journal-first ②）：行在、apply 未达
    await prisma.fileJournal.create({
      data: {
        sessionId: SESSION, checkpointId: 'ckB', seq: 1, op: 'write', path: 'crash.txt',
        afterSha256: null, toolCallId: 'tc-crash-1', applied: false, runId: 'run-crash',
      },
    })
    // afterSha null → roll-forward 记 missing、置位（文件现状即真相）；不炸 rewind
    const user = await prisma.user.findFirstOrThrow()
    const result = await svc.rewindFiles({ sessionId: SESSION, anchor: 'root', userId: user.id, username: user.username })
    expect(result.degraded).toBe(false)
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION } })
    expect(row.applied).toBe(true)
    // 观测面：roll-forward 活动计数入审计域（D8——静默失败不可接受）
    const auditRow = await prisma.textTraceLog.findFirstOrThrow({ where: { sessionKey: SESSION } })
    expect(auditRow.inputText).toContain('"kind":"reconcile"')
    expect(auditRow.inputText).toContain('"rolledMissing":1')
  })

  it('boot reconcile 与并发面互斥：围栏被占时排队等待', async () => {
    await seedSession()
    // crash 残留行驱动 sessionsNeedingReconcile 命中本 session（write 无 afterSha → rolledMissing 面）
    await prisma.fileJournal.create({
      data: {
        sessionId: SESSION, checkpointId: PENDING_CHECKPOINT_ID, seq: 1, op: 'write', path: 'boot.txt',
        afterSha256: null, toolCallId: 'tc-boot', applied: false, runId: null,
      },
    })
    const hold = await svc.fence.acquire(SESSION, { holder: 'rewind-replay', timeoutMs: 0 })
    let done = false
    const boot = svc.reconcileOnBoot().then((o) => {
      done = true
      return o
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(done).toBe(false) // 围栏被占——boot 路排队未执行
    hold.release()
    const outcomes = await boot
    expect(outcomes.get(SESSION)).toMatchObject({ rolledMissing: 1, containerMissing: false })
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION, applied: true } })).toBe(1)
  })

  it('boot 续放 chain 过滤：崩溃残集续放、锚链内新写保留（activeCheckpointId 指针重建链）', async () => {
    await seedSession({ activeCheckpointId: 'ckB' })
    const b = backend()
    // 崩溃前 rewind 决策的 toRevert（ckC ∉ chain(ckB)）——未处置残集
    expect((await b.write('/lab/stale.txt', 'stale')).error).toBeUndefined()
    await prisma.fileJournal.update({
      where: { sessionId_seq: { sessionId: SESSION, seq: 1 } },
      data: { checkpointId: 'ckC' },
    })
    // 崩溃后新 run 的锚链内写（ckA ∈ chain(ckB)）——boot 串行遍历期间落账的合法新写
    expect((await b.write('/lab/fresh.txt', 'fresh')).error).toBeUndefined()
    await prisma.fileJournal.update({
      where: { sessionId_seq: { sessionId: SESSION, seq: 2 } },
      data: { checkpointId: 'ckA' },
    })
    // 上次 rewind tx 已提交：水位推进至 0（判据 seq > 0 两行皆入残集候选）
    await prisma.session.update({ where: { id: SESSION }, data: { fileJournalAnchorSeq: 0 } })
    await fs.trees.get(CONTAINER)!.delete('/lab/stale.txt') // 逆放中断时的文件现状

    await svc.reconcileOnBoot()
    // ckC 残集行续放处置；ckA 锚链内新写行未动（不误撤）
    const after1 = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, path: 'stale.txt' } })
    const after2 = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, path: 'fresh.txt' } })
    expect(after1.fileRevertedAt).not.toBeNull()
    expect(after2.fileRevertedAt).toBeNull()
    expect(fs.trees.get(CONTAINER)!.get('/lab/fresh.txt')?.toString()).toBe('fresh')
  })

  it('boot 水位 null 无短路：链内正常写行保护（从未 rewind 会话重启不误撤 /lab）', async () => {
    await seedSession({ activeCheckpointId: 'ckB' })
    const b = backend()
    // 从未 rewind（水位 null）的正常会话：链内 completed 行 + teammate 面行（∉ chain）+ pending ''
    expect((await b.write('/lab/normal.txt', 'keep')).error).toBeUndefined()
    await prisma.fileJournal.update({
      where: { sessionId_seq: { sessionId: SESSION, seq: 1 } },
      data: { checkpointId: 'ckA' }, // ∈ chain(ckB)——正常 completed 行
    })
    await svc.reconcileOnBoot()
    // 链内正常行不动（水位 null 短路会把整会话 /lab 全量逆放 = 数据破坏）
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, path: 'normal.txt' } })
    expect(row.fileRevertedAt).toBeNull()
    expect(fs.trees.get(CONTAINER)!.get('/lab/normal.txt')?.toString()).toBe('keep')
  })

  it('boot 续放深度护栏：残集超限跳过式处置（resumedDegraded——boot 面对齐 planRevert 降级语义）', async () => {
    await seedSession()
    const tiny = new FileJournalService({
      prisma,
      primitives: fs.primitives,
      quotaBytes: 10 * 1024 * 1024,
      depthLimit: 2,
      fenceTimeoutMs: 200,
      containerOf: async () => CONTAINER,
      checkpointParentOf: async () => parentOf,
    })
    const b = tiny.backendFor({ sessionId: SESSION, targets: { wiki: 'w-1', lab: CONTAINER } })
    for (let i = 0; i < 3; i++) await b.write(`/lab/rd${i}.txt`, `v${i}`)
    // 水位 0 → 残集 3 行 > depthLimit 2
    await prisma.session.update({ where: { id: SESSION }, data: { fileJournalAnchorSeq: 0 } })

    const outcomes = await tiny.reconcileOnBoot()
    expect(outcomes.get(SESSION)).toMatchObject({ resumedDegraded: 3, resumedReverted: 0 })
    // 跳过式处置——文件保持现状、行打标（续放不再拾起）
    expect(labSnapshot(fs)).toEqual({ 'rd0.txt': 'v0', 'rd1.txt': 'v1', 'rd2.txt': 'v2' })
    const rows = await prisma.fileJournal.findMany({ where: { sessionId: SESSION } })
    expect(rows.every((r) => r.fileRevertedAt !== null)).toBe(true)
  })

  it('boot 拾起 scope=files 崩溃面：归档未处置行 ∈ chain(指针) 仍续放（行级决策优先——指针在被放弃分支）', async () => {
    // scope=files：对话面零改动、指针留在被放弃分支（ckB ∈ abandoned）——boot 续放 chain=指针
    // 重建时归档行 ∈ chain(指针)，chain 过滤会错排；行级归档标记 = 决策表达（无 chain 过滤）
    await seedSession({ activeCheckpointId: 'ckB', fileJournalAnchorSeq: 0 })
    const b = backend()
    expect((await b.write('/lab/files-victim.txt', 'v')).error).toBeUndefined()
    // files rewind tx1：journal 行归档（checkpointId=ckC ∈ abandoned）——tx2 前崩溃残留
    await prisma.fileJournal.update({
      where: { sessionId_seq: { sessionId: SESSION, seq: 1 } },
      data: { checkpointId: 'ckC', archivedAt: new Date() },
    })
    expect(fs.trees.get(CONTAINER)!.has('/lab/files-victim.txt')).toBe(true)

    await svc.reconcileOnBoot()
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, path: 'files-victim.txt' } })
    expect(row.fileRevertedAt).not.toBeNull()
    expect(fs.trees.get(CONTAINER)!.has('/lab/files-victim.txt')).toBe(false)
  })

  it('boot 拾起首次 rewind tx1 后崩溃窗口：归档未处置行重演（水位 null 决策面）', async () => {
    await seedSession({ activeCheckpointId: 'ckB' })
    // tx1 已提交（指针=ckB、abandoned 行已归档）、tx2 未跑（水位 null）——前两支判据均不命中
    const b = backend()
    expect((await b.write('/lab/victim.txt', 'v')).error).toBeUndefined()
    await prisma.fileJournal.update({
      where: { sessionId_seq: { sessionId: SESSION, seq: 1 } },
      data: { checkpointId: 'ckC', archivedAt: new Date() }, // abandoned 归档（对话面已回退）
    })
    expect(fs.trees.get(CONTAINER)!.has('/lab/victim.txt')).toBe(true)

    await svc.reconcileOnBoot()
    // 决策已落盘 → boot 重演执行（/lab 恢复无自动路径 + 零审计的静默面消除）
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, path: 'victim.txt' } })
    expect(row.fileRevertedAt).not.toBeNull()
    expect(fs.trees.get(CONTAINER)!.has('/lab/victim.txt')).toBe(false)
  })

  it('续放：逆放中断残留（水位已推进、部分行未处置）在下次 rewindFiles 续放完成', async () => {
    await seedSession()
    const b = backend()
    await b.write('/lab/r1.txt', 'one')
    await b.write('/lab/r2.txt', 'two')
    const rows = await prisma.fileJournal.findMany({ where: { sessionId: SESSION }, orderBy: { seq: 'asc' } })
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: rows[0]!.seq } }, data: { checkpointId: 'ckB' } })
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: rows[1]!.seq } }, data: { checkpointId: 'ckC' } })
    // 模拟中断态：水位推进（= root 链 max 0）、r1 已处置（逆放完成——文件随之移除）、r2 未处置
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: rows[0]!.seq } }, data: { fileRevertedAt: new Date() } })
    await prisma.session.update({ where: { id: SESSION }, data: { fileJournalAnchorSeq: 0 } })
    await fs.primitives.exec(CONTAINER, ['sh', '-c', 'rm -rf -- "$1"', 'sh', '/lab/r1.txt'])
    // 手工制造 r2「已删但账面未处置」的中间态（模拟执行到一半崩溃）
    await fs.primitives.exec(CONTAINER, ['sh', '-c', 'rm -rf -- "$1"', 'sh', '/lab/r2.txt'])

    const user = await prisma.user.findFirstOrThrow()
    const result = await svc.rewindFiles({ sessionId: SESSION, anchor: 'root', userId: user.id, username: user.username })
    expect(result.degraded).toBe(false)
    // 续放后 r2 处置完毕（write before=null → remove 幂等），lab 空
    expect(labSnapshot(fs)).toEqual({})
  })

  // ---------------------------------------------------------------------------
  // GC（refcount + lease）
  // ---------------------------------------------------------------------------

  it('GC：rewind 后无引用 blob 剪枝、活跃行引用保留', async () => {
    await seedSession()
    const b = backend()
    await b.write('/lab/gc-a.txt', 'content-a') // seq1
    await b.write('/lab/gc-a.txt', 'content-b') // seq2 覆盖（seq1 的 after blob 失去引用）
    const rows = await prisma.fileJournal.findMany({ where: { sessionId: SESSION }, orderBy: { seq: 'asc' } })
    for (const r of rows) {
      await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: r.seq } }, data: { checkpointId: 'ckB' } })
    }
    const user = await prisma.user.findFirstOrThrow()
    await svc.rewindFiles({ sessionId: SESSION, anchor: 'root', userId: user.id, username: user.username })
    // 两行已全部逆放处置（fileRevertedAt 置位）——refcount 收敛（已处置行 blob 无再读面）：
    // 行未归档也不占额，尾部 gc 已剪净
    const usageBefore = await svc.atticUsage(CONTAINER)
    expect(usageBefore.blobs).toBe(0)
    // 模拟对话面归档（#781 rewind 事务面）后，二次 rewindFiles 的尾部 gc 无剩余可剪
    await prisma.fileJournal.updateMany({ where: { sessionId: SESSION }, data: { archivedAt: new Date() } })
    await svc.rewindFiles({ sessionId: SESSION, anchor: 'root', userId: user.id, username: user.username })
    const usage = await svc.atticUsage(CONTAINER)
    expect(usage.blobs).toBe(0)
  })

  it('replay lease：lease 集内的 blob 不被 GC 剪枝', async () => {
    await seedSession()
    const b = backend()
    await b.write('/lab/lease.txt', 'lv')
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION } })
    // 手工 GC 时该行已归档（无 refcount）但 lease 持有其 sha
    await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: row.seq } }, data: { archivedAt: new Date() } })
    // 经 rewindFiles 的 lease 窗口不可直接探——用 gc 部件验证语义
    const { AtticGc } = await import('../src/runner/filejournal/gc')
    const { AtticStore } = await import('../src/runner/filejournal/attic')
    const attic = new AtticStore(fs.primitives, { quotaBytes: 1024 * 1024 })
    const g = new AtticGc(prisma, attic)
    g.acquireLease(SESSION, [row.afterSha256!])
    const out = await g.gc(CONTAINER, SESSION)
    expect(out.freed).toBe(0)
    g.releaseLease(SESSION)
    const out2 = await g.gc(CONTAINER, SESSION)
    expect(out2.freed).toBe(1)
  })

  it('GC refcount 收敛：已处置未归档行（pending 空 checkpointId/keepMark 面）blob 剪枝——死 blob 不累积耗尽配额', async () => {
    await seedSession()
    const b = backend()
    await b.write('/lab/leak.txt', 'lv1')
    // 模拟 aborted/failed 面行：pending '' + 已逆放处置（fileRevertedAt 置位、行未归档——
    // checkpointId='' 恒匹配不到 abandoned 归档集 = 结构性永不可归档）
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION } })
    await prisma.fileJournal.update({
      where: { sessionId_seq: { sessionId: SESSION, seq: row.seq } },
      data: { fileRevertedAt: new Date() },
    })
    // 已处置行不再占 refcount（planRevert/续放/boot 三处判定全滤已处置行——blob 无再读面）
    const { AtticGc } = await import('../src/runner/filejournal/gc')
    const { AtticStore } = await import('../src/runner/filejournal/attic')
    const attic = new AtticStore(fs.primitives, { quotaBytes: 1024 * 1024 })
    const g = new AtticGc(prisma, attic)
    const out = await g.gc(CONTAINER, SESSION)
    expect(out.freed).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // 围栏（逆放期间写排队）
  // ---------------------------------------------------------------------------

  it('逆放期间 agent 写排队（围栏互斥）；有界超时 50008', async () => {
    await seedSession()
    const b = backend()
    await b.write('/lab/w1.txt', '1')
    const rows = await prisma.fileJournal.findMany({ where: { sessionId: SESSION } })
    for (const r of rows) {
      await prisma.fileJournal.update({ where: { sessionId_seq: { sessionId: SESSION, seq: r.seq } }, data: { checkpointId: 'ckB' } })
    }
    // 占住围栏模拟慢逆放
    const hold = await svc.fence.acquire(SESSION, { holder: 'rewind-replay', timeoutMs: 0 })
    const writePromise = b.write('/lab/w2.txt', '2')
    await new Promise((r) => setTimeout(r, 30))
    const pendingRow = await prisma.fileJournal.count({ where: { sessionId: SESSION } })
    expect(pendingRow).toBe(1) // 排队中未打点
    hold.release()
    const wr = await writePromise
    expect(wr.error).toBeUndefined()
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(2)
  })
})
