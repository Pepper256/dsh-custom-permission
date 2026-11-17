/**
 * Plugin configuration for dsh-custom-permission: the named preset table plus
 * the active preset name, both persisted as the plugin's own profile config.
 *
 * The two runtime-editable fields are schemastery `volatile()`: the Loader
 * commits their new values into the running plugin's references without
 * remounting it, and dsh-settings can write them through the active profile
 * patch. The table is the single source of truth — the composition patch seeds
 * it, runtime edits replace it wholesale, and a missing `default` entry fails
 * the load (never falling back to another preset).
 * @module dsh-custom-permission/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * One runtime-editable config field. The Loader hands a live reference
 * (`{ get }`) to a running plugin; plain values are accepted for direct
 * construction in tests.
 */
export type MaybeVolatile<T> = T | { get(): T }

/** Read one config field, whether it is a Loader volatile reference or a plain value. */
export function readVolatile<T>(value: MaybeVolatile<T>): T {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get(): T }).get()
    : value as T
}

/** One string condition on one argument field; every declared key must match. */
export interface FieldMatcher {
  /**
   * JavaScript regular expression (unescaped search). Config values are
   * JSON-shaped, so the composition and the editor supply the pattern source
   * as a string; the policy compiles it (and rejects an invalid pattern)
   * when the preset table is loaded.
   */
  regex?: string | RegExp
  /** Literal prefix the string must start with. */
  prefix?: string
  /** Glob (`*`, `**`, `?`, `[set]`, `{a,b}`) the whole string must match. */
  glob?: string
  /** Literal substring the string must contain. */
  contains?: string
}

/**
 * One matcher with at least one condition. The `regex` field stays a plain
 * string in the schema because volatile config values must be JSON-shaped
 * (a `RegExp` instance is rejected by the Loader); an invalid pattern fails
 * loud when the preset is compiled.
 */
export const FieldMatcher: z<FieldMatcher> = z.transform(
  z.object({
    regex: z.string(),
    prefix: z.string(),
    glob: z.string(),
    contains: z.string(),
  }),
  (value) => {
    if (Object.keys(value).length === 0) {
      throw new Error('dsh-custom-permission: a field matcher must declare at least one of regex, prefix, glob, contains')
    }
    return value
  },
  true,
) as unknown as z<FieldMatcher>

/** One allow/deny rule: a tool-name pattern plus optional argument conditions. */
export interface RuleSpec {
  /**
   * Tool-name pattern. Exact name, glob (e.g. `fs_*`), or `regex:<pattern>`
   * for a JavaScript regular expression.
   */
  tool: string
  /**
   * Argument-field conditions keyed by dotted field path (e.g. `command` for
   * the bash/pwsh command text, `path` for filesystem targets). Every listed
   * field must match; fields absent from the call never match.
   */
  when?: Record<string, FieldMatcher>
  /** Model-visible denial text; overrides the numbered default for deny rules. */
  reason?: string
}

/** Schema for one rule: `when` maps arbitrary field paths to matchers. */
export const RuleSpec: z<RuleSpec> = z.object({
  tool: z.string(),
  when: z.dict(FieldMatcher),
  reason: z.string(),
}) as unknown as z<RuleSpec>

/** One named permission preset: the four knobs, each defaulting to empty. */
export interface Preset {
  /** Allow rules; a matching tool call short-circuits to `allow` before hooks. */
  allowRules?: RuleSpec[]
  /** Deny rules; a matching tool call is denied before approval and again by the monotonic guard. */
  denyRules?: RuleSpec[]
  /** Tool-level auto-grants: every ask for these tools resolves `allowed-once`, including sandbox escalation asks. */
  allowApprovals?: string[]
  /** Extra paths the filesystem fence admits for writes under `workspace-write`. */
  extraWritableRoots?: string[]
}

/** Schema for one preset; fields are optional in input and default to empty lists. */
export const Preset: z<Preset> = z.object({
  allowRules: z.array(RuleSpec).default([]),
  denyRules: z.array(RuleSpec).default([]),
  allowApprovals: z.array(z.string()).default([]),
  extraWritableRoots: z.array(z.string()).default([]),
}) as unknown as z<Preset>

/**
 * JSON wire form of one argument-field matcher, as Remote get/create/update
 * carry it: every value is a plain string (a `regex` source, never a `RegExp`
 * instance) so the payload survives JSON.
 */
export interface FieldMatcherWire {
  /** JavaScript regular-expression source (unescaped search). */
  regex?: string
  /** Literal prefix the string must start with. */
  prefix?: string
  /** Glob (`*`, `**`, `?`, `[set]`, `{a,b}`) the whole string must match. */
  glob?: string
  /** Literal substring the string must contain. */
  contains?: string
}

/** JSON wire form of one rule: same shape as {@link RuleSpec}, regexes as sources. */
export interface RuleSpecWire {
  /** Tool-name pattern: exact name, glob, or `regex:<pattern>`. */
  tool: string
  /** Argument-field conditions keyed by dotted field path. */
  when?: Record<string, FieldMatcherWire>
  /** Model-visible denial text for deny rules. */
  reason?: string
}

/** JSON wire form of one preset spec, carried by the Remote editor endpoints. */
export interface PresetSpecWire {
  /** Allow rules; a matching tool call short-circuits to `allow` before hooks. */
  allowRules: RuleSpecWire[]
  /** Deny rules; a matching tool call is denied before approval and again by the monotonic guard. */
  denyRules: RuleSpecWire[]
  /** Tool-level auto-grants: every ask for these tools resolves `allowed-once`. */
  allowApprovals: string[]
  /** Extra paths the filesystem fence admits for writes under `workspace-write`. */
  extraWritableRoots: string[]
}

/** Schema for the preset table, keyed by preset name. */
export const Presets: z<Record<string, Preset>> = z.dict(Preset) as unknown as z<Record<string, Preset>>
