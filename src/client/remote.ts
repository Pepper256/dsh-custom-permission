/**
 * The hand-written `customPermission` Remote contribution, browser half. The
 * Typert Gateway dispatches the Host service's `typertRemote` binding
 * dynamically (no generator needed), and the client mounts this descriptor
 * through the shipped `ctx.remote.$mount` — version-independent across DSH
 * releases, unlike the `settings` namespace this plugin cannot rely on.
 * @module dsh-custom-permission/client/remote
 */

import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    /** The `customPermission` namespace this browser half mounts. */
    customPermission: {
      list(): Promise<RemoteResult<PresetListView>>
      switch(name: string): Promise<RemoteResult<PresetListView>>
    }
  }
}

/** The Typert client-Remote result envelope every Remote method returns. */
export type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } }

/** Wire view of one configured preset (mirrors the Host's `PresetViewEntry`). */
export interface PresetViewEntry {
  readonly name: string
  readonly active: boolean
  readonly allowRules: readonly string[]
  readonly denyRules: readonly string[]
  readonly allowApprovals: readonly string[]
  readonly extraWritableRoots: readonly string[]
}

/** Wire view of the whole preset table plus the active name. */
export interface PresetListView {
  readonly active: string
  readonly presets: readonly PresetViewEntry[]
}

/** The mounted `customPermission` Remote namespace face (result-envelope form). */
export interface CustomPermissionRemote {
  list(): Promise<RemoteResult<PresetListView>>
  switch(name: string): Promise<RemoteResult<PresetListView>>
}

/** Hand-written contribution this browser half mounts into the gateway client. */
export const CUSTOM_PERMISSION_REMOTE: TypertRemoteContribution = {
  package: 'dsh-custom-permission',
  descriptors: [
    {
      id: 'dsh-custom-permission#customPermission/list',
      service: 'customPermission',
      namespace: 'customPermission',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'src-json' },
    },
    {
      id: 'dsh-custom-permission#customPermission/switch',
      service: 'customPermission',
      namespace: 'customPermission',
      method: 'switch',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'name', wire: 'name', source: 'json', codec: { mode: 'src-json' } }],
      result: { mode: 'src-json' },
    },
  ],
}
