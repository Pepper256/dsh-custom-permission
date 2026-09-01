import { describe, expect, it } from 'vitest'
import { applyPreset, createPanelController, fetchPresetView } from '../src/client/store.ts'
import type { CustomPermissionRemote, PresetListView } from '../src/client/remote.ts'

/** One minimal preset view. */
function view(active: string, names: string[]): PresetListView {
  return {
    active,
    presets: names.map(name => ({
      name,
      active: name === active,
      allowRules: [],
      denyRules: [],
      allowApprovals: [],
      extraWritableRoots: [],
    })),
  }
}

/** A scripted `customPermission` Remote; `switch` updates the active preset. */
function fakeRemote(initial: PresetListView): {
  remote: CustomPermissionRemote
  switches: string[]
  fail: boolean
} {
  let current = initial
  const switches: string[] = []
  const state = { fail: false }
  return {
    remote: {
      list: async () => ({ ok: true as const, value: current }),
      switch: async (name) => {
        if (state.fail) throw new Error('remote failed')
        switches.push(name)
        if (!current.presets.some(entry => entry.name === name)) {
          return { ok: false as const, error: { message: 'unknown preset' } }
        }
        current = view(name, current.presets.map(entry => entry.name))
        return { ok: true as const, value: current }
      },
    },
    get switches() {
      return switches
    },
    get fail() {
      return state.fail
    },
    set fail(value: boolean) {
      state.fail = value
    },
  }
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('fetchPresetView', () => {
  it('returns the Remote view', async () => {
    const { remote } = fakeRemote(view('default', ['default', 'work']))
    const result = await fetchPresetView(remote)
    expect(result.active).toBe('default')
    expect(result.presets).toHaveLength(2)
    expect(result.presets[0]).toMatchObject({ name: 'default', active: true })
  })

  it('propagates Remote rejections', async () => {
    const { remote } = fakeRemote(view('default', ['default']))
    remote.list = async () => ({ ok: false, error: { message: 'gateway down' } })
    await expect(fetchPresetView(remote)).rejects.toThrow('gateway down')
  })
})

describe('applyPreset', () => {
  it('switches and returns the refreshed view', async () => {
    const { remote, switches } = fakeRemote(view('default', ['default', 'work']))
    const result = await applyPreset(remote, 'work')
    expect(switches).toEqual(['work'])
    expect(result).toMatchObject({ active: 'work' })
  })

  it('propagates failures and rejected results', async () => {
    const { remote } = fakeRemote(view('default', ['default', 'work']))
    remote.switch = async () => ({ ok: false, error: { message: 'unknown preset' } })
    await expect(applyPreset(remote, 'nope')).rejects.toThrow('unknown preset')
  })
})

describe('createPanelController', () => {
  it('opens, loads the view, switches, and surfaces errors', async () => {
    const { remote } = fakeRemote(view('default', ['default', 'work']))
    const controller = createPanelController(async () => remote)

    controller.toggle()
    expect(controller.source.getSnapshot()).toMatchObject({ open: true, status: 'loading' })
    await flush()
    expect(controller.source.getSnapshot()).toMatchObject({ status: 'ready' })
    expect(controller.source.getSnapshot().view?.active).toBe('default')

    controller.switchTo('work')
    await flush()
    expect(controller.source.getSnapshot().view?.active).toBe('work')

    controller.toggle()
    expect(controller.source.getSnapshot().open).toBe(false)
  })

  it('shows the error state with a message when the load fails', async () => {
    const { remote } = fakeRemote(view('default', ['default']))
    remote.list = async () => ({ ok: false, error: { message: 'gateway down' } })
    const controller = createPanelController(async () => remote)
    controller.toggle()
    await flush()
    expect(controller.source.getSnapshot()).toMatchObject({ status: 'error' })
    expect(controller.source.getSnapshot().error).toContain('gateway down')
  })

  it('toggles the quick-add placeholder hint', async () => {
    const { remote } = fakeRemote(view('default', ['default']))
    const controller = createPanelController(async () => remote)
    expect(controller.source.getSnapshot().quickAddHint).toBe(false)
    controller.quickAdd()
    expect(controller.source.getSnapshot().quickAddHint).toBe(true)
    controller.quickAdd()
    expect(controller.source.getSnapshot().quickAddHint).toBe(false)
  })
})
