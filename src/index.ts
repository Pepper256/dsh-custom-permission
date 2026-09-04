/**
 * dsh-custom-permission: one out-of-tree plugin providing the sandboxed
 * filesystem backend with configurable extra writable roots, plus the
 * auto-allow / auto-deny policy over the tool pipeline and the approval seam.
 *
 * Permission settings live in a named preset table. The `default` preset is
 * required in the composition config (it may be empty) and any preset that
 * fails to compile fails the plugin load — nothing ever falls back to another
 * preset. The composition table is the SEED: while the `custom-permission`
 * settings document carries no user preset table the composition presets are
 * authoritative, and the first runtime change (Web editor or command) copies
 * the whole current table into the settings document, which becomes the
 * authoritative table from then on (later composition edits are shadowed until
 * the settings section is cleared). The active preset is a process-level
 * selection: it starts at `default`, can be switched through
 * `/custom-permission preset <name>` or the Web panel, and the selection is
 * persisted in the settings namespace (hot-reloaded, so a restart restores the
 * last selection; an invalid stored name fails the load).
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
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { lookupCallArguments } from './answerer.ts'
import { applyPermissionCommand } from './command.ts'
import { PluginConfig, Preset } from './config.ts'
import type {
  FieldMatcher as FieldMatcherSpec,
  FieldMatcherWire,
  Preset as PresetSpec,
  PresetSpecWire,
  RuleSpec as RuleSpecSpec,
  RuleSpecWire,
} from './config.ts'
import { isPathUnder } from './containment.ts'
import { EXTRA_ROOTS_CONTEXT_NAME, EXTRA_ROOTS_CONTEXT_ORDER, renderExtraRootsContext } from './context.ts'
import { compileRules, evaluateRules } from './rules.ts'
import type { CompiledRule } from './rules.ts'

/** Brand one valid namespace string; mirrors the check the settings service applies. */
function settingsNamespace(value: string): SettingsNamespace {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ^[a-z][a-z0-9-]*$`)
  }
  return value as SettingsNamespace
}

/** Settings namespace carrying the preset table and the active preset name. */
export const CUSTOM_PERMISSION_SETTINGS_NAMESPACE = settingsNamespace('custom-permission')

/**
 * The settings document's value shape for this plugin: the active preset name
 * plus the user-owned preset table (absent until the first runtime change —
 * the composition table is the seed, see the module doc).
 */
interface PresetSettingsDocument {
  /** The active preset name (user layer, switched through the UI or command). */
  preset: string
  /** The user-owned preset table; absent while the composition table still seeds. */
  presets?: Record<string, PresetSpec>
}

/** The active preset's compiled enforcement state, replaced atomically on switch. */
interface CompiledPreset {
  readonly allowRules: readonly CompiledRule[]
  readonly denyRules: readonly CompiledRule[]
  readonly allowApprovalsSet: ReadonlySet<string>
  readonly extraRoots: readonly string[]
}

/** Wire view of one configured preset, for the Web client's preset panel. */
export interface PresetViewEntry {
  readonly name: string
  readonly active: boolean
  readonly allowRules: readonly string[]
  readonly denyRules: readonly string[]
  readonly allowApprovals: readonly string[]
  readonly extraWritableRoots: readonly string[]
}

/** Wire view of the whole preset table plus the active name. */
export interface PresetListView {
  readonly active: string
  readonly presets: readonly PresetViewEntry[]
}

/**
 * Full plugin config: the local backend's knobs plus the preset table.
 * `presets` is optional here because schemastery validates `default` and the
 * rest is read through the schema-transformed value.
 */
export interface Config extends LocalConfig {
  /** Named preset table; `default` required, its four fields may be empty. */
  presets?: Record<string, PresetSpec>
}

/** Valid preset names: non-empty, no whitespace, at most 64 characters. */
const PRESET_NAME_PATTERN = /^\S+$/

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
function compilePreset(spec: PresetSpec, cwd: string): CompiledPreset {
  return {
    allowRules: compileRules(spec.allowRules ?? []),
    denyRules: compileRules(spec.denyRules ?? []),
    allowApprovalsSet: new Set(spec.allowApprovals ?? []),
    extraRoots: resolveExtraRoots(spec.extraWritableRoots ?? [], cwd),
  }
}

/**
 * Validate a preset name for runtime creation/rename. Throws with a
 * correction-oriented message; names with whitespace would break the
 * `/custom-permission preset <name>` command grammar.
 * @param raw - the proposed name.
 * @param taken - names already in the table.
 * @param exempt - the name this write replaces (rename), if any.
 * @returns the accepted name.
 */
function validatePresetName(raw: string, taken: ReadonlySet<string>, exempt?: string): string {
  if (!PRESET_NAME_PATTERN.test(raw) || raw.length > 64) {
    throw new Error('preset name must be non-empty, contain no whitespace, and be at most 64 characters')
  }
  if (raw !== exempt && taken.has(raw)) {
    throw new Error(`a preset named "${raw}" already exists`)
  }
  return raw
}

/** Coerce one wire preset (regex sources as strings) into a typed preset (RegExp). */
function coercePresetSpec(raw: unknown): PresetSpec {
  // The schemastery schema is callable: it validates the structure, turns
  // regex sources into RegExp, defaults the four arrays, and throws on an
  // invalid regular expression — the earliest point a bad editor input fails.
  // The inferred output type is inexpressible against the `Preset` interface
  // (schemastery fields are nullable), so the value is re-typed.
  return Preset(raw as never) as unknown as PresetSpec
}

/** One matcher to its JSON wire form: regex sources, never RegExp instances. */
function matcherToWire(matcher: FieldMatcherSpec): FieldMatcherWire {
  const wire: FieldMatcherWire = {}
  if (matcher.regex !== undefined) {
    wire.regex = matcher.regex instanceof RegExp ? matcher.regex.source : String(matcher.regex)
  }
  if (matcher.prefix !== undefined) wire.prefix = matcher.prefix
  if (matcher.glob !== undefined) wire.glob = matcher.glob
  if (matcher.contains !== undefined) wire.contains = matcher.contains
  return wire
}

/** One rule to its JSON wire form (see {@link matcherToWire}). */
function ruleToWire(rule: RuleSpecSpec): RuleSpecWire {
  const wire: RuleSpecWire = { tool: rule.tool }
  if (rule.when !== undefined) {
    wire.when = {}
    for (const [field, matcher] of Object.entries(rule.when)) {
      wire.when[field] = matcherToWire(matcher)
    }
  }
  if (rule.reason !== undefined) wire.reason = rule.reason
  return wire
}

/** One typed preset to the JSON wire form the editor endpoints carry. */
function presetToWire(spec: PresetSpec): PresetSpecWire {
  return {
    allowRules: (spec.allowRules ?? []).map(ruleToWire),
    denyRules: (spec.denyRules ?? []).map(ruleToWire),
    allowApprovals: [...(spec.allowApprovals ?? [])],
    extraWritableRoots: [...(spec.extraWritableRoots ?? [])],
  }
}

/** Human-readable description of one matcher for the `/custom-permission` command. */
function describeMatcher(matcher: FieldMatcherSpec): string {
  const parts: string[] = []
  if (matcher.regex !== undefined) parts.push(`regex /${matcher.regex instanceof RegExp ? matcher.regex.source : matcher.regex}/`)
  if (matcher.prefix !== undefined) parts.push(`prefix "${matcher.prefix}"`)
  if (matcher.glob !== undefined) parts.push(`glob "${matcher.glob}"`)
  if (matcher.contains !== undefined) parts.push(`contains "${matcher.contains}"`)
  return parts.join(' + ')
}

/** Human-readable description of one rule for the `/custom-permission` command. */
function describeRule(spec: RuleSpecSpec, index: number): string {
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

  /** The Typert Gateway binding exposing the `customPermission` Remote namespace. */
  readonly typertRemote = bindTypertRemote(this, 'fs', { namespace: 'customPermission' })

  /**
   * Local backend fields plus the preset table; invalid rules and a missing
   * `default` preset fail at load. The `override` modifier is inexpressible
   * here: tsc requires it on this static, while the vite/rolldown parser
   * rejects the spelling, so the error is suppressed with the literal
   * `static` form.
   */
  // @ts-expect-error TS4114 — static Config override; see the doc above.
  static Config = z.intersect([LocalFileSystem.Config, PluginConfig]) as unknown as z<Config>

  /** The composition's preset table (the seed; see the module doc). */
  private readonly configSpecs: ReadonlyMap<string, PresetSpec>

  /** The EFFECTIVE preset specs: composition presets until the first runtime change. */
  private specs: ReadonlyMap<string, PresetSpec>

  /** Compiled state of every effective preset; replaced atomically on table change. */
  private compiled: ReadonlyMap<string, CompiledPreset>

  /** Compiled state of the active preset (the process-level selection). */
  private current: CompiledPreset

  /** Name of the active preset. */
  private currentPresetName = 'default'

  /** The settings document thunk (falls back to the composition entry on detach). */
  private settingsValue: () => PresetSettingsDocument = () => ({ preset: 'default' })

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const configSpecs = new Map(Object.entries(config.presets ?? {}))
    this.configSpecs = configSpecs
    const compiled = new Map<string, CompiledPreset>()
    for (const [name, spec] of configSpecs) {
      try {
        compiled.set(name, compilePreset(spec, this.config.cwd))
      } catch (error) {
        throw new Error(`dsh-custom-permission: preset "${name}" is invalid: ${errorMessage(error)}`)
      }
    }
    this.specs = configSpecs
    this.compiled = compiled
    // The schema guarantees `presets.default`; this narrows the optional type.
    this.current = compiled.get('default') ?? compilePreset({}, this.config.cwd)

    // Persist the table and the selection in the `custom-permission` settings
    // namespace. The composition preset table is the seed while the document
    // carries none; once a runtime change stores one, it is authoritative. An
    // invalid stored table (uncompilable preset, unknown active name) throws
    // from the attach-time `onChange` and therefore fails the plugin load,
    // never silently falling back to `default`. Without a settings service
    // the table and the selection stay process-local.
    const settingsSchema = z.object({
      preset: z.string().required(),
      presets: z.dict(Preset),
    }) as unknown as z<PresetSettingsDocument>
    this.attachSettingsSection(ctx, settingsSchema)
  }

  /**
   * Wire the `custom-permission` settings namespace without depending on the
   * `installSettingsSection` convenience export, which released dsh-settings
   * versions differ on. Uses only the stable `register`/`watch` surface both
   * the installed closure and the master source share: while a settings
   * service exists the namespace is registered with the composition entry as
   * its base layer; committed changes and attach re-derive the table through
   * `onChange`, and service teardown falls back to the process-local
   * composition entry without touching the fiber mid-unload.
   */
  private attachSettingsSection(ctx: Context, settingsSchema: z<PresetSettingsDocument>): void {
    ctx.inject(['settings'], (sctx) => {
      const settings = sctx.settings as {
        register<T>(
          ns: SettingsNamespace,
          schema: z<T>,
          options?: { base?: Partial<T> },
        ): { get(): T; watch(callback: () => void): () => void }
      }
      const scope = settings.register<PresetSettingsDocument>(
        CUSTOM_PERMISSION_SETTINGS_NAMESPACE,
        settingsSchema,
        { base: { preset: 'default' } },
      )
      let active = true
      this.settingsValue = () => scope.get()
      const onChange = (): void => {
        if (active) this.syncFromSettings(scope.get())
      }
      onChange()
      scope.watch(() => onChange())
      sctx.effect(() => () => {
        active = false
        this.settingsValue = () => ({ preset: 'default' })
      })
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

  /**
   * Re-derive the effective table from the resolved settings document. The
   * stored user table wins when the document carries one (even a single-entry
   * one); otherwise the composition table is the seed. An uncompilable preset
   * throws — at attach this fails the plugin load, on later document edits
   * the settings service contains the failure and keeps the last good value.
   */
  private syncFromSettings(value: PresetSettingsDocument): void {
    const user = value.presets
    const specs = user !== undefined && Object.keys(user).length > 0
      ? new Map(Object.entries(user))
      : this.configSpecs
    this.commitTable(specs)
    this.applyPreset(value.preset)
  }

  /** Compile every preset of a table atomically; an invalid preset throws, nothing is replaced. */
  private commitTable(specs: ReadonlyMap<string, PresetSpec>): void {
    const compiled = new Map<string, CompiledPreset>()
    for (const [name, spec] of specs) {
      try {
        compiled.set(name, compilePreset(spec, this.config.cwd))
      } catch (error) {
        throw new Error(`dsh-custom-permission: preset "${name}" is invalid: ${errorMessage(error)}`)
      }
    }
    this.specs = specs
    this.compiled = compiled
  }

  /** Replace the active preset atomically; unknown names fail loud, never falling back. */
  private applyPreset(name: string): void {
    const compiled = this.compiled.get(name)
    if (compiled === undefined) {
      throw new Error(`dsh-custom-permission: preset "${name}" is not configured; available: ${[...this.compiled.keys()].join(', ')}`)
    }
    this.current = compiled
    this.currentPresetName = name
  }

  /** Switch the process-level selection; persists through settings when available. */
  private switchPreset(name: string): void {
    if (!this.specs.has(name)) {
      throw new Error(`dsh-custom-permission: unknown preset "${name}"; available: ${[...this.specs.keys()].join(', ')}`)
    }
    const settings = this.ctx.get('settings') as
      | { update(namespace: string, patch: Record<string, unknown>): Promise<void> }
      | undefined
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
      this.applyPreset(name)
    }
  }

  /**
   * Persist a whole next preset table plus the active name, then commit it
   * atomically. The section is REPLACED wholesale (not merged): `update`'s
   * recursive merge could never express deletion or rename, so a removed
   * composition preset would resurrect on every boot. This plugin owns the
   * whole `custom-permission` section (`preset` + `presets`), so replace is
   * lossless.
   * @param nextSpecs - the complete next table (already validated).
   * @param active - the preset to activate.
   */
  private async persistTable(nextSpecs: ReadonlyMap<string, PresetSpec>, active: string): Promise<void> {
    const settings = this.ctx.get('settings') as
      | { replace(namespace: string, section: Record<string, unknown>): Promise<void> }
      | undefined
    if (settings === undefined) {
      throw new Error('dsh-custom-permission: preset changes need a settings service; add @deepseek-ai/dsh-settings-file to the profile')
    }
    const presetsJson: Record<string, PresetSpecWire> = {}
    for (const [name, spec] of nextSpecs) {
      presetsJson[name] = presetToWire(spec)
    }
    await settings.replace(CUSTOM_PERMISSION_SETTINGS_NAMESPACE, { preset: active, presets: presetsJson })
    this.commitTable(nextSpecs)
    this.applyPreset(active)
  }

  /** Build the wire view of every effective preset, for the Web client panel. */
  private presetListView(): PresetListView {
    const entries: PresetViewEntry[] = []
    for (const [name, spec] of this.specs) {
      entries.push({
        name,
        active: name === this.currentPresetName,
        allowRules: (spec.allowRules ?? []).map((rule, index) => describeRule(rule, index)),
        denyRules: (spec.denyRules ?? []).map((rule, index) => describeRule(rule, index)),
        allowApprovals: spec.allowApprovals ?? [],
        extraWritableRoots: this.compiled.get(name)?.extraRoots ?? [],
      })
    }
    return { active: this.currentPresetName, presets: entries }
  }

  /**
   * Remote: the configured preset table plus the active name, for the Web
   * client's preset panel.
   * @returns the full wire view.
   */
  @Remote('list')
  listPresetsRemote(): PresetListView {
    return this.presetListView()
  }

  /**
   * Remote: switch the process-level selection and return the refreshed view.
   * @param name - the preset to activate.
   * @returns the full wire view after the switch.
   * @throws when the preset is unknown — the client surfaces it as an error.
   */
  @Remote('switch')
  switchPresetRemote(name: string): PresetListView {
    this.switchPreset(name)
    return this.presetListView()
  }

  /**
   * Remote: one preset's structured spec for the editor prefill.
   * @param name - the preset to read.
   * @returns the preset's wire spec.
   * @throws when the preset is unknown.
   */
  @Remote('get')
  getPresetRemote(name: string): PresetSpecWire {
    const spec = this.specs.get(name)
    if (spec === undefined) {
      throw new Error(`dsh-custom-permission: unknown preset "${name}"; available: ${[...this.specs.keys()].join(', ')}`)
    }
    return presetToWire(spec)
  }

  /**
   * Remote: create a preset (validated, compiled, persisted) and activate it.
   * @param name - the new preset's name.
   * @param spec - the wire spec (regex sources as strings).
   * @returns the full wire view after the change.
   * @throws when the name is invalid or taken, or the spec does not compile.
   */
  @Remote('create')
  async createPresetRemote(name: string, spec: unknown): Promise<PresetListView> {
    const taken = new Set(this.specs.keys())
    const target = validatePresetName(name, taken)
    const typed = coercePresetSpec(spec)
    try {
      compilePreset(typed, this.config.cwd)
    } catch (error) {
      throw new Error(`preset spec for "${target}" is invalid: ${errorMessage(error)}`)
    }
    const next = new Map(this.specs)
    next.set(target, typed)
    await this.persistTable(next, target)
    return this.presetListView()
  }

  /**
   * Remote: replace one preset's rules and optionally rename it. Renaming the
   * active preset moves the selection to the new name.
   * @param name - the preset to update.
   * @param spec - the wire spec (regex sources as strings).
   * @param renameTo - the preset's name after the edit (may equal `name`).
   * @returns the full wire view after the change.
   * @throws when the preset is unknown, the new name is invalid or taken, or
   *   the spec does not compile.
   */
  @Remote('update')
  async updatePresetRemote(name: string, spec: unknown, renameTo: string): Promise<PresetListView> {
    if (!this.specs.has(name)) {
      throw new Error(`dsh-custom-permission: unknown preset "${name}"; available: ${[...this.specs.keys()].join(', ')}`)
    }
    const taken = new Set(this.specs.keys())
    const target = validatePresetName(renameTo, taken, name)
    const typed = coercePresetSpec(spec)
    try {
      compilePreset(typed, this.config.cwd)
    } catch (error) {
      throw new Error(`preset spec for "${target}" is invalid: ${errorMessage(error)}`)
    }
    const next = new Map<string, PresetSpec>()
    for (const [existing, existingSpec] of this.specs) {
      next.set(existing === name ? target : existing, existingSpec)
    }
    next.set(target, typed)
    const active = this.currentPresetName === name ? target : this.currentPresetName
    await this.persistTable(next, active)
    return this.presetListView()
  }

  /**
   * Remote: delete a preset. Deleting the active preset and deleting the last
   * remaining preset are refused.
   * @param name - the preset to delete.
   * @returns the full wire view after the change.
   * @throws when the preset is unknown, active, or the only one left.
   */
  @Remote('delete')
  async deletePresetRemote(name: string): Promise<PresetListView> {
    if (!this.specs.has(name)) {
      throw new Error(`dsh-custom-permission: unknown preset "${name}"; available: ${[...this.specs.keys()].join(', ')}`)
    }
    if (this.currentPresetName === name) {
      throw new Error(`cannot delete the active preset "${name}"; switch to another preset first`)
    }
    if (this.specs.size <= 1) {
      throw new Error('cannot delete the last preset')
    }
    const next = new Map(this.specs)
    next.delete(name)
    await this.persistTable(next, this.currentPresetName)
    return this.presetListView()
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
      if (!this.specs.has(name)) {
        return { kind: 'error', text: `unknown preset "${name}"; available: ${[...this.specs.keys()].join(', ')}` }
      }
      this.switchPreset(name)
      return { kind: 'success', text: `switched to preset "${name}"` }
    }
    return { kind: 'error', text: 'usage: /custom-permission [preset <name> | presets]' }
  }

  /** The preset names and the active one, for `/custom-permission presets`. */
  private listPresets(): string {
    const names = [...this.specs.keys()]
    const marker = (name: string): string => name === this.currentPresetName ? `${name} (active)` : name
    return `available presets: ${names.map(marker).join(', ')}`
  }

  /** Read-only summary of the active preset, rendered by the `/custom-permission` command. */
  private summarize(): string {
    const lines = [`dsh-custom-permission: active preset "${this.currentPresetName}"`, this.listPresets()]
    const spec = this.specs.get(this.currentPresetName)
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
