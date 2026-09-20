/** Ink 终端按键兼容规则。 */
import type { Key } from "ink"

/** Ink 6.8 将多数终端的 Backspace（DEL/0x7f）报告为 delete。 */
export function isInkBackspace(key: Pick<Key, "backspace" | "delete">): boolean {
  return key.backspace || key.delete
}

const SGR_MOUSE_COMPLETE = /(?:\u001b)?\[<[0-9]+;[0-9]+;[0-9]+[Mm]/g
const SGR_MOUSE_PREFIX = /^(?:\u001b)?\[<[0-9]/

/** Ink 会剥掉输入序列开头的 ESC；单条、多条连发或分块截断的 SGR 报文均视为终端鼠标报告。 */
export function isInkMouseReport(input: string): boolean {
  if (!input) return false
  if (/^(?:\u001b)?\[<[0-9;]+[Mm]$/.test(input)) return true
  const stripped = input.replace(SGR_MOUSE_COMPLETE, "")
  if (stripped === "") return true
  if (SGR_MOUSE_PREFIX.test(input) && /^(?:\u001b)?\[<?[0-9;]*$/.test(stripped)) {
    return true
  }
  if (/^(?:\u001b)?\[<[0-9;]+$/.test(input)) return true
  return false
}

/** 剥离输入字符串中夹带的全部完整 SGR 鼠标报告及尾随残片，避免按键与鼠标报文并包时污染文本。 */
export function stripMouseReports(input: string): string {
  if (!input) return ""
  const hadComplete = /(?:\u001b)?\[<[0-9]+;[0-9]+;[0-9]+[Mm]/.test(input)
  const stripped = input.replace(SGR_MOUSE_COMPLETE, "")
  if (hadComplete) {
    return stripped.replace(/(?:\u001b)?\[<?[0-9;]*$/, "")
  }
  return stripped.replace(/^(?:\u001b)?\[<[0-9;]*$/, "")
}
