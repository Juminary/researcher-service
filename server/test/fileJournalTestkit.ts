// filejournal 测试共享 fake（attic/writer/replay 共用）：fakePrimitives 的语义扩展——
// 模拟 sh -c 'mkdir -p …' 建目录条目与 sh -c 'rm -f …' 删除（真实容器语义：ensureRoot 与
// GC rm 都走 sh -c 复合 argv，fakePrimitives 基础版只认 mkdir 直接形式）。

import { fakePrimitives } from './runnerFakes'
import type { SandboxFilePrimitives } from '../src/runner/backend/primitives'

export interface FakeFs {
  trees: Map<string, Map<string, Buffer | 'dir'>>
  execCalls: { container: string; cmd: string[]; user?: string }[]
  primitives: SandboxFilePrimitives
}

export function fakeFs(): FakeFs {
  const base = fakePrimitives()
  const execCalls = base.execCalls as FakeFs['execCalls']
  const inner = base.primitives.exec.bind(base.primitives)
  const extended: SandboxFilePrimitives = {
    ...base.primitives,
    async exec(container, cmd, opts) {
      execCalls.push({ container, cmd, ...(opts?.user !== undefined ? { user: opts.user } : {}) })
      let tree = base.trees.get(container)
      if (!tree) {
        tree = new Map()
        base.trees.set(container, tree)
      }
      const script = cmd[0] === 'sh' && cmd[1] === '-c' ? (cmd[2] as string | undefined) : undefined
      if (script !== undefined && script.includes('mkdir -p')) {
        const path = cmd[cmd.length - 1]
        if (typeof path === 'string' && path.startsWith('/')) tree.set(path, 'dir')
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (script !== undefined && script.startsWith('rm -f')) {
        for (const p of cmd.slice(4)) tree.delete(p as string) // cmd[3] = $0 占位 'sh'
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (script !== undefined && script.includes('rm -rf')) {
        // backend delete 哨兵形状：if [ ! -e "$1" ]...; rm -rf -- "$1"（cmd[4] = $1）
        const target = cmd[4]
        if (typeof target === 'string') {
          tree.delete(target)
          // 目录删除连带子树（rm -rf 语义）
          for (const p of [...tree.keys()]) {
            if (p.startsWith(`${target}/`)) tree.delete(p)
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return inner(container, cmd, opts)
    },
  }
  return { trees: base.trees, execCalls, primitives: extended }
}
