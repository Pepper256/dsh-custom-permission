/**
 * dsh-custom-permission: one out-of-tree plugin providing the sandboxed
 * filesystem backend with configurable extra writable roots, plus the
 * auto-allow / auto-deny policy over the tool pipeline and the approval seam.
 *
 * Permission settings live in a named preset table (`presets`); the `default`
 * preset is required (it may be empty) and any preset that fails to compile
 * fails the plugin load — nothing ever falls back to another preset. The
 * active preset is a process-level selection: it starts at `default`, can be
 * switched through `/custom-permission preset <name>`, and the selection is
 * persisted in the `custom-permission` settings namespace (hot-reloaded, so a
 * restart restores the last selection; an invalid stored name fails the load).
 *
 * Enforcement sites (all driven by the active preset's compiled rules):
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
 * lies under the shared `writableRoots(policy)` set OR one of the active
 * preset's `extraWritableRoots`. The shipped composition mounts this backend
 * through the bundle's `cordis.patch.yml`, which disables the base
 * `fs-sandbox` row and inserts this plugin as the sole `ctx.fs` provider.
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
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { lookupCallArguments } from './answerer.ts'
import { applyPermissionCommand } from './command.ts'
import { PluginConfig } from './config.ts'
import type { FieldMatcher, Preset, RuleSpec } from './config.ts'
import { isPathUnder } from './containment.ts'
import { EXTRA_ROOTS_CONTEXT_NAME, EXTRA_ROOTS_CONTEXT_ORDER, renderExtraRootsContext } from './context.ts'
import { compileRules, evaluateRules } from './rules.ts'
import type { CompiledRule } from './rules.ts'

/** Settings namespace carrying the current preset selection (persisted, hot-reloaded). */
export const CUSTOM_PERMISSION_SETTINGS_NAMESPACE = settingsNamespace('custom-permission')

/** The settings document's value shape for this plugin. */
interface PresetSelection {
  /** The active preset name (user layer, switched through the UI or command). */
  preset: string
  /** The configured preset names (base layer; the Web client lists them). */
  presets: string[]
}

/** The active preset's compiled enforcement state, replaced atomically on switch. */
interface CompiledPreset {
  readonly allowRules: readonly CompiledRule[]
  readonly denyRules: readonly CompiledRule[]
  readonly allowApprovalsSet: ReadonlySet<string>
  readonly extraRoots: readonly string[]
}

/**
 * Full plugin config: the local backend's knobs plus the preset table.
 * `presets` is optional here because schemastery validates `default` and the
 * rest is read through the schema-transformed value.
 */
export interface Config extends LocalConfig {
  /** Named preset table; `default` required, its four fields may be empty. */
  presets?: Record<string, Preset>
}

/**
 * Canonicalize and deduplicate one preset's configured extra roots (relative
 * to the backend cwd). `resolve` after `canonicalPath` normalizes platform
 * separators — Windows `realpathSync.native` preserves forward slashes, which
 * would break the lexical containment fast path and leak into model context.
 */
function resolveExtraRoots(raw: readonly string[], cwd: string): readonly string[] {
  return [...new Set(raw.map(root => resolve(canonicalPath(isAbsolute(root) ? root : resolve(cwd, root)))))]
}

/** Best-effort message from an arbitrary thrown value, for fail-loud diagnostics. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Compile one preset's four knobs; invalid rules throw here (fail loud, no fallback). */
function compilePreset(spec: Preset, cwd: string): CompiledPreset {
  return {
    allowRules: compileRules(spec.allowRules ?? []),
    denyRules: compileRules(spec.denyRules ?? []),
    allowApprovalsSet: new Set(spec.allowApprovals ?? []),
    extraRoots: resolveExtraRoots(spec.extraWritableRoots ?? [], cwd),
  }
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
 * The sandbox-enforcing filesystem backend with preset-switchable extra
 * writable roots and the auto-allow / auto-deny permission policy. Loading it
 * INSTEAD OF `dsh-fs-sandbox` (together with `ctx.sandboxPolicy`) is the
 * whole swap; the model-facing tools and the policy plugin are untouched. It
 * registers as `ctx.fs`, so a composition must not also mount `dsh-fs-sandbox`.
 */
export class CustomPermissionFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy', 'tools', 'systemPrompt']

  /**
   * Local backend fields plus the preset table; invalid rules and a missing
   * `default` preset fail at load. The `override` modifier is inexpressible
   * here: tsc requires it on this static, while the vite/rolldown parser
   * rejects the spelling, so the error is suppressed with the literal
   * `static` form.
   */
  // @ts-expect-error TS4114 — static Config override; see the doc above.
  static Config = z.intersect([LocalFileSystem.Config, PluginConfig]) as unknown as z<Config>

  private readonly presetSpecs: ReadonlyMap<string, Preset>
  private readonly compiledPresets: ReadonlyMap<string, CompiledPreset>
  private current: CompiledPreset
  private currentPresetName = 'default'
  private selectionSource: () => string = () => 'default'

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const presetSpecs = new Map(Object.entries(config.presets ?? {}))
    this.presetSpecs = presetSpecs
    const compiledPresets = new Map<string, CompiledPreset>()
    for (const [name, spec] of presetSpecs) {
      try {
        compiledPresets.set(name, compilePreset(spec, this.config.cwd))
      } catch (error) {
        throw new Error(`dsh-custom-permission: preset "${name}" is invalid: ${errorMessage(error)}`)
      }
    }
    this.compiledPresets = compiledPresets
    // The schema guarantees `presets.default`; this narrows the optional type.
    this.current = compiledPresets.get('default') ?? compilePreset({}, this.config.cwd)

    // Persist the selection in the `custom-permission` settings namespace. An
    // invalid stored preset name fails the registration (and therefore the
    // plugin load), never silently falling back to `default`. Without a
    // settings service the selection stays process-local.
    const presetChoices = [...presetSpecs.keys()].map(name => z.const(name))
    const settingsSchema: z<PresetSelection> = z.object({
      preset: z.union(presetChoices).required(),
      // The table lives in the base layer so the Web client can list every
      // configured preset without a custom Remote surface.
      presets: z.array(z.string()).required(),
    })
    installSettingsSection(ctx, CUSTOM_PERMISSION_SETTINGS_NAMESPACE, settingsSchema, {
      preset: 'default',
      presets: [...presetSpecs.keys()],
    }, {
      setSource: (current) => {
        this.selectionSource = () => current().preset
      },
      onChange: () => {
        this.reapplySelection()
      },
    })
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
      const { denyRules, allowRules } = this.current
      const deny = evaluateRules(denyRules, exec.name, exec.arguments)
      if (deny) return { kind: 'deny', reason: deny.denyReason }
      const allow = evaluateRules(allowRules, exec.name, exec.arguments)
      if (allow) return { kind: 'allow' }
      return next()
    }, { prepend: true })

    // Monotonic deny backstop: evaluated after any allow and after approval,
    // so a deny rule is never bypassed by another listener or an answerer.
    this.ctx.tools.guard(exec => {
      const deny = evaluateRules(this.current.denyRules, exec.name, exec.arguments)
      return deny ? deny.denyReason : undefined
    })

    // Approval answerer: tool-level auto-grants, then command-level allow
    // rules against the ask's recovered tool/call arguments.
    this.ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
      const { allowApprovalsSet, allowRules } = this.current
      if (allowApprovalsSet.has(req.toolName)) return 'allowed-once'
      const args = lookupCallArguments(req.agent, req.callId)
      if (args !== undefined && evaluateRules(allowRules, req.toolName, args) !== undefined) {
        return 'allowed-once'
      }
      return next()
    }, { prepend: true })

    this.ctx.systemPrompt.context({
      name: EXTRA_ROOTS_CONTEXT_NAME,
      order: EXTRA_ROOTS_CONTEXT_ORDER,
      text: () => renderExtraRootsContext(this.current.extraRoots),
    })

    applyPermissionCommand(this.ctx, rawInput => this.handleCommand(rawInput))
  }

  /** Resolve the stored selection to a compiled preset; an unknown name fails loud. */
  private reapplySelection(): void {
    this.applyPreset(this.selectionSource())
  }

  /** Replace the active preset atomically; unknown names fail loud, never falling back. */
  private applyPreset(name: string): void {
    const compiled = this.compiledPresets.get(name)
    if (compiled === undefined) {
      throw new Error(`dsh-custom-permission: stored preset "${name}" is not a configured preset`)
    }
    this.current = compiled
    this.currentPresetName = name
  }

  /** Switch the process-level selection; persists through settings when available. */
  private switchPreset(name: string): void {
    if (!this.presetSpecs.has(name)) {
      throw new Error(`dsh-custom-permission: unknown preset "${name}"; available: ${[...this.presetSpecs.keys()].join(', ')}`)
    }
    const settings = this.ctx.get('settings')
    if (settings !== undefined) {
      // Apply synchronously so the next call is judged under the new preset;
      // the settings write follows and its watcher re-applies idempotently.
      this.applyPreset(name)
      void settings.update(CUSTOM_PERMISSION_SETTINGS_NAMESPACE, { preset: name }).then(
        () => this.applyPreset(name),
        (error: unknown) => {
          this.ctx.logger.warn(`dsh-custom-permission: failed to persist preset selection: ${errorMessage(error)}`)
        },
      )
    } else {
      this.selectionSource = () => name
      this.applyPreset(name)
    }
  }

  /** The `/custom-permission` command: bare = summary, `presets` = list, `preset <name>` = switch. */
  private handleCommand(rawInput: string): CommandResult {
    const input = rawInput.trim()
    if (input === '') return { kind: 'success', text: this.summarize() }
    const [verb, name] = input.split(/\s+/, 2) as [string, string | undefined]
    if (verb === 'presets') {
      return { kind: 'success', text: this.listPresets() }
    }
    if (verb === 'preset' && name !== undefined) {
      if (!this.presetSpecs.has(name)) {
        return { kind: 'error', text: `unknown preset "${name}"; available: ${[...this.presetSpecs.keys()].join(', ')}` }
      }
      this.switchPreset(name)
      return { kind: 'success', text: `switched to preset "${name}"` }
    }
    return { kind: 'error', text: 'usage: /custom-permission [preset <name> | presets]' }
  }

  /** The preset names and the active one, for `/custom-permission presets`. */
  private listPresets(): string {
    const names = [...this.presetSpecs.keys()]
    const marker = (name: string): string => name === this.currentPresetName ? `${name} (active)` : name
    return `available presets: ${names.map(marker).join(', ')}`
  }

  /** Read-only summary of the active preset, rendered by the `/custom-permission` command. */
  private summarize(): string {
    const lines = [`dsh-custom-permission: active preset "${this.currentPresetName}"`, this.listPresets()]
    const spec = this.presetSpecs.get(this.currentPresetName)
    const allowRules = spec?.allowRules ?? []
    const denyRules = spec?.denyRules ?? []
    const allowApprovals = spec?.allowApprovals ?? []
    lines.push('', 'allow rules:')
    lines.push(...(allowRules.length === 0 ? ['  (none)'] : allowRules.map((rule, index) => '  ' + describeRule(rule, index))))
    lines.push('', 'deny rules:')
    lines.push(...(denyRules.length === 0 ? ['  (none)'] : denyRules.map((rule, index) => '  ' + describeRule(rule, index))))
    lines.push('', `auto-allowed approval tools: ${allowApprovals.length === 0 ? '(none)' : allowApprovals.join(', ')}`)
    lines.push('', `extra writable roots: ${this.current.extraRoots.length === 0 ? '(none)' : this.current.extraRoots.map(root => `"${root}"`).join(', ')}`)
    return lines.join('\n')
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
   * roots OR the active preset's extra roots; `danger-full-access` returns the
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
      for (const root of this.current.extraRoots) {
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
}

export default CustomPermissionFileSystem
