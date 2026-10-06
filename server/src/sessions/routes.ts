// 会话域 REST（#778 · #747 C 节「写操作全 REST」）：挂 /api/v1/sessions。#312 信封 +
// requireAuth + mustChangePasswordGate（wiki 先例）。路由层零业务（归属/门禁/幂等在 service），
// 仅承接 32-hex 幂等 key 中间件（header 在 body 之前不可知，经 res.locals 传递——figures 先例）。

import { Router, type Request, type Response, type NextFunction } from 'express'
import type { z } from 'zod'
import { fail, ok } from '../envelope'
import { CODE } from '../codes'
import { requireAuth } from '../middleware/auth'
import { mustChangePasswordGate } from '../middleware/mustChangePasswordGate'
import { validateBody } from '../middleware/validate'
import {
  messageSendSchema,
  sessionApprovalSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionPatchSchema,
  sessionResumeSchema,
  sessionRewindPreviewSchema,
  sessionRewindSchema,
} from '../validation/schemas'
import { MESSAGE_KEY_REGEX } from './values'
import type { SessionService } from './service'

export interface SessionsRouterDeps {
  readonly service: SessionService
}

// Idempotency-Key：32-hex 钉死形态（#747 C 节）。缺失/格式非法 → 90002（确定性拒绝，
// data null——不被 body 校验的字段明细形状掩盖，figures 先例）。
function requireMessageKey(req: Request, res: Response, next: NextFunction): void {
  const key = (req.get('Idempotency-Key') ?? '').trim()
  if (!MESSAGE_KEY_REGEX.test(key)) {
    next(fail(CODE.VALIDATION_FAILED, '缺少合法的 Idempotency-Key 请求头（32 位小写 hex）'))
    return
  }
  res.locals.messageKey = key
  next()
}

// Express 5 params 可为 string | string[]（重复段）；:id 是 cuid 单段路径恒 string。
function pathId(req: Request): string {
  return typeof req.params.id === 'string' ? req.params.id : ''
}

export function createSessionsRouter(deps: SessionsRouterDeps): Router {
  const router = Router()
  router.use(requireAuth, mustChangePasswordGate)

  // POST / —— 创建会话（扁平挂本人；标题可选）+ session.created{source:new} 广播。
  router.post('/', validateBody(sessionCreateSchema), async (req: Request, res: Response) => {
    const { title } = req.body as z.infer<typeof sessionCreateSchema>
    ok(res, await deps.service.createSession(req.user!, title ?? ''))
  })

  // GET / —— 本人会话列表（扁平挂用户；updatedAt DESC）。
  router.get('/', async (req: Request, res: Response) => {
    ok(res, await deps.service.listSessions(req.user!))
  })

  // PATCH /:id —— 改标题（story 5）+ session.updated 广播。
  router.patch('/:id', validateBody(sessionPatchSchema), async (req: Request, res: Response) => {
    const { title } = req.body as z.infer<typeof sessionPatchSchema>
    ok(res, await deps.service.renameSession(req.user!, pathId(req), title))
  })

  // DELETE /:id —— 删会话（级联删沙箱容器+网络；DB 行级联清 messages/checkpoints/attachments）。
  router.delete('/:id', async (req: Request, res: Response) => {
    await deps.service.deleteSession(req.user!, pathId(req))
    ok(res, null)
  })

  // POST /:id/messages —— 发消息（story 7 幂等 + 多端门禁）。中间件顺序对齐 figures：
  // requireMessageKey（缺/坏 key → 90002 零行）→ validateBody（→ 90002 字段明细）→ handler。
  router.post(
    '/:id/messages',
    requireMessageKey,
    validateBody(messageSendSchema),
    async (req: Request, res: Response) => {
      const clientKey = res.locals.messageKey as string
      const { content, attachmentIds } = req.body as z.infer<typeof messageSendSchema>
      ok(res, await deps.service.sendMessage(req.user!, pathId(req), { content, clientKey, attachmentIds }))
    },
  )

  // POST /:id/abort —— 中断在飞 run（story 8，by:user；run.aborted 事件经 SSE 广播）。
  router.post('/:id/abort', async (req: Request, res: Response) => {
    ok(res, await deps.service.abortRun(req.user!, pathId(req)))
  })

  // POST /:id/resume —— interrupt 恢复（全端可审批；decisions 直通 #777 命令面，#783 接漏斗）。
  router.post('/:id/resume', validateBody(sessionResumeSchema), async (req: Request, res: Response) => {
    const { decisions } = req.body as z.infer<typeof sessionResumeSchema>
    ok(res, await deps.service.resumeRun(req.user!, pathId(req), decisions))
  })

  // GET /:id/messages —— 历史投影（story 3 回放面；与实时流终态零差异）。
  router.post('/:id/approvals/:escalationId', validateBody(sessionApprovalSchema), async (req, res) => {
    const { decision, reason } = req.body as z.infer<typeof sessionApprovalSchema>
    const id = typeof req.params.escalationId === 'string' ? req.params.escalationId : ''
    await deps.service.resolveApproval(req.user!, pathId(req), id, decision, reason)
    ok(res, null)
  })

  router.get('/:id/messages', async (req: Request, res: Response) => {
    ok(res, await deps.service.getProjection(req.user!, pathId(req)))
  })

  // POST /:id/rewind —— 回退重开（story 16 · #782 三态）：换 activeCheckpointId 指针 + 被放弃
  // 路线软删（#770）+ 文件逆放（scope=all 缺省；chat = 只回对话；files = 只回文件）+
  // session.invalidated{reason:rewind} 广播。
  router.post('/:id/rewind', validateBody(sessionRewindSchema), async (req: Request, res: Response) => {
    const { messageId, scope } = req.body as z.infer<typeof sessionRewindSchema>
    ok(res, await deps.service.rewindSession(req.user!, pathId(req), { messageId, scope }))
  })

  // POST /:id/rewind/preview —— 回退预览（#782 · D8）：逆放集摘要 + exec 跨越清单。只读。
  router.post('/:id/rewind/preview', validateBody(sessionRewindPreviewSchema), async (req: Request, res: Response) => {
    const { messageId } = req.body as z.infer<typeof sessionRewindPreviewSchema>
    ok(res, await deps.service.rewindPreview(req.user!, pathId(req), { messageId }))
  })

  // POST /:id/fork —— 复制出新会话（story 18/20 · #768 D7）：state/沙箱/journal/attachments
  // 全件 + session.created{source:fork} 广播。branch-switch 机制 #770 取消（fork 并存多开）。
  router.post('/:id/fork', validateBody(sessionForkSchema), async (req: Request, res: Response) => {
    const { messageId, title } = req.body as z.infer<typeof sessionForkSchema>
    ok(res, await deps.service.forkSession(req.user!, pathId(req), { messageId, title }))
  })

  return router
}
