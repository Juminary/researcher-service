// JournalingBackend（#782 · D8 打点接缝）：DockerArchiveBackend 装饰器——/lab 写面
//（write/edit/delete）journal-first 打点（JournalWriter 管线）+ 会话写围栏；读面与 shell
//（execute）零改动直通（exec 副作用不入日志 = D8 显式降级）。/wiki 写不打点（wiki 治理
// 另有通道，file_journal 覆盖域 = /lab）。
//
// 打点失败语义（fail-closed 与否的分野）：
//   attic 配额超限（AtticQuotaExceededError）→ op 拒绝执行，错误回流 agent 自纠——静默
//   降级会破「file_journal 覆盖完备」（#769 只读化前提）。
//   其余打点内故障（pre 读取 daemon 故障等）同样上抛 → { error } 回 agent；journal tx 后
//   apply 前的故障 = journal 行残留 applied=false → reconcile roll-forward 兜底。
//   ALS 无 toolCallId → 随机键（幂等性损失、正确性无损，见 writer.ts 注）。

import { randomUUID } from 'node:crypto'
import { performStringReplacement } from '../backend/semantics'
import { decodeWriteContent } from '../backend/mime'
import { routePath, type BackendTargets } from '../backend/paths'
import { DockerArchiveBackend } from '../backend/dockerArchiveBackend'
import type { BackendProtocolV2, DeleteResult, EditResult, WriteResult } from '../backend/protocol'
import type { SandboxFilePrimitives } from '../backend/primitives'
import { MAX_COLLECT_BYTES } from '../backend/values'
import { AtticQuotaExceededError } from './attic'
import { currentRunId, currentToolCallContext } from './context'
import type { SessionWriteFence } from './fence'
import { filePreTar, snapshotAsTar } from './preimage'
import { labRelOf } from './values'
import type { JournalWriter } from './writer'

export interface JournalingBackendParams {
  readonly primitives: SandboxFilePrimitives
  readonly targets: BackendTargets
  /** journal 归属会话 id（teammate thread 写 = parent sessionId——session-global 日志） */
  readonly sessionId: string
  readonly writer: JournalWriter
  readonly fence: SessionWriteFence
  readonly fenceTimeoutMs: number
}

export class JournalingBackend extends DockerArchiveBackend implements BackendProtocolV2 {
  constructor(private readonly j: JournalingBackendParams) {
    super(j.primitives, j.targets)
  }

  override async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const routed = routePath(filePath, this.j.targets)
      if ('error' in routed) return routed
      if (routed.container !== this.j.targets.lab) return super.write(filePath, content)
      if (labRelOf(routed.absPath) === '') return super.write(filePath, content) // /lab 根目标：V1 不打点（super 回 error——根不可写为文件）
      const buf = decodeWriteContent(filePath, content)
      const rel = labRelOf(routed.absPath)
      const basename = routed.absPath.split('/').pop() ?? 'file'
      const afterTar = filePreTar(basename, buf)
      return await this.fenced('agent-write', async () => {
        // pre 探测在围栏内（fence 自钉「全局序重放一致性前提」——围栏外读 pre 可捕获逆放
        // 中途态，beforeSha 与获权后实态不符）。kind 分派：not-found → null = 新建语义；
        // 超限/目录/symlink → 降级不打点直写（对齐 delete 面降级形态——打点而逆操作错
        //（beforeSha=null + op=write → 逆放 remove 删原文件）比无恢复面直操作更危险）
        const g = await this.guardedFile(routed, filePath)
        if ('error' in g && g.kind !== 'not-found') return super.write(filePath, content)
        const preTar = 'tree' in g ? filePreTar(basename, g.buf) : null
        await this.j.writer.write({
          sessionId: this.j.sessionId,
          container: routed.container,
          path: rel,
          op: 'write',
          readPreImage: async () => preTar,
          afterBytes: afterTar,
          apply: () => this.putBuffer(routed, buf),
          toolCallId: this.toolCallId(),
          runId: this.runId(),
        })
        return { path: routed.absPath, filesUpdate: null }
      })
    } catch (e) {
      return journalError('write failed', e)
    }
  }

  override async edit(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<EditResult> {
    try {
      const routed = routePath(filePath, this.j.targets)
      if ('error' in routed) return routed
      if (routed.container !== this.j.targets.lab) return super.edit(filePath, oldString, newString, replaceAll)
      if (labRelOf(routed.absPath) === '') return super.edit(filePath, oldString, newString, replaceAll)
      const rel = labRelOf(routed.absPath)
      const basename = routed.absPath.split('/').pop() ?? 'file'
      return await this.fenced('agent-edit', async () => {
        // after 全文合成在围栏内（围栏外读文本合成替换 = TOCTOU：等待围栏期间文件被逆放
        // 改动，写回基于旧文本的替换——正确性面非仅打点面；S4 基准锁开销）
        const full = await this.readFullText(routed, filePath)
        if ('error' in full) return full
        const replaced = performStringReplacement(full.text, oldString, newString, replaceAll)
        if (typeof replaced === 'string') return { error: replaced }
        const afterTar = filePreTar(basename, Buffer.from(replaced[0], 'utf8'))
        const preTar = filePreTar(basename, Buffer.from(full.text, 'utf8'))
        await this.j.writer.write({
          sessionId: this.j.sessionId,
          container: routed.container,
          path: rel,
          op: 'edit',
          readPreImage: async () => preTar,
          afterBytes: afterTar,
          apply: () => this.putBuffer(routed, Buffer.from(replaced[0], 'utf8')),
          toolCallId: this.toolCallId(),
          runId: this.runId(),
        })
        return { path: routed.absPath, filesUpdate: null, occurrences: replaced[1] }
      })
    } catch (e) {
      return journalError('edit failed', e)
    }
  }

  override async delete(filePath: string): Promise<DeleteResult> {
    try {
      const routed = routePath(filePath, this.j.targets)
      if ('error' in routed) return routed
      if (routed.container !== this.j.targets.lab) return super.delete(filePath)
      // /lab 根目标拒绝（fail-closed）：super.delete = 全树 rm -rf——blast radius 最大的路径
      // 恰不能走打点（全树 pre 快照受 MAX_COLLECT_BYTES 上限，失守即无恢复面），拒绝回 agent
      // 自纠；写工具不经 approval 词法黑名单，此处是唯一闸门。
      if (labRelOf(routed.absPath) === '') {
        return { error: 'refusing to delete /lab root（全树删除无 rewind 恢复面——请指定具体文件）' }
      }
      return await this.fenced('agent-delete', async () => {
        // pre 快照在围栏内（同 write——围栏外快照可捕获逆放中途态）
        const preTar = await snapshotAsTar(this.j.primitives, routed.container, routed.absPath, {
          maxDataBytes: MAX_COLLECT_BYTES,
        })
        if (preTar === null) return super.delete(filePath) // 不存在 = super 走 not found
        const rel = labRelOf(routed.absPath)
        await this.j.writer.write({
          sessionId: this.j.sessionId,
          container: routed.container,
          path: rel,
          op: 'delete',
          readPreImage: async () => preTar,
          afterBytes: null,
          apply: () => this.deleteForApply(filePath),
          toolCallId: this.toolCallId(),
          runId: this.runId(),
        })
        return { path: routed.absPath, filesUpdate: null }
      })
    } catch (e) {
      return journalError('delete failed', e)
    }
  }

  // apply 面：super.delete 的 {error} 转 throw（journal 残留 applied=false → reconcile 兜底；
  // not found 场景已在 pre 快照拦截，此处 error = daemon 故障面）。
  private async deleteForApply(filePath: string): Promise<void> {
    const r = await super.delete(filePath)
    if ('error' in r) throw new Error(r.error)
  }

  private fenced<T>(holder: string, fn: () => Promise<T>): Promise<T> {
    return this.j.fence.runExclusive(this.j.sessionId, { holder, timeoutMs: this.j.fenceTimeoutMs }, fn)
  }

  private toolCallId(): string {
    // 空串拦截（context 盖印面 String(id ?? '') 会把 id 缺席转成 '' 真实键——两次空 id 调用
    // 在 (sessionId, toolCallId) UNIQUE 相撞 → 第二次幂等命中不落行 → rewind 漏撤）
    const id = currentToolCallContext()?.toolCallId
    return id !== undefined && id !== '' ? id : randomUUID()
  }

  private runId(): string | undefined {
    return currentRunId()
  }
}

function journalError(prefix: string, e: unknown): { error: string } {
  if (e instanceof AtticQuotaExceededError) {
    return { error: `${prefix}: attic storage quota exceeded（rewind 存储配额已满，请清理或联系管理员）` }
  }
  return { error: `${prefix}: ${String(e)}` }
}
