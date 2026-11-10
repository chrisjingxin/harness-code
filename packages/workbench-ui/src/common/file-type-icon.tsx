/** 文件类型图标：按文件名选择原有图形和语义色，供文件树与对话路径共同使用。 */
import { File, FileCode, FileImage, FileJson, FileText } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ReactElement } from "react"

/** 文件类型只用于显示，不表示文件可读取或可执行。 */
export type FileIconType = "ts" | "js" | "code" | "style" | "doc" | "config" | "image" | "default"

export type FileIconSpec = {
  readonly type: FileIconType
  readonly icon: LucideIcon
}

const EXTENSION_TYPES: Record<string, FileIconType> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "code", sh: "code", bash: "code", zsh: "code", rb: "code", go: "code", rs: "code",
  java: "code", c: "code", cc: "code", cpp: "code", h: "code", hpp: "code",
  cs: "code", php: "code", lua: "code", r: "code", swift: "code", kt: "code", kts: "code",
  css: "style", scss: "style", less: "style", sass: "style", html: "style", htm: "style",
  vue: "style", svelte: "style",
  md: "doc", mdx: "doc", txt: "doc", rst: "doc", adoc: "doc",
  json: "config", jsonc: "config", json5: "config", toml: "config", yaml: "config", yml: "config",
  ini: "config", env: "config", cfg: "config", conf: "config", lock: "config",
  sql: "config", csv: "config", xml: "config",
  png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image",
  webp: "image", ico: "image", avif: "image", bmp: "image",
}

const SPECIAL_NAME_TYPES: Record<string, FileIconType> = {
  dockerfile: "config", makefile: "config", ".gitignore": "config", ".gitattributes": "config",
  ".editorconfig": "config", license: "doc", readme: "doc",
}

const TYPE_ICONS: Record<FileIconType, LucideIcon> = {
  ts: FileCode, js: FileCode, code: FileCode, style: FileCode,
  doc: FileText, config: FileJson, image: FileImage, default: File,
}

/** 仅按文件名推导显示图标；大小写不敏感，特殊文件名优先。 */
export function fileIconFor(name: string): FileIconSpec {
  const lower = name.toLowerCase()
  // 文件名可能恰好是对象原型属性，只能采用映射表自己声明的键。
  const special = Object.hasOwn(SPECIAL_NAME_TYPES, lower) ? SPECIAL_NAME_TYPES[lower] : undefined
  if (special) return { type: special, icon: TYPE_ICONS[special] }
  const dot = lower.lastIndexOf(".")
  const ext = dot >= 0 ? lower.slice(dot + 1) : ""
  const type = Object.hasOwn(EXTENSION_TYPES, ext) ? EXTENSION_TYPES[ext] ?? "default" : "default"
  return { type, icon: TYPE_ICONS[type] }
}

/** 装饰性图标的类型色由公共样式映射到同一套主题变量。 */
export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }): ReactElement {
  const spec = fileIconFor(name)
  const Icon = spec.icon
  return <Icon aria-hidden="true" size={size} className={`wb-file-type-icon wb-file-type-icon-${spec.type}`} />
}
