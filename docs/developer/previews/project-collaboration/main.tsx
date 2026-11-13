/**
 * 前端视觉稿：使用固定示例数据和本地交互，不调用服务端、Runner 或 ACP。
 * 时间线、头像、工具、输入及文件部件直接消费现有 @workbench/ui 公开出口。
 */
import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { createRoot } from "react-dom/client"
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  SquarePen,
  Circle,
  Clock,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  LayoutGrid,
  Link2,
  ListChecks,
  LockKeyhole,
  Laptop,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  X,
} from "lucide-react"
import {
  BrandMark,
  ConversationView,
  Markdown,
  ProjectDock,
  ProjectFilePanel,
  ProjectFileTab,
  WorkbenchLayout,
} from "@workbench/ui"
import type {
  ConversationComposerView,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationReferenceView,
  ConversationTimelineEntry,
  ProjectActions,
  ProjectFileView,
  ProjectGates,
  ProjectPersonalView,
  ProjectTreeRow,
} from "@workbench/ui"
import "@workbench/ui/theme.css"
import "@workbench/ui/layout.css"
import "@workbench/ui/conversation.css"
import "@workbench/ui/project.css"
import "./preview.css"

type Page = "local" | "remote" | "overview" | "task" | "tasks" | "info" | "knowledge" | "new"
type Modal = "directory" | "reference" | "create-task" | "new-project" | null
type RemoteKey = "lee" | "wang" | "other-device"
const scope = {
  namespace: "visual-design",
  accountId: "zhangsan",
  workspaceId: "team",
  deviceId: "this-device",
  projectId: "payment",
}
const enabled = { enabled: true } as const
const unavailable = { enabled: false, reason: "设计稿中的示例数据" } as const
const date = new Date(2026, 10, 12, 15, 56).getTime()
const remoteSessions: Record<
  RemoteKey,
  { title: string; owner: string; device: string; brief: string; time: string }
> = {
  lee: {
    title: "服务 A · 幂等接口设计",
    owner: "李四",
    device: "李四的工作电脑",
    brief:
      "已确认支付服务使用业务请求号作为幂等键，重复请求返回首次处理结果。接口设计已完成，目前正在补充并发请求和超时重试的边界说明，下一步与订单服务对齐状态回传。",
    time: "16:08",
  },
  wang: {
    title: "服务 B · 错误码约定",
    owner: "王五",
    device: "王五的工作电脑",
    brief:
      "已整理订单服务与支付服务的错误码映射。需要区分可重试的网络异常和确定失败的业务结果，准备补充到统一接口文档。",
    time: "16:03",
  },
  "other-device": {
    title: "支付异常分析",
    owner: "张三",
    device: "我的另一台电脑",
    brief: "已分析支付请求超时的主要原因，整理了需要进一步核对的接口与监控点。",
    time: "昨天 18:21",
  },
}
const localEntries: ConversationTimelineEntry[] = [
  {
    kind: "message",
    id: "u1",
    role: "user",
    text: "这次支付重试会同时涉及支付服务和订单服务。先帮我梳理调用链和幂等边界。",
    createdAtMs: date,
  },
  {
    kind: "message",
    id: "a1",
    role: "assistant",
    text: "我先阅读两个服务的接口约定，确认请求号、重试和结果回传的关系。",
    createdAtMs: date + 16000,
  },
  {
    kind: "tool",
    id: "t1",
    label: "读取文件",
    originalName: "read_file",
    summary: "payment-api/docs/retry.md",
    status: "completed",
    tone: "read",
    detail: {
      blocks: [
        {
          kind: "file",
          path: "payment-api/docs/retry.md",
          rangeLabel: "1–5 行",
          truncated: false,
          lines: [
            { number: 1, text: "# 支付重试与幂等约定" },
            { number: 2, text: "同一业务请求号只产生一次有效支付。" },
            { number: 3, text: "网络超时不直接视为支付失败。" },
            { number: 4, text: "订单侧查询结果后决定是否重试。" },
            { number: 5, text: "重试沿用首次业务请求号。" },
          ],
        },
      ],
    },
  },
  {
    kind: "tool",
    id: "t2",
    label: "检索代码",
    originalName: "search",
    summary: "order-api/src/payment · 3 处引用",
    status: "completed",
    tone: "read",
    detail: {
      outputText:
        "createPayment → getPaymentResult → retryPayment\n找到 3 处调用关系，均使用 paymentRequestId。",
    },
  },
  {
    kind: "message",
    id: "a2",
    role: "assistant",
    text: "调用链可以分成两条：\n\n- **支付服务**：识别同一业务请求，保存首次处理结果，重复调用返回相同结果。\n- **订单服务**：超时后先查询支付状态，只有明确可重试时才重发请求。\n\n建议先对齐 `paymentRequestId` 的生命周期，再分别补充两侧的异常处理。你也可以引用李四的接口讨论，一起核对已经确认的结论。",
    createdAtMs: date + 38000,
  },
]
function getRemoteEntries(key: RemoteKey): ConversationTimelineEntry[] {
  const session = remoteSessions[key]
  return [
    {
      kind: "message",
      id: "ru1",
      role: "user",
      author: { id: key, displayName: session.owner },
      text: `关于“${session.title}”，请整理已经确认的结论和下一步。`,
      createdAtMs: date,
    },
    { kind: "message", id: "ra1", role: "assistant", text: session.brief, createdAtMs: date + 40000 },
    {
      kind: "tool",
      id: "rt1",
      label: "工具调用摘要",
      summary: "已整理接口约定与讨论结论",
      status: "completed",
      tone: "neutral",
      detail: { outputText: "已整理本次讨论的接口约定。这里展示已上传的工具摘要。" },
    },
  ]
}
const fileContents: Record<string, string> = {
  "README.md":
    "# 支付体验优化\n\n本目录用于支付重试方案讨论与功能开发。\n\n- payment-api：支付服务\n- order-api：订单服务\n- docs：接口与业务约定\n",
  "payment-api/src/retry.ts":
    "import { getPaymentResult } from './payment';\n\nexport async function retryPayment(requestId: string) {\n  const result = await getPaymentResult(requestId);\n\n  if (result.status === 'succeeded') {\n    return result;\n  }\n\n  return { requestId, retryable: result.retryable };\n}\n",
  "payment-api/docs/retry.md":
    "# 支付重试与幂等\n\n同一业务请求号只产生一次有效支付。\n\n1. 超时先查询结果。\n2. 重试沿用原请求号。\n3. 明确失败和结果未知分别处理。\n",
  "order-api/src/payment.ts":
    "export type PaymentStatus =\n  | 'pending'\n  | 'succeeded'\n  | 'failed';\n\nexport function canRetry(status: PaymentStatus) {\n  return status === 'pending';\n}\n",
}
const files: Record<string, ProjectFileView> = Object.fromEntries(
  Object.entries(fileContents).map(([path, content]) => [
    path,
    {
      status: "ready",
      file: {
        path,
        content,
        language: path.endsWith(".ts") ? "typescript" : "markdown",
        sizeBytes: new TextEncoder().encode(content).length,
        lineCount: content.trimEnd().split("\n").length,
        truncated: false,
        freshness: "live",
      },
    },
  ]),
)
const rows: ProjectTreeRow[] = [
  {
    path: "payment-api",
    name: "payment-api",
    kind: "directory",
    depth: 0,
    expanded: true,
    loading: false,
    hasChildren: true,
  },
  {
    path: "payment-api/src/retry.ts",
    name: "src/retry.ts",
    kind: "file",
    depth: 1,
    expanded: false,
    loading: false,
    hasChildren: false,
  },
  {
    path: "payment-api/docs/retry.md",
    name: "docs/retry.md",
    kind: "file",
    depth: 1,
    expanded: false,
    loading: false,
    hasChildren: false,
  },
  {
    path: "order-api",
    name: "order-api",
    kind: "directory",
    depth: 0,
    expanded: true,
    loading: false,
    hasChildren: true,
  },
  {
    path: "order-api/src/payment.ts",
    name: "src/payment.ts",
    kind: "file",
    depth: 1,
    expanded: false,
    loading: false,
    hasChildren: false,
  },
  {
    path: "README.md",
    name: "README.md",
    kind: "file",
    depth: 0,
    expanded: false,
    loading: false,
    hasChildren: false,
  },
]
function initialPersonal(): ConversationPersonalState {
  return {
    scroll: { anchorEntryId: null, offsetPx: 0, following: false, seenContentRevision: null },
    expandedTools: [],
    expandedOutputs: [],
    draft: {
      text: "",
      selectionStart: 0,
      selectionEnd: 0,
      revision: 0,
      referenceIds: [],
      attachmentIds: [],
    },
    interactions: {},
  }
}
const initialProject: ProjectPersonalView = {
  dockOpen: true,
  dockWidthPx: 340,
  panel: "files",
  selectedPath: "README.md",
  fileTabs: [{ path: "README.md", name: "README.md" }],
  activeFilePath: "README.md",
  selectedChanges: [],
  commitMessage: "",
}
const gates: ProjectGates = {
  refreshTree: unavailable,
  openFile: enabled,
  refreshFile: unavailable,
  openCentral: enabled,
  refreshChanges: unavailable,
  readDiff: unavailable,
  commit: unavailable,
  push: unavailable,
}
const referenceText =
  "已确认支付服务使用业务请求号作为幂等键；重复请求返回首次处理结果；超时先查询状态，再决定重试。"
function Tag({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span className="status-tag" data-tone={tone}>
      {children}
    </span>
  )
}
function Avatar({ name, tone }: { name: string; tone?: string }) {
  return (
    <span className="person-avatar" data-tone={tone}>
      {name.slice(0, 1)}
    </span>
  )
}

function Preview() {
  const [page, setPage] = useState<Page>("local")
  const [remoteKey, setRemoteKey] = useState<RemoteKey>("lee")
  const [theme, setTheme] = useState(
    () => localStorage.getItem("hc-collaboration-design-theme") ?? "light",
  )
  const [settings, setSettings] = useState(false),
    [projectMenu, setProjectMenu] = useState(false)
  const [leftOpen, setLeftOpen] = useState(true),
    [leftWidth, setLeftWidth] = useState(280),
    [rightOpen, setRightOpen] = useState(true)
  const [project, setProject] = useState(initialProject),
    [centralPath, setCentralPath] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [personal, setPersonal] = useState<Record<string, ConversationPersonalState>>({
    local: initialPersonal(),
  })
  const [extraEntries, setExtraEntries] = useState<ConversationTimelineEntry[]>([])
  const [references, setReferences] = useState<ConversationReferenceView[]>([])
  const [modal, setModal] = useState<Modal>(null),
    [toast, setToast] = useState("")
  const [directoryPurpose, setDirectoryPurpose] = useState<"local" | "new" | "task">("local")
  const [directoryInput, setDirectoryInput] = useState("")
  const [localDirectory, setLocalDirectory] = useState("/Users/zhangsan/Projects/payment-work")
  const [newDirectory, setNewDirectory] = useState("")
  const [newDraft, setNewDraft] = useState("")
  const [synced, setSynced] = useState<Partial<Record<RemoteKey, boolean>>>({ wang: true })
  const [syncing, setSyncing] = useState<RemoteKey | null>(null)
  // 仅视觉稿本地阶段，不定义或映射服务端任务状态机。
  const [taskAccepted, setTaskAccepted] = useState(false)
  const [search, setSearch] = useState("")
  const [collapsedMembers, setCollapsedMembers] = useState<string[]>(["李四", "王五"])
  const [taskFilter, setTaskFilter] = useState("指派给我")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem("hc-collaboration-design-theme", theme)
  }, [theme])
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(""), 3200)
    return () => clearTimeout(id)
  }, [toast])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModal(null)
        setProjectMenu(false)
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [])
  useEffect(() => {
    if (page === "remote") {
      setCollapsedMembers((previous) => previous.filter((owner) => owner !== remoteSessions[remoteKey].owner))
    }
  }, [page, remoteKey])
  const remote = remoteSessions[remoteKey]
  const isLocal = page === "local"
  const stateKey = isLocal ? "local" : `remote-${remoteKey}`
  const conversationScope = { ...scope, conversationId: stateKey }
  const conversationPersonal = personal[stateKey] ?? initialPersonal()
  const title = {
    local: "支付失败重试方案",
    remote: remote.title,
    overview: "项目概览",
    task: "任务详情",
    tasks: "项目任务",
    info: "项目资料",
    knowledge: "团队知识",
    new: "新建会话",
  }[page]
  const toggleTheme = () => setTheme((value) => (value === "light" ? "dark" : "light"))
  const rendering = {
    copyText: async (text: string) => {
      await navigator.clipboard.writeText(text)
    },
  }
  function updatePersonal(incoming: { conversationId: string }, change: ConversationPersonalChange) {
    setPersonal((previous) => {
      const value = previous[incoming.conversationId] ?? initialPersonal()
      let next = value
      switch (change.kind) {
        case "scroll":
          next = { ...value, scroll: change.value }
          break
        case "tool":
          next = {
            ...value,
            expandedTools: change.expanded
              ? [...value.expandedTools, change.entryId]
              : value.expandedTools.filter((id) => id !== change.entryId),
          }
          break
        case "output":
          next = {
            ...value,
            expandedOutputs: change.expanded
              ? [...value.expandedOutputs, change.entryId]
              : value.expandedOutputs.filter((id) => id !== change.entryId),
          }
          break
        case "draft-text":
          next = {
            ...value,
            draft: {
              ...value.draft,
              text: change.text,
              selectionStart: change.selectionStart,
              selectionEnd: change.selectionEnd,
              revision: value.draft.revision + 1,
            },
          }
          break
        case "draft-references":
          next = {
            ...value,
            draft: {
              ...value.draft,
              referenceIds: change.referenceIds,
              revision: value.draft.revision + 1,
            },
          }
          break
        case "clear-draft":
          if (value.draft.revision === change.expectedRevision)
            next = {
              ...value,
              draft: { ...initialPersonal().draft, revision: value.draft.revision + 1 },
            }
          break
      }
      return { ...previous, [incoming.conversationId]: next }
    })
  }
  function addReference(kind: "conversation" | "knowledge" | "task" = "conversation") {
    const id = `preview-${kind}`
    const sourceLabel =
      kind === "knowledge"
        ? "团队知识 · 接口幂等规约"
        : kind === "task"
          ? "TASK-024 · 对齐支付超时与重试边界"
          : "李四 · 服务 A 幂等接口设计"
    setReferences((previous) => [
      ...previous.filter((item) => item.id !== id),
      {
        id,
        sourceLabel,
        rangeLabel: kind === "knowledge" ? "v3 · 固定版本" : "16:08 · 引用快照",
        snapshotText: referenceText,
        status: "ready",
        actions: { open: enabled, refresh: enabled, remove: enabled },
      },
    ])
    setPersonal((previous) => {
      const value = previous.local
      return {
        ...previous,
        local: {
          ...value,
          draft: {
            ...value.draft,
            referenceIds: [...new Set([...value.draft.referenceIds, id])],
            revision: value.draft.revision + 1,
          },
        },
      }
    })
    setModal(null)
    setPage("local")
    setCentralPath(null)
    setToast("已加入当前输入草稿，等待你发送")
  }
  function openDirectory(purpose: "local" | "new" | "task") {
    setDirectoryPurpose(purpose)
    setDirectoryInput(purpose === "local" ? localDirectory : "")
    setModal("directory")
  }
  function chooseDirectory() {
    const path = directoryInput.trim()
    if (!path) return
    if (directoryPurpose === "new") setNewDirectory(path)
    else {
      setLocalDirectory(path)
      if (directoryPurpose === "task") {
        setTaskAccepted(true)
        addReference("task")
      }
    }
    setModal(null)
    setToast(directoryPurpose === "task" ? "已打开本机任务会话预览，未调用 Agent" : "已选择预览工作目录")
  }
  function syncRemote() {
    const key = remoteKey
    setSyncing(key)
    timer.current = setTimeout(() => {
      setSynced((previous) => ({ ...previous, [key]: true }))
      setSyncing(null)
      setToast("已展示示例会话正文，后续正文仍需主动同步")
    }, 450)
  }
  function openFile(path: string) {
    setProject((previous) => ({
      ...previous,
      selectedPath: path,
      activeFilePath: path,
      fileTabs: [
        ...previous.fileTabs.filter((item) => item.path !== path),
        { path, name: path.split("/").at(-1)! },
      ],
    }))
  }
  const projectActions: ProjectActions = {
    setDockOpen: (_scope, open) => setRightOpen(open),
    setDockWidth: (_scope, width) => setProject((value) => ({ ...value, dockWidthPx: width })),
    selectPanel: (_scope, panel) => setProject((value) => ({ ...value, panel })),
    toggleDirectory: (_scope, path) =>
      setCollapsed((value) =>
        value.includes(path) ? value.filter((item) => item !== path) : [...value, path],
      ),
    refreshTree: () => {},
    openFile: (_scope, path) => openFile(path),
    selectFileTab: (_scope, path) => setProject((value) => ({ ...value, activeFilePath: path })),
    closeFileTab: (_scope, path) =>
      setProject((value) => {
        const tabs = value.fileTabs.filter((item) => item.path !== path)
        return {
          ...value,
          fileTabs: tabs,
          activeFilePath:
            value.activeFilePath === path ? (tabs.at(-1)?.path ?? null) : value.activeFilePath,
        }
      }),
    refreshFile: () => {},
    openCentralFile: (_scope, path) => setCentralPath(path),
    refreshChanges: () => {},
    readDiff: () => {},
    setSelectedChanges: () => {},
    setCommitMessage: () => {},
    commit: () => {},
    push: () => {},
  }
  const composer: ConversationComposerView = {
    send: isLocal ? enabled : unavailable,
    cancel: unavailable,
    primaryActions: isLocal ? "send" : "none",
    commands: [],
    controls: isLocal
      ? [
          {
            id: "model",
            label: "Harness",
            selectedId: "default",
            availability: enabled,
            items: [{ id: "default", label: "默认模型", availability: enabled }],
          },
        ]
      : [],
    projectTarget: null,
    references,
    attachments: [],
  }
  const localView = (
    <ConversationView
      scope={conversationScope}
      visible={!centralPath}
      entries={[...localEntries, ...extraEntries]}
      contentRevision={extraEntries.length}
      interaction={null}
      personal={conversationPersonal}
      composer={composer}
      actions={{
        onPersonalChange: updatePersonal,
        onSend: async (_scope, _revision, text) => {
          setExtraEntries((value) => [
            ...value,
            {
              kind: "message",
              id: `draft-${value.length}`,
              role: "user",
              text,
              createdAtMs: Date.now(),
            },
          ])
          setToast("仅更新视觉稿中的对话，未调用 Agent")
          return { status: "accepted" }
        },
        onCapabilitySelect: () => {},
        onReferenceAction: (_scope, id, action) => {
          if (action === "remove")
            updatePersonal(conversationScope, {
              kind: "draft-references",
              referenceIds: conversationPersonal.draft.referenceIds.filter((item) => item !== id),
            })
          else if (action === "open") setModal("reference")
          else setToast("引用预览仍使用固定示例快照")
        },
        rendering,
      }}
      slots={{
        aboveTimeline: (
          <div className="directory-row">
            <button
              className="directory-button"
              onClick={() => openDirectory("local")}
              title={localDirectory}
            >
              <Folder size={13} />
              工作目录 · {localDirectory.split("/").at(-1)}
              <ChevronDown size={12} />
            </button>
            <Tag>
              <Laptop size={10} />
              本机
            </Tag>
          </div>
        ),
        composer: (
          <button type="button" className="context-button" onClick={() => setModal("reference")}>
            <Plus size={13} />
            添加上下文
          </button>
        ),
      }}
    />
  )
  const sessionHeader = (readonly: boolean) => (
    <div className="session-heading">
      <div>
        <h1>{title}</h1>
        <div className="session-subtitle">
          <span>{readonly ? remote.owner : "张三"}</span>
          <span>·</span>
          <span>{readonly ? remote.device : "当前设备"}</span>
          {readonly ? (
            <Tag>
              <LockKeyhole size={10} />
              只读
            </Tag>
          ) : (
            <Tag tone="success">本机会话</Tag>
          )}
        </div>
      </div>
      <div className="remote-actions">
        {readonly && synced[remoteKey] ? (
          <button className="button" onClick={syncRemote}>
            <RefreshCw size={13} />
            同步更新
          </button>
        ) : null}
        {!readonly ? (
          <Tag>
            <Users size={11} />
            Project 内共享
          </Tag>
        ) : null}
        <button
          className="icon-button"
          aria-label="更多操作"
          onClick={() => setToast("会话链接和展示设置将在这里收纳")}
        >
          <MoreHorizontal size={18} />
        </button>
      </div>
    </div>
  )
  const remoteView = (
    <div className="session-center design-remote-view">
      {sessionHeader(true)}
      {synced[remoteKey] ? (
        <>
          <div className="remote-synced-note">
            <CheckCheck size={13} />
            已同步至 {remote.time}
            <span>·</span>当前显示已下载的消息
          </div>
          <div className="conversation-wrap">
            <ConversationView
              scope={conversationScope}
              visible
              entries={getRemoteEntries(remoteKey)}
              contentRevision={1}
              composer={composer}
              interaction={null}
              personal={conversationPersonal}
              actions={{ onPersonalChange: updatePersonal, rendering }}
            />
          </div>
        </>
      ) : (
        <div className="remote-body">
          <div className="remote-brief">
            <div className="eyebrow">会话简报</div>
            <p className="brief-text">{remote.brief}</p>
            <div className="brief-facts">
              <span>
                <Clock size={13} />
                最近上传于 {remote.time}
              </span>
              <span>
                <MessageSquare size={13} />
                20 条已上传消息
              </span>
              <span>
                <GitBranch size={13} />
                payment-api
              </span>
            </div>
            <div className="remote-download">
              <span className="download-icon">
                <MessageSquare size={18} />
              </span>
              <div>
                <h3>正文尚未同步到这台电脑</h3>
                <p>主动同步后，查看已上传的对话和工具摘要。</p>
              </div>
              <button className="button primary" onClick={syncRemote} disabled={syncing === remoteKey}>
                <RefreshCw size={13} />
                {syncing === remoteKey ? "正在同步…" : "同步会话"}
              </button>
            </div>
            <div className="remote-footnote">
              <ShieldCheck size={13} />
              查看会话不会操作对方的 Agent 或文件。
            </div>
          </div>
        </div>
      )}
      <div className="remote-action-bar">
        <span>
          <LockKeyhole size={13} />
          跨机器会话仅供阅读
        </span>
        <div className="remote-actions">
          <button className="button quiet" onClick={() => setModal("create-task")}>
            <Plus size={13} />
            创建任务
          </button>
          <button className="button" onClick={() => addReference()}>
            <Link2 size={13} />
            引用到我的会话
          </button>
        </div>
      </div>
    </div>
  )
  const taskCard = (id: string, text: string, owner: string, label: string) => (
    <button className="task-card" onClick={() => setPage("task")}>
      <small>{id}</small>
      <h4>{text}</h4>
      <footer>
        <span>
          <Avatar name={owner} tone="neutral" />
          {owner}
        </span>
        <span>{label}</span>
      </footer>
    </button>
  )
  const overview = (
    <div className="page-scroll">
      <div className="page-content">
        <div className="page-heading">
          <div>
            <h1>支付体验优化</h1>
            <p>对齐支付重试与订单回传，让异常处理更清楚。</p>
          </div>
          <div className="remote-actions">
            <button className="button" onClick={() => setPage("info")}>
              <Users size={13} />
              项目资料
            </button>
            <button className="button primary" onClick={() => setModal("create-task")}>
              <Plus size={14} />
              创建任务
            </button>
          </div>
        </div>
        <div className="overview-summary">
          <span>
            <strong>3</strong>位成员
          </span>
          <span>
            <strong>3</strong>条会话
          </span>
          <span>
            <strong>1</strong>项进行中的任务
          </span>
          <span>
            <RefreshCw size={11} />
            更新于 16:10
          </span>
        </div>
        <div className="section-heading">
          <h2>成员进展</h2>
          <span>点击会话，主动同步正文</span>
        </div>
        <div className="member-grid">
          {[
            {
              name: "张三",
              title: "支付失败重试方案",
              text: "梳理支付与订单服务的调用链，核对重试边界。",
              tag: "讨论中",
              key: null,
            },
            {
              name: "李四",
              title: remoteSessions.lee.title,
              text: "幂等接口设计已确认，正在整理超时处理规则。",
              tag: "设计已确认",
              key: "lee",
            },
            {
              name: "王五",
              title: remoteSessions.wang.title,
              text: "已整理错误码映射，准备补充统一接口文档。",
              tag: "进行中",
              key: "wang",
            },
          ].map((member) => (
            <button
              className="member-card"
              key={member.name}
              onClick={() => {
                if (member.key) {
                  setRemoteKey(member.key as RemoteKey)
                  setPage("remote")
                } else setPage("local")
              }}
            >
              <div className="member-card-header">
                <Avatar
                  name={member.name}
                  tone={
                    member.name === "王五" ? "green" : member.name === "李四" ? "neutral" : undefined
                  }
                />
                <strong>{member.name}</strong>
                <Tag>{member.tag}</Tag>
              </div>
              <h3>{member.title}</h3>
              <p>{member.text}</p>
              <footer>
                <span>{member.name === "张三" ? "当前设备" : "最近上传于 16:08"}</span>
                <span>
                  查看会话
                  <ArrowUpRight size={12} />
                </span>
              </footer>
            </button>
          ))}
        </div>
        <div className="section-heading">
          <h2>项目任务</h2>
          <button onClick={() => setPage("tasks")}>
            查看全部
            <ArrowRight size={11} />
          </button>
        </div>
        <div className="task-grid">
          <section className="task-column">
            <h3>
              <Circle size={11} />
              待处理<small>2</small>
            </h3>
            {taskCard("TASK-024", "对齐支付超时与重试边界", "张三", "李四发起")}
            {taskCard("TASK-025", "补充订单状态回传的接口约定", "王五", "15:40")}
          </section>
          <section className="task-column">
            <h3>
              <Clock size={11} />
              进行中<small>1</small>
            </h3>
            {taskCard("TASK-021", "支付幂等键与重复请求处理", "李四", "正在开发")}
          </section>
          <section className="task-column">
            <h3>
              <CheckSquare size={11} />
              已完成<small>1</small>
            </h3>
            {taskCard("TASK-018", "梳理支付调用链与异常分类", "张三", "今天 14:20")}
          </section>
        </div>
      </div>
    </div>
  )
  const task = (
    <div className="page-scroll">
      <div className="page-content detail-content">
        <button className="back-link" onClick={() => setPage("tasks")}>
          <ArrowLeft size={13} />
          返回项目任务
        </button>
        <div className="session-subtitle">
          <span>TASK-024</span>
          <span>·</span>
          <span>支付体验优化</span>
          <Tag tone={taskAccepted ? "success" : "accent"}>{taskAccepted ? "已接收" : "待接收"}</Tag>
        </div>
        <h1 className="task-title">对齐支付超时与重试边界</h1>
        <dl className="task-properties">
          <dt>被指派人</dt>
          <dd>
            <Avatar name="张三" />
            张三<Tag>我</Tag>
          </dd>
          <dt>发起人</dt>
          <dd>
            <Avatar name="李四" tone="neutral" />
            李四
          </dd>
          <dt>涉及仓库</dt>
          <dd>
            <span className="repository-chip">
              <GitBranch size={12} />
              payment-api
            </span>
            <span className="repository-chip">
              <GitBranch size={12} />
              order-api
            </span>
          </dd>
          <dt>创建时间</dt>
          <dd>今天 16:10</dd>
        </dl>
        <section className="detail-section">
          <h2>任务说明</h2>
          <p>
            支付侧的幂等接口已确认。请结合订单侧调用链，补充超时后的查询与重试流程，明确哪些结果可以重试，哪些情况需要等待确认。
          </p>
        </section>
        <section className="detail-section">
          <h2>验收要点</h2>
          <ul>
            <li>支付重试沿用同一个业务请求号。</li>
            <li>订单侧区分网络异常和明确的业务失败。</li>
            <li>接口文档中补充超时、重复请求的返回示例。</li>
          </ul>
        </section>
        <section className="detail-section">
          <h2>相关上下文</h2>
          <button
            className="reference-card"
            onClick={() => {
              setRemoteKey("lee")
              setPage("remote")
            }}
          >
            <div className="reference-card-header">
              <MessageSquare size={14} />
              李四 · 幂等接口设计<span>固定快照 · 16:08</span>
            </div>
            <p>{referenceText}</p>
          </button>
        </section>
        <div className="task-detail-actions">
          {taskAccepted ? (
            <button className="button primary" onClick={() => openDirectory("task")}>
              <Laptop size={14} />
              在本机开始
            </button>
          ) : (
            <>
              <button
                className="button primary"
                onClick={() => {
                  setTaskAccepted(true)
                  setToast("任务已在设计稿中标记为接收，未启动 Agent")
                }}
              >
                <Check size={14} />
                接受任务
              </button>
              <button
                className="button"
                onClick={() => setToast("拒绝任务时将填写原因，此稿不提交业务记录")}
              >
                拒绝
              </button>
            </>
          )}
          <small>
            {taskAccepted
              ? "选择自己的会话和工作目录，主动开始。"
              : "接收只表示认领，执行由你主动开始。"}
          </small>
        </div>
      </div>
    </div>
  )
  const taskList = (
    <div className="page-scroll">
      <div className="page-content">
        <div className="page-heading">
          <div>
            <h1>项目任务</h1>
            <p>查看需要我处理的任务，以及项目内的协作进度。</p>
          </div>
          <button className="button primary" onClick={() => setModal("create-task")}>
            <Plus size={14} />
            创建任务
          </button>
        </div>
        <div className="session-filter" style={{ padding: "0 0 16px", justifyContent: "flex-start" }}>
          {["指派给我", "我发布的", "项目全部"].map((label) => (
            <button key={label} data-active={taskFilter === label} onClick={() => setTaskFilter(label)}>
              {label}
            </button>
          ))}
        </div>
        <div className="preview-list">
          {["对齐支付超时与重试边界", "补充订单状态回传的接口约定", "支付幂等键与重复请求处理"].map(
            (text, index) => (
              <button className="preview-list-row" key={text} onClick={() => setPage("task")}>
                <CheckSquare size={17} />
                <span>
                  <strong>{text}</strong>
                  <small>
                    TASK-0{24 + index} · {index === 0 ? "指派给我" : "项目协作"} · 今天 16:05
                  </small>
                </span>
                <Tag tone={index === 0 ? "accent" : undefined}>
                  {index === 0 && taskAccepted ? "已接收" : index === 2 ? "进行中" : "待处理"}
                </Tag>
                <ArrowRight size={13} />
              </button>
            ),
          )}
        </div>
      </div>
    </div>
  )
  const info = (
    <div className="page-scroll">
      <div className="page-content detail-content">
        <div className="page-heading">
          <div>
            <h1>项目资料</h1>
            <p>支付体验优化 · 研发协作组</p>
          </div>
          <Tag>张三创建</Tag>
        </div>
        <section className="detail-section">
          <h2>项目说明</h2>
          <p>梳理支付重试、幂等处理与订单状态回传，统一两个服务之间的异常处理体验。</p>
        </section>
        <section className="detail-section">
          <h2>项目成员</h2>
          <div className="preview-list">
            {["张三", "李四", "王五"].map((name) => (
              <div className="preview-list-row" key={name}>
                <Avatar name={name} tone={name === "张三" ? undefined : "neutral"} />
                <strong>{name}</strong>
                <Tag>{name === "张三" ? "项目负责人" : "项目成员"}</Tag>
              </div>
            ))}
          </div>
        </section>
        <section className="detail-section">
          <h2>关联仓库</h2>
          {["payment-api", "order-api"].map((name) => (
            <div className="preview-list-row" key={name}>
              <GitBranch size={17} />
              <span>
                <strong>{name}</strong>
                <small>团队仓库 · main</small>
              </span>
              <Tag>已关联</Tag>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
  const knowledge = (
    <div className="page-scroll">
      <div className="page-content detail-content">
        <div className="page-heading">
          <div>
            <h1>团队知识</h1>
            <p>研发协作组 · 可供各项目引用的共同约定</p>
          </div>
          <Tag>
            <BookOpen size={11} />
            团队范围
          </Tag>
        </div>
        <section className="detail-section">
          <div className="section-heading">
            <h2>接口幂等规约</h2>
            <Tag>v3 · 李四更新</Tag>
          </div>
          <Markdown
            text={
              "为重复请求和异常重试提供统一约定。\n\n### 基本原则\n\n- 同一业务操作使用稳定的请求号。\n- 网络超时先查询结果，明确状态后再决定是否重试。\n- 结果未知和明确失败分别表达。\n\n### 通用术语\n\n**业务请求号**：标识一次独立业务意图；重试时沿用，不随网络请求变化。"
            }
          />
          <button className="button" onClick={() => addReference("knowledge")}>
            <Link2 size={13} />
            引用到我的会话
          </button>
        </section>
        <section className="detail-section">
          <h2>更多条目</h2>
          {["错误码命名约定", "服务间调用术语表"].map((name) => (
            <button
              className="preview-list-row"
              key={name}
              onClick={() => setToast("该条目的阅读布局沿用当前知识正文")}
            >
              <FileText size={15} />
              <strong>{name}</strong>
              <Tag>v1</Tag>
            </button>
          ))}
        </section>
      </div>
    </div>
  )
  const newSession = (
    <div className="new-session">
      <h1>今天想推进什么？</h1>
      <p>在“支付体验优化”中创建自己的会话。</p>
      <div className="new-session-controls">
        <button className="button" onClick={() => openDirectory("new")}>
          <FolderOpen size={14} />
          {newDirectory ? newDirectory.split("/").at(-1) : "选择文件夹"}
          <ChevronDown size={12} />
        </button>
        <span className="repository-chip">Harness · 本机</span>
      </div>
      <textarea
        value={newDraft}
        onChange={(event) => setNewDraft(event.target.value)}
        placeholder="描述你想讨论或完成的事情…"
      />
      <div className="new-session-send">
        <button
          className="button primary"
          disabled={!newDirectory || !newDraft.trim()}
          onClick={() => {
            setLocalDirectory(newDirectory)
            setExtraEntries((value) => [
              ...value,
              { kind: "message", id: `new-${value.length}`, role: "user", text: newDraft },
            ])
            setPage("local")
            setToast("已打开新会话的视觉示例，未创建真实会话")
          }}
        >
          <ArrowRight size={14} />
          开始会话
        </button>
      </div>
      <p className="design-note" style={{ marginTop: 19 }}>
        目录由你选择，可以是普通文件夹。
      </p>
    </div>
  )
  const memberSessions = [
    { owner: "张三", sessions: [{ key: "local", title: "支付失败重试方案" }] },
    {
      owner: "李四",
      sessions: [{ key: "lee", title: remoteSessions.lee.title }],
    },
    {
      owner: "王五",
      sessions: [{ key: "wang", title: remoteSessions.wang.title }],
    },
  ]
    .map((member) => ({
      ...member,
      sessions: member.sessions.filter((session) =>
        `${member.owner} ${session.title}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      ),
    }))
    .filter((member) => member.sessions.length > 0)
  const navigation = (
    <div className="design-nav">
      <div className="nav-brand">
        <span className="nav-brand-mark">
          <BrandMark />
        </span>
        Harness Code
      </div>
      <button
        className="new-conversation"
        data-active={page === "new"}
        onClick={() => setPage("new")}
      >
        <SquarePen size={17} />
        新对话
      </button>
      <div className="nav-search">
        <Search size={16} />
        <input
          aria-label="搜索成员或会话"
          placeholder="搜索成员或会话"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="nav-project">
        <button
          className="project-switch"
          aria-expanded={projectMenu}
          onClick={() => setProjectMenu((value) => !value)}
        >
          <span>
            <FolderOpen size={15} />
            支付体验优化
          </span>
          <ChevronDown size={14} />
        </button>
        <button
          className="icon-button project-settings"
          aria-label="项目设置"
          title="项目设置 · 资料与成员"
          data-active={page === "info"}
          onClick={() => {
            setPage("info")
            setProjectMenu(false)
          }}
        >
          <Settings size={14} />
        </button>
        {projectMenu ? (
          <div className="nav-project-menu" aria-label="切换项目">
            <div className="project-menu-label">项目</div>
            <button onClick={() => setProjectMenu(false)}>
              <Check size={14} />
              支付体验优化
            </button>
            <button
              className="project-menu-create"
              onClick={() => {
                setModal("new-project")
                setProjectMenu(false)
              }}
            >
              <Plus size={14} />
              创建项目
            </button>
          </div>
        ) : null}
      </div>
      <div className="project-nav" aria-label="项目工具">
        <button
          data-active={page === "overview"}
          onClick={() => setPage("overview")}
        >
          <LayoutGrid size={14} />
          看板
        </button>
        <button
          data-active={page === "tasks" || page === "task"}
          onClick={() => setPage("tasks")}
        >
          <ListChecks size={14} />
          任务<span className="nav-task-count">2</span>
        </button>
      </div>
      <div className="session-list" data-searching={Boolean(search.trim())} aria-label="按成员分组的项目会话">
        {memberSessions.length === 0 ? (
          <p className="session-empty">没有匹配的成员或会话</p>
        ) : null}
        {memberSessions.map((member) => {
          const expanded =
            Boolean(search.trim()) || !collapsedMembers.includes(member.owner)
          const groupId = `member-sessions-${member.owner}`
          return (
            <section
              className="member-sessions"
              data-self={member.owner === "张三"}
              data-expanded={expanded}
              key={member.owner}
            >
              <button
                className="member-toggle"
                aria-expanded={expanded}
                aria-controls={groupId}
                onClick={() => {
                  setCollapsedMembers((previous) =>
                    previous.includes(member.owner)
                      ? previous.filter((name) => name !== member.owner)
                      : [...previous, member.owner],
                  )
                }}
              >
                {expanded ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
                <Avatar
                  name={member.owner}
                  tone={member.owner === "张三" ? undefined : "neutral"}
                />
                <span>
                  {member.owner === "张三" ? "我的会话" : member.owner}
                </span>
                <span className="member-session-count">
                  {member.sessions.length}
                </span>
              </button>
              <div
                id={groupId}
                hidden={!expanded}
                className="member-session-items"
              >
                {member.sessions.map((item) => {
                  const active =
                    item.key === "local"
                      ? isLocal
                      : page === "remote" && remoteKey === item.key
                  return (
                    <button
                      className="session-row"
                      key={item.key}
                      title={item.title}
                      aria-current={active ? "page" : undefined}
                      data-active={active}
                      onClick={() => {
                        setCentralPath(null)
                        if (item.key === "local") setPage("local")
                        else {
                          setRemoteKey(item.key as RemoteKey)
                          setPage("remote")
                        }
                      }}
                    >
                      <MessageSquare size={15} />
                      <span className="session-copy">
                        <span className="session-title">{item.title}</span>
                        <span className="session-meta">
                          {item.key === "local"
                            ? "进行中"
                            : synced[item.key as RemoteKey]
                              ? "已同步 · 只读"
                              : "未同步"}
                          <time>
                            {item.key === "local"
                              ? "15:56"
                              : remoteSessions[item.key as RemoteKey].time}
                          </time>
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
      <div className="nav-bottom">
        <button
          className="nav-item"
          data-active={page === "knowledge"}
          onClick={() => setPage("knowledge")}
        >
          <BookOpen size={16} />
          团队知识
        </button>
        <div className="nav-account">
          <Avatar name="张三" />
          <span className="nav-account-copy">
            <strong>研发协作组</strong>
            <small>张三</small>
          </span>
          <button
            className="icon-button"
            aria-label="设置"
            onClick={() => setSettings(true)}
          >
            <Settings size={16} />
          </button>
        </div>
      </div>
    </div>
  )
  const localCenter = (
    <div className="session-center">
      {sessionHeader(false)}
      <div className="session-tabs">
        <button className="session-tab" data-active={!centralPath} onClick={() => setCentralPath(null)}>
          <MessageSquare size={15} />
          对话
        </button>
        {centralPath ? (
          <ProjectFileTab
            scope={scope}
            path={centralPath}
            name={centralPath.split("/").at(-1)!}
            selected
            tabId="central-file-tab"
            panelId="central-file-panel"
            onActivate={() => {}}
            onClose={() => setCentralPath(null)}
          />
        ) : null}
      </div>
      <div className="conversation-wrap" hidden={Boolean(centralPath)}>
        {localView}
      </div>
      {centralPath ? (
        <ProjectFilePanel
          scope={scope}
          path={centralPath}
          view={files[centralPath]}
          refresh={unavailable}
          onRefresh={() => {}}
          active
          tabId="central-file-tab"
          panelId="central-file-panel"
        />
      ) : null}
    </div>
  )
  const center = {
    local: localCenter,
    remote: remoteView,
    overview,
    task,
    tasks: taskList,
    info,
    knowledge,
    new: newSession,
  }[page]
  const directoryName = localDirectory.split("/").at(-1)!
  const folderRows = localDirectory.endsWith("design-notes")
    ? rows.filter((row) => row.path === "README.md")
    : rows
        .filter(
          (row) => row.depth === 0 || !collapsed.some((parent) => row.path.startsWith(`${parent}/`)),
        )
        .map((row) =>
          row.kind === "directory" ? { ...row, expanded: !collapsed.includes(row.path) } : row,
        )
  return (
    <div className="design-root">
      <div className="design-bar">
        <span>
          <b>项目协作 · 视觉稿</b>
          <small>示例数据，不连接服务或 Agent</small>
        </span>
        <div className="design-bar-actions">
          {[
            { page: "local", label: "本机会话" },
            { page: "remote", label: "远端只读" },
            { page: "task", label: "任务详情" },
            { page: "overview", label: "项目看板" },
          ].map((item) => (
            <button
              key={item.page}
              data-active={page === item.page}
              onClick={() => {
                if (item.page === "remote") setRemoteKey("lee")
                setPage(item.page as Page)
              }}
            >
              {item.label}
            </button>
          ))}
          <button aria-label="切换浅深主题" onClick={toggleTheme}>
            {theme === "light" ? <Moon size={13} /> : <Sun size={13} />}
          </button>
        </div>
      </div>
      <div className="design-shell" data-files={isLocal}>
        <WorkbenchLayout
          context={{
            title: "支付体验优化",
            projectName: title,
            connection: page === "remote" ? "只读查看" : undefined,
          }}
          navigation={navigation}
          center={center}
          right={(slot) =>
            isLocal ? (
              <ProjectDock
                scope={scope}
                projectName={directoryName}
                availability={{ state: "available" }}
                tree={{ status: "ready", rows: folderRows, limited: false }}
                files={files}
                changes={{ status: "ready", busy: false }}
                gates={gates}
                personal={{ ...project, dockOpen: slot.open, dockWidthPx: slot.widthPx }}
                actions={{
                  ...projectActions,
                  setDockOpen: (_scope, open) => slot.setOpen(open),
                  setDockWidth: (_scope, width) => slot.setWidth(width),
                }}
              />
            ) : null
          }
          leftOpen={leftOpen}
          leftWidthPx={leftWidth}
          rightOpen={isLocal && rightOpen}
          rightWidthPx={project.dockWidthPx}
          setPanelOpen={(side, open) => (side === "left" ? setLeftOpen(open) : setRightOpen(open))}
          setPanelWidth={(side, width) =>
            side === "left"
              ? setLeftWidth(width)
              : setProject((value) => ({ ...value, dockWidthPx: width }))
          }
          settingsOpen={settings}
          closeSettings={() => setSettings(false)}
          settings={
            <>
              <h2 className="settings-title">设置</h2>
              <div className="settings-row">
                <span>
                  外观<small>沿用工作台的浅色与深色主题</small>
                </span>
                <button className="button" onClick={toggleTheme}>
                  {theme === "light" ? <Sun size={14} /> : <Moon size={14} />}
                  {theme === "light" ? "浅色" : "深色"}
                </button>
              </div>
              <div className="settings-row">
                <span>当前团队</span>
                <strong>研发协作组</strong>
              </div>
              <div className="settings-row">
                <span>当前用户</span>
                <strong>张三</strong>
              </div>
              <p className="design-note">本页为隔离的视觉预览，使用固定示例数据。</p>
            </>
          }
        />
      </div>
      {modal ? (
        <div
          className="design-modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setModal(null)
          }}
        >
          <section
            className="design-modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "directory"
                ? "选择工作目录"
                : modal === "reference"
                  ? "添加上下文"
                  : modal === "new-project"
                    ? "创建项目"
                    : "创建任务"
            }
          >
            <div className="design-modal-head">
              <h2>
                {modal === "directory"
                  ? "选择工作目录"
                  : modal === "reference"
                    ? "添加上下文"
                    : modal === "new-project"
                      ? "创建项目"
                      : "创建任务"}
              </h2>
              <button className="icon-button" aria-label="关闭弹窗" onClick={() => setModal(null)}>
                <X size={17} />
              </button>
            </div>
            {modal === "directory" ? (
              <>
                <p>选择这次会话使用的文件夹，可以不是 Git 仓库。</p>
                <label>
                  工作目录
                  <input
                    aria-label="工作目录路径"
                    value={directoryInput}
                    onChange={(event) => setDirectoryInput(event.target.value)}
                    placeholder="选择文件夹，或输入预览路径"
                  />
                </label>
                {[
                  {
                    name: "payment-work",
                    path: "/Users/zhangsan/Projects/payment-work",
                    meta: "包含 payment-api 和 order-api",
                  },
                  {
                    name: "design-notes",
                    path: "/Users/zhangsan/Documents/design-notes",
                    meta: "普通文件夹 · 没有 Git 仓库",
                  },
                ].map((item) => (
                  <button
                    key={item.path}
                    className="reference-option"
                    onClick={() => setDirectoryInput(item.path)}
                  >
                    <FolderOpen size={18} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.meta}</small>
                    </span>
                    {directoryInput === item.path ? (
                      <Check size={16} style={{ marginLeft: "auto" }} />
                    ) : null}
                  </button>
                ))}
                <p className="modal-note">这是目录选择的交互示意，不读取你电脑上的文件。</p>
                <div className="modal-footer">
                  <button className="button" onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className="button primary"
                    disabled={!directoryInput.trim()}
                    onClick={chooseDirectory}
                  >
                    {directoryPurpose === "task" ? "选择并打开本机会话" : "确认选择"}
                  </button>
                </div>
              </>
            ) : modal === "reference" ? (
              <>
                <p>主动选择一份材料，作为当前问题的固定上下文。</p>
                <button className="reference-option" onClick={() => addReference()}>
                  <MessageSquare size={18} />
                  <span>
                    <strong>李四 · 服务 A 幂等接口设计</strong>
                    <small>会话快照 · 上传于 16:08</small>
                  </span>
                </button>
                <button className="reference-option" onClick={() => addReference("task")}>
                  <CheckSquare size={18} />
                  <span>
                    <strong>TASK-024 · 对齐支付超时与重试边界</strong>
                    <small>任务材料 · 当前版本</small>
                  </span>
                </button>
                <button className="reference-option" onClick={() => addReference("knowledge")}>
                  <BookOpen size={18} />
                  <span>
                    <strong>团队知识 · 接口幂等规约</strong>
                    <small>固定版本 v3</small>
                  </span>
                </button>
                <button className="reference-option" onClick={() => setModal("create-task")}>
                  <Users size={18} />
                  <span>
                    <strong>@李四 · 发布任务</strong>
                    <small>填写任务说明后明确发布</small>
                  </span>
                </button>
              </>
            ) : (
              <>
                <p>
                  {modal === "new-project"
                    ? "先创建协作事项，再设置成员和关联仓库。"
                    : "明确分派工作，由对方接收后在自己的电脑上开始。"}
                </p>
                <label>
                  {modal === "new-project" ? "项目名称" : "任务标题"}
                  <input
                    placeholder={
                      modal === "new-project" ? "例如：支付体验优化" : "例如：补充超时查询的处理规则"
                    }
                  />
                </label>
                {modal !== "new-project" ? (
                  <label>
                    被指派人
                    <select defaultValue="李四">
                      <option>李四</option>
                      <option>王五</option>
                      <option>张三</option>
                    </select>
                  </label>
                ) : null}
                <label>
                  {modal === "new-project" ? "项目说明" : "任务说明"}
                  <textarea placeholder="描述目标和需要对齐的内容…" />
                </label>
                {modal !== "new-project" ? (
                  <div className="reference-card">
                    <div className="reference-card-header">
                      <Link2 size={13} />
                      附带上下文
                    </div>
                    <p>李四 · 幂等接口设计的固定快照</p>
                  </div>
                ) : null}
                <div className="modal-footer">
                  <button className="button" onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className="button primary"
                    onClick={() => {
                      const isProject = modal === "new-project"
                      setModal(null)
                      setPage(isProject ? "info" : "tasks")
                      setToast(
                        isProject
                          ? "已打开项目资料的视觉示例，未创建真实项目"
                          : "仅展示任务发布后的视觉状态，未发送真实任务",
                      )
                    }}
                  >
                    {modal === "new-project" ? "创建并设置" : "发布任务"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}
      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Preview />)
