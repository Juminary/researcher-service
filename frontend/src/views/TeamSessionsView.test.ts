import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TeamSessionsView from './TeamSessionsView.vue'

class Stream extends EventTarget {
  static instances: Stream[] = []
  readyState = 1
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor() { super(); Stream.instances.push(this) }
  emit(type: string, payload: unknown, teammateId?: string) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ type, sessionId: 'session', teammateId, runId: 'peer-run', payload }) }))
  }
}
afterEach(() => { vi.unstubAllGlobals(); Stream.instances = [] })
describe('#786 session REST/SSE journey', () => {
  it('routes peer streaming to its fold and reconciles to the same refreshed history', async () => {
    let finished = false
    const projection = () => ({ sessionId: 'session', title: 'Research', messages: [], teammates: [{
      id: 'peer', name: 'Reader', task: 'Find evidence', status: finished ? 'completed' : 'running', mailbox: [],
      messages: finished ? [{ id: 'result', role: 'assistant', turn: 1, content: 'Peer result', createdAt: '', anchorCheckpointId: null }] : [],
    }] })
    vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify({ code: 0, message: '', data: input.endsWith('/messages') ? projection() : { sessions: [{ id: 'session', title: 'Research', createdAt: '', updatedAt: '' }] } }), { headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('EventSource', Stream)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/sessions/:id?', component: TeamSessionsView }] })
    await router.push('/sessions/session'); await router.isReady()
    const wrapper = mount(TeamSessionsView, { global: { plugins: [createPinia(), router] } })
    await flushPromises()
    const stream = Stream.instances[0]!
    stream.emit('run.started', {}, 'peer'); stream.emit('text.delta', { delta: 'Peer result' }, 'peer')
    await flushPromises()
    await wrapper.get('[data-test="teammate-toggle"]').trigger('click')
    expect(wrapper.get('[data-teammate-id="peer"]').text()).toContain('Peer result')
    expect(wrapper.get('[data-test="leader-timeline"]').text()).not.toContain('Peer result')
    finished = true
    stream.emit('session.updated', { projectionChanged: true })
    await flushPromises()
    const liveText = wrapper.get('[data-teammate-id="peer"]').text()
    wrapper.unmount()
    expect(stream.close).toHaveBeenCalled()
    const replay = mount(TeamSessionsView, { global: { plugins: [createPinia(), router] } })
    await flushPromises(); await replay.get('[data-test="teammate-toggle"]').trigger('click')
    expect(replay.get('[data-teammate-id="peer"]').text()).toBe(liveText)
    replay.unmount()
  })
})
