/** 执行命令、运行决定、Runner 来源与恢复端口的唯一线上定义；设备协议只引用这里。 */
import type { Uuid, Sequence, ShareVersion, UtcTimestamp } from "./conversation.js"

export type BodySha256 = string
export type RunnerSequence = string
export type NativeSessionId = string

export interface ExecutionTarget {
  workspaceId: Uuid
  conversationId: Uuid
  executionId: Uuid
  inputId: Uuid
  deviceId: Uuid
  projectId: Uuid
}
export interface ExecutionSourcePrefix extends ExecutionTarget {
  startCommandId: Uuid
  runnerSequence: RunnerSequence
  startBodySha256: BodySha256
}

export interface ExecutionStartPayload extends ExecutionTarget {
  inputSequence: Sequence
  initiatedByUserId: Uuid
  agentConfigId: Uuid
  shareVersion: ShareVersion
  nativeSessionId: NativeSessionId | null
  input: { text: string }
  bodySha256: BodySha256
}
export interface ExecutionCancelPayload extends ExecutionTarget {
  startCommandId: Uuid
  startBodySha256: BodySha256
  requestedByUserId: Uuid
  bodySha256: BodySha256
}
export type DecisionReasonCode = "CANCEL_REQUESTED" | "AUTHOR_UNAVAILABLE" | "PROJECT_NOT_SHARED" | "SHARE_VERSION_CHANGED" | "DEVICE_REVOKED" | "TARGET_INVALID"
export interface ExecutionStartDecisionPayload extends ExecutionTarget {
  startCommandId: Uuid
  startBodySha256: BodySha256
  decision: "allow" | "deny"
  reasonCode: DecisionReasonCode | null
  bodySha256: BodySha256
}
export interface ExecutionAcceptedPayload extends ExecutionSourcePrefix { bodySha256: BodySha256 }
export interface ExecutionNativeBoundPayload extends ExecutionSourcePrefix {
  startDecisionMessageId: Uuid
  nativeSessionId: NativeSessionId
  bodySha256: BodySha256
}
export interface ExecutionRunningPayload extends ExecutionSourcePrefix {
  startDecisionMessageId: Uuid
  nativeSessionId: NativeSessionId
  bodySha256: BodySha256
}
export interface MessageCreatedChange { type: "message.created"; messageId: Uuid }
export interface MessageTextAppendedChange { type: "message.text.appended"; messageId: Uuid; text: string }
export interface MessageClosedChange { type: "message.closed"; messageId: Uuid; state: "completed" | "interrupted" }
export type ExecutionChange = MessageCreatedChange | MessageTextAppendedChange | MessageClosedChange
export interface ExecutionOutputPayload extends ExecutionSourcePrefix {
  startDecisionMessageId: Uuid
  change: ExecutionChange
  bodySha256: BodySha256
}
export type TerminalState = "succeeded" | "failed" | "cancelled" | "rejected"
export type TerminalReasonCode =
  | "AUTHOR_UNAVAILABLE" | "PROJECT_NOT_SHARED" | "SHARE_VERSION_CHANGED" | "DEVICE_REVOKED" | "TARGET_INVALID"
  | "NATIVE_SESSION_UNAVAILABLE" | "PROJECT_ROOT_CHANGED" | "CAPABILITY_UNAVAILABLE"
  | "EXECUTION_FAILED" | "CANCELLED_BY_RUNNER"
export interface ExecutionTerminalPayload extends ExecutionSourcePrefix {
  startDecisionMessageId: Uuid | null
  nativeSessionId: NativeSessionId | null
  state: TerminalState
  reasonCode: TerminalReasonCode | null
  invocationState: "notInvoked" | "finished"
  bodySha256: BodySha256
}
export interface ExecutionCancelReceivedPayload extends ExecutionSourcePrefix {
  cancelCommandId: Uuid
  bodySha256: BodySha256
}
export interface ExecutionEventsAckPayload {
  executionId: Uuid
  lastCommittedRunnerSequence: RunnerSequence
}

interface MessageHeader<T extends string> { protocolVersion: 1; messageId: Uuid; type: T; occurredAt: UtcTimestamp }
export interface ExecutionStartMessage extends MessageHeader<"execution.start"> { payload: ExecutionStartPayload }
export interface ExecutionCancelMessage extends MessageHeader<"execution.cancel"> { payload: ExecutionCancelPayload }
export interface ExecutionStartDecisionMessage extends MessageHeader<"execution.start.decision"> { payload: ExecutionStartDecisionPayload }
export interface ExecutionAcceptedMessage extends MessageHeader<"execution.accepted"> { payload: ExecutionAcceptedPayload }
export interface ExecutionNativeBoundMessage extends MessageHeader<"execution.native.bound"> { payload: ExecutionNativeBoundPayload }
export interface ExecutionRunningMessage extends MessageHeader<"execution.running"> { payload: ExecutionRunningPayload }
export interface ExecutionOutputMessage extends MessageHeader<"execution.output"> { payload: ExecutionOutputPayload }
export interface ExecutionTerminalMessage extends MessageHeader<"execution.terminal"> { payload: ExecutionTerminalPayload }
export interface ExecutionCancelReceivedMessage extends MessageHeader<"execution.cancel.received"> { payload: ExecutionCancelReceivedPayload }
export interface ExecutionEventsAckMessage extends MessageHeader<"execution.events.ack"> { payload: ExecutionEventsAckPayload }

export type ExecutionRunnerMessage =
  | ExecutionAcceptedMessage
  | ExecutionNativeBoundMessage
  | ExecutionRunningMessage
  | ExecutionOutputMessage
  | ExecutionTerminalMessage
  | ExecutionCancelReceivedMessage
export type ExecutionMessage =
  | ExecutionStartMessage
  | ExecutionCancelMessage
  | ExecutionStartDecisionMessage
  | ExecutionRunnerMessage
  | ExecutionEventsAckMessage

export interface RecordBatchRequest {
  deviceId: Uuid
  connectionId: Uuid
  executionId: Uuid
  events: ExecutionRunnerMessage[]
}
export interface ExecutionAck { executionId: Uuid; lastCommittedRunnerSequence: RunnerSequence }
export interface RecordBatchResult { ack: ExecutionAck; startDecision: ExecutionStartDecisionMessage | null }
export type ExecutionProblemKind = "gap" | "conflict" | "targetMismatch" | "bindingConflict" | "invalidTransition" | "storeUnavailable"
export type ExecutionProblem =
  | { kind: "gap"; executionId: Uuid; expectedRunnerSequence: RunnerSequence; lastCommittedRunnerSequence: RunnerSequence }
  | { kind: Exclude<ExecutionProblemKind, "gap">; executionId: Uuid }
export type RecoveryLocalState = "notFound" | "accepted" | "notInvoked" | "invoking" | "running" | "terminalPending" | "unknown"
export type RecoveryAction = "continueOriginal" | "resendSame" | "waitForEvidence" | "terminalSaved"
export interface ReconcileRequest {
  deviceId: Uuid
  connectionId: Uuid
  ledgerId: Uuid
  executionId: Uuid
  startCommandId: Uuid
  startBodySha256: BodySha256
  localState: RecoveryLocalState
  storedDecisionMessageId: Uuid | null
  nativeSessionId: NativeSessionId | null
}
export interface ReconcileResult { action: RecoveryAction; ack: ExecutionAck; startDecision: ExecutionStartDecisionMessage | null }
