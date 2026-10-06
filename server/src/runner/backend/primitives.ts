// SandboxFilePrimitives —— runner backend 的 Docker 原语 Port（#747 S2 接缝）。
// S2 定稿：「Docker 原语（exec/Archive/容器生命周期）全部注入可 fake，单测走 fake」。
// 本 Port 是 files 域 Docker 通道（ADR 0012：getArchive/putArchive/exec rm）的原语级
// 提炼——DockerFileArchive 与 DockerPrimitives 各自在其上封装不同语义层，不共享类层次
// （files 域 = REST 文件 CRUD 的 root/relPath + 域异常；本域 = backend 的 absPath + Result 类型）。
//
// 错误语义：原语层把 docker/daemon 故障原样抛（backend 层 catch → {error} Result）；
// getArchive 对 daemon 404 返回 null（路径不存在是业务信号，非故障）。

/** exec 原语结果：stdout/stderr 分列（execute 需要区分合并输出；mkdir/rm 只需退出码） */
export interface ExecOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** exec 选项：超时经容器内 timeout coreutil 杀进程（adapter 包 argv），归一 exitCode 124 + stderr 附说明（机制见 dockerPrimitives.ts） */
export interface ExecOptions {
  /** 超时毫秒数；缺省或 <=0 = 无超时（内部 mkdir/rm 等固定 argv 调用不传） */
  timeoutMs?: number
  /** 执行用户（dockerode exec User 选项，如 '0' = root）。缺省 = 容器配置用户（沙箱 1000）。
   *  消费面仅 filejournal attic（#782：0700 root 目录的建置与 GC rm——daemon 侧 root 写）。 */
  user?: string
}

export interface SandboxFilePrimitives {
  /**
   * 容器内同步执行命令（dockerode exec + demux，TTY=false 流带 8 字节复用头由适配层解）。
   * container = docker 容器名；cmd = argv 数组（不经 shell 插值，shell 语义由 caller 用
   * ['/bin/sh', '-c', ...] 显式表达）。opts.timeoutMs 超时语义见 ExecOptions。
   * 执行失败（daemon 故障/容器不存在）→ 抛错。
   */
  exec(container: string, cmd: string[], opts?: ExecOptions): Promise<ExecOutcome>

  /**
   * getArchive 全量收集为 tar Buffer（调用方 parseTar）。路径不存在（daemon 404）→ null；
   * 超 MAX_COLLECT_BYTES 由适配层拒绝（throw）——不驻留超限内存。
   */
  getArchive(container: string, absPath: string): Promise<Buffer | null>

  /** putArchive：把单文件/树 tar Buffer 解包进容器 dir（目录须已存在或由 caller mkdir）。 */
  putArchive(container: string, dir: string, tar: Buffer): Promise<void>
}
