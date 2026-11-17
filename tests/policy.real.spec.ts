/**
 * Real composition tests for dsh-custom-permission on the supported DSH
 * release: a plain Cordis composition (sandbox-policy + system-prompt + tools +
 * the native executor + the plugin) exercises the tool pipeline and the
 * approval waterfall; a stub settings service plus live config references
 * exercise runtime preset switching, editing, and the persisted payload
 * without depending on Loader internals.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { apply as applyNativeExecutor, inject as nativeExecutorInject } from '@deepseek-ai/dsh-tool-executor-native'
import CustomPermissionFileSystem from '../src/index.ts'
import type { Preset as PresetSpec, PresetSpecWire } from '../src/config.ts'

/** One live preset table plus the active name, shared with the fake settings service. */
interface LiveConfig {
  presets: Record<string, PresetSpec>
  active: string
}

/** The stub settings service: records writes and applies them to the live config. */
class FakeSettings extends Service {
  /** Every patch the plugin persisted, in order. */
  readonly writes: Array<Record<string, unknown>> = []
  constructor(ctx: Context, private readonly live: LiveConfig) {
    super(ctx, 'settings')
  }
  /** Serve this plugin's own profile entry. */
  describe(): Array<{ ns: string; revision: number; schema: unknown }> {
    return [{ ns: 'custom-permission', revision: this.writes.length + 1, schema: CustomPermissionFileSystem.Config }]
  }
  /** Apply a volatile-field write to the live references (as the Loader would). */
  async update(_ns: string, patch: Record<string, unknown>): Promise<void> {
    this.writes.push(patch)
    if (patch.presets !== undefined) {
      this.live.presets = patch.presets as Record<string, PresetSpec>
    }
    if (typeof patch.active === 'string') this.live.active = patch.active
  }
}

let base: string
let workspace: string
let extra: string
let ctx: Context
let live: LiveConfig
let fs: CustomPermissionFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

/** The default preset table: an allow rule, two deny rules, an approval grant, an extra root. */
function presets(extraRoots: string[]): Record<string, PresetSpec> {
  // Volatile config values are JSON-shaped: regex matchers are schema sources.
  return {
    default: {
      allowRules: [{ tool: 'bash', when: { command: { regex: '^git ' } } }],
      denyRules: [
        { tool: 'bash', when: { command: { regex: 'rm -rf /' } } },
        { tool: 'echo', reason: 'echo is disabled here' },
      ],
      allowApprovals: ['fetch'],
      extraWritableRoots: extraRoots,
    },
    work: {
      denyRules: [{ tool: 'echo', reason: 'echo disabled in work preset' }],
    },
  } as unknown as Record<string, PresetSpec>
}

/**
 * Boot the test composition.
 * @param options - settings on/off, the preset table, and the configured selection.
 */
async function compose(options: {
  settings?: boolean
  table?: Record<string, PresetSpec>
  active?: string
} = {}): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin({ inject: nativeExecutorInject, apply: applyNativeExecutor })
  live = { presets: options.table ?? presets([extra]), active: options.active ?? 'default' }
  if (options.settings !== false) await ctx.plugin(FakeSettings, live)
  fiber = await ctx.plugin(CustomPermissionFileSystem, {
    cwd: workspace,
    presets: live.presets,
    active: live.active,
  })
  fs = ctx.fs as CustomPermissionFileSystem
}

beforeEach(async () => {
  // Base under HOME, deliberately NOT tmpdir: `workspace-write` grants /tmp
  // and os.tmpdir(), so an "outside" dir under tmpdir would be legitimately writable.
  base = await mkdtemp(join(homedir(), '.dsh-custom-perm-'))
  workspace = join(base, 'ws')
  extra = join(base, 'extra')
  await mkdir(workspace)
  await mkdir(extra)
})

afterEach(async () => {
  await fiber?.dispose()
  await rm(base, { recursive: true, force: true })
})

const testSignal = (): AbortSignal => new AbortController().signal

/** Execute one tool call through the pipeline and return its settled result. */
async function call(name: string, args: Record<string, unknown>, callId: string): Promise<ToolExecutionResult> {
  const result = await ctx.tools.execute({
    signal: testSignal(),
    calls: [{ type: 'tool-call', id: ToolCallId(callId), name, arguments: JSON.stringify(args) }],
  })
  return result.results[0]!.result
}

/** A minimal agent stand-in for the approval waterfall payload. */
function fakeAgent(): Agent {
  return { session: { append: () => undefined } } as unknown as Agent
}

/** Run the approval waterfall with a stand-in answerer that reports delegation. */
async function ask(toolName: string, callId?: string): Promise<string> {
  return ctx.waterfall('approval/request', {
    agent: fakeAgent(),
    toolName,
    ...callId !== undefined ? { callId: ToolCallId(callId) } : {},
  }, () => Promise.resolve('unavailable' as const))
}

const bashTool = defineTool({
  name: 'bash',
  description: 'test bash stand-in',
  parameters: { command: { type: 'string' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  async execute(args) {
    return args.command ?? ''
  },
})

const echoTool = defineTool({
  name: 'echo',
  description: 'test echo tool',
  parameters: { text: { type: 'string' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  },
  async execute(args) {
    return args.text ?? ''
  },
})

describe('policy enforcement', () => {
  it('loads as the sole ctx.fs provider with the policy service composed', async () => {
    await compose()
    expect(ctx.get('fs')).toBeInstanceOf(CustomPermissionFileSystem)
    expect(ctx.get('sandboxPolicy')).toBeInstanceOf(SandboxPolicyService)
  })

  it('denies a matching tool call before execution, with the configured reason', async () => {
    await compose()
    ctx.tools.register(echoTool)

    const result = await call('echo', { text: 'hi' }, 'deny-echo')
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: echo is disabled here' })
  })

  it('denies a matching bash command with the numbered default reason', async () => {
    await compose()
    ctx.tools.register(bashTool)

    const result = await call('bash', { command: 'rm -rf /' }, 'deny-bash')
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: blocked by dsh-custom-permission rule #1 (tool "bash")' })
  })

  it('auto-allows a matching command before a later hook ask can fire', async () => {
    await compose()
    ctx.tools.register(bashTool)
    // A hook-style ask producer registered AFTER the plugin: without the
    // plugin's allow short-circuit, this would send the call to approval.
    ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'ask', reason: 'hook wants human' }))

    const result = await call('bash', { command: 'git status' }, 'allow-bash')
    expect(result.isError).toBe(false)
    expect(result.content[0]).toMatchObject({ text: 'git status' })
  })

  it('delegates a non-matching call so downstream ask producers still decide', async () => {
    await compose()
    ctx.tools.register(bashTool)
    ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'ask', reason: 'hook wants human' }))

    const result = await call('bash', { command: 'echo hi' }, 'delegate-bash')
    // The ask reached the pipeline without an approval answerer: the plugin
    // delegated instead of swallowing the decision.
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('hook wants human') })
  })

  it('the monotonic guard keeps a deny rule authoritative over a later allow', async () => {
    await compose()
    ctx.tools.register(echoTool)
    // A later prepend listener runs BEFORE the plugin's own listener and
    // allows everything; the guard stage must still deny the echo rule.
    ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'allow' }), { prepend: true })

    const result = await call('echo', { text: 'hi' }, 'guard-echo')
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: echo is disabled here' })
  })
})

describe('approval answerer', () => {
  it('auto-grants an approval request for a listed tool', async () => {
    await compose()
    await expect(ask('fetch', 'fetch-call')).resolves.toBe('allowed-once')
  })

  it('auto-grants a command-level ask from the recorded call arguments', async () => {
    await compose()
    ctx.tools.register(bashTool)
    // Dispatch the call so the plugin records its arguments, then ask about it.
    await call('bash', { command: 'git push' }, 'bash-call')

    await expect(ask('bash', 'bash-call')).resolves.toBe('allowed-once')
  })

  it('delegates asks that match no rule to the remaining answerers', async () => {
    await compose()
    ctx.tools.register(bashTool)
    await call('bash', { command: 'echo hi' }, 'bash-call')

    await expect(ask('bash', 'bash-call')).resolves.toBe('unavailable')
    ctx.on('approval/request', () => Promise.resolve('rejected' as const))
    await expect(ask('bash', 'bash-call')).resolves.toBe('rejected')
    // Without a call id no arguments are recorded; delegation still applies.
    await expect(ask('bash')).resolves.toBe('rejected')
  })
})

describe('presets', () => {
  it('switches the active preset through the Remote and persists the whole table', async () => {
    await compose()
    ctx.tools.register(echoTool)

    // The default preset denies echo with its own reason.
    const before = await call('echo', {}, 'before-switch')
    expect(before.content[0]).toMatchObject({ text: 'Error: echo is disabled here' })

    const view = await fs.switchPresetRemote('work')
    expect(view.active).toBe('work')

    // The next call is judged against the new preset's rules.
    const after = await call('echo', {}, 'after-switch')
    expect(after.content[0]).toMatchObject({ text: 'Error: echo disabled in work preset' })

    const settings = ctx.get('settings') as FakeSettings
    expect(settings.writes).toHaveLength(1)
    expect(settings.writes[0]).toMatchObject({ active: 'work' })
    expect(Object.keys(settings.writes[0]!.presets as Record<string, PresetSpecWire>)).toEqual(['default', 'work'])

    await expect(fs.switchPresetRemote('nope')).rejects.toThrow(/unknown preset/)
  })

  it('creates, edits, renames, and deletes presets through the Remotes', async () => {
    await compose()
    ctx.tools.register(bashTool)

    const created = await fs.createPresetRemote('ci', {
      allowRules: [],
      denyRules: [{ tool: 'bash', when: { command: { regex: 'rm -rf /' } }, reason: 'ci denies rm' }],
      allowApprovals: [],
      extraWritableRoots: [],
    })
    expect(created.active).toBe('ci')
    expect(created.presets.map(entry => entry.name)).toEqual(['default', 'work', 'ci'])

    // The new preset is active, so the next call is judged under its rules.
    const result = await call('bash', { command: 'rm -rf /' }, 'after-create')
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: ci denies rm' })

    const updated = await fs.updatePresetRemote('ci', {
      allowRules: [],
      denyRules: [{ tool: 'bash', when: { command: { regex: 'rm -rf /' } }, reason: 'ci2 denies rm' }],
      allowApprovals: [],
      extraWritableRoots: [],
    }, 'ci2')
    expect(updated.active).toBe('ci2')
    expect(updated.presets.map(entry => entry.name)).toEqual(['default', 'work', 'ci2'])

    const afterRename = await call('bash', { command: 'rm -rf /' }, 'after-rename')
    expect(afterRename.content[0]).toMatchObject({ text: 'Error: ci2 denies rm' })

    const afterDelete = await fs.deletePresetRemote('work')
    expect(afterDelete.presets.map(entry => entry.name)).toEqual(['default', 'ci2'])
    expect(afterDelete.active).toBe('ci2')

    await expect(fs.deletePresetRemote('ci2')).rejects.toThrow(/cannot delete the active preset/)
    await expect(fs.createPresetRemote('default', {
      allowRules: [], denyRules: [], allowApprovals: [], extraWritableRoots: [],
    })).rejects.toThrow(/already exists/)
  })

  it('keeps switching process-local without a settings service and refuses edits', async () => {
    await compose({ settings: false })
    ctx.tools.register(echoTool)

    const view = await fs.switchPresetRemote('work')
    expect(view.active).toBe('work')

    const result = await call('echo', {}, 'no-settings-switch')
    expect(result.content[0]).toMatchObject({ text: 'Error: echo disabled in work preset' })

    await expect(fs.createPresetRemote('ci', {
      allowRules: [], denyRules: [], allowApprovals: [], extraWritableRoots: [],
    })).rejects.toThrow(/settings service/)
  })

  it('fails loud on an unknown configured selection', async () => {
    await expect(compose({ active: 'missing' })).rejects.toThrow(/preset "missing" is not configured/)
  })
})

describe('extra writable roots', () => {
  it('admits filesystem writes under a configured extra root and advertises it', async () => {
    await compose()
    await mkdir(workspace, { recursive: true })

    const outsideTarget = await ctx.fs.resolve(join(extra, 'out.txt'))
    await expect(ctx.fs.writeText(outsideTarget, 'extra')).resolves.toBeDefined()
    expect(existsSync(join(extra, 'out.txt'))).toBe(true)

    const assembly = await ctx.systemPrompt.assemble()
    const ourContext = assembly.contexts.find(entry => entry.name === 'custom-permission:extra-roots')
    expect(ourContext?.text).toContain(`"${extra}"`)
    expect(ourContext?.text).toContain('also writable')

    const workspaceTarget = await ctx.fs.resolve(join(workspace, 'in.txt'))
    await expect(ctx.fs.writeText(workspaceTarget, 'ws')).resolves.toBeDefined()
  })
})
