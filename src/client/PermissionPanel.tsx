/**
 * The permission-preset panel: lists every configured preset with the active
 * one marked, switches on selection, shows the active preset's rules, and
 * offers per-preset edit/delete plus a quick-add action that opens the preset
 * editor dialog (also rendered from here, layered above the panel). Rendered
 * in the `conversation.input.overlay` slot; renders nothing while closed.
 * @module dsh-custom-permission/client/PermissionPanel
 */

import type { CSSProperties, ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PermissionKey } from './locales.ts'
import type { PresetViewEntry } from './remote.ts'
import { PresetEditor } from './PresetEditor.tsx'
import type { PresetDraft, UsePanel } from './store.ts'

/** The panel's injected face: actions plus the shared state source. */
export interface PermissionPanelFace {
  readonly close: () => void
  readonly switchTo: (name: string) => void
  /** Open the create-preset editor (快捷添加). */
  readonly openCreate: () => void
  readonly openEdit: (name: string) => void
  readonly closeEditor: () => void
  readonly editorSetName: (name: string) => void
  readonly editorSetDraft: (draft: PresetDraft) => void
  readonly saveEditor: () => void
  readonly requestDelete: (name: string) => void
  readonly cancelDelete: () => void
  readonly confirmDelete: () => void
  readonly usePanel: UsePanel
}

/** Full panel props: injected face plus the locale seat. */
export type PermissionPanelProps = PermissionPanelFace & PropsLocale<'custom-permission'>

const PANEL_STYLE: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 6px)',
  right: 0,
  zIndex: 20,
  minWidth: 300,
  maxWidth: 400,
  maxHeight: 420,
  overflowY: 'auto',
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
  const {
    close, switchTo, openCreate, openEdit, requestDelete, cancelDelete, confirmDelete,
    usePanel, t,
  } = props
  const panel = usePanel(state => state)
  if (!panel.open) return null
  const active = panel.view?.presets.find(entry => entry.active)
  return (
    <>
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
        {panel.status === 'ready' && panel.view !== null && (
          <>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {panel.view.presets.length === 0
                ? <li style={{ padding: '4px 0', opacity: 0.8 }}>{t('panel.empty')}</li>
                : panel.view.presets.map(entry => (
                  <PresetRow
                    key={entry.name}
                    entry={entry}
                    t={t}
                    pendingDelete={panel.pendingDelete === entry.name}
                    onSwitch={() => switchTo(entry.name)}
                    onEdit={() => openEdit(entry.name)}
                    onDelete={() => requestDelete(entry.name)}
                    onCancelDelete={() => cancelDelete()}
                    onConfirmDelete={() => confirmDelete()}
                  />
                ))}
            </ul>
            {active !== undefined && <PresetDetails entry={active} t={t} />}
          </>
        )}
        <div style={{ borderTop: '1px solid var(--dsw-border, #d0d7de)', marginTop: 6, paddingTop: 6 }}>
          <button type="button" onClick={() => openCreate()} style={presetButtonStyle}>
            ＋ {t('panel.quickAdd')}
          </button>
        </div>
      </div>
      <PresetEditor
        closeEditor={props.closeEditor}
        editorSetName={props.editorSetName}
        editorSetDraft={props.editorSetDraft}
        saveEditor={props.saveEditor}
        usePanel={usePanel}
        t={t}
      />
    </>
  )
}

/** One preset row: switch on the name, edit/delete actions on the right. */
function PresetRow(props: {
  readonly entry: PresetViewEntry
  readonly t: (key: PermissionKey, params?: Record<string, string>) => string
  readonly pendingDelete: boolean
  readonly onSwitch: () => void
  readonly onEdit: () => void
  readonly onDelete: () => void
  readonly onCancelDelete: () => void
  readonly onConfirmDelete: () => void
}): ReactElement {
  const { entry, t, pendingDelete, onSwitch, onEdit, onDelete, onCancelDelete, onConfirmDelete } = props
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: 2, margin: '2px 0' }}>
      <button
        type="button"
        onClick={onSwitch}
        aria-pressed={entry.active}
        title={t('panel.switchTo', { name: entry.name })}
        style={{ ...presetButtonStyle, flex: 1, fontWeight: entry.active ? 600 : 400 }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
        {entry.active && <span style={{ marginLeft: 8, opacity: 0.7, flexShrink: 0 }}>{t('panel.active')}</span>}
      </button>
      <button type="button" onClick={onEdit} aria-label={t('panel.edit', { name: entry.name })} title={t('panel.edit', { name: entry.name })} style={iconButtonStyle}>
        ✎
      </button>
      {pendingDelete ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <button type="button" onClick={onConfirmDelete} style={dangerConfirmStyle}>{t('panel.delete.confirm')}</button>
          <button type="button" onClick={onCancelDelete} aria-label={t('panel.delete.cancel')} style={iconButtonStyle}>✕</button>
        </span>
      ) : (
        <button type="button" onClick={onDelete} aria-label={t('panel.delete', { name: entry.name })} title={t('panel.delete', { name: entry.name })} style={iconButtonStyle}>
          🗑
        </button>
      )}
    </li>
  )
}

/** The active preset's rules, approvals, and extra roots. */
function PresetDetails(props: {
  readonly entry: PresetViewEntry
  readonly t: (key: PermissionKey, params?: Record<string, string>) => string
}): ReactElement {
  const { entry, t } = props
  return (
    <div style={{ borderTop: '1px solid var(--dsw-border, #d0d7de)', marginTop: 6, paddingTop: 6 }}>
      <div style={{ opacity: 0.7, marginBottom: 4 }}>{t('panel.details')}</div>
      <DetailRow label={t('panel.allow')} items={entry.allowRules} none={t('panel.none')} />
      <DetailRow label={t('panel.deny')} items={entry.denyRules} none={t('panel.none')} />
      <DetailRow label={t('panel.approvals')} items={entry.allowApprovals} none={t('panel.none')} />
      <DetailRow label={t('panel.roots')} items={entry.extraWritableRoots} none={t('panel.none')} />
    </div>
  )
}

/** One labeled list row in the details block. */
function DetailRow(props: { readonly label: string; readonly items: readonly string[]; readonly none: string }): ReactElement {
  const { label, items, none } = props
  return (
    <div style={{ margin: '2px 0' }}>
      <span style={{ opacity: 0.7 }}>{label}: </span>
      {items.length === 0 ? <span style={{ opacity: 0.6 }}>{none}</span> : (
        <ul style={{ listStyle: 'none', margin: '2px 0 0', padding: 0 }}>
          {items.map((item, index) => (
            <li key={index} style={{ padding: '1px 0 1px 8px', wordBreak: 'break-word' }}>{item}</li>
          ))}
        </ul>
      )}
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
  minWidth: 0,
  padding: '4px 6px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 13,
}

const iconButtonStyle: CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 13,
  color: 'inherit',
  opacity: 0.75,
  padding: '2px 3px',
  flexShrink: 0,
}

const dangerConfirmStyle: CSSProperties = {
  ...iconButtonStyle,
  color: 'var(--dsw-error, #cf222e)',
  fontWeight: 600,
  border: '1px solid currentColor',
  borderRadius: 4,
  padding: '1px 5px',
  whiteSpace: 'nowrap',
}
