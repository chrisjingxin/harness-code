/** Ink 内联命令、提及与选择器：只消费 Adapter snapshot，不含鼠标或绝对定位。 */
/** @jsxImportSource react */
import { Box, Text } from "ink"
import React from "react"

import type { TuiAdapterSnapshot } from "../application/adapter"
import { tuiTheme } from "../presentation/theme"

function MenuList(props: {
  title: string
  items: readonly string[]
  selectedIndex: number
  maxItems: number
  empty?: string
  footer?: string
}) {
  if (!props.items.length) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={tuiTheme.border} paddingX={1}>
        <Text dimColor wrap="truncate">{props.title}</Text>
        <Text dimColor wrap="truncate">{props.empty ?? "无候选"}</Text>
      </Box>
    )
  }
  const visibleCount = Math.max(1, Math.min(8, Math.floor(props.maxItems)))
  const windowStart = Math.max(0, props.selectedIndex - visibleCount + 1)
  const visible = props.items.slice(windowStart, windowStart + visibleCount)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tuiTheme.borderActive} paddingX={1}>
      <Text color={tuiTheme.brand} wrap="truncate">{props.title}</Text>
      {visible.map((item, offset) => {
        const index = windowStart + offset
        return (
          <Text
            key={`${index}-${item}`}
            color={index === props.selectedIndex ? tuiTheme.selection : undefined}
            bold={index === props.selectedIndex}
            wrap="truncate"
          >
            {index === props.selectedIndex ? "❯ " : "  "}{item}
          </Text>
        )
      })}
      {props.footer ? <Text dimColor wrap="truncate">{props.footer}</Text> : null}
    </Box>
  )
}

/** 渲染当前打开的内联菜单或选择器；同时最多一个。 */
export function InlineMenus(props: { snapshot: TuiAdapterSnapshot; maxItems?: number; maxRows?: number }) {
  const snapshot = props.snapshot
  const maxItems = props.maxItems ?? 8
  const maxRows = props.maxRows ?? 24
  if (snapshot.commandDialog) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={tuiTheme.warning} paddingX={1}>
        <Text color={tuiTheme.warning} wrap="truncate">{snapshot.commandDialog.title}</Text>
        <Text wrap="truncate">{snapshot.commandDialog.message}</Text>
        <Text dimColor wrap="truncate">{`${snapshot.commandDialog.confirmLabel ?? "确认"} · ${snapshot.commandDialog.cancelLabel ?? "取消"}`}</Text>
      </Box>
    )
  }
  if (snapshot.modelBindingDialog) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={tuiTheme.warning} paddingX={1}>
        <Text color={tuiTheme.warning} wrap="truncate">{snapshot.modelBindingDialog.title}</Text>
        <Text wrap="truncate">{snapshot.modelBindingDialog.message}</Text>
      </Box>
    )
  }
  if (snapshot.undoDialog?.visible) {
    const options = [
      { value: "both", label: "会话和代码" },
      { value: "conversation", label: "仅会话" },
      { value: "code", label: "仅代码" },
    ] as const
    const optionRows = Math.max(1, Math.min(options.length, maxRows - 3))
    const selectedIndex = Math.max(0, options.findIndex(option => option.value === snapshot.undoDialog?.selectedMode))
    const windowStart = Math.max(0, selectedIndex - optionRows + 1)
    const visibleOptions = options.slice(windowStart, windowStart + optionRows)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={tuiTheme.warning} paddingX={1}>
        <Text color={tuiTheme.warning} wrap="truncate">确认撤销</Text>
        {maxRows >= 6 ? <Text wrap="truncate">{snapshot.undoDialog.targetTurn.user_prompt}</Text> : null}
        {visibleOptions.map(option => {
          const selected = option.value === snapshot.undoDialog?.selectedMode
          return <Text key={option.value} color={selected ? tuiTheme.selection : undefined} bold={selected} wrap="truncate">{selected ? "❯ " : "  "}{option.label}</Text>
        })}
      </Box>
    )
  }
  if (snapshot.skills.visible) {
    return (
      <MenuList
        title={snapshot.skills.query ? `Skill · ${snapshot.skills.query}` : "Skill"}
        items={snapshot.skills.items.map(item => item.name)}
        selectedIndex={snapshot.skills.selectedIndex}
        maxItems={maxItems}
        empty={snapshot.skills.loading ? "加载中…" : snapshot.skills.error ?? "无匹配 Skill"}
        footer="↑↓ 选择 · Enter 确认 · Esc 关闭"
      />
    )
  }
  if (snapshot.threads.visible) {
    return (
      <MenuList
        title="恢复会话"
        items={snapshot.threads.items.map(item => item.title || item.firstMessage || item.threadId)}
        selectedIndex={snapshot.threads.selectedIndex}
        maxItems={maxItems}
        empty={snapshot.threads.loading ? "加载中…" : snapshot.threads.error ?? "无会话"}
        footer="↑↓ 选择 · Enter 打开 · Esc 关闭"
      />
    )
  }
  if (snapshot.models.visible) {
    return (
      <MenuList
        title={snapshot.models.query ? `模型 · ${snapshot.models.query}` : "模型"}
        items={snapshot.models.items.map(item => item.model)}
        selectedIndex={snapshot.models.selectedIndex}
        maxItems={maxItems}
        empty={snapshot.models.loading ? "加载中…" : snapshot.models.error ?? "无匹配模型"}
        footer="↑↓ 选择 · Enter 确认 · Esc 关闭"
      />
    )
  }
  if (snapshot.agents.visible) {
    return (
      <MenuList
        title="Agent"
        items={snapshot.agents.items.map(item => item.id)}
        selectedIndex={snapshot.agents.selectedIndex}
        maxItems={maxItems}
        empty={snapshot.agents.loading ? "加载中…" : snapshot.agents.error ?? "无 Agent"}
        footer="↑↓ 浏览 · Enter/Esc 关闭"
      />
    )
  }
  if (snapshot.undo.visible) {
    return (
      <MenuList
        title="撤销到回合"
        items={snapshot.undo.items.map(item => `${item.turn_index}. ${item.user_prompt}`)}
        selectedIndex={snapshot.undo.selectedIndex}
        maxItems={maxItems}
        empty={snapshot.undo.loading ? "加载中…" : snapshot.undo.error ?? "无可撤销回合"}
        footer="↑↓ 选择 · Enter 确认 · Esc 关闭"
      />
    )
  }
  if (snapshot.commandMenu.visible) {
    const options = snapshot.commandOptions
    return (
      <MenuList
        title="命令"
        items={options.map(item => item.kind === "skill" ? `/${item.skill.name}  ${item.skill.description}` : `/${item.command.name}  ${item.command.description}`)}
        selectedIndex={snapshot.commandMenu.selectedIndex}
        maxItems={maxItems}
        empty="无匹配命令"
        footer="↑↓ 选择 · Tab 补全 · Enter 执行 · Esc 关闭"
      />
    )
  }
  if (snapshot.mentionMenu.visible) {
    const options = snapshot.mentionSearch.items
    const status = snapshot.mentionMenu.workspaceStatus === "loading"
      ? "扫描工作区…"
      : snapshot.mentionMenu.workspaceMessage
    return (
      <MenuList
        title={snapshot.mentionMenu.browsePath ? `@ ${snapshot.mentionMenu.browsePath}` : "@ 文件"}
        items={options.map(item => item.kind === "directory" ? `${item.name}/` : item.name)}
        selectedIndex={snapshot.mentionMenu.selectedIndex}
        maxItems={maxItems}
        empty={status ?? "无匹配文件"}
        footer="↑↓ 选择 · Enter 插入 · Esc 关闭"
      />
    )
  }
  return null
}

export function activePickerKind(snapshot: TuiAdapterSnapshot): "skills" | "threads" | "models" | "agents" | "undo" | null {
  if (snapshot.skills.visible) return "skills"
  if (snapshot.threads.visible) return "threads"
  if (snapshot.models.visible) return "models"
  if (snapshot.agents.visible) return "agents"
  if (snapshot.undo.visible) return "undo"
  return null
}
