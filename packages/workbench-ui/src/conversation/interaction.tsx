/**
 * 通用待处理交互：展示调用方提供的审批选项、问题和扩展节点。
 * 选择与反馈只写入当前 scope 的个人草稿，提交只上报意图，不推断真实处理结果。
 */
import { useEffect, useId, useState } from "react"
import type { ReactElement } from "react"
import type { ConversationActions, ConversationInteractionAnswer, ConversationInteractionView, ConversationPersonalState, ConversationScope } from "./types.js"

type QuestionAnswer = Extract<ConversationInteractionAnswer, { kind: "question" }>["answers"][number]
type Question = Extract<ConversationInteractionView, { kind: "question" }>["questions"][number]

export function ConversationInteraction({ scope, interaction, personal, actions, blocked, status, onSubmit }: {
  scope: ConversationScope
  interaction: ConversationInteractionView
  personal: ConversationPersonalState
  actions: ConversationActions
  blocked: boolean
  status?: string
  onSubmit: (answer: ConversationInteractionAnswer) => void
}): ReactElement {
  const radioGroup = useId()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (interaction.deadlineAtMs === undefined) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [interaction.deadlineAtMs])

  const deadline = interaction.deadlineAtMs
  const expired = deadline !== undefined && (!Number.isFinite(deadline) || now >= deadline)
  const editable = !blocked && !expired && !interaction.readOnly && interaction.availability.enabled && Boolean(actions.onPersonalChange && actions.onInteractionSubmit)
  const reason = expired ? "请求已过期" : interaction.readOnly ? "当前请求只读" : !interaction.availability.enabled ? interaction.availability.reason ?? "当前请求不可用" : interaction.kind !== "extension" && (!actions.onPersonalChange || !actions.onInteractionSubmit) ? "当前无法提交回答" : undefined
  const saved = personal.interactions[interaction.id]
  const save = (answer: ConversationInteractionAnswer): void => {
    if (!editable || (deadline !== undefined && Date.now() >= deadline)) return
    actions.onPersonalChange?.(scope, { kind: "interaction", interactionId: interaction.id, answer })
  }
  const submit = (answer: ConversationInteractionAnswer): void => {
    if (!editable || (deadline !== undefined && Date.now() >= deadline)) return
    onSubmit(answer)
  }

  return (
    <section className="wb-interaction-dock" aria-label="待处理请求">
      <div className="wb-interaction-form">
        <header className="wb-interaction-heading">
          <h3>{interaction.title}</h3>
          {deadline !== undefined ? <span className={expired ? "wb-interaction-deadline is-expired" : "wb-interaction-deadline"}>{expired ? "已过期" : `剩余 ${formatRemaining(deadline - now)}`}</span> : null}
        </header>
        {interaction.description ? <p className="wb-interaction-description">{interaction.description}</p> : null}
        {interaction.preview != null ? <div className="wb-interaction-preview">{interaction.preview}</div> : null}
        {interaction.kind === "approval" ? (() => {
          const answer = saved?.kind === "approval" ? saved : null
          const selected = interaction.options.find(option => option.id === answer?.optionId)
          const feedbackValid = selected?.feedback !== "required" || Boolean(answer?.feedback?.trim())
          return <>
            <div className="wb-interaction-approval-options" role="group" aria-label="审批选项">
              {interaction.options.map(option => <button type="button" key={option.id} className={`wb-interaction-option wb-interaction-option-${option.tone}`} aria-pressed={answer?.optionId === option.id} title={!option.availability.enabled ? option.availability.reason ?? "当前选项不可用" : option.description} disabled={!editable || !option.availability.enabled} onClick={() => {
                const next: ConversationInteractionAnswer = { kind: "approval", optionId: option.id }
                save(next)
                // 明确要求反馈或批准类动作都保留确认步骤，防止误触。
                if (option.behavior === "immediate" && option.tone !== "positive" && option.feedback !== "required") submit(next)
              }}><span>{option.label}</span>{option.description ? <span className="wb-interaction-option-description">{option.description}</span> : null}{!option.availability.enabled && option.availability.reason ? <span className="wb-interaction-option-description">{option.availability.reason}</span> : null}</button>)}
            </div>
            {selected && selected.feedback !== "none" ? <label className="wb-interaction-feedback"><span>反馈{selected.feedback === "required" ? "（必填）" : "（可选）"}</span><textarea rows={3} value={answer?.feedback ?? ""} disabled={!editable} onChange={event => save({ kind: "approval", optionId: selected.id, feedback: event.currentTarget.value })} /></label> : null}
            <div className="wb-interaction-actions"><button type="button" className="wb-interaction-submit" disabled={!editable || !selected?.availability.enabled || !feedbackValid} title={!selected?.availability.enabled && selected ? selected.availability.reason : reason} onClick={() => { if (answer && selected && feedbackValid) submit(answer) }}>提交</button></div>
          </>
        })() : null}
        {interaction.kind === "question" ? (() => {
          const answers = saved?.kind === "question" ? saved.answers : []
          const current = (questionId: string): QuestionAnswer => answers.find(item => item.questionId === questionId) ?? { questionId, selectedOptionIds: [] }
          const update = (next: QuestionAnswer): void => save({ kind: "question", answers: [...answers.filter(item => item.questionId !== next.questionId), next] })
          const valid = interaction.questions.every(question => validQuestion(question, current(question.id)))
          return <>
            <div className="wb-interaction-questions">{interaction.questions.map((question, index) => {
              const answer = current(question.id)
              const otherSelected = answer.otherText !== undefined
              return <fieldset key={question.id} className="wb-interaction-question" disabled={!editable}>
                <legend>{question.text}{question.required ? "（必答）" : "（可选）"}</legend>
                {question.options.map(option => {
                  const checked = answer.selectedOptionIds.includes(option.id)
                  return <label key={option.id} className="wb-interaction-question-option" data-checked={checked} title={!option.availability.enabled ? option.availability.reason ?? "当前选项不可用" : undefined}>
                    <input type={question.multiple ? "checkbox" : "radio"} name={`${radioGroup}-${index}`} checked={checked} disabled={!option.availability.enabled} onChange={event => {
                      const selectedOptionIds = question.multiple ? event.currentTarget.checked ? [...answer.selectedOptionIds, option.id] : answer.selectedOptionIds.filter(id => id !== option.id) : [option.id]
                      update({ questionId: question.id, selectedOptionIds, ...(question.multiple && otherSelected ? { otherText: answer.otherText } : {}) })
                    }} />
                    <span>{option.label}</span>{option.description ? <span className="wb-interaction-option-description">{option.description}</span> : null}{!option.availability.enabled && option.availability.reason ? <span className="wb-interaction-option-description">{option.availability.reason}</span> : null}
                  </label>
                })}
                {question.allowOther ? <div className="wb-interaction-question-option wb-interaction-other" data-checked={otherSelected}>
                  <label><input type={question.multiple ? "checkbox" : "radio"} name={`${radioGroup}-${index}`} checked={otherSelected} onChange={event => update({ questionId: question.id, selectedOptionIds: question.multiple ? answer.selectedOptionIds : [], ...(event.currentTarget.checked ? { otherText: answer.otherText ?? "" } : {}) })} /><span>其他</span></label>
                  <input type="text" aria-label={`${question.text} · 其他`} value={answer.otherText ?? ""} disabled={!editable || !otherSelected} onChange={event => update({ ...answer, otherText: event.currentTarget.value })} />
                </div> : null}
              </fieldset>
            })}</div>
            <div className="wb-interaction-actions"><button type="button" className="wb-interaction-submit" disabled={!editable || !valid} title={reason} onClick={() => { if (valid) submit({ kind: "question", answers: interaction.questions.map(question => current(question.id)) }) }}>提交</button></div>
          </>
        })() : null}
        {interaction.kind === "extension" ? <div className="wb-interaction-extension" inert={blocked || expired || interaction.readOnly || !interaction.availability.enabled}>{interaction.content}</div> : null}
        {status || reason ? <p className="wb-interaction-status" role="status">{status ?? reason}</p> : null}
      </div>
    </section>
  )
}

/** 防止旧选项或未填写的“其他”作为有效答案提交。 */
function validQuestion(question: Question, answer: QuestionAnswer): boolean {
  const other = answer.otherText !== undefined
  if (other && (!question.allowOther || !answer.otherText?.trim())) return false
  if (answer.selectedOptionIds.some(id => !question.options.some(option => option.id === id && option.availability.enabled))) return false
  const count = answer.selectedOptionIds.length + Number(other)
  return (question.multiple || count <= 1) && (!question.required || count > 0)
}

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`
}
