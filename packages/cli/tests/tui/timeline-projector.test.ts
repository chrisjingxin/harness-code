/** Ink Static/live 时间线投影测试。 */
import { describe, expect, it } from "vitest"

import type { TimelineItem } from "../../src/interactive/state"
import { TimelineProjector } from "../../src/tui/ink/timeline-projector"

const message = (id: string, content: string, streaming = false): TimelineItem => ({
  type: "message",
  message: { id, role: "assistant", content, streaming },
})

describe("TimelineProjector", () => {
  it("keeps streaming updates live and commits the final item once", () => {
    const projector = new TimelineProjector()

    expect(projector.update([message("m1", "a", true)])).toEqual({ committed: [], live: [message("m1", "a", true)] })
    expect(projector.update([message("m1", "ab", true)])).toEqual({ committed: [], live: [message("m1", "ab", true)] })
    expect(projector.update([message("m1", "abc")])).toEqual({ committed: [message("m1", "abc")], live: [] })
    expect(projector.update([message("m1", "abc")])).toEqual({ committed: [], live: [] })
  })

  it("commits restored history once and handles a thousand entries", () => {
    const projector = new TimelineProjector()
    const restored = Array.from({ length: 1_000 }, (_, index) => message(`m${index}`, String(index)))

    expect(projector.update(restored).committed).toHaveLength(1_000)
    expect(projector.update(restored).committed).toHaveLength(0)
    expect(projector.update([...restored, message("live", "next", true)])).toEqual({
      committed: [],
      live: [message("live", "next", true)],
    })
  })

  it("keeps running tools and reasoning in the live region", () => {
    const projector = new TimelineProjector()
    const live: TimelineItem[] = [
      { type: "tool", tool: { id: "t", runId: "r", name: "read", arguments: "{}", output: "", status: "running" } },
      { type: "reasoning", reasoning: { id: "q", runId: "r", text: "thinking", active: true } },
    ]

    expect(projector.update(live)).toEqual({ committed: [], live })
  })
})
