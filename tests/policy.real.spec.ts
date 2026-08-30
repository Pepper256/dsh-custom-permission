/**
 * Real Loader composition tests for dsh-custom-permission: a test-only
 * cordis.yml boots through the Loader (sandbox-policy + system-prompt + tools
 * + user-approval + the plugin), and every assertion observes model-visible or
 * durable behavior — denied tool results, skipped hook asks, answered approval
 * requests — rather than listener internals.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
): Promise<{ ctx: Context; workspace: string; extra: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-custom-permission-loader-'))
  const workspace = join(root, 'ws')
  const extra = join(root, 'extra')
  const configPath = join(root, 'cordis.yml')
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
    "- name: 'dsh-custom-permission'",
    '  config:',
    '    allowRules:',
    "      - tool: 'bash'",
    '        when:',
    '          command:',
    "            regex: '^git '",
    '    denyRules:',
    "      - tool: 'bash'",
    '        when:',
    '          command:',
    "            regex: 'rm -rf /'",
    "      - tool: 'echo'",
    "        reason: 'echo is disabled here'",
    "    allowApprovals: ['fetch']",
    '    extraWritableRoots:',
    `      - '${yamlPath(extra)}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      switch (specifier) {
        case '@deepseek-ai/dsh-sandbox-policy': return SandboxPolicyService
        case '@deepseek-ai/dsh-system-prompt': return SystemPrompt
        case '@deepseek-ai/dsh-tools': return Tools
        case '@deepseek-ai/dsh-user-approval': return ApprovalService
        case 'dsh-custom-permission': return CustomPermissionFileSystem
        default: throw new Error(`unexpected Loader import: ${specifier}`)
      }
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()

  return { ctx: context, workspace, extra }
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
})
