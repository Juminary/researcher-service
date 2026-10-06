<script setup lang="ts">
// T06 权限审批卡（#783 三层漏斗升级通道前端面 / #729）：橙边待处理，处理后落定即摘除
//（ADR 0014，摘除在父层）。props-in/emits-out 哑组件（#316：#340 拆分边界）。
// decision 两值：allow（放行一次）/ deny——allow-always 已砍（#729 钉死）。
// #793：teammate 审批带「队友协作」徽标（teammateId 非空；具名折叠区泛化归 #796）。
import type { ApprovalItem } from '@/stores/chat'

defineProps<{
  approval: ApprovalItem
  disconnected: boolean
}>()

const emit = defineEmits<{
  resolve: [approval: ApprovalItem, decision: 'allow' | 'deny']
  toggleDetail: [approval: ApprovalItem]
}>()

// 审批卡副标题（升级通道：工具执行被漏斗升级，需用户裁决）
function approvalSubtitle(a: ApprovalItem): string {
  return `agent 请求执行 ${a.toolName}，请确认后批准或拒绝：`
}

function commandSummary(command: string): string { return command.replace(/\s+/g, ' ').slice(0, 120) }
</script>

<template>
  <div class="approval" :data-test="`approval-${approval.id}`">
    <div class="a-head">
      ⚠️ 请求提升权限
      <span v-if="approval.teammateId" class="source-badge" data-test="approval-source">
        <span class="source-dot" />队友协作
      </span>
      <!-- #492：网关侧审批已失效（过期/他端处理）→ 终态不可回覆，明示「已失效」而非死卡 -->
      <span v-if="approval.status === 'expired'" class="resolved-tag expired" data-test="approval-expired">
        已失效
      </span>
    </div>
    <div class="a-sub">{{ approvalSubtitle(approval) }}</div>
    <div class="a-cmd" :title="approval.toolCallSummary">{{ commandSummary(approval.toolCallSummary) }}</div>
    <div v-if="approval.detailOpen" class="a-detail" :data-test="`approval-detail-${approval.id}`">
      参数摘要全文：<code>{{ approval.toolCallSummary }}</code><br>
      升级来源：<code>{{ approval.source }}</code>
      <template v-if="approval.judgeReason"> · judge 理由：<code>{{ approval.judgeReason }}</code></template>
      <br>审批 id：<code>{{ approval.id }}</code> · 经审批事件推送，审批接口回覆
    </div>
    <div v-if="approval.status !== 'expired'" class="a-actions">
      <button
        class="btn-approve"
        :disabled="approval.status !== 'pending' || disconnected"
        :title="disconnected ? '连接已断开，请重新连接后操作' : '仅批准本次操作'"
        :data-test="`approve-${approval.id}`"
        @click="emit('resolve', approval, 'allow')"
      >{{ approval.status === 'resolving' ? '处理中…' : '批准一次' }}</button>
      <button
        class="btn-deny"
        :disabled="approval.status !== 'pending' || disconnected"
        :title="disconnected ? '连接已断开，请重新连接后操作' : '拒绝本次操作'"
        :data-test="`deny-${approval.id}`"
        @click="emit('resolve', approval, 'deny')"
      >拒绝</button>
      <button class="btn-ghost" :data-test="`detail-${approval.id}`" @click="emit('toggleDetail', approval)">查看细节</button>
    </div>
  </div>
</template>

<style scoped>
/* 宽度与 AI 气泡一致（min 280 / max 840），左对齐——不再突兀窄于正文气泡。 */
.approval { align-self: flex-start; border: 1px solid var(--el-color-warning); background: var(--el-color-warning-light-9); border-radius: 11px; padding: 12px 14px; margin: 4px 0; min-width: 280px; max-width: 840px; }
.approval .a-head { display: flex; align-items: center; gap: 8px; color: var(--el-color-warning); font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.approval .source-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; color: var(--el-text-color-secondary); background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 10px; padding: 1px 8px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.approval .source-badge .source-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--el-color-warning); flex-shrink: 0; }
.approval .resolved-tag { margin-left: auto; font-size: 11.5px; color: var(--el-color-success); font-weight: 600; }
.approval .resolved-tag.deny { color: var(--el-color-danger); }
.approval .resolved-tag.unknown { color: var(--el-text-color-secondary); }
.approval .a-sub { color: var(--el-text-color-secondary); font-size: 13px; }
.approval .a-cmd { font-family: ui-monospace, monospace; background: var(--el-fill-color-darker); border: 1px solid var(--el-border-color); border-radius: 7px; padding: 8px 10px; margin: 8px 0; font-size: 12.5px; white-space: pre-wrap; word-break: break-all; }
.approval .a-detail { font-size: 11px; color: var(--el-text-color-secondary); margin-bottom: 6px; }
.approval .a-detail code { background: var(--el-fill-color); border-radius: 4px; padding: 1px 4px; }
.approval .a-actions { display: flex; gap: 9px; margin-top: 8px; }
.approval .a-actions button { border: none; border-radius: 7px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.approval .a-actions button:disabled { cursor: not-allowed; opacity: .5; }
.approval .btn-approve { background: var(--el-color-success); color: #fff; }
.approval .btn-deny { background: transparent; border: 1px solid var(--el-color-danger); color: var(--el-color-danger); }
.approval .btn-ghost { background: transparent; border: 1px solid var(--el-border-color); color: var(--el-text-color-secondary); }
.approval.resolved { opacity: .55; border-color: var(--el-border-color); }
.approval .resolved-tag.expired { color: var(--el-text-color-secondary); }
</style>
