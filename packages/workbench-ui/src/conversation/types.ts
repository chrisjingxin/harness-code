/**
 * 对话时间线的窄显示类型。
 *
 * 调用方提供当前会话的显示事实与个人视图状态；本模块不定义线上载荷，也不读取 Agent 数据。
 * 包含时间线、受控输入、结构化工具和待处理交互的显示值。
 */
import type { ReactNode } from "react"
import type { RenderingActions } from "../rendering/types.js"

/** 个人对话状态的隔离范围；namespace 区分服务或身份域，不应包含凭据。 */
export interface ConversationScope {
  readonly namespace: string
  readonly accountId: string
  readonly workspaceId: string
  readonly conversationId: string
}

/** 时间线条目 ID 在当前会话的所有条目中唯一，更新同一条目时保持不变。 */
export type ConversationTimelineEntry =
  | {
      readonly kind: "message"
      readonly id: string
      readonly role: "user" | "assistant" | "system"
      readonly author?: { readonly id: string; readonly displayName: string }
      readonly text: string
      readonly createdAtMs?: number
      readonly streaming?: boolean
    }
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string; readonly active: boolean }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly label: string
      readonly originalName?: string
      readonly summary?: string
      readonly status: "running" | "completed" | "failed"
      readonly tone: "read" | "write" | "neutral"
      readonly detail?: ConversationToolDetailView
    }
  | {
      readonly kind: "interaction-history"
      readonly id: string
      readonly title: string
      readonly statusLabel: string
      readonly description?: string
    }
  | { readonly kind: "extension"; readonly id: string; readonly content: ReactNode }

/** 调用方已投影的工具显示内容；文本和路径均只展示，不触发文件读取。 */
export type ConversationToolBlock =
  | { readonly kind: "text" | "json"; readonly text: string }
  | { readonly kind: "file"; readonly path: string; readonly lines: readonly { readonly number?: number; readonly text: string }[]; readonly rangeLabel: string; readonly truncated: boolean }
  | { readonly kind: "paths"; readonly paths: readonly string[] }
  | { readonly kind: "matches"; readonly groups: readonly { readonly path: string; readonly lines: readonly { readonly number?: number; readonly text: string }[] }[] }
  | { readonly kind: "diff"; readonly path?: string; readonly rows: readonly { readonly kind: "add" | "remove" | "context"; readonly text: string }[] }
  | { readonly kind: "terminal"; readonly command?: string; readonly lines: readonly string[]; readonly truncated: boolean }

export interface ConversationToolDetailView {
  readonly argumentsText?: string
  readonly outputText?: string
  /** 复制内容由调用方明确提供，不从格式化后的 DOM 反推。 */
  readonly copyText?: string
  readonly blocks?: readonly ConversationToolBlock[]
  readonly extension?: ReactNode
}

/** 活动文案由调用方提供；本地计时不代表设备在线或执行完成。 */
export interface ConversationTimelineActivity {
  readonly label: string
  readonly active: boolean
  readonly phaseLabel?: string
  readonly elapsedMs?: number
}

/** 锚点是条目在滚动容器中的位置，用于隐藏或重新挂载后的恢复。 */
export interface ConversationTimelineScroll {
  readonly anchorEntryId: string | null
  readonly offsetPx: number
  readonly following: boolean
  /** 最后跟到的内容版本；null 表示尚未建立可比较的阅读基线。 */
  readonly seenContentRevision: number | null
}

/** 当前用户在一个会话里的阅读选择，由调用方按完整 scope 保存。 */
export interface ConversationTimelineState {
  readonly scroll: ConversationTimelineScroll
  readonly expandedTools: readonly string[]
  readonly expandedOutputs: readonly string[]
}

/** 局部变化不携带其他会话的状态，也不会覆盖未来输入区草稿。 */
export type ConversationTimelineChange =
  | { readonly kind: "scroll"; readonly value: ConversationTimelineScroll }
  | { readonly kind: "tool" | "output"; readonly entryId: string; readonly expanded: boolean }

/**
 * 时间线只消费调用方投影后的条目和个人状态。
 *
 * `visible` 为 false 时暂停滚动跟随；缺少 `onPersonalChange` 时工具展开控件只读。
 * `contentRevision` 由装配方按完整 scope 在内容生命周期内维护：新增或更新实际输出时递增，
 * 加载旧历史、切页或改变外观时不变。重建版本时须清空对应个人状态的已读版本。
 * 版本只用于阅读提示，不是线上协议或权限依据。
 * `rendering` 缺失时复制与外链不可用，失败由对应视图如实提示。
 */
export interface ConversationTimelineProps {
  readonly scope: ConversationScope
  readonly visible: boolean
  readonly entries: readonly ConversationTimelineEntry[]
  readonly contentRevision: number
  readonly activity?: ConversationTimelineActivity | null
  readonly personal: ConversationTimelineState
  readonly onPersonalChange?: (scope: ConversationScope, change: ConversationTimelineChange) => void
  readonly rendering?: RenderingActions
}

/** 设备和项目由工作台装配方提供；它们指向原项目，不代表查看者的本机目录。 */
export interface ConversationProjectTarget {
  readonly deviceId: string
  readonly projectId: string
}

/** 调用方给出动作是否可用以及不可用的原因。 */
export interface ConversationAvailability {
  readonly enabled: boolean
  readonly reason?: string
}

export interface ConversationMenuItemView {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly availability: ConversationAvailability
}

/** 待处理请求的显示模型；可用性、期限和实际处理结果均由装配方提供。 */
export type ConversationInteractionView = {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly deadlineAtMs?: number
  readonly readOnly: boolean
  readonly availability: ConversationAvailability
  readonly preview?: ReactNode
  /** 装配方仅在确认此 scope 与请求可以重试时递增，默认 0。 */
  readonly retryRevision?: number
} & (
  | { readonly kind: "approval"; readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string; readonly tone: "positive" | "negative" | "neutral"; readonly behavior: "confirm" | "immediate"; readonly feedback: "none" | "optional" | "required"; readonly availability: ConversationAvailability }[] }
  | { readonly kind: "question"; readonly questions: readonly { readonly id: string; readonly text: string; readonly multiple: boolean; readonly required: boolean; readonly allowOther: boolean; readonly options: readonly ConversationMenuItemView[] }[] }
  | { readonly kind: "extension"; readonly content: ReactNode }
)

/** 答案是个人草稿；提交后的处理状态不是答案的一部分。 */
export type ConversationInteractionAnswer =
  | { readonly kind: "approval"; readonly optionId: string; readonly feedback?: string }
  | { readonly kind: "question"; readonly answers: readonly { readonly questionId: string; readonly selectedOptionIds: readonly string[]; readonly otherText?: string }[] }

/** 引用正文是调用方提供的固定快照；视图不自行刷新或推断来源权限。 */
export interface ConversationReferenceView {
  readonly id: string
  readonly sourceLabel: string
  readonly rangeLabel: string
  readonly snapshotText: string
  readonly status: "loading" | "ready" | "unavailable" | "error"
  readonly message?: string
  readonly actions: {
    readonly open: ConversationAvailability
    readonly refresh: ConversationAvailability
    readonly remove: ConversationAvailability
  }
}

/** 输入区只展示调用方明确提供的命令、能力和状态，不解释 Agent 类型。 */
export interface ConversationComposerView {
  readonly send: ConversationAvailability
  readonly cancel: ConversationAvailability
  readonly primaryActions: "send" | "cancel" | "both" | "none"
  readonly statusText?: string
  readonly commands: readonly ConversationMenuItemView[]
  readonly controls: readonly {
    readonly id: string
    readonly label: string
    readonly selectedId?: string
    readonly availability: ConversationAvailability
    readonly items: readonly ConversationMenuItemView[]
  }[]
  /** 仅在空闲空草稿时按明确名单轮转；未声明时 Tab 保留原生焦点行为。 */
  readonly tabCycle?: { readonly controlId: string; readonly itemIds: readonly string[] }
  readonly projectTarget: ConversationProjectTarget | null
  readonly references: readonly ConversationReferenceView[]
  readonly attachments: readonly { readonly id: string; readonly label: string; readonly availability: ConversationAvailability }[]
}

/** 草稿由装配方按完整 scope 保存；修订只在文字、引用或附件选择变化时递增。 */
export interface ConversationDraft {
  readonly text: string
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly revision: number
  readonly referenceIds: readonly string[]
  readonly attachmentIds: readonly string[]
}

export interface ConversationPersonalState extends ConversationTimelineState {
  readonly draft: ConversationDraft
  readonly interactions: Readonly<Record<string, ConversationInteractionAnswer>>
}

/** 清空是带原修订号的条件动作，调用方必须在原 scope 内原子比较后再执行。 */
export type ConversationPersonalChange = ConversationTimelineChange
  | { readonly kind: "draft-text"; readonly text: string; readonly selectionStart: number; readonly selectionEnd: number }
  | { readonly kind: "draft-references"; readonly referenceIds: readonly string[] }
  | { readonly kind: "draft-attachments"; readonly attachmentIds: readonly string[] }
  | { readonly kind: "clear-draft"; readonly expectedRevision: number }
  | { readonly kind: "interaction"; readonly interactionId: string; readonly answer: ConversationInteractionAnswer | null }

/** 所有位置均为当前 JavaScript 字符串的 UTF-16 半开区间。 */
export interface ConversationFileCandidateRequest {
  readonly requestId: number
  readonly draftRevision: number
  readonly tokenStart: number
  readonly tokenEnd: number
  readonly query: string
  readonly directory: string
}

export interface ConversationFileCandidate {
  readonly relativePath: string
  readonly name: string
  readonly kind: "file" | "directory" | "symlink"
  readonly matchRanges: readonly { readonly start: number; readonly end: number }[]
}

export interface ConversationFileCandidateResult {
  readonly status: "ready" | "unavailable" | "error"
  readonly items: readonly ConversationFileCandidate[]
  readonly total?: number
  readonly truncated: boolean
  readonly message?: string
}

export type ConversationSendResult =
  | { readonly status: "accepted" }
  | { readonly status: "rejected" | "unknown"; readonly message: string }

/**
 * 动作均为用户意图。调用方负责身份有效性、草稿条件清空及结果未知后的禁用/确认；
 * 组件卸载后装配方仍须保留在途和未知结果，不能把一次回调当成真实 Agent 已执行。
 */
export interface ConversationActions {
  readonly onPersonalChange?: (scope: ConversationScope, change: ConversationPersonalChange) => void
  readonly onSend?: (scope: ConversationScope, revision: number, text: string, referenceIds: readonly string[], attachmentIds: readonly string[]) => Promise<ConversationSendResult>
  readonly onCancel?: (scope: ConversationScope) => Promise<void>
  /**
   * 只上报回答意图。装配方在提交时按 scope 和请求 ID 锁定，卸载后仍保存等待状态；
   * 只有明确确认可以重试时才递增 `retryRevision`，网络恢复只改变可用性。
   */
  readonly onInteractionSubmit?: (scope: ConversationScope, interactionId: string, answer: ConversationInteractionAnswer) => Promise<void>
  readonly onCommand?: (scope: ConversationScope, itemId: string) => void
  readonly onCapabilitySelect?: (scope: ConversationScope, controlId: string, itemId: string) => void
  readonly onRequestFileCandidates?: (scope: ConversationScope, target: ConversationProjectTarget, request: ConversationFileCandidateRequest) => Promise<ConversationFileCandidateResult>
  readonly onOpenFile?: (scope: ConversationScope, target: ConversationProjectTarget, relativePath: string, destination: "preview" | "central") => void
  readonly onReferenceAction?: (scope: ConversationScope, id: string, action: "open" | "refresh" | "remove") => void
  readonly rendering?: RenderingActions
}

/** 对话组合视图：阅读、待处理交互和输入均由装配方提供事实与个人状态。 */
export interface ConversationViewProps {
  readonly scope: ConversationScope
  readonly visible: boolean
  readonly entries: readonly ConversationTimelineEntry[]
  readonly contentRevision: number
  readonly activity?: ConversationTimelineActivity | null
  readonly composer: ConversationComposerView
  readonly interaction: ConversationInteractionView | null
  readonly personal: ConversationPersonalState
  readonly actions: ConversationActions
  readonly slots?: { readonly aboveTimeline?: ReactNode; readonly composer?: ReactNode }
}
