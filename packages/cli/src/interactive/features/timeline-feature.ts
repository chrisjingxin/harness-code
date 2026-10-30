/** Timeline Feature：负责把 Agent 事件流增量投影到 Timeline；sequence 校验由 state.ts 的 acceptSequence 唯一负责。 */

import type { EventEnvelope } from "@za38/protocol"
import { applyAgentEvent } from "../state"
import type { FeatureContext } from "./types"

export class TimelineFeature {
  processAgentEvent(event: EventEnvelope, ctx: FeatureContext): void {
    ctx.commit(current => applyAgentEvent(current, event, ctx.idGenerator))
  }
}
