<script setup lang="ts">
// 顶部栏：会话标题 + 容器 tag + 连接态（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// #698 分支菜单（#693 spec §1.5）：trailing 下拉——仅 branches.length > 1 渲染（单分支/拉取失败
// /能力缺失统一不渲染，界面噪音门）；每项 = headline（空 →「未命名分支」）+「N 条消息」+ 时间
//（可选槽位缺失不渲染）；active 项打勾且 disabled（no-op switch 网关是 typed error，UI 从不发起）；
// branchBusy 时触发器禁用（不隐藏——顶栏按钮闪现会推挤布局）且已开菜单强制收起。下拉为手写浮层
//（RewindConfirmPopover 先例：测试 mount 不装 ElementPlus 插件，仓库无 el-dropdown 使用习惯）。
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

// 分支菜单数据形状（#794 会话交互票接线投影 branches；#793 新管线暂不灌入——length>1 门恒不渲染）。
// 随 gatewayChat 类型家删除就地落位（本组件骨架保留，#794 复用时换投影 branches 数据源）。
interface SessionBranchDTO {
  leafEntryId: string
  active: boolean
  headline?: string
  messageCount?: number
  updatedAt?: string
}

const props = withDefaults(
  defineProps<{
    title: string
    // legacy 容器 tag（#793 chat 容器维度退役后恒空不渲染；prop 保留给分支菜单同窗的 #794 复用）
    container?: string
    connecting: boolean
    branches?: SessionBranchDTO[]
    branchBusy?: boolean
    // story 5 标题可改：有选中会话时渲染改名牌（宿主弹确认框，本组件只上抛）
    renameable?: boolean
  }>(),
  { container: '', renameable: false },
)

const emit = defineEmits<{
  branchSwitch: [leafEntryId: string]
  rename: []
}>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

// 时间格式化（TraceLogsView formatDate 先例）：非法日期串视同缺失（NaN → undefined，不渲染槽位）
function formatBranchTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString()
}

function toggle(): void {
  open.value = !open.value
}

function pick(b: SessionBranchDTO): void {
  if (b.active) return // active 项 disabled，防御性早退（正常路径按钮点不到）
  open.value = false
  emit('branchSwitch', b.leafEntryId)
}

// 点击外部收起（只认落在分支组件之外的按下——菜单项在 root 内，不会自我取消）
function onDocMousedown(e: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', onDocMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMousedown))

// busy 翻转（agent 开始工作 / 断线 / 切换在途）→ 强制收起已开菜单（禁用态下留着旧快照误导）
watch(
  () => props.branchBusy === true,
  (busy) => {
    if (busy) open.value = false
  },
)
</script>

<template>
  <div class="topbar">
    <span class="title" data-test="chat-title" :title="title || '对话'">{{ title || '对话' }}</span>
    <button
      v-if="renameable"
      type="button"
      class="rename-btn"
      data-test="rename-session"
      title="重命名会话"
      aria-label="重命名会话"
      @click="emit('rename')"
    >✎</button>
    <span v-if="container" class="tag">{{ container }}</span>
    <span v-if="connecting" class="tag warn">连接中…</span>
    <div v-if="(branches?.length ?? 0) > 1" ref="root" class="branch-wrap">
      <button
        class="branch-btn"
        :disabled="branchBusy"
        data-test="branch-menu"
        aria-label="Session branches"
        @click="toggle"
      >对话分支</button>
      <div v-if="open && !branchBusy" class="branch-list" data-test="branch-list">
        <button
          v-for="b in branches"
          :key="b.leafEntryId"
          class="branch-item"
          :class="{ active: b.active }"
          :disabled="b.active"
          :data-test="b.active ? 'branch-item-active' : 'branch-item'"
          @click="pick(b)"
        >
          <span class="branch-check" aria-hidden="true">{{ b.active ? '✓' : '' }}</span>
          <span class="branch-body">
            <span class="branch-headline">{{ b.headline || '未命名分支' }}</span>
            <span class="branch-meta">
              <span v-if="b.messageCount !== undefined">{{ b.messageCount }} 条消息</span>
              <span v-if="formatBranchTime(b.updatedAt)">{{ formatBranchTime(b.updatedAt) }}</span>
            </span>
          </span>
        </button>
      </div>
    </div>
    <slot name="banner" />
  </div>
</template>

<style scoped>
.topbar { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 10px 18px; border-bottom: 1px solid var(--el-border-color); }
.title { flex: 1; min-width: 0; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.rename-btn { flex: 0 0 auto; border: none; background: transparent; color: var(--el-text-color-placeholder); cursor: pointer; font-size: 13px; padding: 2px 6px; border-radius: 6px; }
.rename-btn:hover { color: var(--el-color-primary); background: var(--el-fill-color); }
.tag { flex: 0 0 auto; white-space: nowrap; font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); }
.tag.warn { color: var(--el-color-warning); }
.branch-wrap { position: relative; flex: 0 0 auto; }
.branch-btn { font-size: 12px; padding: 3px 10px; border-radius: 10px; border: 1px solid var(--el-border-color); background: var(--el-fill-color-light); color: var(--el-text-color-regular); cursor: pointer; }
.branch-btn:disabled { cursor: not-allowed; opacity: 0.5; }
.branch-list { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; min-width: 260px; max-width: 340px; padding: 4px; border-radius: 8px; border: 1px solid var(--el-border-color); background: var(--el-bg-color-overlay); box-shadow: var(--el-box-shadow-light); }
.branch-item { display: flex; gap: 8px; width: 100%; padding: 8px 10px; border: none; border-radius: 6px; background: none; text-align: left; cursor: pointer; }
.branch-item:hover { background: var(--el-fill-color-light); }
.branch-item:disabled { cursor: default; background: var(--el-fill-color-lighter); }
.branch-item.active { color: var(--el-color-primary); }
.branch-check { flex: 0 0 auto; min-width: 1em; }
.branch-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.branch-headline { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.branch-meta { display: flex; gap: 8px; font-size: 11px; color: var(--el-text-color-secondary); }
</style>
