// JournalWriter 单测（#782 · S3/S2 混合：管线步骤序 + 幂等处置 + 崩溃残留用真 SQLite 锁行面）。

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { JournalWriter } from '../src/runner/filejournal/writer'
import { sha256Of } from '../src/runner/filejournal/attic'
import { fakeFs } from './fileJournalTestkit'
import { seedUser } from './helpers'

const CONTAINER = 'researcher-sandbox-w1'
const SESSION = 'sess-jw'

describe('JournalWriter（journal-first 管线）', () => {
  let prisma: PrismaClient
  const cleanupDirs: string[] = []
  const fs = fakeFs()

  function writer(opts: { quotaBytes?: number } = {}): JournalWriter {
    return new JournalWriter(prisma, fs.primitives, { quotaBytes: opts.quotaBytes ?? Number.MAX_SAFE_INTEGER })
  }

  // 常规参数：path=f.txt、pre 读 fake 树、after=新字节、apply=覆盖写
  // （显式 null 合法——delete 语义 afterBytes=null；故用 in 判存在而非 ?? 合并）
  function writeParams(over: Partial<Parameters<JournalWriter['write']>[0]> & { toolCallId?: string }): Parameters<JournalWriter['write']>[0] {
    const p = over.path ?? 'f.txt'
    const file = `/lab/${p}`
    const afterBytes = 'afterBytes' in over ? over.afterBytes! : Buffer.from('after-bytes')
    return {
      sessionId: SESSION,
      container: CONTAINER,
      path: p,
      op: over.op ?? 'write',
      readPreImage: over.readPreImage ?? (async () => await fs.primitives.getArchive(CONTAINER, file)),
      afterBytes,
      apply: over.apply ?? (async () => {
        await fs.primitives.exec(CONTAINER, ['mkdir', '-p', '/lab'])
        const { createTarFile } = await import('../src/files/tar')
        await fs.primitives.putArchive(CONTAINER, '/lab', createTarFile(p, afterBytes))
      }),
      ...(over.toolCallId !== undefined ? { toolCallId: over.toolCallId } : {}),
      ...(over.runId !== undefined ? { runId: over.runId } : {}),
    }
  }

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'filejournal-writer-'))
    cleanupDirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'jw-user', 'pw-jw1-secure')
    await prisma.session.create({ data: { id: SESSION, ownerId: user.id, containerId: CONTAINER } })
  })

  afterEach(async () => {
    await prisma.fileJournal.deleteMany({})
    fs.trees.get(CONTAINER)?.clear()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true })
  })

  it('正常管线：journal 行全列 + attic 双 blob + apply 执行 + applied=true + seq 自增', async () => {
    const w = writer()
    const r1 = await w.write(writeParams({ toolCallId: 'tc-1' }))
    expect(r1).toMatchObject({ seq: 1, idempotentReplay: false })
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION } })
    expect(row).toMatchObject({
      seq: 1, op: 'write', path: 'f.txt', applied: true,
      beforeSha256: null,
      afterSha256: sha256Of(Buffer.from('after-bytes')),
      tombstoneKey: null, archivedAt: null, fileRevertedAt: null,
    })
    // attic：after blob 在
    const attic = w.atticStore
    expect(await attic.hasBlob(CONTAINER, sha256Of(Buffer.from('after-bytes')))).toBe(true)
    // 文件已 apply
    expect(await fs.primitives.getArchive(CONTAINER, '/lab/f.txt')).not.toBeNull()

    // 第二笔：有 pre-image（前一笔的产物）→ seq=2、beforeSha 记录
    const pre = (await fs.primitives.getArchive(CONTAINER, '/lab/f.txt'))!
    const r2 = await w.write(writeParams({ toolCallId: 'tc-2', afterBytes: Buffer.from('v2') }))
    expect(r2.seq).toBe(2)
    const row2 = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, seq: 2 } })
    expect(row2.beforeSha256).toBe(sha256Of(pre))
  })

  it('delete：tombstoneKey = beforeSha、afterSha null；pre blob 进 attic', async () => {
    // 预置文件
    const { createTarFile } = await import('../src/files/tar')
    await fs.primitives.exec(CONTAINER, ['mkdir', '-p', '/lab'])
    await fs.primitives.putArchive(CONTAINER, '/lab', createTarFile('d.txt', Buffer.from('to-delete')))
    const pre = (await fs.primitives.getArchive(CONTAINER, '/lab/d.txt'))!

    const w = writer()
    const r = await w.write(
      writeParams({
        op: 'delete',
        path: 'd.txt',
        afterBytes: null,
        apply: async () => {
          await fs.primitives.exec(CONTAINER, ['sh', '-c', 'rm -f -- "$@"', 'sh', '/lab/d.txt'])
        },
      }),
    )
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, seq: r.seq } })
    expect(row).toMatchObject({ op: 'delete', beforeSha256: sha256Of(pre), afterSha256: null, tombstoneKey: sha256Of(pre) })
    expect(await atticHas(w, sha256Of(pre))).toBe(true)
  })

  it('幂等命中 applied=true：不重复插行、apply 重执行', async () => {
    const w = writer()
    await w.write(writeParams({ toolCallId: 'tc-idem' }))
    let applyCount = 0
    const r = await w.write(
      writeParams({
        toolCallId: 'tc-idem',
        apply: async () => {
          applyCount += 1
        },
      }),
    )
    expect(r).toMatchObject({ idempotentReplay: true })
    expect(applyCount).toBe(1)
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(1)
  })

  it('幂等命中 applied=false（崩溃残留）：apply 后置位', async () => {
    await prisma.fileJournal.create({
      data: { sessionId: SESSION, checkpointId: 'c0', seq: 1, op: 'write', path: 'r.txt', toolCallId: 'tc-crash', applied: false },
    })
    const w = writer()
    const r = await w.write(writeParams({ toolCallId: 'tc-crash', path: 'r.txt' }))
    expect(r).toMatchObject({ seq: 1, idempotentReplay: true })
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION, seq: 1 } })
    expect(row.applied).toBe(true)
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(1)
  })

  it('幂等命中跨 run 复用：runId 迁移至最新 run（重发 run 终态回填 where runId 可命中）', async () => {
    const w = writer()
    // 首打点挂 failed run（无终态回填——行带旧 runId）
    await w.write(writeParams({ toolCallId: 'tc-mig', runId: 'runA', apply: async () => {} }))
    // 重发 run 幂等命中：runId 迁移至 runB（不迁移则 runB 回填不命中、行恒 pending 被误逆放）
    const r2 = await w.write(writeParams({ toolCallId: 'tc-mig', runId: 'runB', apply: async () => {} }))
    expect(r2).toMatchObject({ seq: 1, idempotentReplay: true })
    expect(await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION } })).toMatchObject({ runId: 'runB' })
    // 缺 runId 的重放不迁移（ALS 随机键等无归属面）
    await w.write(writeParams({ toolCallId: 'tc-mig', apply: async () => {} }))
    expect(await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION } })).toMatchObject({ runId: 'runB' })
  })

  it('apply 抛错：applied=false 行残留（reconcile 消费面）、错误上抛', async () => {
    const w = writer()
    await expect(
      w.write(
        writeParams({
          toolCallId: 'tc-fail',
          apply: async () => {
            throw new Error('docker boom')
          },
        }),
      ),
    ).rejects.toThrow('docker boom')
    const row = await prisma.fileJournal.findFirstOrThrow({ where: { sessionId: SESSION } })
    expect(row.applied).toBe(false)
  })

  it('attic 配额超限：op 失败且 journal 零行（打点不成不执行）', async () => {
    const w = writer({ quotaBytes: 4 })
    await expect(w.write(writeParams({ toolCallId: 'tc-quota' }))).rejects.toThrow(/quota exceeded/)
    expect(await prisma.fileJournal.count({ where: { sessionId: SESSION } })).toBe(0)
    expect(await fs.primitives.getArchive(CONTAINER, '/lab/f.txt')).toBeNull()
  })

  async function atticHas(w: JournalWriter, sha: string): Promise<boolean> {
    return w.atticStore.hasBlob(CONTAINER, sha)
  }
})
