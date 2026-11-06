/**
 * `ReplayBuffer`：`session/load` 回放期间的 update 收进缓冲，按
 * messageId 把同一条消息的连续块拼回去，产出 `ThreadsOpenResult.messages`
 * 用的 `ThreadMessage[]`。纯状态机，不做 I/O。
 *
 * 回放规则（设计 §4.6）：`user_message_chunk` / `agent_message_chunk`
 * 文本按 kind 成消息、同 `messageId` 的连续块拼接（Python 对超 64 KiB 的
 * 消息切块共用 messageId）；`tool_call`（回放里一律 completed）取
 * `title` 首段作 tool_name、第一个文本块作 content；`created_at_ms`
 * 一律省略（控制器只在存在时使用）。其它 update 忽略。
 */

import type { ThreadMessage } from "@za38/protocol"

import { nameOf, updateText, type AcpSessionUpdate } from "./translate"

export class ReplayBuffer {
  readonly messages: ThreadMessage[] = []
  /** 上一条消息及其 messageId：同 id 的连续块拼到它后面，不同 id 开新条。 */
  private last: { messageId: string; index: number } | null = null

  accept(update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined
        if (content?.type !== "text" || !content.text) return
        const kind = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant"
        const messageId = update.messageId ?? ""
        if (this.last && this.last.messageId === messageId && messageId !== "") {
          this.messages[this.last.index]!.content += content.text
          return
        }
        this.messages.push({ kind, content: content.text })
        this.last = { messageId, index: this.messages.length - 1 }
        return
      }
      case "tool_call": {
        // 回放里的 tool_call 一律 completed；不同 id 断开拼接状态。
        this.last = null
        const text = updateText(update.content) ?? ""
        if (!text) return
        this.messages.push({
          kind: "tool",
          tool_name: nameOf(update.title, update.toolCallId, update._meta),
          content: text,
        })
        return
      }
      default:
        // tool_call_update / agent_thought_chunk / session_info_update 等忽略。
        return
    }
  }
}
