// chatStore —— 对话页响应式投影（#316 候选 B / #340：Pinia 纯 mutation，贴 useWikiStore 形态）。
// #793 chat 核心重写（#730 §3.2「state 随投影行形状重定义」）：容器维度退役（instances/
// selectedContainer/branches 删除），会话扁平挂用户（story 4）；messages 形状 = 投影归约器
//（chat/projection.ts）的视图模型，类型自彼处再导出（16 组件 import 零改动）；
// 审批卡换 #783 升级通道形状（escalation 摘要 + allow/deny 两值）。
// 渲染状态与编排解耦：本 store 只做纯 mutation；SSE 路由 × 幂等发送 × 断线补偿的非响应式簇
// 归 useChatSession 同宿主（#340 关键约束延续）。
import { defineStore } from 'pinia'
import type { SessionApproval, SessionSummary } from '@/api/sessions'
import type { Msg } from '@/chat/projection'

// 视图模型单一来源在投影归约器（纯函数可测）——组件经由本 store 再导出保持 import 面不变。
export type { Msg, ToolRow } from '@/chat/projection'
export { hasTrace, newMsg, shouldFoldTrace } from '@/chat/projection'

// T06 审批卡（#783 三层漏斗前端面）：独立列表渲染，不混入 messages——避免破坏流式锚定
// （审查 #5），随会话切换清空。decision 两值（allow-always 已砍，#729）。
export interface ApprovalItem {
  id: string // escalation.id（审批回覆 REST 的定位参数）
  source: string // 升级来源：cautious-mode | judge-limit | repeat-reject | judge-malformed
  toolName: string
  toolCallSummary: string // 规范化参数 JSON 摘要（≤1KB）
  judgeReason?: string // judge 理由（repeat-reject / judge-malformed 附带）
  teammateId: string | null // 队友审批来源标识；null = 主会话审批
  status: 'pending' | 'resolving' | 'expired' // pending 待处理 / resolving 已点击等回执 / expired 已失效终态
  decision: '' | 'allow' | 'deny'
  detailOpen: boolean
  seq: number // ADR 0009：全局单调到达序号（先到者小、后到者大）
}

// 审批卡构造单一来源（0 信任逐字段走查）：SSE approval.requested 载荷与投影 approvals[] 双路
// 同形（escalation + teammateId）——两个生产方共用一个构造器，形状漂移单点修复。
export function approvalCardFields(
  escalation: unknown,
  teammateId: unknown,
): Omit<ApprovalItem, 'status' | 'decision' | 'detailOpen' | 'seq'> | null {
  if (!escalation || typeof escalation !== 'object') return null
  const esc = escalation as Record<string, unknown>
  const id = typeof esc.id === 'string' ? esc.id : ''
  const toolName = typeof esc.toolName === 'string' ? esc.toolName : ''
  if (!id || !toolName) return null
  return {
    id,
    source: typeof esc.source === 'string' ? esc.source : '',
    toolName,
    toolCallSummary: typeof esc.toolCallSummary === 'string' ? esc.toolCallSummary : '',
    ...(typeof esc.judgeReason === 'string' ? { judgeReason: esc.judgeReason } : {}),
    teammateId: typeof teammateId === 'string' && teammateId ? teammateId : null,
  }
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    // 会话列表：本人会话扁平挂用户（GET /api/v1/sessions，updatedAt DESC）。
    sessions: [] as SessionSummary[],
    selectedSession: '' as string,
    messages: [] as Msg[],
    approvals: [] as ApprovalItem[],
    // ADR 0009：审批卡全局到达序号计数器（addApproval 时赋 ++seqCounter）——严格单调递增。
    seqCounter: 0 as number,
    input: '' as string,
    // T07 斜杠命令补全：菜单选中项 + Esc 关闭态
    slashIndex: 0 as number,
    slashDismissed: false as boolean,
  }),
  getters: {
    // 审批卡列表（编排层只灌当前会话的卡：SSE 按 sessionId 分派 + 投影重拉按选中会话整替）。
    visibleApprovals(state): ApprovalItem[] {
      return state.approvals
    },
  },
  actions: {
    // ---- 会话 ----
    setSessions(list: SessionSummary[]): void {
      this.sessions = list
    },
    // 幂等 upsert（session.created/updated 事件 + 改名回执共用）：按 id 替换/头部插入。
    upsertSession(s: SessionSummary): void {
      const idx = this.sessions.findIndex((x) => x.id === s.id)
      if (idx === -1) {
        this.sessions = [s, ...this.sessions]
        return
      }
      this.sessions.splice(idx, 1, s)
    },
    // 新建会话置顶（幂等：upsert 后已在位的不重复插，保留权威行字段）。
    prependSession(s: SessionSummary): void {
      if (this.sessions.some((x) => x.id === s.id)) return
      this.sessions = [s, ...this.sessions]
    },
    removeSession(id: string): void {
      this.sessions = this.sessions.filter((s) => s.id !== id)
    },
    setSelectedSession(id: string): void {
      this.selectedSession = id
    },

    // ---- 消息投影（纯 mutation，供 useChatSession 经归约器调用）----
    setMessages(list: Msg[]): void {
      this.messages = list
    },
    pushMessage(m: Msg): void {
      this.messages.push(m)
    },
    // 乐观回显回填：POST 响应的 messageId 按发送键（sendKey）定位写回。
    markMessageId(sendKey: string, id: string): void {
      const m = this.messages.find((x) => x.role === 'user' && x.sendKey === sendKey && !x.id)
      if (m) m.id = id
    },
    // 发送失败摘除乐观行（按发送键定位；只摘无 id 的本轮 echo，已落库行不动）。
    removeMessage(sendKey: string): void {
      const idx = this.messages.findIndex((x) => x.role === 'user' && x.sendKey === sendKey && !x.id)
      if (idx !== -1) this.messages.splice(idx, 1)
    },
    setInput(v: string): void {
      this.input = v
    },
    // T1 轮次折叠（#664）手动开合：折叠条 emit 回父层落 store（自动折叠在归约器终态收敛）。
    toggleTraceFold(m: Msg): void {
      m.traceFolded = !m.traceFolded
    },

    // ---- 审批卡（T06 / #783 升级通道形状）----
    addApproval(card: Omit<ApprovalItem, 'status' | 'decision' | 'detailOpen' | 'seq'>): void {
      if (this.approvals.some((a) => a.id === card.id)) return // 幂等（事件 + 投影重拉双路去重）
      this.approvals.push({
        ...card,
        status: 'pending',
        decision: '',
        detailOpen: false,
        seq: ++this.seqCounter, // ADR 0009：到达序号（重连补拉排所有现有卡之后）
      })
    },
    markApproval(id: string, status: ApprovalItem['status']): void {
      const a = this.approvals.find((x) => x.id === id)
      if (a) a.status = status
    },
    // resolved/expired 不留痕（ADR 0014）：落定即从列表摘除，不回时间线。
    removeApproval(id: string): void {
      this.approvals = this.approvals.filter((a) => a.id !== id)
    },
    // 投影重拉整替（权威面）：服务端挂起中断即全量待决卡；resolving 本地态随权威面复位。
    setApprovalsFromProjection(list: SessionApproval[] | undefined): void {
      const next: ApprovalItem[] = []
      for (const item of list ?? []) {
        const card = approvalCardFields(item.escalation, item.teammateId)
        if (card) next.push({ ...card, status: 'pending', decision: '', detailOpen: false, seq: ++this.seqCounter })
      }
      this.approvals = next
    },
    toggleApprovalDetail(id: string): void {
      const a = this.approvals.find((x) => x.id === id)
      if (a) a.detailOpen = !a.detailOpen
    },

    // ---- 斜杠命令（T07）----
    setSlashDismissed(v: boolean): void {
      this.slashDismissed = v
    },
    setSlashIndex(i: number): void {
      this.slashIndex = i
    },

    // ---- 切会话清态（连接簇由 useEventStream/useChatSession 负责）----
    resetForSession(): void {
      this.messages = []
      this.approvals = []
      this.input = ''
      this.slashDismissed = false
      this.slashIndex = 0
    },
  },
})
