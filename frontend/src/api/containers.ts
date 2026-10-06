// containers API —— list/create/remove（spec §9.3 容器管理页后端契约）。
import { apiJson } from '@/api/client'

export interface PairingSnapshotDTO {
  status: string
  device_id?: string
  scopes?: string[]
  pairing_request_id?: string
}

export interface InstanceDTO {
  name: string
  port: number
  status: string
  health: string
  image: string
  container_id: string
  created_at: string
  // #702：读侧记账判定（行镜像 ≠ 当前目标镜像，与启动方向无关）——#699 起由 list 携带。
  needs_upgrade?: boolean
  pairing: PairingSnapshotDTO
}

export function listInstances(): Promise<InstanceDTO[]> {
  return apiJson<InstanceDTO[]>('/api/v1/containers/')
}

export function createInstance(name: string): Promise<InstanceDTO> {
  return apiJson<InstanceDTO>('/api/v1/containers/', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

// #702 惰性升级（#699 服务端编排）：POST /containers/<name>/upgrade。
// 同步段返回升级中快照（status='upgrading'）并 detach 后台六步；服务端守卫语义：
//   upgrading → 幂等返回同快照（不重复入队）；upgrade_failed → 20043「容器升级失败，仅可删除重建」；
//   目标镜像已对齐 → 幂等 no-op（status 保持 running）；状态 ∉ {running, stopped} → 20043 busy。
// 调用方（ContainersView 管理面）据 code 分支：20043 如实刷新状态再决策，其余透传文案。
export function upgradeInstance(name: string): Promise<InstanceDTO> {
  return apiJson<InstanceDTO>(`/api/v1/containers/${encodeURIComponent(name)}/upgrade`, {
    method: 'POST',
  })
}

export async function removeInstance(name: string): Promise<void> {
  // 经 apiJson：TS 后端越权/不存在删除恒 HTTP 200 + code:20040（同码防探测）——旧 apiFetch+resp.ok
  // 把它当成功（删非属主容器「成功」，PR #370 第四轮 #9 P0）。apiJson 对 code!==0 抛 ApiError，
  // 调用方（ContainersView）据 toast 提示失败。重删（已 removing）也返 20040 → 抛错，可接受
  //（容器确已不在）；name 非法 → 90002。
  await apiJson<void>(`/api/v1/containers/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

// ---- legacy 容器设备配对（ADR 0006；ContainersView 管理面仍在用）----
// #793：随 chat 协议机退役从 api/chat.ts 移入——聊天侧自动配对三件（approvePairing/getBootstrapToken）
// 已随 gatewayChat 删除，仅保留管理页的「查状态 + 手动触发」两面。
export interface PairingDTO {
  status: string // unpaired / pending / paired / error
  device_id?: string
  scopes?: string[]
  pairing_request_id?: string
  detail?: string
}

export function getPairing(name: string): Promise<PairingDTO> {
  return apiJson<PairingDTO>(`/api/v1/containers/${encodeURIComponent(name)}/pairing/`)
}

export function triggerPair(name: string): Promise<PairingDTO> {
  return apiJson<PairingDTO>(`/api/v1/containers/${encodeURIComponent(name)}/pairing/`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}
