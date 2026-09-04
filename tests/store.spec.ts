import { describe, expect, it } from 'vitest'
import {
  applyPreset,
  createPanelController,
  draftToWire,
  fetchPresetView,
  wireToDraft,
} from '../src/client/store.ts'
import type { CustomPermissionRemote, PresetListView, PresetSpecWire } from '../src/client/remote.ts'

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

/**
 * A scripted `customPermission` Remote: `switch` updates the active preset,
 * `get` serves the spec registry, and create/update/delete mutate the view.
 */
function fakeRemote(initial: PresetListView): {
  remote: CustomPermissionRemote
  switches: string[]
  created: Array<{ name: string; spec: PresetSpecWire }>
  updated: Array<{ name: string; spec: PresetSpecWire; renameTo: string }>
  deleted: string[]
  fail: boolean
  specs: Map<string, PresetSpecWire>
} {
  let current = initial
  const switches: string[] = []
  const created: Array<{ name: string; spec: PresetSpecWire }> = []
  const updated: Array<{ name: string; spec: PresetSpecWire; renameTo: string }> = []
  const deleted: string[] = []
  const state = { fail: false }
  const specs = new Map<string, PresetSpecWire>()
  const names = (): string[] => current.presets.map(entry => entry.name)
  return {
    remote: {
      list: async () => ({ ok: true as const, value: current }),
      switch: async (name) => {
        if (state.fail) throw new Error('remote failed')
        switches.push(name)
        if (!current.presets.some(entry => entry.name === name)) {
          return { ok: false as const, error: { message: 'unknown preset' } }
        }
        current = view(name, names())
        return { ok: true as const, value: current }
      },
      get: async (name) => {
        if (state.fail) throw new Error('remote failed')
        const spec = specs.get(name)
        if (spec === undefined) return { ok: false as const, error: { message: `unknown preset "${name}"` } }
        return { ok: true as const, value: spec }
      },
      create: async (name, spec) => {
        if (state.fail) throw new Error('remote failed')
        created.push({ name, spec })
        if (current.presets.some(entry => entry.name === name)) {
          return { ok: false as const, error: { message: 'already exists' } }
        }
        specs.set(name, spec)
        current = view(name, [...names(), name])
        return { ok: true as const, value: current }
      },
      update: async (name, spec, renameTo) => {
        if (state.fail) throw new Error('remote failed')
        updated.push({ name, spec, renameTo })
        const next = [...names()].map(entry => entry === name ? renameTo : entry)
        specs.delete(name)
        specs.set(renameTo, spec)
        current = view(current.active === name ? renameTo : current.active, next)
        return { ok: true as const, value: current }
      },
      delete: async (name) => {
        if (state.fail) throw new Error('remote failed')
        deleted.push(name)
        specs.delete(name)
        current = view(current.active, names().filter(entry => entry !== name))
        return { ok: true as const, value: current }
      },
    },
    get switches() {
      return switches
    },
    get created() {
      return created
    },
    get updated() {
      return updated
    },
    get deleted() {
      return deleted
    },
    get fail() {
      return state.fail
    },
    set fail(value: boolean) {
      state.fail = value
    },
    get specs() {
      return specs
    },
  }
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** A deniable rule spec used across the editor tests. */
const ruleSpec: PresetSpecWire = {
  allowRules: [{ tool: 'bash', when: { command: { contains: 'git' } } }],
  denyRules: [],
  allowApprovals: ['fetch'],
  extraWritableRoots: [],
}

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

describe('draft wire conversion', () => {
  it('round-trips rules, approvals, and roots losslessly', () => {
    const wire: PresetSpecWire = {
      allowRules: [
        {
          tool: 'bash',
          when: { command: { contains: 'git', prefix: '--' }, path: { glob: 'src/**' } },
        },
      ],
      denyRules: [
        { tool: 'echo', reason: 'no echo' },
        { tool: 'fs_*', when: { path: { regex: '^C:\\\\tmp' } } },
      ],
      allowApprovals: ['fetch', 'web_search'],
      extraWritableRoots: ['C:\\data', '/mnt/x'],
    }
    expect(draftToWire(wireToDraft(wire))).toEqual(wire)
  })

  it('drops blank tool rows, blank conditions, and blank reason/lists on save', () => {
    const draft = wireToDraft({
      allowRules: [{ tool: 'bash', when: { command: { contains: 'git' } } }, { tool: '   ' }],
      denyRules: [{ tool: 'echo', reason: '   ' }, { tool: '   ' }],
      allowApprovals: ['fetch', ' '],
      extraWritableRoots: [],
    })
    expect(draftToWire(draft)).toEqual({
      allowRules: [{ tool: 'bash', when: { command: { contains: 'git' } } }],
      denyRules: [{ tool: 'echo' }],
      allowApprovals: ['fetch'],
      extraWritableRoots: [],
    })
  })
})

describe('createPanelController editor', () => {
  it('opens the create editor and saves through the Remote, closing on success', async () => {
    const { remote, created } = fakeRemote(view('default', ['default']))
    const controller = createPanelController(async () => remote)

    controller.openCreate()
    expect(controller.source.getSnapshot().open).toBe(true)
    expect(controller.source.getSnapshot().editor).toMatchObject({ mode: 'create', busy: false, error: null })

    controller.editorSetName('ci')
    controller.editorSetDraft(wireToDraft(ruleSpec))
    controller.saveEditor()
    expect(controller.source.getSnapshot().editor?.busy).toBe(true)
    await flush()

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ name: 'ci', spec: ruleSpec })
    expect(controller.source.getSnapshot().editor).toBeNull()
    expect(controller.source.getSnapshot().view?.active).toBe('ci')
  })

  it('rejects an invalid editor name client-side without calling the Remote', async () => {
    const { remote, created } = fakeRemote(view('default', ['default']))
    const controller = createPanelController(async () => remote)

    controller.openCreate()
    controller.editorSetName('bad name')
    controller.saveEditor()
    await flush()

    expect(created).toHaveLength(0)
    const editor = controller.source.getSnapshot().editor
    expect(editor?.error).toContain('whitespace')
  })

  it('rejects a duplicate name client-side without calling the Remote', async () => {
    const { remote, created } = fakeRemote(view('default', ['default']))
    const controller = createPanelController(async () => remote)

    // Load the list first so the client-side duplicate check sees the table.
    controller.toggle()
    await flush()
    controller.openCreate()
    controller.editorSetName('default')
    controller.saveEditor()
    await flush()

    expect(created).toHaveLength(0)
    expect(controller.source.getSnapshot().editor?.error).toContain('already exists')
  })

  it('surfaces a Remote rejection in the editor instead of closing it', async () => {
    const { remote, created } = fakeRemote(view('default', ['default']))
    const controller = createPanelController(async () => remote)

    controller.openCreate()
    controller.editorSetName('ci')
    controller.editorSetDraft(wireToDraft(ruleSpec))
    remote.create = async () => ({ ok: false, error: { message: 'spec is invalid' } })
    controller.saveEditor()
    await flush()

    expect(created).toHaveLength(0)
    expect(controller.source.getSnapshot().editor).toMatchObject({ busy: false, error: 'spec is invalid' })
  })

  it('prefills the editor from the Remote and updates (with rename) on save', async () => {
    const { remote, specs, updated } = fakeRemote(view('work', ['default', 'work']))
    specs.set('work', ruleSpec)
    const controller = createPanelController(async () => remote)

    controller.openEdit('work')
    expect(controller.source.getSnapshot().editor).toMatchObject({ mode: 'edit', originalName: 'work', draftName: 'work' })
    await flush()

    const editor = controller.source.getSnapshot().editor
    expect(editor?.busy).toBe(false)
    expect(editor?.draft.allowApprovals).toEqual(['fetch'])

    // Rename while editing: originalName stays, the submitted renameTo is the new name.
    controller.editorSetName('ci')
    controller.saveEditor()
    await flush()

    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ name: 'work', renameTo: 'ci' })
    expect(controller.source.getSnapshot().view?.active).toBe('ci')
  })

  it('loads an unknown preset into the editor error without closing', async () => {
    const { remote } = fakeRemote(view('default', ['default']))
    const controller = createPanelController(async () => remote)

    controller.openEdit('nope')
    await flush()

    expect(controller.source.getSnapshot().editor).toMatchObject({ busy: false })
    expect(controller.source.getSnapshot().editor?.error).toContain('unknown preset')
  })
})

describe('createPanelController delete', () => {
  it('confirms deletion through the Remote and refreshes the view', async () => {
    const { remote, deleted } = fakeRemote(view('default', ['default', 'work']))
    const controller = createPanelController(async () => remote)

    controller.openCreate() // ensure the panel is open
    controller.closeEditor()
    controller.requestDelete('work')
    expect(controller.source.getSnapshot().pendingDelete).toBe('work')
    controller.confirmDelete()
    expect(controller.source.getSnapshot().pendingDelete).toBeNull()
    await flush()

    expect(deleted).toEqual(['work'])
    expect(controller.source.getSnapshot().view?.presets.map(entry => entry.name)).toEqual(['default'])
  })

  it('cancels a pending delete', async () => {
    const { remote, deleted } = fakeRemote(view('default', ['default', 'work']))
    const controller = createPanelController(async () => remote)
    controller.openCreate()
    controller.closeEditor()

    controller.requestDelete('work')
    controller.cancelDelete()
    expect(controller.source.getSnapshot().pendingDelete).toBeNull()
    await flush()
    expect(deleted).toEqual([])
  })

  it('surfaces a delete failure in the panel error state', async () => {
    const { remote } = fakeRemote(view('default', ['default', 'work']))
    const controller = createPanelController(async () => remote)
    controller.openCreate()
    controller.closeEditor()

    remote.delete = async () => ({ ok: false, error: { message: 'cannot delete the active preset' } })
    controller.requestDelete('default')
    controller.confirmDelete()
    await flush()

    expect(controller.source.getSnapshot()).toMatchObject({ status: 'error' })
    expect(controller.source.getSnapshot().error).toContain('cannot delete the active preset')
  })
})

describe('createPanelController basics', () => {
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
})
