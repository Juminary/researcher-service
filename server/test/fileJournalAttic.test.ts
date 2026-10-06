import { describe, expect, it } from 'vitest'
import { fakeFs } from './fileJournalTestkit'
import { AtticQuotaExceededError, AtticStore, sha256Of } from '../src/runner/filejournal/attic'
import { ATTIC_BLOBS_DIR, atticBlobPath } from '../src/runner/filejournal/values'

const CONTAINER = 'researcher-sandbox-s1'

describe('AtticStore', () => {
  it('ensureRoot：mkdir+chmod 700+chown 0:0，exec 以 root 执行', async () => {
    const { primitives, execCalls } = fakeFs()
    const store = new AtticStore(primitives, { quotaBytes: 1000 })
    await store.ensureRoot(CONTAINER)
    const call = execCalls.at(-1)!
    expect(call.container).toBe(CONTAINER)
    expect(call.cmd.join(' ')).toContain('chmod 700')
    expect(call.cmd.join(' ')).toContain('chown 0:0')
    expect(call.cmd.at(-1)).toBe(ATTIC_BLOBS_DIR)
    expect(call.user).toBe('0')
  })

  it('put/get 往返；同内容幂等不重复写', async () => {
    const { primitives } = fakeFs()
    const store = new AtticStore(primitives, { quotaBytes: 10_000 })
    await store.ensureRoot(CONTAINER)
    const buf = Buffer.from('hello attic')
    const first = await store.putBlob(CONTAINER, buf)
    expect(first).toEqual({ sha256: sha256Of(buf), created: true })
    const again = await store.putBlob(CONTAINER, buf)
    expect(again.created).toBe(false)
    const back = await store.getBlob(CONTAINER, sha256Of(buf))
    expect(back?.equals(buf)).toBe(true)
  })

  it('超配额拒绝（AtticQuotaExceededError），同内容 dedup 不占新配额', async () => {
    const { primitives } = fakeFs()
    const store = new AtticStore(primitives, { quotaBytes: 16 })
    await store.ensureRoot(CONTAINER)
    const a = Buffer.alloc(10, 1)
    await store.putBlob(CONTAINER, a)
    await expect(store.putBlob(CONTAINER, a)).resolves.toMatchObject({ created: false })
    const b = Buffer.alloc(10, 2)
    await expect(store.putBlob(CONTAINER, b)).rejects.toBeInstanceOf(AtticQuotaExceededError)
  })

  it('getBlob 失联 → null；hasBlob 探存在', async () => {
    const { primitives } = fakeFs()
    const store = new AtticStore(primitives, { quotaBytes: 10_000 })
    await store.ensureRoot(CONTAINER)
    const buf = Buffer.alloc(4, 9)
    expect(await store.hasBlob(CONTAINER, sha256Of(buf))).toBe(false)
    expect(await store.getBlob(CONTAINER, sha256Of(buf))).toBeNull()
    await store.putBlob(CONTAINER, buf)
    expect(await store.hasBlob(CONTAINER, sha256Of(buf))).toBe(true)
    expect(await store.getBlob(CONTAINER, sha256Of(buf))).not.toBeNull()
  })

  it('usage 统计字节与 blob 数', async () => {
    const { primitives } = fakeFs()
    const store = new AtticStore(primitives, { quotaBytes: 10_000 })
    await store.ensureRoot(CONTAINER)
    await store.putBlob(CONTAINER, Buffer.alloc(7, 3))
    await store.putBlob(CONTAINER, Buffer.alloc(9, 4))
    expect(await store.usage(CONTAINER)).toEqual({ bytes: 16, blobs: 2 })
  })

  it('deleteBlobs：root rm 删除后不可取；user 面为 0', async () => {
    const { primitives, execCalls } = fakeFs()
    const store = new AtticStore(primitives, { quotaBytes: 10_000 })
    await store.ensureRoot(CONTAINER)
    const a = Buffer.alloc(4, 5)
    const b = Buffer.alloc(4, 6)
    await store.putBlob(CONTAINER, a)
    await store.putBlob(CONTAINER, b)
    const removed = await store.deleteBlobs(CONTAINER, [sha256Of(a), sha256Of(b)])
    expect(removed).toBe(2)
    expect(await store.getBlob(CONTAINER, sha256Of(a))).toBeNull()
    expect(await store.usage(CONTAINER)).toEqual({ bytes: 0, blobs: 0 })
    const rmCall = execCalls.find((c) => c.cmd[2]?.startsWith('rm -f'))
    expect(rmCall?.user).toBe('0')
    expect(atticBlobPath(sha256Of(a))).toBe(`${ATTIC_BLOBS_DIR}/${sha256Of(a)}`)
  })
})
