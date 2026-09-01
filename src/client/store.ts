/**
 * Preset-panel state and the `customPermission` Remote bridge, browser half.
 * Pure logic with no React/Cordis runtime imports: the panel lists every
 * configured preset (the Host's Remote view) and switches the process-level
 * selection through the mounted Remote namespace. Remote rejections and
 * unknown presets surface with a fix-the-yml hint.
 * @module dsh-custom-permission/client/store
 */

import type { CustomPermissionRemote, PresetListView } from './remote.ts'

/** Minimal observable snapshot source the slot `hooks` compartment accepts. */
export interface PanelSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The panel's renderable state. */
export interface PanelState {
  readonly open: boolean
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly view: PresetListView | null
  readonly error: string | null
  /** Whether the quick-add placeholder hint is showing. */
  readonly quickAddHint: boolean
}

const INITIAL_STATE: PanelState = {
  open: false,
  status: 'idle',
  view: null,
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

/** Unwrap one Remote result; rejections and business errors throw their message. */
function unwrap<T>(response: { readonly ok: boolean; readonly value?: T; readonly error?: { readonly message: string } }): T {
  if (!response.ok) throw new Error(response.error?.message ?? 'remote call failed')
  return response.value as T
}

/**
 * Fetch the configured presets and active selection.
 * @param remote - the mounted `customPermission` Remote namespace.
 * @returns the parsed view.
 * @throws when the Remote rejects 鈥?surfaced with a fix-the-yml hint.
 */
export async function fetchPresetView(remote: CustomPermissionRemote): Promise<PresetListView> {
  return unwrap(await remote.list())
}

/**
 * Switch the process-level selection through the Remote, then return the
 * refreshed view.
 * @param remote - the mounted `customPermission` Remote namespace.
 * @param name - the preset to activate.
 */
export async function applyPreset(remote: CustomPermissionRemote, name: string): Promise<PresetListView> {
  return unwrap(await remote.switch(name))
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
      void remote()
        .then(r => applyPreset(r, name))
        .then(
          (view) => set({ status: 'ready', view }),
          (error: unknown) => set({ status: 'error', error: errorMessage(error) }),
        )
    },
    quickAdd: () => set({ quickAddHint: !source.getSnapshot().quickAddHint }),
  }
}
