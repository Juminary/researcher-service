<script setup lang="ts">
// 输入区 + 斜杠命令补全（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// 斜杠菜单（slash-menu slot）由父注入表现；输入/键盘事件上抛。
// 匹配计算（slashQuery/slashMatches/slashOpen）单一来源在 ChatView（逻辑留宿主）——
// 本组件只收 matches/slashOpen props 渲染菜单，不重复计算。
// #459-T2 #463：附件采集壳——粘贴/拖拽/文件选择三通道仅做「采 File 上抛」，压缩/校验/发送逻辑全在
// 宿主 ChatView；预览条只渲染宿主给的 pendingAttachments（含 previewUrl），移除上抛 key。
import type { SlashOption } from '@/chat/useChatSession'
import type { PendingAttachment } from '@/chat/attachments'
import { nextTick, ref, watch } from 'vue'

// 预览项 PendingAttachment（结构上提 attachments.ts 单一来源，本组件只渲染）：
// att 附件数据 + previewUrl 缩略（图片 dataURL，非图片空）+ key。

const props = withDefaults(
  defineProps<{
    modelValue: string
    matches: SlashOption[]
    slashOpen: boolean
    slashIndex: number
    connecting: boolean
    streaming: boolean
    disconnected: boolean
    // Codex #703 P1（F2）：回退在途——窗口内投影还是回退前的旧代，发送会被随后的 abandonActiveRun
    // 吞掉（用户消息与回复双双丢失），故发送键置灰。输入框/附件编辑不受限（草稿指纹守卫允许窗口内
    // 继续编辑，回填时新草稿原地保留）。
    rewindBusy?: boolean
    // #697：fork 在途——同 rewindBusy 语义（导航窗口内 send 会被切换冲掉），发送键置灰；
    // 输入框/附件编辑不受限。
    forkBusy?: boolean
    pendingAttachments?: PendingAttachment[]
  }>(),
  { pendingAttachments: () => [] },
)

const emit = defineEmits<{
  'update:modelValue': [v: string]
  input: []
  send: []
  keydown: [e: KeyboardEvent]
  pickSlash: [alias: string]
  addFiles: [files: File[]]
  removeAttachment: [key: number]
}>()

defineSlots<{
  'slash-menu'?: (props: { matches: SlashOption[]; slashIndex: number }) => unknown
}>()

// 真实用户输入（非程序化赋值）：上抛 update:modelValue（v-model）+ input（父复位菜单态）
function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
  emit('input')
}

// ---- 附件三通道采集（仅采 File 上抛，不处理）----
// 粘贴（剪贴板文件，截图直发）。
function onPaste(e: ClipboardEvent): void {
  const files = Array.from(e.clipboardData?.files ?? [])
  if (files.length) {
    e.preventDefault()
    emit('addFiles', files)
  }
}

// 拖拽释放（文件/图片拖入输入区）。dragover 须 preventDefault 才会触发 drop。
// #5：仅当拖入内容含文件时才 preventDefault——无文件（拖纯文本/链接）不拦截，保留浏览器原生
// 「拖文本到光标处插入」行为（旧 composer 无 drop handler，该路径曾可用）。
function onDrop(e: DragEvent): void {
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (!files.length) return
  e.preventDefault()
  emit('addFiles', files)
}

// 文件选择按钮 → 隐藏 file-input；选完上抛并复位（同名文件可再选）。
const fileInput = ref<HTMLInputElement | null>(null)
function openFilePicker(): void {
  fileInput.value?.click()
}
function onPick(e: Event): void {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) emit('addFiles', files)
  input.value = ''
}
const inputEl = ref<HTMLTextAreaElement | null>(null)
function resize(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}
watch(() => props.modelValue, () => void nextTick(resize), { immediate: true })
</script>

<template>
  <div
    class="composer"
    data-test="composer"
    @paste="onPaste"
    @drop="onDrop"
    @dragover.prevent
  >
    <!-- T07 斜杠命令补全（spec §9.4 / 原型 oc-chat-page.html）：输入 `/` 弹菜单（前缀过滤，
         cmd mono + 描述），点选/↑↓+Enter 选中填入后经普通 send() 发 `/cmd`。 -->
    <slot
      v-if="slashOpen"
      name="slash-menu"
      :matches="matches"
      :slash-index="slashIndex"
    />
    <!-- #459-T2 #463：附件预览条——发送前缩略列表 + 逐个移除 + 合计状态（数据宿主给，移除上抛） -->
    <div v-if="pendingAttachments.length" class="preview-strip" data-test="preview-strip">
      <div
        v-for="p in pendingAttachments"
        :key="p.key"
        class="preview-item"
        data-test="preview-item"
      >
        <img v-if="p.previewUrl" :src="p.previewUrl" :alt="p.att.fileName" class="preview-thumb" />
        <span v-else class="preview-file" :title="p.att.fileName">{{ p.att.fileName }}</span>
        <button
          type="button"
          class="preview-remove"
          data-test="preview-remove"
          :disabled="connecting || streaming || disconnected"
          :aria-label="`移除 ${p.att.fileName}`"
          @click="emit('removeAttachment', p.key)"
        >✕</button>
      </div>
      <span class="attach-count" data-test="attach-count">{{ pendingAttachments.length }} 个附件</span>
    </div>
    <div class="composer-row">
      <button
        type="button"
        class="attach-btn"
        data-test="attach-btn"
        :disabled="connecting || streaming || disconnected"
        aria-label="添加附件"
        @click="openFilePicker"
      >📎</button>
      <input
        ref="fileInput"
        type="file"
        multiple
        data-test="file-input"
        class="file-input"
        @change="onPick"
      />
      <textarea
        ref="inputEl"
        :value="modelValue"
        data-test="input"
        rows="2"
        placeholder="发消息…（Enter 发送 / Shift+Enter 换行；输 / 弹命令补全；可粘贴/拖拽/选附件）"
        aria-label="消息输入框"
        @input="onInput"
        @keydown="emit('keydown', $event)"
      ></textarea>
      <button
        data-test="send"
        :disabled="connecting || streaming || disconnected || rewindBusy || forkBusy"
        :title="connecting ? '正在连接' : streaming ? '正在生成回答' : disconnected ? '连接已断开' : rewindBusy ? '正在回退' : forkBusy ? '正在分叉' : '发送消息'"
        aria-label="发送消息"
        @click="emit('send')"
      >发送</button>
    </div>
  </div>
</template>

<style scoped>
.composer { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--el-border-color); }
.composer-row { display: flex; width: 100%; max-width: 840px; margin: 0 auto; gap: 8px; align-items: flex-end; }
.composer-row textarea { flex: 1; resize: none; min-height: 42px; max-height: 180px; overflow-y: auto; padding: 8px; border: 1px solid var(--el-border-color); border-radius: 8px; box-sizing: border-box; }
.composer-row button { padding: 8px 16px; background: var(--el-color-primary); color: #fff; border: none; border-radius: 8px; cursor: pointer; }
.composer-row button:disabled { cursor: not-allowed; opacity: .55; }
.composer-row textarea:focus-visible, .composer-row button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

/* #459-T2 #463：附件采集 + 预览条 */
.attach-btn { padding: 8px 12px !important; background: transparent !important; border: 1px solid var(--el-border-color) !important; color: var(--el-text-color-regular) !important; font-size: 16px; }
.attach-btn:disabled { opacity: .5; cursor: default; }
.file-input { display: none; }
.preview-strip { display: flex; width: 100%; max-width: 840px; margin: 0 auto; flex-wrap: wrap; align-items: center; gap: 8px; }
.preview-item { position: relative; display: flex; align-items: center; border: 1px solid var(--el-border-color); border-radius: 8px; padding: 4px; background: var(--el-fill-color-light); }
.preview-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; display: block; }
.preview-file { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--el-text-color-regular); padding: 0 4px; }
.preview-remove { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; border: none; background: var(--el-color-danger); color: #fff; font-size: 11px; line-height: 1; cursor: pointer; padding: 0; }
.attach-count { margin-left: auto; font-size: 12px; color: var(--el-text-color-secondary); }
</style>
