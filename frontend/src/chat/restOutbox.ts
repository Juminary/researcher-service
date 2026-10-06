// restOutbox —— REST 断线排队（story 12 · #779「outbox 收敛为断线排队」）。
//
// 语义（#747 C 节「sessionStorage 落盘、重连按序 REST 幂等注入、上限 50 丢最旧」）：
//   - 断线期间用户发送 → enqueue（sessionStorage 落盘，刷新不丢——标签页生命周期语义，
//     旧 outboxStore #564 的窄窗落盘升级为整段断线排队）。
//   - SSE 重连后 flush：按入队序逐条 POST /sessions/:id/messages——clientKey 原样复用 =
//     服务端幂等 replay（story 7 已收消息必得 replay，不重复入列）。
//   - 按序纪律：逐条 await，失败即停（后续条保留）——保序注入，重连后续传。
//   - 上限 50 丢最旧（对齐官方 MAX_STORED_QUEUE_ITEMS；宁丢一条不爆 quota）。
//
// 仿 outboxStore 工厂模式（storage 注入可测，生产默认全局 sessionStorage——「本标签待发」
// 语义）。0 信任读回：逐字段 normalize（clientKey 32-hex / content 非空 / queuedAt 有限数），
// 坏行丢弃、坏 blob → 空（读取降级不抛）。接线归 #793（useEventStream 断线重连编排）。

import { getSafeSessionStorage } from './localStorage'

export const REST_OUTBOX_STORAGE_KEY = 'chat.restOutbox.v1'

export interface OutboxEntry {
  /** 32-hex 幂等 key（enqueue 时生成，flush 原样复用 → 服务端 replay 不重复入列） */
  clientKey: string
  content: string
  queuedAt: number
}

// flush 的注入缝：生产 = api sessions.sendMessage(sessionId, content, clientKey)（#793 接线）；
// 测试 fake。throw = 网络/服务故障 → flush 停止保序。
export type RestOutboxSend = (sessionId: string, entry: OutboxEntry) => Promise<void>

export interface RestOutbox {
  enqueue(sessionId: string, content: string, opts?: { idgen?: () => string; now?: () => number }): OutboxEntry
  pending(sessionId: string): OutboxEntry[]
  remove(sessionId: string, clientKey: string): void
  /** 按序逐条注入：成功（resolve）移除、失败（reject）停止并上抛；返回已注入条数 */
  flush(sessionId: string, send: RestOutboxSend): Promise<{ sent: number }>
}

// 单会话上限（对齐官方 MAX_STORED_QUEUE_ITEMS=50）：超限丢最旧（宁丢一条不爆 quota）。
const MAX_QUEUE_ITEMS = 50

// clientKey 严格 [0-9a-f]{32}（#778 服务端 MESSAGE_KEY_REGEX 的客户端镜像——校验背书在
// 服务端；gatewayChat.createRequestId 的旧 [a-z0-9]{32} 宽契约不适用 REST 幂等面）。
const CLIENT_KEY_REGEX = /^[0-9a-f]{32}$/

interface OutboxBlob {
  version: 1
  sessions: Record<string, OutboxEntry[]>
}

// 32-hex 幂等 key 生成（sendSessionMessage Idempotency-Key 与 outbox clientKey 同源共用——
// #793 接线：直发路径与断线排队路径共用同一 key 形态，重发必得 replay）。
export function newClientKey(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function createRestOutbox(storage: Storage | null = getSafeSessionStorage()): RestOutbox {
  // 逐字段 normalize：坏项（非对象/key 非 32-hex/空 content/queuedAt 非有限数）丢弃
  function normalizeEntry(v: unknown): OutboxEntry | null {
    if (!v || typeof v !== 'object') return null
    const rec = v as Record<string, unknown>
    const clientKey = typeof rec.clientKey === 'string' ? rec.clientKey : ''
    const content = typeof rec.content === 'string' ? rec.content : ''
    const queuedAt = typeof rec.queuedAt === 'number' && Number.isFinite(rec.queuedAt) ? rec.queuedAt : NaN
    if (!CLIENT_KEY_REGEX.test(clientKey) || content === '' || Number.isNaN(queuedAt)) return null
    return { clientKey, content, queuedAt }
  }

  function readBlob(): OutboxBlob | null {
    if (!storage) return null
    const raw = storage.getItem(REST_OUTBOX_STORAGE_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed?.version !== 1) return null
      const sessions: Record<string, OutboxEntry[]> = {}
      const rawSessions = parsed.sessions
      if (rawSessions && typeof rawSessions === 'object' && !Array.isArray(rawSessions)) {
        for (const [key, list] of Object.entries(rawSessions as Record<string, unknown>)) {
          if (!Array.isArray(list)) continue
          const entries = list.map(normalizeEntry).filter((e): e is OutboxEntry => e !== null)
          if (entries.length) sessions[key] = entries
        }
      }
      return { version: 1, sessions }
    } catch {
      return null // 损坏 blob → null（读取降级）
    }
  }

  function writeBlob(blob: OutboxBlob): void {
    if (!storage) return
    try {
      if (Object.keys(blob.sessions).length === 0) storage.removeItem(REST_OUTBOX_STORAGE_KEY)
      else storage.setItem(REST_OUTBOX_STORAGE_KEY, JSON.stringify(blob))
    } catch {
      // 配额满/隐私模式写入失败：静默降级（outbox 是尽力而为，不打断聊天）
    }
  }

  function mutate(sessionId: string, fn: (list: OutboxEntry[]) => OutboxEntry[]): void {
    const blob = readBlob() ?? { version: 1, sessions: {} }
    const next = fn(blob.sessions[sessionId] ?? [])
    if (next.length === 0) delete blob.sessions[sessionId]
    else blob.sessions[sessionId] = next
    writeBlob(blob)
  }

  return {
    enqueue(sessionId, content, opts) {
      const entry: OutboxEntry = {
        clientKey: opts?.idgen ? opts.idgen() : newClientKey(),
        content,
        queuedAt: opts?.now ? opts.now() : Date.now(),
      }
      mutate(sessionId, (list) => {
        const next = [...list, entry]
        if (next.length > MAX_QUEUE_ITEMS) next.splice(0, next.length - MAX_QUEUE_ITEMS) // 丢最旧
        return next
      })
      return entry
    },

    pending(sessionId) {
      return readBlob()?.sessions[sessionId] ?? []
    },

    remove(sessionId, clientKey) {
      mutate(sessionId, (list) => list.filter((e) => e.clientKey !== clientKey))
    },

    async flush(sessionId, send) {
      let sent = 0
      // 逐条快照读（每次从 storage 取队首——remove 后下一条自然前移；跨 flush 段一致）
      for (;;) {
        const list = this.pending(sessionId)
        if (list.length === 0) return { sent }
        const entry = list[0]
        await send(sessionId, entry) // throw → 保序停止（该条与后续保留）
        this.remove(sessionId, entry.clientKey)
        sent += 1
      }
    },
  }
}
