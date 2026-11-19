/**
 * 【功能定义】Node 工程与测试脚本的最小 TypeScript loader：
 * 为 `.ts` / `.tsx` 源码内遵循 ESM `.js` 后缀约定的相对导入解析回对应 `.ts` / `.tsx` 文件并转译执行。
 * 【协作边界】仅作用于 `.ts` / `.tsx` 模块，不改写外部包解析。
 */
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import ts from "typescript"

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../"))
    && specifier.endsWith(".js")
    && context.parentURL?.startsWith("file:")
    && /\.(?:ts|tsx)$/.test(context.parentURL)
  ) {
    const jsUrl = new URL(specifier, context.parentURL)
    if (!existsSync(fileURLToPath(jsUrl))) {
      for (const ext of [".ts", ".tsx"]) {
        const tsSpecifier = specifier.slice(0, -3) + ext
        if (existsSync(fileURLToPath(new URL(tsSpecifier, context.parentURL)))) {
          return nextResolve(tsSpecifier, context)
        }
      }
    }
  }
  return nextResolve(specifier, context)
}

/** 让 Node 直接加载 TypeScript 工程脚本与单元测试，同时保留语法错误的明确失败。 */
export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !/\.(?:ts|tsx)$/.test(url)) return nextLoad(url, context)

  const file = fileURLToPath(url)
  const source = await readFile(file, "utf8")
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      inlineSourceMap: true,
      inlineSources: true,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      ...(file.endsWith(".tsx") ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  })
  const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
  if (errors.length > 0) {
    const details = errors.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n")
    throw new Error(`TypeScript 工程脚本转译失败：${file}\n${details}`)
  }
  return { format: "module", shortCircuit: true, source: result.outputText }
}
