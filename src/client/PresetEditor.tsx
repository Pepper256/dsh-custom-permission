/**
 * The preset editor dialog: name field plus the four permission knobs (allow
 * rules, deny rules, auto-approve tools, extra writable roots). Rule rows
 * carry a tool-name pattern and optional per-field matcher conditions; deny
 * rows add a model-visible reason. Every keystroke commits an immutable
 * {@link PresetDraft} through the controller, so Cancel discards nothing and
 * Save validates client-side first (the Host re-validates authoritatively).
 * @module dsh-custom-permission/client/PresetEditor
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PermissionKey } from './locales.ts'
import type {
  MatcherDraftCondition,
  PresetDraft,
  RuleDraft,
  UsePanel,
} from './store.ts'

/** The editor's injected face: editor actions plus the shared state source. */
export interface PresetEditorFace {
  readonly closeEditor: () => void
  readonly editorSetName: (name: string) => void
  readonly editorSetDraft: (draft: PresetDraft) => void
  readonly saveEditor: () => void
  readonly usePanel: UsePanel
}

/** Full editor props: injected face plus the locale seat. */
export type PresetEditorProps = PresetEditorFace & PropsLocale<'custom-permission'>

/** Which rule section a row belongs to. */
type RuleKind = 'allowRules' | 'denyRules'

/** Locale accessor shape shared by the sub-renderers. */
type Translator = (key: PermissionKey, params?: Record<string, string>) => string

const OVERLAY_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgb(0 0 0 / 0.35)',
}

const CARD_STYLE: CSSProperties = {
  width: 'min(560px, calc(100vw - 32px))',
  maxHeight: 'min(640px, calc(100vh - 48px))',
  overflowY: 'auto',
  background: 'var(--dsw-surface, #fff)',
  color: 'var(--dsw-text, #1f2328)',
  border: '1px solid var(--dsw-border, #d0d7de)',
  borderRadius: 10,
  boxShadow: '0 8px 32px rgb(0 0 0 / 0.28)',
  padding: 12,
  fontSize: 13,
  lineHeight: 1.5,
  textAlign: 'left',
}

const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '3px 6px',
  border: '1px solid var(--dsw-border, #d0d7de)',
  borderRadius: 4,
  background: 'var(--dsw-surface-input, #fff)',
  color: 'inherit',
  fontSize: 12,
}

const buttonStyle: CSSProperties = {
  padding: '4px 10px',
  borderRadius: 4,
  border: '1px solid var(--dsw-border, #d0d7de)',
  background: 'var(--dsw-surface, #fff)',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
}

const smallButtonStyle: CSSProperties = {
  ...buttonStyle,
  padding: '1px 6px',
  fontSize: 11,
  opacity: 0.85,
}

/** A fresh empty rule row (one row per tool pattern). */
function emptyRule(): RuleDraft {
  return { tool: '', conditions: [] }
}

/** The preset editor dialog; renders nothing while no editor is open. */
export function PresetEditor(props: PresetEditorProps & Record<string, unknown>): ReactElement | null {
  const { closeEditor, editorSetName, editorSetDraft, saveEditor, usePanel, t } = props
  const editor = usePanel(state => state.editor)
  if (editor === null) return null
  const { draft } = editor
  const update = (next: PresetDraft): void => editorSetDraft(next)
  const titleKey: PermissionKey = editor.mode === 'create' ? 'editor.title.create' : 'editor.title.edit'
  const saveKey: PermissionKey = editor.mode === 'create' ? 'editor.save.create' : 'editor.save.edit'

  return (
    <div style={OVERLAY_STYLE} onClick={() => closeEditor()}>
      <div role="dialog" aria-label={t(titleKey)} style={CARD_STYLE} onClick={event => event.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>{t(titleKey)}</strong>
          <button type="button" onClick={() => closeEditor()} aria-label={t('panel.close')} style={{ ...buttonStyle, border: 'none', background: 'transparent', fontSize: 14 }}>✕</button>
        </div>

        <label style={{ display: 'block', marginBottom: 8 }}>
          <span style={{ opacity: 0.8, marginRight: 6 }}>{t('editor.name')}</span>
          <input
            type="text"
            value={editor.draftName}
            disabled={editor.busy}
            onChange={event => editorSetName(event.target.value)}
            placeholder={t('editor.name.placeholder')}
            style={inputStyle}
          />
        </label>

        <Section title={t('editor.allow')}>
          <RuleRows draft={draft} kind="allowRules" deny={false} update={update} t={t} />
        </Section>
        <Section title={t('editor.deny')}>
          <RuleRows draft={draft} kind="denyRules" deny update={update} t={t} />
        </Section>
        <Section title={t('editor.approvals')}>
          {draft.allowApprovals.length === 0 && <EmptyHint text={t('panel.none')} />}
          {draft.allowApprovals.map((value, index) => (
            <Row key={index} removeAria={t('editor.remove')} onRemove={() => update({ ...draft, allowApprovals: draft.allowApprovals.filter((_, at) => at !== index) })}>
              <input
                type="text"
                value={value}
                disabled={editor.busy}
                onChange={event => update({ ...draft, allowApprovals: draft.allowApprovals.map((entry, at) => at === index ? event.target.value : entry) })}
                placeholder={t('editor.approval.placeholder')}
                style={inputStyle}
              />
            </Row>
          ))}
          <AddButton label={t('editor.approval.add')} onClick={() => update({ ...draft, allowApprovals: [...draft.allowApprovals, ''] })} />
        </Section>
        <Section title={t('editor.roots')}>
          {draft.extraWritableRoots.length === 0 && <EmptyHint text={t('panel.none')} />}
          {draft.extraWritableRoots.map((value, index) => (
            <Row key={index} removeAria={t('editor.remove')} onRemove={() => update({ ...draft, extraWritableRoots: draft.extraWritableRoots.filter((_, at) => at !== index) })}>
              <input
                type="text"
                value={value}
                disabled={editor.busy}
                onChange={event => update({ ...draft, extraWritableRoots: draft.extraWritableRoots.map((entry, at) => at === index ? event.target.value : entry) })}
                placeholder={t('editor.root.placeholder')}
                style={inputStyle}
              />
            </Row>
          ))}
          <AddButton label={t('editor.root.add')} onClick={() => update({ ...draft, extraWritableRoots: [...draft.extraWritableRoots, ''] })} />
        </Section>

        {editor.error !== null && (
          <div style={{ marginTop: 8, padding: '6px 8px', borderRadius: 4, color: 'var(--dsw-error, #cf222e)', background: 'rgb(207 34 46 / 0.08)', wordBreak: 'break-word' }}>
            {t('editor.error')}: {editor.error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}>
          <button type="button" onClick={() => closeEditor()} disabled={editor.busy} style={buttonStyle}>
            {t('editor.cancel')}
          </button>
          <button
            type="button"
            onClick={() => saveEditor()}
            disabled={editor.busy}
            style={{ ...buttonStyle, background: 'var(--dsw-accent, #4f8cff)', borderColor: 'var(--dsw-accent, #4f8cff)', color: '#fff', fontWeight: 600 }}
          >
            {editor.busy ? t('editor.busy') : t(saveKey)}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One labeled section with a hairline separator. */
function Section(props: { readonly title: string; readonly children: ReactNode }): ReactElement {
  const { title, children } = props
  return (
    <fieldset style={{ border: 'none', margin: '6px 0 0', padding: '6px 0 0', borderTop: '1px solid var(--dsw-border, #d0d7de)' }}>
      <legend style={{ padding: '0 4px 0 0', fontSize: 12, opacity: 0.85 }}>{title}</legend>
      {children}
    </fieldset>
  )
}

/** A pale "nothing here" line for an empty list section. */
function EmptyHint(props: { readonly text: string }): ReactElement {
  return <div style={{ opacity: 0.55, margin: '2px 0' }}>{props.text}</div>
}

/** A row with a remove button on the right. */
function Row(props: { readonly removeAria: string; readonly onRemove: () => void; readonly children: ReactNode }): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '2px 0' }}>
      <div style={{ flex: 1, minWidth: 0 }}>{props.children}</div>
      <button type="button" onClick={props.onRemove} aria-label={props.removeAria} title={props.removeAria} style={smallButtonStyle}>✕</button>
    </div>
  )
}

/** A full-width "add" button under a section. */
function AddButton(props: { readonly label: string; readonly onClick: () => void }): ReactElement {
  return (
    <button type="button" onClick={props.onClick} style={{ ...smallButtonStyle, width: '100%', padding: '2px 6px', marginTop: 2 }}>
      {props.label}
    </button>
  )
}

/** The allow/deny rule editors: one row per rule, each with tool + conditions. */
function RuleRows(props: {
  readonly draft: PresetDraft
  readonly kind: RuleKind
  readonly deny: boolean
  readonly update: (draft: PresetDraft) => void
  readonly t: Translator
}): ReactElement {
  const { draft, kind, deny, update, t } = props
  const rules = draft[kind]
  const patchRule = (ruleIndex: number, patch: (rule: RuleDraft) => RuleDraft): void => {
    update({ ...draft, [kind]: rules.map((rule, at) => at === ruleIndex ? patch(rule) : rule) })
  }
  return (
    <>
      {rules.map((rule, ruleIndex) => (
        <div key={ruleIndex} style={{ border: '1px solid var(--dsw-border, #d0d7de)', borderRadius: 6, padding: 4, margin: '4px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="text"
              value={rule.tool}
              onChange={event => patchRule(ruleIndex, current => ({ ...current, tool: event.target.value }))}
              placeholder={t('editor.rule.toolPlaceholder')}
              style={inputStyle}
            />
            <button type="button" aria-label={t('editor.rule.remove')} title={t('editor.rule.remove')} onClick={() => update({ ...draft, [kind]: rules.filter((_, at) => at !== ruleIndex) })} style={smallButtonStyle}>✕</button>
          </div>
          {rule.conditions.map((condition, conditionIndex) => (
            <div key={conditionIndex} style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
              <input
                type="text"
                value={condition.field}
                onChange={event => patchRule(ruleIndex, current => ({ ...current, conditions: replaceCondition(current.conditions, conditionIndex, { ...condition, field: event.target.value }) }))}
                placeholder={t('editor.condition.fieldPlaceholder')}
                style={{ ...inputStyle, width: '32%' }}
              />
              <select
                value={condition.type}
                onChange={event => patchRule(ruleIndex, current => ({ ...current, conditions: replaceCondition(current.conditions, conditionIndex, { ...condition, type: event.target.value as MatcherDraftCondition['type'] }) }))}
                style={{ ...inputStyle, width: '26%' }}
              >
                <option value="contains">contains</option>
                <option value="regex">regex</option>
                <option value="prefix">prefix</option>
                <option value="glob">glob</option>
              </select>
              <input
                type="text"
                value={condition.value}
                onChange={event => patchRule(ruleIndex, current => ({ ...current, conditions: replaceCondition(current.conditions, conditionIndex, { ...condition, value: event.target.value }) }))}
                placeholder={t('editor.condition.valuePlaceholder')}
                style={inputStyle}
              />
              <button
                type="button"
                aria-label={t('editor.condition.remove')}
                title={t('editor.condition.remove')}
                onClick={() => patchRule(ruleIndex, current => ({ ...current, conditions: current.conditions.filter((_, at) => at !== conditionIndex) }))}
                style={smallButtonStyle}
              >✕</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
            <button
              type="button"
              style={smallButtonStyle}
              onClick={() => patchRule(ruleIndex, current => ({ ...current, conditions: [...current.conditions, { field: 'command', type: 'contains', value: '' }] }))}
            >
              {t('editor.condition.add')}
            </button>
            {deny && (
              <input
                type="text"
                value={rule.reason ?? ''}
                onChange={event => patchRule(ruleIndex, current => ({ ...current, reason: event.target.value }))}
                placeholder={t('editor.rule.reasonPlaceholder')}
                style={{ ...inputStyle, flex: 1 }}
              />
            )}
          </div>
        </div>
      ))}
      <AddButton label={t('editor.rule.add')} onClick={() => update({ ...draft, [kind]: [...rules, emptyRule()] })} />
    </>
  )
}

/** Replace one condition inside a rule's condition list (immutable). */
function replaceCondition(
  conditions: readonly MatcherDraftCondition[],
  index: number,
  next: MatcherDraftCondition,
): MatcherDraftCondition[] {
  return conditions.map((condition, at) => at === index ? next : condition)
}
