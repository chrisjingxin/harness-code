/**
 * 对话组合视图：把已迁出的阅读流与受控输入区放在同一容器。
 *
 * 装配方保存每个 scope 的个人状态并处理真实动作；这里不持有服务连接或 Agent。
 * 发送输入 → 捕获身份和草稿修订 → 等待回调 → 身份仍有效时发条件清空。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { ReactElement } from "react"

import { ConversationComposer } from "./composer.js"
import { ConversationInteraction } from "./interaction.js"
import { ConversationTimeline } from "./timeline.js"
import type { ConversationInteractionAnswer, ConversationScope, ConversationViewProps } from "./types.js"

type SendStatus = { phase: "sending" | "unknown" | "rejected"; message: string; identity: number; sawDisabled: boolean }
type CancelStatus = { message: string; identity: number; sawDisabled: boolean }
type InteractionStatus = { phase: "submitting" | "waiting" | "unknown"; message: string; identity: number; retryRevision: number }

function scopeKey(scope: ConversationScope): string {
  return JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.conversationId])
}

/**
 * 同账号不同会话可更新原分区；切换身份后旧结果不能清空草稿或显示给新账号。
 * 调用方仍须在原 scope 原子比较 expectedRevision，并保存组件卸载后的未知结果。
 */
export function ConversationView(props: ConversationViewProps): ReactElement {
  const { scope, visible, entries, contentRevision, activity, composer, interaction, personal, actions, slots } = props
  const key = scopeKey(scope)
  const identityKey = JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId])
  const identity = useRef({ key: identityKey, revision: 0 })
  if (identity.current.key !== identityKey) identity.current = { key: identityKey, revision: identity.current.revision + 1 }
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const mounted = useRef(true)
  const sending = useRef(new Map<string, symbol>())
  const cancelling = useRef(new Map<string, symbol>())
  const submittingInteractions = useRef(new Map<string, symbol>())
  const [sendStates, setSendStates] = useState<Record<string, SendStatus>>({})
  const [cancelStates, setCancelStates] = useState<Record<string, CancelStatus>>({})
  const [interactionStates, setInteractionStates] = useState<Record<string, InteractionStatus>>({})
  const [, refreshPending] = useState(0)
  const currentSend = sendStates[key]?.identity === identity.current.revision ? sendStates[key] : undefined
  const currentCancel = cancelStates[key]?.identity === identity.current.revision ? cancelStates[key] : undefined
  const interactionKey = interaction ? JSON.stringify([key, interaction.id]) : ""
  const currentInteraction = interactionStates[interactionKey]?.identity === identity.current.revision ? interactionStates[interactionKey] : undefined
  const interactionRetryRevision = interaction?.retryRevision ?? 0
  // 明确的重试版本可跨请求切换；连接恢复和普通重渲染不能解除等待。
  const interactionRetryable = Boolean(interaction && currentInteraction && currentInteraction.phase !== "submitting" && interactionRetryRevision > currentInteraction.retryRevision && !interaction.readOnly && interaction.availability.enabled && (interaction.deadlineAtMs === undefined || Number.isFinite(interaction.deadlineAtMs) && Date.now() < interaction.deadlineAtMs))
  const interactionBlocked = Boolean(currentInteraction && !interactionRetryable) || submittingInteractions.current.has(interactionKey)

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // 未知结果必须由装配方先禁用再明确恢复；重新渲染不能悄悄允许重发。
  useEffect(() => {
    if (currentSend?.phase !== "unknown") return
    if (!composer.send.enabled && !currentSend.sawDisabled) {
      setSendStates(previous => ({ ...previous, [key]: { ...currentSend, sawDisabled: true } }))
    } else if (composer.send.enabled && currentSend.sawDisabled) {
      setSendStates(previous => { const next = { ...previous }; delete next[key]; return next })
    }
  }, [composer.send.enabled, currentSend, key])

  useEffect(() => {
    if (!currentCancel) return
    const hasCancel = composer.primaryActions === "cancel" || composer.primaryActions === "both"
    if (!hasCancel) {
      setCancelStates(previous => { const next = { ...previous }; delete next[key]; return next })
    } else if (!composer.cancel.enabled && !currentCancel.sawDisabled) {
      setCancelStates(previous => ({ ...previous, [key]: { ...currentCancel, sawDisabled: true } }))
    } else if (composer.cancel.enabled && currentCancel.sawDisabled) {
      setCancelStates(previous => { const next = { ...previous }; delete next[key]; return next })
    }
  }, [composer.cancel.enabled, composer.primaryActions, currentCancel, key])

  const send = async (): Promise<void> => {
    const onSend = actions.onSend
    const hasContent = personal.draft.text.trim().length > 0 || personal.draft.referenceIds.length > 0 || personal.draft.attachmentIds.length > 0
    if (!visible || (composer.primaryActions !== "send" && composer.primaryActions !== "both") || !onSend || !actions.onPersonalChange || !composer.send.enabled || !hasContent || sending.current.has(key) || currentSend?.phase === "unknown") return
    const request = Symbol("send")
    const sourceScope = { ...scope }
    const sourceIdentity = identity.current.revision
    const { revision, text, referenceIds, attachmentIds } = personal.draft
    sending.current.set(key, request)
    setSendStates(previous => ({ ...previous, [key]: { phase: "sending", message: "正在提交…", identity: sourceIdentity, sawDisabled: false } }))
    try {
      const result = await onSend(sourceScope, revision, text, [...referenceIds], [...attachmentIds])
      if (!mounted.current || identity.current.revision !== sourceIdentity || sending.current.get(key) !== request) return
      if (result.status === "accepted") {
        actionsRef.current.onPersonalChange?.(sourceScope, { kind: "clear-draft", expectedRevision: revision })
        setSendStates(previous => { const next = { ...previous }; delete next[key]; return next })
      } else {
        setSendStates(previous => ({ ...previous, [key]: { phase: result.status, message: result.message, identity: sourceIdentity, sawDisabled: false } }))
      }
    } catch {
      if (mounted.current && identity.current.revision === sourceIdentity && sending.current.get(key) === request) {
        setSendStates(previous => ({ ...previous, [key]: { phase: "unknown", message: "提交结果待确认，请等待状态更新。", identity: sourceIdentity, sawDisabled: false } }))
      }
    } finally {
      if (sending.current.get(key) === request) {
        sending.current.delete(key)
        if (mounted.current) refreshPending(value => value + 1)
      }
    }
  }

  const cancel = async (): Promise<void> => {
    const onCancel = actions.onCancel
    if (!visible || !onCancel || !composer.cancel.enabled || currentCancel || cancelling.current.has(key)) return
    const request = Symbol("cancel")
    const sourceScope = { ...scope }
    const sourceIdentity = identity.current.revision
    cancelling.current.set(key, request)
    setCancelStates(previous => ({ ...previous, [key]: { message: "已请求停止，等待状态更新。", identity: sourceIdentity, sawDisabled: false } }))
    try {
      await onCancel(sourceScope)
    } catch {
      if (mounted.current && identity.current.revision === sourceIdentity && cancelling.current.get(key) === request) {
        setCancelStates(previous => ({ ...previous, [key]: { message: "停止结果待确认，请等待状态更新。", identity: sourceIdentity, sawDisabled: false } }))
      }
    } finally {
      if (cancelling.current.get(key) === request) {
        cancelling.current.delete(key)
        if (mounted.current) refreshPending(value => value + 1)
      }
    }
  }

  const submitInteraction = async (answer: ConversationInteractionAnswer): Promise<void> => {
    const onSubmit = actions.onInteractionSubmit
    if (!visible || !interaction || interaction.kind === "extension" || !onSubmit || !actions.onPersonalChange || interaction.readOnly || !interaction.availability.enabled || interactionBlocked || submittingInteractions.current.has(interactionKey)) return
    if (interaction.deadlineAtMs !== undefined && (!Number.isFinite(interaction.deadlineAtMs) || Date.now() >= interaction.deadlineAtMs)) return
    const request = Symbol("interaction")
    const sourceScope = { ...scope }
    const sourceIdentity = identity.current.revision
    const sourceId = interaction.id
    const submittedRevision = interactionRetryRevision
    submittingInteractions.current.set(interactionKey, request)
    setInteractionStates(previous => ({ ...previous, [interactionKey]: { phase: "submitting", message: "正在提交，等待状态更新。", identity: sourceIdentity, retryRevision: submittedRevision } }))
    try {
      await onSubmit(sourceScope, sourceId, answer)
      if (mounted.current && identity.current.revision === sourceIdentity && submittingInteractions.current.get(interactionKey) === request) {
        setInteractionStates(previous => ({ ...previous, [interactionKey]: { phase: "waiting", message: "已提交，等待状态更新。", identity: sourceIdentity, retryRevision: submittedRevision } }))
      }
    } catch {
      if (mounted.current && identity.current.revision === sourceIdentity && submittingInteractions.current.get(interactionKey) === request) {
        setInteractionStates(previous => ({ ...previous, [interactionKey]: { phase: "unknown", message: "提交结果待确认，请等待状态更新。", identity: sourceIdentity, retryRevision: submittedRevision } }))
      }
    } finally {
      if (submittingInteractions.current.get(interactionKey) === request) {
        submittingInteractions.current.delete(interactionKey)
        if (mounted.current) refreshPending(value => value + 1)
      }
    }
  }

  return (
    <section className="wb-conversation-view" hidden={!visible} inert={!visible} aria-label="对话">
      {slots?.aboveTimeline}
      <ConversationTimeline scope={scope} visible={visible} entries={interaction ? entries.filter(entry => entry.kind !== "interaction-history" || entry.id !== interaction.id) : entries} contentRevision={contentRevision} activity={activity} personal={personal} onPersonalChange={actions.onPersonalChange} rendering={actions.rendering} />
      {interaction ? <ConversationInteraction key={interactionKey} scope={scope} interaction={interaction} personal={personal} actions={actions} blocked={interactionBlocked} status={interactionRetryable ? undefined : currentInteraction?.message} onSubmit={answer => { void submitInteraction(answer) }} /> : null}
      <ConversationComposer
        key={key}
        scope={scope}
        visible={visible}
        activity={activity}
        model={composer}
        draft={personal.draft}
        actions={actions}
        sendBlocked={currentSend?.phase === "sending" || currentSend?.phase === "unknown" || sending.current.has(key)}
        cancelBlocked={Boolean(currentCancel) || cancelling.current.has(key)}
        localStatus={currentSend?.message ?? currentCancel?.message}
        onSend={() => { void send() }}
        onCancel={() => { void cancel() }}
      >{slots?.composer}</ConversationComposer>
    </section>
  )
}
