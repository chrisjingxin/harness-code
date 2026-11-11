/**
 * `RunTranslator`：把 ACP `session/update` 翻译成 v3 `EventEnvelope` 的
 * 纯状态机。每个 Run 一个实例，不做 I/O；顺序保证（F11）由调用方守住——
 * `sessionUpdate` 必须在同一同步段内完成"找会话 → 翻译 → 入队"，
 * 因此 `update()` 本身是同步的。
 *
 * 【这是做什么的？】Python 的 ACP 通道产出的是 ACP 标准 update（工具卡
 * 生命周期 + 消息块），而 Interactive Core 消费的是 v3 事件。这个文件是
 * 两者的逐字段映射（设计 §4.5）：累计内容换算成增量防止文字重复、
 * 未见 started 的"完整卡"合成两条事件、终态响应映射成唯一终态事件。
 *
 * 【上下游】上游：`acp-agent-gateway.ts` 在 `sessionUpdate` 里按
 * `update.sessionUpdate` 字段分派（`session_info_update` /
 * `current_mode_update` / `available_commands_update` 不经过这里）。
 * 下游：`RunState.events`（AsyncQueue）喂给控制器。
 */

import type { EventEnvelope } from "@za38/protocol"

import { parseParentMeta } from "../ext"

/** Python `translate.py` 的 `MAX_OUTPUT_CHARS`：输出超过它就不再增长。 */
export const MAX_OUTPUT_CHARS = 64 * 1024

export type RunTranslatorOptions = {
  readonly runId: string
  readonly threadId: string
  readonly startedAtMs: number
  readonly now?: () => number
  readonly log?: (event: { event: string; [key: string]: unknown }) => void
}

type ToolState = {
  name: string
  /** 已发给控制器的累计输出文本（用于累计→增量换算）。 */
  outputSent: string
  argsSent: boolean
  final: boolean
  diverged?: boolean
}

/** ACP `session/update` 的 `update` 字段（我们只读用到的键）。 */
export type AcpSessionUpdate = {
  sessionUpdate?: string
  toolCallId?: string
  title?: string
  kind?: string
  status?: string | null
  content?: unknown
  rawInput?: unknown
  rawOutput?: unknown
  messageId?: string
  _meta?: unknown
  [key: string]: unknown
}

/** 标准 `PromptResponse.usage`（camelCase）或扩展里的 snake_case。 */
export type PromptUsage = {
  inputTokens?: unknown
  outputTokens?: unknown
  cachedReadTokens?: unknown
  input_tokens?: unknown
  output_tokens?: unknown
  cached_tokens?: unknown
  cached_read_tokens?: unknown
}

/** `run.started` 里给状态栏用的模型。三个名字都必须有，否则界面不显示。 */
export type StartedModel = {
  id: string
  model: string
  provider_label: string
  is_default?: boolean
  available?: boolean
  source?: string
  context_window_tokens?: number
}

/** `session/prompt` 的响应（或 JSON-RPC 错误）。 */
export type PromptOutcome =
  | { stopReason: string; _meta?: unknown; usage?: PromptUsage | null }
  | { error: { code: number; message: string; data?: unknown } }

export function isPromptError(outcome: PromptOutcome): outcome is { error: { code: number; message: string; data?: unknown } } {
  return "error" in outcome
}

/** `title` 第一个空白前的片段是工具名；`trust:` 卡用 `_meta` 里的 toolName。 */
export function nameOf(title: string | undefined, toolCallId?: string, meta?: unknown): string {
  if (toolCallId?.startsWith("trust:")) {
    const approval = metaApproval(meta)
    const toolName = approval?.toolName
    if (typeof toolName === "string" && toolName) return toolName
  }
  const head = (title ?? "").split(/\s/, 1)[0]?.trim() ?? ""
  return head || "tool"
}

const PLAN_STAGE_BY_LABEL: Record<string, "requirement" | "spec" | "plan" | "implement" | "review"> = {
  需求: "requirement",
  规格: "spec",
  计划: "plan",
  实现: "implement",
  检视: "review",
}

function planStages(entries: unknown): Array<{ id: "requirement" | "spec" | "plan" | "implement" | "review"; state: "pending" | "current" | "confirmed" | "failed" }> | null {
  if (!Array.isArray(entries)) return null
  const stages: Array<{ id: "requirement" | "spec" | "plan" | "implement" | "review"; state: "pending" | "current" | "confirmed" | "failed" }> = []
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const raw = entry as { content?: unknown; status?: unknown }
    if (typeof raw.content !== "string" || !raw.content) continue
    const failed = raw.content.endsWith("（失败）")
    const label = failed ? raw.content.slice(0, -"（失败）".length) : raw.content
    const id = PLAN_STAGE_BY_LABEL[label]
    if (!id) continue
    const state = failed
      ? "failed"
      : raw.status === "in_progress"
        ? "current"
        : raw.status === "completed"
          ? "confirmed"
          : "pending"
    stages.push({ id, state })
  }
  return stages.length ? stages : null
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** 标准 usage 优先。没有这块对象时返回 null，调用方再看扩展里的 run.usage。 */
function readPromptUsage(value: unknown): { input: number; output: number; cached?: number } | null {
  if (!value || typeof value !== "object") return null
  const raw = value as PromptUsage
  const cached = finiteToken(raw.cachedReadTokens) ?? finiteToken(raw.cached_tokens) ?? finiteToken(raw.cached_read_tokens)
  return {
    input: finiteToken(raw.inputTokens) ?? finiteToken(raw.input_tokens) ?? 0,
    output: finiteToken(raw.outputTokens) ?? finiteToken(raw.output_tokens) ?? 0,
    ...(cached !== undefined ? { cached } : {}),
  }
}

export function metaApproval(meta: unknown): Record<string, unknown> | null {
  const harness = (meta as { harnessCode?: { approval?: unknown } } | null)?.harnessCode?.approval
  return harness && typeof harness === "object" ? harness as Record<string, unknown> : null
}

/** 提取 update.content 里的全部文本块文本（ACP content 是 `{type:"content", content:{type:"text",text}}` 数组）。 */
export function updateText(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    const inner = (item as { content?: { type?: string; text?: string } }).content
    if (inner?.type === "text" && typeof inner.text === "string") parts.push(inner.text)
  }
  return parts.length ? parts.join("") : null
}

export class RunTranslator {
  private sequence = 0
  /** compose.progress 要求 revision 严格递增，迟到的同号帧会被丢掉。 */
  private planRevision = 0
  private readonly tools = new Map<string, ToolState>()
  private finished = false
  private readonly droppedKinds = new Map<string, number>()
  private readonly now: () => number
  private readonly log: (event: { event: string; [key: string]: unknown }) => void

  constructor(private readonly options: RunTranslatorOptions) {
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? (() => {})
  }

  /** `drive` ⑤ 的起步事件。不传模型时保持原来的 build 起步帧。 */
  started(options?: { mode?: string; model?: StartedModel }): EventEnvelope {
    const model = options?.model
    const profile = model?.id && model.model && model.provider_label
      ? {
          id: model.id,
          model: model.model,
          provider_label: model.provider_label,
          context_window_tokens: typeof model.context_window_tokens === "number" ? model.context_window_tokens : 0,
          capabilities: [] as string[],
          is_default: model.is_default === true,
          available: model.available !== false,
          source: model.source || "config",
        }
      : undefined
    return this.emit("run.started", {
      mode: options?.mode === "compose" ? "compose" : "build",
      resumed: false,
      ...(profile ? { primary_model: { profile } } : {}),
    })
  }

  /** 处理一条 session/update，返回产生的事件（通常 0-2 条）。 */
  update(update: AcpSessionUpdate): EventEnvelope[] {
    if (this.finished) return []
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined
        if (content?.type === "text" && typeof content.text === "string" && content.text.length > 0) {
          const type = update.sessionUpdate === "agent_message_chunk" ? "content.delta" : "reasoning.delta"
          return [this.emit(type, { text: content.text })]
        }
        this.drop("non_text_chunk", update.sessionUpdate)
        return []
      }
      case "tool_call":
        return this.onToolCall(update)
      case "tool_call_update":
        return this.onToolUpdate(update)
      case "user_message_chunk":
        // 非回放期出现 user 块不产事件（回放进 ReplayBuffer）。
        return []
      case "plan":
        return this.onPlan(update)
      case "usage_update":
        return this.onUsage(update)
      default:
        this.drop("unknown_update", update.sessionUpdate ?? "missing")
        return []
    }
  }

  /** `session/prompt` 终态：每个 Run 恰好一个终态事件。 */
  finish(outcome: PromptOutcome): EventEnvelope {
    this.finished = true
    if (isPromptError(outcome)) {
      const { code, message, data } = outcome.error
      const detail = (data ?? {}) as { code?: string; message?: string; retryable?: boolean }
      return this.emit("run.failed", {
        error: {
          code: typeof detail.code === "string" ? detail.code : `ACP_${code}`,
          message: typeof detail.message === "string" ? detail.message : message,
          retryable: detail.retryable === true,
        },
      })
    }
    switch (outcome.stopReason) {
      case "cancelled":
        return this.emit("run.cancelled", { reason: "user cancelled" })
      case "refusal":
        return this.emit("run.failed", {
          error: { code: "MODEL_REFUSAL", message: "模型拒绝继续", retryable: false },
        })
      case "max_tokens":
      case "max_turn_requests":
        return this.completed(outcome, outcome.stopReason)
      case "end_turn":
      default:
        return this.completed(outcome, "end_turn")
    }
  }

  /** `session/prompt` 成功响应 → run.completed。 */
  private completed(outcome: { stopReason: string; _meta?: unknown; usage?: PromptUsage | null }, finishReason: string): EventEnvelope {
    const harness = (outcome._meta as {
      harnessCode?: {
        run?: { usage?: unknown; duration_ms?: unknown; context?: unknown }
        command?: { historyChanged?: unknown }
      }
    } | null)?.harnessCode
    const run = harness?.run ?? {}
    const usage = readPromptUsage(outcome.usage) ?? readPromptUsage(run.usage) ?? { input: 0, output: 0 }
    const context: Record<string, unknown> = run.context && typeof run.context === "object"
      ? { ...(run.context as Record<string, unknown>) }
      : {}
    // /undo 和 /redo 告诉客户端历史变了，控制器据此重新打开会话。
    if (harness?.command?.historyChanged === true) context.historyChanged = true
    return this.emit("run.completed", {
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        ...(usage.cached !== undefined ? { cached_tokens: usage.cached } : {}),
      },
      duration_ms: typeof run.duration_ms === "number" ? run.duration_ms : this.now() - this.options.startedAtMs,
      finish_reason: finishReason,
      context,
    })
  }

  /**
   * ACP plan 的中文短名还原成 Compose 阶段条。
   * 需求对应界面上的 requirement，当前阶段记成 grill（分不出 grill 和 task）。
   */
  private onPlan(update: AcpSessionUpdate): EventEnvelope[] {
    const stages = planStages(update.entries)
    if (!stages) {
      this.drop("unknown_update", "plan")
      return []
    }
    this.planRevision += 1
    const current = stages.find(stage => stage.state === "current")
      ?? stages.find(stage => stage.state === "failed")
      ?? stages[stages.length - 1]!
    const busy = stages.some(stage => stage.state === "current" || stage.state === "pending" || stage.state === "failed")
    return [this.emit("compose.progress", {
      revision: this.planRevision,
      thread_id: this.options.threadId,
      slug: "compose",
      complexity: "simple",
      current_stage: current.id === "requirement" ? "grill" : current.id,
      status: busy ? "active" : "completed",
      waiting: "none",
      stages,
      documents: [],
      fix_rounds: 0,
    })]
  }

  /** 上下文用量。界面只认 estimated_tokens / input_cap_tokens 这一对数字。 */
  private onUsage(update: AcpSessionUpdate): EventEnvelope[] {
    const used = update.used
    const size = update.size
    if (typeof used !== "number" || typeof size !== "number" || !Number.isFinite(used) || !Number.isFinite(size) || used < 0 || size < 0) {
      this.drop("unknown_update", "usage_update")
      return []
    }
    return [this.emit("context.updated", {
      action: "usage",
      estimated_tokens: used,
      input_cap_tokens: size,
    })]
  }

  private onToolCall(update: AcpSessionUpdate): EventEnvelope[] {
    const toolCallId = update.toolCallId ?? ""
    if (this.tools.has(toolCallId)) return this.onToolUpdate(update)
    const events: EventEnvelope[] = []
    const tool: ToolState = { name: nameOf(update.title, toolCallId, update._meta), outputSent: "", argsSent: false, final: false }
    this.tools.set(toolCallId, tool)
    events.push(this.emit("tool.started", { tool_call_id: toolCallId, name: tool.name }))
    if (update.rawInput !== undefined) {
      events.push(this.emit("tool.delta", { tool_call_id: toolCallId, arguments_delta: JSON.stringify(update.rawInput) }))
      tool.argsSent = true
    }
    if (update.status === "completed" || update.status === "failed") {
      // 首次出现就是终态的"完整卡"：started + completed 一起发。
      const terminal = this.terminalEvents(update, tool)
      events.push(...terminal)
    }
    return this.withParent(events, parseParentMeta(update._meta))
  }

  private onToolUpdate(update: AcpSessionUpdate): EventEnvelope[] {
    const toolCallId = update.toolCallId ?? ""
    let tool = this.tools.get(toolCallId)
    const events: EventEnvelope[] = []
    if (!tool) {
      // 兜底：未见 started 的纯更新，先合成一张卡再按更新处理。
      tool = { name: nameOf(update.title, toolCallId, update._meta), outputSent: "", argsSent: false, final: false }
      this.tools.set(toolCallId, tool)
      events.push(this.emit("tool.started", { tool_call_id: toolCallId, name: tool.name }))
    }
    if (tool.final) return events // 已终态的工具再来 update：丢弃
    const status = update.status ?? "in_progress"
    if (status === "completed" || status === "failed") {
      if (update.rawInput !== undefined && !tool.argsSent) {
        events.push(this.emit("tool.delta", { tool_call_id: toolCallId, arguments_delta: JSON.stringify(update.rawInput) }))
        tool.argsSent = true
      }
      events.push(...this.terminalEvents(update, tool))
      return events
    }
    // pending / in_progress：补参数、算内容增量。
    if (update.rawInput !== undefined && !tool.argsSent) {
      events.push(this.emit("tool.delta", { tool_call_id: toolCallId, arguments_delta: JSON.stringify(update.rawInput) }))
      tool.argsSent = true
    }
    const fullText = updateText(update.content)
    if (fullText !== null) {
      const delta = this.outputDelta(tool, fullText)
      if (delta !== null) {
        events.push(this.emit("tool.delta", { tool_call_id: toolCallId, output_delta: delta }))
      }
    }
    return events
  }

  /** 累计内容 → 增量：防文字重复；非前缀关系记 diverged 不发增量，等终态整体覆盖。 */
  private outputDelta(tool: ToolState, fullText: string): string | null {
    const sent = tool.outputSent
    if (fullText.startsWith(sent) && fullText.length > sent.length) {
      tool.outputSent = fullText
      return fullText.slice(sent.length)
    }
    if (sent.startsWith(fullText)) return null // 重复重发，或被上限截断后的收缩
    tool.diverged = true
    this.log({ event: "tool.content_diverged", tool_call_id: this.options.runId })
    return null
  }

  /** 终态：不再算增量，用 update 自带的完整文本整体替换。 */
  private terminalEvents(update: AcpSessionUpdate, tool: ToolState): EventEnvelope[] {
    tool.final = true
    const toolCallId = update.toolCallId ?? ""
    const fullText = updateText(update.content)
    const rawOutput = typeof update.rawOutput === "string" ? update.rawOutput : null
    const content = fullText ?? rawOutput ?? tool.outputSent
    return [this.emit("tool.completed", {
      tool_call_id: toolCallId,
      result: {
        content,
        is_error: update.status === "failed",
        truncated: content.length >= MAX_OUTPUT_CHARS,
        original_bytes: new TextEncoder().encode(content).byteLength,
      },
    })]
  }

  /** 子代理卡（带 harnessCode.parent）的事件补 execution/agent 顶层归属，供分组。 */
  private withParent(events: EventEnvelope[], parent: { executionId: string; agentId?: string } | undefined): EventEnvelope[] {
    if (!parent) return events
    for (const ev of events) {
      const e = ev as EventEnvelope & { execution_id?: string; agent_id?: string }
      e.execution_id = parent.executionId
      if (parent.agentId) e.agent_id = parent.agentId
    }
    return events
  }

  private emit<T extends EventEnvelope["type"]>(type: T, payload: unknown): EventEnvelope {
    this.sequence += 1
    return {
      event_id: `${this.options.runId}:${this.sequence}`,
      type,
      thread_id: this.options.threadId,
      run_id: this.options.runId,
      sequence: this.sequence,
      timestamp_ms: this.now(),
      payload,
    } as EventEnvelope
  }

  private drop(kind: string, detail: string): void {
    const count = (this.droppedKinds.get(kind) ?? 0) + 1
    this.droppedKinds.set(kind, count)
    this.log({ event: kind, update: detail, count })
  }
}
