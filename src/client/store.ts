/**
 * Preset-panel state and the settings-Remote bridge, browser half. Pure logic
 * with no React/Cordis runtime imports: the panel lists the configured presets
 * (read from the `custom-permission` settings namespace, whose base layer
 * carries the table) and switches the process-level selection through the
 * shipped settings Remote (`describe` + `update`), which the Host plugin
 * already watches. Errors surface with a fix-the-yml hint.
 * @module dsh-custom-permission/client/store
 */

import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'

/** The settings namespace the Host plugin registers. */
export const SETTINGS_NAMESPACE = 'custom-permission'

/** The Typert client-Remote result envelope every Remote method returns. */
export type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } }

/** The shipped settings Remote face the panel needs (result-envelope form). */
export interface SettingsRemoteFace {
  describe(): Promise<RemoteResult<SettingsDescribeValue>>
  update(ns: string, patch: Record<string, unknown>, expectedRevision: number | undefined): Promise<RemoteResult<SettingsNamespaceView>>
}

/** The panel's view of the configured presets. */
export interface PresetView {
  readonly presets: readonly string[]
  readonly active: string
  readonly revision: number
}

/** Minimal observable snapshot source the slot `hooks` compartment accepts. */
export interface PanelSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The panel's renderable state. */
export interface PanelState {
  readonly open: boolean
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly presets: readonly string[]
  readonly active: string
  readonly revision: number
  readonly error: string | null
  /** Whether the quick-add placeholder hint is showing. */
  readonly quickAddHint: boolean
}

const INITIAL_STATE: PanelState = {
  open: false,
  status: 'idle',
  presets: [],
  active: '',
  revision: 0,
  error: null,
  quickAddHint: false,
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

/** Extract this plugin's preset view from one describe response, or undefined. */
export function parsePresetView(view: SettingsNamespaceView): PresetView | undefined {
  if (view.ns !== SETTINGS_NAMESPACE) return undefined
  const value = view.value as { preset?: unknown; presets?: unknown }
  if (typeof value.preset !== 'string') return undefined
  const presets = Array.isArray(value.presets)
    ? value.presets.filter((entry): entry is string => typeof entry === 'string')
    : []
  return { presets, active: value.preset, revision: view.revision }
}

/**
 * Fetch the configured presets and active selection.
 * @param settings - the shipped settings Remote.
 * @returns the parsed view.
 * @throws when the Remote rejects or the namespace is absent — the plugin is
 *   not loaded or its configuration is invalid, which the caller surfaces
 *   with a fix-the-yml hint.
 */
export async function fetchPresetView(settings: SettingsRemoteFace): Promise<PresetView> {
  const response = await settings.describe()
  if (!response.ok) throw new Error(response.error.message)
  for (const view of response.value.namespaces) {
    const parsed = parsePresetView(view)
    if (parsed !== undefined) return parsed
  }
  throw new Error(`settings namespace "${SETTINGS_NAMESPACE}" is not registered — the plugin may be misconfigured or not loaded`)
}

/**
 * Switch the process-level selection through the settings Remote, then return
 * the refreshed view. The revision fences the write: a concurrent change
 * rejects instead of being silently overwritten.
 * @param settings - the shipped settings Remote.
 * @param name - the preset to activate.
 * @param revision - the revision the panel read.
 */
export async function applyPreset(settings: SettingsRemoteFace, name: string, revision: number): Promise<PresetView> {
  const response = await settings.update(SETTINGS_NAMESPACE, { preset: name }, revision)
  if (!response.ok) throw new Error(response.error.message)
  return fetchPresetView(settings)
}

/** Panel controller: wires the components' callbacks to the settings Remote. */
export function createPanelController(settings: () => SettingsRemoteFace): PanelController {
  const { source, set } = createPanelSource()
  const load = (): void => {
    set({ status: 'loading', error: null })
    void fetchPresetView(settings()).then(
      (view) => set({ status: 'ready', presets: view.presets, active: view.active, revision: view.revision }),
      (error: unknown) => set({ status: 'error', error: errorMessage(error) }),
    )
  }
  return {
    source,
    toggle: () => {
      if (source.getSnapshot().open) {
        set({ open: false })
      } else {
        set({ open: true, quickAddHint: false })
        load()
      }
    },
    close: () => set({ open: false }),
    switchTo: (name) => {
      set({ status: 'loading', error: null })
      const revision = source.getSnapshot().revision
      void applyPreset(settings(), name, revision).then(
        (view) => set({ status: 'ready', presets: view.presets, active: view.active, revision: view.revision }),
        (error: unknown) => set({ status: 'error', error: errorMessage(error) }),
      )
    },
    quickAdd: () => set({ quickAddHint: !source.getSnapshot().quickAddHint }),
  }
}

/** The panel controller surface shared by the button and panel registers. */
export interface PanelController {
  readonly source: PanelSource<PanelState>
  readonly toggle: () => void
  readonly close: () => void
  readonly switchTo: (name: string) => void
  readonly quickAdd: () => void
}

/** The selector hook the renderer binds from the inject `hooks` compartment. */
export type UsePanel = <T>(selector: (state: PanelState) => T) => T
