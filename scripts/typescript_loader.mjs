/** Node 工程脚本的最小 TypeScript loader；只转译 .ts 文件，不做模块替换。 */

import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import ts from "typescript"

/** 让 Node 直接加载 TypeScript 工程脚本，同时保留语法错误的明确失败。 */
export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context)

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
    },
  })
  const errors = (result.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
  if (errors.length > 0) {
    const details = errors.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n")
    throw new Error(`TypeScript 工程脚本转译失败：${file}\n${details}`)
  }
  return { format: "module", shortCircuit: true, source: result.outputText }
}
