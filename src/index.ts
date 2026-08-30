/**
 * dsh-custom-permission: one out-of-tree plugin providing the sandboxed
 * filesystem backend with configurable extra writable roots, plus the
 * auto-allow / auto-deny policy over the tool pipeline and the approval seam.
 *
 * Enforcement sites (all driven by the same compiled rules):
 * - `tools/pre-execute` (prepend): deny rules short-circuit before any hook
 *   can ask; allow rules short-circuit before any hook can ask, skipping the
 *   approval round trip entirely.
 * - `ctx.tools.guard()`: the monotonic deny backstop, evaluated after any
 *   pre-execute allow and after approval, so a deny rule is never bypassed.
 * - `approval/request` (prepend): auto-grants asks for tools listed in
 *   `allowApprovals`, and for allow rules whose command-level conditions
 *   match the ask's recovered `tool/call` arguments (sandbox escalation).
 *
 * The filesystem fence is `@deepseek-ai/dsh-fs-sandbox`'s, with one
 * difference: under `workspace-write`, a mutation is admitted when the target
 * lies under the shared `writableRoots(policy)` set OR one of the configured
 * `extraWritableRoots`. The shipped composition mounts this backend through
 * the bundle's `cordis.patch.yml`, which disables the base `fs-sandbox` row
 * and inserts this plugin as the sole `ctx.fs` provider.
 *
 * @module dsh-custom-permission
 */

import { isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsEditOutcome,
  FsEditRequest,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-commands'
import { lookupCallArguments } from './answerer.ts'
import { applyPermissionCommand } from './command.ts'
import { PolicyConfig } from './config.ts'
import type { FieldMatcher, RuleSpec } from './config.ts'
import { isPathUnder } from './containment.ts'
import { EXTRA_ROOTS_CONTEXT_NAME, EXTRA_ROOTS_CONTEXT_ORDER, renderExtraRootsContext } from './context.ts'
import { compileRules, evaluateRules } from './rules.ts'
import type { CompiledRule } from './rules.ts'

/**
 * Full plugin config: the local backend's knobs plus the permission policy.
 * Policy fields are optional here because schemastery applies their defaults
 * before construction; the constructor narrows with `?? []` once.
 */
export interface Config extends LocalConfig {
  /** Allow rules; a matching tool call short-circuits to `allow` before hooks. */
  allowRules?: RuleSpec[]
  /** Deny rules; a matching tool call is denied before approval and again by the monotonic guard. */
  denyRules?: RuleSpec[]
  /** Tool-level auto-grants: every ask for these tools resolves `allowed-once`, including sandbox escalation asks. */
  allowApprovals?: string[]
  /** Extra paths the filesystem fence admits for writes under `workspace-write`. */
  extraWritableRoots?: string[]
}

/**
 * Canonicalize and deduplicate the configured extra roots (relative to the
 * backend cwd). `resolve` after `canonicalPath` normalizes platform
 * separators — Windows `realpathSync.native` preserves forward slashes, which
 * would break the lexical containment fast path and leak into model context.
 */
function resolveExtraRoots(raw: readonly string[], cwd: string): readonly string[] {
  return [...new Set(raw.map(root => resolve(canonicalPath(isAbsolute(root) ? root : resolve(cwd, root)))))]
}

/** Human-readable description of one matcher for the `/custom-permission` command. */
function describeMatcher(matcher: FieldMatcher): string {
  const parts: string[] = []
  if (matcher.regex !== undefined) parts.push(`regex /${matcher.regex.source}/`)
  if (matcher.prefix !== undefined) parts.push(`prefix "${matcher.prefix}"`)
  if (matcher.glob !== undefined) parts.push(`glob "${matcher.glob}"`)
  if (matcher.contains !== undefined) parts.push(`contains "${matcher.contains}"`)
  return parts.join(' + ')
}

/** Human-readable description of one rule for the `/custom-permission` command. */
function describeRule(spec: RuleSpec, index: number): string {
  const when = spec.when === undefined
    ? ''
    : ' when ' + Object.entries(spec.when).map(([field, matcher]) => `${field} ${describeMatcher(matcher)}`).join(' AND ')
  const reason = spec.reason !== undefined ? ` (reason: "${spec.reason}")` : ''
  return `#${index + 1} tool=${spec.tool}${when}${reason}`
}

/**
 * The sandbox-enforcing filesystem backend with extra writable roots and the
 * auto-allow / auto-deny permission policy. Loading it INSTEAD OF
 * `dsh-fs-sandbox` (together with `ctx.sandboxPolicy`) is the whole swap; the
 * model-facing tools and the policy plugin are untouched. It registers as
 * `ctx.fs`, so a composition must not also mount `dsh-fs-sandbox`.
 */
export class CustomPermissionFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy', 'tools', 'systemPrompt']

  /**
   * Local backend fields plus the permission policy; invalid rules fail at
   * load. The `override` modifier is inexpressible here: tsc requires it on
   * this static, while the vite/rolldown parser rejects the spelling, so the
   * error is suppressed with the literal `static` form.
   */
  // @ts-expect-error TS4114 — static Config override; see the doc above.
  static Config = z.intersect([LocalFileSystem.Config, PolicyConfig]) as unknown as z<Config>

  private readonly allowRules: readonly CompiledRule[]
  private readonly denyRules: readonly CompiledRule[]
  private readonly allowApprovalsSet: ReadonlySet<string>
  private readonly extraRoots: readonly string[]
  private readonly allowSpecs: readonly RuleSpec[]
  private readonly denySpecs: readonly RuleSpec[]
  private readonly allowApprovals: readonly string[]

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // Compilation fails loud: an invalid regex or glob must never become a
    // silently non-matching rule. The schemastery defaults make these arrays
    // present at runtime; `?? []` only narrows the optional declared type.
    this.allowRules = compileRules(config.allowRules ?? [])
    this.denyRules = compileRules(config.denyRules ?? [])
    this.allowApprovalsSet = new Set(config.allowApprovals ?? [])
    this.extraRoots = resolveExtraRoots(config.extraWritableRoots ?? [], this.config.cwd)
    this.allowSpecs = config.allowRules ?? []
    this.denySpecs = config.denyRules ?? []
    this.allowApprovals = config.allowApprovals ?? []
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.ctx.sandboxPolicy.defaultMode
  }

  /** Register the policy listeners, the guard, the context contribution, and the command. */
  [Service.init](): void {
    // Allow/deny short-circuits before hooks and asks. Deny is checked first
    // so a call matching both tables fails closed.
    this.ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const deny = evaluateRules(this.denyRules, exec.name, exec.arguments)
      if (deny) return { kind: 'deny', reason: deny.denyReason }
      const allow = evaluateRules(this.allowRules, exec.name, exec.arguments)
      if (allow) return { kind: 'allow' }
      return next()
    }, { prepend: true })

    // Monotonic deny backstop: evaluated after any allow and after approval,
    // so a deny rule is never bypassed by another listener or an answerer.
    this.ctx.tools.guard(exec => {
      const deny = evaluateRules(this.denyRules, exec.name, exec.arguments)
      return deny ? deny.denyReason : undefined
    })

    // Approval answerer: tool-level auto-grants, then command-level allow
    // rules against the ask's recovered tool/call arguments.
    this.ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
      if (this.allowApprovalsSet.has(req.toolName)) return 'allowed-once'
      const args = lookupCallArguments(req.agent, req.callId)
      if (args !== undefined && evaluateRules(this.allowRules, req.toolName, args) !== undefined) {
        return 'allowed-once'
      }
      return next()
    }, { prepend: true })

    this.ctx.systemPrompt.context({
      name: EXTRA_ROOTS_CONTEXT_NAME,
      order: EXTRA_ROOTS_CONTEXT_ORDER,
      text: () => renderExtraRootsContext(this.extraRoots),
    })

    applyPermissionCommand(this.ctx, () => this.summarize())
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit. See {@link checkedTarget}.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal)
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target the
   * mutation must use, so the checked identity is the mutated one (no
   * check-here-write-there TOCTOU). `read-only` denies; `workspace-write`
   * re-canonicalizes now and requires containment under the shared writable
   * roots OR a configured extra root; `danger-full-access` returns the
   * caller's target unfenced. Throws the structured `FS_SANDBOX_DENIED` on
   * refusal — the tool layer maps it to the model-facing `[sandbox: …]` marker
   * and the escalation hint.
   */
  private async checkedTarget(target: FsTarget, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    // workspace-write: containment on the FRESH canonical path (catches a
    // symlink ancestor swapped since the tool resolved this target), and the
    // mutation delegates with THIS fresh target — never the stale one.
    const fresh = await this.resolve(target.displayPath)
    let contained = false
    for (const root of writableRoots(policy)) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      for (const root of this.extraRoots) {
        if (await isPathUnder(fresh.targetKey, root)) {
          contained = true
          break
        }
      }
    }
    if (!contained) {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }

  /** Read-only configuration summary rendered by the `/custom-permission` command. */
  private summarize(): string {
    const lines = ['dsh-custom-permission active configuration:']
    lines.push('', 'allow rules:')
    lines.push(...(this.allowSpecs.length === 0 ? ['  (none)'] : this.allowSpecs.map((spec, index) => '  ' + describeRule(spec, index))))
    lines.push('', 'deny rules:')
    lines.push(...(this.denySpecs.length === 0 ? ['  (none)'] : this.denySpecs.map((spec, index) => '  ' + describeRule(spec, index))))
    lines.push('', `auto-allowed approval tools: ${this.allowApprovals.length === 0 ? '(none)' : this.allowApprovals.join(', ')}`)
    lines.push('', `extra writable roots: ${this.extraRoots.length === 0 ? '(none)' : this.extraRoots.map(root => `"${root}"`).join(', ')}`)
    return lines.join('\n')
  }
}

export default CustomPermissionFileSystem
