<script setup lang="ts">
// #547：待处理权限请求独立于可滚动消息流，固定显示在 composer 上方。
// 卡片本身仍复用 ApprovalCard，审批状态机与事件协议保持不变。
import type { ApprovalItem } from '@/stores/chat'
import ApprovalCard from '@/components/chat/ApprovalCard.vue'

defineProps<{
  approvals: ApprovalItem[]
  disconnected: boolean
}>()

const emit = defineEmits<{
  resolve: [approval: ApprovalItem, decision: 'allow' | 'deny']
  toggleDetail: [approval: ApprovalItem]
}>()
</script>

<template>
  <section
    v-if="approvals.length"
    class="approval-dock"
    data-test="approval-dock"
    aria-label="待处理的权限请求"
    aria-live="polite"
  >
    <div class="dock-inner">
      <div class="dock-title">
        <span>需要你的确认</span>
        <span v-if="approvals.length > 1" class="dock-count">{{ approvals.length }} 项</span>
      </div>
      <div class="approval-list">
        <ApprovalCard
          v-for="approval in approvals"
          :key="approval.id"
          :approval="approval"
          :disconnected="disconnected"
          @resolve="(a, decision) => emit('resolve', a, decision)"
          @toggle-detail="(a) => emit('toggleDetail', a)"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.approval-dock {
  flex: 0 0 auto;
  padding: 10px 18px 0;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
  box-shadow: 0 -8px 22px rgba(0, 0, 0, .06);
  z-index: 2;
}
.dock-inner { width: 100%; max-width: 840px; margin: 0 auto; }
.dock-title { display: flex; align-items: center; gap: 8px; margin: 0 2px 7px; color: var(--el-text-color-secondary); font-size: 12px; font-weight: 600; }
.dock-count { padding: 1px 7px; border-radius: 10px; background: var(--el-fill-color); font-weight: 500; }
.approval-list { display: flex; flex-direction: column; gap: 8px; max-height: min(42vh, 360px); overflow-y: auto; overscroll-behavior: contain; padding: 0 2px 10px; }
.approval-list :deep(.approval) { width: 100%; max-width: none; min-width: 0; margin: 0; box-sizing: border-box; }

@media (max-width: 720px) {
  .approval-dock { padding: 8px 10px 0; }
  .approval-list { max-height: min(48vh, 320px); }
}
</style>
