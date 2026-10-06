// files API —— 沙箱 lab 文件树 + 单文件只读全文（#776 root 契约 / #793 story 61 侧栏文件 tab）。
// root=lab：:name 段传 **sessionId**（服务端派生 researcher-sandbox-<sessionId>），lab 随会话生灭
//（#730 §4.7 生命周期差异：切会话即换树）。只读 GET 面——写面仅 legacy wiki root 放行，lab 写 → 90002。
// 走 apiJson（自动 #312 信封解包 + 401 刷新链，client.ts）。v1 只读——tabs 不回写，不实现 PUT/POST/DELETE。
//
// 镜像类型与 server/src/files/fsPort.ts 逐字段对齐（前端本地定义，不 import server 类型——
// 对齐 api/containers.ts / api/wiki.ts 的本地 DTO 惯例）。
import { apiJson } from '@/api/client'

export interface FileEntry {
  path: string // 相对 root 的完整相对路径（无尾斜杠；目录经 type 区分）
  type: 'file' | 'directory'
  size: number
  modified: string // ISO 8601
}

export interface DirListing {
  kind: 'dir'
  path: string
  files: FileEntry[]
  // 条目数超 WALK_LIMIT 截断 → true（递归 walk 全量后服务端置位）
  truncated: boolean
}

export interface FileReading {
  kind: 'file'
  path: string
  content: string | null // 文本返回内容；binary/oversized 返回 null + 对应标志
  size: number
  modified: string
  binary: boolean
  oversized: boolean
}

// 树：一次拉全量沙箱 /lab 嵌套（recursive=true，10k 上限 truncated 时树底提示）。
// 前置：会话已有沙箱（惰性创建——首次上传/首次执行触发；纯浏览空沙箱会话 → 服务端 50002/20040 由调用方降级空态）。
export function listLabTree(sessionId: string): Promise<DirListing> {
  return apiJson<DirListing>(
    `/api/v1/containers/${encodeURIComponent(sessionId)}/files?root=lab&recursive=true`,
  )
}

// 单文件全文（树点击开只读 tab 时拉；agent 写工具 done 后自动弹 tab 亦走此拉全文）
export function readLabFile(sessionId: string, relPath: string): Promise<FileReading> {
  return apiJson<FileReading>(
    `/api/v1/containers/${encodeURIComponent(sessionId)}/files?root=lab&path=${encodeURIComponent(relPath)}`,
  )
}
