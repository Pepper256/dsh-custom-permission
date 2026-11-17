import ts from 'typescript'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * Transform standard TypeScript decorators before Vite's default parser sees
 * source files, so the plugin's own `@Remote`-decorated methods load under
 * Vitest the same way the published build does.
 * @returns a pre-transform Vite plugin.
 */
export function standardDecoratorPlugin() {
  return {
    name: 'dsh-custom-permission-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}
