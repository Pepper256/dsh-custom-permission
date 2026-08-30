/**
 * The `/custom-permission` slash command: a read-only summary of the active
 * allow/deny rules and extra writable roots, registered only when a commands
 * registry is composed. The rules themselves stay plugin configuration —
 * live profiles reload them by editing the profile's patch file.
 * @module dsh-custom-permission/command
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Register the `/custom-permission` command when `ctx.commands` is composed.
 * @param ctx - the plugin context.
 * @param summarize - renders the active configuration as display text.
 */
export function applyPermissionCommand(ctx: Context, summarize: () => string): void {
  ctx.get('commands')?.register({
    name: 'custom-permission',
    description: 'Show active auto-allow/auto-deny rules and extra writable roots',
    handler: () => ({ kind: 'success', text: summarize() }),
  })
}
