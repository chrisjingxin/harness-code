/** HC-190 主题契约：颜色集中、品牌可替换及真实派生色的阅读对比度。 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const presentation = new URL("../../../src/web/presentation/", import.meta.url)
const read = (name: string) => readFileSync(new URL(name, presentation), "utf8")

function declarations(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]))
}

function theme(mode: "light" | "dark", brand?: string): Record<string, string> {
  const css = read("theme.css")
  const base = css.match(/\.web-shell\s*\{([^}]+)\}/)?.[1] ?? ""
  const block = css.match(new RegExp(`\\.web-shell\\[data-theme="${mode}"\\]\\s*\\{([^}]+)\\}`))?.[1] ?? ""
  expect(block).not.toBe("")
  return { ...declarations(base), ...declarations(block), ...(brand ? { "--brand": brand } : {}) }
}

type Color = [number, number, number]
/** 解析本主题使用的 hex/var/sRGB mix，独立计算最终色而不是只比较 CSS 字符串。 */
function color(value: string, tokens: Record<string, string>, depth = 0): Color {
  if (depth > 12) throw new Error(`循环颜色引用：${value}`)
  if (value.startsWith("--")) return color(tokens[value]!, tokens, depth + 1)
  const variable = /^var\((--[\w-]+)\)$/.exec(value)
  if (variable) return color(variable[1]!, tokens, depth + 1)
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex) return [0, 2, 4].map(offset => parseInt(hex[1]!.slice(offset, offset + 2), 16)) as Color
  const mix = /^color-mix\(in srgb, (.+) ([\d.]+)%, (.+)\)$/.exec(value)
  if (mix) {
    const a = color(mix[1]!, tokens, depth + 1), b = color(mix[3]!, tokens, depth + 1), weight = Number(mix[2]) / 100
    return a.map((channel, index) => channel * weight + b[index]! * (1 - weight)) as Color
  }
  throw new Error(`未解析颜色：${value}`)
}

function luminance(rgb: Color): number {
  const linear = rgb.map(channel => { const c = channel / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 })
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722
}
function contrast(a: Color, b: Color): number {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}

test("主题单独导入，组件及 SVG 无硬编码品牌色，颜色引用完整", () => {
  const entry = readFileSync(new URL("../app.tsx", presentation), "utf8")
  expect(entry.indexOf('import "./presentation/theme.css"')).toBeGreaterThanOrEqual(0)
  expect(entry.indexOf('import "./presentation/theme.css"')).toBeLessThan(entry.indexOf('import "./presentation/styles.css"'))
  const styles = read("styles.css"), tokens = read("theme.css")
  expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  expect(styles).not.toContain('.web-shell[data-theme="light"] {')
  expect(styles).not.toContain('.web-shell[data-theme="dark"] {')
  expect(read("brand-logo.tsx")).not.toMatch(/stopColor="#[0-9a-f]+"/i)
  const defined = new Set([...`${tokens}\n${styles}`.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]))
  for (const match of `${tokens}\n${styles}`.matchAll(/var\((--[\w-]+)/g)) expect(defined.has(match[1])).toBe(true)
  const light = theme("light"), dark = theme("dark")
  expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort())
  expect(color("--action", light)).toEqual([108, 60, 240])
  expect(color("--bg", light)).toEqual([255, 255, 255])
})

test("替换一个品牌变量会改变交互/标志色，不改变消息/成功/错误/Diff语义", () => {
  for (const mode of ["light", "dark"] as const) {
    const original = theme(mode), changed = theme(mode, "#1468d4")
    for (const name of ["--accent", "--action", "--accent-hover", "--thread-selected-bg", "--compose-current-bg"]) {
      expect(color(name, original)).not.toEqual(color(name, changed))
    }
    for (const name of ["--bg", "--message-user-bg", "--success", "--danger", "--diff-add-bg", "--diff-remove-bg"]) {
      expect(color(name, original)).toEqual(color(name, changed))
    }
  }
})

test("浅深主题必要文字达到 AA，暗色选中与未选中侧栏有明确亮度差", () => {
  for (const mode of ["light", "dark"] as const) {
    const tokens = theme(mode)
    for (const [foreground, background] of [
      ["--text", "--bg"], ["--text", "--message-user-bg"], ["--text-soft", "--surface-2"],
      ["--muted", "--sidebar-bg"], ["--text", "--thread-selected-bg"], ["--muted", "--thread-selected-bg"],
      ["--action-text", "--action"], ["--action-text", "--action-hover"], ["--link-text", "--bg"],
      ["--success-text", "--surface"], ["--warning-text", "--surface"], ["--danger-text", "--surface"],
      ["--compose-current-fg", "--compose-current-bg"], ["--compose-wait", "--bg"],
    ]) {
      expect(contrast(color(foreground!, tokens), color(background!, tokens))).toBeGreaterThanOrEqual(4.5)
    }
  }
  const dark = theme("dark")
  expect(contrast(color("--thread-selected-bg", dark), color("--sidebar-bg", dark))).toBeGreaterThanOrEqual(1.8)
})

test("每种 Trace 类型使用不同色相，浅色标签在双主题下可读且不随品牌漂移", () => {
  const light = theme("light")
  expect(color("--trace-root", light)).toEqual([26, 115, 147])
  expect(color("--trace-run", light)).toEqual([65, 118, 230])
  expect(color("--trace-func", light)).toEqual([165, 29, 156])
  expect(color("--trace-agent", light)).toEqual([156, 28, 88])
  expect(color("--trace-llm", light)).toEqual([120, 104, 201])
  const kinds = ["root", "run", "func", "agent", "node", "llm", "tool", "retriever", "rerank", "embedding", "interaction", "policy", "db", "context", "unknown"]
  for (const mode of ["light", "dark"] as const) {
    const tokens = theme(mode)
    const seen = new Set<string>()
    for (const kind of kinds) {
      seen.add(color(`--trace-${kind}`, tokens).join(","))
      const foreground = `color-mix(in srgb, var(--trace-${kind}) 64%, var(--text))`
      const background = `color-mix(in srgb, var(--trace-${kind}) 18%, var(--surface))`
      expect(contrast(color(foreground, tokens), color(background, tokens))).toBeGreaterThanOrEqual(4.5)
    }
    expect(seen.size).toBe(kinds.length)
    const changed = theme(mode, "#1468d4")
    expect(color("--trace-run", tokens)).toEqual(color("--trace-run", changed))
    for (const status of ["success", "failed", "error", "running"]) {
      expect(color(`--trace-${status}`, tokens)).toEqual(color(`--trace-${status}`, changed))
    }
  }
})
