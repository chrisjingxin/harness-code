/** 将消息中的文件引用限制在当前会话已绑定的工作目录内；实际读取仍由本机宿主校验。 */
export function resolveSessionFileReference(reference: string, directory: string): { path: string; exact: boolean } | null {
  let value = reference.trim()
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return null
  value = value.replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/i, "")

  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null
      value = url.pathname.replace(/^\/(\w:\/)/, "$1")
    } catch { return null }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return null
  }
  try { value = decodeURIComponent(value) } catch { /* 文件名中可能直接包含 %。 */ }
  value = value.replaceAll("\\", "/")
  const root = directory.replaceAll("\\", "/").replace(/\/+$/, "") || "/"
  if (!directory || /[\u0000-\u001f\u007f]/u.test(value)) return null
  const absolute = value.startsWith("/") || /^[a-z]:\//i.test(value)
  const explicit = absolute || value.startsWith("./") || value.includes("/")
  if (absolute) {
    const prefix = root === "/" ? "/" : `${root}/`
    const inside = /^[a-z]:\//i.test(prefix)
      ? value.toLowerCase().startsWith(prefix.toLowerCase())
      : value.startsWith(prefix)
    if (!inside) return null
    value = value.slice(prefix.length)
  } else {
    value = value.replace(/^(?:\.\/)+/, "")
  }
  if (!value || value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null
  return { path: value, exact: explicit }
}
