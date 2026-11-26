/**
 * Harness `_meta.harnessCode` 扩展元数据解析辅助函数。
 *
 * 【功能定义】把 Harness Agent 在 ACP 帧 `_meta.harnessCode` 中附带的工作流、计划、目标、
 * 思考、命令来源、子代理归属与审批语义整理成强类型只读对象，缺失或畸形时安全忽略。
 * 【协作边界】纯数据解析，不持有会话或连接状态，也不要求其他 Agent 产生这些字段。
 */
import type { AcpAgentHostHints, LocalAcpConfigOption } from "@workbench/acp-runtime"

export const HARNESS_EXT_KEY = "harnessCode" as const
export const HARNESS_EXT_VERSION = 1 as const

/** 客户端声明的 `_meta.harnessCode` 能力列表，与 Python 侧 `ext.py` 对齐。 */
export const HARNESS_CLIENT_EXTENSION_CAPABILITIES = {
  version: HARNESS_EXT_VERSION,
  capabilities: ["approval", "runSummary", "sessionSummary", "subagent", "goal", "commands", "steering"] as const,
} as const

/** Harness 推荐开启的宿主客户端能力提示：表单交互、工作区文件与自动新建兜底恢复。 */
export const HARNESS_HOST_HINTS: AcpAgentHostHints = {
  enableElicitation: true,
  extraClientCapabilitiesMeta: { [HARNESS_EXT_KEY]: HARNESS_CLIENT_EXTENSION_CAPABILITIES },
  enableClientFs: true,
  promptTurnIdMetaKey: "workbenchTurnId",
  restorePolicy: "fallback-new",
  shareProcessPerWorkspace: true,
}

export type HarnessAgentCapabilitiesMeta = {
  readonly version: number
  readonly capabilities: readonly string[]
}

export type HarnessCommandMeta = {
  readonly id?: string
  readonly source?: string
  readonly requestedSkillId?: string
  readonly pluginId?: string
  readonly commandName?: string
  readonly historyChanged?: boolean
  readonly ephemeral?: boolean
}

export type HarnessApprovalMeta = {
  readonly type?: string
  readonly requestId?: string
  readonly description?: string
  readonly scope?: string
}

export type HarnessParentMeta = {
  readonly toolCallId: string
  readonly executionId: string
  readonly agentId?: string
}

export type HarnessRunUsageMeta = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens?: number
}

export type HarnessRunMeta = {
  readonly usage?: HarnessRunUsageMeta
  readonly durationMs?: number
  readonly workflow?: string
  readonly plan?: unknown
  readonly goal?: unknown
  readonly thinking?: unknown
  readonly context?: Readonly<Record<string, unknown>>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function readHarnessNamespace(meta: unknown): Record<string, unknown> | undefined {
  const root = asRecord(meta)
  if (!root) return undefined
  const direct = asRecord(root[HARNESS_EXT_KEY])
  if (direct) return direct
  const nestedMeta = asRecord(root._meta)
  return nestedMeta ? asRecord(nestedMeta[HARNESS_EXT_KEY]) : undefined
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 解析握手响应 `agentCapabilities._meta.harnessCode` 中的版本与能力清单。 */
export function parseHarnessAgentCapabilitiesMeta(agentCapabilities: unknown): HarnessAgentCapabilitiesMeta | undefined {
  const ns = readHarnessNamespace(agentCapabilities)
  if (!ns) return undefined
  if (typeof ns.version !== "number" || !Number.isInteger(ns.version) || ns.version !== HARNESS_EXT_VERSION) {
    return undefined
  }
  if (!Array.isArray(ns.capabilities)) return undefined
  return {
    version: ns.version,
    capabilities: ns.capabilities.filter((item): item is string => typeof item === "string" && item.length > 0),
  }
}

/** 解析斜杠命令或内置命令响应上的 `_meta.harnessCode`（含来源、插件与历史变更标志）。 */
export function parseHarnessCommandMeta(meta: unknown): HarnessCommandMeta | undefined {
  const ns = readHarnessNamespace(meta)
  if (!ns) return undefined
  const cmd = asRecord(ns.command)
  const id = readNonEmptyString(ns.id)
  const source = readNonEmptyString(ns.source)
  const requestedSkillId = readNonEmptyString(ns.requestedSkillId)
  const pluginId = readNonEmptyString(ns.pluginId)
  const commandName = readNonEmptyString(cmd?.name)
  const historyChanged = typeof cmd?.historyChanged === "boolean" ? cmd.historyChanged : undefined
  const ephemeral = typeof ns.ephemeral === "boolean"
    ? ns.ephemeral
    : typeof cmd?.ephemeral === "boolean"
      ? cmd.ephemeral
      : undefined
  if (!id && !source && !requestedSkillId && !pluginId && !commandName && historyChanged === undefined && ephemeral === undefined) {
    return undefined
  }
  return {
    ...(id ? { id } : {}),
    ...(source ? { source } : {}),
    ...(requestedSkillId ? { requestedSkillId } : {}),
    ...(pluginId ? { pluginId } : {}),
    ...(commandName ? { commandName } : {}),
    ...(historyChanged !== undefined ? { historyChanged } : {}),
    ...(ephemeral !== undefined ? { ephemeral } : {}),
  }
}

/** 解析权限请求或选项上的 `_meta.harnessCode.approval` 与范围说明。 */
export function parseHarnessApprovalMeta(meta: unknown): HarnessApprovalMeta | undefined {
  const ns = readHarnessNamespace(meta)
  if (!ns) return undefined
  const approval = asRecord(ns.approval)
  const type = readNonEmptyString(approval?.type)
  const requestId = readNonEmptyString(approval?.requestId)
  const description = readNonEmptyString(approval?.description)
  const scope = readNonEmptyString(ns.scope) ?? readNonEmptyString(approval?.scope)
  if (!type && !requestId && !description && !scope) return undefined
  return {
    ...(type ? { type } : {}),
    ...(requestId ? { requestId } : {}),
    ...(description ? { description } : {}),
    ...(scope ? { scope } : {}),
  }
}

/** 解析子代理工具卡上的 `_meta.harnessCode.parent` 归属。 */
export function parseHarnessParentMeta(meta: unknown): HarnessParentMeta | undefined {
  const ns = readHarnessNamespace(meta)
  const parent = asRecord(ns?.parent)
  if (!parent) return undefined
  const toolCallId = readNonEmptyString(parent.toolCallId)
  const executionId = readNonEmptyString(parent.executionId)
  if (!toolCallId || !executionId) return undefined
  const agentId = readNonEmptyString(parent.agentId)
  return {
    toolCallId,
    executionId,
    ...(agentId ? { agentId } : {}),
  }
}

/** 解析 `session/prompt` 终态响应上的 `_meta.harnessCode.run`（用量、耗时、workflow/plan/goal/thinking）。 */
export function parseHarnessRunMeta(meta: unknown): HarnessRunMeta | undefined {
  const ns = readHarnessNamespace(meta)
  if (!ns) return undefined
  const run = asRecord(ns.run)
  if (!run && ns.workflow === undefined && ns.plan === undefined && ns.goal === undefined && ns.thinking === undefined) {
    return undefined
  }
  const rawUsage = asRecord(run?.usage)
  const inputTokens = readFiniteNumber(rawUsage?.inputTokens ?? rawUsage?.input_tokens)
  const outputTokens = readFiniteNumber(rawUsage?.outputTokens ?? rawUsage?.output_tokens)
  const cachedTokens = readFiniteNumber(rawUsage?.cachedTokens ?? rawUsage?.cached_tokens)
  const usage: HarnessRunUsageMeta | undefined = inputTokens !== undefined || outputTokens !== undefined
    ? {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        ...(cachedTokens !== undefined ? { cachedTokens } : {}),
      }
    : undefined
  const durationMs = readFiniteNumber(run?.durationMs ?? run?.duration_ms)
  const context = asRecord(run?.context)
  const workflow = readNonEmptyString(context?.workflow ?? run?.workflow ?? ns.workflow)
  const plan = context?.plan ?? run?.plan ?? ns.plan
  const goal = context?.goal ?? run?.goal ?? ns.goal
  const thinking = context?.thinking ?? run?.thinking ?? ns.thinking
  return {
    ...(usage ? { usage } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(workflow ? { workflow } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(context ? { context } : {}),
  }
}

/** 解析 `SessionInfo._meta.harnessCode.summary` 会话摘要扩展。 */
export function parseHarnessSessionSummaryMeta(meta: unknown): Readonly<Record<string, unknown>> | undefined {
  const ns = readHarnessNamespace(meta)
  return asRecord(ns?.summary)
}

/** 从 ACP `configOptions` 中识别 Harness 工作流配置项（`build` / `compose`）。 */
export function extractHarnessWorkflowOption(configOptions: readonly LocalAcpConfigOption[]): LocalAcpConfigOption | undefined {
  return configOptions.find(opt => opt.id === "workflow" || opt.category === "harness.workflow")
}

/** 从 ACP `configOptions` 中识别思考级别/开关配置项。 */
export function extractHarnessThinkingOption(configOptions: readonly LocalAcpConfigOption[]): LocalAcpConfigOption | undefined {
  return configOptions.find(opt => opt.id === "thought_level" || opt.id === "thinking" || opt.category === "thought_level")
}
