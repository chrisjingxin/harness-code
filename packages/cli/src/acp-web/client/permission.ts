/**
 * `session/request_permission` ⇄ Core 交互信封的纯函数映射（设计 §4.7）。
 *
 * 【这是做什么的？】Python 把审批/目录信任请求包装在 ACP
 * `request_permission` 的 `toolCall._meta.harnessCode.approval` 里；
 * Interactive Core 消费的是 v3 `InteractionRequestEnvelope`。这里做
 * 逐字段翻译与决策回映射，不做 I/O、不持状态——挂起/作废/收敛都归网关。
 *
 * 【fail closed】`_meta` 缺失或形状不对、`options` 与已知决策无交集时
 * 返回 `null`：网关一律按 `cancelled` 应答（审批 = reject、信任 = deny），
 * 未经用户授权绝不放行。
 */

import type {
  ApprovalResponse,
  DirectoryTrustResponse,
  FileDiffPresentation,
  InteractionRequestEnvelope,
  InteractionResponse,
  JsonValue,
} from "@za38/protocol"

import { metaApproval, nameOf } from "./translate"

export type PermissionInput = {
  readonly sessionId: string
  readonly toolCall: {
    readonly toolCallId?: string
    readonly title?: string
    readonly rawInput?: unknown
    readonly _meta?: unknown
  }
  readonly options: ReadonlyArray<{ optionId?: string }>
}

export type PermissionContext = {
  readonly coreThreadId: string
  readonly coreRunId: string
  /** 网关已登记工具名（审批卡的 `requests.action_requests[].name`）；没有时按 title 首段取名。 */
  readonly registeredToolName?: string
}

export type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" }

const APPROVAL_DECISIONS = new Set(["approve_once", "approve_thread", "approve_project", "reject"])
const TRUST_DECISIONS = new Set(["allow_session", "deny"])

/** `presentation` 形状完整才透传（保持 v3 snake_case），否则丢弃。 */
function isFileDiff(value: unknown): value is FileDiffPresentation {
  const p = value as FileDiffPresentation | null
  return !!p
    && p.kind === "file_diff"
    && (p.operation === "write" || p.operation === "edit" || p.operation === "delete")
    && typeof p.path === "string"
    && typeof p.unified_diff === "string"
    && typeof p.added_lines === "number"
    && typeof p.removed_lines === "number"
    && typeof p.truncated === "boolean"
}

/** `rawInput`：对象原样；undefined → {}；其它值 → {value: …}。 */
function requestArgs(rawInput: unknown): Record<string, unknown> {
  if (rawInput === undefined) return {}
  if (typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)) {
    return rawInput as Record<string, unknown>
  }
  return { value: rawInput }
}

/**
 * 构造 `InteractionRequestEnvelope`；形状不全或决策无交集返回 null
 * （网关据此 fail closed 回 `cancelled`）。
 */
export function buildInteractionRequest(
  input: PermissionInput,
  context: PermissionContext,
): InteractionRequestEnvelope | null {
  const meta = metaApproval(input.toolCall._meta)
  if (!meta || typeof meta.requestId !== "string" || !meta.requestId) return null
  const decisions = input.options
    .map(option => option.optionId)
    .filter((id): id is string => typeof id === "string")

  if (meta.type === "approval") {
    const filtered = decisions.filter(id => APPROVAL_DECISIONS.has(id)) as Array<
      "approve_once" | "approve_thread" | "approve_project" | "reject"
    >
    if (filtered.length === 0) return null
    const description = typeof meta.description === "string" && meta.description
      ? meta.description
      : (input.toolCall.title ?? "")
    return {
      request_id: meta.requestId,
      type: "approval",
      thread_id: context.coreThreadId,
      run_id: context.coreRunId,
      // 审批无超时（S2 已定）：Infinity 让控制器不装定时器、Deadline 不渲染。
      timeout_ms: Number.POSITIVE_INFINITY,
      ...(typeof meta.agentId === "string" && meta.agentId ? { agent_id: meta.agentId } : {}),
      payload: {
        interrupt_id: meta.requestId,
        description,
        // GAP-38：合成值，不是 v3 原样——name 用已登记工具名否则 title 首段。
        requests: {
          action_requests: [{
            name: context.registeredToolName ?? nameOf(input.toolCall.title, input.toolCall.toolCallId, input.toolCall._meta),
            args: requestArgs(input.toolCall.rawInput),
            description,
          }],
        } as unknown as JsonValue,
        decisions: filtered,
        ...(isFileDiff(meta.presentation) ? { presentation: meta.presentation } : {}),
      },
    }
  }

  if (meta.type === "directory_trust") {
    const filtered = decisions.filter(id => TRUST_DECISIONS.has(id)) as Array<"allow_session" | "deny">
    if (filtered.length === 0) return null
    return {
      request_id: meta.requestId,
      type: "directory_trust",
      thread_id: context.coreThreadId,
      run_id: context.coreRunId,
      timeout_ms: Number.POSITIVE_INFINITY,
      payload: {
        interrupt_id: meta.requestId,
        directory: typeof meta.directory === "string" ? meta.directory : "",
        target_path: typeof meta.targetPath === "string" ? meta.targetPath : "",
        tool_name: typeof meta.toolName === "string" ? meta.toolName : "",
        access: meta.access === "write" ? "write" : "read",
        shadows_workspace: Boolean(meta.shadowsWorkspace),
        decisions: filtered,
      },
    }
  }

  return null // 未知 type：fail closed
}

/**
 * Core 回答 → ACP `RequestPermissionResponse.outcome`。
 * `decision` 必须在本次 options 里，否则 cancelled。
 */
export function mapInteractionResponse(
  response: InteractionResponse,
  request: InteractionRequestEnvelope,
): PermissionOutcome {
  if (response.type === "approval" && request.type === "approval") {
    const decision = (response as ApprovalResponse).decision
    const allowed = new Set(request.payload.decisions)
    if (typeof decision === "string" && allowed.has(decision as "approve_once")) {
      return { outcome: "selected", optionId: decision }
    }
    return { outcome: "cancelled" }
  }
  if (response.type === "directory_trust" && request.type === "directory_trust") {
    const decision = (response as DirectoryTrustResponse).decision
    const allowed = new Set(request.payload.decisions)
    if (typeof decision === "string" && allowed.has(decision as "allow_session")) {
      return { outcome: "selected", optionId: decision }
    }
    return { outcome: "cancelled" }
  }
  return { outcome: "cancelled" }
}
