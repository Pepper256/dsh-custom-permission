/**
 * Rule matching for dsh-custom-permission: one compiled evaluation over
 * tool-name patterns and argument-field conditions, shared verbatim by the
 * pre-execute listener, the monotonic guard, and the approval answerer so
 * the three enforcement sites can never drift. Which table a rule came from
 * (allow vs deny) is the caller's knowledge — each site evaluates exactly
 * the table it enforces.
 * @module dsh-custom-permission/rules
 */

import type { FieldMatcher, RuleSpec } from './config.ts'

/** One matched rule: its position and its model-visible denial text. */
export interface RuleHit {
  /** Zero-based index into the evaluated table (config order). */
  readonly ruleIndex: number
  /** Model-visible denial text (used by deny enforcement; allow sites ignore it). */
  readonly denyReason: string
}

/** Compiled argument-condition: regexes precompiled, literals kept as-is. */
interface CompiledFieldMatcher {
  readonly regex?: RegExp
  readonly prefix?: string
  readonly glob?: RegExp
  readonly contains?: string
}

/** Compiled rule: tool-name predicate plus optional argument conditions. */
export interface CompiledRule {
  /** Whether the tool-name pattern matches. */
  readonly tool: (name: string) => boolean
  /** Argument-field conditions keyed by dotted field path, or none. */
  readonly when?: ReadonlyMap<string, CompiledFieldMatcher>
  /** User-supplied denial text, when the rule carries one. */
  readonly reason?: string
}

const REGEX_PREFIX = 'regex:'
const GLOB_METACHARS = /[*?[\]{}]/

/** Escape a literal for inclusion in a regular expression. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Translate one glob (with `**`, `*`, `?`, `[set]`, `{a,b}`) to an anchored `RegExp`. */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern, 0, pattern.length)}$`)
}

/** Recursive glob-to-regex-source translation over `[start, end)`. */
function globSource(pattern: string, start: number, end: number): string {
  let source = ''
  let i = start
  while (i < end) {
    const char = pattern[i]!
    switch (char) {
      case '*':
        if (pattern[i + 1] === '*') {
          source += '.*'
          i++
        } else {
          source += '[^/]*'
        }
        break
      case '?':
        source += '[^/]'
        break
      case '\\':
        // A backslash escapes the next character literally.
        source += i + 1 < end ? escapeRegex(pattern[i + 1]!) : '\\\\'
        i++
        break
      case '[': {
        // Character class up to the next unescaped `]`; `[!…]` negates like `[^…]`.
        const close = findClassClose(pattern, i + 1, end)
        const inner = pattern.slice(i + 1, close)
        const negated = inner.startsWith('!')
        source += `[${negated ? '^' : ''}${inner.slice(negated ? 1 : 0).replace(/\\/g, '\\\\')}]`
        i = close
        break
      }
      case '{': {
        // Alternation `{a,b}` over top-level commas; alternatives recurse.
        const close = findBraceClose(pattern, i + 1, end)
        const alternatives = splitTopLevel(pattern.slice(i + 1, close))
          .map(alternative => globSource(alternative, 0, alternative.length))
        source += `(?:${alternatives.join('|')})`
        i = close
        break
      }
      default:
        source += escapeRegex(char)
    }
    i++
  }
  return source
}

/** Index of the `]` closing a character class opened at `open`, or throw. */
function findClassClose(pattern: string, open: number, end: number): number {
  for (let i = open; i < end; i++) {
    if (pattern[i] === '\\') {
      i++
    } else if (pattern[i] === ']') {
      return i
    }
  }
  throw new Error(`dsh-custom-permission: unterminated "[" in glob pattern ${JSON.stringify(pattern)}`)
}

/** Index of the `}` closing a brace alternation opened at `open`, or throw. */
function findBraceClose(pattern: string, open: number, end: number): number {
  let depth = 1
  for (let i = open; i < end; i++) {
    if (pattern[i] === '\\') {
      i++
    } else if (pattern[i] === '{') {
      depth++
    } else if (pattern[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error(`dsh-custom-permission: unterminated "{" in glob pattern ${JSON.stringify(pattern)}`)
}

/** Split a brace body on top-level commas (nested braces and classes kept whole). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char === '\\') {
      i++
    } else if (char === '[') {
      const close = findClassClose(body, i + 1, body.length)
      i = close
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
    } else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts
}

/** Compile one tool-name pattern: exact, glob, or `regex:<pattern>`. */
function compileToolPattern(pattern: string): (name: string) => boolean {
  if (pattern.startsWith(REGEX_PREFIX)) {
    const regex = new RegExp(pattern.slice(REGEX_PREFIX.length))
    return name => regex.test(name)
  }
  if (GLOB_METACHARS.test(pattern)) {
    const regex = globToRegExp(pattern)
    return name => regex.test(name)
  }
  return name => name === pattern
}

/** Compile one argument-field matcher; an invalid glob fails at load. */
function compileFieldMatcher(matcher: FieldMatcher): CompiledFieldMatcher {
  return {
    ...matcher.regex !== undefined ? { regex: matcher.regex } : {},
    ...matcher.prefix !== undefined ? { prefix: matcher.prefix } : {},
    ...matcher.glob !== undefined ? { glob: globToRegExp(matcher.glob) } : {},
    ...matcher.contains !== undefined ? { contains: matcher.contains } : {},
  }
}

/**
 * Compile a rule table, failing loudly on invalid regex or glob patterns so a
 * misconfigured rule can never silently match nothing.
 * @param rules - the configured rule table in evaluation order.
 * @returns the compiled rules for {@link evaluateRules}.
 */
export function compileRules(rules: readonly RuleSpec[]): CompiledRule[] {
  return rules.map(rule => {
    const when = rule.when === undefined
      ? undefined
      : new Map(Object.entries(rule.when).map(([field, matcher]) => [field, compileFieldMatcher(matcher)]))
    return {
      tool: compileToolPattern(rule.tool),
      ...rule.reason !== undefined ? { reason: rule.reason } : {},
      ...when !== undefined ? { when } : {},
    }
  })
}

/** Read one dotted field path from parsed tool arguments. */
export function fieldValue(args: unknown, path: string): unknown {
  let current: unknown = args
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Whether every condition in one compiled matcher matches the field value. */
function matchField(matcher: CompiledFieldMatcher, value: unknown): boolean {
  if (typeof value !== 'string') return false
  return (matcher.regex === undefined || matcher.regex.test(value))
    && (matcher.prefix === undefined || value.startsWith(matcher.prefix))
    && (matcher.glob === undefined || matcher.glob.test(value))
    && (matcher.contains === undefined || value.includes(matcher.contains))
}

/** Whether every listed field condition matches the arguments (an empty `when` matches anything). */
function matchWhen(when: ReadonlyMap<string, CompiledFieldMatcher>, args: unknown): boolean {
  for (const [field, matcher] of when) {
    if (!matchField(matcher, fieldValue(args, field))) return false
  }
  return true
}

/** Default model-visible denial text for a deny hit. */
export function defaultDenyReason(toolName: string, ruleIndex: number): string {
  return `blocked by dsh-custom-permission rule #${ruleIndex + 1} (tool "${toolName}")`
}

/**
 * Evaluate one compiled rule table against a tool call. The first rule whose
 * tool pattern and argument conditions both match wins; later rules are not
 * consulted.
 * @param rules - the compiled table in evaluation order.
 * @param toolName - the called tool's name.
 * @param args - the losslessly parsed tool arguments.
 * @returns the winning rule, or `undefined` when none matches.
 */
export function evaluateRules(
  rules: readonly CompiledRule[],
  toolName: string,
  args: unknown,
): RuleHit | undefined {
  for (const [index, rule] of rules.entries()) {
    if (!rule.tool(toolName)) continue
    if (rule.when !== undefined && !matchWhen(rule.when, args)) continue
    return {
      ruleIndex: index,
      denyReason: rule.reason ?? defaultDenyReason(toolName, index),
    }
  }
  return undefined
}
