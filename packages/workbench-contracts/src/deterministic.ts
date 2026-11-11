/**
 * 执行内层的确定性正文：按契约顺序构造、去掉指纹字段、紧凑编码。
 * 契约包保持无 Node/Electron 依赖；SHA-256 由 Node 宿主（Runner/桌面主进程）实现。
 */
import type { ExecutionMessage } from "./execution.js"

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value)
}

/** 指纹只覆盖内层头与完整 payload，不含连接外壳和 payload.bodySha256。 */
export function executionMessageBody(message: ExecutionMessage): string {
  const payload = { ...(message.payload as unknown as Record<string, unknown>) }
  delete payload.bodySha256
  return canonicalJson({
    protocolVersion: message.protocolVersion,
    messageId: message.messageId,
    type: message.type,
    occurredAt: message.occurredAt,
    payload,
  })
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

/** 十进制字符串序号：不做 Number 转换，避免超过 2^53 后丢精度。 */
export function isSequence(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/.test(value)
}
