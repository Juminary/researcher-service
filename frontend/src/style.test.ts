/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/style.css', 'utf8')

describe('global styles', () => {
  it('keeps application-wide styles free of the Vite starter layout', () => {
    expect(styles).not.toMatch(/(^|\n)h1\s*[,{]/)
    expect(styles).not.toContain('.hero')
    expect(styles).not.toContain('#next-steps')
    expect(styles).not.toContain('width: 1126px')
    expect(styles).not.toContain('text-align: center')
  })

  it('provides only the shared application reset and shell defaults', () => {
    expect(styles).toContain('box-sizing: border-box')
    expect(styles).toMatch(/html,\s*\nbody,\s*\n#app\s*{[^}]*min-height: 100svh/s)
    expect(styles).toMatch(/#app\s*{[^}]*width: 100%/s)
  })
})
