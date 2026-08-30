/**
 * The model-visible runtime-context contribution naming the extra writable
 * roots, so the model knows which paths outside the session workspace the
 * filesystem tools may also write. Registered through `ctx.systemPrompt.context`
 * (the same cache-safe mechanism as `sandbox:policy`); an empty root list
 * contributes nothing.
 * @module dsh-custom-permission/context
 */

/** The registered contribution's stable name (duplicate registration throws). */
export const EXTRA_ROOTS_CONTEXT_NAME = 'custom-permission:extra-roots'

/** Placement after `sandbox:policy` (order 110) in the ascending context order. */
export const EXTRA_ROOTS_CONTEXT_ORDER = 120

/**
 * Render the stable context sentence, or an empty string when no extra roots
 * are configured (an empty contribution adds no model tokens).
 * @param roots - the canonicalized extra writable roots.
 * @returns the model-visible sentence listing the roots.
 */
export function renderExtraRootsContext(roots: readonly string[]): string {
  if (roots.length === 0) return ''
  return 'Custom permission policy (dsh-custom-permission): the following paths outside the session workspace are also writable: '
    + roots.map(root => `"${root}"`).join(', ') + '.'
}
