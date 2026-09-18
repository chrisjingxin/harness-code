/** Ink 全宽临时视图：status/BTW/inspect/workspace/Tool Inspector，有界分页。 */
/** @jsxImportSource react */
import { Box, Text, useInput, type Key } from "ink"
import React, { useMemo, useState } from "react"

import type { TuiAdapter, TuiAdapterSnapshot } from "../application/adapter"

const PAGE_SIZE = 16

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
    <Box flexDirection="column" borderStyle="round" borderColor={props.color ?? "cyan"} paddingX={1}>
      <Text color={props.color ?? "cyan"}>{props.title}{pageCount > 1 ? `  ${current + 1}/${pageCount}` : ""}</Text>
      {visible.map((line, index) => <Text key={`${current}-${index}-${line.slice(0, 24)}`}>{line || " "}</Text>)}
      <Text dimColor>PgUp/PgDn 翻页 · Esc 关闭</Text>
    </Box>
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
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green">工作区</Text>
      {tree.status === "loading" ? <Text dimColor>加载中…</Text> : null}
      {tree.message ? <Text color="yellow">{tree.message}</Text> : null}
      {rows.map((row, offset) => {
        const index = windowStart + offset
        const prefix = `${"  ".repeat(row.depth)}${row.kind === "directory" ? (row.expanded ? "▼ " : "▶ ") : "  "}`
        return (
          <Text key={row.path} inverse={index === selected}>
            {index === selected ? "❯ " : "  "}{prefix}{row.name}{row.kind === "directory" ? "/" : ""}
          </Text>
        )
      })}
      {preview && preview.status === "ready" ? <Text dimColor>{preview.file.path}</Text> : null}
      {preview && preview.status === "error" ? <Text color="red">{preview.message}</Text> : null}
      <Text dimColor>↑↓ 选择 · ←→ 展开 · Enter 预览 · @ 插入 · Esc 关闭</Text>
    </Box>
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
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">Tool Inspector</Text>
      {tools.length === 0 ? <Text dimColor>暂无工具记录</Text> : tools.slice(Math.max(0, selectedIndex - 6), selectedIndex + 6).map((tool, offset) => {
        const index = Math.max(0, selectedIndex - 6) + offset
        return <Text key={tool.id} inverse={index === selectedIndex}>{index === selectedIndex ? "❯ " : "  "}{tool.name} · {tool.status}</Text>
      })}
      {selected?.output ? <Text dimColor>{selected.output.split("\n").slice(0, 8).join("\n")}</Text> : null}
      <Text dimColor>↑↓ 选择 · Esc 关闭</Text>
    </Box>
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
        color="magenta"
        lines={[btw.question, btw.answer ?? btw.error ?? "", btw.copied ? "已复制" : "按 c 复制"].filter(Boolean)}
      />
    )
  }
  if (kind === "inspect") {
    return <PagedText title={props.snapshot.inspectOverlay.title || "查看"} lines={props.snapshot.inspectOverlay.body.split("\n")} />
  }
  return null
}
