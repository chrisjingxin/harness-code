/**
 * 会话状态投影与更新归并辅助：将 ACP 握手、开会、配置与 SessionUpdate 规范化为只读快照。
 * 纯数据转换模块，不持有连接或子进程副作用。
 */
import type {
  AuthMethod,
  AvailableCommand,
  ClientCapabilities,
  ContentBlock,
  Implementation,
  PlanEntry,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionModeState,
  SessionUpdate,
} from "@agentclientprotocol/sdk"
import { toLocalAcpTool } from "./tool-update.js"
import type {
  LocalAcpAuthMethod,
  LocalAcpCommand,
  LocalAcpConfigOption,
  LocalAcpConfigSelectOption,
  LocalAcpHostOptions,
  LocalAcpImplementation,
  LocalAcpModelsState,
  LocalAcpModesState,
  LocalAcpPlanEntry,
  LocalAcpPlanState,
  LocalAcpPromptBlock,
  LocalAcpReplayFrame,
  LocalAcpSessionInfo,
  LocalAcpSessionState,
  LocalAcpSessionUsage,
} from "./index.js"

export function emptySessionState(): LocalAcpSessionState {
  return {
    connected: false,
    authMethods: [],
    configOptions: [],
    availableCommands: [],
    plans: [],
    restoreStatus: { kind: "none" },
  }
}

export function buildClientCapabilities(options: LocalAcpHostOptions): ClientCapabilities {
  return {
    plan: {},
    ...(options.enableClientFs !== false ? { fs: { readTextFile: true, writeTextFile: true } } : {}),
    ...(options.enableClientTerminal === true ? { terminal: true } : {}),
    ...(options.enableElicitation === true ? { elicitation: { form: {} } } : {}),
  }
}

export function parseImplementation(info?: Implementation | null): LocalAcpImplementation | undefined {
  if (!info || typeof info.name !== "string") return undefined
  return {
    name: info.name,
    version: typeof info.version === "string" ? info.version : "",
    ...(typeof info.title === "string" && info.title ? { title: info.title } : {}),
  }
}

export function parseAuthMethods(methods?: readonly AuthMethod[]): LocalAcpAuthMethod[] {
  if (!Array.isArray(methods)) return []
  const result: LocalAcpAuthMethod[] = []
  for (const method of methods) {
    if (!method || typeof method.id !== "string" || typeof method.name !== "string") continue
    const raw = method as Record<string, unknown>
    const type = raw.type === "env_var" || raw.type === "terminal" ? raw.type : "agent"
    result.push({
      id: method.id,
      name: method.name,
      type,
      ...(typeof method.description === "string" && method.description ? { description: method.description } : {}),
      ...(type === "terminal" && Array.isArray(raw.args)
        ? { args: raw.args.filter((item): item is string => typeof item === "string") }
        : {}),
      ...(type === "env_var" && typeof raw.link === "string" && raw.link ? { link: raw.link } : {}),
      ...(type === "env_var" && Array.isArray(raw.vars)
        ? {
            vars: raw.vars
              .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && typeof (v as { name?: unknown }).name === "string")
              .map(v => ({
                name: v.name as string,
                ...(typeof v.label === "string" ? { label: v.label } : {}),
                ...(typeof v.secret === "boolean" ? { secret: v.secret } : {}),
                ...(typeof v.optional === "boolean" ? { optional: v.optional } : {}),
              })),
          }
        : {}),
    })
  }
  return result
}

export function parseModes(modes?: SessionModeState | null): LocalAcpModesState | undefined {
  if (!modes || !Array.isArray(modes.availableModes) || typeof modes.currentModeId !== "string") return undefined
  return {
    currentModeId: modes.currentModeId,
    availableModes: modes.availableModes.map(mode => ({
      id: mode.id,
      name: mode.name,
      ...(typeof mode.description === "string" && mode.description ? { description: mode.description } : {}),
    })),
  }
}

/** 兼容部分标准 ACP Agent 在会话响应中附带的旧版 models 字段。 */
export function parseModels(raw: unknown): LocalAcpModelsState | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as { currentModelId?: unknown; availableModels?: unknown }
  if (!Array.isArray(record.availableModels)) return undefined
  const availableModels = record.availableModels.flatMap(item => {
    if (!item || typeof item !== "object") return []
    const model = item as { modelId?: unknown; id?: unknown; name?: unknown; description?: unknown }
    const modelId = typeof model.modelId === "string" ? model.modelId : typeof model.id === "string" ? model.id : ""
    if (!modelId) return []
    return [{
      modelId,
      name: typeof model.name === "string" && model.name ? model.name : modelId,
      ...(typeof model.description === "string" && model.description ? { description: model.description } : {}),
    }]
  })
  const currentModelId = typeof record.currentModelId === "string" && record.currentModelId ? record.currentModelId : undefined
  if (!availableModels.length && !currentModelId) return undefined
  return { ...(currentModelId ? { currentModelId } : {}), availableModels }
}

function flattenConfigSelectOptions(rawOptions: readonly (SessionConfigSelectOption | SessionConfigSelectGroup)[]): LocalAcpConfigSelectOption[] {
  const flat: LocalAcpConfigSelectOption[] = []
  for (const item of rawOptions) {
    if ("group" in item && Array.isArray(item.options)) {
      for (const option of item.options) {
        flat.push({
          value: option.value,
          name: option.name,
          ...(option.description ? { description: option.description } : {}),
          group: item.group,
          groupName: item.name,
        })
      }
      continue
    }
    const option = item as SessionConfigSelectOption
    flat.push({
      value: option.value,
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
    })
  }
  return flat
}

export function parseConfigOptions(options?: readonly SessionConfigOption[] | null): LocalAcpConfigOption[] {
  if (!Array.isArray(options)) return []
  const result: LocalAcpConfigOption[] = []
  for (const option of options) {
    if (!option || typeof option.id !== "string" || typeof option.name !== "string") continue
    const base = {
      id: option.id,
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
      ...(option.category ? { category: option.category } : {}),
    }
    if (option.type === "boolean") {
      result.push({ ...base, type: "boolean", currentValue: Boolean(option.currentValue) })
    } else if (option.type === "select" && Array.isArray(option.options)) {
      result.push({
        ...base,
        type: "select",
        currentValue: String(option.currentValue ?? ""),
        options: flattenConfigSelectOptions(option.options),
      })
    }
  }
  return result
}

export function parseCommands(commands?: readonly AvailableCommand[] | null): LocalAcpCommand[] {
  if (!Array.isArray(commands)) return []
  return commands
    .filter((cmd): cmd is AvailableCommand => Boolean(cmd) && typeof cmd.name === "string" && Boolean(cmd.name))
    .map(cmd => ({
      name: cmd.name,
      description: typeof cmd.description === "string" ? cmd.description : "",
      ...(cmd.input?.hint ? { inputHint: cmd.input.hint } : {}),
      ...(cmd._meta && typeof cmd._meta === "object" ? { meta: { ...cmd._meta } } : {}),
    }))
}

export function parsePlanEntries(entries?: readonly PlanEntry[]): LocalAcpPlanEntry[] {
  if (!Array.isArray(entries)) return []
  return entries.map(entry => ({
    content: entry.content,
    priority: entry.priority,
    status: entry.status,
  }))
}

export function upsertPlan(
  current: readonly LocalAcpPlanState[],
  next: LocalAcpPlanState,
): LocalAcpPlanState[] {
  const index = current.findIndex(item => item.id === next.id)
  if (index === -1) return [...current, next]
  return current.map((item, i) => (i === index ? next : item))
}

export function mergeSessionInfo(
  current: LocalAcpSessionInfo | undefined,
  update: { readonly title?: string | null; readonly updatedAt?: string | null },
): LocalAcpSessionInfo {
  return {
    ...(update.title !== undefined ? { title: update.title } : current?.title !== undefined ? { title: current.title } : {}),
    ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt } : current?.updatedAt !== undefined ? { updatedAt: current.updatedAt } : {}),
  }
}

export function toSdkPromptBlocks(blocks: readonly LocalAcpPromptBlock[]): ContentBlock[] {
  return blocks.map(block => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text }
      case "image":
        return {
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
          ...(block.uri !== undefined ? { uri: block.uri } : {}),
        }
      case "resource_link":
        return {
          type: "resource_link",
          uri: block.uri,
          name: block.name,
          ...(block.title !== undefined ? { title: block.title } : {}),
          ...(block.description !== undefined ? { description: block.description } : {}),
          ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
          ...(block.size !== undefined ? { size: block.size } : {}),
        }
      case "resource":
        return { type: "resource", resource: { ...block.resource } }
    }
  })
}

function toPromptBlock(content: ContentBlock): LocalAcpPromptBlock | undefined {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text }
    case "image":
      return {
        type: "image",
        data: content.data,
        mimeType: content.mimeType,
        ...(content.uri ? { uri: content.uri } : {}),
      }
    case "resource_link":
      return {
        type: "resource_link",
        uri: content.uri,
        name: content.name,
        ...(content.title ? { title: content.title } : {}),
        ...(content.description ? { description: content.description } : {}),
        ...(content.mimeType ? { mimeType: content.mimeType } : {}),
        ...(typeof content.size === "number" ? { size: content.size } : {}),
      }
    case "resource":
      return {
        type: "resource",
        resource: "text" in content.resource
          ? { uri: content.resource.uri, text: content.resource.text, ...(content.resource.mimeType ? { mimeType: content.resource.mimeType } : {}) }
          : { uri: content.resource.uri, blob: content.resource.blob, ...(content.resource.mimeType ? { mimeType: content.resource.mimeType } : {}) },
      }
    default:
      return undefined
  }
}

export function toReplayFrame(update: SessionUpdate): LocalAcpReplayFrame | undefined {
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return { kind: "tool", tool: toLocalAcpTool(update) }
  }
  if (update.sessionUpdate === "user_message_chunk") {
    const messageId = update.messageId ?? undefined
    if (update.content.type === "text") {
      return { kind: "user-text", text: update.content.text, ...(messageId ? { messageId } : {}) }
    }
    const block = toPromptBlock(update.content)
    return block ? { kind: "user-block", block, ...(messageId ? { messageId } : {}) } : undefined
  }
  if (update.sessionUpdate === "agent_message_chunk") {
    const messageId = update.messageId ?? undefined
    if (update.content.type === "text") {
      return { kind: "agent-text", text: update.content.text, ...(messageId ? { messageId } : {}) }
    }
    const block = toPromptBlock(update.content)
    return block ? { kind: "agent-block", block, ...(messageId ? { messageId } : {}) } : undefined
  }
  if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
    const messageId = update.messageId ?? undefined
    return { kind: "agent-thought", text: update.content.text, ...(messageId ? { messageId } : {}) }
  }
  return undefined
}

export function parseUsageUpdate(update: {
  readonly used: number
  readonly size: number
  readonly cost?: { readonly amount: number; readonly currency: string } | null
}): LocalAcpSessionUsage {
  return {
    used: update.used,
    size: update.size,
    ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}),
  }
}

export function cloneSessionState(state: LocalAcpSessionState): LocalAcpSessionState {
  return structuredClone(state)
}
