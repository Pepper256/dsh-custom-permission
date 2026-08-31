/**
 * Tests for the dsh-custom-permission filesystem backend: the per-call policy
 * fence extends `@deepseek-ai/dsh-fs-sandbox`'s with the configured extra
 * writable roots — workspace and platform-temp writes stay admitted,
 * extra-root writes are admitted, everything else is denied with the
 * structured FS_SANDBOX_DENIED, `read-only` still denies everything, and
 * `danger-full-access` still passes through. The fence is exercised on a
 * real filesystem: a denied write leaves no file on disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import CustomPermissionFileSystem from '../src/index.ts'

let base: string
let workspace: string
let outside: string
let extra: string
let ctx: Context
let fs: CustomPermissionFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

async function boot(extraRoots: string[] = [extra]): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  fiber = await ctx.plugin(CustomPermissionFileSystem, {
    cwd: workspace,
    presets: { default: { extraWritableRoots: extraRoots } },
  })
  fs = ctx.fs as CustomPermissionFileSystem
}

beforeEach(async () => {
  // Base under HOME, deliberately NOT tmpdir: `workspace-write` grants /tmp
  // and os.tmpdir() (parity with the bash runner), so an "outside" dir under
  // tmpdir would be legitimately writable. Sibling dirs under HOME are outside
  // every grant, so containment failures are real denials.
  base = await mkdtemp(join(homedir(), '.dsh-custom-perm-'))
  workspace = join(base, 'ws')
  outside = join(base, 'out')
  extra = join(base, 'extra')
  await mkdir(workspace)
  await mkdir(outside)
  await mkdir(extra)
})
afterEach(async () => {
  await fiber?.dispose()
  await rm(base, { recursive: true, force: true })
})

/** Resolve a path through the backend and return its target. */
function target(path: string): Promise<FsTarget> {
  return fs.resolve(path)
}

describe('workspace-write with extra roots', () => {
  it('admits writes under the session workspace', async () => {
    await boot()
    const path = join(workspace, 'a.txt')
    await expect(fs.writeText(await target(path), 'ok')).resolves.toMatchObject({ version: expect.anything() })
    expect(await readFile(path, 'utf8')).toBe('ok')
  })

  it('admits writes under each configured extra root', async () => {
    await boot()
    const path = join(extra, 'b.txt')
    await expect(fs.writeText(await target(path), 'extra')).resolves.toBeDefined()
    expect(await readFile(path, 'utf8')).toBe('extra')
  })

  it('admits edits under a configured extra root', async () => {
    await boot()
    const path = join(extra, 'c.txt')
    await writeFile(path, 'before')
    await expect(fs.editText(await target(path), { oldString: 'before', newString: 'after', replaceAll: false })).resolves.toBeDefined()
    expect(await readFile(path, 'utf8')).toBe('after')
  })

  it('still denies writes outside every grant, leaving no file on disk', async () => {
    await boot()
    const path = join(outside, 'denied.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('catches `..` traversal out of an extra root', async () => {
    await boot()
    const path = join(extra, '..', 'outside2.txt')
    await expect(fs.writeText(await target(path), 'x')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('throws the structured FsError for an outside denial', async () => {
    await boot()
    let error: unknown
    try {
      await fs.writeText(await target(join(outside, 'denied.txt')), 'x')
    } catch (caught: unknown) {
      error = caught
    }
    expect(error).toBeInstanceOf(FsError)
    expect((error as FsError).code).toBe('FS_SANDBOX_DENIED')
  })

  it('resolves relative extra roots against the backend cwd and deduplicates', async () => {
    await boot(['..', '..'])
    const path = join(base, 'nested.txt')
    await expect(fs.writeText(await target(path), 'nested')).resolves.toBeDefined()
    expect(await readFile(path, 'utf8')).toBe('nested')
  })
})

describe('mode interactions', () => {
  it('read-only denies writes even under an extra root', async () => {
    await boot()
    const path = join(extra, 'ro.txt')
    const policy = { mode: 'read-only' as const, workspaceRoot: workspace }
    await expect(fs.writeText(await target(path), 'x', undefined, undefined, policy)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(existsSync(path)).toBe(false)
  })

  it('danger-full-access admits writes anywhere, extra roots aside', async () => {
    await boot([])
    const path = join(outside, 'free.txt')
    const policy = { mode: 'danger-full-access' as const, workspaceRoot: workspace }
    await expect(fs.writeText(await target(path), 'free', undefined, undefined, policy)).resolves.toBeDefined()
    expect(await readFile(path, 'utf8')).toBe('free')
  })

  it('reports the deployment default mode as its sandboxMode fact', async () => {
    await boot()
    expect(fs.sandboxMode).toBe('workspace-write')
  })
})

describe('config validation', () => {
  it('rejects a non-array extraWritableRoots at load', async () => {
    const failing = new Context()
    await failing.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await failing.plugin(SystemPrompt)
    await failing.plugin(Tools)
    await expect(failing.plugin(CustomPermissionFileSystem, {
      cwd: workspace,
      presets: { default: { extraWritableRoots: 'not-an-array' } },
    } as never)).rejects.toThrow()
    await failing.fiber.dispose()
  })

  it('rejects a config without the required default preset', async () => {
    const failing = new Context()
    await failing.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await failing.plugin(SystemPrompt)
    await failing.plugin(Tools)
    await expect(failing.plugin(CustomPermissionFileSystem, {
      cwd: workspace,
      presets: { work: {} },
    } as never)).rejects.toThrow(/presets\.default is required/)
    await failing.fiber.dispose()
  })

  it('rejects an invalid rule regex at load, naming the failing preset', async () => {
    const failing = new Context()
    await failing.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
    await failing.plugin(SystemPrompt)
    await failing.plugin(Tools)
    await expect(failing.plugin(CustomPermissionFileSystem, {
      cwd: workspace,
      presets: {
        default: {},
        work: { denyRules: [{ tool: 'regex:[' }] },
      },
    } as never)).rejects.toThrow(/preset "work" is invalid/)
    await failing.fiber.dispose()
  })
})
