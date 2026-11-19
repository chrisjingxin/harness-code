/** 从唯一公共 CSS 色表生成原生窗口颜色；主进程不需要加载 React 或 CSS。 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const source = new URL("../../desktop/src/ui/theme/colors.css", import.meta.url)
const output = new URL("../../desktop/src/shared/native-theme.ts", import.meta.url)

// 若色表不合法，移除上次生成物，避免后续构建误用已经过期的颜色。
await rm(output, { force: true })
const css = (await readFile(source, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "")
const colors = {}
for (const mode of ["light", "dark"]) {
  const blocks = [...css.matchAll(new RegExp(`:root\\[data-theme="${mode}"\\]\\s*\\{([^{}]*)\\}`, "g"))]
  if (blocks.length !== 1) throw new Error(`主题 ${mode} 必须有且只有一组颜色定义`)
  const block = blocks[0][1]
  const values = {}
  for (const [property, name] of [["--bg", "background"], ["--text", "text"]]) {
    const matches = [...block.matchAll(new RegExp(`${property}\\s*:\\s*([^;]+);`, "g"))]
    const value = matches[0]?.[1].trim()
    if (matches.length !== 1 || !/^#[0-9a-f]{6}$/i.test(value ?? "")) {
      throw new Error(`主题 ${mode} 的 ${property} 必须唯一且为六位十六进制颜色`)
    }
    values[name] = value
  }
  colors[mode] = values
}
await mkdir(dirname(fileURLToPath(output)), { recursive: true })
const content = `/** 由公共 CSS 生成；请修改色表而不是此产物。 */
export const nativeTheme = Object.freeze({
  light: Object.freeze(${JSON.stringify(colors.light)}),
  dark: Object.freeze(${JSON.stringify(colors.dark)}),
})
`
await writeFile(output, content, "utf8")
