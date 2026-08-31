/**
 * Plugin configuration for dsh-custom-permission: the named preset table.
 * Every preset carries the four permission knobs (allow/deny rules,
 * tool-level approval auto-grants, extra writable roots), each defaulting to
 * empty. The `default` preset is required — an absent key fails at load — and
 * may itself be empty; any preset that fails to compile fails the load,
 * never falling back to another preset.
 * @module dsh-custom-permission/config
 */

import z from '@deepseek-ai/schemastery'

/** One string condition on one argument field; every declared key must match. */
export interface FieldMatcher {
  /** JavaScript regular expression the string must match (unescaped search). */
  regex?: RegExp
  /** Literal prefix the string must start with. */
  prefix?: string
  /** Glob (`*`, `**`, `?`, `[set]`, `{a,b}`) the whole string must match. */
  glob?: string
  /** Literal substring the string must contain. */
  contains?: string
}

/**
 * One matcher with at least one condition. `z.regExp()` rejects an invalid
 * pattern at config load, so a typo fails loud instead of silently matching
 * nothing. `z.object` fields are optional by construction.
 */
export const FieldMatcher = z.transform(
  z.object({
    regex: z.regExp(),
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
)

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
export const RuleSpec = z.object({
  tool: z.string(),
  when: z.dict(FieldMatcher),
  reason: z.string(),
})

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
export const Preset = z.object({
  allowRules: z.array(RuleSpec).default([]),
  denyRules: z.array(RuleSpec).default([]),
  allowApprovals: z.array(z.string()).default([]),
  extraWritableRoots: z.array(z.string()).default([]),
})

/** Plugin config: the named preset table; `default` is required and may be empty. */
export interface PluginConfig {
  presets: Record<string, Preset>
}

/**
 * Schema for the preset table. The `default` key is mandatory — using the
 * plugin requires an explicit default, even when it is empty — and every
 * preset's rules are validated only when compiled (see the plugin constructor).
 */
export const PluginConfig = z.transform(
  z.object({
    presets: z.dict(Preset),
  }),
  (value) => {
    if (value.presets?.default === undefined) {
      throw new Error('dsh-custom-permission: presets.default is required (its four fields may be empty)')
    }
    return value
  },
  true,
)
