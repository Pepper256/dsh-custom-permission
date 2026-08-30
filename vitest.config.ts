import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

/**
 * Standalone test configuration for the dsh-custom-permission plugin. Source
 * files resolve the `@deepseek-ai/*` packages through the DSH checkout's
 * tsconfig paths (the extended `../tsconfig.base.json`), the same source
 * plane the harness packages themselves test on; the shared decorator
 * pre-transform keeps legacy decorators in that source parseable.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [standardDecoratorPlugin()],
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
