/**
 * Bridge the plugin's runtime dependencies from the installed DeepSeek
 * Harness closure into this checkout's node_modules, so the built plugin
 * resolves `@deepseek-ai/*` imports when the plugin directory sits OUTSIDE
 * the dsh installation (the normal dev-machine situation for this repo).
 *
 * The closure is the nested package tree of the global `dsh` install:
 * `<npm-global>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`.
 * Override with `DSH_CLOSURE` when the install lives elsewhere. Junctions
 * (Windows) / symlinks (POSIX) point at the installed packages verbatim, so
 * the plugin runs against the same package versions the profile boots.
 *
 * Only the RUNTIME bare imports of the built `lib/` need bridging; the rest
 * of the plugin's `@deepseek-ai/*` imports are type-only and erased on emit.
 *
 * @module dsh-custom-permission/scripts/link-closure-deps
 */

import { mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Runtime bare imports of the built plugin (see lib/types/*.js after `pnpm run build`). */
const RUNTIME_DEPS = ['cordis', 'schemastery', 'dsh-fs', 'dsh-fs-local', 'dsh-sandbox', 'dsh-settings', 'dsh-typert-protocol']

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const targetRoot = join(repoRoot, 'node_modules', '@deepseek-ai')

function defaultClosure() {
  if (process.env.DSH_CLOSURE !== undefined) return process.env.DSH_CLOSURE
  if (process.platform === 'win32' && process.env.APPDATA !== undefined) {
    return join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
  }
  return undefined
}

const closure = defaultClosure()
if (closure === undefined || !existsSync(join(closure, 'cordis'))) {
  console.error(
    'link-closure-deps: cannot locate the dsh installation closure; pass DSH_CLOSURE='
    + '<npm-global>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  )
  process.exit(1)
}

mkdirSync(targetRoot, { recursive: true })
for (const name of RUNTIME_DEPS) {
  const source = join(closure, name)
  const link = join(targetRoot, name)
  if (!existsSync(source)) {
    console.error(`link-closure-deps: ${name} is absent from the closure (${source})`)
    process.exit(1)
  }
  if (existsSync(link)) rmSync(link, { recursive: true, force: true })
  // Junction avoids Windows admin rights; the loader follows it to the closure.
  symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`linked ${name}`)
}

const absolute = isAbsolute(closure) ? closure : join(process.cwd(), closure)
console.log(`dsh-custom-permission runtime deps bridged to ${absolute}`)
