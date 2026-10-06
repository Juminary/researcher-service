<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, toRaw } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { abortSession, createSession, getSessionProjection, listSessions, resolveSessionApproval, sendSessionMessage, type SessionProjection, type SessionSummary } from '@/api/sessions'
import SessionTimeline from '@/components/chat/SessionTimeline.vue'
import { applySessionEvent, reconcileSessionProjection, type SessionEvent } from '@/chat/teamProjection'
import { useEventStream } from '@/chat/useEventStream'
import { createRestOutbox } from '@/chat/restOutbox'

const route = useRoute()
const router = useRouter()
const selected = computed(() => typeof route.params.id === 'string' ? route.params.id : '')
const sessions = ref<SessionSummary[]>([])
const projection = ref<SessionProjection | null>(null)
const input = ref('')
const error = ref('')
const connected = ref(true)
const actionBusy = ref(false)
const outbox = createRestOutbox()
const running = computed(() => !!projection.value?.inFlight)
const leaderApproval = computed(() => projection.value?.approvals?.some(item => !item.teammateId) ?? false)
let stopEvents = () => {}
let disposed = false
let refreshing = false
let refreshAgain = false
let refreshPending: Promise<void> = Promise.resolve()
const sending = new Set<string>()

function refresh(): Promise<void> {
  if (refreshing) { refreshAgain = true; return refreshPending }
  refreshPending = refreshNow()
  return refreshPending
}
async function refreshNow() {
  if (disposed) return
  if (refreshing) { refreshAgain = true; return }
  refreshing = true
  try {
    do {
      refreshAgain = false
      const id = selected.value
      const [list, history] = await Promise.all([listSessions(), id ? getSessionProjection(id) : Promise.resolve(null)])
      if (!disposed && id === selected.value) { sessions.value = list; projection.value = history ? reconcileSessionProjection(projection.value ? toRaw(projection.value) : null, history) : null }
    } while (refreshAgain && !disposed)
  } catch (cause) { showError(cause) }
  finally { refreshing = false }
}
function showError(cause: unknown) { error.value = cause instanceof Error ? cause.message : '操作失败，请重试' }
async function act(action: () => Promise<void>) {
  if (actionBusy.value) return
  actionBusy.value = true; error.value = ''
  try { await action() } catch (cause) { showError(cause) } finally { actionBusy.value = false }
}
async function flushOutbox() {
  const id = selected.value
  if (!id || sending.has(id) || running.value || leaderApproval.value) return
  const entry = outbox.pending(id)[0]
  if (!entry) return
  sending.add(id)
  try {
    const result = await sendSessionMessage(id, entry.content, entry.clientKey)
    outbox.remove(id, entry.clientKey)
    if (selected.value === id && projection.value && result.runId && !projection.value.inFlight) projection.value.inFlight = { runId: result.runId, state: 'queued', turn: { content: '' } }
  } finally { sending.delete(id) }
}
function onEvent(event: SessionEvent) {
  if (event.type === 'stream.opened') {
    connected.value = true
    void refresh().then(flushOutbox).catch(showError)
    return
  }
  if (event.type === 'session.created') { void refresh(); return }
  if (event.sessionId !== selected.value || !projection.value) return
  projection.value = applySessionEvent(toRaw(projection.value), event)
  if (event.type === 'run.failed') {
    const labels: Record<string, string> = { llm_error: '模型请求失败', recursion_limit: '运行步数达到上限', infra: '运行环境异常' }
    error.value = labels[String(event.payload.errorKind)] ?? '运行失败'
  }
  if (event.type.startsWith('session.') || event.type.startsWith('teammate.') || ['run.completed', 'run.failed', 'run.aborted', 'run.suspended', 'approval.resolved'].includes(event.type)) {
    void refresh().then(() => connected.value ? flushOutbox() : undefined).catch(showError)
  }
}
async function newSession() { await act(async () => { const session = await createSession(); await router.push(`/sessions/${session.id}`) }) }
async function send() {
  const content = input.value.trim()
  if (!content || !selected.value || running.value || leaderApproval.value) return
  outbox.enqueue(selected.value, content); input.value = ''
  if (connected.value) await act(async () => { await flushOutbox(); await refresh() })
}
async function approve(id: string, decision: 'allow' | 'deny') {
  await act(async () => { await resolveSessionApproval(selected.value, id, decision); await refresh() })
}
watch(selected, () => { projection.value = null; input.value = ''; error.value = ''; void refresh() })
onMounted(() => {
  const stream = useEventStream({ onEvent, onDisconnect: () => { connected.value = false }, onGap: () => { void refresh() } })
  stopEvents = stream.close
  void refresh()
})
onBeforeUnmount(() => { disposed = true; stopEvents() })
</script>
<template>
  <div class="sessions-page">
    <aside class="session-list" aria-label="会话列表">
      <button type="button" :disabled="actionBusy" @click="newSession">新建会话</button>
      <router-link v-for="session in sessions" :key="session.id" :to="`/sessions/${session.id}`">{{ session.title || '未命名会话' }}</router-link>
    </aside>
    <main>
      <header><h1>{{ projection?.title || '协作会话' }}</h1><span v-if="!connected" role="status">连接已中断，正在重连</span></header>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <div class="history"><SessionTimeline v-if="projection" :projection="projection" /><p v-else>新建或选择一个会话，开始与助手协作。</p></div>
      <section v-if="projection?.approvals?.length" class="approvals" aria-label="待审批操作">
        <article v-for="approval in projection.approvals" :key="approval.escalation.id">
          <strong>{{ projection.teammates?.find(peer => peer.id === approval.teammateId)?.name || '主助手' }} · 请求审批</strong>
          <p>{{ approval.escalation.toolName }}：{{ approval.escalation.toolCallSummary }}</p>
          <button type="button" :disabled="actionBusy || !connected" @click="approve(approval.escalation.id, 'allow')">允许一次</button>
          <button type="button" :disabled="actionBusy || !connected" @click="approve(approval.escalation.id, 'deny')">拒绝</button>
        </article>
      </section>
      <form v-if="selected" class="composer" @submit.prevent="send">
        <textarea v-model="input" aria-label="消息" placeholder="告诉助手要做什么，也可以请它派生具名队友协作" :disabled="running || leaderApproval" />
        <button type="submit" :disabled="actionBusy || !input.trim() || running || leaderApproval">{{ connected ? '发送' : '加入待发' }}</button>
        <button v-if="running" type="button" :disabled="actionBusy" @click="act(async () => { await abortSession(selected); await refresh() })">中断</button>
      </form>
    </main>
  </div>
</template>
<style scoped>
.sessions-page { display: flex; height: 100%; min-height: 0; color: var(--el-text-color-primary); }
.session-list { width: 220px; padding: 16px; display: flex; flex-direction: column; gap: 12px; border-right: 1px solid var(--el-border-color); overflow: auto; }
.session-list a { color: inherit; text-decoration: none; padding: 8px; border-radius: 8px; overflow-wrap: anywhere; }
.session-list a.router-link-active { background: var(--el-fill-color-light); }
main { min-width: 0; flex: 1; display: flex; flex-direction: column; }
header { display: flex; align-items: center; justify-content: space-between; padding: 8px 24px; }
h1 { font-size: 18px; }
.history { overflow: auto; flex: 1; }
.history > p { margin: 32px; color: var(--el-text-color-secondary); }
.composer { display: flex; gap: 12px; padding: 16px 24px; border-top: 1px solid var(--el-border-color); }
textarea { flex: 1; resize: vertical; min-height: 70px; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 10px; font: inherit; color: inherit; background: var(--el-bg-color); }
button { cursor: pointer; padding: 8px 12px; }
.approvals { padding: 12px 24px; background: var(--el-color-warning-light-9); }
.approvals p { overflow-wrap: anywhere; }
.error { color: var(--el-color-danger); padding: 0 24px; }
@media (max-width: 700px) { .session-list { width: 130px; padding: 8px; } .composer { flex-wrap: wrap; padding: 12px; } }
</style>
