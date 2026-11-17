import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from './tests/vitest.decorators.ts'

/**
 * Standalone test configuration for the dsh-custom-permission plugin. The
 * `@deepseek-ai/*` packages resolve from this package's own devDependencies
 * (pinned to the supported DSH release), never from a sibling DSH checkout.
 * The decorator pre-transform keeps the standard `@Remote` decorators
 * parseable for Vite's default transform.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [standardDecoratorPlugin()],
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
