/** Ink 时间线投影：终态条目只交给 Static 一次，流式条目留在 live region。 */
import type { TimelineItem } from "../../interactive/state"

export type TimelineProjection = {
  committed: TimelineItem[]
  live: TimelineItem[]
}

export class TimelineProjector {
  private readonly committedIds = new Set<string>()

  /** 重复 snapshot 不重复产出；live 转终态时只 commit 一次。 */
  update(items: readonly TimelineItem[]): TimelineProjection {
    const committed: TimelineItem[] = []
    const live: TimelineItem[] = []
    for (const item of items) {
      const id = timelineItemId(item)
      if (isLive(item)) {
        if (!this.committedIds.has(id)) live.push(item)
        continue
      }
      if (this.committedIds.has(id)) continue
      this.committedIds.add(id)
      committed.push(item)
    }
    return { committed, live }
  }
}

/** 不使用数组下标，避免 resize/恢复后身份漂移。 */
export function timelineItemId(item: TimelineItem): string {
  switch (item.type) {
    case "message": return `message:${item.message.id}`
    case "tool": return `tool:${item.tool.id}`
    case "reasoning": return `reasoning:${item.reasoning.id}`
    case "interaction": return `interaction:${item.interaction.id}`
    case "compose-summary": return `compose-summary:${item.summary.id}`
    case "goal-evaluation": return `goal-evaluation:${item.evaluation.id}`
  }
}

function isLive(item: TimelineItem): boolean {
  switch (item.type) {
    case "message": return item.message.streaming === true
    case "tool": return item.tool.status === "running"
    case "reasoning": return item.reasoning.active
    case "interaction": return item.interaction.status === "pending"
    case "goal-evaluation": return item.evaluation.phase === "checking"
    case "compose-summary": return false
  }
}
