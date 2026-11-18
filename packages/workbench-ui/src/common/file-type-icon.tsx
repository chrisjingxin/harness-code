/** 文件类型图标：按文件名选择原有图形和语义色，供文件树与对话路径共同使用。 */
import { Braces, CodeXml, Database, File, FileCode, FileImage, FileJson, FileText, Terminal } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ReactElement } from "react"

/** 文件类型只用于显示，不表示文件可读取或可执行。 */
export type FileIconType = "ts" | "js" | "python" | "go" | "rust" | "shell" | "code" | "style" | "html" | "json" | "doc" | "config" | "data" | "image" | "default"

export type FileIconSpec = {
  readonly type: FileIconType
  readonly icon: LucideIcon
  readonly label?: string
}

const EXTENSION_TYPES: Record<string, FileIconType> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "python", sh: "shell", bash: "shell", zsh: "shell", rb: "code", go: "go", rs: "rust",
  java: "code", c: "code", cc: "code", cpp: "code", h: "code", hpp: "code",
  cs: "code", php: "code", lua: "code", r: "code", swift: "code", kt: "code", kts: "code",
  css: "style", scss: "style", less: "style", sass: "style", html: "html", htm: "html",
  vue: "style", svelte: "style",
  md: "doc", mdx: "doc", txt: "doc", rst: "doc", adoc: "doc",
  json: "json", jsonc: "json", json5: "json", toml: "config", yaml: "config", yml: "config",
  ini: "config", env: "config", cfg: "config", conf: "config", lock: "config",
  sql: "data", csv: "data", xml: "config",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image",
  webp: "image", ico: "image", avif: "image", bmp: "image",
}

const SPECIAL_NAME_TYPES: Record<string, FileIconType> = {
  dockerfile: "config", makefile: "config", ".gitignore": "config", ".gitattributes": "config",
  ".editorconfig": "config", license: "doc", readme: "doc",
}

const TYPE_ICONS: Record<FileIconType, LucideIcon> = {
  ts: FileCode, js: FileCode, python: FileCode, go: FileCode, rust: FileCode,
  shell: Terminal, code: FileCode, style: Braces, html: CodeXml, json: Braces,
  doc: FileText, config: FileJson, data: Database, image: FileImage, default: File,
}

const TYPE_LABELS: Partial<Record<FileIconType, string>> = { ts: "TS", js: "JS", python: "Py", go: "Go", rust: "Rs" }

/** 仅按文件名推导显示图标；大小写不敏感，特殊文件名优先。 */
export function fileIconFor(name: string): FileIconSpec {
  const lower = (name.replaceAll("\\", "/").split("/").at(-1) ?? "").toLowerCase()
  // 文件名可能恰好是对象原型属性，只能采用映射表自己声明的键。
  const special = Object.hasOwn(SPECIAL_NAME_TYPES, lower) ? SPECIAL_NAME_TYPES[lower] : undefined
  const dot = lower.lastIndexOf(".")
  const ext = dot >= 0 ? lower.slice(dot + 1) : ""
  const type = special ?? (Object.hasOwn(EXTENSION_TYPES, ext) ? EXTENSION_TYPES[ext] : undefined) ?? "default"
  return { type, icon: TYPE_ICONS[type], label: TYPE_LABELS[type] }
}

/** 装饰性图标的类型色由公共样式映射到同一套主题变量。 */
export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }): ReactElement {
  const spec = fileIconFor(name)
  const Icon = spec.icon
  if (spec.label) return <span aria-hidden="true" className={`wb-file-type-icon wb-file-type-badge wb-file-type-icon-${spec.type}`} style={{ width: size, height: size }}>{spec.label}</span>
  return <Icon aria-hidden="true" size={size} className={`wb-file-type-icon wb-file-type-icon-${spec.type}`} />
}
