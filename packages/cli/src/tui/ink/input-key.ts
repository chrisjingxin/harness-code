/** Ink 终端按键兼容规则。 */
import type { Key } from "ink"

/** Ink 6.8 将多数终端的 Backspace（DEL/0x7f）报告为 delete。 */
export function isInkBackspace(key: Pick<Key, "backspace" | "delete">): boolean {
  return key.backspace || key.delete
}
