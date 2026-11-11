/** 共享会话、消息、执行视图与展示事件的线上类型；字段顺序与 schema 一致，供确定性编码消费。 */
import type { ServerErrorCode } from "./identity.js"

export type Uuid = string
/** 十进制字符串，禁用 Number 承载。 */
export type Sequence = string
export type ShareVersion = string
export type UtcTimestamp = string

export interface ConversationSummary {
  conversationId: Uuid
  workspaceId: Uuid
  title: string
  createdByUserId: Uuid
  currentUserId: Uuid
  deviceId: Uuid
  projectId: Uuid
  agentConfigId: Uuid
  createdAt: UtcTimestamp
}

export type MessageState = "streaming" | "completed" | "interrupted"

export interface UserAuthor { kind: "user"; userId: Uuid; username: string; displayName: string }
export interface AgentAuthor { kind: "agent"; agentConfigId: Uuid }
export type MessageAuthor = UserAuthor | AgentAuthor

export interface Message {
  messageId: Uuid
  conversationId: Uuid
  executionId: Uuid
  author: MessageAuthor
  createdSequence: Sequence
  createdAt: UtcTimestamp
  text: string
  state: MessageState
}

export type ExecutionState = "queued" | "dispatching" | "accepted" | "running" | "unknown" | "succeeded" | "failed" | "cancelled" | "rejected"
export type CancelState = "none" | "requested" | "delivered" | "resolved"
export type ExecutionReasonCode =
  | "WAITING_DEVICE" | "WAITING_PREVIOUS" | "WAITING_PROJECT" | "WAITING_EXECUTOR"
  | "AUTHOR_UNAVAILABLE" | "PROJECT_NOT_SHARED" | "SHARE_VERSION_CHANGED" | "DEVICE_REVOKED" | "TARGET_INVALID"
  | "PROJECT_ROOT_CHANGED" | "CAPABILITY_UNAVAILABLE" | "CANCEL_REQUESTED" | "DELIVERY_UNCONFIRMED"
  | "DEVICE_DISCONNECTED" | "RUNNER_STATE_UNKNOWN" | "NATIVE_SESSION_UNAVAILABLE" | "EXECUTION_FAILED"
  | "CANCELLED_BEFORE_DISPATCH" | "CANCELLED_BY_RUNNER"

export interface ExecutionView {
  executionId: Uuid
  conversationId: Uuid
  inputId: Uuid
  inputSequence: Sequence
  initiatedByUserId: Uuid
  state: ExecutionState
  lastConfirmedState: ExecutionState
  cancelState: CancelState
  reasonCode: ExecutionReasonCode | null
  createdAt: UtcTimestamp
  updatedAt: UtcTimestamp
}

export interface ConversationPageCursor { beforeCreatedAt: UtcTimestamp; beforeId: Uuid }
export interface ConversationListResponse { conversations: ConversationSummary[]; nextPage: ConversationPageCursor | null }
export interface ConversationResponse { conversation: ConversationSummary }
export interface CreateConversationRequest { requestId: Uuid; title: string; deviceId: Uuid; projectId: Uuid; agentConfigId: Uuid }
export interface CreateConversationResponse { conversation: ConversationSummary; committedSequence: Sequence }
export interface SendInputRequest { requestId: Uuid; text: string }
export interface InputSavedResponse {
  conversationId: Uuid
  inputId: Uuid
  executionId: Uuid
  inputSequence: Sequence
  committedSequence: Sequence
  savedAt: UtcTimestamp
}
export interface CancelExecutionRequest { requestId: Uuid }
export interface CancelExecutionResponse { executionId: Uuid; cancelState: CancelState; stateAtRequest: ExecutionState; committedSequence: Sequence }
export interface ExecutionResponse { execution: ExecutionView }
export interface HistoryResponse {
  conversationId: Uuid
  throughSequence: Sequence
  events: ConversationEvent[]
  nextAfterSequence: Sequence
  hasMore: boolean
}
export type RequestOperation = "conversation.create" | "input.send" | "execution.cancel"
export interface RequestReceiptResponse {
  operation: RequestOperation
  result: CreateConversationResponse | InputSavedResponse | CancelExecutionResponse
}

interface EventHeader {
  protocolVersion: 1
  messageId: Uuid
  occurredAt: UtcTimestamp
  workspaceId: Uuid
  conversationId: Uuid
  sequence: Sequence
}
export interface ConversationCreatedEvent extends EventHeader { type: "conversation.created"; payload: { conversation: ConversationSummary } }
export interface MessageCreatedEvent extends EventHeader { type: "message.created"; payload: { message: Message } }
export interface MessageTextAppendedEvent extends EventHeader { type: "message.text.appended"; payload: { executionId: Uuid; messageId: Uuid; text: string } }
export interface MessageClosedEvent extends EventHeader { type: "message.closed"; payload: { executionId: Uuid; messageId: Uuid; state: "completed" | "interrupted" } }
export interface ExecutionChangedEvent extends EventHeader { type: "execution.changed"; payload: { execution: ExecutionView } }
export type ConversationEvent =
  | ConversationCreatedEvent
  | MessageCreatedEvent
  | MessageTextAppendedEvent
  | MessageClosedEvent
  | ExecutionChangedEvent

/** SSE 控制问题沿用统一错误信封，不推进业务游标。 */
export interface StreamProblem { error: { code: ServerErrorCode; message: string; requestId: Uuid; retryable: boolean } }
