import { describe, expect, it } from 'vitest'
import { compileRules, defaultDenyReason, evaluateRules, fieldValue, globToRegExp } from '../src/rules.ts'
import type { RuleSpec } from '../src/config.ts'

describe('globToRegExp', () => {
  it('matches whole strings with *, **, ?, sets, and alternation', () => {
    expect(globToRegExp('fs_*').test('fs_read')).toBe(true)
    expect(globToRegExp('fs_*').test('web_read')).toBe(false)
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.js')).toBe(false)
    expect(globToRegExp('?.txt').test('a.txt')).toBe(true)
    expect(globToRegExp('?.txt').test('ab.txt')).toBe(false)
    expect(globToRegExp('file.{ts,tsx}').test('file.tsx')).toBe(true)
    expect(globToRegExp('file.{ts,tsx}').test('file.css')).toBe(false)
    expect(globToRegExp('*.{spec,test}.ts').test('x.test.ts')).toBe(true)
    expect(globToRegExp('[a-c]x').test('bx')).toBe(true)
    expect(globToRegExp('[a-c]x').test('dx')).toBe(false)
    expect(globToRegExp('[!a-c]x').test('dx')).toBe(true)
    expect(globToRegExp('[!a-c]x').test('bx')).toBe(false)
  })

  it('treats glob metacharacters outside the supported set as literals', () => {
    expect(globToRegExp('a+b').test('a+b')).toBe(true)
    expect(globToRegExp('a+b').test('aab')).toBe(false)
    expect(globToRegExp('git \\*').test('git *')).toBe(true)
    expect(globToRegExp('git \\*').test('git a')).toBe(false)
  })

  it('is anchored — partial matches never pass', () => {
    expect(globToRegExp('git').test('git status')).toBe(false)
    expect(globToRegExp('*status').test('git status')).toBe(true)
  })

  it('rejects unterminated classes and braces', () => {
    expect(() => globToRegExp('a[bc')).toThrow(/unterminated "\["/)
    expect(() => globToRegExp('a{b,c')).toThrow(/unterminated "\{"/)
  })
})

describe('fieldValue', () => {
  it('reads top-level and dotted paths from parsed arguments', () => {
    expect(fieldValue({ command: 'git status' }, 'command')).toBe('git status')
    expect(fieldValue({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep')
  })

  it('yields undefined for missing paths and non-object carriers', () => {
    expect(fieldValue({}, 'command')).toBeUndefined()
    expect(fieldValue({ a: 1 }, 'a.b')).toBeUndefined()
    expect(fieldValue(null, 'a')).toBeUndefined()
    expect(fieldValue('text', 'a')).toBeUndefined()
  })
})

describe('evaluateRules', () => {
  const spec = (tool: string, when?: RuleSpec['when'], reason?: string): RuleSpec => ({ tool, ...when !== undefined ? { when } : {}, ...reason !== undefined ? { reason } : {} })

  it('matches exact, glob, and regex tool patterns', () => {
    const rules = compileRules([spec('bash'), spec('fs_*'), spec('regex:^(read|write)$')])
    expect(evaluateRules(rules, 'bash', {})?.ruleIndex).toBe(0)
    expect(evaluateRules(rules, 'fs_read', {})?.ruleIndex).toBe(1)
    expect(evaluateRules(rules, 'fs_write', {})?.ruleIndex).toBe(1)
    expect(evaluateRules(rules, 'write', {})?.ruleIndex).toBe(2)
    expect(evaluateRules(rules, 'web_search', {})).toBeUndefined()
    expect(evaluateRules(rules, 'bashx', {})).toBeUndefined()
  })

  it('matches command conditions against the bash command field', () => {
    const rules = compileRules([spec('bash', { command: { regex: /^git / } })])
    expect(evaluateRules(rules, 'bash', { command: 'git status' })).toBeDefined()
    expect(evaluateRules(rules, 'bash', { command: 'echo hi' })).toBeUndefined()
    expect(evaluateRules(rules, 'bash', {})).toBeUndefined()
    expect(evaluateRules(rules, 'bash', { command: 42 })).toBeUndefined()
  })

  it('requires every condition on one field and every listed field (AND)', () => {
    const rules = compileRules([spec('bash', {
      command: { regex: /^git /, prefix: 'git status' },
      description: { contains: 'read-only' },
    })])
    expect(evaluateRules(rules, 'bash', { command: 'git status', description: 'read-only check' })).toBeDefined()
    expect(evaluateRules(rules, 'bash', { command: 'git push', description: 'read-only check' })).toBeUndefined()
    expect(evaluateRules(rules, 'bash', { command: 'git status' })).toBeUndefined()
  })

  it('supports prefix, glob, and contains conditions', () => {
    const rules = compileRules([
      spec('write', { path: { prefix: 'E:\\data' } }),
      spec('write', { path: { glob: 'src/**' } }),
      spec('write', { path: { contains: 'node_modules' } }),
    ])
    expect(evaluateRules(rules, 'write', { path: 'E:\\data\\out.txt' })?.ruleIndex).toBe(0)
    expect(evaluateRules(rules, 'write', { path: 'src/a/b.txt' })?.ruleIndex).toBe(1)
    expect(evaluateRules(rules, 'write', { path: 'src/node_modules/x' })?.ruleIndex).toBe(1)
    expect(evaluateRules(rules, 'write', { path: 'node_modules/x' })?.ruleIndex).toBe(2)
    expect(evaluateRules(rules, 'write', { path: 'other.txt' })).toBeUndefined()
  })

  it('first match in config order wins', () => {
    const rules = compileRules([spec('bash'), spec('bash', { command: { regex: /^git / } }, 'specific')])
    const hit = evaluateRules(rules, 'bash', { command: 'git status' })
    expect(hit?.ruleIndex).toBe(0)
    expect(hit?.denyReason).toContain('#1')
  })

  it('renders custom and default deny reasons', () => {
    const rules = compileRules([spec('echo', undefined, 'echo is disabled here'), spec('bash')])
    expect(evaluateRules(rules, 'echo', {})?.denyReason).toBe('echo is disabled here')
    expect(evaluateRules(rules, 'bash', {})?.denyReason).toBe(defaultDenyReason('bash', 1))
  })

  it('fails loudly on invalid regex and glob patterns', () => {
    expect(() => compileRules([spec('regex:[')])).toThrow()
    expect(() => compileRules([spec('a[bc')])).toThrow()
    expect(() => compileRules([spec('x', { command: { glob: '{unterminated' } })])).toThrow()
  })
})
