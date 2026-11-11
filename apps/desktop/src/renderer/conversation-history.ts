/**
 * 把一页已提交事件顺序投影为消息和执行状态。
 * 输入是同一会话与固定历史上界；只有整页校验成功才返回新游标。
 */
import type { ExecutionView, HistoryResponse, Message } from "@workbench/contracts"
import type { ConversationTimelineEntry } from "@workbench/ui"

export interface HistoryProjection {
  cursor: string
  contentRevision: number
  messages: Readonly<Record<string, Message>>
  messageOrder: readonly string[]
  executions: Readonly<Record<string, ExecutionView>>
  latestExecutionId: string | null
  eventIds: ReadonlySet<string>
}

export function emptyHistory(): HistoryProjection {
  return { cursor: "0", contentRevision: 0, messages: {}, messageOrder: [], executions: {}, latestExecutionId: null, eventIds: new Set() }
}

const SEQUENCE = /^(?:0|[1-9][0-9]{0,18})$/
const MAX_SEQUENCE = 9_223_372_036_854_775_807n

function sequence(value: string): bigint {
  if (!SEQUENCE.test(value)) throw new Error("历史位置无效")
  const result = BigInt(value)
  if (result > MAX_SEQUENCE) throw new Error("历史位置超出范围")
  return result
}

/** 新到的消息才增加内容版本，首次重放历史不改变阅读基线。 */
export function applyHistoryPage(
  previous: HistoryProjection,
  page: HistoryResponse,
  workspaceId: string,
  conversationId: string,
  throughSequence: string,
  countNewContent: boolean,
): HistoryProjection {
  const through = sequence(throughSequence)
  let cursor = sequence(previous.cursor)
  if (page.conversationId !== conversationId || page.throughSequence !== throughSequence || cursor > through) throw new Error("历史范围不一致")
  const messages = { ...previous.messages }
  const messageOrder = [...previous.messageOrder]
  const executions = { ...previous.executions }
  const eventIds = new Set(previous.eventIds)
  let latestExecutionId = previous.latestExecutionId
  let contentRevision = previous.contentRevision

  for (const event of page.events) {
    if (event.workspaceId !== workspaceId || event.conversationId !== conversationId
      || sequence(event.sequence) !== cursor + 1n || eventIds.has(event.messageId)) throw new Error("历史事件不连续")
    eventIds.add(event.messageId)
    cursor++
    if (cursor > through) throw new Error("历史事件超出读取上界")
    if (event.type === "conversation.created") {
      if (event.payload.conversation.workspaceId !== workspaceId || event.payload.conversation.conversationId !== conversationId) throw new Error("会话范围不一致")
    } else if (event.type === "message.created") {
      const message = event.payload.message
      if (message.conversationId !== conversationId || message.createdSequence !== event.sequence || messages[message.messageId]) throw new Error("消息创建事件不一致")
      messages[message.messageId] = message
      messageOrder.push(message.messageId)
      if (countNewContent) contentRevision++
    } else if (event.type === "message.text.appended" || event.type === "message.closed") {
      const message = messages[event.payload.messageId]
      if (!message || message.executionId !== event.payload.executionId || message.author.kind !== "agent" || message.state !== "streaming") throw new Error("消息更新事件不一致")
      messages[message.messageId] = event.type === "message.text.appended"
        ? { ...message, text: message.text + event.payload.text }
        : { ...message, state: event.payload.state }
      if (countNewContent) contentRevision++
    } else {
      const execution = event.payload.execution
      if (execution.conversationId !== conversationId || !messages[execution.inputId]) throw new Error("执行状态与会话不一致")
      executions[execution.executionId] = execution
      latestExecutionId = execution.executionId
    }
  }
  if (page.nextAfterSequence !== cursor.toString() || page.hasMore !== (cursor < through)) throw new Error("历史分页位置不一致")
  return { cursor: cursor.toString(), contentRevision, messages, messageOrder, executions, latestExecutionId, eventIds }
}

/** 在事件顺序中保留消息 ID、原作者和创建时间。 */
export function historyEntries(projection: HistoryProjection): ConversationTimelineEntry[] {
  return projection.messageOrder.map(id => {
    const message = projection.messages[id]
    return {
      kind: "message",
      id: message.messageId,
      role: message.author.kind === "user" ? "user" : "assistant",
      ...(message.author.kind === "user" ? { author: { id: message.author.userId, displayName: message.author.displayName } } : {}),
      text: message.text,
      createdAtMs: Date.parse(message.createdAt),
      streaming: message.state === "streaming",
    }
  })
}

export function latestExecution(projection: HistoryProjection): ExecutionView | null {
  return projection.latestExecutionId ? projection.executions[projection.latestExecutionId] ?? null : null
}
