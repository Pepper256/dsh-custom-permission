/**
 * Client-bundle build for the dsh-custom-permission browser half. Reproduces
 * the lazy-CJS factory artifact the client module system serves over
 * `/plugins`: `window.__ModuleLoader__.load({ id, factory })`, with the shell's
 * baseline modules resolved through the injected `require` (the loader module
 * table). The DSH-internal `tsdown.client.ts` preset is not published, so this
 * config states the same output shape here, without the CSS/sourcemap extras
 * this package does not use.
 * @module dsh-custom-permission/tsdown.config
 */

import { defineConfig } from 'tsdown'

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

const isPlatformModule = (specifier: string): boolean => PLATFORM_MODULES.includes(specifier)

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    // Requested module-table rows stay imports; everything else is bundled.
    neverBundle: isPlatformModule,
    alwaysBundle: (specifier: string) => !isPlatformModule(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-custom-permission", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
