// DockerArchiveBackend（#747·02 · #747 A 节四件自研之一，PoC #724 已验证可行）：
// deepagents BackendProtocolV2 → 控制面 Docker 原语的沙箱文件后端。
//
// 形状：SandboxBackendProtocolV2 全方法（protocol.ts 本地镜像 deepagents@1.14.1）。
// 双根路由：文件工具 path 以 /wiki/（wiki 容器，用户知识树）或 /lab/（会话沙箱）为根
// （#747 E 节双容器模型；根即容器内挂载根），paths.ts 纯函数选容器，容器内路径原样保留。
// execute（shell 通道）固定落 /lab 沙箱——wiki 容器 busybox 级无运行时（sh/mkdir/rm/cat），
// 可执行环境只在沙箱。
//
// 原语通道（S2 接缝）：只依赖 SandboxFilePrimitives Port（exec/getArchive/putArchive，
// files 域 ADR 0012 同通道），dockerode 适配层（dockerPrimitives.ts）构造注入——单测走
// fake（dockerArchiveBackend.test.ts），真 daemon 仅门控 smoke（dockerArchiveBackendSmoke.test.ts）。
//
// 语义（semantics.ts/mime.ts/globmatch.ts 逐条镜像 deepagents@1.14.1 官方行为——基座
// 三包联动升级时按上游核对）：read 行分页、edit 多命中拒绝、MIME 表、glob 全语义、
// grep basename includeGlob、二进制 read 返回 Uint8Array、write 二进制 base64 解码、
// edit 恒 utf8 写回（评审 M1：不过 write 的 base64 分支，对齐官方 edit 无条件 utf8）。

import { createTarFile, mtimeIso, normalizeTarName, parseTar, type TarEntry } from '../../files/tar'
import type {
  BackendProtocolV2,
  DeleteResult,
  EditResult,
  ExecuteResponse,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  SandboxBackendProtocolV2,
  WriteResult,
} from './protocol'
import type { ExecOutcome, SandboxFilePrimitives } from './primitives'
import { routePath, type BackendTargets, type RouteResult } from './paths'
import { decodeWriteContent, getMimeType, isTextMimeType } from './mime'
import { matchGlobBaseName, matchGlobPattern } from './globmatch'
import { paginateReadLines, performStringReplacement } from './semantics'
import {
  DEFAULT_READ_LIMIT,
  DEFAULT_READ_OFFSET,
  EMPTY_CONTENT_WARNING,
  EXEC_DEFAULT_TIMEOUT_MS,
  GREP_DEFAULT_MAX_COUNT,
  MAX_COLLECT_BYTES,
  MAX_OUTPUT_CHARS,
} from './values'

// archiveRead 结果：条目（容器内绝对路径）+ 文件内容（collectData 时，key = 绝对路径）
interface ArchiveTree {
  root: TarEntry
  entries: FileInfo[]
  content: Map<string, Buffer>
}

// routePath 成功分支的命名形态（putBuffer 等内部通道参数；窄化即得）
type RoutedPath = Extract<RouteResult, { container: string }>

// guardedFile error 分类（not-found 单列——write 打点面的新建语义判据；其余 = 降级面）
export type GuardedFileErrorKind = 'not-found' | 'is-directory' | 'symlink' | 'exceeds-limit'

export class DockerArchiveBackend implements SandboxBackendProtocolV2 {
  readonly id: string

  constructor(
    private readonly primitives: SandboxFilePrimitives,
    private readonly targets: BackendTargets,
  ) {
    this.id = `docker-archive:wiki=${targets.wiki},lab=${targets.lab}`
  }

  // ---- 内部：getArchive 全量收集 + tar 解析 ----

  // 单文件根 → entries=[自身]；目录根 → 子条目 strip 根前缀得相对路径，拼回绝对路径。
  // 路径不存在（原语返 null）→ 返回 null；其余故障由原语层抛（caller catch → {error}）。
  private async archiveRead(container: string, absPath: string, collectData: boolean): Promise<ArchiveTree | null> {
    const buf = await this.primitives.getArchive(container, absPath)
    if (buf === null) return null
    // maxDataBytes 语义（files/tar.ts）：超限单文件 data=null（不抛）——超大文件在 read 处给明确 error。
    const parsed = parseTar(buf, { collectData, maxDataBytes: MAX_COLLECT_BYTES })
    const root = parsed[0]
    if (!root) return null
    const base = absPath
    const tree: ArchiveTree = { root, entries: [], content: new Map() }
    if (root.type !== 'directory') {
      tree.entries.push({ path: base, is_dir: false, size: root.size, modified_at: mtimeIso(root.mtime) })
      if (collectData && root.data) tree.content.set(base, root.data)
      return tree
    }
    const rootName = normalizeTarName(root.name)
    for (const t of parsed.slice(1)) {
      const rel = normalizeTarName(t.name)
      if (rel === null) continue
      const stripped = rootName !== null && rel.startsWith(`${rootName}/`) ? rel.slice(rootName.length + 1) : rel
      if (stripped === '') continue
      tree.entries.push({ path: `${base}/${stripped}`, is_dir: t.type === 'directory', size: t.size, modified_at: mtimeIso(t.mtime) })
      if (collectData && t.type === 'file' && t.data) tree.content.set(`${base}/${stripped}`, t.data)
    }
    return tree
  }

  // ---- 内部：单文件读取守卫链（read/readRaw/readFullText 三处共用；评审 m3-m9 轮 Standards 收拢） ----
  //（protected：#782 JournalingBackend 子类打点管线复用 pre-image 读取面）

  // null → not found；directory → is a directory；symlink → 显式拒绝；'other'（fifo 等）
  // → not found（镜像上游 stat !isFile——评审残留：旧代码落入 content 缺失误报超限）；
  // file 但 content 缺失 → exceeds read limit（>32MiB，评审 m7）。评审 m9(1)：目录文案
  // 「is a directory」系知情分歧——上游报 not found（stat !isFile），此处信息量更高。
  // kind 结构化分类（#782：JournalingBackend.write 按 kind 分派 pre-image 处置——
  // not-found = 新建语义，其余 = 降级面；文案匹配脆弱故随 error 结构化）。
  protected async guardedFile(
    routed: RoutedPath,
    filePath: string,
  ): Promise<{ tree: ArchiveTree; buf: Buffer } | { error: string; kind: GuardedFileErrorKind }> {
    const tree = await this.archiveRead(routed.container, routed.absPath, true)
    if (tree === null) return { error: `File '${filePath}' not found`, kind: 'not-found' }
    if (tree.root.type === 'directory') return { error: `is a directory: ${filePath}`, kind: 'is-directory' }
    if (tree.root.type === 'symlink') return { error: `Symlinks are not allowed: ${filePath}`, kind: 'symlink' }
    if (tree.root.type !== 'file') return { error: `File '${filePath}' not found`, kind: 'not-found' }
    const buf = tree.content.get(routed.absPath)
    if (buf === undefined) {
      return { error: `File '${filePath}' exceeds read limit (${MAX_COLLECT_BYTES} bytes)`, kind: 'exceeds-limit' }
    }
    return { tree, buf }
  }

  // ---- 内部：read 全量文本（edit 合成用；守卫链见 guardedFile；分页走 paginateReadLines） ----

  protected async readFullText(routed: RoutedPath, filePath: string): Promise<{ text: string } | { error: string }> {
    const g = await this.guardedFile(routed, filePath)
    if ('error' in g) return g
    return { text: g.buf.toString('utf8') }
  }

  // ---- 内部：mkdir -p 父目录 + putArchive 单文件落盘（write/edit 共用通道） ----
  //（protected：#782 JournalingBackend 子类打点管线复用 apply 通道——幂等重放同路径）

  // edit 必须走本通道而非 write()：write 对二进制 mime 做 base64 解码，而 edit 读侧按
  // utf8 全文本（readFullText）——错名二进制扩展名（.png 实为文本）经 write() 写回会把
  // 替换后文本 base64 解码成乱码（评审 M1）。上游 FilesystemBackend.edit 无条件 utf8 写回。
  // symlink 语义（评审 m8 跟进探针亲验）：上游 fs.writeFile 穿透 symlink 写目标；本通道
  // 经 daemon untar 对链目的端是「替换链本身」（真 daemon 实测：目标字节不变、链变常规
  // 文件）——不穿透故不会越界写链指目标，安全面不劣于上游。
  protected async putBuffer(routed: RoutedPath, buf: Buffer): Promise<void> {
    const abs = routed.absPath
    const dir = abs.slice(0, abs.lastIndexOf('/')) || '/'
    const basename = abs.split('/').pop() ?? 'file'
    if (dir !== '/') await this.primitives.exec(routed.container, ['mkdir', '-p', dir])
    await this.primitives.putArchive(routed.container, dir, createTarFile(basename, buf))
  }

  // ---- SandboxBackendProtocolV2 ----

  // shell 固定落 /lab 沙箱（wiki 容器无运行时）；stdout+stderr 合并，超 MAX_OUTPUT_CHARS 截断。
  // 默认超时 EXEC_DEFAULT_TIMEOUT_MS（上游 LocalShellBackend 120s 对齐，评审 M2）：adapter
  // 包容器内 timeout -s KILL，到期杀子进程、exitCode 归一 124 + stderr 附说明。
  async execute(command: string): Promise<ExecuteResponse> {
    try {
      const r: ExecOutcome = await this.primitives.exec(this.targets.lab, ['/bin/sh', '-c', command], {
        timeoutMs: EXEC_DEFAULT_TIMEOUT_MS,
      })
      const combined = r.stdout + r.stderr
      const truncated = combined.length > MAX_OUTPUT_CHARS
      return {
        output: truncated ? combined.slice(0, MAX_OUTPUT_CHARS) : combined,
        exitCode: r.exitCode,
        truncated,
      }
    } catch (e) {
      // 协议无 error 位：backend 故障作为输出回 agent（exitCode null = 未能执行），不炸 agent loop。
      return { output: `execute failed: ${String(e)}`, exitCode: null, truncated: false }
    }
  }

  async ls(path: string): Promise<LsResult> {
    try {
      const routed = routePath(path, this.targets)
      if ('error' in routed) return { error: routed.error }
      const tree = await this.archiveRead(routed.container, routed.absPath, false)
      if (tree === null || tree.root.type !== 'directory') return { files: [] } // 非目录/不存在：对齐官方
      const prefix = `${routed.absPath}/`
      // 目录条目 path 带尾 '/'（官方 ls 语义）；按 path 排序（确定性输出）
      const files: FileInfo[] = tree.entries
        .filter((e) => !e.path.slice(prefix.length).includes('/'))
        .map((e) => (e.is_dir ? { ...e, path: `${e.path}/` } : e))
      files.sort((a, b) => a.path.localeCompare(b.path))
      return { files }
    } catch (e) {
      return { error: `ls failed: ${String(e)}` }
    }
  }

  async read(filePath: string, offset = DEFAULT_READ_OFFSET, limit = DEFAULT_READ_LIMIT): Promise<ReadResult> {
    try {
      const routed = routePath(filePath, this.targets)
      if ('error' in routed) return { error: routed.error }
      const g = await this.guardedFile(routed, filePath)
      if ('error' in g) return { error: g.error }
      const buf = g.buf

      const mimeType = getMimeType(filePath)
      if (!isTextMimeType(mimeType)) {
        return { content: new Uint8Array(buf), mimeType }
      }
      const text = buf.toString('utf8')
      if (text.trim() === '') return { content: EMPTY_CONTENT_WARNING, mimeType }
      const page = paginateReadLines(text, offset, limit)
      if ('error' in page) return { error: page.error, mimeType }
      return { ...page, mimeType }
    } catch (e) {
      return { error: `read failed: ${String(e)}` }
    }
  }

  async readRaw(filePath: string): Promise<ReadRawResult> {
    try {
      const routed = routePath(filePath, this.targets)
      if ('error' in routed) return { error: routed.error }
      const g = await this.guardedFile(routed, filePath)
      if ('error' in g) return { error: g.error }
      const buf = g.buf
      const mimeType = getMimeType(filePath)
      // 评审 nit：tar 只有 mtime 无 birthtime——created_at 以 mtime 填充（知情取舍）
      const created = mtimeIso(g.tree.root.mtime)
      return {
        data: isTextMimeType(mimeType)
          ? { content: buf.toString('utf8'), mimeType, created_at: created, modified_at: created }
          : { content: new Uint8Array(buf), mimeType, created_at: created, modified_at: created },
      }
    } catch (e) {
      return { error: `readRaw failed: ${String(e)}` }
    }
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    try {
      const routed = routePath(filePath, this.targets)
      if ('error' in routed) return { error: routed.error }
      await this.putBuffer(routed, decodeWriteContent(filePath, content))
      return { path: routed.absPath, filesUpdate: null }
    } catch (e) {
      return { error: `write failed: ${String(e)}` }
    }
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<EditResult> {
    try {
      const routed = routePath(filePath, this.targets)
      if ('error' in routed) return { error: routed.error }
      const full = await this.readFullText(routed, filePath)
      if ('error' in full) return { error: full.error }
      const replaced = performStringReplacement(full.text, oldString, newString, replaceAll)
      if (typeof replaced === 'string') return { error: replaced }
      await this.putBuffer(routed, Buffer.from(replaced[0], 'utf8'))
      return { path: routed.absPath, filesUpdate: null, occurrences: replaced[1] }
    } catch (e) {
      return { error: `edit failed: ${String(e)}` }
    }
  }

  // 评审 m4：不存在路径须显式 { error }（对齐上游 lstat 语义，旧 rm -rf 对缺失路径
  // exit 0 静默成功）；rm 非零退出码不再吞（DeleteResult.error 契约）。单条 sh -c：
  // test -e/-L 探存在（-L 兜破损 symlink——rm -rf 删链不跟随，同上游 unlink 链语义；
  // 存在性哨兵 exit 44，不解析 stderr 文案，免疫 locale）；wiki/lab 镜像均 busybox 级，
  // sh/test 与 rm/mkdir 同为基础 applet（与 #776/#784 钉镜像验收同源）。
  async delete(filePath: string): Promise<DeleteResult> {
    try {
      const routed = routePath(filePath, this.targets)
      if ('error' in routed) return { error: routed.error }
      const r = await this.primitives.exec(routed.container, [
        'sh',
        '-c',
        'if [ ! -e "$1" ] && [ ! -L "$1" ]; then exit 44; fi; rm -rf -- "$1"',
        'sh',
        routed.absPath,
      ])
      // 哨兵碰撞假设：busybox/GNU rm 退出码只用 0/1，44 不可能与 rm 自身冲突
      if (r.exitCode === 44) return { error: `File '${filePath}' not found` }
      if (r.exitCode !== 0) {
        const detail = r.stderr.trim() === '' ? `exit ${r.exitCode}` : r.stderr.trim()
        return { error: `delete failed: ${detail}` }
      }
      return { path: routed.absPath, filesUpdate: null }
    } catch (e) {
      return { error: `delete failed: ${String(e)}` }
    }
  }

  async glob(pattern: string, path = '/'): Promise<GlobResult> {
    try {
      // 评审 m5：剥除 pattern 前导 '/'（镜像上游 glob 首行 substring(1)）——官方工具描述
      // 广告 /subdir/**/*.md 形态，不剥则与相对路径匹配恒零命中
      const pat = pattern.startsWith('/') ? pattern.substring(1) : pattern
      const routed = routePath(path, this.targets)
      if ('error' in routed) return { error: routed.error }
      const tree = await this.archiveRead(routed.container, routed.absPath, false)
      if (tree === null || tree.root.type !== 'directory') return { files: [] } // 对齐官方 glob 非目录行为
      const base = routed.absPath
      const prefix = `${base}/`
      const files: FileInfo[] = tree.entries
        .filter((e) => !e.is_dir && matchGlobPattern(e.path.slice(prefix.length), pat))
        .map((e) => ({ path: e.path, is_dir: false, size: e.size, modified_at: e.modified_at }))
      files.sort((a, b) => a.path.localeCompare(b.path))
      return { files }
    } catch (e) {
      return { error: `glob failed: ${String(e)}` }
    }
  }

  async grep(pattern: string, path: string | null = null, glob: string | null = null, maxCount: number | null = null): Promise<GrepResult> {
    try {
      const routed = routePath(path ?? '/', this.targets)
      if ('error' in routed) return { error: routed.error }
      const tree = await this.archiveRead(routed.container, routed.absPath, true)
      if (tree === null) return { matches: [], truncated: false } // 不存在：对齐官方 grep 宽容行为
      const cap = maxCount ?? GREP_DEFAULT_MAX_COUNT
      const matches: GrepMatch[] = []
      let truncated = false
      for (const e of tree.entries) {
        if (e.is_dir) continue
        const mimeType = getMimeType(e.path)
        if (!isTextMimeType(mimeType)) continue // 二进制按 mime 跳过（官方语义）
        if (glob !== null && !matchGlobBaseName(e.path, glob)) continue
        const buf = tree.content.get(e.path)
        if (buf === undefined) continue // symlink 等无 content 条目：rg 不跟随，跳过
        const lines = buf.toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes(pattern)) continue
          // 评审 m3：恰达 cap 不报 truncated（镜像上游 applyGrepMaxCount 的
          // matches.length <= maxCount 分支）；见第 cap+1 条才置位并停扫。
          if (matches.length < cap) {
            matches.push({ path: e.path, line: i + 1, text: lines[i] })
          } else {
            truncated = true
            break
          }
        }
        if (truncated) break
      }
      // 按 path+line 排序：官方 rg/字面搜索序未定义，V1 定确定性输出（agent 可预期、快照可锁）。
      // 评审 m9(2)：截断早退路径同样经此排序——截断集 = 扫描序前 cap 条，呈现序仍确定。
      matches.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)))
      return { matches, truncated }
    } catch (e) {
      return { error: `grep failed: ${String(e)}` }
    }
  }
}

// BackendProtocolV2 类型级断言：DockerArchiveBackend 满足协议全形状（编译期锁定）。
// runner 票接入 deepagents 时以同样方式对齐 import('deepagents').BackendProtocolV2。
const _protocolCheck: BackendProtocolV2 = null as unknown as DockerArchiveBackend
void _protocolCheck
