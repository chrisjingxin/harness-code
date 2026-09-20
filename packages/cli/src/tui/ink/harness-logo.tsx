/** Harness Code 品牌 ASCII Logo 与欢迎卡片字标。 */
/** @jsxImportSource react */
import { Box, Text } from "ink"
import React from "react"

import { tuiTheme } from "../presentation/theme"

/** 3行精巧半格字符字形（来自 MiMo / za38 经典设计）。 */
const LOGO_FONT: Record<string, [string, string, string]> = {
  H: ["█  █", "█▀▀█", "▀  ▀"],
  A: ["█▀▀█", "█▀▀█", "▀  ▀"],
  R: ["█▀▀▄", "█▀▀▄", "▀  ▀"],
  N: ["█▄ █", "█ ▀█", "▀  ▀"],
  E: ["█▀▀▀", "█▀▀ ", "▀▀▀▀"],
  S: ["▄▀▀▀", " ▀▀▄", "▀▀▀ "],
  C: ["█▀▀▀", "█   ", "▀▀▀▀"],
  O: ["▄▀▀▄", "█  █", " ▀▀ "],
  D: ["█▀▀▄", "█  █", "▀▀▀ "],
}

function rasterize(word: string): [string, string, string] {
  const r0 = word.split("").map(c => LOGO_FONT[c]?.[0] ?? "    ").join(" ")
  const r1 = word.split("").map(c => LOGO_FONT[c]?.[1] ?? "    ").join(" ")
  const r2 = word.split("").map(c => LOGO_FONT[c]?.[2] ?? "    ").join(" ")
  return [r0, r1, r2]
}

const HARNESS_ROWS = rasterize("HARNESS")
const CODE_ROWS = rasterize("CODE")

/** 完整 ASCII Logo 宽度：34 (HARNESS) + 2 (空格) + 19 (CODE) = 55 */
export const FULL_LOGO_WIDTH = 55

/**
 * 渲染 Harness Code 品牌 Logo。
 * - width >= 60: 渲染 3 行方块字符艺术字标 + powered by za38
 * - width < 60: 渲染紧凑单行高亮字标
 */
export function HarnessCodeLogo(props: { width: number }) {
  if (props.width < 60) {
    return (
      <Box flexDirection="row">
        <Text color={tuiTheme.brand} bold>❯ HARNESS </Text>
        <Text bold>CODE</Text>
        <Text dimColor> · powered by </Text>
        <Text color={tuiTheme.brand}>za38</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginY={1}>
      {[0, 1, 2].map(rowIndex => (
        <Box key={rowIndex} flexDirection="row">
          <Text color={tuiTheme.brand} bold>{HARNESS_ROWS[rowIndex]}</Text>
          <Text> </Text>
          <Text bold>{CODE_ROWS[rowIndex]}</Text>
        </Box>
      ))}
      <Box justifyContent="flex-start" paddingLeft={2}>
        <Text dimColor>powered by </Text>
        <Text color={tuiTheme.brand}>za38</Text>
      </Box>
    </Box>
  )
}
