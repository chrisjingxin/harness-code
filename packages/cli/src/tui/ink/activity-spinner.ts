/** 全屏 TUI 活动态指示器：仅在当前活动内容存在时触发局部刷新。 */
import { useEffect, useState } from "react"

const ACTIVITY_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const

/** 返回固定单元格宽度的活动 glyph；非活动态不创建计时器。 */
export function useActivitySpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setFrame(current => (current + 1) % ACTIVITY_SPINNER_FRAMES.length), 120)
    return () => clearInterval(timer)
  }, [active])

  return active ? ACTIVITY_SPINNER_FRAMES[frame] : "•"
}
