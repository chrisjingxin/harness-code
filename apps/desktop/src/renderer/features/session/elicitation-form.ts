/**
 * ACP `elicitation/create` JSON Schema 表单 ↔ `@workbench/ui` `ConversationInteractionView` 双向转换器。
 *
 * 【功能定义】
 * 识别标准 ACP 表单及 Harness Agent 的四类结构化 schema：
 * 1. `q_N` / `q_N_other`（单选、多选、自由文本填空） → `ConversationInteractionView(question)`
 * 2. `decision` + `criteria`（目标确认） → `ConversationInteractionView(approval)`
 * 3. `decision` + `feedback`（计划确认） → `ConversationInteractionView(approval)`
 * 4. 仅必填 `feedback`（拒绝原因追问） → `ConversationInteractionView(question)`
 * 5. 其余通用 JSON Schema 属性（string / enum / oneOf / array / boolean / number） → `ConversationInteractionView(question)`
 * 并将用户提交的答案、拒绝或取消安全翻回 `LocalExecutionElicitationAnswer`。
 * 【协作边界】纯数据转换，无 React/DOM/Node 依赖，可在 Node 测试与渲染进程直接运行。
 */
import type {
  ConversationAvailability,
  ConversationInteractionAnswer,
  ConversationInteractionView,
} from "@workbench/ui"
import type {
  LocalExecutionElicitationAnswer,
  LocalExecutionElicitationRequest,
  LocalExecutionElicitationValue,
} from "../../../local-execution-host.js"

const FEEDBACK_MAX = 4000
const PLAN_ORDER = ["approved", "revise", "abandoned"] as const
const GOAL_ORDER = ["accepted", "edited", "rejected"] as const

const PLAN_LABELS: Record<(typeof PLAN_ORDER)[number], string> = {
  approved: "批准并开始执行",
  revise: "需要修改",
  abandoned: "放弃",
}

const GOAL_LABELS: Record<(typeof GOAL_ORDER)[number], string> = {
  accepted: "接受",
  edited: "修改判定条件后接受",
  rejected: "拒绝",
}

export type ElicitationQuestionSpec = {
  readonly id: string
  readonly text: string
  readonly header: string
  readonly description: string
  readonly multiple: boolean
  readonly required: boolean
  readonly allowOther: boolean
  /** 存在独立 `_other` 属性时写回该键；无选项或通用字段直接写回本题 id。 */
  readonly otherKey: string | null
  readonly valueType: "string" | "array" | "boolean" | "number"
  readonly options: readonly { readonly id: string; readonly label: string }[]
}

export type RecognizedElicitationForm =
  | { readonly kind: "question"; readonly questions: readonly ElicitationQuestionSpec[] }
  | {
      readonly kind: "plan"
      readonly displayPath: string
      readonly markdown: string
      readonly decisions: readonly (typeof PLAN_ORDER)[number][]
      readonly optionLabels: Readonly<Record<string, string>>
    }
  | {
      readonly kind: "goal"
      readonly objective: string
      readonly assumptions: readonly string[]
      readonly criteria: readonly string[]
      readonly decisions: readonly (typeof GOAL_ORDER)[number][]
      readonly optionLabels: Readonly<Record<string, string>>
    }
  | { readonly kind: "feedback"; readonly message: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function clip(value: string): string {
  return value.length <= FEEDBACK_MAX ? value : value.slice(0, FEEDBACK_MAX)
}

function extractTitledOptions(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return []
  const options: Array<{ id: string; label: string }> = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record || typeof record.const !== "string" || !record.const) continue
    const label = typeof record.title === "string" && record.title ? record.title : record.const
    options.push({ id: record.const, label })
  }
  return options
}

function extractPropertyOptions(prop: Record<string, unknown>): Array<{ id: string; label: string }> {
  const oneOf = extractTitledOptions(prop.oneOf)
  if (oneOf.length > 0) return oneOf
  const items = asRecord(prop.items)
  const anyOf = extractTitledOptions(items?.anyOf)
  if (anyOf.length > 0) return anyOf
  if (Array.isArray(items?.enum)) {
    return items.enum
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .map(value => ({ id: value, label: value }))
  }
  if (!Array.isArray(prop.enum)) return []
  return prop.enum
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .map(value => ({ id: value, label: value }))
}

function knownDecisions<T extends string>(
  prop: Record<string, unknown> | undefined,
  order: readonly T[],
): { readonly decisions: T[]; readonly labels: Record<string, string> } | null {
  if (!prop) return null
  const options = extractPropertyOptions(prop)
  if (options.length === 0) return null
  const allowed = new Set<string>(order)
  if (options.some(option => !allowed.has(option.id))) return null
  const labelMap: Record<string, string> = {}
  for (const option of options) labelMap[option.id] = option.label
  const present = new Set(options.map(option => option.id))
  return {
    decisions: order.filter(item => present.has(item)),
    labels: labelMap,
  }
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

function parseCriteriaDefault(prop: Record<string, unknown> | null): string[] {
  if (!prop || typeof prop.default !== "string") return []
  return prop.default.split("\n").map(item => item.trim()).filter(Boolean)
}

function buildQuestionFields(
  properties: Record<string, unknown>,
  requiredSet: ReadonlySet<string>,
  message: string,
): ElicitationQuestionSpec[] {
  const names = Object.keys(properties)
    .filter(name => /^q_\d+$/.test(name))
    .sort((left, right) => Number(left.slice(2)) - Number(right.slice(2)))
  const questions: ElicitationQuestionSpec[] = []
  for (const name of names) {
    const prop = asRecord(properties[name])
    if (!prop) continue
    const options = extractPropertyOptions(prop)
    const otherKey = asRecord(properties[`${name}_other`]) ? `${name}_other` : null
    const title = text(prop.title) || "请回答"
    const promptText = names.length === 1 ? (message || title) : title
    if (options.length === 0) {
      if (prop.type !== "string") continue
      questions.push({
        id: name,
        text: promptText,
        header: title,
        description: text(prop.description),
        multiple: false,
        required: requiredSet.has(name),
        allowOther: true,
        otherKey: null,
        valueType: "string",
        options: [],
      })
      continue
    }
    const multiple = prop.type === "array"
    questions.push({
      id: name,
      text: promptText,
      header: title,
      description: text(prop.description),
      multiple,
      required: requiredSet.has(name),
      allowOther: otherKey !== null,
      otherKey,
      valueType: multiple ? "array" : "string",
      options,
    })
  }
  return questions
}

function buildGenericFields(
  properties: Record<string, unknown>,
  requiredSet: ReadonlySet<string>,
  message: string,
): ElicitationQuestionSpec[] {
  const names = Object.keys(properties)
  return names.flatMap<ElicitationQuestionSpec>(name => {
    const prop = asRecord(properties[name])
    if (!prop) return []
    const title = text(prop.title)
    const promptText = names.length === 1 ? (title || message || name) : (title || name)
    if (prop.type === "boolean") {
      return [{
        id: name,
        text: promptText,
        header: title || name,
        description: text(prop.description),
        multiple: false,
        required: requiredSet.has(name),
        allowOther: false,
        otherKey: null,
        valueType: "boolean" as const,
        options: [{ id: "true", label: "是" }, { id: "false", label: "否" }],
      }]
    }
    if (prop.type === "number" || prop.type === "integer") {
      return [{
        id: name,
        text: promptText,
        header: title || name,
        description: text(prop.description),
        multiple: false,
        required: requiredSet.has(name),
        allowOther: true,
        otherKey: null,
        valueType: "number" as const,
        options: [],
      }]
    }
    const options = extractPropertyOptions(prop)
    const multiple = prop.type === "array"
    return [{
      id: name,
      text: promptText,
      header: title || name,
      description: text(prop.description),
      multiple,
      required: requiredSet.has(name),
      allowOther: options.length === 0,
      otherKey: null,
      valueType: multiple ? "array" as const : "string" as const,
      options,
    }]
  })
}

/** 按 JSON Schema 结构识别 ACP 表单类型；认不出专用表时退化为通用提问表单。 */
export function recognizeElicitationForm(requestedSchema: unknown, message: string): RecognizedElicitationForm {
  const root = asRecord(requestedSchema)
  const properties = asRecord(root?.properties) ?? {}
  const required = Array.isArray(root?.required)
    ? root.required.filter((item): item is string => typeof item === "string")
    : []
  const requiredSet = new Set(required)

  if (Object.keys(properties).some(name => /^q_\d+$/.test(name))) {
    return { kind: "question", questions: buildQuestionFields(properties, requiredSet, message) }
  }

  const decisionProp = asRecord(properties.decision) ?? undefined
  const goalDecision = knownDecisions(decisionProp, GOAL_ORDER)
  if (goalDecision && "criteria" in properties) {
    const parsed = parseGoalMessage(message)
    return {
      kind: "goal",
      objective: parsed.objective,
      assumptions: parsed.assumptions,
      criteria: parseCriteriaDefault(asRecord(properties.criteria)),
      decisions: goalDecision.decisions,
      optionLabels: goalDecision.labels,
    }
  }

  const planDecision = knownDecisions(decisionProp, PLAN_ORDER)
  const feedbackProp = asRecord(properties.feedback)
  if (planDecision && !("criteria" in properties) && (feedbackProp?.title === "修改意见" || "feedback" in properties)) {
    const parsed = parsePlanMessage(message)
    return {
      kind: "plan",
      displayPath: parsed.displayPath,
      markdown: parsed.markdown,
      decisions: planDecision.decisions,
      optionLabels: planDecision.labels,
    }
  }

  const keys = Object.keys(properties)
  if (keys.length === 1 && keys[0] === "feedback" && requiredSet.has("feedback")) {
    return { kind: "feedback", message }
  }

  return { kind: "question", questions: buildGenericFields(properties, requiredSet, message) }
}

/** 把识别后的 ACP 表单请求转换为 `@workbench/ui` 可直接渲染的 `ConversationInteractionView`。 */
export function toConversationInteraction(
  request: LocalExecutionElicitationRequest,
  options: {
    readonly retryRevision?: number
    readonly readOnly?: boolean
    readonly availability?: ConversationAvailability
  } = {},
): { readonly form: RecognizedElicitationForm; readonly interaction: ConversationInteractionView } | null {
  const form = recognizeElicitationForm(request.requestedSchema, request.message)
  const availability = options.availability ?? { enabled: true }
  const base = {
    id: request.id,
    readOnly: options.readOnly === true,
    availability,
    ...(options.retryRevision !== undefined ? { retryRevision: options.retryRevision } : {}),
  }

  if (form.kind === "feedback") {
    return {
      form,
      interaction: {
        ...base,
        kind: "question",
        title: "请补充说明",
        questions: [{
          id: "feedback",
          text: form.message || "请说明拒绝原因",
          multiple: false,
          required: true,
          allowOther: true,
          options: [],
        }],
      },
    }
  }

  if (form.kind === "question") {
    if (form.questions.length === 0) return null
    const mappedQuestions = form.questions.map(q => ({
      id: q.id,
      text: q.description ? `${q.text}（${q.description}）` : q.text,
      multiple: q.multiple,
      required: q.required,
      allowOther: q.allowOther,
      options: q.options.map(opt => ({
        id: opt.id,
        label: opt.label,
        availability: { enabled: true },
      })),
    }))
    let singleTitle = "Agent 提问"
    if (form.questions.length === 1) {
      const only = form.questions[0]!
      const onlyRenderedText = mappedQuestions[0]!.text
      const rawHeader = only.header.trim()
      // 单题提问时，Agent 常把同一句完整问题同时写入 request.message 和 prop.title；
      // 若 header 与问题正文相同或为兜底占位“请回答”，改用简短眉题“请确认细节”，避免卡片内连续显示两遍同一问题。
      singleTitle = !rawHeader || rawHeader === "请回答" || rawHeader === only.text.trim() || rawHeader === onlyRenderedText.trim()
        ? "请确认细节"
        : rawHeader
    }
    return {
      form,
      interaction: {
        ...base,
        kind: "question",
        title: singleTitle,
        ...(request.message && form.questions.length > 1 ? { description: request.message } : {}),
        questions: mappedQuestions,
      },
    }
  }

  if (form.kind === "plan") {
    return {
      form,
      interaction: {
        ...base,
        kind: "approval",
        title: form.displayPath ? `确认执行计划（${form.displayPath}）` : "确认执行计划",
        ...(form.markdown ? { description: form.markdown } : {}),
        options: form.decisions.map(decision => ({
          id: decision,
          label: form.optionLabels[decision] || PLAN_LABELS[decision],
          tone: decision === "approved" ? "positive" : decision === "abandoned" ? "negative" : "neutral",
          behavior: decision === "abandoned" ? "immediate" : "confirm",
          feedback: decision === "abandoned" ? "none" : "optional",
          availability: { enabled: true },
        })),
      },
    }
  }

  const descriptionParts: string[] = []
  if (form.assumptions.length > 0) {
    descriptionParts.push(`假设：\n${form.assumptions.map(item => `• ${item}`).join("\n")}`)
  }
  if (form.criteria.length > 0) {
    descriptionParts.push(`当前判定条件：\n${form.criteria.map(item => `• ${item}`).join("\n")}`)
  }
  return {
    form,
    interaction: {
      ...base,
      kind: "approval",
      title: form.objective ? `确认目标：${form.objective}` : "确认目标",
      ...(descriptionParts.length > 0 ? { description: descriptionParts.join("\n\n") } : {}),
      options: form.decisions.map(decision => ({
        id: decision,
        label: form.optionLabels[decision] || GOAL_LABELS[decision],
        ...(decision === "edited" ? { description: "请在下方反馈框每行填写一条新的判定条件" } : {}),
        tone: decision === "accepted" ? "positive" : decision === "rejected" ? "negative" : "neutral",
        behavior: "confirm",
        feedback: decision === "edited" ? "required" : "optional",
        availability: { enabled: true },
      })),
    },
  }
}

/** 把用户对交互卡片的回答（或取消/拒绝动作）翻译为标准 ACP `LocalExecutionElicitationAnswer`。 */
export function toElicitationAnswer(
  form: RecognizedElicitationForm,
  answer: ConversationInteractionAnswer | { readonly kind: "decline" } | { readonly kind: "cancel" },
): LocalExecutionElicitationAnswer {
  if (answer.kind === "cancel") return { action: "cancel" }
  if (answer.kind === "decline") return { action: "decline" }

  if (form.kind === "feedback") {
    if (answer.kind !== "question") return { action: "decline" }
    const entry = answer.answers.find(item => item.questionId === "feedback")
    const textValue = entry?.otherText?.trim() || entry?.selectedOptionIds[0]?.trim() || ""
    if (!textValue) return { action: "decline" }
    return { action: "accept", content: { feedback: clip(textValue) } }
  }

  if (form.kind === "plan") {
    if (answer.kind !== "approval") return { action: "cancel" }
    return {
      action: "accept",
      content: {
        decision: answer.optionId,
        feedback: clip(answer.feedback?.trim() ?? ""),
      },
    }
  }

  if (form.kind === "goal") {
    if (answer.kind !== "approval" || answer.optionId === "cancelled") return { action: "cancel" }
    const feedback = clip(answer.feedback?.trim() ?? "")
    const content: Record<string, LocalExecutionElicitationValue> = { decision: answer.optionId }
    if (feedback) content.feedback = feedback
    if (answer.optionId === "edited") {
      content.criteria = feedback || form.criteria.join("\n")
    }
    return { action: "accept", content }
  }

  if (answer.kind !== "question") return { action: "cancel" }
  const content: Record<string, LocalExecutionElicitationValue> = {}
  for (const question of form.questions) {
    const response = answer.answers.find(item => item.questionId === question.id)
    if (!response) continue
    const otherValue = response.otherText?.trim() ?? ""
    if (question.valueType === "boolean") {
      const picked = response.selectedOptionIds[0]
      if (picked === "true") content[question.id] = true
      else if (picked === "false") content[question.id] = false
      continue
    }
    if (question.valueType === "number") {
      const raw = otherValue || response.selectedOptionIds[0]?.trim() || ""
      if (!raw) continue
      const num = Number(raw)
      if (Number.isFinite(num)) content[question.id] = num
      continue
    }
    if (question.options.length === 0) {
      const textValue = otherValue || response.selectedOptionIds[0]?.trim() || ""
      if (textValue) content[question.id] = clip(textValue)
      continue
    }
    const allowed = new Set(question.options.map(option => option.id))
    const selected = response.selectedOptionIds.filter(id => allowed.has(id))
    if (question.multiple) {
      if (selected.length > 0) content[question.id] = selected
    } else if (selected[0]) {
      content[question.id] = selected[0]
    }
    if (otherValue) {
      if (question.otherKey) content[question.otherKey] = clip(otherValue)
      else if (!question.multiple && !selected[0]) content[question.id] = clip(otherValue)
    }
  }
  if (Object.keys(content).length === 0) return { action: "cancel" }
  return { action: "accept", content }
}
