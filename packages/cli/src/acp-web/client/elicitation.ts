/**
 * ACP `elicitation/create` 表单 ↔ 现有提问、计划、目标卡片。
 *
 * 【这是做什么的？】Python 把提问、计划确认、目标确认、拒绝原因收成一张
 * JSON Schema 表单。浏览器已经会画这四种卡片，这里只做形状识别和字段对译，
 * 不发网络请求、不持有挂起状态。
 *
 * 【上下游】上游是网关的 `unstable_createElicitation`。下游仍是原来的
 * `interactionHandler`：用户在现有卡片上作答后，再翻回 ACP 的 accept/decline/cancel。
 *
 * 【认表】只看 schema，不看文案：
 *   有 q_N            → 提问（q_N_other 是「其他」）
 *   decision + criteria → 目标
 *   decision +「修改意见」→ 计划
 *   只有必填 feedback → 拒绝原因
 *   其余              → 一题一个字段的通用提问
 */

import type { InteractionRequestEnvelope, InteractionResponse, PlanDecision } from "@za38/protocol"

const FEEDBACK_MAX = 4000
const PLAN_ORDER = ["approved", "revise", "abandoned"] as const
const GOAL_ORDER = ["accepted", "edited", "rejected"] as const
const PLAN_VIRTUAL_PATH = "/.harness/plan.md" as const

type FormQuestion = {
  id: string
  question: string
  header: string
  body: string
  options: Array<{ label: string; value: string; description: string }>
  multi: boolean
  allowOther: boolean
  /** 自由文本写到这个键。空则写回本题自己。 */
  otherKey: string | null
}

export type RecognizedForm =
  | { kind: "question"; questions: FormQuestion[] }
  | { kind: "plan"; displayPath: string; markdown: string; decisions: PlanDecision[] }
  | { kind: "goal"; objective: string; assumptions: string[]; criteria: string[]; decisions: Array<"accepted" | "edited" | "rejected"> }
  | { kind: "feedback" }

export type FormContext = {
  requestId: string
  threadId: string
  runId: string
  message: string
}

type ElicitationAnswer =
  | { action: "accept"; content: Record<string, string | string[]> }
  | { action: "decline" }
  | { action: "cancel" }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function optionList(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return []
  const options: Array<{ label: string; value: string }> = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record || typeof record.const !== "string" || !record.const) continue
    const title = typeof record.title === "string" && record.title ? record.title : record.const
    options.push({ label: title, value: record.const })
  }
  return options
}

function propertyOptions(prop: Record<string, unknown>): Array<{ label: string; value: string }> {
  const titled = optionList(prop.oneOf)
  if (titled.length > 0) return titled
  const items = asRecord(prop.items)
  const multi = optionList(items?.anyOf)
  if (multi.length > 0) return multi
  if (!Array.isArray(prop.enum)) return []
  return prop.enum
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map(value => ({ label: value, value }))
}

/** 选项必须全是这组已知值；按规范顺序返回，夹带未知值就不是这种表。 */
function knownDecisions<T extends string>(prop: Record<string, unknown> | undefined, order: readonly T[]): T[] | null {
  if (!prop) return null
  const options = propertyOptions(prop)
  if (options.length === 0) return null
  const allowed = new Set<string>(order)
  if (options.some(option => !allowed.has(option.value))) return null
  const present = new Set(options.map(option => option.value))
  return order.filter(item => present.has(item))
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function clip(value: string): string {
  return value.length <= FEEDBACK_MAX ? value : value.slice(0, FEEDBACK_MAX)
}

function questionFields(properties: Record<string, unknown>, message: string): FormQuestion[] {
  const names = Object.keys(properties)
    .filter(name => /^q_\d+$/.test(name))
    .sort((left, right) => Number(left.slice(2)) - Number(right.slice(2)))
  const questions: FormQuestion[] = []
  for (const name of names) {
    const prop = asRecord(properties[name])
    if (!prop) continue
    const options = propertyOptions(prop)
    const otherKey = asRecord(properties[`${name}_other`]) ? `${name}_other` : null
    const title = text(prop.title) || "请回答"
    // 没有 oneOf 的字符串是填空。卡片用「其他」文本框收下，交回时写在 q_N 上。
    if (options.length === 0) {
      if (prop.type !== "string") continue
      questions.push({
        id: name,
        question: names.length === 1 ? (message || title) : title,
        header: title,
        body: text(prop.description),
        options: [],
        multi: false,
        allowOther: true,
        otherKey: null,
      })
      continue
    }
    questions.push({
      id: name,
      question: names.length === 1 ? (message || title) : title,
      header: title,
      body: text(prop.description),
      options: options.map(option => ({ ...option, description: "" })),
      multi: prop.type === "array",
      allowOther: otherKey !== null,
      otherKey,
    })
  }
  return questions
}

function genericFields(properties: Record<string, unknown>, message: string): FormQuestion[] {
  const names = Object.keys(properties)
  return names.flatMap(name => {
    const prop = asRecord(properties[name])
    if (!prop) return []
    const options = propertyOptions(prop)
    const title = text(prop.title)
    return [{
      id: name,
      question: names.length === 1 ? (title || message || name) : (title || name),
      header: title,
      body: text(prop.description),
      options: options.map(option => ({ ...option, description: "" })),
      multi: prop.type === "array",
      allowOther: options.length === 0,
      otherKey: null,
    }]
  })
}

function parsePlanMessage(message: string): { displayPath: string; markdown: string } {
  const matched = message.match(/^请确认执行计划（([^）]*)）\n\n([\s\S]*)$/)
  if (!matched) return { displayPath: "", markdown: message }
  return { displayPath: matched[1] ?? "", markdown: matched[2] ?? "" }
}

function parseGoalMessage(message: string): { objective: string; assumptions: string[] } {
  const lines = message.split("\n")
  const objective = (lines[0] ?? "").replace(/^确认目标：/, "")
  if (!lines[1]?.startsWith("假设：")) return { objective, assumptions: [] }
  const rest = [lines[1].slice("假设：".length), ...lines.slice(2)]
  return { objective, assumptions: rest.map(item => item.trim()).filter(Boolean) }
}

function criteriaDefault(prop: Record<string, unknown> | null): string[] {
  if (!prop || typeof prop.default !== "string") return []
  return prop.default.split("\n").map(item => item.trim()).filter(Boolean)
}

/** 按 schema 形状认出一张表。认不出时收成通用提问。 */
export function recognizeForm(schema: unknown, message: string): RecognizedForm {
  const root = asRecord(schema)
  const properties = asRecord(root?.properties) ?? {}
  const questionNames = Object.keys(properties).some(name => /^q_\d+$/.test(name))
  if (questionNames) return { kind: "question", questions: questionFields(properties, message) }

  const goalDecisions = knownDecisions(asRecord(properties.decision) ?? undefined, GOAL_ORDER)
  if (goalDecisions && "criteria" in properties) {
    const parsed = parseGoalMessage(message)
    return {
      kind: "goal",
      objective: parsed.objective,
      assumptions: parsed.assumptions,
      criteria: criteriaDefault(asRecord(properties.criteria)),
      decisions: goalDecisions,
    }
  }

  const feedback = asRecord(properties.feedback)
  const planDecisions = knownDecisions(asRecord(properties.decision) ?? undefined, PLAN_ORDER)
  if (planDecisions && !("criteria" in properties) && feedback?.title === "修改意见") {
    const parsed = parsePlanMessage(message)
    return { kind: "plan", displayPath: parsed.displayPath, markdown: parsed.markdown, decisions: planDecisions }
  }

  const keys = Object.keys(properties)
  const required = Array.isArray(root?.required) ? root.required : []
  if (keys.length === 1 && keys[0] === "feedback" && required.includes("feedback")) {
    return { kind: "feedback" }
  }

  return { kind: "question", questions: genericFields(properties, message) }
}

function questionEnvelope(questions: FormQuestion[], context: FormContext): InteractionRequestEnvelope | null {
  if (questions.length === 0) return null
  return {
    request_id: context.requestId,
    type: "question",
    thread_id: context.threadId,
    run_id: context.runId,
    timeout_ms: Number.POSITIVE_INFINITY,
    payload: {
      interrupt_id: context.requestId,
      questions: questions.map(question => ({
        id: question.id,
        question: question.question,
        header: question.header,
        body: question.body,
        options: question.options,
        multi_select: question.multi,
        allow_other: question.allowOther,
      })),
    },
  }
}

/** 翻成现有卡片能画的信封。没有可展示的字段时返回 null，调用方按拒绝处理。 */
export function toInteractionEnvelope(form: RecognizedForm, context: FormContext): InteractionRequestEnvelope | null {
  if (form.kind === "question") return questionEnvelope(form.questions, context)
  if (form.kind === "feedback") {
    return questionEnvelope([{
      id: "feedback",
      question: context.message || "请说明拒绝原因",
      header: "拒绝原因",
      body: "",
      options: [],
      multi: false,
      allowOther: true,
      otherKey: null,
    }], context)
  }
  if (form.kind === "plan") {
    return {
      request_id: context.requestId,
      type: "plan",
      thread_id: context.threadId,
      run_id: context.runId,
      timeout_ms: Number.POSITIVE_INFINITY,
      payload: {
        interrupt_id: context.requestId,
        tool_call_id: "",
        revision: 0,
        has_plan: form.markdown.length > 0,
        plan_markdown: form.markdown,
        plan_virtual_path: PLAN_VIRTUAL_PATH,
        plan_display_path: form.displayPath,
        decisions: form.decisions,
      },
    }
  }
  return {
    request_id: context.requestId,
    type: "goal",
    thread_id: context.threadId,
    run_id: context.runId,
    timeout_ms: Number.POSITIVE_INFINITY,
    payload: {
      interrupt_id: context.requestId,
      request_id: context.requestId,
      proposal_kind: "create",
      base_goal_id: null,
      base_revision: null,
      objective: form.objective,
      assumptions: form.assumptions,
      criteria: form.criteria,
      decisions: form.decisions,
    },
  }
}

function questionContent(questions: FormQuestion[], answers: Record<string, readonly string[]>): Record<string, string | string[]> {
  const content: Record<string, string | string[]> = {}
  for (const question of questions) {
    const values = (answers[question.id] ?? []).map(item => item.trim()).filter(Boolean)
    if (question.options.length === 0) {
      const textValue = values[0]
      if (textValue) content[question.id] = clip(textValue)
      continue
    }
    const allowed = new Set(question.options.map(option => option.value))
    const selected = values.filter(value => allowed.has(value))
    const extra = values.find(value => !allowed.has(value)) ?? ""
    if (question.multi) {
      if (selected.length > 0) content[question.id] = selected
    } else if (selected[0]) {
      content[question.id] = selected[0]
    }
    if (question.otherKey && extra) content[question.otherKey] = clip(extra)
  }
  return content
}

/** 卡片回答 → ACP accept/decline/cancel。对不上这种表就取消。 */
export function toElicitationResponse(form: RecognizedForm, response: InteractionResponse): ElicitationAnswer {
  if (form.kind === "feedback") {
    if (response.type !== "question") return { action: "decline" }
    const textValue = (response.answers.feedback ?? []).map(item => item.trim()).find(Boolean) ?? ""
    if (!textValue) return { action: "decline" }
    return { action: "accept", content: { feedback: clip(textValue) } }
  }
  if (form.kind === "question") {
    if (response.type !== "question") return { action: "cancel" }
    const content = questionContent(form.questions, response.answers)
    if (Object.keys(content).length === 0) return { action: "cancel" }
    return { action: "accept", content }
  }
  if (form.kind === "plan") {
    if (response.type !== "plan") return { action: "cancel" }
    return { action: "accept", content: { decision: response.decision, feedback: clip(response.feedback ?? "") } }
  }
  if (response.type !== "goal" || response.decision === "cancelled") return { action: "cancel" }
  const content: Record<string, string> = { decision: response.decision }
  const feedback = clip(response.feedback ?? "")
  if (feedback) content.feedback = feedback
  if (response.decision === "edited") content.criteria = response.criteria.join("\n")
  return { action: "accept", content }
}
