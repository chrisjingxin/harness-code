/**
 * Harness Code 的 ACP 扩展常量：桥与浏览器两侧从同一份常量取值，避免拼写漂移。
 *
 * 【这是做什么的？】
 * `_harnessCode/…` 是不属于标准 ACP 的扩展方法命名空间：桥自己产生的
 * `_harnessCode/bridge/exit` 崩溃通知、以及 initialize 握手里的扩展能力声明。
 * 值必须与 `packages/agent/harness_agent/host/acp/ext.py` 同名同值（有跨语言
 * 常量漂移测试锁定）。
 *
 * 【上下游】
 * 上游：`host/acp/ext.py` 是源头（Python 侧常量）。
 * 下游：`bridge/`（桥发崩溃通知）与 `client/`（ws-stream 拦截崩溃通知、
 * 网关拼扩展声明）都可引用——它刻意放在 `acp-web/` 根层而不是 `bridge/` 或
 * `client/` 里，因为边界规则禁止这两个子目录互相 import。
 */

export const EXT_KEY = "harnessCode"
export const EXT_METHOD_PREFIX = `_${EXT_KEY}/`
export const EXT_VERSION = 1
export const CAP_APPROVAL = "approval"
export const CAP_RUN_SUMMARY = "runSummary"
export const CAP_SESSION_SUMMARY = "sessionSummary"

/** 子代理扩展能力名；与 Python `harness_agent.host.acp.ext.CAP_SUBAGENT` 同名同步。 */
export const CAP_SUBAGENT = "subagent"
/** 目标确认之后的计划条目；与 Python `CAP_GOAL` 同名同步。 */
export const CAP_GOAL = "goal"
/** 命令来源与内置命令结果；与 Python `CAP_COMMANDS` 同名同步。 */
export const CAP_COMMANDS = "commands"
/** 桥产生的唯一帧类型：子进程退出通知（不经过 Python）。 */
export const BRIDGE_EXIT_METHOD = `${EXT_METHOD_PREFIX}bridge/exit`
export const CLIENT_EXTENSION_DECLARATION = { version: EXT_VERSION, capabilities: [CAP_APPROVAL, CAP_RUN_SUMMARY, CAP_SESSION_SUMMARY, CAP_SUBAGENT, CAP_GOAL, CAP_COMMANDS] } as const

/**
 * `SessionInfo._meta.harnessCode.summary`（服务端 §12.2）：会话列表摘要，
 * 只有声明了 `sessionSummary` 的客户端才收得到。
 */
export interface SessionSummaryMeta {
  createdAt: string
  messageCount: number
  firstMessage: string
  latestMessage: string
}

/**
 * 解析 `SessionInfo._meta` 里的会话摘要；形状有任何问题都返回 undefined，
 * 不抛异常——`_meta` 是扩展字段，客户端必须容忍对端不发或发错。
 */
export function parseSessionSummaryMeta(meta: unknown): SessionSummaryMeta | undefined {
  if (typeof meta !== "object" || meta === null) return undefined
  const summary = (meta as Record<string, unknown>)[EXT_KEY]
  if (typeof summary !== "object" || summary === null) return undefined
  const fields = (summary as Record<string, unknown>).summary
  if (typeof fields !== "object" || fields === null) return undefined
  const { createdAt, messageCount, firstMessage, latestMessage } = fields as Record<string, unknown>
  if (typeof createdAt !== "string") return undefined
  if (typeof messageCount !== "number" || !Number.isInteger(messageCount)) return undefined
  if (typeof firstMessage !== "string") return undefined
  if (typeof latestMessage !== "string") return undefined
  return { createdAt, messageCount, firstMessage, latestMessage }
}

/** `_meta.harnessCode.parent`：子代理卡挂回父 task 卡的归属（GAP-16）。 */
export type ParentMeta = { toolCallId: string; executionId: string; agentId?: string }

/** 形状不全返回 undefined（fail-soft：未声明扩展或绑定缺失都按普通卡显示）。 */
export function parseParentMeta(meta: unknown): ParentMeta | undefined {
  const parent = (meta as { harnessCode?: { parent?: unknown } } | null | undefined)?.harnessCode?.parent
  if (!parent || typeof parent !== "object") return undefined
  const p = parent as { toolCallId?: unknown; executionId?: unknown; agentId?: unknown }
  if (typeof p.toolCallId !== "string" || !p.toolCallId) return undefined
  if (typeof p.executionId !== "string" || !p.executionId) return undefined
  return {
    toolCallId: p.toolCallId,
    executionId: p.executionId,
    ...(typeof p.agentId === "string" && p.agentId ? { agentId: p.agentId } : {}),
  }
}
