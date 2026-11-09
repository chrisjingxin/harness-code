/** 从唯一公共 CSS 色表生成原生窗口颜色；主进程不需要加载 React 或 CSS。 */
import { readFile, rm, writeFile } from "node:fs/promises"

const source = new URL("../../packages/workbench-ui/src/theme/colors.css", import.meta.url)
const js = new URL("../../packages/workbench-ui/dist/native-theme.js", import.meta.url)
const types = new URL("../../packages/workbench-ui/dist/native-theme.d.ts", import.meta.url)

// 若色表不合法，移除上次生成物，避免后续构建误用已经过期的颜色。
await Promise.all([rm(js, { force: true }), rm(types, { force: true })])
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
const jsContent = `/** 由公共 CSS 生成；请修改色表而不是此产物。 */\nexport const nativeTheme = Object.freeze({\n  light: Object.freeze(${JSON.stringify(colors.light)}),\n  dark: Object.freeze(${JSON.stringify(colors.dark)}),\n})\n`
const typesContent = `/** 从公共主题生成的原生背景及文字颜色。 */\nexport declare const nativeTheme: Readonly<{\n  light: Readonly<{ background: string; text: string }>\n  dark: Readonly<{ background: string; text: string }>\n}>\n`
await Promise.all([writeFile(js, jsContent), writeFile(types, typesContent)])
