import { describe, expect, it } from 'vitest'
import {
  applyPreset,
  createPanelController,
  fetchPresetView,
  parsePresetView,
  SETTINGS_NAMESPACE,
} from '../src/client/store.ts'
import type { SettingsRemoteFace } from '../src/client/store.ts'
import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'

/** One minimal namespace view for this plugin. */
function view(preset: string, presets: string[], revision = 0): SettingsNamespaceView {
  return {
    ns: SETTINGS_NAMESPACE,
    value: { preset, presets },
    revision,
  } as unknown as SettingsNamespaceView
}

/** A scripted settings Remote; `update` applies the patch to the matching namespace. */
function fakeSettings(initial: SettingsNamespaceView[]): {
  remote: SettingsRemoteFace
  updates: Array<{ ns: string; patch: Record<string, unknown>; revision: number | undefined }>
  failUpdate: boolean
} {
  let namespaces = initial
  const updates: Array<{ ns: string; patch: Record<string, unknown>; revision: number | undefined }> = []
  const state = { failUpdate: false }
  return {
    remote: {
      describe: async () => ({ namespaces }) as SettingsDescribeValue,
      update: async (ns, patch, expectedRevision) => {
        if (state.failUpdate) throw new Error('update failed')
        updates.push({ ns, patch, revision: expectedRevision })
        namespaces = namespaces.map(entry => {
          if (entry.ns !== ns) return entry
          return { ...entry, value: { ...(entry.value as Record<string, unknown>), ...patch }, revision: entry.revision + 1 }
        }) as unknown as SettingsNamespaceView[]
        const updated = namespaces.find(entry => entry.ns === ns)
        if (updated === undefined) throw new Error('namespace not found')
        return updated
      },
    },
    get updates() {
      return updates
    },
    get failUpdate() {
      return state.failUpdate
    },
    set failUpdate(value: boolean) {
      state.failUpdate = value
    },
  }
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('parsePresetView', () => {
  it('extracts the preset list, active name, and revision', () => {
    const parsed = parsePresetView(view('work', ['default', 'work'], 3))
    expect(parsed).toEqual({ presets: ['default', 'work'], active: 'work', revision: 3 })
  })

  it('yields undefined for other namespaces or malformed values', () => {
    expect(parsePresetView({ ns: 'other', value: {}, revision: 0 } as unknown as SettingsNamespaceView)).toBeUndefined()
    expect(parsePresetView(view('work', ['default']))).toMatchObject({ active: 'work' })
  })
})

describe('fetchPresetView', () => {
  it('returns the plugin namespace view', async () => {
    const { remote } = fakeSettings([view('default', ['default', 'work'], 2)])
    await expect(fetchPresetView(remote)).resolves.toMatchObject({ active: 'default', presets: ['default', 'work'], revision: 2 })
  })

  it('throws when the namespace is absent', async () => {
    const { remote } = fakeSettings([])
    await expect(fetchPresetView(remote)).rejects.toThrow(/not registered/)
  })
})

describe('applyPreset', () => {
  it('updates the selection and returns the refreshed view', async () => {
    const { remote, updates } = fakeSettings([view('default', ['default', 'work'], 1)])
    const result = await applyPreset(remote, 'work', 1)
    expect(updates).toEqual([{ ns: SETTINGS_NAMESPACE, patch: { preset: 'work' }, revision: 1 }])
    expect(result).toMatchObject({ active: 'work' })
  })

  it('propagates update failures', async () => {
    const { remote } = fakeSettings([view('default', ['default', 'work'])])
    remote.update = async () => {
      throw new Error('revision conflict')
    }
    await expect(applyPreset(remote, 'work', 0)).rejects.toThrow('revision conflict')
  })
})

describe('createPanelController', () => {
  it('opens, loads the view, switches, and surfaces errors', async () => {
    const { remote } = fakeSettings([view('default', ['default', 'work'], 1)])
    const controller = createPanelController(() => remote)

    controller.toggle()
    expect(controller.source.getSnapshot()).toMatchObject({ open: true, status: 'loading' })
    await flush()
    expect(controller.source.getSnapshot()).toMatchObject({ status: 'ready', presets: ['default', 'work'], active: 'default' })

    controller.switchTo('work')
    await flush()
    expect(controller.source.getSnapshot()).toMatchObject({ status: 'ready', active: 'work' })

    controller.toggle()
    expect(controller.source.getSnapshot().open).toBe(false)
  })

  it('shows the error state with a message when the load fails', async () => {
    const { remote } = fakeSettings([])
    const controller = createPanelController(() => remote)
    controller.toggle()
    await flush()
    expect(controller.source.getSnapshot()).toMatchObject({ status: 'error' })
    expect(controller.source.getSnapshot().error).toContain('not registered')
  })

  it('toggles the quick-add placeholder hint', () => {
    const { remote } = fakeSettings([view('default', ['default'])])
    const controller = createPanelController(() => remote)
    expect(controller.source.getSnapshot().quickAddHint).toBe(false)
    controller.quickAdd()
    expect(controller.source.getSnapshot().quickAddHint).toBe(true)
    controller.quickAdd()
    expect(controller.source.getSnapshot().quickAddHint).toBe(false)
  })
})
