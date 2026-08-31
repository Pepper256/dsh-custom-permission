/**
 * The `/custom-permission` slash command: shows the active preset and rules,
 * lists the presets, and switches the process-level selection. Registered only
 * when a commands registry is composed; the rules themselves stay plugin
 * configuration, and the preset list is the plugin's own config table.
 * @module dsh-custom-permission/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'

/**
 * Register the `/custom-permission` command when `ctx.commands` is composed.
 * @param ctx - the plugin context.
 * @param handle - renders the command's outcome from its raw input
 *   (`''` = summary, `presets` = list, `preset <name>` = switch).
 */
export function applyPermissionCommand(ctx: Context, handle: (rawInput: string) => CommandResult): void {
  ctx.get('commands')?.register({
    name: 'custom-permission',
    description: 'Show or switch permission presets: /custom-permission [preset <name> | presets]',
    handler: ({ rawInput }) => handle(rawInput),
  })
}
