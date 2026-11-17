/**
 * dsh-custom-permission: one out-of-tree plugin providing the sandboxed
 * filesystem backend with configurable extra writable roots, plus the
 * auto-allow / auto-deny policy over the tool pipeline and the approval seam.
 *
 * Permission settings are the plugin's own profile config: a named preset
 * table plus the active preset name. Both fields are schemastery-volatile, so
 * the Loader commits a new value into the running plugin's references without
 * remounting it, and dsh-settings can write them through the active profile
 * patch. The table is the single source of truth: the composition seeds it,
 * runtime edits replace it wholesale, and a missing `default` preset, an
 * uncompilable preset, or an unknown active name fails loud — nothing ever
 * falls back to another preset. The active preset is a process-level
 * selection: it starts at the configured name, can be switched through
 * `/custom-permission preset <name>` or the Web panel, and is persisted to the
 * profile patch when a settings service is composed (a profile without one
 * keeps the switch process-local).
 *
 * Enforcement sites (all driven by the active preset's compiled rules):
 * - `tools/pre-execute` (prepend): the dispatched call's arguments are recorded
 *   for the approval answerer, then deny rules short-circuit before any hook
 *   can ask and allow rules short-circuit before any hook can ask, skipping
 *   the approval round trip entirely.
 * - `ctx.tools.guard()`: the monotonic deny backstop, evaluated after any
 *   pre-execute allow and after approval, so a deny rule is never bypassed.
 * - `approval/request` (prepend): auto-grants asks for tools listed in
 *   `allowApprovals`, and for allow rules whose command-level conditions match
 *   the recorded arguments of the ask's call (sandbox escalation).
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
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { createCallArgumentsCache } from './answerer.ts'
import type { CallArgumentsCache } from './answerer.ts'
import { applyPermissionCommand } from './command.ts'
import { Preset, Presets, readVolatile } from './config.ts'
import type {
  FieldMatcher as FieldMatcherSpec,
  FieldMatcherWire,
  MaybeVolatile,
  Preset as PresetSpec,
  PresetSpecWire,
  RuleSpec as RuleSpecSpec,
  RuleSpecWire,
} from './config.ts'
import { isPathUnder } from './containment.ts'
import { EXTRA_ROOTS_CONTEXT_NAME, EXTRA_ROOTS_CONTEXT_ORDER, renderExtraRootsContext } from './context.ts'
import { compileRules, evaluateRules } from './rules.ts'
import type { CompiledRule } from './rules.ts'

/**
 * The dsh-settings service surface this plugin depends on. Deliberately
 * structural: the released SettingsForms service (describe/update keyed by
 * profile entry id) is stable across the 0.2 line, and a profile without it
 * simply keeps the selection process-local.
 */
interface SettingsFormsLike {
  /** Live configuration descriptors, one per addressable profile entry. */
  describe(): Array<{ readonly ns: string; readonly revision: number; readonly schema: unknown }>
  /** Merge a volatile-field patch into one profile entry's config. */
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** The active preset's compiled enforcement state, replaced atomically on switch. */
interface CompiledPreset {
  readonly allowRules: readonly CompiledRule[]
  readonly denyRules: readonly CompiledRule[]
  readonly allowApprovalsSet: ReadonlySet<string>
  readonly extraRoots: readonly string[]
}

/** The compiled table plus the resolved selection for one enforcement observation. */
interface EnforcementState {
  readonly table: Record<string, PresetSpec>
  readonly name: string
  readonly compiled: ReadonlyMap<string, CompiledPreset>
  readonly current: CompiledPreset
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
 * Full plugin config: the local backend's knobs plus the preset table and the
 * active preset name. The two runtime-editable fields arrive as Loader
 * volatile references inside a running plugin; plain values keep direct
 * construction (tests) and the composition seed usable.
 */
export interface Config extends LocalConfig {
  /** Named preset table; `default` required at load, its four fields may be empty. */
  presets?: MaybeVolatile<Record<string, PresetSpec> | undefined>
  /** Active preset name; absent means `default`. */
  active?: MaybeVolatile<string | undefined>
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
  // Volatile config values arrive deep-frozen, and schema normalization
  // writes defaults into nested objects, so validate a mutable clone.
  const copy = structuredClone(raw)
  // The inferred output type is inexpressible against the `Preset` interface
  // (schemastery fields are nullable), so the value is re-typed.
  return Preset(copy as never) as unknown as PresetSpec
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
   * The local backend's knobs restated as a plain object schema, so the
   * `presets` and `active` volatile children are visible to the Loader's
   * config diff and to dsh-settings form projection. An `intersect` schema
   * would hide both.
   */
  static Config = z.object({
    ...(LocalFileSystem.Config as unknown as { dict: Record<string, z> }).dict,
    presets: Presets.volatile(),
    active: z.string().volatile(),
  }) as unknown as z<Config>

  /** The live config references (Loader volatile fields, or plain values in tests). */
  private readonly configRefs: { presets: MaybeVolatile<Record<string, PresetSpec> | undefined>; active: MaybeVolatile<string | undefined> }

  /** The table identity the compiled cache belongs to. */
  private compiledTable: Record<string, PresetSpec> | undefined

  /** The selection the compiled cache belongs to. */
  private compiledName: string | undefined

  /** Compiled state of every configured preset, replaced atomically on table change. */
  private compiled: ReadonlyMap<string, CompiledPreset> | undefined

  /** Compiled state of the active preset. */
  private current: CompiledPreset | undefined

  /** Name of the active preset. */
  private activeName: string | undefined

  /** A selection applied before its persistence settles (or kept without settings). */
  private activeOverride: string | undefined

  /** A preset table applied before its persisted config reference settles. */
  private tableOverride: Record<string, PresetSpec> | undefined

  /** The raw config table the normalized table was derived from. */
  private normalizedRaw: Record<string, PresetSpec> | undefined

  /** The normalized (RegExp-bearing, defaults-filled) view of the config table. */
  private normalizedTable: Record<string, PresetSpec> | undefined

  /** The recorded arguments of recently dispatched tool calls, for approval asks. */
  private readonly calls: CallArgumentsCache = createCallArgumentsCache()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    if (config.presets === undefined) {
      throw new Error('dsh-custom-permission: config.presets is required (its four fields may be empty)')
    }
    this.configRefs = {
      presets: config.presets,
      active: config.active ?? undefined,
    }
    // Fail loud at load: invalid presets, a missing `default`, or an unknown
    // configured selection never fall back to another preset.
    this.state()
  }

  /** The configured preset table, read fresh from the volatile config reference. */
  private configTable(): Record<string, PresetSpec> {
    const table = readVolatile(this.configRefs.presets)
    if (table === undefined || table === null) {
      throw new Error('dsh-custom-permission: config.presets is required (its four fields may be empty)')
    }
    return table
  }

  /** The configured active preset name, read fresh from the volatile config reference. */
  private configActiveName(): string {
    return readVolatile(this.configRefs.active) ?? 'default'
  }

  /** The selection currently in force: a pending switch, else the configured name. */
  private selection(): string {
    return this.activeOverride ?? this.configActiveName()
  }

  /** Whether two preset tables carry the same JSON wire content (regexes as sources). */
  private sameTable(left: Record<string, PresetSpec>, right: Record<string, PresetSpec>): boolean {
    const wire = (table: Record<string, PresetSpec>): string =>
      JSON.stringify(Object.keys(table).sort().map(name => [name, presetToWire(table[name]!)]))
    return wire(left) === wire(right)
  }

  /**
   * Drop a pending override once the config references reflect it: the Loader
   * commits a volatile write into the running references, while a plain test
   * config never changes and keeps the override in force.
   */
  private syncOverrides(): void {
    if (this.activeOverride !== undefined && this.configActiveName() === this.activeOverride) {
      this.activeOverride = undefined
    }
    if (this.tableOverride !== undefined) {
      try {
        if (this.sameTable(this.configTable(), this.tableOverride)) this.tableOverride = undefined
      } catch {
        // An unreadable config table keeps the applied override in force.
      }
    }
  }

  /**
   * Compile every preset of a table atomically; an invalid preset (or a table
   * without `default`) throws, nothing is replaced.
   * @param table - the preset table in declaration order.
   * @returns compiled state per preset.
   */
  private compileTable(table: Record<string, PresetSpec>): ReadonlyMap<string, CompiledPreset> {
    if (!Object.hasOwn(table, 'default')) {
      throw new Error('dsh-custom-permission: presets.default is required (its four fields may be empty)')
    }
    const compiled = new Map<string, CompiledPreset>()
    for (const [name, spec] of Object.entries(table)) {
      try {
        compiled.set(name, compilePreset(spec, this.config.cwd))
      } catch (error) {
        throw new Error(`dsh-custom-permission: preset "${name}" is invalid: ${errorMessage(error)}`)
      }
    }
    return compiled
  }

  /**
   * Normalize the raw config table into the typed form the policy consumes.
   * Volatile config values are JSON-shaped, so regex matchers arrive as
   * sources; the schema turns them into RegExp and fills the four field
   * defaults, and an invalid entry fails loud with its preset name.
   * @param raw - the raw config table.
   * @returns the typed table.
   */
  private normalizeTable(raw: Record<string, PresetSpec>): Record<string, PresetSpec> {
    const normalized: Record<string, PresetSpec> = {}
    for (const [name, spec] of Object.entries(raw)) {
      try {
        normalized[name] = coercePresetSpec(spec)
      } catch (error) {
        throw new Error(`dsh-custom-permission: preset "${name}" is invalid: ${errorMessage(error)}`)
      }
    }
    return normalized
  }

  /**
   * Resolve the current enforcement state: compile on table/selection change,
   * otherwise reuse the compiled cache. An unknown selection fails loud.
   * @returns the table, selection, compiled table, and active compiled preset.
   */
  private state(): EnforcementState {
    this.syncOverrides()
    const raw = this.tableOverride ?? this.configTable()
    const name = this.selection()
    if (this.normalizedRaw !== raw || this.normalizedTable === undefined) {
      this.normalizedTable = this.normalizeTable(raw)
      this.normalizedRaw = raw
    }
    const table = this.normalizedTable
    if (this.compiledTable !== raw || this.compiledName !== name || this.compiled === undefined || this.current === undefined || this.activeName === undefined) {
      const compiled = this.compileTable(table)
      const current = compiled.get(name)
      if (current === undefined) {
        throw new Error(`dsh-custom-permission: preset "${name}" is not configured; available: ${[...compiled.keys()].join(', ')}`)
      }
      this.compiledTable = raw
      this.compiledName = name
      this.compiled = compiled
      this.current = current
      this.activeName = name
    }
    return { table, name: this.activeName, compiled: this.compiled, current: this.current }
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.ctx.sandboxPolicy.defaultMode
  }

  /** Register the policy listeners, the guard, the context contribution, and the command. */
  [Service.init](): void {
    // Record every dispatched call's arguments first: the approval answerer
    // recovers command-level asks by call id, and this stage runs immediately
    // before the tool body that can ask.
    this.ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      this.calls.remember(String(exec.callId), exec.arguments)
      const { current } = this.state()
      // Deny is checked first so a call matching both tables fails closed.
      const deny = evaluateRules(current.denyRules, exec.name, exec.arguments)
      if (deny) return { kind: 'deny', reason: deny.denyReason }
      const allow = evaluateRules(current.allowRules, exec.name, exec.arguments)
      if (allow) return { kind: 'allow' }
      return next()
    }, { prepend: true })

    // Monotonic deny backstop: evaluated after any allow and after approval,
    // so a deny rule is never bypassed by another listener or an answerer.
    this.ctx.tools.guard(exec => {
      const deny = evaluateRules(this.state().current.denyRules, exec.name, exec.arguments)
      return deny ? deny.denyReason : undefined
    })

    // Approval answerer: tool-level auto-grants, then command-level allow
    // rules against the recorded arguments of the ask's call.
    this.ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
      const { current } = this.state()
      if (current.allowApprovalsSet.has(req.toolName)) return 'allowed-once'
      const args = req.callId === undefined ? undefined : this.calls.lookup(String(req.callId))
      if (args !== undefined && evaluateRules(current.allowRules, req.toolName, args) !== undefined) {
        return 'allowed-once'
      }
      return next()
    }, { prepend: true })

    this.ctx.systemPrompt.context({
      name: EXTRA_ROOTS_CONTEXT_NAME,
      order: EXTRA_ROOTS_CONTEXT_ORDER,
      text: () => renderExtraRootsContext(this.state().current.extraRoots),
    })

    applyPermissionCommand(this.ctx, rawInput => this.handleCommand(rawInput))
  }

  /**
   * Locate this plugin's profile entry in the settings service. The entry's
   * schema is this class's static Config (the Loader records it on the fiber),
   * so the address is discovered rather than hardcoded, and a renamed profile
   * row keeps working.
   * @param settings - the composed settings service.
   * @returns the profile entry id, or undefined when the entry is not configurable here.
   */
  private settingsNamespace(settings: SettingsFormsLike): string | undefined {
    try {
      const descriptor = settings.describe().find(entry => entry.schema === CustomPermissionFileSystem.Config)
      return descriptor?.ns
    } catch (error) {
      this.ctx.logger.warn(`dsh-custom-permission: cannot read settings descriptors: ${errorMessage(error)}`)
      return undefined
    }
  }

  /**
   * Persist the whole preset table plus the active name into this plugin's
   * profile entry. The row config is replaced wholesale (the same layering the
   * composition patch uses), so every write restates the complete table — a
   * removal can never resurrect. Writes go through the settings service's
   * volatile-field form, which persists to the active profile patch and lets
   * the Loader commit the new references without remounting the plugin.
   * @param table - the complete next table.
   * @param active - the preset to select.
   * @param required - whether a missing settings service/entry is an error.
   * @returns whether the write reached the settings service.
   */
  private async persist(table: Record<string, PresetSpec>, active: string, required: boolean): Promise<boolean> {
    const settings = this.ctx.get('settings') as SettingsFormsLike | undefined
    if (settings === undefined) {
      if (!required) return false
      throw new Error('dsh-custom-permission: preset changes need the settings service; add @deepseek-ai/dsh-settings to the profile')
    }
    const ns = this.settingsNamespace(settings)
    if (ns === undefined) {
      if (!required) return false
      throw new Error('dsh-custom-permission: cannot locate this plugin\'s profile config entry; preset changes need a writable profile patch')
    }
    const presetsJson: Record<string, PresetSpecWire> = {}
    for (const [name, spec] of Object.entries(table)) {
      presetsJson[name] = presetToWire(spec)
    }
    const revision = settings.describe().find(entry => entry.ns === ns)?.revision
    await settings.update(ns, { presets: presetsJson, active }, revision)
    // Apply the write locally until the Loader's volatile commit (or, for a
    // plain config without live references, for the rest of the process).
    this.tableOverride = table
    this.activeOverride = active
    return true
  }

  /** Build the wire view of every effective preset, for the Web client panel. */
  private presetListView(): PresetListView {
    const { table, name, compiled } = this.state()
    const entries: PresetViewEntry[] = []
    for (const [presetName, spec] of Object.entries(table)) {
      entries.push({
        name: presetName,
        active: presetName === name,
        allowRules: (spec.allowRules ?? []).map((rule, index) => describeRule(rule, index)),
        denyRules: (spec.denyRules ?? []).map((rule, index) => describeRule(rule, index)),
        allowApprovals: spec.allowApprovals ?? [],
        extraWritableRoots: compiled.get(presetName)?.extraRoots ?? [],
      })
    }
    return { active: name, presets: entries }
  }

  /**
   * Switch the process-level selection. The override applies immediately; a
   * composed settings service persists it to the profile patch, otherwise the
   * switch stays process-local.
   * @param name - the preset to activate.
   * @throws when the preset is unknown — the client surfaces it as an error.
   */
  private async switchPreset(name: string): Promise<void> {
    const { table } = this.state()
    if (!Object.hasOwn(table, name)) {
      throw new Error(`dsh-custom-permission: unknown preset "${name}"; available: ${Object.keys(table).join(', ')}`)
    }
    this.activeOverride = name
    try {
      await this.persist(table, name, false)
    } catch (error) {
      this.activeOverride = undefined
      throw error
    }
  }

  /**
   * Switch the selection for a synchronous command handler: the override
   * applies before the (async) persistence settles, so the next call is judged
   * under the new preset.
   * @param name - the preset to activate.
   */
  private switchPresetForCommand(name: string): void {
    const { table } = this.state()
    this.activeOverride = name
    void this.persist(table, name, false).then(
      () => undefined,
      (error: unknown) => {
        this.activeOverride = undefined
        this.ctx.logger.warn(`dsh-custom-permission: failed to persist preset selection: ${errorMessage(error)}`)
      },
    )
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
  async switchPresetRemote(name: string): Promise<PresetListView> {
    await this.switchPreset(name)
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
    const { table } = this.state()
    const spec = table[name]
    if (spec === undefined) {
      throw new Error(`dsh-custom-permission: unknown preset "${name}"; available: ${Object.keys(table).join(', ')}`)
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
    const { table } = this.state()
    const target = validatePresetName(name, new Set(Object.keys(table)))
    const typed = coercePresetSpec(spec)
    try {
      compilePreset(typed, this.config.cwd)
    } catch (error) {
      throw new Error(`preset spec for "${target}" is invalid: ${errorMessage(error)}`)
    }
    const next = { ...table, [target]: typed }
    await this.persist(next, target, true)
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
    const { table, name: activeName } = this.state()
    if (!Object.hasOwn(table, name)) {
      throw new Error(`dsh-custom-permission: unknown preset "${name}"; available: ${Object.keys(table).join(', ')}`)
    }
    const target = validatePresetName(renameTo, new Set(Object.keys(table)), name)
    const typed = coercePresetSpec(spec)
    try {
      compilePreset(typed, this.config.cwd)
    } catch (error) {
      throw new Error(`preset spec for "${target}" is invalid: ${errorMessage(error)}`)
    }
    const next: Record<string, PresetSpec> = {}
    for (const [existing, existingSpec] of Object.entries(table)) {
      next[existing === name ? target : existing] = existingSpec
    }
    next[target] = typed
    const active = activeName === name ? target : activeName
    await this.persist(next, active, true)
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
    const { table, name: activeName } = this.state()
    if (!Object.hasOwn(table, name)) {
      throw new Error(`dsh-custom-permission: unknown preset "${name}"; available: ${Object.keys(table).join(', ')}`)
    }
    if (activeName === name) {
      throw new Error(`cannot delete the active preset "${name}"; switch to another preset first`)
    }
    const names = Object.keys(table)
    if (names.length <= 1) {
      throw new Error('cannot delete the last preset')
    }
    const next: Record<string, PresetSpec> = {}
    for (const [existing, spec] of Object.entries(table)) {
      if (existing !== name) next[existing] = spec
    }
    await this.persist(next, activeName, true)
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
      const { table } = this.state()
      if (!Object.hasOwn(table, name)) {
        return { kind: 'error', text: `unknown preset "${name}"; available: ${Object.keys(table).join(', ')}` }
      }
      this.switchPresetForCommand(name)
      return { kind: 'success', text: `switched to preset "${name}"` }
    }
    return { kind: 'error', text: 'usage: /custom-permission [preset <name> | presets]' }
  }

  /** The preset names and the active one, for `/custom-permission presets`. */
  private listPresets(): string {
    const { table, name } = this.state()
    const marker = (presetName: string): string => presetName === name ? `${presetName} (active)` : presetName
    return `available presets: ${Object.keys(table).map(marker).join(', ')}`
  }

  /** Read-only summary of the active preset, rendered by the `/custom-permission` command. */
  private summarize(): string {
    const { table, name } = this.state()
    const spec = table[name]
    const lines = [`dsh-custom-permission: active preset "${name}"`, this.listPresets()]
    const allowRules = spec?.allowRules ?? []
    const denyRules = spec?.denyRules ?? []
    const allowApprovals = spec?.allowApprovals ?? []
    const { current } = this.state()
    lines.push('', 'allow rules:')
    lines.push(...(allowRules.length === 0 ? ['  (none)'] : allowRules.map((rule, index) => '  ' + describeRule(rule, index))))
    lines.push('', 'deny rules:')
    lines.push(...(denyRules.length === 0 ? ['  (none)'] : denyRules.map((rule, index) => '  ' + describeRule(rule, index))))
    lines.push('', `auto-allowed approval tools: ${allowApprovals.length === 0 ? '(none)' : allowApprovals.join(', ')}`)
    lines.push('', `extra writable roots: ${current.extraRoots.length === 0 ? '(none)' : current.extraRoots.map(root => `"${root}"`).join(', ')}`)
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
      for (const root of this.state().current.extraRoots) {
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
