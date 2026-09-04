/**
 * Self-contained build for git/tarball installs. `pnpm` runs `prepare` after
 * cloning a `github:`/git dependency, where this checkout's normal build
 * cannot run: the developer tsconfigs extend the DeepSeek Harness checkout
 * (`../tsconfig.base.json` + project references) and no sibling checkout
 * exists at install time, and Node's type-stripping cannot lower decorators
 * (`@Remote`). esbuild transpiles without types or project references:
 *
 * - Host: `src/index.ts` bundles to one ESM `lib/types/index.js`; every
 *   `@deepseek-ai/*` bare import stays external and resolves from the dsh
 *   installation closure at runtime (see README "分发说明").
 * - Client: `src/client/index.ts` bundles to the lazy-CJS
 *   `window.__ModuleLoader__.load(...)` artifact `lib/client.js` the client
 *   module system serves over `/plugins`, mirroring `tsdown.config.ts`: the
 *   shell's eight baseline modules stay imports, everything else (zod) is
 *   bundled.
 *
 * Declaration files are not produced here; the full `pnpm run build`
 * (tsc + tsdown, in the DSH checkout) remains the release path that emits
 * `lib/types/**/*.d.ts`.
 * @module dsh-custom-permission/prepare
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The shell-seeded module table this bundle resolves against (never bundled). */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

async function run() {
  await mkdir(dirname(`${root}lib/types/index.js`), { recursive: true })
  // Host: one ESM file replacing the tsc multi-file output; type-only
  // declarations are absent on this path.
  await build({
    entryPoints: [`${root}src/index.ts`],
    outfile: `${root}lib/types/index.js`,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2024',
    external: [/^@deepseek-ai\//],
    logLevel: 'info',
  })

  await mkdir(dirname(`${root}lib/client.js`), { recursive: true })
  await build({
    entryPoints: [`${root}src/client/index.ts`],
    outfile: `${root}lib/client.js`,
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2024',
    jsx: 'automatic',
    external: PLATFORM_MODULES,
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "dsh-custom-permission", factory: (require) => {\n'
        + 'var module = { exports: {} }; var exports = module.exports;',
    },
    footer: { js: 'return module.exports; } });' },
    logLevel: 'info',
  })
}

run().catch((error) => {
  console.error('dsh-custom-permission prepare failed:', error)
  process.exitCode = 1
})
