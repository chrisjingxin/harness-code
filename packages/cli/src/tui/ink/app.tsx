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
import type { ShortcutAction } from "../application/shortcuts"
import { createInputBuffer, inputBufferReducer, visibleInputLines, type InputBufferAction } from "./input-buffer"
import { TimelineProjector, timelineItemId } from "./timeline-projector"

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

/** 将 Ink 键事件收敛为 InputBuffer 或现有 Adapter intent。 */
export function resolveInkInput(
  input: string,
  key: Key,
  context: { hasDraft: boolean; activeRun: boolean; multiline?: boolean },
): InkInputResolution {
  if (key.ctrl && input.toLowerCase() === "c") {
    return { type: "shortcut", action: context.hasDraft ? "clear-draft" : context.activeRun ? "cancel-run" : "exit" }
  }
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
  if (key.backspace) return { type: "buffer", action: { type: "backspace" } }
  if (key.delete) return { type: "buffer", action: { type: "delete" } }
  if (input && !key.ctrl && !key.super) return { type: "buffer", action: { type: "insert", text: input } }
  return { type: "ignore" }
}

export function MinimalConversationView(props: {
  committed: TimelineItem[]
  live: TimelineItem[]
  draft: string
  draftCursor?: number
  notice?: string
  terminalWidth?: number
}) {
  const draftBuffer = createInputBuffer(props.draft, props.draftCursor ?? props.draft.length)
  const visible = visibleInputLines(draftBuffer)
  const visibleDraft = visible.lines.join("\n")
  const visibleStart = draftBuffer.value.split("\n").slice(0, visible.firstLine)
    .reduce((length, line) => length + line.length + 1, 0)
  const cursorOffset = draftBuffer.cursor - visibleStart
  const cursorGrapheme = Array.from(
    graphemeSegmenter.segment(visibleDraft.slice(cursorOffset)),
    segment => segment.segment,
  )[0] ?? " "
  const beforeCursor = visibleDraft.slice(0, cursorOffset)
  const afterCursor = visibleDraft.slice(cursorOffset + (cursorGrapheme === " " && cursorOffset === visibleDraft.length ? 0 : cursorGrapheme.length))
  return (
    <Box flexDirection="column" width={props.terminalWidth}>
      <Text bold color="cyan">Harness Code <Text dimColor>Node / Ink</Text></Text>
      <Static items={props.committed}>
        {item => <TimelineLine key={timelineItemId(item)} item={item} />}
      </Static>
      {props.live.map(item => <TimelineLine key={timelineItemId(item)} item={item} live />)}
      {props.notice ? <Text color="yellow">{props.notice}</Text> : null}
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="green">{"> "}</Text>
        {visibleDraft
          ? <Text>{beforeCursor}<Text color="cyan">▏</Text><Text inverse>{cursorGrapheme}</Text>{afterCursor}</Text>
          : <Text><Text color="cyan">▏</Text><Text inverse> </Text><Text dimColor>输入消息…</Text></Text>}
      </Box>
      <Text dimColor>Enter 发送 · Shift/Alt+Enter 换行 · Ctrl+C 清空/取消/退出</Text>
    </Box>
  )
}

/** 把有状态 projector 的提交结果转换为每次都换引用的 Static items。 */
export function ProjectedConversationView(props: {
  timeline: readonly TimelineItem[]
  draft: string
  draftCursor?: number
  notice?: string
  terminalWidth?: number
}) {
  const projector = useRef(new TimelineProjector())
  const [committed, setCommitted] = useState<TimelineItem[]>([])
  const [live, setLive] = useState<TimelineItem[]>([])

  useEffect(() => {
    const projection = projector.current.update(props.timeline)
    if (projection.committed.length > 0) {
      setCommitted(current => [...current, ...projection.committed])
    }
    setLive(projection.live)
  }, [props.timeline])

  return (
    <MinimalConversationView
      committed={committed}
      live={live}
      draft={props.draft}
      draftCursor={props.draftCursor}
      notice={props.notice}
      terminalWidth={props.terminalWidth}
    />
  )
}

function TimelineLine(props: { item: TimelineItem; live?: boolean }) {
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

function InkConversationRoot(props: { adapter: TuiAdapter }) {
  const subscribe = useCallback((listener: (snapshot: TuiAdapterSnapshot) => void) => props.adapter.subscribe(listener), [props.adapter])
  const getSnapshot = useCallback(() => props.adapter.getSnapshot(), [props.adapter])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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

  useInput((input, key) => {
    const resolution = resolveInkInput(input, key, {
      hasDraft: buffer.value.length > 0,
      activeRun: Boolean(snapshot.interactive.activeRun),
      multiline: buffer.value.includes("\n"),
    })
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
    instance = render(<InkConversationRoot adapter={adapter} />, {
      exitOnCtrlC: false,
      incrementalRendering: true,
      maxFps: 30,
      kittyKeyboard: { mode: "auto" },
    })
    await instance.waitUntilExit()
  } finally {
    close()
    await adapter.close()
  }
}
