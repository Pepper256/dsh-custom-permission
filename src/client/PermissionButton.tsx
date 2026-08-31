/**
 * The composer button that opens the permission-preset panel. Rendered in the
 * `conversation.input.right` slot; the panel itself renders in the input
 * overlay slot and reads the same state source.
 * @module dsh-custom-permission/client/PermissionButton
 */

import type { CSSProperties, ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsePanel } from './store.ts'

/** The button's injected face: toggle the panel and read its shared state. */
export interface PermissionButtonFace {
  readonly toggle: () => void
  readonly usePanel: UsePanel
}

/** Full button props: injected face plus the locale seat. */
export type PermissionButtonProps = PermissionButtonFace & PropsLocale<'custom-permission'>

/** The composer button; opens (or closes) the preset panel on click. */
export function PermissionButton(props: PermissionButtonProps & Record<string, unknown>): ReactElement {
  const { toggle, usePanel, t } = props
  const panel = usePanel(state => state)
  return (
    <button
      type="button"
      aria-label={t('button.aria')}
      title={t('button.aria')}
      onClick={() => toggle()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        color: panel.open ? 'var(--dsw-accent, #4f8cff)' : 'inherit',
        fontSize: 16,
      } satisfies CSSProperties}
    >
      ⚙
    </button>
  )
}
