/**
 * Real Loader composition tests for dsh-custom-permission: a test-only
 * cordis.yml boots through the Loader (sandbox-policy + system-prompt + tools
 * + user-approval + the plugin), and every assertion observes model-visible or
 * durable behavior — denied tool results, skipped hook asks, answered approval
 * requests — rather than listener internals.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import ApiGateway from '@deepseek-ai/dsh-api-gateway'
import CustomPermissionFileSystem from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Forward-slash spelling for YAML single-quoted strings on Windows. */
function yamlPath(path: string): string {
  return path.split('\\').join('/')
}

/** Boot the test composition through the Loader; the extra root is this base's own `extra` dir. */
async function compose(
  approvalPolicy: 'ask' | 'never',
): Promise<{ ctx: Context; workspace: string; extra: string; settingsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-custom-permission-loader-'))
  return boot(root, approvalPolicy)
}

/** Boot the Loader composition inside an existing root (for restart tests). */
async function boot(
  rootPath: string,
  approvalPolicy: 'ask' | 'never',
): Promise<{ ctx: Context; workspace: string; extra: string; settingsPath: string }> {
  const workspace = join(rootPath, 'ws')
  const extra = join(rootPath, 'extra')
  const settingsPath = join(rootPath, 'settings.yaml')
  const configPath = join(rootPath, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    '    mode: workspace-write',
    `    workspaceRoot: '${yamlPath(workspace)}'`,
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-user-approval'",
    '  config:',
    `    policy: ${approvalPolicy}`,
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: '${yamlPath(settingsPath)}'`,
    "- name: '@deepseek-ai/dsh-typert-registry'",
    "- name: '@deepseek-ai/dsh-api-gateway'",
    "- name: 'dsh-custom-permission'",
    '  config:',
    '    presets:',
    '      default:',
    '        allowRules:',
    "          - tool: 'bash'",
    '            when:',
    '              command:',
    "                regex: '^git '",
    '        denyRules:',
    "          - tool: 'bash'",
    '            when:',
    '              command:',
    "                regex: 'rm -rf /'",
    "          - tool: 'echo'",
    "            reason: 'echo is disabled here'",
    "        allowApprovals: ['fetch']",
    '        extraWritableRoots:',
    `          - '${yamlPath(extra)}'`,
    '      work:',
    '        denyRules:',
    "          - tool: 'echo'",
    "            reason: 'echo disabled in work preset'",
    '',
  ].join('\n'))

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(rootPath).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      switch (specifier) {
        case '@deepseek-ai/dsh-sandbox-policy': return SandboxPolicyService
        case '@deepseek-ai/dsh-system-prompt': return SystemPrompt
        case '@deepseek-ai/dsh-tools': return Tools
        case '@deepseek-ai/dsh-user-approval': return ApprovalService
        case '@deepseek-ai/dsh-commands': return CommandRuntime
        case '@deepseek-ai/dsh-settings-file': return SettingsFile
        case '@deepseek-ai/dsh-typert-registry': return TypertRegistry
        case '@deepseek-ai/dsh-api-gateway': return ApiGateway
        case 'dsh-custom-permission': return CustomPermissionFileSystem
        default: throw new Error(`unexpected Loader import: ${specifier}`)
      }
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()

  // Module bookkeeping so the default `compose` path disposes on afterEach.
  context = ctx
  return { ctx, workspace, extra, settingsPath }
}

/** A minimal Agent stand-in with a seeded open turn and optional tool/call events. */
function fakeAgent(seed: Array<{ type: string; data?: Record<string, unknown> }>): { agent: Agent; appended: Array<{ type: string; data: Record<string, unknown> }> } {
  const appended: Array<{ type: string; data: Record<string, unknown> }> = []
  const agent = {
    session: {
      events: seed,
      append: (type: string, data: Record<string, unknown>) => {
        appended.push({ type, data })
        return { type, data }
      },
    },
  } as unknown as Agent
  return { agent, appended }
}

function requestOf(agent: Agent, toolName: string, callId?: string): ApprovalRequest {
  return { agent, toolName, ...callId !== undefined ? { callId: ToolCallId(callId) } : {} }
}

const testSignal = () => new AbortController().signal

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

describe('dsh-custom-permission real Loader composition', () => {
  it('loads as the sole ctx.fs provider with the policy service composed', async () => {
    const { ctx } = await compose('ask')
    expect(ctx.get('fs')).toBeInstanceOf(CustomPermissionFileSystem)
    expect(ctx.get('sandboxPolicy')).toBeInstanceOf(SandboxPolicyService)
  })

  it('denies a matching tool call before execution, with the configured reason', async () => {
    const { ctx } = await compose('ask')
    ctx.tools.register(echoTool)

    const result = await ctx.tools.execute({
      signal: testSignal(), callId: ToolCallId('deny-echo'), name: 'echo', arguments: { text: 'hi' },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: echo is disabled here' })
  })

  it('denies a matching bash command with the numbered default reason', async () => {
    const { ctx } = await compose('ask')
    ctx.tools.register(bashTool)

    const result = await ctx.tools.execute({
      signal: testSignal(), callId: ToolCallId('deny-bash'), name: 'bash', arguments: { command: 'rm -rf /' },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: blocked by dsh-custom-permission rule #1 (tool "bash")' })
  })

  it('auto-allows a matching command before a later hook ask can fire', async () => {
    const { ctx } = await compose('ask')
    ctx.tools.register(bashTool)
    // A hook-style ask producer registered AFTER the plugin: without the
    // plugin's allow short-circuit, this would send the call to approval.
    ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'ask', reason: 'hook wants human' }))

    const result = await ctx.tools.execute({
      signal: testSignal(), callId: ToolCallId('allow-bash'), name: 'bash', arguments: { command: 'git status' },
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toMatchObject({ text: 'git status' })
  })

  it('delegates a non-matching call so downstream ask producers still decide', async () => {
    const { ctx } = await compose('ask')
    ctx.tools.register(bashTool)
    ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'ask', reason: 'hook wants human' }))

    const result = await ctx.tools.execute({
      signal: testSignal(), callId: ToolCallId('delegate-bash'), name: 'bash', arguments: { command: 'echo hi' },
    })
    // The ask reached approval without an agent to route it through: the
    // plugin delegated instead of swallowing the decision.
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('no agent to route it through') })
  })

  it('the monotonic guard keeps a deny rule authoritative over a later allow', async () => {
    const { ctx } = await compose('ask')
    ctx.tools.register(echoTool)
    // A later prepend listener runs BEFORE the plugin's own listener and
    // allows everything; the guard stage must still deny the echo rule.
    ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'allow' }), { prepend: true })

    const result = await ctx.tools.execute({
      signal: testSignal(), callId: ToolCallId('guard-echo'), name: 'echo', arguments: { text: 'hi' },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: echo is disabled here' })
  })

  it('auto-grants an approval request for a listed tool without any session lookup', async () => {
    const { ctx } = await compose('ask')
    const { agent } = fakeAgent([{ type: 'turn/start' }])

    await expect(ctx.approval.request(requestOf(agent, 'fetch', 'fetch-call'))).resolves.toBe('allowed-once')
  })

  it('auto-grants a command-level ask by recovering the logged tool/call arguments', async () => {
    const { ctx } = await compose('ask')
    const { agent } = fakeAgent([
      { type: 'turn/start' },
      {
        type: 'tool/call',
        data: { callId: 'bash-call', name: 'bash', arguments: JSON.stringify({ command: 'git push' }) },
      },
    ])

    await expect(ctx.approval.request(requestOf(agent, 'bash', 'bash-call'))).resolves.toBe('allowed-once')
  })

  it('delegates asks that match no rule to the remaining answerers', async () => {
    const { ctx } = await compose('ask')
    const { agent } = fakeAgent([
      { type: 'turn/start' },
      { type: 'tool/call', data: { callId: 'bash-call', name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) } },
    ])

    await expect(ctx.approval.request(requestOf(agent, 'bash', 'bash-call'))).resolves.toBe('unavailable')
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'))
    await expect(ctx.approval.request(requestOf(agent, 'bash', 'bash-call'))).resolves.toBe('rejected')
    // Without a call id the lookup cannot recover arguments; delegation still applies.
    await expect(ctx.approval.request(requestOf(agent, 'bash'))).resolves.toBe('rejected')
  })

  it('the never policy rejects before the plugin answerer can grant', async () => {
    const { ctx } = await compose('never')
    const { agent } = fakeAgent([{ type: 'turn/start' }])

    await expect(ctx.approval.request(requestOf(agent, 'fetch', 'fetch-call'))).resolves.toBe('rejected')
  })

  it('exposes the active preset through the settings namespace', async () => {
    const { ctx } = await compose('ask')
    const describe = await ctx.get('settings')!.describe()
    const ours = describe.find(entry => entry.ns === 'custom-permission')
    expect(ours).toBeDefined()
    expect(ours?.value).toMatchObject({ preset: 'default' })
  })

  it('admits filesystem writes under a configured extra root through the whole composition', async () => {
    const { ctx, workspace, extra } = await compose('ask')
    await mkdir(extra, { recursive: true })
    await mkdir(workspace, { recursive: true })

    const outsideTarget = await ctx.fs.resolve(join(extra, 'out.txt'))
    await expect(ctx.fs.writeText(outsideTarget, 'extra')).resolves.toBeDefined()

    const assembly = await ctx.systemPrompt.assemble()
    const ourContext = assembly.contexts.find(entry => entry.name === 'custom-permission:extra-roots')
    expect(ourContext?.text).toContain(`"${extra}"`)
    expect(ourContext?.text).toContain('also writable')

    const workspaceTarget = await ctx.fs.resolve(join(workspace, 'in.txt'))
    await expect(ctx.fs.writeText(workspaceTarget, 'ws')).resolves.toBeDefined()
  })

  it('serves the customPermission Remote namespace through the gateway', async () => {
    const { ctx } = await compose('ask')
    const gateway = ctx.get('typertGateway') as unknown as {
      invoke(request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown>
    }

    const list = await gateway.invoke({ namespace: 'customPermission', method: 'list', args: {} }) as { active: string; presets: Array<{ name: string; active: boolean }> }
    expect(list.active).toBe('default')
    expect(list.presets.map(entry => entry.name)).toEqual(['default', 'work'])
    expect(list.presets.find(entry => entry.name === 'default')?.active).toBe(true)

    const switched = await gateway.invoke({ namespace: 'customPermission', method: 'switch', args: { name: 'work' } }) as { active: string }
    expect(switched.active).toBe('work')

    await expect(gateway.invoke({ namespace: 'customPermission', method: 'switch', args: { name: 'nope' } })).rejects.toThrow(/unknown preset/)
  })

  it('switches presets through the command, applies them to the next call, and persists the selection', async () => {
    const { ctx, settingsPath } = await compose('ask')
    ctx.tools.register(echoTool)

    // The default preset denies echo with its own reason.
    const before = await ctx.tools.execute({
      signal: testSignal(), callId: ToolCallId('before-switch'), name: 'echo', arguments: {},
    })
    expect(before.content[0]).toMatchObject({ text: 'Error: echo is disabled here' })

    // The command lists both presets, then switches to `work` synchronously.
    const { agent } = fakeAgent([{ type: 'turn/start' }])
    const listed = await ctx.commands.execute(agent, '/custom-permission presets', [], new AbortController().signal)
    expect(listed?.result).toMatchObject({ kind: 'success' })
    expect(listed?.result.text).toContain('default')
    expect(listed?.result.text).toContain('work')

    const switched = await ctx.commands.execute(agent, '/custom-permission preset work', [], new AbortController().signal)
    expect(switched?.result).toMatchObject({ kind: 'success' })
    expect(switched?.result.text).toContain('switched to preset "work"')

    // The next call is judged against the new preset's rules.
    const after = await ctx.tools.execute({
      signal: testSignal(), callId: ToolCallId('after-switch'), name: 'echo', arguments: {},
    })
    expect(after.content[0]).toMatchObject({ text: 'Error: echo disabled in work preset' })

    // The selection persists to the settings document (poll for the async write).
    let document = ''
    for (let attempt = 0; attempt < 40 && !document.includes('preset: work'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      document = await readFile(settingsPath, 'utf8').catch(() => '')
    }
    expect(document).toContain('preset: work')

    // An unknown preset is an error, not a fallback.
    const unknown = await ctx.commands.execute(agent, '/custom-permission preset nope', [], new AbortController().signal)
    expect(unknown?.result).toMatchObject({ kind: 'error' })
    expect(unknown?.result.text).toContain('unknown preset "nope"')
  })
})

/** Invoke one `customPermission` Remote method through the live gateway. */
async function invoke(ctx: Context, method: string, args: Record<string, unknown>): Promise<unknown> {
  const gateway = ctx.get('typertGateway') as unknown as {
    invoke(request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown>
  }
  return gateway.invoke({ namespace: 'customPermission', method, args })
}

/** Wait until the settings document contains `needle` (the write is async). */
async function waitForDocument(settingsPath: string, needle: string): Promise<string> {
  let document = ''
  for (let attempt = 0; attempt < 40 && !document.includes(needle); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    document = await readFile(settingsPath, 'utf8').catch(() => '')
  }
  return document
}

/** A minimal wire spec for the editor Remotes. */
function wireSpec(overrides: Partial<{
  allowRules: Array<Record<string, unknown>>
  denyRules: Array<Record<string, unknown>>
  allowApprovals: string[]
  extraWritableRoots: string[]
}> = {}): Record<string, unknown> {
  return {
    allowRules: [],
    denyRules: [],
    allowApprovals: [],
    extraWritableRoots: [],
    ...overrides,
  }
}

describe('dsh-custom-permission preset editing over the real gateway', () => {
  it('creates a preset through the Remote, persists it, and enforces it', async () => {
    const { ctx, settingsPath } = await compose('ask')
    ctx.tools.register(bashTool)

    const created = await invoke(ctx, 'create', {
      name: 'ci',
      spec: wireSpec({ denyRules: [{ tool: 'bash', when: { command: { regex: 'rm -rf /' } }, reason: 'ci denies rm' }] }),
    }) as { active: string; presets: Array<{ name: string }> }
    expect(created.active).toBe('ci')
    expect(created.presets.map(entry => entry.name)).toEqual(['default', 'work', 'ci'])

    // The new preset is active, so the next call is judged under its rules.
    const result = await ctx.tools.execute({
      signal: testSignal(), callId: ToolCallId('after-create'), name: 'bash', arguments: { command: 'rm -rf /' },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: ci denies rm' })

    // The full table plus the selection land in the settings document.
    const document = await waitForDocument(settingsPath, 'preset: ci')
    expect(document).toContain('preset: ci')
    expect(document).toContain('ci denies rm')
  })

  it('returns a structured spec through get for the editor prefill', async () => {
    const { ctx } = await compose('ask')
    const spec = await invoke(ctx, 'get', { name: 'default' }) as { allowRules: Array<{ tool: string; when?: Record<string, unknown> }> }
    expect(spec.allowRules[0]).toMatchObject({ tool: 'bash' })
    expect(spec.allowRules[0].when?.command).toMatchObject({ regex: '^git ' })
  })

  it('rejects an invalid spec and a duplicate name without persisting anything', async () => {
    const { ctx, settingsPath } = await compose('ask')

    await expect(invoke(ctx, 'create', {
      name: 'bad',
      // An uncompilable tool pattern fails the Host's own compile step.
      spec: wireSpec({ allowRules: [{ tool: 'regex:(' }] }),
    })).rejects.toThrow(/invalid/)

    await expect(invoke(ctx, 'create', {
      name: 'default',
      spec: wireSpec(),
    })).rejects.toThrow(/already exists/)

    const listed = await invoke(ctx, 'list', {}) as { presets: Array<{ name: string }> }
    expect(listed.presets.map(entry => entry.name)).toEqual(['default', 'work'])
    // No write ever reached the document (the file may not even exist yet).
    const document = await readFile(settingsPath, 'utf8').catch(() => '')
    expect(document).not.toContain('bad')
  })

  it('edits and renames the active preset through the Remote', async () => {
    const { ctx, settingsPath } = await compose('ask')
    ctx.tools.register(echoTool)
    await invoke(ctx, 'switch', { name: 'work' })

    const updated = await invoke(ctx, 'update', {
      name: 'work',
      spec: wireSpec({ denyRules: [{ tool: 'echo', reason: 'work2 denies echo' }] }),
      renameTo: 'work2',
    }) as { active: string; presets: Array<{ name: string; active: boolean }> }
    expect(updated.active).toBe('work2')
    expect(updated.presets.map(entry => entry.name)).toEqual(['default', 'work2'])

    // Renaming the active preset moves the selection with it.
    const result = await ctx.tools.execute({
      signal: testSignal(), callId: ToolCallId('after-update'), name: 'echo', arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ text: 'Error: work2 denies echo' })

    const document = await waitForDocument(settingsPath, 'preset: work2')
    expect(document).toContain('preset: work2')
    expect(document).not.toContain('echo disabled in work preset')
  })

  it('deletes a preset through the Remote but refuses to delete the active one', async () => {
    const { ctx } = await compose('ask')

    const afterDelete = await invoke(ctx, 'delete', { name: 'work' }) as { active: string; presets: Array<{ name: string }> }
    expect(afterDelete.presets.map(entry => entry.name)).toEqual(['default'])

    // `default` is the active preset — deleting it fails loud.
    await expect(invoke(ctx, 'delete', { name: 'default' })).rejects.toThrow(/cannot delete the active preset/)
    const listed = await invoke(ctx, 'list', {}) as { presets: Array<{ name: string }> }
    expect(listed.presets.map(entry => entry.name)).toEqual(['default'])
  })

  it('restarts with the stored table authoritative over the composition', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'dsh-custom-permission-restart-'))
    try {
      const first = await boot(rootPath, 'ask')
      try {
        // First session: add a runtime preset and delete the composition `work`
        // preset — the stored table now is `default` + `ci`, active `ci`.
        const created = await invoke(first.ctx, 'create', {
          name: 'ci',
          spec: wireSpec({ denyRules: [{ tool: 'echo', reason: 'ci restart denies echo' }] }),
        }) as { presets: Array<{ name: string }> }
        expect(created.presets.map(entry => entry.name)).toEqual(['default', 'work', 'ci'])
        await invoke(first.ctx, 'delete', { name: 'work' })
        // Deleting must actually remove the preset from the stored document
        // (a merge-only write could never express the removal).
        const afterDelete = await waitForDocument(first.settingsPath, 'preset: ci')
        expect(afterDelete).not.toContain('echo disabled in work preset')
      } finally {
        await first.ctx.fiber.dispose()
      }

      // Second session on the same home: the stored table wins over the
      // composition (which still declares `work`), and the selection restores.
      const second = await boot(rootPath, 'ask')
      context = undefined
      try {
        const listed = await invoke(second.ctx, 'list', {}) as { active: string; presets: Array<{ name: string }> }
        expect(listed.active).toBe('ci')
        expect(listed.presets.map(entry => entry.name)).toEqual(['default', 'ci'])

        // The restored active preset is enforced.
        second.ctx.tools.register(echoTool)
        const result = await second.ctx.tools.execute({
          signal: testSignal(), callId: ToolCallId('after-restart'), name: 'echo', arguments: {},
        })
        expect(result.isError).toBe(true)
        expect(result.content[0]).toMatchObject({ text: 'Error: ci restart denies echo' })
      } finally {
        await second.ctx.fiber.dispose()
      }
    } finally {
      await rm(rootPath, { recursive: true, force: true })
    }
  })
})
