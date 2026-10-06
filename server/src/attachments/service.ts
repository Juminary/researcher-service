// 附件域业务服务（#780 · #747 G 节「附件与文件 rewind」D1–D6）。
// 三件职责（片 1）：
//   - 上传：REST 收字节（multer 已落临时文件）→ 雪花 id → 移入控制面临时区（<tmpRoot>/<attachmentId>）
//     → sha256 + 建行（字节绝不落 DB）→ 返回元数据（attachmentId 供消息引用）。**REST 不直写沙箱**
//     （#780 D5 修订：物化归 runner 侧 ingestion 节点，片 2）。
//   - 下载：owner 门（50002 不存在/越权同码防探测，仿 figures PNG 先例）→ 沙箱读字节
//     （files 域 readLabBytes，S2 接缝）。
//   - 消息链接：发消息带 attachmentIds → 校验 ≤4 件 + 归属/session → 挂 messageId（引用面，
//     字节仍在沙箱；消息行 attachmentsJson 的 media? 只承载 agent→用户媒体块，D9 片 3）。

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient, Attachment } from '../generated/prisma/client'
import type { AuthUser } from '../types'
import { fail } from '../envelope'
import { CODE } from '../codes'
import { getSessionForUser } from '../sandboxes/service'
import { SANDBOX_CONTAINER_PREFIX } from '../sandboxes/values'
import type { FileArchive } from '../files/fsPort'
import { createTarFile, parseTar } from '../files/tar'
import type { SandboxFilePrimitives } from '../runner/backend/primitives'
import { snowflakeId } from './snowflake'
import { ATTACHMENTS_PER_MESSAGE_MAX, ATTACHMENT_MAX_BYTES, ATTACHMENT_LAB_UPLOADS, labUploadRelPath, sanitizeFileName } from './values'

export interface AttachmentMeta {
  readonly attachmentId: string
  readonly fileName: string
  readonly mimeType: string
  readonly size: number
  readonly sha256: string
  readonly path: string // 沙箱内物化路径 /lab/uploads/<attachmentId>/<原始文件名>
}

export interface AttachmentsServiceDeps {
  readonly prisma: PrismaClient
  /** 控制面临时区根（<fleetRoot>/attachments）；ingestion 节点按 id 读此物化 */
  readonly tmpRoot: string
  /** 沙箱只读字节通道（files 域 readLabBytes；下载端点）。缺省不注 → download 50002（未装配） */
  readonly archive?: Pick<FileArchive, 'readLabBytes'>
}

export class AttachmentsService {
  constructor(private readonly deps: AttachmentsServiceDeps) {}

  private meta(row: Attachment): AttachmentMeta {
    return {
      attachmentId: row.id,
      fileName: row.fileName,
      mimeType: row.mimeType,
      size: row.size,
      sha256: row.sha256,
      path: row.path,
    }
  }

  // ---- 上传（字节已由 multer 落控制面临时文件）----
  // 归属（getSessionForUser，50002 同码）→ 尺寸（multer limits 已挡，此处双保险）→ 雪花 id →
  // 移入 <tmpRoot>/<attachmentId>（ingestion 按 id 读；同 id 重传覆盖幂等）→ sha256 + 建行。
  async upload(
    user: Pick<AuthUser, 'id' | 'role'>,
    sessionId: string,
    p: { tempPath: string; fileName: string; mimeType: string },
  ): Promise<AttachmentMeta> {
    await getSessionForUser(this.deps.prisma, user, sessionId)
    const st = await stat(p.tempPath)
    if (st.size > ATTACHMENT_MAX_BYTES) throw fail(CODE.VALIDATION_FAILED, `附件过大（≤${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB）`)
    const attachmentId = snowflakeId()
    await mkdir(this.deps.tmpRoot, { recursive: true })
    // 以 attachmentId 为键的临时区落位（控制面字节暂存，ingestion 节点消费；覆盖幂等）
    await rename(p.tempPath, path.join(this.deps.tmpRoot, attachmentId))
    const buf = await readFile(path.join(this.deps.tmpRoot, attachmentId))
    const sha256 = createHash('sha256').update(buf).digest('hex')
    const row = await this.deps.prisma.attachment.create({
      data: {
        id: attachmentId,
        ownerId: user.id,
        sessionId,
        fileName: p.fileName,
        mimeType: p.mimeType,
        size: buf.length,
        sha256,
        path: `${ATTACHMENT_LAB_UPLOADS}/${attachmentId}/${p.fileName}`,
      },
    })
    return this.meta(row)
  }

  // ---- 下载（owner 门 + 不存在/越权同码 50002 防探测；字节经沙箱 readLabBytes）----
  // attachmentId 会话内唯一（fork 复制不改 id，#766 D7）——按 id 取全部行后按 owner 过滤：
  // admin 全放行 / user 仅本人；无命中 → 50002（与「不存在」逐字节一致，防枚举探测）。
  // 字节从该附件所属 session 的沙箱读（/lab/uploads/<attachmentId>/<原文件名>）。
  async download(
    user: Pick<AuthUser, 'id' | 'role'>,
    attachmentId: string,
  ): Promise<{ meta: AttachmentMeta; buf: Buffer }> {
    if (!this.deps.archive) throw fail(CODE.SESSION_NOT_FOUND)
    const rows = await this.deps.prisma.attachment.findMany({ where: { id: attachmentId } })
    const row = rows.find((r) => user.role === 'admin' || r.ownerId === user.id)
    if (!row) throw fail(CODE.SESSION_NOT_FOUND)
    const dockerName = `${SANDBOX_CONTAINER_PREFIX}${row.sessionId}`
    const buf = await this.deps.archive.readLabBytes(dockerName, labUploadRelPath(row.path))
    return { meta: this.meta(row), buf }
  }

  // ---- 消息链接（发消息带 attachmentIds）：≤4 件 + 归属/session 校验 → 挂 messageId ----
  // 在 sendMessage 落 user 行之后调用（messageId 已知）；行更新失败（P2025 行已删）best-effort
  // 上抛（调用方回滚消息行——附件引用与消息同生共死）。
  async linkToMessage(
    user: Pick<AuthUser, 'id' | 'role'>,
    sessionId: string,
    messageId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    const ids = [...attachmentIds]
    if (ids.length === 0) return
    if (ids.length > ATTACHMENTS_PER_MESSAGE_MAX) {
      throw fail(CODE.VALIDATION_FAILED, `单消息最多 ${ATTACHMENTS_PER_MESSAGE_MAX} 个附件`)
    }
    // 归属/session 校验：全部目标行须属本 session 且本人（admin 放行）；任一不命中 → 50002
    //（防跨会话引用他人附件）。
    const rows = await this.deps.prisma.attachment.findMany({ where: { id: { in: ids } } })
    const owned = rows.filter((r) => r.sessionId === sessionId && (user.role === 'admin' || r.ownerId === user.id))
    if (owned.length !== ids.length) throw fail(CODE.SESSION_NOT_FOUND)
    await this.deps.prisma.attachment.updateMany({
      where: { id: { in: ids }, sessionId },
      data: { messageId },
    })
  }

  // ---- ingestion（片 2 · run 首步，runner 调度权）：sha256 校验 → 写沙箱物化 ----
  // 从控制面临时区读字节、重算 sha256 与行校验（不符 = 内容被改/临时区损坏 → 抛错 → run 失败，
  // 不进入 agent loop）；校验通过 → mkdir + putArchive 单文件 tar 落 `/lab/uploads/<attachmentId>/`
  //（ID 子目录结构性防同名碰撞，D1）。putArchive 覆盖写 = 幂等（resume/重投安全）。返回元数据
  // 供 runner 做图片内联（image mime → 读字节 data URL 多模态 block；文件类由常规 fs 工具自读）。
  // journalWrite（#782）：注入时物化改由回调承担（journal-first 管线内部 apply——打点先于
  // 字节落盘）；缺省直写（journal 未接线的测试/降级面）。
  async ingestAttachments(p: {
    sessionId: string
    attachmentIds: readonly string[]
    container: string
    primitives: Pick<SandboxFilePrimitives, 'exec' | 'putArchive'>
    journalWrite?: (row: { id: string; fileName: string; mimeType: string }, bytes: Buffer) => Promise<void>
  }): Promise<Array<{ attachmentId: string; mimeType: string }>> {
    const rows = await this.deps.prisma.attachment.findMany({
      where: { id: { in: [...p.attachmentIds] }, sessionId: p.sessionId },
    })
    // 任一 id 未命中（行被删/跨会话引用）→ 校验失败（ingestion 错误面）
    if (rows.length !== new Set(p.attachmentIds).size) {
      throw fail(CODE.SESSION_NOT_FOUND, '附件引用无效（会话内不存在）')
    }
    const metas: Array<{ attachmentId: string; mimeType: string }> = []
    for (const row of rows) {
      const tmp = path.join(this.deps.tmpRoot, row.id)
      let buf: Buffer
      try {
        buf = await readFile(tmp)
      } catch {
        throw fail(CODE.INTERNAL, `附件字节缺失（临时区）：${row.id}`)
      }
      const sha = createHash('sha256').update(buf).digest('hex')
      if (sha !== row.sha256) throw fail(CODE.INTERNAL, `附件内容校验失败（sha256 不符）：${row.id}`)
      const dir = `${ATTACHMENT_LAB_UPLOADS}/${row.id}`
      if (p.journalWrite) {
        await p.journalWrite({ id: row.id, fileName: row.fileName, mimeType: row.mimeType }, buf)
      } else {
        await p.primitives.exec(p.container, ['mkdir', '-p', dir])
        await p.primitives.putArchive(p.container, dir, createTarFile(row.fileName, buf))
      }
      metas.push({ attachmentId: row.id, mimeType: row.mimeType })
    }
    return metas
  }

  // 读临时区字节（ingestion 图片内联用；附件 id 为键）。
  async readTempBytes(attachmentId: string): Promise<Buffer> {
    return readFile(path.join(this.deps.tmpRoot, attachmentId))
  }

  // ---- agent→用户媒体物化（片 3 · D9）：校验存在性/mime 白名单 → 拷进 /lab/uploads/ → 建行 ----
  // agent 经工具产出文件后在最终回复里声明路径（mediaBlocks 扫描已保 /lab/ 前缀 + mime 白名单）；
  // 此处校验文件真实存在（getArchive；不存在 = 已删/墓碑态）→ sha256/size → 拷贝进
  // /lab/uploads/<attachmentId>/<fileName>（与用户附件同表同目录，方向由挂载消息 role 派生——
  // 不加列不分目录）→ 建 Attachment 行（messageId 空——assistant 行由 recordTurn 随后落，回放
  // 引用走 attachmentsJson media 数组）。返回 null = 校验失败（调用方降级文本占位 + 审计计数，
  // 不 fail run）。字节读/拷失败（daemon 故障）同样返 null（fail-soft，run 不受累）。
  // journalWrite（#782）：注入时拷贝改由回调承担（journal-first；attachmentId/fileName 在
  // 建行前回调——物化失败的行不落账，行建行在回调成功后）。
  async materializeAgentMedia(p: {
    sessionId: string
    ownerId: string
    declaredPath: string // /lab/... agent 声明路径
    mime: string
    container: string
    primitives: Pick<SandboxFilePrimitives, 'exec' | 'getArchive' | 'putArchive'>
    journalWrite?: (row: { attachmentId: string; fileName: string }, bytes: Buffer) => Promise<void>
  }): Promise<AttachmentMeta | null> {
    try {
      // 双保险：路径仍须 /lab/ 前缀且无穿越段（扫描层已保，防御面）
      if (!p.declaredPath.startsWith('/lab/') || p.declaredPath.includes('..')) return null
      const tar = await p.primitives.getArchive(p.container, p.declaredPath)
      if (tar === null) return null // 不存在（已删/墓碑态）→ 降级
      const entries = parseTar(tar, { collectData: true, maxDataBytes: ATTACHMENT_MAX_BYTES })
      const entry = entries[0]
      if (!entry || entry.data === null || entry.type !== 'file') return null
      const fileName = sanitizeFileName(p.declaredPath.split('/').pop() ?? 'file')
      const buf = entry.data
      const sha256 = createHash('sha256').update(buf).digest('hex')
      const attachmentId = snowflakeId()
      const dir = `${ATTACHMENT_LAB_UPLOADS}/${attachmentId}`
      if (p.journalWrite) {
        await p.journalWrite({ attachmentId, fileName }, buf)
      } else {
        await p.primitives.exec(p.container, ['mkdir', '-p', dir])
        await p.primitives.putArchive(p.container, dir, createTarFile(fileName, buf))
      }
      const row = await this.deps.prisma.attachment.create({
        data: {
          id: attachmentId,
          ownerId: p.ownerId,
          sessionId: p.sessionId,
          fileName,
          mimeType: p.mime,
          size: buf.length,
          sha256,
          path: `${dir}/${fileName}`,
        },
      })
      return this.meta(row)
    } catch {
      // 物化链路故障（daemon/DB）→ 降级面（不 fail run，#747 D9「校验失败降级文本占位」）
      return null
    }
  }
}
