/**
 * The hand-written `customPermission` Remote contribution, browser half. The
 * Typert Gateway dispatches the Host service's `typertRemote` binding
 * dynamically (no generator needed), and the client mounts this descriptor
 * through the shipped `ctx.remote.$mount` — version-independent across DSH
 * releases, unlike the `settings` namespace this plugin cannot rely on. The
 * codecs are strict (zod) because deployed DSH clients reject `src-json`
 * result codecs at mount time.
 * @module dsh-custom-permission/client/remote
 */

import { z } from 'zod'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    /** The `customPermission` namespace this browser half mounts. */
    customPermission: {
      list(): Promise<RemoteResult<PresetListView>>
      switch(name: string): Promise<RemoteResult<PresetListView>>
      create(name: string, spec: PresetSpecWire): Promise<RemoteResult<PresetListView>>
      update(name: string, spec: PresetSpecWire, renameTo: string): Promise<RemoteResult<PresetListView>>
      delete(name: string): Promise<RemoteResult<PresetListView>>
      get(name: string): Promise<RemoteResult<PresetSpecWire>>
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

/** Wire form of one argument-field matcher: regex sources as plain strings. */
export interface FieldMatcherWire {
  readonly regex?: string
  readonly prefix?: string
  readonly glob?: string
  readonly contains?: string
}

/** Wire form of one allow/deny rule (mirrors the Host's `RuleSpecWire`). */
export interface RuleSpecWire {
  readonly tool: string
  readonly when?: Record<string, FieldMatcherWire>
  readonly reason?: string
}

/** Wire form of one preset spec (mirrors the Host's `PresetSpecWire`). */
export interface PresetSpecWire {
  readonly allowRules: readonly RuleSpecWire[]
  readonly denyRules: readonly RuleSpecWire[]
  readonly allowApprovals: readonly string[]
  readonly extraWritableRoots: readonly string[]
}

/** The mounted `customPermission` Remote namespace face (result-envelope form). */
export interface CustomPermissionRemote {
  list(): Promise<RemoteResult<PresetListView>>
  switch(name: string): Promise<RemoteResult<PresetListView>>
  create(name: string, spec: PresetSpecWire): Promise<RemoteResult<PresetListView>>
  update(name: string, spec: PresetSpecWire, renameTo: string): Promise<RemoteResult<PresetListView>>
  delete(name: string): Promise<RemoteResult<PresetListView>>
  get(name: string): Promise<RemoteResult<PresetSpecWire>>
}

/** Strict wire codecs for the `customPermission` namespace (zod, matching the Host shapes). */
const presetEntrySchema = z.object({
  name: z.string(),
  active: z.boolean(),
  allowRules: z.array(z.string()),
  denyRules: z.array(z.string()),
  allowApprovals: z.array(z.string()),
  extraWritableRoots: z.array(z.string()),
})
const listViewSchema = z.object({
  active: z.string(),
  presets: z.array(presetEntrySchema),
})
const fieldMatcherWireSchema = z.object({
  regex: z.string().optional(),
  prefix: z.string().optional(),
  glob: z.string().optional(),
  contains: z.string().optional(),
}).refine(matcher => matcher.regex !== undefined || matcher.prefix !== undefined || matcher.glob !== undefined || matcher.contains !== undefined, {
  message: 'a field matcher must declare at least one of regex, prefix, glob, contains',
})
const ruleWireSchema = z.object({
  tool: z.string(),
  when: z.record(z.string(), fieldMatcherWireSchema).optional(),
  reason: z.string().optional(),
})
const presetSpecWireSchema = z.object({
  allowRules: z.array(ruleWireSchema),
  denyRules: z.array(ruleWireSchema),
  allowApprovals: z.array(z.string()),
  extraWritableRoots: z.array(z.string()),
})

/** Strict codecs (zod), one per wire shape this namespace exchanges. */
const listViewCodec = { mode: 'strict' as const, typeSymbol: 'dsh-custom-permission#PresetListView', schema: listViewSchema }
const presetNameCodec = { mode: 'strict' as const, typeSymbol: 'dsh-custom-permission#PresetName', schema: z.string() }
const presetSpecWireCodec = { mode: 'strict' as const, typeSymbol: 'dsh-custom-permission#PresetSpecWire', schema: presetSpecWireSchema }

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
      result: listViewCodec,
    },
    {
      id: 'dsh-custom-permission#customPermission/switch',
      service: 'customPermission',
      namespace: 'customPermission',
      method: 'switch',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'name', wire: 'name', source: 'json', codec: presetNameCodec }],
      result: listViewCodec,
    },
    {
      id: 'dsh-custom-permission#customPermission/get',
      service: 'customPermission',
      namespace: 'customPermission',
      method: 'get',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'name', wire: 'name', source: 'json', codec: presetNameCodec }],
      result: presetSpecWireCodec,
    },
    {
      id: 'dsh-custom-permission#customPermission/create',
      service: 'customPermission',
      namespace: 'customPermission',
      method: 'create',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'name', wire: 'name', source: 'json', codec: presetNameCodec },
        { name: 'spec', wire: 'spec', source: 'json', codec: presetSpecWireCodec },
      ],
      result: listViewCodec,
    },
    {
      id: 'dsh-custom-permission#customPermission/update',
      service: 'customPermission',
      namespace: 'customPermission',
      method: 'update',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'name', wire: 'name', source: 'json', codec: presetNameCodec },
        { name: 'spec', wire: 'spec', source: 'json', codec: presetSpecWireCodec },
        { name: 'renameTo', wire: 'renameTo', source: 'json', codec: presetNameCodec },
      ],
      result: listViewCodec,
    },
    {
      id: 'dsh-custom-permission#customPermission/delete',
      service: 'customPermission',
      namespace: 'customPermission',
      method: 'delete',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'name', wire: 'name', source: 'json', codec: presetNameCodec }],
      result: listViewCodec,
    },
  ],
}
