/** Ink 6.8 TUI 最小纵向切片：对话时间线、流式尾部与 InputBar。 */
/** @jsxImportSource react */
import { Box, Static, Text, render, useInput, useStdout, type Key } from "ink"
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

import type { TimelineItem } from "../../interactive/state"
import type { InteractiveController } from "../../interactive/types"
import type { AgentGateway } from "../../interactive/ports"
import type { WorkspaceExplorer } from "../../workspace/types"
import type { PresentationCoordinator } from "../../presentation-coordinator"
import { detectGitChangedFiles } from "../../infrastructure/git-workspace"
import { createTuiAdapter, type TuiAdapter, type TuiAdapterSnapshot } from "../application/adapter"
import { resolveShortcut, type ShortcutAction, type ShortcutContext, type TemporaryViewKind } from "../application/shortcuts"
import { createInputBuffer, inputBufferReducer, visibleInputLines, type InputBufferAction } from "./input-buffer"
import { isInkBackspace } from "./input-key"
import { TimelineProjector, timelineItemId } from "./timeline-projector"
import { MarkdownText } from "./markdown"
import { InteractionBottomArea } from "./bottom-area"
import { activePickerKind, InlineMenus } from "./menus"
import { TemporaryView } from "./temporary-view"
import { bottomAreaKind } from "../../presentation-shared/interaction-policy"

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export type TuiOptions = {
  controller: InteractiveController
  gateway?: AgentGateway
  workspaceExplorer?: WorkspaceExplorer
  resume?: boolean
  promptHistoryFile?: string
  openWeb?: (threadId: string | null) => Promise<void>
  webHandoff?: PresentationCoordinator
}

export type InkInputResolution =
  | { type: "buffer"; action: InputBufferAction }
  | { type: "submit" }
  | { type: "history"; direction: "previous" | "next" }
  | { type: "shortcut"; action: ShortcutAction }
  | { type: "ignore" }

function toKeyLike(input: string, key: Key): { name: string; ctrl: boolean; shift?: boolean } {
  let name = input.toLowerCase()
  if (key.return) name = "return"
  else if (key.escape) name = "escape"
  else if (key.tab) name = "tab"
  else if (key.upArrow) name = "up"
  else if (key.downArrow) name = "down"
  else if (key.leftArrow) name = "left"
  else if (key.rightArrow) name = "right"
  else if (key.pageUp) name = "pageup"
  else if (key.pageDown) name = "pagedown"
  else if (key.home) name = "home"
  else if (key.end) name = "end"
  else if (isInkBackspace(key)) name = "backspace"
  return { name, ctrl: Boolean(key.ctrl), shift: Boolean(key.shift) }
}

/** 将 Ink 键事件收敛为 InputBuffer 或现有 Adapter intent。 */
export function resolveInkInput(
  input: string,
  key: Key,
  context: ShortcutContext & { multiline?: boolean },
): InkInputResolution {
  if (key.eventType === "release") return { type: "ignore" }
  const shortcut = resolveShortcut(toKeyLike(input, key), context)
  if (shortcut !== "none") return { type: "shortcut", action: shortcut }
  if (key.return) {
    if (key.shift || key.meta || key.ctrl) return { type: "buffer", action: { type: "insert", text: "\n" } }
    return { type: "submit" }
  }
  if (key.ctrl && input.toLowerCase() === "j") return { type: "buffer", action: { type: "insert", text: "\n" } }
  if (key.leftArrow) return { type: "buffer", action: { type: "left" } }
  if (key.rightArrow) return { type: "buffer", action: { type: "right" } }
  if (key.upArrow) return context.multiline ? { type: "buffer", action: { type: "up" } } : { type: "history", direction: "previous" }
  if (key.downArrow) return context.multiline ? { type: "buffer", action: { type: "down" } } : { type: "history", direction: "next" }
  if (key.home) return { type: "buffer", action: { type: "home" } }
  if (key.end) return { type: "buffer", action: { type: "end" } }
  if (isInkBackspace(key)) return { type: "buffer", action: { type: "backspace" } }
  if (input && !key.ctrl && !key.super) return { type: "buffer", action: { type: "insert", text: input } }
  return { type: "ignore" }
}

function InputBar(props: { draft: string; draftCursor?: number; width?: number }) {
  const buffer = createInputBuffer(props.draft, props.draftCursor ?? props.draft.length)
  const visible = visibleInputLines(buffer)
  const lineCount = Math.max(1, visible.lines.length)
  return (
    <Box flexDirection="column" flexShrink={0} width={props.width} overflow="hidden">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexShrink={0}
        height={lineCount + 2}
        overflow="hidden"
      >
        {visible.lines.map((line, index) => {
          const prefix = index === 0 ? "> " : "  "
          if (!props.draft && index === 0) {
            return (
              <Text key="empty" wrap="truncate">
                {prefix}<Text inverse> </Text><Text dimColor>输入消息…</Text>
              </Text>
            )
          }
          if (index !== visible.cursorLine) {
            return <Text key={index} wrap="truncate">{prefix}{line || " "}</Text>
          }
          const units = Array.from(graphemeSegmenter.segment(line), segment => segment.segment)
          const column = Math.min(visible.cursorColumn, units.length)
          const before = units.slice(0, column).join("")
          const current = units[column] ?? " "
          const after = units.slice(column + (units[column] ? 1 : 0)).join("")
          return (
            <Text key={index} wrap="truncate">
              {prefix}{before}<Text inverse>{current}</Text>{after}
            </Text>
          )
        })}
      </Box>
      <Text dimColor wrap="truncate">Harness Code · Enter 发送 · Shift/Alt+Enter 换行 · Ctrl+C 清空/取消/退出</Text>
    </Box>
  )
}

export function MinimalConversationView(props: {
  committed: TimelineItem[]
  live: TimelineItem[]
  draft: string
  draftCursor?: number
  notice?: string
  terminalWidth?: number
  hideInput?: boolean
  footer?: React.ReactNode
  status?: React.ReactNode
}) {
  return (
    <>
      <Static items={props.committed}>
        {item => (
          <Box key={timelineItemId(item)}>
            <TimelineLine item={item} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column" width={props.terminalWidth} flexShrink={0}>
        {props.live.map(item => <TimelineLine key={timelineItemId(item)} item={item} live />)}
        {props.notice ? <Text color="yellow">{props.notice}</Text> : null}
        {props.footer}
        {props.hideInput ? null : <InputBar draft={props.draft} draftCursor={props.draftCursor} width={props.terminalWidth} />}
        {props.status}
      </Box>
    </>
  )
}

/** 把有状态 projector 的提交结果转换为每次都换引用的 Static items。 */
export function ProjectedConversationView(props: {
  timeline: readonly TimelineItem[]
  draft: string
  draftCursor?: number
  notice?: string
  terminalWidth?: number
  hideInput?: boolean
  footer?: React.ReactNode
  status?: React.ReactNode
  frozen?: boolean
}) {
  const projector = useRef(new TimelineProjector())
  const [committed, setCommitted] = useState<TimelineItem[]>([])
  const [live, setLive] = useState<TimelineItem[]>([])

  useEffect(() => {
    if (props.frozen) return
    const projection = projector.current.update(props.timeline)
    if (projection.committed.length > 0) {
      setCommitted(current => [...current, ...projection.committed])
    }
    setLive(projection.live)
  }, [props.timeline, props.frozen])

  return (
    <MinimalConversationView
      committed={committed}
      live={live}
      draft={props.draft}
      draftCursor={props.draftCursor}
      notice={props.notice}
      terminalWidth={props.terminalWidth}
      hideInput={props.hideInput}
      footer={props.footer}
      status={props.status}
    />
  )
}

function TimelineLine(props: { item: TimelineItem; live?: boolean }) {
  if (props.item.type === "message" && props.item.message.role === "assistant") {
    return (
      <Box flexDirection="column">
        <Text dimColor={props.live}>Harness:</Text>
        <MarkdownText source={props.item.message.content} />
      </Box>
    )
  }
  if (props.item.type === "tool") {
    return (
      <Box flexDirection="column">
        <Text dimColor={props.live}>{`Tool ${props.item.tool.name}: ${props.item.tool.status}`}</Text>
        {props.item.tool.output ? <Text dimColor>{props.item.tool.output.split("\n").slice(0, 12).join("\n")}</Text> : null}
      </Box>
    )
  }
  if (props.item.type === "reasoning") {
    return <Text dimColor={props.live}>{`Reasoning: ${props.item.reasoning.text}`}</Text>
  }
  const text = formatTimelineItem(props.item)
  return <Text dimColor={props.live}>{text}</Text>
}

export function formatTimelineItem(item: TimelineItem): string {
  switch (item.type) {
    case "message": {
      const label = item.message.role === "user" ? "You" : item.message.role === "assistant" ? "Harness" : "System"
      return `${label}: ${item.message.content}`
    }
    case "tool": return `Tool ${item.tool.name}: ${item.tool.status}${item.tool.output ? `\n${item.tool.output}` : ""}`
    case "reasoning": return `Reasoning: ${item.reasoning.text}`
    case "interaction": return `Interaction: ${item.interaction.type} (${item.interaction.status})`
    case "compose-summary": return item.summary.text
    case "goal-evaluation": return `Goal evaluation: ${item.evaluation.result ?? item.evaluation.phase}`
  }
}

export function InkConversationRoot(props: { adapter: TuiAdapter; webHandoff?: PresentationCoordinator }) {
  const subscribe = useCallback((listener: (snapshot: TuiAdapterSnapshot) => void) => props.adapter.subscribe(listener), [props.adapter])
  const getSnapshot = useCallback(() => props.adapter.getSnapshot(), [props.adapter])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const subscribeWeb = useCallback((listener: () => void) => props.webHandoff?.subscribe(listener) ?? (() => {}), [props.webHandoff])
  const getWebSnapshot = useCallback(() => props.webHandoff?.getSnapshot(), [props.webHandoff])
  const webSnapshot = useSyncExternalStore(subscribeWeb, getWebSnapshot, getWebSnapshot)
  const isWebActive = webSnapshot?.phase === "web-active"

  const [buffer, setBuffer] = useState(() => createInputBuffer(snapshot.draft))
  const { stdout } = useStdout()
  const [terminalWidth, setTerminalWidth] = useState(stdout.columns ?? 80)

  useEffect(() => {
    if (snapshot.draft !== buffer.value) setBuffer(createInputBuffer(snapshot.draft, snapshot.draftCursor === "start" ? 0 : snapshot.draft.length))
  }, [buffer.value, snapshot.draft, snapshot.draftCursor])

  useEffect(() => {
    const resize = () => setTerminalWidth(stdout.columns ?? 80)
    stdout.on("resize", resize)
    return () => {
      stdout.off("resize", resize)
    }
  }, [stdout])

  const interactionKind = bottomAreaKind(snapshot.interactive.interaction)

  useInput((input, key) => {
    if (key.eventType === "release") return
    if (isWebActive) {
      if ((key.ctrl && input.toLowerCase() === "c") || key.escape) {
        props.webHandoff?.requestReturn()
      }
      return
    }
    const resolution = resolveInkInput(input, key, {
      hasDraft: buffer.value.length > 0,
      activeRun: Boolean(snapshot.interactive.activeRun),
      multiline: buffer.value.includes("\n"),
      commandMenuVisible: snapshot.commandMenu.visible,
      commandOptionCount: snapshot.commandOptions.length,
      mentionMenuVisible: snapshot.mentionMenu.visible,
      mentionOptionCount: snapshot.mentionSearch.items.length,
      interactionActive: interactionKind !== "input",
      temporaryViewKind: snapshot.temporaryView.kind === "none" ? undefined : snapshot.temporaryView.kind as TemporaryViewKind,
      commandDialogVisible: Boolean(snapshot.commandDialog || snapshot.modelBindingDialog),
      skillPickerVisible: snapshot.skills.visible,
      skillOptionCount: snapshot.skills.items.length,
      threadPickerVisible: snapshot.threads.visible,
      threadOptionCount: snapshot.threads.items.length,
      modelPickerVisible: snapshot.models.visible,
      modelOptionCount: snapshot.models.items.length,
      agentPickerVisible: snapshot.agents.visible,
      agentOptionCount: snapshot.agents.items.length,
      undoPickerVisible: snapshot.undo.visible,
      undoOptionCount: snapshot.undo.items.length,
      undoDialogVisible: Boolean(snapshot.undoDialog?.visible),
      inputMode: snapshot.inputMode,
      childTimelineActive: Boolean(snapshot.interactive.childTimelineExecutionId),
    })
    if (interactionKind !== "input" || snapshot.temporaryView.kind !== "none") {
      if (resolution.type === "shortcut") void props.adapter.dispatch({ type: "shortcut", action: resolution.action })
      return
    }
    const picker = activePickerKind(snapshot)
    if (picker && resolution.type === "buffer") {
      if (resolution.action.type === "insert") {
        const current = picker === "skills" ? snapshot.skills.query
          : picker === "threads" ? snapshot.threads.query
            : picker === "models" ? snapshot.models.query
              : picker === "agents" ? snapshot.agents.query
                : snapshot.undo.query
        void props.adapter.dispatch({ type: "picker-search", picker, query: `${current}${resolution.action.text}` })
        return
      }
      if (resolution.action.type === "backspace") {
        const current = picker === "skills" ? snapshot.skills.query
          : picker === "threads" ? snapshot.threads.query
            : picker === "models" ? snapshot.models.query
              : picker === "agents" ? snapshot.agents.query
                : snapshot.undo.query
        void props.adapter.dispatch({ type: "picker-search", picker, query: current.slice(0, -1) })
        return
      }
    }
    if (resolution.type === "ignore") return
    if (resolution.type === "submit") {
      void props.adapter.dispatch({ type: "submit", value: buffer.value })
      return
    }
    if (resolution.type === "history") {
      void props.adapter.dispatch(resolution)
      return
    }
    if (resolution.type === "shortcut") {
      void props.adapter.dispatch({ type: "shortcut", action: resolution.action })
      return
    }
    const next = inputBufferReducer(buffer, resolution.action)
    setBuffer(next)
    void props.adapter.dispatch({ type: "draft-input", value: next.value, cursorOffset: next.cursor })
  })

  return (
    <ProjectedConversationView
      timeline={snapshot.interactive.timeline}
      draft={buffer.value}
      draftCursor={buffer.cursor}
      notice={snapshot.transientNotice?.message}
      terminalWidth={terminalWidth}
      hideInput={isWebActive || interactionKind !== "input" || snapshot.temporaryView.kind !== "none"}
      frozen={isWebActive}
      footer={(
        <>
          {isWebActive ? (
            <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
              <Text color="cyan" bold>已移交 Web 工作台</Text>
              <Text dimColor>当前会话已由浏览器接管。完成操作后点击页面中的“返回 TUI”，或直接关闭浏览器窗口。</Text>
              <Text dimColor>在终端按 Ctrl+C 或 Esc 可请求返回 TUI。</Text>
            </Box>
          ) : (
            <>
              {snapshot.toasts.map(toast => (
                <Text key={toast.id} color={toast.variant === "error" ? "red" : toast.variant === "warning" ? "yellow" : "cyan"}>
                  {toast.message}
                </Text>
              ))}
              {snapshot.temporaryView.kind !== "none"
                ? <TemporaryView snapshot={snapshot} adapter={props.adapter} />
                : interactionKind !== "input"
                  ? <InteractionBottomArea snapshot={snapshot.interactive} adapter={props.adapter} />
                  : <InlineMenus snapshot={snapshot} />}
            </>
          )}
        </>
      )}
      status={(
        <Text dimColor wrap="truncate">
          {`${snapshot.interactive.workMode} · ${snapshot.interactive.runtime.modelName ?? snapshot.interactive.runtime.approvalMode} · ${snapshot.interactive.runtime.workspace}`}
        </Text>
      )}
    />
  )
}

/** 创建唯一 Ink root 与唯一幂等 shutdown 路径。 */
export async function runTui(options: TuiOptions): Promise<void> {
  const gitWorkspace = options.controller.getSnapshot().runtime.gitWorkspace
  const gitRoot = gitWorkspace?.kind === "branch" || gitWorkspace?.kind === "detached" ? gitWorkspace.root : undefined
  let instance: ReturnType<typeof render> | undefined
  let closed = false
  let unregisterExit: (() => void) | undefined
  const adapter = createTuiAdapter({
    controller: options.controller,
    gateway: options.gateway,
    workspaceExplorer: options.workspaceExplorer,
    promptHistoryFile: options.promptHistoryFile,
    resume: options.resume,
    onRequestExit: () => close(),
    openWeb: options.openWeb,
    workspaceChangeProbe: gitRoot ? () => detectGitChangedFiles(gitRoot) : undefined,
    dispatchGate: options.webHandoff ? intent => options.webHandoff!.tuiDispatch(intent) : undefined,
  })
  const close = () => {
    if (closed) return
    closed = true
    unregisterExit?.()
    instance?.unmount()
  }
  try {
    unregisterExit = options.webHandoff?.registerExitHandler(close)
    instance = render(<InkConversationRoot adapter={adapter} webHandoff={options.webHandoff} />, {
      exitOnCtrlC: false,
      incrementalRendering: false,
      maxFps: 30,
      kittyKeyboard: { mode: "auto" },
    })
    await instance.waitUntilExit()
  } finally {
    close()
    await adapter.close()
  }
}
