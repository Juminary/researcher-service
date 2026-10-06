<script setup lang="ts">
// 容器管理页（spec §9.3）：列表 name/status/health/port/image + 新建 + 删除（默认连数据删）。
// codex R2 :78：挂载期间轮询列表（新起 gateway 由 unhealthy 转 healthy、容器被外部停止等
// 运行时状态变化方能及时反映）；卸载即清定时器，避免泄漏/对已卸载组件发请求。
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  createInstance,
  listInstances,
  removeInstance,
  triggerPair,
  type InstanceDTO,
  type PairingDTO,
} from '@/api/containers'
import { ApiError } from '@/api/client'
import { upgradeBadge, type UpgradeBadge } from '@/containers/upgradeGate'

const instances = ref<InstanceDTO[]>([])
// 配对状态由 listInstances 的 pairing 字段批量携带，不再单独轮询
const pairings = ref<Record<string, PairingDTO>>({})
const loading = ref(false)
const errorMsg = ref('')

// 新建对话框
const createVisible = ref(false)
const newName = ref('')
const creating = ref(false)

// codex R2 :78：轮询间隔（3s），对齐前端既有轮询节奏；太短打满健康探测，太长状态滞后
const POLL_INTERVAL_MS = 3000
let pollTimer: ReturnType<typeof setInterval> | null = null
// codex R3 :89：在飞请求标记——一次 list 超过 3s（多个不可达实例串行 2s 健康探测）时
// 跳过下一 tick，避免叠加并发 Docker/health 请求、乱序完成覆盖较新状态。
let refreshInFlight = false
// #419-6：标签页隐藏时暂停轮询（后台 3s 轮询无意义且浪费）；可见时恢复 + 立即刷新一次
let pageVisible = true

function startPolling(): void {
  if (pollTimer !== null) return
  pollTimer = setInterval(() => {
    void refresh()
  }, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function onVisibilityChange(): void {
  pageVisible = document.visibilityState === 'visible'
  if (pageVisible) {
    void refresh() // 回前台立即刷新，补上隐藏期间的运行时变化
    startPolling()
  } else {
    stopPolling()
  }
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return // codex R3 :89：上一次未完成则跳过本次
  refreshInFlight = true
  loading.value = true
  // #419-6：错误文案不清空重写——同文案期间 errorMsg 值不变，v-if 节点不重建（不闪烁）；
  // 成功才清空（错误消失），文案变化才覆盖。
  try {
    instances.value = await listInstances()
    // 批量同步：后端 list 已携带 pairing 快照，避免 N+1 请求
    pairings.value = Object.fromEntries(
      instances.value.map((inst) => [inst.name, inst.pairing]),
    )
    errorMsg.value = ''
  } catch (e) {
    const msg = (e as Error).message
    if (msg !== errorMsg.value) errorMsg.value = msg
  } finally {
    loading.value = false
    refreshInFlight = false
  }
}

function pairingStatus(name: string): string {
  return pairings.value[name]?.status ?? 'unpaired'
}

// #340-C：配对徽标（只读徽标 + 失败重试）——paired 绿、pending 黄、error 黄+重试入口、
// unpaired 灰。status 文本 + el-tag type 双断言（测试/可访问性）。
function pairingTagType(status: string): 'success' | 'warning' | 'info' {
  if (status === 'paired') return 'success'
  if (status === 'pending' || status === 'error') return 'warning'
  return 'info'
}

function pairingLabel(status: string): string {
  if (status === 'paired') return '已配对'
  if (status === 'pending') return '配对中'
  if (status === 'error') return '配对失败'
  return '未配对'
}

// #702：升级状态徽标（需升级 warning / 升级中 primary / 升级失败 danger，三态文案与色调互异）——
// 判定与文案单一来源在纯函数 upgradeBadge（含 status 优先级），本组件只做取值渲染。
function upgradeBadgeOf(row: Pick<InstanceDTO, 'status' | 'needs_upgrade'>): UpgradeBadge | null {
  return upgradeBadge({ status: row.status, needsUpgrade: row.needs_upgrade })
}

async function pair(name: string): Promise<void> {
  try {
    const result = await triggerPair(name)
    pairings.value = { ...pairings.value, [name]: result }
    if (result.status === 'paired') {
      ElMessage.success(`容器 ${name} 已配对`)
    } else if (result.status === 'pending') {
      // 验收 3：清晰错误 + 重试路径（提示宿主 approve 命令）
      ElMessage.warning(result.detail ?? `待批准：请在宿主执行 openclaw devices approve 后重试`)
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    ElMessage.error((e as Error).message)
  }
}

function openCreate(): void {
  newName.value = ''
  createVisible.value = true
}

async function submitCreate(): Promise<void> {
  if (!newName.value.trim()) {
    ElMessage.warning('请填写容器名称')
    return
  }
  creating.value = true
  try {
    await createInstance(newName.value.trim())
    createVisible.value = false
    await refresh()
    ElMessage.success('容器已创建')
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

async function confirmRemove(name: string): Promise<void> {
  // spec §5.4：删除默认连数据删（wiki/配置），故需二次确认
  try {
    await ElMessageBox.confirm(
      `确认删除容器 ${name}？将一并清除其数据（wiki / openclaw.json）。`,
      '删除容器',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return // 用户取消
  }
  try {
    await removeInstance(name)
    await refresh()
    ElMessage.success('容器已删除')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return // 401 已由 client 处理会话
    ElMessage.error((e as Error).message)
  }
}

onMounted(() => {
  void refresh()
  startPolling()
  // #419-6：监听标签页可见性——隐藏停轮询、回前台恢复并立即刷新（onVisibilityChange 内）
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  stopPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

// 暴露删除/配对动作 + 配对状态查询：el-table row slot 在测试 stub 下不便点击，暴露供测试与潜在父组件触发
defineExpose({ confirmRemove, pair, pairingStatus, upgradeBadgeOf })
</script>

<template>
  <div class="containers">
    <div class="header">
      <h1>容器管理</h1>
      <el-button type="primary" data-test="open-create" @click="openCreate">新建容器</el-button>
    </div>
    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <el-table :data="instances" data-test="instance-table">
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="status" label="状态" width="100" />
      <el-table-column prop="health" label="健康" width="100" />
      <el-table-column prop="port" label="端口" width="80" />
      <el-table-column prop="image" label="镜像" />
      <el-table-column label="升级" width="100">
        <template #default="{ row }">
          <!-- #702：三态互斥（upgrade_failed > upgrading > needs_upgrade），无需升级不渲染徽标 -->
          <el-tag
            v-if="upgradeBadgeOf(row)"
            :type="upgradeBadgeOf(row)!.tone"
            size="small"
            :data-test="`upgrade-badge-${row.name}`"
          >
            {{ upgradeBadgeOf(row)!.label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="配对" width="130">
        <template #default="{ row }">
          <el-tag
            :type="pairingTagType(pairingStatus(row.name))"
            size="small"
            :data-test="`pairing-badge-${row.name}`"
          >
            {{ pairingLabel(pairingStatus(row.name)) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="260">
        <template #default="{ row }">
          <!-- #340-C：配对失败（error）显式「重试配对」入口（黄色警示语义），其余态显式「配对」 -->
          <el-button
            v-if="pairingStatus(row.name) === 'error'"
            type="warning"
            size="small"
            :data-test="`retry-pair-${row.name}`"
            @click="pair(row.name)"
          >
            重试配对
          </el-button>
          <el-button
            v-else
            size="small"
            :data-test="`pair-${row.name}`"
            :disabled="pairingStatus(row.name) === 'paired'"
            @click="pair(row.name)"
          >
            配对
          </el-button>
          <el-button
            type="danger"
            size="small"
            :data-test="`delete-${row.name}`"
            @click="confirmRemove(row.name)"
          >
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="createVisible" title="新建容器" data-test="create-dialog" width="420px">
      <el-form>
        <el-form-item label="名称">
          <el-input
            v-model="newName"
            placeholder="小写字母开头，3–30 位，仅 a-z 0-9 -"
            data-test="name-input"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button data-test="cancel-create" @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" data-test="submit-create" @click="submitCreate">
          创建
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.error {
  color: var(--el-color-danger);
}
</style>
