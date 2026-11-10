/**
 * HC-206 独立预览：固定显示数据和个人状态，不连接服务、项目或 Agent。
 *
 * 切换预览账号/会话和隐藏页签可检查时间线隔离；复制通过真实桌面宿主注入。
 * 本页只在预览构建中使用，不进入正式工作台入口。
 */
import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ThemeMode, WindowState } from "@workbench/contracts"
import { ConversationView } from "@workbench/ui"
import type {
  ConversationActions,
  ConversationComposerView,
  ConversationFileCandidate,
  ConversationFileCandidateRequest,
  ConversationFileCandidateResult,
  ConversationInteractionView,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationProjectTarget,
  ConversationReferenceView,
  ConversationScope,
  ConversationTimelineEntry,
  ConversationSendResult,
  RenderingActions,
} from "@workbench/ui"
import "@workbench/ui/theme.css"
import "@workbench/ui/conversation.css"
import "./preview.css"

interface PreviewProfile {
  readonly id: string
  readonly label: string
  readonly scope: ConversationScope
}

interface PreviewHistory {
  readonly revision: number
  readonly entries: readonly ConversationTimelineEntry[]
}

type SendMode = "accepted" | "rejected" | "unknown"
type CandidateMode = "ready" | "slow" | "unavailable" | "error" | "truncated"
type InteractionFixture = "none" | "approval" | "question" | "deadline" | "expired" | "readonly" | "unavailable" | "extension"
type InteractionResult = "waiting" | "unknown"
type Operation = { readonly status: "pending" | "accepted" | "rejected" | "unknown"; readonly message: string }

const profiles: readonly PreviewProfile[] = [
  { id: "alice-review", label: "用户甲 · 协作讨论", scope: { namespace: "preview", accountId: "alice", workspaceId: "demo", conversationId: "review" } },
  { id: "bob-review", label: "用户乙 · 协作讨论", scope: { namespace: "preview", accountId: "bob", workspaceId: "demo", conversationId: "review" } },
  { id: "alice-notes", label: "用户甲 · 另一会话", scope: { namespace: "preview", accountId: "alice", workspaceId: "demo", conversationId: "notes" } },
]

const longOutput = Array.from({ length: 32 }, (_, index) => `第 ${String(index + 1).padStart(2, "0")} 行 · 这是用于检查展开和复制的固定示例。`).join("\n")
const exampleTime = Date.UTC(2026, 10, 10, 2, 20)
const reviewEntries: ConversationTimelineEntry[] = [
  { kind: "message", id: "user-1", role: "user", author: { id: "alice", displayName: "用户甲" }, createdAtMs: exampleTime, text: "请把这段讨论整理成便于接续的说明。" },
  { kind: "message", id: "assistant-1", role: "assistant", createdAtMs: exampleTime + 60_000, text: "可以。先保留已有结论，再列出下一步与待确认的问题。\n\n- 已确认：沿用当前会话。\n- 下一步：由接手人继续查看。" },
  { kind: "tool", id: "tool-1", label: "查看示例", originalName: "example", summary: "固定展示材料", status: "completed", tone: "read", detail: { argumentsText: '{"section":"overview"}', outputText: longOutput, copyText: longOutput } },
  { kind: "tool", id: "tool-structured", label: "查看结构化示例", summary: "文件、匹配、差异与终端", status: "completed", tone: "read", detail: {
    argumentsText: '{"path":"src/example.ts"}', outputText: "原始输出回退：这是固定的受控示例。", copyText: "原始输出：这是固定的受控示例。",
    blocks: [
      { kind: "text", text: "以下均为固定展示材料。" },
      { kind: "json", text: '{\n  "ready": true\n}' },
      { kind: "file", path: "src/example.ts", rangeLabel: "第 12–14 行", lines: [{ number: 12, text: "export function example() {" }, { number: 13, text: "  return true" }, { number: 14, text: "}" }], truncated: true },
      { kind: "paths", paths: ["src/example.ts", "docs/说明.md", "config.json"] },
      { kind: "matches", groups: [{ path: "src/example.ts", lines: [{ number: 13, text: "  return true" }] }, { path: "docs/说明.md", lines: [{ number: 8, text: "示例匹配行" }] }] },
      { kind: "diff", path: "src/example.ts", rows: [{ kind: "context", text: "function example() {" }, { kind: "remove", text: "  return false" }, { kind: "add", text: "  return true" }, { kind: "context", text: "}" }] },
      { kind: "terminal", command: "echo preview", lines: ["preview", "这是固定终端文本。"], truncated: true },
    ],
    extension: <div className="hc206-preview-extension">工具详情扩展节点（固定示例）</div>,
  } },
  { kind: "extension", id: "extension-1", content: <div className="hc206-preview-extension">按顺序插入的扩展节点（固定示例）</div> },
  { kind: "interaction-history", id: "approval-1", title: "与待处理请求同 ID 的历史示例", statusLabel: "历史展示", description: "选择该待处理请求时不重复显示此条。" },
  { kind: "interaction-history", id: "history-1", title: "历史请求", statusLabel: "已处理", description: "这是一条只读的历史展示。" },
  { kind: "message", id: "user-2", role: "user", author: { id: "bob", displayName: "用户乙" }, createdAtMs: exampleTime + 180_000, text: "我接着查看。请保留重要的上下文和原来的顺序。" },
  { kind: "message", id: "assistant-2", role: "assistant", createdAtMs: exampleTime + 240_000, text: "好的。各成员可以看到相同的讨论，每个人的阅读位置由自己保留。" },
  { kind: "tool", id: "tool-2", label: "整理记录", summary: "示例输出", status: "failed", tone: "write", detail: { argumentsText: '{"operation":"example"}', outputText: "这是固定的失败状态示例，不执行实际操作。", copyText: "这是固定的失败状态示例，不执行实际操作。" } },
  ...Array.from({ length: 7 }, (_, index): ConversationTimelineEntry => ({
    kind: "message",
    id: `sample-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    author: index % 2 === 0 ? { id: "alice", displayName: "用户甲" } : undefined,
    createdAtMs: exampleTime + (index + 5) * 60_000,
    text: index % 2 === 0 ? `示例讨论 ${index + 1}：请继续保留阅读位置。` : `示例回复 ${index + 1}：这是预先准备的文本，不连接任何模型。`,
  })),
  { kind: "reasoning", id: "reasoning-1", text: "正在展示一条固定的进行中状态。", active: true },
  { kind: "message", id: "streaming-1", role: "assistant", text: "这里可以观察末尾的流式光标。", streaming: true },
]
const noteEntries: ConversationTimelineEntry[] = [
  { kind: "message", id: "user-1", role: "user", author: { id: "alice", displayName: "用户甲" }, createdAtMs: exampleTime, text: "这是另一份独立会话。" },
  { kind: "message", id: "assistant-1", role: "assistant", createdAtMs: exampleTime + 60_000, text: "它可以使用相同的条目编号，但展开状态与滚动位置互不混用。" },
  { kind: "tool", id: "tool-1", label: "查看示例", summary: "另一会话的文本", status: "completed", tone: "neutral", detail: { outputText: "另一会话的工具详情。", copyText: "另一会话的工具详情。" } },
]

const emptyPersonal: ConversationPersonalState = {
  scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
  expandedTools: [],
  expandedOutputs: [],
  draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: 0, referenceIds: [], attachmentIds: [] },
  interactions: {},
}

const previewReference: ConversationReferenceView = {
  id: "handoff-1", sourceLabel: "交接快照", rangeLabel: "固定示例",
  snapshotText: "这是一份固定的示例快照，用于展示引用材料。",
  status: "ready", actions: { open: { enabled: true }, refresh: { enabled: true }, remove: { enabled: true } },
}

const candidatePaths: readonly { readonly path: string; readonly kind: "file" | "directory" | "symlink" }[] = [
  { path: "src", kind: "directory" }, { path: "docs", kind: "directory" },
  { path: "README.md", kind: "file" }, { path: "使用说明.md", kind: "file" },
  { path: "项目 计划.md", kind: "file" }, { path: "入口.ts", kind: "file" },
  { path: "配置.json", kind: "file" }, { path: "示例.css", kind: "file" },
  { path: "记录一.md", kind: "file" }, { path: "记录二.md", kind: "file" },
  { path: "记录三.md", kind: "file" }, { path: "快捷入口", kind: "symlink" },
  { path: "src/components", kind: "directory" }, { path: "src/app.tsx", kind: "file" },
  { path: "src/带 空格.ts", kind: "file" }, { path: "src/components/button.tsx", kind: "file" },
  { path: "docs/设计说明.md", kind: "file" },
]

const rendering: RenderingActions = {
  copyText: text => window.workbench.copyText(text),
  openExternal: href => window.workbench.openExternal(href),
}

/** 完整身份域、账号、工作区与会话共同决定个人阅读状态。 */
function scopeKey(scope: ConversationScope): string {
  return JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.conversationId])
}

function identityKey(scope: ConversationScope): string {
  return JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId])
}

/** 夹具按查询返回有序显示项，未访问本地目录或文件。 */
function fixtureCandidates(target: ConversationProjectTarget, request: ConversationFileCandidateRequest): ConversationFileCandidate[] {
  const query = request.query.toLocaleLowerCase()
  const entries = target.deviceId === "device-b" ? [...candidatePaths, { path: "另一设备示例.md", kind: "file" as const }] : candidatePaths
  return entries.flatMap(entry => {
    const slash = entry.path.lastIndexOf("/")
    const parent = slash < 0 ? "" : entry.path.slice(0, slash)
    const name = entry.path.slice(slash + 1)
    const match = entry.path.toLocaleLowerCase().indexOf(query)
    if (parent !== request.directory || (query && match < 0)) return []
    return [{ relativePath: entry.path, name, kind: entry.kind, matchRanges: query ? [{ start: match, end: match + query.length }] : [] }]
  }).sort((left, right) => {
    if (!query && left.kind !== right.kind) return left.kind === "directory" ? -1 : right.kind === "directory" ? 1 : 0
    if (query) {
      const score = (entry: ConversationFileCandidate) => entry.name.toLocaleLowerCase().startsWith(query) ? 0 : entry.name.toLocaleLowerCase().includes(query) ? 1 : 2
      return score(left) - score(right)
    }
    return 0
  })
}

function delay(ms: number): Promise<void> { return new Promise(resolve => window.setTimeout(resolve, ms)) }

/** 固定交互只用于观察通用表单，不代表实际审批、提问或服务回执。 */
function fixtureInteraction(kind: InteractionFixture, unavailableReason: string | undefined, showExtensions: boolean, deadlineAtMs: number, retryRevision: number, onExtensionAction: () => void): ConversationInteractionView | null {
  if (kind === "none") return null
  const base = {
    id: kind === "approval" ? "approval-1" : `${kind}-1`,
    title: kind === "question" ? "请回答示例问题" : kind === "extension" ? "完整交互扩展示例" : "需要处理示例请求",
    description: "这是受控预览；提交只记录意图。",
    readOnly: kind === "readonly",
    availability: { enabled: kind !== "unavailable" && !unavailableReason, reason: kind === "unavailable" ? "示例请求暂不可用" : unavailableReason },
    preview: showExtensions ? <div className="hc206-preview-extension">交互预览扩展节点（固定示例）</div> : undefined,
    deadlineAtMs: kind === "expired" ? 0 : kind === "deadline" ? deadlineAtMs : undefined,
    retryRevision,
  }
  if (kind === "extension") return { ...base, kind: "extension", content: <button type="button" className="wb-button wb-button-small" onClick={onExtensionAction}>记录扩展表单意图</button> }
  if (kind === "question") return { ...base, kind: "question", questions: [
    { id: "single", text: "选择一个处理方向", multiple: false, required: true, allowOther: true, options: [
      { id: "a", label: "方向 A", availability: { enabled: true } },
      { id: "b", label: "方向 B", availability: { enabled: true } },
      { id: "locked", label: "不可用方向", availability: { enabled: false, reason: "示例中未开放" } },
    ] },
    { id: "multiple", text: "选择需要保留的内容", multiple: true, required: true, allowOther: true, options: [
      { id: "notes", label: "说明", availability: { enabled: true } },
      { id: "steps", label: "步骤", availability: { enabled: true } },
    ] },
    { id: "optional", text: "是否附带示例标签", multiple: false, required: false, allowOther: false, options: [{ id: "tag", label: "附带", availability: { enabled: true } }] },
  ] }
  return { ...base, kind: "approval", options: [
    { id: "approve", label: "批准", tone: "positive", behavior: "confirm", feedback: "none", availability: { enabled: true } },
    { id: "reject", label: "拒绝", tone: "negative", behavior: "immediate", feedback: "none", availability: { enabled: true } },
    { id: "feedback", label: "拒绝并反馈", tone: "negative", behavior: "confirm", feedback: "required", availability: { enabled: true } },
    { id: "optional", label: "补充意见", tone: "neutral", behavior: "confirm", feedback: "optional", availability: { enabled: true } },
    { id: "locked", label: "不可用选项", tone: "neutral", behavior: "confirm", feedback: "none", availability: { enabled: false, reason: "示例中未开放" } },
  ] }
}

function TimelinePreview() {
  const [windowState, setWindowState] = useState<WindowState>({ themeMode: "system", colorScheme: "light", zoomPercent: 100 })
  const [windowError, setWindowError] = useState("")
  const [profileId, setProfileId] = useState(profiles[0].id)
  const [chatVisible, setChatVisible] = useState(true)
  const [mounted, setMounted] = useState(true)
  const [pasted, setPasted] = useState("")
  const [personalStates, setPersonalStates] = useState<Record<string, ConversationPersonalState>>({})
  const [operationStates, setOperationStates] = useState<Record<string, Operation>>({})
  const [callRecords, setCallRecords] = useState<Record<string, readonly string[]>>({})
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({})
  const [sendMode, setSendMode] = useState<SendMode>("accepted")
  const [candidateMode, setCandidateMode] = useState<CandidateMode>("ready")
  const [targetId, setTargetId] = useState("device-a")
  const [active, setActive] = useState(false)
  const [offline, setOffline] = useState(false)
  const [tabCycleEnabled, setTabCycleEnabled] = useState(true)
  const [interactionFixture, setInteractionFixture] = useState<InteractionFixture>("approval")
  const [fixtureDeadline, setFixtureDeadline] = useState(0)
  const [interactionResult, setInteractionResult] = useState<InteractionResult>("waiting")
  const [interactionStates, setInteractionStates] = useState<Record<string, "pending" | InteractionResult>>({})
  const [interactionRetryRevisions, setInteractionRetryRevisions] = useState<Record<string, number>>({})
  const interactionLocks = useRef(new Set<string>())
  const [showSlots, setShowSlots] = useState(true)
  const [histories, setHistories] = useState<Record<string, PreviewHistory>>({
    review: { revision: 0, entries: reviewEntries },
    notes: { revision: 0, entries: noteEntries },
  })
  const profile = profiles.find(item => item.id === profileId) ?? profiles[0]
  const currentKey = scopeKey(profile.scope)
  const personal = personalStates[currentKey] ?? emptyPersonal
  const history = histories[profile.scope.conversationId] ?? { revision: 0, entries: [] }
  const operation = operationStates[currentKey]
  const interactionId = interactionFixture === "approval" ? "approval-1" : `${interactionFixture}-1`
  const interactionKey = JSON.stringify([currentKey, interactionId])
  const interactionState = interactionStates[interactionKey]
  const approvalKey = JSON.stringify([currentKey, "approval-1"])
  const backgroundApproval = interactionStates[approvalKey]
  const mountedRef = useRef(mounted)
  mountedRef.current = mounted
  const currentIdentity = useRef({ key: identityKey(profile.scope), revision: 0 })
  if (currentIdentity.current.key !== identityKey(profile.scope)) {
    currentIdentity.current = { key: identityKey(profile.scope), revision: currentIdentity.current.revision + 1 }
  }

  useEffect(() => {
    let active = true
    const apply = (next: WindowState) => { if (active) setWindowState(next) }
    const unsubscribe = window.workbench.onWindowStateChanged(apply)
    window.workbench.getWindowState().then(apply).catch(() => { if (active) setWindowError("无法读取窗口外观。") })
    return () => { active = false; unsubscribe() }
  }, [])

  useEffect(() => { document.documentElement.dataset.theme = windowState.colorScheme }, [windowState.colorScheme])

  async function updateWindow(action: () => Promise<WindowState>): Promise<void> {
    try { setWindowError(""); setWindowState(await action()) }
    catch { setWindowError("窗口外观未能更新，请重试。") }
  }

  const updatePersonal = (scope: ConversationScope, change: ConversationPersonalChange) => {
    const key = scopeKey(scope)
    setPersonalStates(previous => {
      const current = previous[key] ?? emptyPersonal
      if (change.kind === "scroll") return { ...previous, [key]: { ...current, scroll: change.value } }
      if (change.kind === "tool" || change.kind === "output") {
        const field = change.kind === "tool" ? "expandedTools" : "expandedOutputs"
        const existing = current[field]
        const selected = change.expanded
          ? existing.includes(change.entryId) ? existing : [...existing, change.entryId]
          : existing.filter(id => id !== change.entryId)
        return { ...previous, [key]: { ...current, [field]: selected } }
      }
      if (change.kind === "interaction") {
        const next = { ...current.interactions }
        if (change.answer === null) delete next[change.interactionId]
        else next[change.interactionId] = change.answer
        return { ...previous, [key]: { ...current, interactions: next } }
      }
      const draft = current.draft
      if (change.kind === "draft-text") {
        const revision = draft.revision + (change.text === draft.text ? 0 : 1)
        const start = Math.max(0, Math.min(change.text.length, change.selectionStart))
        const end = Math.max(start, Math.min(change.text.length, change.selectionEnd))
        return { ...previous, [key]: { ...current, draft: { ...draft, text: change.text, selectionStart: start, selectionEnd: end, revision } } }
      }
      if (change.kind === "draft-references" || change.kind === "draft-attachments") {
        const field = change.kind === "draft-references" ? "referenceIds" : "attachmentIds"
        const next = change.kind === "draft-references" ? change.referenceIds : change.attachmentIds
        if (draft[field].length === next.length && draft[field].every((id, index) => id === next[index])) return previous
        return { ...previous, [key]: { ...current, draft: { ...draft, [field]: [...next], revision: draft.revision + 1 } } }
      }
      // 旧发送结果只能条件清空原账号的原修订，不能覆盖当前账号或后续编辑。
      if (change.kind === "clear-draft") {
        if (identityKey(scope) !== currentIdentity.current.key || draft.revision !== change.expectedRevision) return previous
        return { ...previous, [key]: { ...current, draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: draft.revision + 1, referenceIds: [], attachmentIds: [] } } }
      }
      return previous
    })
  }

  const record = (scope: ConversationScope, message: string) => {
    const key = scopeKey(scope)
    setCallRecords(previous => ({ ...previous, [key]: [...(previous[key] ?? []).slice(-11), message] }))
  }

  const interaction = fixtureInteraction(interactionFixture, interactionState ? "示例结果待确认" : offline ? "示例设备暂时离线" : undefined, showSlots, fixtureDeadline, interactionRetryRevisions[interactionKey] ?? 0, () => record(profile.scope, "完整交互扩展：仅记录界面意图。"))

  const composer: ConversationComposerView = {
    send: { enabled: !offline && operation?.status !== "pending" && operation?.status !== "unknown", reason: offline ? "示例设备暂时离线" : operation?.status === "unknown" ? "提交结果待确认" : operation?.status === "pending" ? "正在等待受控回调" : undefined },
    cancel: { enabled: active && !offline, reason: offline ? "示例设备暂时离线" : undefined },
    primaryActions: active ? "both" : "send",
    statusText: offline ? "示例设备离线；草稿仍保留。" : operation?.message || (active ? "示例状态：等待下一步。" : undefined),
    commands: [
      { id: "overview", label: "/overview", description: "记录查看意图", availability: { enabled: true } },
      { id: "unavailable", label: "/restricted", description: "受限示例", availability: { enabled: false, reason: "当前示例不可用" } },
    ],
    controls: [{
      id: "display-choice", label: "示例能力", selectedId: selectedModels[currentKey] ?? "choice-a",
      availability: { enabled: !offline, reason: offline ? "设备离线时不能切换" : undefined },
      items: [
        { id: "choice-a", label: "选项 A", description: "固定示例", availability: { enabled: true } },
        { id: "choice-b", label: "选项 B", description: "固定示例", availability: { enabled: true } },
        { id: "choice-locked", label: "不可用选项", availability: { enabled: false, reason: "示例能力未提供" } },
        { id: "manage", label: "管理选项…", availability: { enabled: true } },
      ],
    }],
    tabCycle: tabCycleEnabled ? { controlId: "display-choice", itemIds: ["choice-a", "missing", "choice-locked", "choice-b", "choice-a"] } : undefined,
    projectTarget: { deviceId: targetId, projectId: "example-project" },
    references: [previewReference],
    attachments: [{ id: "attachment-1", label: "固定示例附件", availability: { enabled: true } }],
  }

  const actions: ConversationActions = {
    onPersonalChange: updatePersonal,
    onSend: async (sourceScope, revision, text, referenceIds, attachmentIds): Promise<ConversationSendResult> => {
      const sourceKey = scopeKey(sourceScope)
      const sourceIdentityRevision = currentIdentity.current.revision
      const selectedResult = sendMode
      record(sourceScope, `发送意图：修订 ${revision}，${text.length} 字符，${referenceIds.length} 项引用，${attachmentIds.length} 项附件`)
      setOperationStates(previous => ({ ...previous, [sourceKey]: { status: "pending", message: "正在等待固定示例回调。" } }))
      await delay(1200)
      const message = selectedResult === "accepted" ? "示例回调已受理，不代表实际执行。" : selectedResult === "rejected" ? "示例回调拒绝，草稿已保留。" : "示例回调结果待确认，草稿已保留。"
      setOperationStates(previous => ({ ...previous, [sourceKey]: { status: selectedResult, message } }))
      record(sourceScope, `发送回调：${selectedResult}`)
      // 对话被卸载时，由预览装配方接管原修订的条件清空；身份变化后不能清空。
      if (selectedResult === "accepted" && !mountedRef.current && currentIdentity.current.revision === sourceIdentityRevision) {
        updatePersonal(sourceScope, { kind: "clear-draft", expectedRevision: revision })
      }
      return selectedResult === "accepted" ? { status: "accepted" } : { status: selectedResult, message }
    },
    onCancel: async sourceScope => { record(sourceScope, "请求停止：仅记录界面意图。"); await delay(300) },
    onInteractionSubmit: async (sourceScope, id, answer) => {
      const sourceKey = JSON.stringify([scopeKey(sourceScope), id])
      if (interactionLocks.current.has(sourceKey)) throw new Error("示例请求仍在等待结果")
      interactionLocks.current.add(sourceKey)
      setInteractionStates(previous => ({ ...previous, [sourceKey]: "pending" }))
      record(sourceScope, `交互意图：${id} · ${JSON.stringify(answer)}`)
      const result = interactionResult
      await delay(1200)
      setInteractionStates(previous => ({ ...previous, [sourceKey]: result }))
      record(sourceScope, `交互回调：${result === "waiting" ? "等待外部事实" : "结果待确认"}`)
      if (result === "unknown") throw new Error("示例结果待确认")
    },
    onCommand: (sourceScope, itemId) => { record(sourceScope, `命令意图：${itemId}`) },
    onCapabilitySelect: (sourceScope, controlId, itemId) => {
      record(sourceScope, `能力意图：${controlId} / ${itemId}`)
      if (itemId !== "manage") setSelectedModels(previous => ({ ...previous, [scopeKey(sourceScope)]: itemId }))
    },
    onRequestFileCandidates: async (sourceScope, target, request): Promise<ConversationFileCandidateResult> => {
      const mode = candidateMode
      record(sourceScope, `文件候选：${target.deviceId}/${target.projectId} · ${request.directory || "/"} · 请求 ${request.requestId}`)
      await delay(mode === "slow" && request.query.length <= 1 ? 1100 : 180)
      if (mode === "unavailable") return { status: "unavailable", items: [], truncated: false, message: "示例项目当前受限。" }
      if (mode === "error") return { status: "error", items: [], truncated: false, message: "示例项目读取失败。" }
      const items = fixtureCandidates(target, request)
      return { status: "ready", items, total: mode === "truncated" ? 1200 : items.length, truncated: mode === "truncated" }
    },
    onOpenFile: (sourceScope, target, path, destination) => { record(sourceScope, `打开文件意图：${destination} · ${target.deviceId}/${target.projectId} · ${path}`) },
    onReferenceAction: (sourceScope, id, action) => {
      record(sourceScope, `引用意图：${action} · ${id}`)
      if (action === "remove") updatePersonal(sourceScope, { kind: "draft-references", referenceIds: personal.draft.referenceIds.filter(item => item !== id) })
    },
    rendering,
  }

  const appendExample = () => {
    const conversationId = profile.scope.conversationId
    setHistories(previous => {
      const current = previous[conversationId] ?? { revision: 0, entries: [] }
      const next: ConversationTimelineEntry = {
        kind: "message", id: `new-${current.entries.length}`, role: "user",
        author: { id: "example-author", displayName: "示例成员" },
        text: "新增的固定示例，用于检查个人滚动位置。",
      }
      return { ...previous, [conversationId]: { revision: current.revision + 1, entries: [...current.entries, next] } }
    })
  }

  const extendExample = () => {
    const conversationId = profile.scope.conversationId
    setHistories(previous => {
      const current = previous[conversationId] ?? { revision: 0, entries: [] }
      return {
        ...previous,
        [conversationId]: {
          revision: current.revision + 1,
          entries: current.entries.map(entry => entry.kind === "message" && entry.id === "streaming-1"
            ? { ...entry, text: `${entry.text} 追加的示例文字。` }
            : entry),
        },
      }
    })
  }

  const hasTimelineExtension = history.entries.some(entry => entry.id === "extension-1" && entry.kind === "extension")
  const toggleTimelineExtension = () => {
    const conversationId = profile.scope.conversationId
    setHistories(previous => {
      const current = previous[conversationId] ?? { revision: 0, entries: [] }
      const exists = current.entries.some(entry => entry.id === "extension-1" && entry.kind === "extension")
      const without = current.entries.filter(entry => entry.id !== "extension-1").map(entry => entry.kind === "tool" && entry.id === "tool-structured" ? {
        ...entry, detail: { ...entry.detail, extension: exists ? undefined : <div className="hc206-preview-extension">工具详情扩展节点（固定示例）</div> },
      } : entry)
      if (!exists) {
        const index = without.findIndex(entry => entry.kind === "tool")
        without.splice(index < 0 ? without.length : index + 1, 0, { kind: "extension", id: "extension-1", content: <div className="hc206-preview-extension">按顺序插入的扩展节点（固定示例）</div> })
      }
      return { ...previous, [conversationId]: { revision: current.revision + 1, entries: without } }
    })
  }

  const clearInteractionWait = (targetKey: string, targetId: string) => {
    const state = interactionStates[targetKey]
    if (!state || state === "pending") return
    interactionLocks.current.delete(targetKey)
    setInteractionStates(previous => { const next = { ...previous }; delete next[targetKey]; return next })
    setInteractionRetryRevisions(previous => ({ ...previous, [targetKey]: (previous[targetKey] ?? 0) + 1 }))
    record(profile.scope, `示例明确允许重试：${targetId}`)
  }

  return (
    <div className="hc206-preview">
      <header className="hc206-preview-header">
        <div><strong>对话视图</strong><span>固定数据预览</span></div>
        <div className="hc206-preview-appearance">
          <label>外观<select aria-label="外观" value={windowState.themeMode} onChange={event => { void updateWindow(() => window.workbench.setThemeMode(event.target.value as ThemeMode)) }}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <button type="button" className="wb-icon-button" aria-label="缩小" disabled={windowState.zoomPercent <= 80} onClick={() => { void updateWindow(() => window.workbench.adjustZoom("out")) }}>−</button>
          <button type="button" className="wb-button wb-button-small" aria-label="恢复缩放" onClick={() => { void updateWindow(() => window.workbench.adjustZoom("reset")) }}>{windowState.zoomPercent}%</button>
          <button type="button" className="wb-icon-button" aria-label="放大" disabled={windowState.zoomPercent >= 150} onClick={() => { void updateWindow(() => window.workbench.adjustZoom("in")) }}>+</button>
        </div>
      </header>
      <main className="hc206-preview-main">
        <div className="hc206-preview-intro">
          <div><h1>对话阅读流</h1><p>内容和动作均为预览数据；不会连接服务或执行操作。</p></div>
          <label>查看身份与会话<select aria-label="查看身份与会话" value={profileId} onChange={event => setProfileId(event.target.value)}>{profiles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        </div>
        {windowError ? <p className="hc206-preview-error" role="alert">{windowError}</p> : null}
        <div className="hc206-preview-actions">
          <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={appendExample}>添加示例消息</button>
          <button type="button" className="wb-button wb-button-secondary wb-button-small" disabled={profile.scope.conversationId !== "review"} onClick={extendExample}>追加示例文字</button>
          <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => setMounted(value => !value)}>{mounted ? "卸载对话" : "重新挂载对话"}</button>
          <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => setActive(value => !value)}>{active ? "设为空闲示例" : "设为活动示例"}</button>
          <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => setOffline(value => !value)}>{offline ? "恢复示例连接" : "设为离线示例"}</button>
          <button type="button" className="wb-button wb-button-secondary wb-button-small" disabled={personal.draft.referenceIds.includes(previewReference.id)} onClick={() => updatePersonal(profile.scope, { kind: "draft-references", referenceIds: [...personal.draft.referenceIds, previewReference.id] })}>加入固定引用</button>
          <button type="button" className="wb-button wb-button-secondary wb-button-small" disabled={personal.draft.attachmentIds.includes("attachment-1")} onClick={() => updatePersonal(profile.scope, { kind: "draft-attachments", attachmentIds: [...personal.draft.attachmentIds, "attachment-1"] })}>加入固定附件</button>
          <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={toggleTimelineExtension}>{hasTimelineExtension ? "卸载时间线/工具扩展" : "插入时间线/工具扩展"}</button>
          <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => setShowSlots(value => !value)}>{showSlots ? "卸载其余扩展" : "装载其余扩展"}</button>
          {interactionState && interactionState !== "pending" ? <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => clearInteractionWait(interactionKey, interactionId)}>确认交互可重试</button> : null}
          {interactionFixture !== "approval" && backgroundApproval && backgroundApproval !== "pending" ? <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => clearInteractionWait(approvalKey, "approval-1")}>确认离屏审批可重试</button> : null}
          {operation?.status === "unknown" ? <button type="button" className="wb-button wb-button-secondary wb-button-small" onClick={() => setOperationStates(previous => ({ ...previous, [currentKey]: { status: "rejected", message: "示例已确认可以重新尝试。" } }))}>确认可重试</button> : null}
        </div>
        <div className="hc206-preview-fixtures">
          <label>发送回调<select aria-label="发送回调" value={sendMode} onChange={event => setSendMode(event.target.value as SendMode)}><option value="accepted">受理</option><option value="rejected">拒绝</option><option value="unknown">结果待确认</option></select></label>
          <label>文件候选<select aria-label="文件候选情景" value={candidateMode} onChange={event => setCandidateMode(event.target.value as CandidateMode)}><option value="ready">正常</option><option value="slow">旧查询较慢</option><option value="unavailable">受限</option><option value="error">错误</option><option value="truncated">结果截断</option></select></label>
          <label>原设备<select aria-label="原设备" value={targetId} onChange={event => setTargetId(event.target.value)}><option value="device-a">设备 A</option><option value="device-b">设备 B</option></select></label>
          <label>待处理请求<select aria-label="待处理请求示例" value={interactionFixture} onChange={event => { const next = event.target.value as InteractionFixture; if (next === "deadline") setFixtureDeadline(Date.now() + 30_000); setInteractionFixture(next) }}><option value="none">无请求</option><option value="approval">审批</option><option value="question">多题问答</option><option value="deadline">30 秒后过期</option><option value="expired">已过期</option><option value="readonly">只读</option><option value="unavailable">不可用</option><option value="extension">完整扩展</option></select></label>
          <label>交互回调<select aria-label="交互回调" value={interactionResult} onChange={event => setInteractionResult(event.target.value as InteractionResult)}><option value="waiting">等待外部事实</option><option value="unknown">结果待确认</option></select></label>
          <label><input type="checkbox" checked={tabCycleEnabled} onChange={event => setTabCycleEnabled(event.target.checked)} />启用 Tab 切换示例</label>
        </div>
        <section className="hc206-preview-workspace" aria-label="对话预览区域">
          <div className="hc206-preview-tabs" role="tablist" aria-label="预览页签">
            <button type="button" role="tab" aria-selected={chatVisible} onClick={() => setChatVisible(true)}>对话</button>
            <button type="button" role="tab" aria-selected={!chatVisible} onClick={() => setChatVisible(false)}>其他页签</button>
          </div>
          <div className="hc206-preview-panel" hidden={!chatVisible} inert={!chatVisible}>
            {mounted ? <ConversationView scope={profile.scope} visible={chatVisible} entries={history.entries} contentRevision={history.revision} activity={{ label: "受控示例状态", active, elapsedMs: 12_000 }} composer={composer} interaction={interaction} personal={personal} actions={actions} slots={showSlots ? { aboveTimeline: <div className="hc206-preview-extension">时间线上方扩展（固定示例）</div>, composer: <span className="hc206-preview-composer-extension">输入区增量扩展</span> } : undefined} /> : <p className="hc206-preview-placeholder">对话已卸载，个人状态仍保留在预览中。</p>}
          </div>
          <div className="hc206-preview-panel hc206-preview-placeholder" hidden={chatVisible} inert={chatVisible}>
            此页仅用于检查对话隐藏后的阅读状态，不是文件页签。
          </div>
        </section>
        <section className="hc206-preview-records" aria-label="受控回调记录">
          <strong>当前会话的受控回调记录</strong>
          {(callRecords[currentKey] ?? []).length ? <ol>{(callRecords[currentKey] ?? []).map((entry, index) => <li key={`${index}:${entry}`}>{entry}</li>)}</ol> : <p>尚无回调；这些记录只表示界面意图。</p>}
        </section>
        <label className="hc206-preview-paste">复制后可在这里粘贴核对<textarea aria-label="粘贴验证" rows={3} value={pasted} onChange={event => setPasted(event.target.value)} /></label>
      </main>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<TimelinePreview />)
