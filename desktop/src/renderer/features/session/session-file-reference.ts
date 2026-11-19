/** 将消息中的文件引用限制在当前会话已绑定的工作目录内，并提取可选的 1-based 行号区间。 */

export type ResolvedSessionFileReference = {
  readonly path: string
  readonly exact: boolean
  readonly line?: number
  readonly endLine?: number
}

const LINE_SUFFIX_RE = /(?:#L([1-9]\d*)(?:-L?([1-9]\d*))?|:([1-9]\d*)(?:-([1-9]\d*)|:\d+)?)$/i

/** 常见系统/宿主顶层目录名：当不处于当前工作目录前缀下时，按越界系统路径拦截而非回退为项目根相对路径。 */
const HOST_SYSTEM_ROOTS = new Set([
  "etc", "var", "tmp", "private", "usr", "opt", "dev", "proc", "sys", "sbin", "bin", "root",
  "home", "users", "system", "library", "volumes", "applications", "mnt", "media", "run", "srv", "boot",
])

export function resolveSessionFileReference(reference: string, directory: string): ResolvedSessionFileReference | null {
  let value = reference.trim()
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return null

  const lineMatch = LINE_SUFFIX_RE.exec(value)
  let line: number | undefined
  let endLine: number | undefined
  if (lineMatch) {
    const start = Number(lineMatch[1] ?? lineMatch[3])
    const rawEndText = lineMatch[2] ?? lineMatch[4]
    const rawEnd = rawEndText ? Number(rawEndText) : undefined
    line = Math.min(start, rawEnd ?? start)
    if (rawEnd !== undefined && rawEnd !== start) endLine = Math.max(start, rawEnd)
    value = value.slice(0, lineMatch.index)
  }

  const wasFileUrl = /^file:\/\//i.test(value)
  const wasWindowsDrive = /^[a-z]:[\\/]/i.test(value)

  if (wasFileUrl) {
    try {
      const url = new URL(value)
      if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null
      value = url.pathname.replace(/^\/(\w:\/)/, "$1")
    } catch { return null }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !wasWindowsDrive) {
    return null
  }
  try { value = decodeURIComponent(value) } catch { /* 文件名中可能直接包含 %。 */ }
  value = value.replaceAll("\\", "/")
  const root = directory.replaceAll("\\", "/").replace(/\/+$/, "") || "/"
  if (!directory || /[\u0000-\u001f\u007f]/u.test(value)) return null
  if (value.startsWith("//")) return null

  const absolute = value.startsWith("/") || /^[a-z]:\//i.test(value)
  let exact = absolute || value.startsWith("./") || value.includes("/")
  if (absolute) {
    const prefix = root === "/" ? "/" : `${root}/`
    const inside = /^[a-z]:\//i.test(prefix)
      ? value.toLowerCase().startsWith(prefix.toLowerCase())
      : value.startsWith(prefix)
    if (inside) {
      value = value.slice(prefix.length)
    } else {
      if (wasFileUrl || wasWindowsDrive || /^[a-z]:\//i.test(value) || root === "/") return null
      const firstSeg = value.replace(/^\/+/, "").split("/")[0] ?? ""
      const rootFirstSeg = root.replace(/^\/+/, "").split("/")[0] ?? ""
      if (!firstSeg || (rootFirstSeg && firstSeg.toLowerCase() === rootFirstSeg.toLowerCase()) || HOST_SYSTEM_ROOTS.has(firstSeg.toLowerCase())) {
        return null
      }
      // 模型常以 `/README.md:34`、`/src/index.ts` 等斜杠开头形式引用当前项目根目录下的文件。
      value = value.replace(/^\/+/, "")
      exact = true
    }
  } else {
    value = value.replace(/^(?:\.\/)+/, "")
  }
  if (!value || value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null
  return {
    path: value,
    exact,
    ...(line !== undefined ? { line } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  }
}
