/**
 * dsh-custom-permission, browser half: the composer button that opens the
 * permission-preset panel. The button renders in `conversation.input.right`;
 * the panel renders in `conversation.input.overlay` and lists every configured
 * preset with its rules (served by the plugin's own `customPermission` Remote
 * namespace), switches the process-level selection through it, and surfaces
 * errors with a fix-the-yml hint. A quick-add button sits in the panel as a
 * placeholder — it does not open the configuration file yet.
 * @module dsh-custom-permission/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the slot declarations, the locale merge, the `remote`
// Context merge, the `ctx.slots` registry typing, and the `customPermission`
// namespace augmentation into this program — no runtime edges to those
// packages.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { PermissionButton } from './PermissionButton.tsx'
import type { PermissionButtonProps } from './PermissionButton.tsx'
import { PermissionPanel } from './PermissionPanel.tsx'
import type { PermissionPanelProps } from './PermissionPanel.tsx'
import { en, zh } from './locales.ts'
import type { PermissionKey } from './locales.ts'
import { CUSTOM_PERMISSION_REMOTE } from './remote.ts'
import type { CustomPermissionRemote } from './remote.ts'
import { createPanelController } from './store.ts'

/** Locale namespace owned by this plugin. */
const NS = 'custom-permission'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'custom-permission': PermissionKey
  }
}

/**
 * Required services: the client Remote, the slot system, and the locale
 * registry. The `customPermission` namespace is NOT injected: this plugin
 * mounts it itself in `apply`, so injecting it would deadlock activation;
 * the controller reads it with `ctx.get` after the mount settles.
 */
export const inject = ['remote', 'slots', 'locale']

/**
 * Client plugin body: mount the `customPermission` Remote namespace, register
 * the dictionaries, then mount the composer button and the preset panel once
 * the conversation slots are declared. Both registers share one controller
 * whose state source rides the inject `hooks` compartment, so the button and
 * the panel stay in sync without a cross-slot store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const mounted = ctx.remote.$mount(CUSTOM_PERMISSION_REMOTE)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-custom-permission: dictionaries')
  const controller = createPanelController(async () => {
    await mounted
    return (ctx as unknown as { get(name: string): unknown }).get('remote.customPermission') as unknown as CustomPermissionRemote
  })
  ctx.inject(['slots'], (scope: ClientContext) => {
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'custom-permission-button',
      locale: NS,
      inject: () => ({
        toggle: controller.toggle,
        close: controller.close,
        switchTo: controller.switchTo,
        quickAdd: controller.quickAdd,
        hooks: { panel: controller.source },
      }),
    }, PermissionButton as unknown as (props: PermissionButtonProps) => ReturnType<typeof PermissionButton>))
    scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
      name: 'conversation.input.overlay',
      id: 'custom-permission-panel',
      order: 50,
      locale: NS,
      inject: () => ({
        toggle: controller.toggle,
        close: controller.close,
        switchTo: controller.switchTo,
        quickAdd: controller.quickAdd,
        hooks: { panel: controller.source },
      }),
    }, PermissionPanel as unknown as (props: PermissionPanelProps) => ReturnType<typeof PermissionPanel>))
  })
}
