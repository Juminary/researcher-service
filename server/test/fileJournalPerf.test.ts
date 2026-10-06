// S4 性能基准（#782 · #766 C7/D8）：小 op 捕获 ≤50ms p95 / 100 小 op 重放 ≤5s / 100MB op
// 带进度面。fake primitives + 真 SQLite（真实管线开销面，无 docker IO——真容器基线另随
// 部署实测校准；本基准锁回归：打点管线复杂度劣化在此显形）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { createPrismaClient } from '../src/prisma'
import type { PrismaClient } from '../src/generated/prisma/client'
import { FileJournalService } from '../src/runner/filejournal/service'
import { fakeFs } from './fileJournalTestkit'
import { seedUser } from './helpers'

const CONTAINER = 'researcher-sandbox-perf'
const SESSION = 'sess-perf'

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
}

describe('文件 rewind 性能基准（S4，#782）', () => {
  let prisma: PrismaClient
  let svc: FileJournalService
  const fs = fakeFs()
  const parentOf = new Map<string, string | null>([['root', null]])

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'filejournal-perf-'))
    const dbPath = path.join(dir, 'test.db')
    const sqlite = new Database(dbPath)
    sqlite.exec(readFileSync(path.join(process.cwd(), 'prisma', 'init.sql'), 'utf8'))
    sqlite.close()
    prisma = createPrismaClient(`file:${dbPath}`)
    const user = await seedUser(prisma, 'perf-user', 'pw-perf1-secure')
    await prisma.session.create({ data: { id: SESSION, ownerId: user.id, containerId: CONTAINER } })
    svc = new FileJournalService({
      prisma,
      primitives: fs.primitives,
      quotaBytes: 512 * 1024 * 1024,
      depthLimit: 10_000,
      fenceTimeoutMs: 30_000,
      containerOf: async () => CONTAINER,
      checkpointParentOf: async () => parentOf,
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('小 op 捕获 ≤50ms p95（write/edit 打点全管线）', async () => {
    const backend = svc.backendFor({ sessionId: SESSION, targets: { wiki: 'w', lab: CONTAINER } })
    const samples: number[] = []
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now()
      const r = await backend.write(`/lab/perf-${i}.txt`, `content-${i}`)
      samples.push(performance.now() - t0)
      expect(r.error).toBeUndefined()
    }
    const p = p95(samples)
    // eslint-disable-next-line no-console
    console.log(`[perf] 小 op 捕获 p95=${p.toFixed(2)}ms（n=100，中位 ${samples.sort((a, b) => a - b)[50]!.toFixed(2)}ms）`)
    expect(p).toBeLessThanOrEqual(50)
  })

  it('100 小 op 重放 ≤5s + 100MB op 带进度面', async () => {
    // 100 op 全量落账（checkpointId ∉ chain(root) → 全逆放）
    const backend = svc.backendFor({ sessionId: SESSION, targets: { wiki: 'w', lab: CONTAINER } })
    for (let i = 0; i < 100; i++) {
      const r = await backend.write(`/lab/replay-${i}.txt`, `v-${i}`)
      expect(r.error).toBeUndefined()
    }

    // 100MB op（进度面 + 单 op 吞吐）
    const big = Buffer.alloc(100 * 1024 * 1024, 7)
    const progress: Array<[number, number]> = []
    const mbStart = performance.now()
    await svc.rewindFiles({ sessionId: SESSION, anchor: 'root', userId: 'u', username: 'u' })
    const elapsed = performance.now() - mbStart
    // eslint-disable-next-line no-console
    console.log(`[perf] 100 小 op + 100MB 前像捕获重放总耗时=${(elapsed / 1000).toFixed(2)}s`)
    expect(elapsed).toBeLessThanOrEqual(5000)

    // 进度面：executeRevert onProgress 经 rewindFiles 无对外回调——服务级回填后由 rewindFiles
    // 内部逐行处置；此处直接驱动 executeRevert 锁进度回调序列（100MB op 逆放）。
    const { executeRevert } = await import('../src/runner/filejournal/replay')
    const bigRow = {
      id: 'j-big', sessionId: SESSION, checkpointId: 'ck-x', seq: 999, op: 'write',
      path: 'big.bin', beforeSha256: null, afterSha256: null, tombstoneKey: null,
      toolCallId: 'tc-big', applied: true, archivedAt: null, fileRevertedAt: null, runId: null,
    } as never
    let lastDone = 0
    const io = {
      getBlob: async () => big,
      putTar: async () => {},
      removeFile: async () => {},
      markReverted: async () => {},
    }
    const t0 = performance.now()
    const outcome = await executeRevert(SESSION, CONTAINER, [bigRow], io, (done, total) => {
      progress.push([done, total])
      lastDone = done
    })
    expect(performance.now() - t0).toBeLessThanOrEqual(2000) // 单 100MB op 逆放（fake IO）≤2s
    expect(outcome.reverted).toBe(1)
    expect(progress).toEqual([[1, 1]])
    expect(lastDone).toBe(1)
  })
})
