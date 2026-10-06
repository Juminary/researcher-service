<script setup lang="ts">
defineOptions({ name: 'ChatView' })
// 对话页编排壳（#316 候选 B / #340：8 组件边界，本文件只做编排）。
// #793 chat 核心重写（#730 主骨架）：接线从网关协议机换轨 REST+SSE 三件套——
//   useEventStream（SSE 传输）+ chat/projection（投影归约器）+ useChatSession（会话编排）；
// 响应式投影（messages/approvals/sessions/输入）在 chatStore（纯 mutation）；8 个展示组件全
// props-in/emits-out 哑组件，6 slot 全开（msg-item/thinking/tool-line/empty/slash-menu/banner），
// 表现父注入、逻辑留宿主。容器维度退役（#730 §4.7）：无容器切换器/升级编排——侧栏 = 会话列表
//（扁平挂用户，story 4）+ 沙箱 lab 文件树（story 61）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { uploadSessionAttachment } from '@/api/sessions'
import type { SystemCommandResult } from '@/api/sessions'
import { useChatStore } from '@/stores/chat'
import { useFileTabsStore } from '@/stores/fileTabs'
import { useAuthStore, tokenOwner } from '@/stores/auth'
import { safeLocalStorage } from '@/storage'
import { useChatSession, type SentAttachment } from '@/chat/useChatSession'
import { INLINE_RANGE_NARROW, INLINE_RANGE_WIDE } from '@/panels/triState'
import { usePanelGroup } from '@/panels/usePanelGroup'
import { usePanelTriState } from '@/panels/usePanelTriState'
import PanelTriState from '@/components/PanelTriState.vue'
import {
  buildAttachments,
  compressImageFile,
  fileToRawAttachment,
  isAllowedAttachmentType,
  toPreviewDataUrl,
  type PendingAttachment,
  type RawAttachment,
} from '@/chat/attachments'
import ChatSidebar from '@/components/chat/ChatSidebar.vue'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import ChatStream from '@/components/chat/ChatStream.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import ApprovalDock from '@/components/chat/ApprovalDock.vue'
import FileTabsPanel from '@/components/chat/FileTabsPanel.vue'

const chat = useChatStore()
const auth = useAuthStore()
// 视图专属态（errorMsg 上抛至此；connecting/disconnected/lastRunError/run 在 composable 内）
const errorMsg = ref('')

// #671 / #672：本页三态面板组（每页一个实例，非模块级单例）——左栏与右侧文件预览共用一组，
// 弹一个自动收回另一个（spec #667 US25）。互斥逻辑单一实现在 usePanelGroup。
const panelGroup = usePanelGroup()
// 左栏三态（inline 拖宽 160–560px / collapsed 窄条 / popped 浮层）：默认宽沿用原 220px 固定宽。
// 「会话｜文件」分段切换仍归本组件（sidebarTab），与呈现态正交。
const SIDEBAR_DEFAULT_WIDTH = 220
const sidebarPanel = usePanelTriState({
  view: 'chat',
  panel: 'sidebar',
  side: 'left',
  inlineRange: INLINE_RANGE_NARROW,
  defaultInlineWidth: SIDEBAR_DEFAULT_WIDTH,
  token: () => auth.token,
  group: panelGroup,
})
const {
  state: sidebarState,
  inlineWidth: sidebarWidth,
  poppedVw: sidebarPoppedVw,
  disabled: sidebarDisabled,
  viewportWidth: sidebarViewportWidth,
  onCollapse: onSidebarCollapse,
  onPop: onSidebarPop,
  onExpand: onSidebarExpand,
  onRestore: onSidebarRestore,
  onResizeInline: onSidebarResizeInline,
  onResizePopped: onSidebarResizePopped,
  onDragEnd: onSidebarDragEnd,
} = sidebarPanel

// #672：右侧文件预览三态（inline 拖宽 240–720px / collapsed 窄条 / popped 浮层），贴右边。
// 默认宽沿用原 360px 固定宽；与左栏同组 → 同页至多一个浮层（与 wiki 页机制同源）。
const FILE_PANEL_DEFAULT_WIDTH = 360
const filePreviewPanel = usePanelTriState({
  view: 'chat',
  panel: 'file-preview',
  side: 'right',
  inlineRange: INLINE_RANGE_WIDE,
  defaultInlineWidth: FILE_PANEL_DEFAULT_WIDTH,
  token: () => auth.token,
  group: panelGroup,
})
const {
  state: filePanelState,
  inlineWidth: filePanelWidth,
  poppedVw: filePanelPoppedVw,
  disabled: filePanelDisabled,
  viewportWidth: filePanelViewportWidth,
  onCollapse: onFilePanelCollapse,
  onPop: onFilePanelPop,
  onExpand: onFilePanelExpand,
  onRestore: onFilePanelRestore,
  onResizeInline: onFilePanelResizeInline,
  onResizePopped: onFilePanelResizePopped,
  onDragEnd: onFilePanelDragEnd,
} = filePreviewPanel

// #626 T1：左栏「会话｜文件」分段态（视图专属，默认「会话」）+ lab 文件 tab store（决议 A）
const sidebarTab = ref<'sessions' | 'files'>('sessions')
const fileTabs = useFileTabsStore()
// 切到「文件」分段：树未加载则拉一次；切会话：fileTabs.reset 已清树，在 files 分段时重拉
watch(sidebarTab, (tab) => {
  if (tab === 'files' && chat.selectedSession && !fileTabs.tree && !fileTabs.treeLoading) {
    void fileTabs.loadTree()
  }
})
watch(() => chat.selectedSession, (id) => {
  if (sidebarTab.value === 'files' && id) void fileTabs.loadTree()
})
function switchSidebarTab(tab: 'sessions' | 'files'): void {
  sidebarTab.value = tab
}
function activateTab(path: string): void {
  fileTabs.activePath = path
}

// ---- 会话编排（三件套之三）----
const conn = useChatSession({
  onError(message: string) {
    errorMsg.value = message
  },
  onClearError() {
    errorMsg.value = ''
  },
  // 动作类失败走瞬时 toast，不进顶部连接横幅（贴 #461 删除会话失败 toast 先例）。
  onActionError(message: string) {
    ElMessage.error(message)
  },
  // Enter/斜杠发送统一走 sendMessage（含附件校验/清空预览条），与发送按钮同路径。
  // 箭头闭包延迟求值——sendMessage 为 function 声明提升，Enter 触发时 conn 已就绪。
  onSend() {
    void sendMessage()
  },
  // 系统命令结果：/new → 选中服务端新建的会话；/model → 提示当前生效面。
  onCommand(cmd: SystemCommandResult) {
    if (cmd.name === 'new' && cmd.sessionId) {
      conn.selectSession(cmd.sessionId)
      ElMessage.success('已新建会话')
      return
    }
    if (cmd.name === 'model') {
      const m = cmd.model
      ElMessage.success(m ? `下一条消息起使用模型 ${m.modelId}` : '未指定模型，沿用面板默认')
    }
  },
})
// 嵌套 ref 在模板中不解包（conn 是普通对象）——顶层解构后模板自动解包（slash 匹配单一来源在
// useChatSession，此处只消费）
const slashOpen = conn.slashOpen
const slashMatches = conn.slashMatches
const connecting = conn.connecting

const currentSessionTitle = computed(() => {
  const s = chat.sessions.find((x) => x.id === chat.selectedSession)
  return s?.title || (s ? s.id.slice(0, 8) : '') || ''
})

// 是否有在飞 run（流式 overlay）——发送门控 + 中断按钮 + 执行状态行（story 8 前端面）
const running = conn.running

// 连接/加载横幅 + 错误分类红显（story 10：llm_error/recursion_limit/infra）。
// run.error 横幅独立于连接横幅——run 失败不等于连接失败；进行态装饰随下次 run/切会话剥落。
const connectionState = computed(() => {
  if (connecting.value) return { tone: 'info', label: '正在连接…', detail: '', test: 'connection-banner' }
  if (conn.disconnected.value) return { tone: 'danger', label: '连接已断开', detail: errorMsg.value, test: 'reconnect-bar' }
  if (errorMsg.value) return { tone: 'danger', label: '加载失败', detail: errorMsg.value, test: 'connection-banner' }
  return null
})

// #542：执行状态指示——与上方连接横幅互补，横幅只报连接态（正在连接/断开/加载失败），
// 此行只反映「正在干活」的瞬时态；横幅可见时返回空串整行隐藏，不重复横幅文案。
// story 8：在飞 run 时行内挂「中断」入口（REST POST /abort；50006 无在飞 → toast）。
const executionStatus = computed(() => {
  if (connectionState.value) return ''
  if (chat.approvals.some((a) => a.status === 'pending')) return '等待批准'
  if (running.value) return '模型正在回答…'
  if (chat.messages.some((m) => m.tools.some((t) => t.state === 'running'))) return '正在执行工具…'
  return '已连接'
})

// #668：JWT 身份解析与 localStorage 安全访问收敛到共享实现（stores/auth.tokenOwner /
// storage.safeLocalStorage），面板三态宽度持久化共用同一套隔离语义。
function draftKey(session = chat.selectedSession): string {
  return `researcher:draft:${tokenOwner(auth.token)}:${session}`
}
watch(() => chat.selectedSession, () => {
  if (chat.selectedSession) chat.setInput(safeLocalStorage()?.getItem(draftKey()) ?? '')
})
watch(() => chat.input, (value) => {
  if (!chat.selectedSession) return
  const storage = safeLocalStorage(); if (!storage) return
  if (value) storage.setItem(draftKey(), value); else storage.removeItem(draftKey())
})

// story 5 标题可改：改名牌（ChatHeader）→ 确认框 → PATCH /sessions/:id。
async function renameSession(): Promise<void> {
  if (!chat.selectedSession) return
  try {
    const { value } = await ElMessageBox.prompt('输入新的会话标题', '重命名会话', {
      type: 'info',
      inputValue: currentSessionTitle.value,
      inputPattern: /\S/,
      inputErrorMessage: '标题不能为空',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    })
    await conn.renameSession(chat.selectedSession, value)
  } catch {
    // 用户取消
  }
}

// #547 / ADR 0014：pending/resolving 请求固定在 composer 上方 ApprovalDock，避免被长回答顶出可视区域。
// resolved/expired 卡不留痕（ADR 0014）——落定即从界面消失，不回时间线。
const activeApprovals = computed(() =>
  conn.chat.visibleApprovals.filter((a) => a.status === 'pending' || a.status === 'resolving'),
)

function toggleApprovalDetail(a: { id: string }): void {
  chat.toggleApprovalDetail(a.id)
}

// 删除会话：确认（ElMessageBox）由本壳注入（composable 内不持有 UI）。
// #461：文案明示硬删除不可恢复（删除即硬删，级联删沙箱由服务端负责）。
async function confirmRemoveSession(): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      '确认删除该会话？删除后不可恢复。',
      '删除会话',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    return true
  } catch {
    return false // 用户取消
  }
}

async function removeSession(id: string): Promise<void> {
  const res = await conn.removeSession(id, confirmRemoveSession)
  if (res === true) {
    safeLocalStorage()?.removeItem(draftKey(id))
    ElMessage.success('会话已删除')
  }
  else if (typeof res === 'string') ElMessage.error(res) // #461：失败 → 醒目错误 toast
  // null = 用户取消：无反馈
}

// ---- 附件采集（预览条状态归宿主，贴 connecting/errorMsg 先例——本地瞬态 UI 态）----
// 预览项 PendingAttachment（结构上提 attachments.ts 单一来源）= 采集到的 RawAttachment（content 纯
// base64）+ 本地缩略 previewUrl（图片经 toPreviewDataUrl 重建 dataURL）；发送前经 buildAttachments
// 统一校验（类型/体积）→ 逐个上传（POST /sessions/:id/attachments）→ attachmentIds 随消息发送。
const pendingAttachments = ref<PendingAttachment[]>([])
let attachKey = 0
let uploading = false

// 预览条追加（单一入口）：采集三通道（粘贴/拖拽/选择）共用同一落点——key 单调递增
// （移除按钮按 key 定位）、图片经 toPreviewDataUrl 重建 dataURL 缩略。
function pushAttachment(att: RawAttachment): void {
  pendingAttachments.value.push({ key: ++attachKey, att, previewUrl: toPreviewDataUrl(att) })
}

// 三通道共用入口：粘贴/拖拽/文件选择的 File 列表 → 压缩（图片）/转换（非图片）→ 入预览条。
// 不支持的类型（非 image/audio/video）即时提示，不入预览条（体积校验留发送前 buildAttachments 兜底）。
async function addFiles(files: File[]): Promise<void> {
  for (const file of files) {
    if (!isAllowedAttachmentType(file.type)) {
      ElMessage.error(`不支持的附件类型：${file.name}`)
      continue
    }
    try {
      const att = file.type.startsWith('image/')
        ? await compressImageFile(file)
        : await fileToRawAttachment(file)
      pushAttachment(att)
    } catch {
      ElMessage.error(`附件读取失败：${file.name}`)
    }
  }
}

function removeAttachment(key: number): void {
  pendingAttachments.value = pendingAttachments.value.filter((p) => p.key !== key)
}

// base64（纯）→ Blob（上传面：RawAttachment content 重建字节，文件名/mime 为权威元数据）
function base64ToBlob(content: string, mime: string): Blob {
  const bin = atob(content)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// 发送（Enter/按钮/斜杠统一入口，#1）：buildAttachments 校验预览条 → 有拒发则提示不发；
// 全放行 → 逐个上传换 attachmentId（失败中止保留预览条）→ conn.send（幂等/门控/断线排队）。
// 仅真受理才清空预览条（conn.send 守卫早退——无会话/在飞/审批挂起——返回 false，附件不丢）。
async function sendMessage(): Promise<void> {
  if (uploading) return
  const { attachments, rejected } = buildAttachments(pendingAttachments.value.map((p) => p.att))
  if (rejected.length > 0) {
    const oversize = rejected.some((r) => r.reason === 'size')
    ElMessage.error(oversize ? '文件过大，无法发送' : '存在不支持的附件类型')
    return
  }
  let refs: SentAttachment[] | undefined
  if (attachments.length) {
    if (!chat.selectedSession || conn.disconnected.value) {
      ElMessage.error(conn.disconnected.value ? '连接已断开，暂不能发送附件' : '请先选择会话')
      return
    }
    uploading = true
    try {
      refs = []
      for (const att of attachments) {
        const content = typeof att.content === 'string' ? att.content : ''
        const mime = att.mimeType ?? 'application/octet-stream'
        const meta = await uploadSessionAttachment(
          chat.selectedSession,
          base64ToBlob(content, mime),
          att.fileName ?? 'file',
          mime,
        )
        refs.push({ attachmentId: meta.attachmentId, mime: meta.mimeType, size: meta.size, fileName: meta.fileName })
      }
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : '附件上传失败')
      return // 预览条保留，可重试
    } finally {
      uploading = false
    }
  }
  const accepted = conn.send(refs)
  if (accepted) pendingAttachments.value = [] // 真受理 → 预览条清空；早退保留
}

async function regenerate(text: string): Promise<void> {
  if (!text || running.value || conn.disconnected.value) return
  chat.setInput(text)
  await nextTick()
  await sendMessage()
}

onMounted(() => {
  void conn.boot()
})
onBeforeUnmount(() => {
  conn.dispose()
})

defineExpose({
  // #9：暴露的发送统一走 sendMessage（含附件校验/清空预览条），与按钮/Enter 同路径，不分叉。
  send: () => sendMessage(),
  newSession: conn.newSession,
  selectSession: conn.selectSession,
})
</script>

<template>
  <div class="chat">
    <!-- #671：左栏接入三态包装（拖宽/窄条/浮层）；窄屏整体禁用，退回本页原响应式布局。 -->
    <PanelTriState
      :state="sidebarState"
      side="left"
      label="侧栏"
      :disabled="sidebarDisabled"
      :inline-width="sidebarWidth"
      :default-width="SIDEBAR_DEFAULT_WIDTH"
      :popped-vw="sidebarPoppedVw"
      :viewport-width="sidebarViewportWidth"
      @collapse="onSidebarCollapse"
      @pop="onSidebarPop"
      @expand="onSidebarExpand"
      @restore="onSidebarRestore"
      @resize-inline="onSidebarResizeInline"
      @resize-popped="onSidebarResizePopped"
      @drag-end="onSidebarDragEnd"
    >
      <ChatSidebar
        :sessions="chat.sessions"
        :selected-session="chat.selectedSession"
        :sidebar-tab="sidebarTab"
        :tree="fileTabs.tree"
        :tree-error="fileTabs.treeError"
        :active-file-path="fileTabs.activePath ?? ''"
        @select-session="conn.selectSession"
        @remove-session="removeSession"
        @new-session="conn.newSession"
        @switch-tab="switchSidebarTab"
        @open-file="(path: string) => void fileTabs.openFromTree(path)"
      />
    </PanelTriState>
    <main class="main">
      <ChatHeader
        :title="currentSessionTitle"
        :connecting="connecting"
        :renameable="!!chat.selectedSession"
        @rename="renameSession"
      />
      <div v-if="connectionState" class="connection-banner" :class="connectionState.tone" role="status" aria-live="polite" :data-test="connectionState.test">
        <span class="connection-label">{{ connectionState.label }}</span>
        <span v-if="connectionState.detail" class="connection-detail" data-test="error-bar">{{ connectionState.detail }}</span>
        <button v-if="conn.disconnected.value" class="reconnect" data-test="reconnect" @click="conn.reconnect()">重新连接</button>
      </div>
      <!-- story 10 错误分类红显：run.failed 的三分类横幅（进行态装饰——随新 run/切会话剥落） -->
      <div v-if="conn.lastRunError.value" class="connection-banner danger run-error" role="alert" data-test="run-error">
        <span class="connection-label">运行失败（{{ conn.lastRunError.value.kind }}）</span>
        <span class="connection-detail">{{ conn.lastRunError.value.label }}</span>
      </div>
      <div v-if="executionStatus" class="execution-status" role="status" aria-live="polite" data-test="execution-status">
        <span>{{ executionStatus }}</span>
        <button v-if="running" type="button" class="abort" data-test="abort" @click="conn.abort()">中断</button>
      </div>
      <ChatStream
        :messages="chat.messages"
        :history-has-more="false"
        :history-loading="false"
        @regenerate="regenerate"
        @toggle-trace-fold="chat.toggleTraceFold"
      >
        <!-- #461：无选中会话（含删除当前会话后）→ 空态视图 + 「新建会话」入口 -->
        <template #empty>
          <div v-if="!chat.selectedSession" class="empty-state" data-test="empty-state">
            <p class="empty-title">未选择会话</p>
            <p class="empty-hint">选择一个会话继续对话，或新建会话</p>
            <button
              type="button"
              class="empty-new"
              data-test="empty-new-session"
              :disabled="conn.disconnected.value"
              @click="conn.newSession"
            >＋ 新建会话</button>
          </div>
        </template>
      </ChatStream>
      <ApprovalDock
        :approvals="activeApprovals"
        :disconnected="conn.disconnected.value"
        @resolve="conn.resolveApproval"
        @toggle-detail="toggleApprovalDetail"
      />
      <ChatComposer
        v-model="chat.input"
        :matches="slashMatches"
        :slash-open="slashOpen"
        :slash-index="chat.slashIndex"
        :connecting="connecting"
        :streaming="running"
        :disconnected="conn.disconnected.value"
        :pending-attachments="pendingAttachments"
        @input="conn.onComposerInput"
        @keydown="conn.onComposerKeydown"
        @send="sendMessage"
        @pick-slash="conn.pickSlash"
        @add-files="addFiles"
        @remove-attachment="removeAttachment"
      >
        <!-- T07 斜杠补全菜单表现（父注入，逻辑留宿主 useChatSession） -->
        <template #slash-menu="{ matches, slashIndex }">
          <div v-if="matches.length" class="slash-menu" data-test="slash-menu">
            <div
              v-for="(o, i) in matches"
              :key="o.alias"
              class="slash-item"
              :class="{ sel: i === slashIndex }"
              data-test="slash-item"
              @mousedown.prevent="conn.pickSlash(o.alias)"
            >
              <span class="cmd">{{ o.alias }}</span><span class="desc">{{ o.description }}</span>
            </div>
          </div>
        </template>
      </ChatComposer>
    </main>
    <!-- #672：无 tab 时连三态包装一起不渲染（不残留幽灵手柄/浮层入口）；有 tab 时恒以
         inline 起步（呈现态不持久化），拖宽/折叠/弹出由三态包装接管。 -->
    <PanelTriState
      v-if="fileTabs.tabs.length"
      :state="filePanelState"
      side="right"
      label="文件预览"
      :disabled="filePanelDisabled"
      :inline-width="filePanelWidth"
      :default-width="FILE_PANEL_DEFAULT_WIDTH"
      :popped-vw="filePanelPoppedVw"
      :viewport-width="filePanelViewportWidth"
      @collapse="onFilePanelCollapse"
      @pop="onFilePanelPop"
      @expand="onFilePanelExpand"
      @restore="onFilePanelRestore"
      @resize-inline="onFilePanelResizeInline"
      @resize-popped="onFilePanelResizePopped"
      @drag-end="onFilePanelDragEnd"
    >
      <FileTabsPanel
        :tabs="fileTabs.tabs"
        :active-path="fileTabs.activePath"
        @activate="activateTab"
        @close="fileTabs.closeTab"
        @close-all="fileTabs.closeAll"
        @retry="fileTabs.retry"
      />
    </PanelTriState>
  </div>
</template>

<style scoped>
.chat { display: flex; height: 100%; min-height: 0; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
/* 原 .file-panel 固定宽（360px）已移除：宽度由 PanelTriState 三态接管，避免双重定宽。 */
.connection-banner { display: flex; align-items: center; gap: 10px; padding: 8px 18px; font-size: 13px; }
.connection-banner.info { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.connection-banner.danger { color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
.connection-label { font-weight: 600; }
.connection-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.connection-banner .reconnect { margin-left: auto; background: transparent; border: 1px solid currentColor; border-radius: 6px; padding: 2px 10px; cursor: pointer; color: inherit; font-size: 12.5px; }
.execution-status { display: flex; align-items: center; gap: 10px; padding: 5px 18px; border-bottom: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 12px; }
.execution-status .abort { margin-left: auto; background: transparent; border: 1px solid var(--el-color-danger); color: var(--el-color-danger); border-radius: 6px; padding: 2px 10px; cursor: pointer; font-size: 12px; }
.execution-status .abort:hover { background: var(--el-color-danger-light-9); }

/* T07 斜杠补全菜单（spec §9.4 / 原型 oc-chat-page.html）：弹在输入框上方，cmd mono + 描述 */
.slash-menu { position: absolute; bottom: calc(100% + 6px); left: 18px; right: 18px; max-height: 280px; overflow-y: auto; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color); border-radius: 11px; box-shadow: 0 -8px 30px rgba(0, 0, 0, .18); z-index: 10; }
.slash-item { display: flex; align-items: center; gap: 10px; padding: 9px 14px; cursor: pointer; }
.slash-item.sel, .slash-item:hover { background: var(--el-fill-color); }
.slash-item .cmd { font-family: ui-monospace, monospace; color: var(--el-color-primary); font-size: 13px; }
.slash-item .desc { margin-left: auto; color: var(--el-text-color-secondary); font-size: 12px; }
@media (max-width: 720px) {
  .chat { flex: 1; min-height: 0; flex-direction: column; }
  /* #671 / #672：窄屏三态整体禁用，两侧面板退回「整列常驻块」——覆盖包装的默认宽度与贴边竖边框
     （原 .side 上的同款规则上移到包装），横向堆叠改纵向分区。 */
  .chat :deep(.panel.plain) { width: auto; border-right: 0; border-bottom: 1px solid var(--el-border-color); }
  .chat :deep(.side) { max-height: 34vh; }
  .chat :deep(.stream) { padding: 12px; }
  .chat :deep(.composer) { padding: 10px 12px; }
  .chat :deep(.msg), .chat :deep(.approval) { min-width: 0; max-width: 100%; box-sizing: border-box; }
}

/* #461：无选中会话空态视图（删除当前会话后停留空聊天区）——居中提示 + 新建会话入口 */
.empty-state { margin: auto; text-align: center; color: var(--el-text-color-secondary); }
.empty-title { margin: 0 0 6px; font-size: 14px; }
.empty-hint { margin: 0 0 12px; font-size: 12.5px; }
.empty-new { background: transparent; border: 1px dashed var(--el-border-color); border-radius: 7px; padding: 6px 16px; cursor: pointer; color: var(--el-text-color-secondary); font-size: 13px; }
.empty-new:disabled { cursor: default; opacity: .6; }
</style>
