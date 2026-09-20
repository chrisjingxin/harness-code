/** Ink 全宽临时视图：status/BTW/inspect/workspace/Tool Inspector，有界分页。 */
/** @jsxImportSource react */
import { Box, Text, useInput, type Key } from "ink"
import React, { useMemo, useState } from "react"

import type { TuiAdapter, TuiAdapterSnapshot } from "../application/adapter"
import { tuiTheme } from "../presentation/theme"

const PAGE_SIZE = 16

/** 通用覆盖视图容器外壳：统一强边界、标题、分页信息、内容与 Footer。 */
export function OverlayShell(props: {
  title: string
  titleColor?: string
  borderColor?: string
  pageInfo?: string
  footer?: string
  children: React.ReactNode
}) {
  const color = props.borderColor ?? props.titleColor ?? tuiTheme.brand
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={props.titleColor ?? color} bold wrap="truncate">{props.title}</Text>
        {props.pageInfo ? <Text dimColor>{props.pageInfo}</Text> : null}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {props.children}
      </Box>
      <Text dimColor wrap="truncate">{props.footer ?? "Esc 关闭"}</Text>
    </Box>
  )
}

function PagedText(props: { title: string; lines: readonly string[]; color?: string }) {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(props.lines.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const visible = props.lines.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  useInput((_, key: Key) => {
    if (key.pageDown) setPage(value => Math.min(pageCount - 1, value + 1))
    if (key.pageUp) setPage(value => Math.max(0, value - 1))
    if (key.home) setPage(0)
    if (key.end) setPage(pageCount - 1)
  })
  return (
    <OverlayShell
      title={props.title}
      titleColor={props.color ?? tuiTheme.brand}
      borderColor={props.color ?? tuiTheme.brand}
      pageInfo={pageCount > 1 ? `${current + 1}/${pageCount}` : undefined}
      footer="PgUp/PgDn 翻页 · Esc 关闭"
    >
      {visible.map((line, index) => <Text key={`${current}-${index}-${line.slice(0, 24)}`} wrap="truncate">{line || " "}</Text>)}
    </OverlayShell>
  )
}

function statusLines(snapshot: TuiAdapterSnapshot): string[] {
  const runtime = snapshot.interactive.runtime
  const git = runtime.gitWorkspace
  const gitLine = git?.kind === "branch" ? `git ${git.branch}` : git?.kind === "detached" ? `git ${git.shortSha}` : git?.kind === "not-repository" ? "非 Git 工作区" : "Git 不可用"
  const model = runtime.modelName ?? runtime.modelProfileId ?? "未配置模型"
  const changed = snapshot.workspace.changedFiles?.map(file => `${file.status} ${file.path}`) ?? []
  return [
    `工作区 ${runtime.workspace}`,
    `CLI ${runtime.cliVersion} · ${snapshot.interactive.connection.status}`,
    `模型 ${model}`,
    `审批 ${runtime.approvalMode} · 模式 ${snapshot.interactive.workMode}`,
    gitLine,
    ...changed,
  ]
}

function WorkspaceView(props: { snapshot: TuiAdapterSnapshot; adapter: TuiAdapter }) {
  const tree = props.snapshot.workspace.fileTree
  const selected = tree.selectedIndex
  const windowStart = Math.max(0, selected - 10)
  const rows = tree.rows.slice(windowStart, windowStart + 12)
  const preview = props.snapshot.workspace.preview
  useInput((input, key) => {
    if (key.upArrow) void props.adapter.dispatch({ type: "workspace-navigate", direction: "up" })
    else if (key.downArrow) void props.adapter.dispatch({ type: "workspace-navigate", direction: "down" })
    else if (key.leftArrow) void props.adapter.dispatch({ type: "workspace-navigate", direction: "parent" })
    else if (key.rightArrow) void props.adapter.dispatch({ type: "workspace-navigate", direction: "child" })
    else if (key.return) {
      const row = tree.rows[tree.selectedIndex]
      if (row && row.kind !== "directory") void props.adapter.dispatch({ type: "file-tree-preview", path: row.path })
    } else if (input === "@") {
      const row = tree.rows[tree.selectedIndex]
      if (row) void props.adapter.dispatch({ type: "file-preview-insert-ref", path: row.path })
    }
  })
  return (
    <OverlayShell
      title="工作区"
      titleColor={tuiTheme.success}
      borderColor={tuiTheme.success}
      footer="↑↓ 选择 · ←→ 展开 · Enter 预览 · @ 插入 · Esc 关闭"
    >
      {tree.status === "loading" ? <Text dimColor>加载中…</Text> : null}
      {tree.message ? <Text color={tuiTheme.warning}>{tree.message}</Text> : null}
      {rows.map((row, offset) => {
        const index = windowStart + offset
        const isSelected = index === selected
        const prefix = `${"  ".repeat(row.depth)}${row.kind === "directory" ? (row.expanded ? "▼ " : "▶ ") : "  "}`
        return (
          <Text
            key={row.path}
            color={isSelected ? tuiTheme.selection : undefined}
            bold={isSelected}
            wrap="truncate"
          >
            {isSelected ? "❯ " : "  "}{prefix}{row.name}{row.kind === "directory" ? "/" : ""}
          </Text>
        )
      })}
      {preview && preview.status === "ready" ? <Text dimColor wrap="truncate">{preview.file.path}</Text> : null}
      {preview && preview.status === "error" ? <Text color={tuiTheme.danger} wrap="truncate">{preview.message}</Text> : null}
    </OverlayShell>
  )
}

function ToolInspectorView(props: { snapshot: TuiAdapterSnapshot }) {
  const tools = useMemo(() => props.snapshot.interactive.timeline.flatMap(item => item.type === "tool" ? [item.tool] : []), [props.snapshot.interactive.timeline])
  const initial = Math.max(0, tools.findIndex(tool => tool.id === props.snapshot.toolInspector.selectedToolId))
  const [selectedIndex, setSelectedIndex] = useState(initial === -1 ? Math.max(0, tools.length - 1) : initial)
  const selected = tools[selectedIndex]
  useInput((_, key) => {
    if (!tools.length) return
    if (key.upArrow) setSelectedIndex(index => Math.max(0, index - 1))
    else if (key.downArrow) setSelectedIndex(index => Math.min(tools.length - 1, index + 1))
  })
  return (
    <OverlayShell
      title="Tool Inspector"
      titleColor={tuiTheme.warning}
      borderColor={tuiTheme.warning}
      footer="↑↓ 选择 · Esc 关闭"
    >
      {tools.length === 0 ? <Text dimColor>暂无工具记录</Text> : tools.slice(Math.max(0, selectedIndex - 6), selectedIndex + 6).map((tool, offset) => {
        const index = Math.max(0, selectedIndex - 6) + offset
        const isSelected = index === selectedIndex
        return (
          <Text
            key={tool.id}
            color={isSelected ? tuiTheme.selection : undefined}
            bold={isSelected}
            wrap="truncate"
          >
            {isSelected ? "❯ " : "  "}{tool.name} · {tool.status}
          </Text>
        )
      })}
      {selected?.output ? <Text dimColor wrap="truncate">{selected.output.split("\n").slice(0, 8).join("\n")}</Text> : null}
    </OverlayShell>
  )
}

/** 按 Adapter temporaryView 渲染唯一全宽临时视图。 */
export function TemporaryView(props: { snapshot: TuiAdapterSnapshot; adapter: TuiAdapter }) {
  const kind = props.snapshot.temporaryView.kind
  if (kind === "none") return null
  if (kind === "workspace") return <WorkspaceView snapshot={props.snapshot} adapter={props.adapter} />
  if (kind === "tool-inspector") return <ToolInspectorView snapshot={props.snapshot} />
  if (kind === "status") return <PagedText title="状态" lines={statusLines(props.snapshot)} />
  if (kind === "btw") {
    const btw = props.snapshot.btw
    return (
      <PagedText
        title={btw.status === "loading" ? "BTW 询问中" : "BTW"}
        color={tuiTheme.modeCompose}
        lines={[btw.question, btw.answer ?? btw.error ?? "", btw.copied ? "已复制" : "按 c 复制"].filter(Boolean)}
      />
    )
  }
  if (kind === "inspect") {
    return <PagedText title={props.snapshot.inspectOverlay.title || "查看"} lines={props.snapshot.inspectOverlay.body.split("\n")} />
  }
  return null
}
