/**
 * Preset-panel state and the `customPermission` Remote bridge, browser half.
 * Pure logic with no React/Cordis runtime imports: the panel lists every
 * configured preset, switches the process-level selection, and drives the
 * create/edit/delete editor through the mounted Remote namespace. Remote
 * rejections and unknown presets surface with their message.
 * @module dsh-custom-permission/client/store
 */

import type {
  CustomPermissionRemote,
  FieldMatcherWire,
  PresetListView,
  PresetSpecWire,
  RuleSpecWire,
} from './remote.ts'

/** Minimal observable snapshot source the slot `hooks` compartment accepts. */
export interface PanelSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** One editor condition: a matcher kind applied to one argument field. */
export interface MatcherDraftCondition {
  /** Dotted argument-field path (e.g. `command` for bash/pwsh). */
  field: string
  /** Which matcher kind the value is interpreted as. */
  type: 'contains' | 'regex' | 'prefix' | 'glob'
  /** The matcher value. */
  value: string
}

/** One rule row in the editor: a tool pattern plus optional field conditions. */
export interface RuleDraft {
  /** Tool-name pattern: exact name, glob, or `regex:<pattern>`. */
  tool: string
  /** Model-visible denial text (deny rules only). */
  reason?: string
  /** Field conditions (each on its own field/matcher-kind line). */
  conditions: MatcherDraftCondition[]
}

/** The editor's working copy of one preset's four permission knobs. */
export interface PresetDraft {
  readonly allowRules: readonly RuleDraft[]
  readonly denyRules: readonly RuleDraft[]
  readonly allowApprovals: readonly string[]
  readonly extraWritableRoots: readonly string[]
}

/** The editor's open state; `null` while no editor is open. */
export interface EditorState {
  readonly mode: 'create' | 'edit'
  /** The preset being edited ('' while creating). */
  readonly originalName: string
  /** The preset's name as typed in the editor (rename target while editing). */
  readonly draftName: string
  readonly draft: PresetDraft
  /** Whether a save or prefill fetch is in flight. */
  readonly busy: boolean
  /** Last editor-scoped failure, rendered inside the dialog. */
  readonly error: string | null
}

/** The panel's renderable state. */
export interface PanelState {
  readonly open: boolean
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly view: PresetListView | null
  readonly error: string | null
  /** The open editor, when one is up. */
  readonly editor: EditorState | null
  /** The preset row awaiting delete confirmation. */
  readonly pendingDelete: string | null
}

const EMPTY_DRAFT: PresetDraft = { allowRules: [], denyRules: [], allowApprovals: [], extraWritableRoots: [] }

const INITIAL_STATE: PanelState = {
  open: false,
  status: 'idle',
  view: null,
  error: null,
  editor: null,
  pendingDelete: null,
}

/** Best-effort message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A tiny writable observable source (same reference until a change commits). */
function createPanelSource(): { source: PanelSource<PanelState>; set(patch: Partial<PanelState>): void } {
  let state: PanelState = INITIAL_STATE
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    set: (patch) => {
      state = { ...state, ...patch }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Unwrap one Remote result; rejections and business errors throw their message. */
function unwrap<T>(response: { readonly ok: boolean; readonly value?: T; readonly error?: { readonly message: string } }): T {
  if (!response.ok) throw new Error(response.error?.message ?? 'remote call failed')
  return response.value as T
}

/** Validate a preset name client-side (the Host re-validates authoritatively). */
function validateEditorName(raw: string, taken: ReadonlySet<string>, exempt?: string): string {
  if (raw === '' || /\s/.test(raw) || raw.length > 64) {
    throw new Error('preset name must be non-empty, contain no whitespace, and be at most 64 characters')
  }
  if (raw !== exempt && taken.has(raw)) {
    throw new Error(`a preset named "${raw}" already exists`)
  }
  return raw
}

/** One matcher to its editor conditions (one per declared kind). */
function matcherToConditions(when: Record<string, FieldMatcherWire>): MatcherDraftCondition[] {
  const conditions: MatcherDraftCondition[] = []
  for (const [field, matcher] of Object.entries(when)) {
    if (matcher.contains !== undefined) conditions.push({ field, type: 'contains', value: matcher.contains })
    if (matcher.regex !== undefined) conditions.push({ field, type: 'regex', value: matcher.regex })
    if (matcher.prefix !== undefined) conditions.push({ field, type: 'prefix', value: matcher.prefix })
    if (matcher.glob !== undefined) conditions.push({ field, type: 'glob', value: matcher.glob })
  }
  return conditions
}

/** One rule wire to its editor row. */
function ruleToDraft(rule: RuleSpecWire): RuleDraft {
  const draft: RuleDraft = { tool: rule.tool, conditions: rule.when === undefined ? [] : matcherToConditions(rule.when) }
  if (rule.reason !== undefined) draft.reason = rule.reason
  return draft
}

/** One preset wire to the editor's working copy. */
export function wireToDraft(spec: PresetSpecWire): PresetDraft {
  return {
    allowRules: spec.allowRules.map(ruleToDraft),
    denyRules: spec.denyRules.map(ruleToDraft),
    allowApprovals: [...spec.allowApprovals],
    extraWritableRoots: [...spec.extraWritableRoots],
  }
}

/** Group editor conditions into one matcher per field (immutable merges). */
function mergeCondition(matcher: FieldMatcherWire, type: MatcherDraftCondition['type'], value: string): FieldMatcherWire {
  switch (type) {
    case 'contains': return { ...matcher, contains: value }
    case 'regex': return { ...matcher, regex: value }
    case 'prefix': return { ...matcher, prefix: value }
    case 'glob': return { ...matcher, glob: value }
  }
}

/**
 * Group editor conditions into one matcher per field. Conditions whose value
 * is blank are dropped (an editor row is removed by clearing its text).
 */
function conditionsToMatchers(conditions: readonly MatcherDraftCondition[]): Record<string, FieldMatcherWire> {
  const when: Record<string, FieldMatcherWire> = {}
  for (const condition of conditions) {
    const value = condition.value.trim()
    if (value === '') continue
    const field = condition.field.trim()
    if (field === '') continue
    when[field] = mergeCondition(when[field] ?? {}, condition.type, value)
  }
  return when
}

/** One editor rule row to its wire form; blank-tool rows are dropped. */
function draftRuleToWire(rule: RuleDraft): RuleSpecWire | undefined {
  const tool = rule.tool.trim()
  if (tool === '') return undefined
  const when = conditionsToMatchers(rule.conditions)
  const reason = rule.reason?.trim()
  return {
    tool,
    ...(Object.keys(when).length > 0 ? { when } : {}),
    ...(reason !== undefined && reason !== '' ? { reason } : {}),
  }
}

/** The editor's working copy to the wire spec submitted to the Host. */
export function draftToWire(draft: PresetDraft): PresetSpecWire {
  const allowRules = draft.allowRules
    .map(draftRuleToWire)
    .filter((rule): rule is RuleSpecWire => rule !== undefined)
  const denyRules = draft.denyRules
    .map(draftRuleToWire)
    .filter((rule): rule is RuleSpecWire => rule !== undefined)
  return {
    allowRules,
    denyRules,
    allowApprovals: draft.allowApprovals.map(value => value.trim()).filter(value => value !== ''),
    extraWritableRoots: draft.extraWritableRoots.map(value => value.trim()).filter(value => value !== ''),
  }
}

/** Fetch the configured presets and active selection. */
export async function fetchPresetView(remote: CustomPermissionRemote): Promise<PresetListView> {
  return unwrap(await remote.list())
}

/** Switch the process-level selection through the Remote, then return the refreshed view. */
export async function applyPreset(remote: CustomPermissionRemote, name: string): Promise<PresetListView> {
  return unwrap(await remote.switch(name))
}

/** Fetch one preset's structured spec for the editor prefill. */
export async function fetchPresetSpec(remote: CustomPermissionRemote, name: string): Promise<PresetSpecWire> {
  return unwrap(await remote.get(name))
}

/** Create a preset and activate it, then return the refreshed view. */
export async function createPreset(remote: CustomPermissionRemote, name: string, spec: PresetSpecWire): Promise<PresetListView> {
  return unwrap(await remote.create(name, spec))
}

/** Update (and optionally rename) a preset, then return the refreshed view. */
export async function updatePreset(
  remote: CustomPermissionRemote,
  name: string,
  spec: PresetSpecWire,
  renameTo: string,
): Promise<PresetListView> {
  return unwrap(await remote.update(name, spec, renameTo))
}

/** Delete a preset, then return the refreshed view. */
export async function deletePreset(remote: CustomPermissionRemote, name: string): Promise<PresetListView> {
  return unwrap(await remote.delete(name))
}

/** The panel controller surface shared by the button, panel, and editor registers. */
export interface PanelController {
  readonly source: PanelSource<PanelState>
  readonly toggle: () => void
  readonly close: () => void
  readonly switchTo: (name: string) => void
  /** Open the create-preset editor (the panel's 快捷添加 action). */
  readonly openCreate: () => void
  /** Open the editor prefilled with one preset's rules. */
  readonly openEdit: (name: string) => void
  readonly closeEditor: () => void
  readonly editorSetName: (name: string) => void
  readonly editorSetDraft: (draft: PresetDraft) => void
  /** Validate and submit the open editor; success closes it and refreshes the view. */
  readonly saveEditor: () => void
  readonly requestDelete: (name: string) => void
  readonly cancelDelete: () => void
  readonly confirmDelete: () => void
}

/** The selector hook the renderer binds from the inject `hooks` compartment. */
export type UsePanel = <T>(selector: (state: PanelState) => T) => T

/** Panel controller: wires the components' callbacks to the Remote namespace. */
export function createPanelController(remote: () => Promise<CustomPermissionRemote>): PanelController {
  const { source, set } = createPanelSource()
  const load = (): void => {
    set({ status: 'loading', error: null })
    void remote().then(fetchPresetView).then(
      (view) => set({ status: 'ready', view }),
      (error: unknown) => set({ status: 'error', error: errorMessage(error) }),
    )
  }
  const editError = (error: unknown): void => {
    const editor = source.getSnapshot().editor
    if (editor === null) return
    set({ editor: { ...editor, busy: false, error: errorMessage(error) } })
  }
  return {
    source,
    toggle: () => {
      if (source.getSnapshot().open) {
        set({ open: false, editor: null, pendingDelete: null })
      } else {
        set({ open: true, pendingDelete: null })
        if (source.getSnapshot().status !== 'ready') load()
      }
    },
    close: () => set({ open: false, editor: null, pendingDelete: null }),
    switchTo: (name) => {
      set({ status: 'loading', error: null })
      void remote()
        .then(r => applyPreset(r, name))
        .then(
          (view) => set({ status: 'ready', view }),
          (error: unknown) => set({ status: 'error', error: errorMessage(error) }),
        )
    },
    openCreate: () => {
      set({
        open: true,
        pendingDelete: null,
        editor: {
          mode: 'create',
          originalName: '',
          draftName: '',
          draft: EMPTY_DRAFT,
          busy: false,
          error: null,
        },
      })
      if (source.getSnapshot().status !== 'ready') load()
    },
    openEdit: (name) => {
      set({
        open: true,
        pendingDelete: null,
        editor: { mode: 'edit', originalName: name, draftName: name, draft: EMPTY_DRAFT, busy: true, error: null },
      })
      void remote().then(r => fetchPresetSpec(r, name)).then(
        (spec) => {
          const editor = source.getSnapshot().editor
          if (editor === null || editor.originalName !== name) return
          set({ editor: { ...editor, busy: false, draft: wireToDraft(spec) } })
        },
        (error: unknown) => editError(error),
      )
    },
    closeEditor: () => set({ editor: null, pendingDelete: null }),
    editorSetName: (draftName) => {
      const editor = source.getSnapshot().editor
      if (editor === null) return
      set({ editor: { ...editor, draftName, error: null } })
    },
    editorSetDraft: (draft) => {
      const editor = source.getSnapshot().editor
      if (editor === null) return
      set({ editor: { ...editor, draft, error: null } })
    },
    saveEditor: () => {
      const editor = source.getSnapshot().editor
      if (editor === null || editor.busy) return
      const taken = new Set((source.getSnapshot().view?.presets ?? []).map(entry => entry.name))
      let name: string
      try {
        name = validateEditorName(editor.draftName, taken, editor.originalName)
      } catch (error) {
        set({ editor: { ...editor, error: errorMessage(error) } })
        return
      }
      set({ editor: { ...editor, busy: true, error: null } })
      const wire = draftToWire(editor.draft)
      const call = editor.mode === 'create'
        ? (r: CustomPermissionRemote) => createPreset(r, name, wire)
        : (r: CustomPermissionRemote) => updatePreset(r, editor.originalName, wire, name)
      void remote().then(call).then(
        (view) => set({ status: 'ready', view, editor: null, pendingDelete: null }),
        (error: unknown) => editError(error),
      )
    },
    requestDelete: (name) => set({ pendingDelete: name }),
    cancelDelete: () => set({ pendingDelete: null }),
    confirmDelete: () => {
      const pending = source.getSnapshot().pendingDelete
      if (pending === null) return
      set({ pendingDelete: null, status: 'loading', error: null })
      void remote().then(r => deletePreset(r, pending)).then(
        (view) => set({ status: 'ready', view }),
        (error: unknown) => set({ status: 'error', error: errorMessage(error) }),
      )
    },
  }
}
