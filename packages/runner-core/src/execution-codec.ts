/**
 * Runner 侧确定性执行消息：同一契约正文 + 宿主 SHA-256；指纹始终追加在 payload 最后。
 * 这里只构造 Runner→Java 的六种来源消息，不定义第二套字段或决定。
 */
import { createHash, randomUUID } from "node:crypto"
import {
  executionMessageBody,
  type ExecutionMessage,
  type ExecutionStartMessage,
  type ExecutionStartDecisionMessage,
  type ExecutionCancelMessage,
  type ExecutionAcceptedMessage,
  type ExecutionNativeBoundMessage,
  type ExecutionRunningMessage,
  type ExecutionOutputMessage,
  type ExecutionTerminalMessage,
  type ExecutionCancelReceivedMessage,
  type ExecutionChange,
  type TerminalReasonCode,
  type ExecutionState,
} from "@workbench/contracts"

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

/** 未带指纹的 payload 形状；seal 会计算并追加 bodySha256。 */
type Unsealed<T extends ExecutionMessage> = Omit<T, "payload"> & { payload: Omit<T["payload"], "bodySha256"> }

export function seal<T extends ExecutionMessage>(message: Unsealed<T>): T {
  const body = executionMessageBody(message as unknown as ExecutionMessage)
  return { ...message, payload: { ...message.payload, bodySha256: sha256(body) } } as unknown as T
}

export function verify(message: ExecutionMessage): boolean {
  const stored = (message.payload as { bodySha256?: unknown }).bodySha256
  return typeof stored === "string" && stored === sha256(executionMessageBody(message))
}

export function utcNow(): string { return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1Z") }
export function utc(epochMs: number): string { return new Date(epochMs).toISOString() }

function header<T extends string>(type: T, occurredAt = utcNow(), messageId = randomUUID()) {
  return { protocolVersion: 1 as const, messageId, type, occurredAt }
}

function sourceTarget(start: ExecutionStartMessage | ExecutionCancelMessage, runnerSequence: string) {
  return {
    workspaceId: start.payload.workspaceId,
    conversationId: start.payload.conversationId,
    executionId: start.payload.executionId,
    inputId: start.payload.inputId,
    deviceId: start.payload.deviceId,
    projectId: start.payload.projectId,
    startCommandId: start.type === "execution.start" ? start.messageId : start.payload.startCommandId,
    runnerSequence,
    startBodySha256: start.type === "execution.start" ? start.payload.bodySha256 : start.payload.startBodySha256,
  }
}

export function accepted(start: ExecutionStartMessage, runnerSequence: string): ExecutionAcceptedMessage {
  return seal<ExecutionAcceptedMessage>({
    ...header("execution.accepted"),
    payload: sourceTarget(start, runnerSequence),
  })
}

export function nativeBound(start: ExecutionStartMessage, decision: ExecutionStartDecisionMessage, runnerSequence: string, nativeSessionId: string): ExecutionNativeBoundMessage {
  return seal<ExecutionNativeBoundMessage>({
    ...header("execution.native.bound"),
    payload: { ...sourceTarget(start, runnerSequence), startDecisionMessageId: decision.messageId, nativeSessionId },
  })
}

export function running(start: ExecutionStartMessage, decision: ExecutionStartDecisionMessage, runnerSequence: string, nativeSessionId: string): ExecutionRunningMessage {
  return seal<ExecutionRunningMessage>({
    ...header("execution.running"),
    payload: { ...sourceTarget(start, runnerSequence), startDecisionMessageId: decision.messageId, nativeSessionId },
  })
}

export function output(start: ExecutionStartMessage, decision: ExecutionStartDecisionMessage, runnerSequence: string, change: ExecutionChange): ExecutionOutputMessage {
  return seal<ExecutionOutputMessage>({
    ...header("execution.output"),
    payload: { ...sourceTarget(start, runnerSequence), startDecisionMessageId: decision.messageId, change },
  })
}

export function terminal(start: ExecutionStartMessage | ExecutionCancelMessage, decision: ExecutionStartDecisionMessage | null, runnerSequence: string,
                         state: Extract<ExecutionState, "succeeded" | "failed" | "cancelled" | "rejected">,
                         reasonCode: TerminalReasonCode | null, invocationState: "notInvoked" | "finished",
                         nativeSessionId: string | null): ExecutionTerminalMessage {
  return seal<ExecutionTerminalMessage>({
    ...header("execution.terminal"),
    payload: {
      ...sourceTarget(start, runnerSequence),
      startDecisionMessageId: decision?.messageId ?? null,
      nativeSessionId, state, reasonCode, invocationState,
    },
  })
}

export function cancelReceived(start: ExecutionStartMessage | ExecutionCancelMessage, cancel: ExecutionCancelMessage, runnerSequence: string): ExecutionCancelReceivedMessage {
  return seal<ExecutionCancelReceivedMessage>({
    ...header("execution.cancel.received"),
    payload: { ...sourceTarget(start, runnerSequence), cancelCommandId: cancel.messageId },
  })
}

export function messageCreated(messageId: string): ExecutionChange {
  return { type: "message.created", messageId }
}
export function textAppended(messageId: string, text: string): ExecutionChange {
  return { type: "message.text.appended", messageId, text }
}
export function messageClosed(messageId: string, state: "completed" | "interrupted"): ExecutionChange {
  return { type: "message.closed", messageId, state }
}
