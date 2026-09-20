/** TimelineViewport 的纯布局、锚点与滚动行为测试。 */
import { describe, expect, it } from "vitest"

import stringWidth from "string-width"

import {
  applyViewportAction,
  createViewportState,
  isViewportTooSmall,
  layoutViewport,
  updateViewport,
  type TimelineViewportEntry,
  type TimelineViewportSize,
} from "../../src/tui/ink/timeline-viewport"

const size = (columns: number, rows: number): TimelineViewportSize => ({ columns, rows })
const entry = (id: string, text: string): TimelineViewportEntry => ({ id, text })

function update(
  state: ReturnType<typeof createViewportState>,
  entries: readonly TimelineViewportEntry[],
  viewportSize: TimelineViewportSize,
  threadId = state.threadId,
) {
  return updateViewport(state, entries, viewportSize, threadId)
}

describe("TimelineViewport", () => {
  it("lays out empty and single entries without inventing rows", () => {
    const empty = update(createViewportState("thread-a"), [], size(72, 17))

    expect(empty.layout).toMatchObject({
      visibleRows: [],
      totalRows: 0,
      offset: 0,
      followTail: true,
      unseenCount: 0,
      tooSmall: false,
    })

    const single = update(empty.state, [entry("one", "hello")], size(72, 17))
    expect(single.layout.visibleRows).toEqual([
      expect.objectContaining({ entryId: "one", row: 0, text: "hello" }),
    ])
    expect(single.layout.totalRows).toBe(1)
  })

  it("wraps visual rows by terminal cells at 40, 72, and 120 columns", () => {
    const text = "x".repeat(121)

    for (const columns of [40, 72, 120]) {
      for (const rows of [12, 17, 24]) {
        const result = update(createViewportState("thread-a"), [entry("long", text)], size(columns, rows))
        expect(result.layout.totalRows).toBe(Math.ceil(text.length / columns))
        expect(result.layout.visibleRows.length).toBeLessThanOrEqual(rows)
        expect(result.layout.visibleRows.every(row => stringWidth(row.text) <= columns)).toBe(true)
      }
    }
  })

  it("does not split CJK, emoji, or combining graphemes while wrapping", () => {
    const text = "中🙂e\u0301"
    const result = update(createViewportState("thread-a"), [entry("unicode", text)], size(2, 12))

    expect(result.layout.visibleRows.map(row => row.text)).toEqual(["中", "🙂", "e\u0301"])
    expect(result.layout.visibleRows.every(row => stringWidth(row.text) <= 2)).toBe(true)
  })

  it("moves pages with one visual row of overlap and restores tail following at the end", () => {
    const entries = Array.from({ length: 30 }, (_, index) => entry(`line-${index}`, `line ${index}`))
    const initial = update(createViewportState("thread-a"), entries, size(72, 12))
    expect(initial.layout.offset).toBe(18)

    const pageUp = applyViewportAction(initial.state, "page-up", entries, size(72, 12))
    expect(pageUp.layout.offset).toBe(7)
    expect(pageUp.layout.visibleRows[0]?.text).toBe("line 7")
    expect(pageUp.layout.visibleRows.at(-1)?.text).toBe("line 18")
    expect(pageUp.layout.followTail).toBe(false)

    const pageDown = applyViewportAction(pageUp.state, "page-down", entries, size(72, 12))
    expect(pageDown.layout.offset).toBe(18)
    expect(pageDown.layout.followTail).toBe(true)
    expect(pageDown.layout.unseenCount).toBe(0)
  })

  it("supports top and bottom actions independently of ordinary input navigation", () => {
    const entries = Array.from({ length: 30 }, (_, index) => entry(`line-${index}`, `line ${index}`))
    const initial = update(createViewportState("thread-a"), entries, size(72, 12))

    const top = applyViewportAction(initial.state, "top", entries, size(72, 12))
    expect(top.layout.offset).toBe(0)
    expect(top.layout.followTail).toBe(false)

    const bottom = applyViewportAction(top.state, "bottom", entries, size(72, 12))
    expect(bottom.layout.offset).toBe(18)
    expect(bottom.layout.followTail).toBe(true)
  })

  it("moves mouse wheel actions by three visual rows without stealing tail state", () => {
    const entries = Array.from({ length: 30 }, (_, index) => entry(`line-${index}`, `line ${index}`))
    const initial = update(createViewportState("thread-a"), entries, size(72, 12))

    const up = applyViewportAction(initial.state, "scroll-up", entries, size(72, 12))
    expect(up.layout.offset).toBe(15)
    expect(up.layout.followTail).toBe(false)

    const down = applyViewportAction(up.state, "scroll-down", entries, size(72, 12))
    expect(down.layout.offset).toBe(18)
    expect(down.layout.followTail).toBe(true)
  })

  it("keeps a scrolled anchor and counts appended content until returning to bottom", () => {
    const original = Array.from({ length: 30 }, (_, index) => entry(`line-${index}`, `line ${index}`))
    const initial = update(createViewportState("thread-a"), original, size(72, 12))
    const scrolled = applyViewportAction(initial.state, "page-up", original, size(72, 12))
    const streamed = original.map(item => item.id === "line-7" ? entry(item.id, "line 7 updated") : item)
    const appended = [...streamed, entry("line-30", "line 30"), entry("line-31", "line 31")]

    const changed = update(scrolled.state, appended, size(72, 12))
    expect(changed.layout.offset).toBe(scrolled.layout.offset)
    expect(changed.layout.visibleRows[0]?.entryId).toBe("line-7")
    expect(changed.layout.unseenCount).toBe(3)

    const bottom = applyViewportAction(changed.state, "bottom", appended, size(72, 12))
    expect(bottom.layout.followTail).toBe(true)
    expect(bottom.layout.unseenCount).toBe(0)
    expect(bottom.layout.visibleRows.at(-1)?.entryId).toBe("line-31")
  })

  it("preserves the entry-relative anchor when height or wrapping width changes", () => {
    const entries = [
      entry("first", "first"),
      entry("middle", "m".repeat(80)),
      entry("last", "last"),
      entry("tail-1", "tail 1"),
      entry("tail-2", "tail 2"),
      entry("tail-3", "tail 3"),
    ]
    const initial = update(createViewportState("thread-a"), entries, size(40, 3))
    const scrolled = applyViewportAction(initial.state, "page-up", entries, size(40, 3))
    expect(scrolled.layout.visibleRows[0]?.entryId).toBe("middle")

    const taller = update(scrolled.state, entries, size(40, 5))
    expect(taller.layout.visibleRows[0]?.entryId).toBe("middle")

    const wider = update(taller.state, entries, size(72, 5))
    expect(wider.layout.visibleRows[0]?.entryId).toBe("middle")
    expect(wider.layout.anchor?.entryId).toBe("middle")
  })

  it("preserves an anchor when a completed tool is absorbed into a group", () => {
    const entries: TimelineViewportEntry[] = [
      entry("history", "history"),
      {
        id: "tool:first",
        text: "✓ 读取活动 · 2 项",
        aliases: ["tool:first", "tool:second"],
      },
      entry("tail", "tail"),
    ]
    const anchored = {
      ...createViewportState("thread-a"),
      followTail: false,
      anchor: { entryId: "tool:second", row: 0, cellOffset: 0 },
    }

    const result = update(anchored, entries, size(72, 2))

    expect(result.layout.visibleRows[0]?.entryId).toBe("tool:first")
    expect(result.layout.anchor?.entryId).toBe("tool:first")
  })

  it("keeps the same content offset instead of the old physical row after a width change", () => {
    const entries = [entry("long", "x".repeat(2_000))]
    const initial = update(createViewportState("thread-a"), entries, size(40, 3))
    const top = applyViewportAction(initial.state, "top", entries, size(40, 3))
    const scrolled = applyViewportAction(top.state, "page-down", entries, size(40, 3))

    expect(scrolled.layout.anchor?.cellOffset).toBe(80)
    const resized = update(scrolled.state, entries, size(72, 3))

    expect(resized.layout.anchor?.cellOffset).toBe(72)
    expect(resized.layout.visibleRows[0]?.cellOffset).toBe(72)
  })

  it("keeps consecutive blank lines as distinct content anchors", () => {
    const entries = [entry("multiline", "first\n\n\nlast\ntail\ntail2")]
    const initial = update(createViewportState("thread-a"), entries, size(40, 2))
    const top = applyViewportAction(initial.state, "top", entries, size(40, 2))
    const scrolled = applyViewportAction(top.state, "page-down", entries, size(40, 2))

    expect(scrolled.layout.offset).toBe(1)
    expect(scrolled.layout.visibleRows.map(row => row.text)).toEqual(["", ""])
  })

  it("resets follow-tail and unseen content when the thread identity changes", () => {
    const entries = Array.from({ length: 30 }, (_, index) => entry(`line-${index}`, `line ${index}`))
    const initial = update(createViewportState("thread-a"), entries, size(72, 12))
    const scrolled = applyViewportAction(initial.state, "top", entries, size(72, 12))
    const changed = update(scrolled.state, [entry("newest", "new thread")], size(72, 12), "thread-b")

    expect(changed.state.threadId).toBe("thread-b")
    expect(changed.layout.followTail).toBe(true)
    expect(changed.layout.unseenCount).toBe(0)
    expect(changed.layout.visibleRows.at(-1)?.entryId).toBe("newest")
  })

  it("clamps invalid sizes and exposes the too-small gate", () => {
    expect(isViewportTooSmall(size(39, 24))).toBe(true)
    expect(isViewportTooSmall(size(40, 11))).toBe(true)
    expect(isViewportTooSmall(size(40, 12))).toBe(false)

    const result = layoutViewport(
      [entry("one", "hello")],
      createViewportState("thread-a"),
      size(-10.5, Number.NaN),
    )

    expect(result.tooSmall).toBe(true)
    expect(result.offset).toBe(0)
  })

  it("does not prematurely wrap ANSI-styled lines and preserves right corner box borders", () => {
    // 40 列 ANSI 染色单行：可见宽度恰好 40，但含较长颜色转义序列
    const styledLine = "\u001b[38;5;75;1m" + "a".repeat(40) + "\u001b[0m"
    const singleRowResult = update(createViewportState("thread-a"), [entry("styled", styledLine)], size(40, 12))
    expect(singleRowResult.layout.totalRows).toBe(1)
    expect(singleRowResult.layout.visibleRows[0]?.width).toBe(40)

    // 80 列带语法高亮标签与边框：末尾 ╮ 不得被推挤到下一行
    const lang = "bash"
    const topLabel = `╭─ \u001b[38;5;75;1m${lang}\u001b[0m `
    const topFill = 80 - stringWidth(`╭─ ${lang} `) - 1
    const topBorder = `${topLabel}\u001b[90m${"─".repeat(topFill)}╮\u001b[0m`
    const bottomBorder = `\u001b[90m╰${"─".repeat(78)}╯\u001b[0m`
    const codeEntry = `${topBorder}\n\u001b[90m│\u001b[0m echo "hello"\n${bottomBorder}`

    const boxResult = update(createViewportState("thread-a"), [entry("box", codeEntry)], size(80, 12))
    expect(boxResult.layout.totalRows).toBe(3)
    expect(boxResult.layout.visibleRows[0]?.text).toContain("╮")
    expect(boxResult.layout.visibleRows[0]?.text).toContain("╭─")
    expect(boxResult.layout.visibleRows[1]?.text).toContain("echo \"hello\"")
    expect(boxResult.layout.visibleRows[2]?.text).toContain("╯")
    expect(boxResult.layout.visibleRows[2]?.text).toContain("╰")
  })
})

