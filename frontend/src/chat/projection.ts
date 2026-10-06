// 投影归约器（#730 §4.1 M1 核心 / #793）——eventTranslate 概念位的继任。
//
// 单管线渲染（#730 §1 设计原则）：ChatStream 消费的视图模型由同一归约器产出，两个入口——
//   applyEvent(vm, event)   实时路径：吃 #726/#773 SSE 事件目录增量（text/thinking/tool/attachment
//                           + run 生命周期），对在飞 overlay 原地累积；
//   fromProjection(p)       回放路径：吃 GET /sessions/:id/messages 聚合行（attachmentsJson v1），
//                           一次性重建全量视图。
// 两条路径产出同一数据形状，一致性（reduce(全量事件) ≡ 投影行）由 projection.test.ts 锁死
// （本票硬验收）。事件聚合语义逐条镜像 server/src/sessions/reducer.ts TurnReducer——
// tool.start 重复 id 忽略（先到者赢）、tool.end 无先前行忽略、attachment 引用直推、
// 空聚合终态不落视图（对齐 isEmpty 不落行）；差异只在视图面：state success→done 的呈现映射、
// input/details 的 JSON 解析（渲染层 toolRender 吃对象参数）。
//
// 纯函数纪律：不触 IO、不持模块状态、不改入参（copy-on-write——每条事件只克隆受影响消息，
// 其余按引用复用；流式 delta 高频路径不做全列表深拷贝）。run.failed 的错误分类红显**不在**
// 本归约器（错误横幅是编排层叠加态，投影行不含失败信息——刷新回放自然剥落，#730 §1.2）。
import type {
  LiveTurn,
  MediaRef,
  ProjectionMessage,
  SessionProjection,
  ToolLine,
} from '@/api/sessions'
import type { SessionEvent } from './useEventStream'

// ---- 视图模型（stores/chat.ts 原形状，随投影行形状重定义 #730 §3.2）----

export interface ToolRow {
  id: string | null // toolCallId（服务端事件/投影恒有；类型面保留 null 兼容旧渲染层）
  name: string
  state: 'running' | 'done' | 'error' // 服务端 'success' 的呈现映射（toolRender 全链吃 done）
  title: unknown // 官方 toolTitles 短标题位（新事件面无来源，恒 null → ToolLine 回退 name）
  input: unknown // JSON 参数（parse 失败/截断 → 原始字符串兜底）
  result: unknown // details 序列化的 JSON（同上兜底）
  durationMs?: number
  truncated?: boolean
  rejection?: { source: string; reason: string }
}

export interface Msg {
  role: 'user' | 'assistant'
  raw: string // 原始累积文本（新事件面 thinking 已结构化，raw ≡ text；保留字段稳住渲染层布局快照）
  text: string // 展示正文
  thinking: string // 思考链（thinking.delta 累积 / 投影行 thinking 列）
  thinkingOpen: boolean // 流式中思考未闭合（进行态装饰，回放路径恒 false）
  streaming: boolean // 在飞 overlay 标记（进行态装饰；投影行恒 false）
  tools: ToolRow[]
  media: MediaRef[] // #780 D9 媒体引用（attachmentsJson v1 / attachment 事件同形状）
  traceFolded?: boolean // 轮次折叠（#664）：assistant 有轨迹终态默认收起（两入口同判据）
  turnDurationMs?: number // #665 执行时长——新事件面无统一墙钟信号，两入口均不落值（TraceFold 回退计数文案；恢复挂 #794/#796 从行时间戳推导）
  id?: string // 消息行 id（已持久化有值；乐观 echo 由 POST 响应回填）——消息级操作入口定位参数
  runId?: string // 在飞 overlay 的归属 run（终态后保留；路由标签，回放路径无）
  sendKey?: string // 本轮 32-hex 幂等键（仅本地乐观 echo 有值）——POST 响应回填 id / 失败摘除的定位参数
}

export function newMsg(role: 'user' | 'assistant', text = ''): Msg {
  return {
    role,
    raw: text,
    text,
    thinking: '',
    thinkingOpen: false,
    streaming: role === 'assistant',
    tools: [],
    media: [],
  }
}

// 轨迹判定（#664）：思考非空或工具行非空即有轨迹；正文与媒体不算轨迹。归约器（终态折叠
// 判据）与渲染层（折叠条渲染门）共用此单一实现。
export function hasTrace(m: Msg): boolean {
  return m.thinking !== '' || m.tools.length > 0
}

// 默认折叠判定：assistant 且有轨迹（流式终态折叠与投影重建默认折叠共用）。
export function shouldFoldTrace(m: Msg): boolean {
  return m.role === 'assistant' && hasTrace(m)
}

// ---- 服务端形状 → 视图模型映射（两入口共用，零差异的机制载体）----

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// input/details 是「字符串原样，其余 JSON.stringify」的序列化产物（server projector.ts
// serializeDetails）——parse 成对象供 toolRender 消费；截断（可能切坏 JSON）或纯文本 → 原串兜底。
// 编排层（bridgeFileTabs 的工具事件桥）共用同一实现。
export function coerceJsonish(s: string | undefined): unknown {
  if (s === undefined || s === '') return null
  try {
    return JSON.parse(s) as unknown
  } catch {
    return s
  }
}

// ToolLine（事件聚合形状 / 投影行形状同体）→ ToolRow。success→done 是**呈现映射**，
// 两入口同走此处（零差异不因映射漂移）。
function toolRowFromServer(t: ToolLine): ToolRow {
  return {
    id: t.toolCallId,
    name: t.name,
    state: t.state === 'success' ? 'done' : t.state,
    title: null,
    input: coerceJsonish(t.input),
    result: coerceJsonish(t.details),
    ...(typeof t.durationMs === 'number' ? { durationMs: t.durationMs } : {}),
    ...(t.truncated ? { truncated: true } : {}),
    ...(t.rejection ? { rejection: { source: t.rejection.source, reason: t.rejection.reason } } : {}),
  }
}

// 投影行 → Msg（user/assistant 同构；assistant 有轨迹默认收起——#664 T3 历史折叠语义）。
function msgFromRow(row: ProjectionMessage): Msg {
  const m: Msg = {
    role: row.role === 'user' ? 'user' : 'assistant',
    raw: row.content,
    text: row.content,
    thinking: row.thinking ?? '',
    thinkingOpen: false,
    streaming: false,
    tools: (row.tools ?? []).map(toolRowFromServer),
    media: [...(row.media ?? [])],
    ...(row.id ? { id: row.id } : {}),
  }
  if (shouldFoldTrace(m)) m.traceFolded = true
  return m
}

// 在飞投影（#779 story 11：inFlight 从 checkpoint blob 重建）→ 流式 overlay（进行态装饰唯一
// 回放入口——刷新时在飞 run 的画面与断线前同构，#730 §1.3）。
function overlayFromInFlight(inf: LiveTurn): Msg {
  const m: Msg = {
    role: 'assistant',
    raw: inf.turn.content ?? '',
    text: inf.turn.content ?? '',
    thinking: inf.turn.thinking ?? '',
    thinkingOpen: false,
    streaming: true,
    tools: (inf.turn.tools ?? []).map(toolRowFromServer),
    media: [...(inf.turn.media ?? [])],
    ...(inf.runId ? { runId: inf.runId } : {}),
  }
  return m
}

// 回放入口：全量投影 → 视图模型（权威读模型一次性重建；在飞 run 重建为 overlay 挂尾）。
export function fromProjection(p: SessionProjection): Msg[] {
  const msgs = p.messages.map(msgFromRow)
  if (p.inFlight) msgs.push(overlayFromInFlight(p.inFlight))
  return msgs
}

// ---- 实时入口：事件增量归约（copy-on-write）----

// overlay 定位：**最后一条**匹配 runId 的流式 assistant 消息（per-session run 串行，#777
// per-thread 链——runId 变化即前 run 已终态；runId 缺省时回退「最后一条流式 assistant」，
// 兼容无 runId 的异常事件源不炸）。
function overlayIndex(vm: Msg[], runId: string | undefined): number {
  for (let i = vm.length - 1; i >= 0; i--) {
    const m = vm[i]
    if (m.role !== 'assistant' || !m.streaming) continue
    if (runId === undefined || m.runId === undefined || m.runId === runId) return i
  }
  return -1
}

function cloneOverlay(m: Msg): Msg {
  return { ...m, tools: [...m.tools], media: [...m.media] }
}

// 空聚合判据（镜像 server reducer.ts isEmpty——终态空 run 不落行，前端同步剥落空 overlay）。
function isEmptyMsg(m: Msg): boolean {
  return m.text === '' && m.thinking === '' && m.tools.length === 0 && m.media.length === 0
}

// 终态收尾（run.completed/failed/aborted/suspended 共用）：剥进行态装饰 + 轨迹默认收起 +
// 空 overlay 剥落（服务端不落行，两入口必须同形）。
function finalizeOverlay(m: Msg): Msg | null {
  m.streaming = false
  m.thinkingOpen = false
  if (shouldFoldTrace(m)) m.traceFolded = true
  return isEmptyMsg(m) ? null : m
}

// 实时入口：对 prev 应用一条当前会话事件，返回新视图模型（prev 不变）。非本归约器白名单的
// 事件（session.* / approval.* / teammate.* / 未知）由编排层消费，此处一律原样返回。
export function applyEvent(prev: Msg[], event: SessionEvent): Msg[] {
  const type = event.type

  if (type === 'run.started' || type === 'run.resumed') {
    // 幂等：inFlight 重建已建 overlay（重连后 run.started 重放同 runId）不重复建。
    if (overlayIndex(prev, event.runId) >= 0) return prev
    const overlay: Msg = { ...newMsg('assistant'), ...(event.runId ? { runId: event.runId } : {}) }
    return [...prev, overlay]
  }

  if (type === 'run.completed' || type === 'run.failed' || type === 'run.aborted' || type === 'run.suspended') {
    const idx = overlayIndex(prev, event.runId)
    if (idx < 0) return prev
    const finalized = finalizeOverlay(cloneOverlay(prev[idx]))
    if (!finalized) {
      const next = [...prev]
      next.splice(idx, 1)
      return next
    }
    const next = [...prev]
    next[idx] = finalized
    return next
  }

  if (type === 'text.delta' || type === 'thinking.delta' || type === 'tool.start' || type === 'tool.end' || type === 'attachment') {
    const idx = overlayIndex(prev, event.runId)
    // 无 overlay（事件先于 run.started 的乱序源/foreign run）：text/thinking 建行承载，
    // tool/attachment 无落点丢弃——镜像服务端「tool.end 无先前行忽略」的宽容度。
    if (idx < 0) {
      if (type !== 'text.delta' && type !== 'thinking.delta') return prev
      const delta = asString(event.payload.delta)
      if (delta === '') return prev
      const overlay: Msg = { ...newMsg('assistant'), ...(event.runId ? { runId: event.runId } : {}) }
      if (type === 'text.delta') {
        overlay.text = delta
        overlay.raw = delta
      } else {
        overlay.thinking = delta
        overlay.thinkingOpen = true
      }
      return [...prev, overlay]
    }

    const overlay = cloneOverlay(prev[idx])
    if (type === 'text.delta') {
      const delta = asString(event.payload.delta)
      if (delta === '') return prev
      overlay.text += delta
      overlay.raw = overlay.text
      overlay.thinkingOpen = false
    } else if (type === 'thinking.delta') {
      const delta = asString(event.payload.delta)
      if (delta === '') return prev
      overlay.thinking += delta
      overlay.thinkingOpen = true
    } else if (type === 'tool.start') {
      // 镜像 server TurnReducer：重复 toolCallId 忽略（先到者赢），input 截断同源不再截。
      const toolCallId = asString(event.payload.toolCallId)
      const name = event.payload.name
      if (!toolCallId || typeof name !== 'string') return prev
      if (overlay.tools.some((t) => t.id === toolCallId)) return prev
      const row = toolRowFromServer({
        toolCallId,
        name,
        input: asString(event.payload.input),
        state: 'running',
        ...(event.payload.truncated === true ? { truncated: true } : {}),
      })
      overlay.tools.push(row)
      overlay.thinkingOpen = false
    } else if (type === 'tool.end') {
      // 镜像 server TurnReducer：无先前行忽略（不补插）；state/durationMs/details 原样合入。
      const toolCallId = asString(event.payload.toolCallId)
      if (!toolCallId) return prev
      const tIdx = overlay.tools.findIndex((t) => t.id === toolCallId)
      if (tIdx < 0) return prev
      const row: ToolRow = { ...overlay.tools[tIdx] }
      const state = event.payload.state
      if (state === 'success' || state === 'error') row.state = state === 'success' ? 'done' : 'error'
      if (typeof event.payload.durationMs === 'number') row.durationMs = event.payload.durationMs
      if (typeof event.payload.details === 'string') row.result = coerceJsonish(event.payload.details)
      if (event.payload.truncated === true) row.truncated = true
      const rejection = event.payload.rejection
      if (rejection && typeof rejection === 'object') {
        const r = rejection as { source?: unknown; reason?: unknown }
        if (typeof r.source === 'string' && typeof r.reason === 'string') {
          row.rejection = { source: r.source, reason: r.reason }
        }
      }
      overlay.tools[tIdx] = row
    } else {
      // attachment：#780 D9 媒体引用直推（校验门镜像 server reducer.ts 的接受面）。
      const p = event.payload as Partial<MediaRef> | null
      if (
        !p ||
        typeof p.attachmentId !== 'string' || p.attachmentId === '' ||
        typeof p.mime !== 'string' ||
        typeof p.size !== 'number' ||
        typeof p.fileName !== 'string'
      ) {
        return prev
      }
      overlay.media.push({
        attachmentId: p.attachmentId,
        mime: p.mime,
        size: p.size,
        fileName: p.fileName,
        ...(typeof p.width === 'number' ? { width: p.width } : {}),
        ...(typeof p.height === 'number' ? { height: p.height } : {}),
        ...(typeof p.durationMs === 'number' ? { durationMs: p.durationMs } : {}),
      })
    }
    const next = [...prev]
    next[idx] = overlay
    return next
  }

  return prev
}
