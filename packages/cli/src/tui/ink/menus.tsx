/** Ink 内联命令、提及与选择器：只消费 Adapter snapshot，不含鼠标或绝对定位。 */
/** @jsxImportSource react */
import { Box, Text } from "ink"
import React from "react"

import type { TuiAdapterSnapshot } from "../application/adapter"

function MenuList(props: {
  title: string
  items: readonly string[]
  selectedIndex: number
  empty?: string
  footer?: string
}) {
  if (!props.items.length) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>{props.title}</Text>
        <Text dimColor>{props.empty ?? "无候选"}</Text>
      </Box>
    )
  }
  const windowStart = Math.max(0, props.selectedIndex - 7)
  const visible = props.items.slice(windowStart, windowStart + 8)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan">{props.title}</Text>
      {visible.map((item, offset) => {
        const index = windowStart + offset
        return (
          <Text key={`${index}-${item}`} inverse={index === props.selectedIndex}>
            {index === props.selectedIndex ? "❯ " : "  "}{item}
          </Text>
        )
      })}
      {props.footer ? <Text dimColor>{props.footer}</Text> : null}
    </Box>
  )
}

/** 渲染当前打开的内联菜单或选择器；同时最多一个。 */
export function InlineMenus(props: { snapshot: TuiAdapterSnapshot }) {
  const snapshot = props.snapshot
  if (snapshot.commandDialog) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow">{snapshot.commandDialog.title}</Text>
        <Text>{snapshot.commandDialog.message}</Text>
        <Text dimColor>{`${snapshot.commandDialog.confirmLabel ?? "确认"} · ${snapshot.commandDialog.cancelLabel ?? "取消"}`}</Text>
      </Box>
    )
  }
  if (snapshot.modelBindingDialog) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow">{snapshot.modelBindingDialog.title}</Text>
        <Text>{snapshot.modelBindingDialog.message}</Text>
      </Box>
    )
  }
  if (snapshot.undoDialog?.visible) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow">确认撤销</Text>
        <Text>{snapshot.undoDialog.targetTurn.user_prompt}</Text>
        <Text inverse={snapshot.undoDialog.selectedMode === "both"}>  会话和代码</Text>
        <Text inverse={snapshot.undoDialog.selectedMode === "conversation"}>  仅会话</Text>
        <Text inverse={snapshot.undoDialog.selectedMode === "code"}>  仅代码</Text>
      </Box>
    )
  }
  if (snapshot.skills.visible) {
    return (
      <MenuList
        title={snapshot.skills.query ? `Skill · ${snapshot.skills.query}` : "Skill"}
        items={snapshot.skills.items.map(item => item.name)}
        selectedIndex={snapshot.skills.selectedIndex}
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
