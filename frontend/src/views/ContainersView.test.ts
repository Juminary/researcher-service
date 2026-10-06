// seam: ContainersView 容器管理页 —— issue #39 前端（spec §9.3）。
// 覆盖：mount 拉列表渲染、新建对话框提交调 createInstance、删除二次确认调 removeInstance。
// Element Plus 组件用 stub（聚焦交互逻辑）；删除经 defineExpose 暴露的 confirmRemove 走 seam
// （el-table row scoped slot 在 stub 下渲染脆弱，故删除走方法级 seam）。
import { flushPromises } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/containers', () => ({
  listInstances: vi.fn(),
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  // #793：配对面自 api/chat.ts 移入 api/containers.ts，mock 随迁
  triggerPair: vi.fn(),
}))
vi.mock('element-plus', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ElMessageBox: { confirm: vi.fn() },
  }
})

import ContainersView from '@/views/ContainersView.vue'
import { createInstance, listInstances, removeInstance, triggerPair } from '@/api/containers'

const SAMPLE = {
  name: 'demo',
  port: 19000,
  status: 'running',
  health: 'healthy',
  image: 'img',
  container_id: 'cid',
  created_at: '2026-07-24T00:00:00Z',
  pairing: { status: 'unpaired', device_id: '', scopes: [], pairing_request_id: '' },
}

const stubs = {
  ElButton: {
    props: ['type', 'loading', 'size'],
    template: '<button @click="$emit(\'click\')"><slot /></button>',
  },
  ElTable: {
    props: { data: { type: Array, default: () => [] } },
    // 渲染默认 slot：列定义（ElTableColumn stub）随之挂载，供「升级」列接线断言；行内容仍不渲染
    template:
      '<div data-test="instance-table"><slot />{{ (data||[]).map((r) => r.name).join(",") }}</div>',
  },
  ElTableColumn: { name: 'ElTableColumn', template: '<span />' },
  ElDialog: {
    props: ['modelValue', 'title', 'width'],
    template:
      '<div v-if="modelValue" data-test="create-dialog"><slot /><slot name="footer" /></div>',
  },
  ElForm: { template: '<form><slot /></form>' },
  ElFormItem: { props: ['label'], template: '<div><slot /></div>' },
  ElInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input data-test="name-input" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
}

describe('ContainersView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches and renders instances on mount', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE])
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(listInstances).toHaveBeenCalled()
    expect(wrapper.find('[data-test="instance-table"]').text()).toContain('demo')
  })

  it('shows error message when list fails', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('未登录或登录已过期'))
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('未登录或登录已过期')
  })

  it('opens dialog, submits name, and creates instance', async () => {
    ;(createInstance as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE)
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()

    await wrapper.find('[data-test="open-create"]').trigger('click')
    expect(wrapper.find('[data-test="create-dialog"]').exists()).toBe(true)

    await wrapper.find('[data-test="name-input"]').setValue('demo')
    await wrapper.find('[data-test="submit-create"]').trigger('click')
    await flushPromises()

    expect(createInstance).toHaveBeenCalledWith('demo')
  })

  it('removes instance after confirmation', async () => {
    const { ElMessageBox } = await import('element-plus')
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockResolvedValue('confirm')
    ;(removeInstance as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()

    await (wrapper.vm as unknown as { confirmRemove: (n: string) => Promise<void> }).confirmRemove(
      'demo',
    )
    await flushPromises()
    expect(removeInstance).toHaveBeenCalledWith('demo')
  })

  it('does not remove when user cancels confirmation', async () => {
    const { ElMessageBox } = await import('element-plus')
    ;(ElMessageBox.confirm as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('cancel'))
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()

    await (wrapper.vm as unknown as { confirmRemove: (n: string) => Promise<void> }).confirmRemove(
      'demo',
    )
    expect(removeInstance).not.toHaveBeenCalled()
  })

  it('polls the list periodically while mounted and stops on unmount (codex R2 :78)', async () => {
    // 新起 gateway 由 unhealthy 转 healthy、容器被外部停止等运行时变化须靠轮询反映。
    vi.useFakeTimers()
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const callsAfterMount = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callsAfterMount).toBeGreaterThanOrEqual(1) // mount 时已拉一次

    await vi.advanceTimersByTimeAsync(3000) // 一个轮询周期
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterMount,
    )

    const callsBeforeUnmount = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(9000) // 卸载后多过一个周期也不再调
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeUnmount)
  })

  it('skips a poll tick while the previous refresh is still in flight (codex R3 :89)', async () => {
    // 一次 list 超过 3s（多个不可达实例串行 2s 健康探测）时，下一 tick 须跳过，
    // 避免叠加并发 Docker/health 请求、乱序完成覆盖较新状态。
    vi.useFakeTimers()
    // listInstances 一直 pending（模拟慢请求），永不 resolve
    ;(listInstances as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    // mount 触发的第一次 refresh 仍在飞
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    // 推进多个轮询周期：因上一次未完成，后续 tick 全被跳过，不再新增调用
    await vi.advanceTimersByTimeAsync(9000)
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('resumes polling after a timed-out refresh releases the in-flight guard', async () => {
    vi.useFakeTimers()
    ;(listInstances as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () => new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('请求超时', 'TimeoutError')), 15_000)
        }),
      )
      .mockResolvedValueOnce([])
    mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(listInstances).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15_000)
    await flushPromises()
    const callsAfterTimeout = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callsAfterTimeout).toBeGreaterThan(1)
    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterTimeout,
    )
  })

  // ---------------------------- #419-6 轮询可见性 + 错误去闪烁 ----------------------------

  it('#419-6: 标签页隐藏时暂停轮询，回前台恢复并立即刷新', async () => {
    vi.useFakeTimers()
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([])
    mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const callsAfterMount = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length

    // 隐藏 → 不再轮询
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(12_000)
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterMount)

    // 回前台 → 立即刷新一次 + 恢复轮询
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterMount,
    )
    const callsAfterVisible = (listInstances as ReturnType<typeof vi.fn>).mock.calls.length
    await vi.advanceTimersByTimeAsync(6_000)
    expect((listInstances as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterVisible,
    )
  })

  it('#419-6: 错误文案仅在内容变化时更新（同文案不闪烁）', async () => {
    // 后端持续故障：每次 refresh 失败都写入相同错误——文案不得以轮询频率重复更新
    // （旧实现每次 refresh 开头 errorMsg='' 再写回，同文案 3s 闪烁）。
    // 断言 DOM 节点引用：同文案不重建 <p class="error">。
    vi.useFakeTimers()
    ;(listInstances as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('backend down'))
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('backend down')

    const p1 = wrapper.find('p.error').element
    await vi.advanceTimersByTimeAsync(6_000) // 两轮失败（同文案）
    await flushPromises()
    const p2 = wrapper.find('p.error').element
    expect(p2).toBe(p1) // 同文案不重建节点（不闪烁）
    expect(wrapper.text()).toContain('backend down')

    // 文案变化（错误内容不同）→ 更新显示
    ;(listInstances as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))
    await vi.advanceTimersByTimeAsync(3_000)
    await flushPromises()
    expect(wrapper.text()).toContain('disk full')
  })

  // ---------------------------- 配对状态（issue #40 + #340-C 徽标）----------------------------

  it('loads pairing status from listInstances payload', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...SAMPLE, pairing: { status: 'paired', scopes: ['operator.read'] } },
    ])
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    expect(listInstances).toHaveBeenCalled()
    expect((wrapper.vm as unknown as { pairingStatus: (n: string) => string }).pairingStatus('demo')).toBe('paired')
  })

  it('#340-C: 配对徽标按状态着色（paired→success/pending→warning/error→warning/unpaired→info）', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...SAMPLE, pairing: { status: 'paired' } },
      { ...SAMPLE, name: 'pending-box', pairing: { status: 'pending', pairing_request_id: 'r1' } },
      { ...SAMPLE, name: 'err-box', pairing: { status: 'error', detail: 'boom' } },
      { ...SAMPLE, name: 'unpaired-box', pairing: { status: 'unpaired' } },
    ])
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const vm = wrapper.vm as unknown as {
      pairingTagType: (s: string) => string
      pairingLabel: (s: string) => string
      pairingStatus: (n: string) => string
    }
    expect(vm.pairingTagType('paired')).toBe('success')
    expect(vm.pairingTagType('pending')).toBe('warning')
    expect(vm.pairingTagType('error')).toBe('warning')
    expect(vm.pairingTagType('unpaired')).toBe('info')
    expect(vm.pairingLabel('paired')).toBe('已配对')
    expect(vm.pairingLabel('pending')).toBe('配对中')
    expect(vm.pairingLabel('error')).toBe('配对失败')
    expect(vm.pairingLabel('unpaired')).toBe('未配对')
    expect(vm.pairingStatus('err-box')).toBe('error')
  })

  it('#340-C: 配对失败（error）行内重试 → triggerPair 重新触发', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...SAMPLE, pairing: { status: 'error', detail: 'handshake failed' } },
    ])
    ;(triggerPair as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'paired' })
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    await (wrapper.vm as unknown as { pair: (n: string) => Promise<void> }).pair('demo')
    await flushPromises()
    expect(triggerPair).toHaveBeenCalledWith('demo')
    // 重试成功 → 状态翻转为 paired
    expect((wrapper.vm as unknown as { pairingStatus: (n: string) => string }).pairingStatus('demo')).toBe('paired')
  })

  it('triggerPair calls the api and refreshes pairing status', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([SAMPLE])
    ;(triggerPair as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'pending', pairing_request_id: 'r1' })
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()

    await (wrapper.vm as unknown as { pair: (n: string) => Promise<void> }).pair('demo')
    await flushPromises()
    expect(triggerPair).toHaveBeenCalledWith('demo')
    // pending 态提示宿主 approve（验收 3 重试路径）
    const { ElMessage } = await import('element-plus')
    expect(ElMessage.warning).toHaveBeenCalled()
  })

  // ---------------------------- #702 升级状态标记（需升级 / 升级中 / 升级失败）----------------------------

  it('#702: 三种升级标记文案与视觉状态两两互异；无需升级不渲染', async () => {
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    const vm = wrapper.vm as unknown as {
      upgradeBadgeOf: (r: { status: string; needs_upgrade?: boolean }) => { label: string; tone: string } | null
    }
    expect(vm.upgradeBadgeOf({ status: 'running', needs_upgrade: true })).toEqual({
      label: '需升级',
      tone: 'warning',
    })
    expect(vm.upgradeBadgeOf({ status: 'upgrading', needs_upgrade: true })).toEqual({
      label: '升级中',
      tone: 'primary',
    })
    expect(vm.upgradeBadgeOf({ status: 'upgrade_failed', needs_upgrade: true })).toEqual({
      label: '升级失败',
      tone: 'danger',
    })
    expect(vm.upgradeBadgeOf({ status: 'running', needs_upgrade: false })).toBeNull()
  })

  it('#702: 列表挂载「升级」列（徽标经 scoped slot 取自 upgradeBadgeOf，非硬编码文案）', async () => {
    ;(listInstances as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...SAMPLE, name: 'need', needs_upgrade: true },
      { ...SAMPLE, name: 'doing', status: 'upgrading', needs_upgrade: true },
      { ...SAMPLE, name: 'failed', status: 'upgrade_failed', needs_upgrade: true },
    ])
    const wrapper = mount(ContainersView, { global: { plugins: [createPinia()], stubs } })
    await flushPromises()
    // el-table 各列在 stub 下不渲染行内容，故断言「升级」列存在（列 slot 的取值函数在上一用例已钉死）
    const labels = wrapper
      .findAllComponents({ name: 'ElTableColumn' })
      .map((c) => c.attributes('label'))
    expect(labels).toContain('升级')
    // 三态徽标经同一 mapper 产出（数据驱动，逐行按 status/needs_upgrade 分派）
    const vm = wrapper.vm as unknown as {
      upgradeBadgeOf: (r: { status: string; needs_upgrade?: boolean }) => { label: string } | null
    }
    expect(vm.upgradeBadgeOf({ status: 'running', needs_upgrade: true })?.label).toBe('需升级')
    expect(vm.upgradeBadgeOf({ status: 'upgrading', needs_upgrade: true })?.label).toBe('升级中')
    expect(vm.upgradeBadgeOf({ status: 'upgrade_failed', needs_upgrade: true })?.label).toBe('升级失败')
  })
})
