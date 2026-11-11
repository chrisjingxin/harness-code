/** 渲染器共用的语言名称：只做字符串映射，不访问文件系统或旧终端解析器。 */
export type LanguageId = "javascript" | "typescript" | "jsx" | "tsx" | "json" | "python" | "bash" | "go" | "java" | "c" | "cpp" | "html" | "css" | "yaml" | "markdown" | "plaintext"

const aliases: Record<string, LanguageId> = {
  javascript: "javascript", js: "javascript", mjs: "javascript", cjs: "javascript",
  typescript: "typescript", ts: "typescript", mts: "typescript", cts: "typescript",
  jsx: "jsx", tsx: "tsx", json: "json", jsonc: "json",
  python: "python", py: "python", bash: "bash", sh: "bash", shell: "bash", zsh: "bash",
  go: "go", java: "java", c: "c", h: "c", cpp: "cpp", "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
  html: "html", htm: "html", css: "css", yaml: "yaml", yml: "yaml", markdown: "markdown", md: "markdown",
  plaintext: "plaintext", text: "plaintext", txt: "plaintext", plain: "plaintext",
}

/** 将语言名称或别名规范化；空值和未知名称均返回 plaintext。 */
export function resolveLanguage(language?: string | null): LanguageId {
  const name = language?.trim().toLowerCase() ?? ""
  return Object.hasOwn(aliases, name) ? aliases[name]! : "plaintext"
}

/** 仅按路径末段的扩展名识别语言，不读取路径所指文件。 */
export function resolveLanguageForPath(path?: string | null): LanguageId {
  const name = path?.replaceAll("\\", "/").split("/").at(-1) ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 && dot < name.length - 1 ? resolveLanguage(name.slice(dot + 1)) : "plaintext"
}
