/** Ink 底部 Interaction 面板：与 InputBar 互斥，决策集合来自共享 policy。 */
/** @jsxImportSource react */
import { Box, Text, useInput, type Key } from "ink"
import React, { useMemo, useState } from "react"

import type { FileDiffPresentation } from "@za38/protocol"
import type { GoalReviewResponse, InteractiveSnapshot, PlanDecision } from "../../interactive/types"
import {
  APPROVAL_DECISION_ORDER,
  DIRECTORY_TRUST_DECISION_ORDER,
  PLAN_DECISION_ORDER,
  QUESTION_OTHER_VALUE,
  answersByQuestionId,
  approvalDecisionDescription,
  approvalDecisionLabel,
  bottomAreaKind,
  directoryTrustDecisionDescription,
  directoryTrustDecisionLabel,
  formatPlanReviewFeedback,
  isApprovalDecision,
  isDirectoryTrustDecision,
  isPlanDecision,
  planDecisionDescription,
  planDecisionLabel,
  recordAskUserAnswer,
} from "../../presentation-shared/interaction-policy"
import { diffTextForRenderer } from "../../presentation-shared/file-diff"
import type { ApprovalDecision, DirectoryTrustDecision, TuiAdapter } from "../application/adapter"
import { isInkBackspace } from "./input-key"

type Option = { value: string; label: string; description?: string }

function OptionList(props: { options: readonly Option[]; selectedIndex: number }) {
  return (
    <Box flexDirection="column">
      {props.options.map((option, index) => (
        <Text key={option.value} inverse={index === props.selectedIndex}>
          {index === props.selectedIndex ? "❯ " : "  "}
          {option.label}
          {option.description ? ` · ${option.description}` : ""}
        </Text>
      ))}
    </Box>
  )
}

function moveIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (index + delta + length) % length
}

function isNavKey(key: Key, input: string): "up" | "down" | "confirm" | "escape" | "other" | "none" {
  if (key.upArrow || (key.ctrl && input.toLowerCase() === "p")) return "up"
  if (key.downArrow || (key.ctrl && input.toLowerCase() === "n")) return "down"
  if (key.return && !key.shift && !key.meta) return "confirm"
  if (key.escape) return "escape"
  if (input && !key.ctrl && !key.meta) return "other"
  return "none"
}

function ApprovalDiff(props: { presentation: FileDiffPresentation }) {
  const text = diffTextForRenderer(props.presentation.unified_diff)
  const lines = text.split("\n").slice(0, 14)
  return (
    <Box flexDirection="column">
      <Text dimColor>{`${props.presentation.operation} ${props.presentation.path}  +${props.presentation.added_lines}/-${props.presentation.removed_lines}`}</Text>
      {props.presentation.truncated ? <Text color="yellow">diff 已截断</Text> : null}
      {lines.map((line, index) => <Text key={`${index}-${line.slice(0, 24)}`}>{line || " "}</Text>)}
    </Box>
  )
}

function ApprovalPanel(props: {
  interaction: Extract<InteractiveSnapshot["interaction"], { type: "approval" }>
  onApproval: (decision: ApprovalDecision) => void
}) {
  const options = useMemo(() => {
    const allowed = props.interaction.decisions.filter(isApprovalDecision)
    return (allowed.length ? allowed : APPROVAL_DECISION_ORDER).map(decision => ({
      value: decision,
      label: approvalDecisionLabel(decision),
      description: approvalDecisionDescription(decision),
    }))
  }, [props.interaction.decisions])
  const [selectedIndex, setSelectedIndex] = useState(0)
  useInput((input, key) => {
    const nav = isNavKey(key, input)
    if (nav === "up") setSelectedIndex(index => moveIndex(index, -1, options.length))
    else if (nav === "down") setSelectedIndex(index => moveIndex(index, 1, options.length))
    else if (nav === "confirm") {
      const value = options[selectedIndex]?.value
      if (isApprovalDecision(value)) props.onApproval(value)
    }
  })
  const title = props.interaction.agentId && props.interaction.agentId !== "main"
    ? `子代理 ${props.interaction.agentId} 需要审批`
    : "需要审批"
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">{title}</Text>
      {props.interaction.description ? <Text>{props.interaction.description}</Text> : null}
      {props.interaction.presentation ? <ApprovalDiff presentation={props.interaction.presentation} /> : null}
      <OptionList options={options} selectedIndex={selectedIndex} />
      <Text dimColor>{props.interaction.presentation ? "↑↓ 选择 · Enter 确认" : "↑↓ 选择 · Enter 确认"}</Text>
    </Box>
  )
}

function DirectoryTrustPanel(props: {
  interaction: Extract<InteractiveSnapshot["interaction"], { type: "directory_trust" }>
  onDirectoryTrust: (decision: DirectoryTrustDecision) => void
}) {
  const options = useMemo(() => {
    const allowed = props.interaction.decisions.filter(isDirectoryTrustDecision)
    return (allowed.length ? allowed : DIRECTORY_TRUST_DECISION_ORDER).map(decision => ({
      value: decision,
      label: directoryTrustDecisionLabel(decision),
      description: directoryTrustDecisionDescription(decision),
    }))
  }, [props.interaction.decisions])
  const [selectedIndex, setSelectedIndex] = useState(0)
  useInput((input, key) => {
    const nav = isNavKey(key, input)
    if (nav === "up") setSelectedIndex(index => moveIndex(index, -1, options.length))
    else if (nav === "down") setSelectedIndex(index => moveIndex(index, 1, options.length))
    else if (nav === "confirm") {
      const value = options[selectedIndex]?.value
      if (isDirectoryTrustDecision(value)) props.onDirectoryTrust(value)
    }
  })
  const access = props.interaction.access === "write" ? "写入" : "读取"
  const title = props.interaction.agentId && props.interaction.agentId !== "main"
    ? `子代理 ${props.interaction.agentId} 需要目录信任`
    : "目录信任"
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">{title}</Text>
      <Text>{`工具：${props.interaction.toolName}（${access}）`}</Text>
      <Text>{`目标路径：${props.interaction.targetPath}`}</Text>
      <Text color="yellow">{`待信任目录：${props.interaction.directory}`}</Text>
      {props.interaction.shadowsWorkspace ? <Text color="yellow">注意：该目录会遮蔽主工作区内的同名路径。</Text> : null}
      <OptionList options={options} selectedIndex={selectedIndex} />
      <Text dimColor>↑↓ 选择 · Enter 确认</Text>
    </Box>
  )
}

function QuestionPanel(props: {
  interaction: Extract<InteractiveSnapshot["interaction"], { type: "question" }>
  onQuestion: (answers: Record<string, string[]>) => void
}) {
  const questions = props.interaction.questions
  const [index, setIndex] = useState(0)
  const [collected, setCollected] = useState<Record<string, string>>({})
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [custom, setCustom] = useState<string | null>(null)
  const [multiSelected, setMultiSelected] = useState<string[]>([])
  const question = questions[Math.min(index, Math.max(0, questions.length - 1))]
  const options = (question?.options ?? []).map(option => ({
    value: option.value,
    label: option.label,
    description: option.description || undefined,
  }))
  if (question?.allowOther) options.push({ value: QUESTION_OTHER_VALUE, label: "其他", description: "输入自定义回答" })

  const accept = (answer: string) => {
    if (!question) return
    const next = recordAskUserAnswer(questions, collected, question.id, answer)
    if (!next.done) {
      setCollected(next.collected)
      setIndex(current => current + 1)
      setSelectedIndex(0)
      setCustom(null)
      setMultiSelected([])
      return
    }
    props.onQuestion(answersByQuestionId(questions, next.collected))
  }

  useInput((input, key) => {
    if (custom !== null) {
      if (key.escape) { setCustom(null); return }
      if (key.return) { if (custom.trim()) accept(custom.trim()); return }
      if (isInkBackspace(key)) { setCustom(custom.slice(0, -1)); return }
      if (input && !key.ctrl) setCustom(custom + input)
      return
    }
    const nav = isNavKey(key, input)
    if (question?.multiSelect) {
      if (nav === "up") setSelectedIndex(current => moveIndex(current, -1, options.length))
      else if (nav === "down") setSelectedIndex(current => moveIndex(current, 1, options.length))
      else if (input === " ") {
        const value = options[selectedIndex]?.value
        if (!value || value === QUESTION_OTHER_VALUE) return
        setMultiSelected(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value])
      } else if (nav === "confirm") {
        if (options[selectedIndex]?.value === QUESTION_OTHER_VALUE) setCustom("")
        else if (multiSelected.length) accept(multiSelected.join(","))
      }
      return
    }
    if (!options.length) {
      if (custom === null) setCustom("")
      return
    }
    if (nav === "up") setSelectedIndex(current => moveIndex(current, -1, options.length))
    else if (nav === "down") setSelectedIndex(current => moveIndex(current, 1, options.length))
    else if (nav === "confirm") {
      const value = options[selectedIndex]?.value
      if (value === QUESTION_OTHER_VALUE) setCustom("")
      else if (value) accept(value)
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan">{questions.length > 1 ? `Agent 需要你的回答 · ${index + 1}/${questions.length}` : "Agent 需要你的回答"}</Text>
      {question?.question ? <Text>{question.question}</Text> : null}
      {custom !== null
        ? <Text>回答：{custom || " "}▏</Text>
        : options.length
          ? <OptionList options={options.map(option => ({
              ...option,
              label: question?.multiSelect && multiSelected.includes(option.value) ? `✓ ${option.label}` : option.label,
            }))} selectedIndex={selectedIndex} />
          : <Text dimColor>输入回答…</Text>}
      <Text dimColor>{question?.multiSelect ? "空格多选 · Enter 确认" : "↑↓ 选择 · Enter 确认"}</Text>
    </Box>
  )
}

function PlanPanel(props: {
  interaction: Extract<InteractiveSnapshot["interaction"], { type: "plan" }>
  onPlan: (decision: PlanDecision, feedback?: string) => void
  onClose: () => void
}) {
  const options = useMemo(() => {
    const allowed = props.interaction.decisions.filter(isPlanDecision)
    return (allowed.length ? allowed : PLAN_DECISION_ORDER).map(decision => ({
      value: decision,
      label: planDecisionLabel(decision),
      description: planDecisionDescription(decision),
    }))
  }, [props.interaction.decisions])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [feedback, setFeedback] = useState<string | null>(null)
  useInput((input, key) => {
    if (props.interaction.readOnly) {
      if (key.escape || key.return) props.onClose()
      return
    }
    if (feedback !== null) {
      if (key.escape) { setFeedback(null); return }
      if (key.return) {
        const text = feedback.trim()
        if (text) props.onPlan("revise", formatPlanReviewFeedback([], text))
        return
      }
      if (isInkBackspace(key)) { setFeedback(feedback.slice(0, -1)); return }
      if (input && !key.ctrl) setFeedback(feedback + input)
      return
    }
    const nav = isNavKey(key, input)
    if (nav === "up") setSelectedIndex(index => moveIndex(index, -1, options.length))
    else if (nav === "down") setSelectedIndex(index => moveIndex(index, 1, options.length))
    else if (nav === "confirm") {
      const value = options[selectedIndex]?.value
      if (value === "revise") setFeedback("")
      else if (isPlanDecision(value)) props.onPlan(value)
    } else if (nav === "escape") props.onClose()
  })
  const lines = props.interaction.hasPlan ? props.interaction.planMarkdown.split("\n").slice(0, 12) : []
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta">{props.interaction.readOnly ? "计划预览" : "审核计划"}</Text>
      {lines.map((line, index) => <Text key={`${index}-${line.slice(0, 24)}`}>{line || " "}</Text>)}
      {feedback !== null
        ? <Text>打磨意见：{feedback || " "}▏</Text>
        : props.interaction.readOnly
          ? <Text dimColor>Esc/Enter 关闭</Text>
          : <OptionList options={options} selectedIndex={selectedIndex} />}
      {props.interaction.readOnly || feedback !== null ? null : <Text dimColor>↑↓ 选择 · Enter 确认</Text>}
    </Box>
  )
}

function GoalPanel(props: {
  interaction: Extract<InteractiveSnapshot["interaction"], { type: "goal" }>
  onGoal: (response: GoalReviewResponse) => void
  onClose: () => void
}) {
  const options = [
    { value: "accepted", label: "接受并开始", description: "保存目标并自动开始工作" },
    { value: "edited", label: "编辑验收标准", description: "每行一条，确认后保存并开始" },
    { value: "rejected", label: "驳回并反馈", description: "填写修改意见后重新生成" },
    { value: "cancelled", label: "取消", description: "放弃这次目标草案" },
  ].filter(option => props.interaction.decisions.includes(option.value as GoalReviewResponse["decision"]))
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [editMode, setEditMode] = useState<"criteria" | "feedback" | null>(null)
  const [draft, setDraft] = useState("")
  useInput((input, key) => {
    if (props.interaction.readOnly || props.interaction.isEditPrompt) {
      if (key.escape || (props.interaction.readOnly && key.return)) props.onClose()
      return
    }
    if (editMode) {
      if (key.escape) { setEditMode(null); setDraft(""); return }
      if (key.return) {
        const text = draft.trim()
        if (!text) return
        if (editMode === "criteria") {
          props.onGoal({ decision: "edited", criteria: text.split("\n").map(item => item.trim()).filter(Boolean) })
        } else {
          props.onGoal({ decision: "rejected", feedback: text })
        }
        return
      }
      if (isInkBackspace(key)) { setDraft(draft.slice(0, -1)); return }
      if (input && !key.ctrl) setDraft(draft + input)
      return
    }
    const nav = isNavKey(key, input)
    if (nav === "up") setSelectedIndex(index => moveIndex(index, -1, options.length))
    else if (nav === "down") setSelectedIndex(index => moveIndex(index, 1, options.length))
    else if (nav === "confirm") {
      const value = options[selectedIndex]?.value
      if (value === "edited") { setEditMode("criteria"); setDraft(props.interaction.criteria.join("\n")); return }
      if (value === "rejected") { setEditMode("feedback"); setDraft(""); return }
      if (value === "accepted" || value === "cancelled") props.onGoal({ decision: value })
    } else if (nav === "escape") props.onGoal({ decision: "cancelled" })
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text color="green">{props.interaction.isEditPrompt ? "编辑目标" : props.interaction.readOnly ? "目标详情" : "审核目标"}</Text>
      <Text>{props.interaction.objective}</Text>
      {props.interaction.criteria.map((criterion, index) => <Text key={`${index}-${criterion}`} dimColor>{`${index + 1}. ${criterion}`}</Text>)}
      {editMode
        ? <Text>{editMode === "criteria" ? "验收标准：" : "反馈："}{draft || " "}▏</Text>
        : props.interaction.readOnly
          ? <Text dimColor>Esc/Enter 关闭</Text>
          : <OptionList options={options} selectedIndex={selectedIndex} />}
    </Box>
  )
}

/** 按 pending Interaction 渲染唯一底部面板。 */
export function InteractionBottomArea(props: {
  snapshot: InteractiveSnapshot
  adapter: TuiAdapter
}) {
  const interaction = props.snapshot.interaction
  const kind = bottomAreaKind(interaction)
  if (kind === "input" || !interaction) return null
  if (interaction.type === "approval") {
    return <ApprovalPanel interaction={interaction} onApproval={decision => { void props.adapter.dispatch({ type: "approval", decision }) }} />
  }
  if (interaction.type === "directory_trust") {
    return <DirectoryTrustPanel interaction={interaction} onDirectoryTrust={decision => { void props.adapter.dispatch({ type: "directory-trust", decision }) }} />
  }
  if (interaction.type === "question") {
    return <QuestionPanel interaction={interaction} onQuestion={answers => { void props.adapter.dispatch({ type: "question", answers }) }} />
  }
  if (interaction.type === "plan") {
    return (
      <PlanPanel
        interaction={interaction}
        onPlan={(decision, feedback) => { void props.adapter.dispatch({ type: "plan", decision, feedback }) }}
        onClose={() => { void props.adapter.dispatch({ type: "plan-view-close" }) }}
      />
    )
  }
  if (interaction.type === "goal") {
    return (
      <GoalPanel
        interaction={interaction}
        onGoal={response => { void props.adapter.dispatch({ type: "goal", response }) }}
        onClose={() => { void props.adapter.dispatch({ type: "goal-view-close" }) }}
      />
    )
  }
  return null
}

export { bottomAreaKind }
