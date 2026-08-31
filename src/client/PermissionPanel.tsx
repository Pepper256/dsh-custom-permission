/**
 * The permission-preset panel: lists every configured preset, marks the active
 * one, switches on selection, and surfaces errors with a fix-the-yml hint.
 * Rendered in the `conversation.input.overlay` slot; renders nothing while
 * closed. A quick-add button sits at the bottom (placeholder only — it does
 * not open the configuration file yet).
 * @module dsh-custom-permission/client/PermissionPanel
 */

import type { CSSProperties, ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UsePanel } from './store.ts'

/** The panel's injected face: actions plus the shared state source. */
export interface PermissionPanelFace {
  readonly close: () => void
  readonly switchTo: (name: string) => void
  readonly quickAdd: () => void
  readonly usePanel: UsePanel
}

/** Full panel props: injected face plus the locale seat. */
export type PermissionPanelProps = PermissionPanelFace & PropsLocale<'custom-permission'>

const PANEL_STYLE: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 6px)',
  right: 0,
  zIndex: 20,
  minWidth: 240,
  maxWidth: 320,
  background: 'var(--dsw-surface, #fff)',
  color: 'var(--dsw-text, #1f2328)',
  border: '1px solid var(--dsw-border, #d0d7de)',
  borderRadius: 8,
  boxShadow: '0 4px 16px rgb(0 0 0 / 0.18)',
  padding: 8,
  fontSize: 13,
  lineHeight: 1.5,
  textAlign: 'left',
}

/** The permission-preset panel; null while closed. */
export function PermissionPanel(props: PermissionPanelProps & Record<string, unknown>): ReactElement | null {
  const { close, switchTo, quickAdd, usePanel, t } = props
  const panel = usePanel(state => state)
  if (!panel.open) return null
  return (
    <div role="dialog" aria-label={t('panel.title')} style={PANEL_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong>{t('panel.title')}</strong>
        <button type="button" onClick={() => close()} aria-label={t('panel.close')} style={closeButtonStyle}>
          ✕
        </button>
      </div>
      {panel.status === 'loading' && <div style={{ padding: '4px 0' }}>{t('panel.loading')}</div>}
      {panel.status === 'error' && (
        <div style={{ padding: '4px 0', color: 'var(--dsw-error, #cf222e)' }}>
          <div>{t('panel.error')}</div>
          {panel.error !== null && <div style={{ opacity: 0.8, wordBreak: 'break-word' }}>{t('panel.error.detail', { detail: panel.error })}</div>}
        </div>
      )}
      {panel.status === 'ready' && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {panel.presets.length === 0
            ? <li style={{ padding: '4px 0', opacity: 0.8 }}>{t('panel.empty')}</li>
            : panel.presets.map(name => (
              <li key={name} style={{ margin: '2px 0' }}>
                <button
                  type="button"
                  onClick={() => switchTo(name)}
                  aria-pressed={name === panel.active}
                  style={{ ...presetButtonStyle, fontWeight: name === panel.active ? 600 : 400 }}
                >
                  <span>{name}</span>
                  {name === panel.active && <span style={{ marginLeft: 8, opacity: 0.7 }}>{t('panel.active')}</span>}
                </button>
              </li>
            ))}
        </ul>
      )}
      <div style={{ borderTop: '1px solid var(--dsw-border, #d0d7de)', marginTop: 6, paddingTop: 6 }}>
        <button type="button" onClick={() => quickAdd()} style={presetButtonStyle}>
          ＋ {t('panel.quickAdd')}
        </button>
        {panel.quickAddHint && <div style={{ padding: '4px 0', opacity: 0.8 }}>{t('panel.quickAddHint')}</div>}
      </div>
    </div>
  )
}

const closeButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 12,
  color: 'inherit',
  opacity: 0.7,
}

const presetButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '4px 6px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 13,
}
