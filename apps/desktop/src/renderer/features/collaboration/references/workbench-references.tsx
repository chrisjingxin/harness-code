/**
 * 将项目简报、会话引用预览和本机草稿动作接到工作台。快照读取能力由装配方提供。
 * 仅在应用草稿后保留已确认的固定材料，个人记录只接收材料标识。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { CollaborationAppsHost, TaskSummary } from "@workbench/contracts"
import type { ConversationCollaborationCandidate, ConversationProjectTarget, ConversationReferenceView, ConversationScope, ConversationTimelineEntry } from "@workbench/ui"
import { knowledgeReferenceId, parseFixedReference } from "../../../../collaboration-reference.js"
import type { ProjectNavigationScope } from "../../project-navigation/index.js"
import { decodeHistoryToTimelineEntries } from "../../session/index.js"
import type {
  ProjectConversationSummary,
  SessionExternalHooks,
  SessionIntegrationApi,
  SessionPageController,
  SessionReferenceDraftChange,
} from "../../session/index.js"
import { snapshotReferenceView, useConversationReferences } from "./conversation-references.js"
import type { ConversationSnapshot, ReferenceActions, ReferenceScope } from "./conversation-references.js"
import { knowledgeMaterial, readFixedMaterial, snapshotMaterial } from "./fixed-materials.js"
import { readPages } from "../metadata.js"

type Material = { readonly snapshot: ConversationSnapshot }
type Restored = { readonly snapshot: ConversationSnapshot } | { readonly message: string }
const EMPTY_MATERIALS: ReadonlyMap<string, Material> = new Map()

interface WorkbenchReferenceOptions {
  readonly scope: ProjectNavigationScope | null
  readonly selectedConversationId: string | null
  readonly pageController: SessionPageController
  readonly integration: SessionIntegrationApi
  readonly readSnapshot?: ReferenceActions["readSnapshot"]
  readonly host?: CollaborationAppsHost
  readonly members?: readonly { id: string; name: string }[]
  readonly tasks?: readonly TaskSummary[]
  onChooseMember?(memberId: string): void
  onOpenTask?(taskId: string): void
  chooseDirectory(): Promise<string | null>
  locateConversation(conversation: ProjectConversationSummary): boolean
}

/** 快照能力缺失时，工作台沿用原有文件提及和只读页提示。 */
export function useWorkbenchReferences(options: WorkbenchReferenceOptions) {
  const { scope, selectedConversationId, pageController, integration, readSnapshot, host, chooseDirectory, locateConversation,
    members, tasks, onChooseMember, onOpenTask } = options
  const { currentUserId: localDeviceId, conversations, directories, resolveOwnerName } = pageController
  const sourceIsListed = selectedConversationId === null || conversations.some(item =>
    item.conversationId === selectedConversationId && item.projectId === scope?.projectId)
  // 切换看板/任务/知识/会话页时不重建引用范围，避免切页清掉已恢复的固定材料缓存并重复拉取。
  const referenceScope = useMemo((): ReferenceScope | null =>
    scope && sourceIsListed && (host || (localDeviceId && readSnapshot))
      ? { ...scope, deviceId: localDeviceId ?? "", conversationId: selectedConversationId }
      : null,
  [scope, localDeviceId, selectedConversationId, sourceIsListed, readSnapshot, host])

  const currentOrigin = useRef<ReferenceScope | null>(null)
  useLayoutEffect(() => {
    currentOrigin.current = referenceScope
    return () => { currentOrigin.current = null }
  }, [referenceScope])
  const materialKey = scope && localDeviceId && (host || readSnapshot)
    ? JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.projectId, localDeviceId])
    : ""
  const restoredKey = referenceScope
    ? JSON.stringify([referenceScope.namespace, referenceScope.accountId, referenceScope.workspaceId, referenceScope.projectId, referenceScope.deviceId])
    : ""
  const [confirmed, setConfirmed] = useState<{ key: string; origin: ReferenceScope; materials: ReadonlyMap<string, Material> }>()
  const [restored, setRestored] = useState<{ key: string; materials: ReadonlyMap<string, Restored> }>()
  const [retryRevision, retryReads] = useState(0)
  const confirmedMaterials = confirmed?.key === materialKey ? confirmed.materials : EMPTY_MATERIALS
  const restoredMaterials = restoredKey && restored?.key === restoredKey ? restored.materials : undefined

  const selected = selectedConversationId && conversations.find(item => item.conversationId === selectedConversationId)
  const draftIds = selectedConversationId ? pageController.personalStates[selectedConversationId]?.draft.referenceIds ?? [] : []
  const executionView = selectedConversationId ? pageController.execution.getView?.(selectedConversationId) : undefined
  const acceptedEntries = executionView?.entries ?? []
  const history = selected ? pageController.syncStates[selected.conversationId]?.messages ?? [] : []
  const historyEntries = selected && history.length
    ? decodeHistoryToTimelineEntries(history, { userId: selected.ownerUserId, displayName: resolveOwnerName(selected.ownerUserId) }) : []
  const ids = [...new Set([
    ...draftIds,
    ...[...historyEntries, ...acceptedEntries].flatMap(entry => entry.kind === "message" ? entry.referenceIds ?? [] : []),
  ])]
  const restoreKey = JSON.stringify(ids)

  useLayoutEffect(() => {
    const failure = executionView?.referenceFailure
    if (!referenceScope || !restoredKey || !failure) return
    setRestored(previous => {
      const next = new Map(previous?.key === restoredKey ? previous.materials : [])
      next.set(failure.id, { message: failure.message })
      return { key: restoredKey, materials: next }
    })
  }, [referenceScope, restoredKey, executionView?.referenceFailure])

  useEffect(() => {
    if (!host || !referenceScope || !restoredKey || !ids.length) return
    let active = true
    const origin = referenceScope
    const key = restoredKey
    for (const id of ids) {
      if (restoredMaterials?.get(id) && "snapshot" in restoredMaterials.get(id)!) continue
      void readFixedMaterial(host, origin, id, resolveOwnerName)
        .then(result => result.ok ? { snapshot: result.value } : { message: result.error.message })
        .catch(() => ({ message: "无法读取固定引用，请重试。" }))
        .then(value => {
          if (!active || currentOrigin.current !== origin) return
          setRestored(previous => {
            const next = new Map(previous?.key === key ? previous.materials : [])
            next.set(id, value)
            return { key, materials: next }
          })
        })
    }
    return () => { active = false }
  }, [host, referenceScope, restoredKey, restoreKey, retryRevision])

  function fixedMaterial(id: string): ConversationSnapshot | undefined {
    const record = restoredMaterials?.get(id)
    return record ? ("snapshot" in record ? record.snapshot : undefined) : confirmedMaterials.get(id)?.snapshot
  }

  const targets = referenceScope ? integration.listMyLocalConversations(referenceScope).map(item => ({
    id: item.conversationId,
    title: item.title || "未命名会话",
    directory: directories[item.conversationId],
  })) : []

  function canRead(origin: ReferenceScope, conversationId: string | undefined): conversationId is string {
    return currentOrigin.current === origin
      && Boolean(conversationId && integration.listProjectConversations(origin).some(item => item.conversationId === conversationId))
  }

  function matchesComposer(source: ConversationScope, target: ConversationProjectTarget): boolean {
    const origin = referenceScope
    return Boolean(origin && currentOrigin.current === origin
      && origin.namespace === source.namespace && origin.accountId === source.accountId
      && origin.workspaceId === source.workspaceId && origin.conversationId === source.conversationId
      && origin.projectId === target.projectId && origin.deviceId === target.deviceId)
  }

  const references = useConversationReferences(localDeviceId ? referenceScope : null, targets, {
    async readSnapshot(origin, request) {
      if (currentOrigin.current !== origin) return { ok: false, message: "发起范围已变化。" }
      if (host) {
        if (request.kind === "fixed") {
          const result = await readFixedMaterial(host, origin, request.referenceId, resolveOwnerName)
          if (!result.ok) return { ok: false, message: result.error.message }
          return result.value.archived ? { ok: false, message: "知识条目已归档，无法新增引用。" } : result
        }
        if (request.kind === "refresh") {
          const reference = parseFixedReference(request.referenceId)
          if (reference?.kind === "knowledge") {
            const result = await host.readKnowledge(origin.workspaceId, reference.knowledgeId)
            if (!result.ok) return { ok: false, message: result.error.message }
            return result.value.item.archived
              ? { ok: false, message: "知识条目已归档。" }
              : { ok: true, value: knowledgeMaterial(result.value.current, resolveOwnerName) }
          }
        }
        const source = request.kind === "preview" ? request.conversationId : fixedMaterial(request.referenceId)?.sourceConversationId
        if (!canRead(origin, source)) return { ok: false, message: "该会话的引用暂不可用。" }
        const brief = integration.listProjectConversations(origin).find(item => item.conversationId === source)
        const range = request.kind === "preview" ? request.range : undefined
        const fallback = brief?.syncedSequence === 0 && brief.briefText.trim() ? { type: "brief" as const } : undefined
        const result = await host.createSnapshot(origin.workspaceId, origin.projectId, {
          sourceConversationId: source,
          ...(range || fallback ? { range: range ?? fallback } : {}),
        })
        if (!canRead(origin, source)) return { ok: false, message: "该会话的引用暂不可用。" }
        return result.ok ? { ok: true, value: snapshotMaterial(result.value, resolveOwnerName) } : { ok: false, message: result.error.message }
      }
      const source = request.kind === "preview"
        ? request.conversationId : fixedMaterial(request.referenceId)?.sourceConversationId
      if (!readSnapshot || !canRead(origin, source)) return { ok: false, message: "该会话的引用暂不可用。" }
      const result = await readSnapshot(origin, request)
      if (!canRead(origin, source)) return { ok: false, message: "该会话的引用暂不可用。" }
      if (!result.ok) return result
      const known = fixedMaterial(result.value.id)
      if (known && known.sourceConversationId !== source) {
        return { ok: false, message: "快照标识与来源不匹配。" }
      }
      return { ok: true, value: known ?? { ...result.value, sourceConversationId: source } }
    },
    async chooseDirectory(origin) {
      if (currentOrigin.current !== origin) return { ok: false, message: "发起会话已变化。" }
      return { ok: true, value: await chooseDirectory() }
    },
    async applyDraft(origin, change) {
      if (currentOrigin.current !== origin) return { ok: false, message: "发起范围已变化。" }
      if (host && change.kind !== "remove") {
        const verified = await readFixedMaterial(host, origin, change.snapshot.id, resolveOwnerName)
        if (currentOrigin.current !== origin) return { ok: false, message: "发起范围已变化。" }
        if (!verified.ok) return verified.error.code === "RESOURCE_NOT_FOUND"
          ? { ok: false, materialUnavailable: true, message: verified.error.message }
          : { ok: false, message: verified.error.message }
        if (verified.value.archived) return { ok: false, materialUnavailable: true, message: "知识条目已归档，无法新增引用。" }
      }
      const draftChange: SessionReferenceDraftChange = change.kind === "add"
        ? { kind: "add", target: change.target, referenceIds: [change.snapshot.id], mention: change.mention }
        : change.kind === "replace"
          ? { kind: "replace", referenceId: change.referenceId, replacementId: change.snapshot.id }
          : change
      const result = await integration.applyReferenceDraft(origin, draftChange)
      if (result.ok && change.kind !== "remove" && currentOrigin.current === origin) {
        const snapshot = change.snapshot
        setConfirmed(previous => {
          const next = new Map(previous?.key === materialKey ? previous.materials : EMPTY_MATERIALS)
          next.set(snapshot.id, { snapshot })
          return { key: materialKey, origin, materials: next }
        })
      }
      return result
    },
    async locateConversation(origin, id) {
      const target = currentOrigin.current === origin
        ? integration.listMyLocalConversations(origin).find(item => item.conversationId === id)
        : undefined
      if (!target || !locateConversation(target)) return { ok: false, message: "无法打开目标会话，请重试定位。" }
      integration.revealReferenceDraft(origin, id)
      return { ok: true, value: null }
    },
    async openSource(origin, id) {
      const source = fixedMaterial(id)?.sourceConversationId
      const conversation = currentOrigin.current === origin
        ? integration.listProjectConversations(origin).find(item => item.conversationId === source)
        : undefined
      return conversation && locateConversation(conversation)
        ? { ok: true, value: null }
        : { ok: false, message: "来源会话暂不可用。" }
    },
  }, Boolean(host))

  function referenceView(id: string): ConversationReferenceView {
    const snapshot = fixedMaterial(id)
    if (snapshot) {
      const canOpen = conversations.some(item => item.conversationId === snapshot.sourceConversationId && item.projectId === scope?.projectId)
      return snapshotReferenceView(snapshot, { enabled: true }, canOpen)
    }
    const result = restoredMaterials?.get(id)
    const message = result && "message" in result ? result.message : undefined
    return {
      id, sourceLabel: message ? "引用不可用" : "正在读取引用", rangeLabel: "", snapshotText: "",
      status: message ? "unavailable" : "loading", message,
      actions: { open: { enabled: false }, refresh: { enabled: Boolean(message && host) }, remove: { enabled: true } },
    }
  }

  const hooks: SessionExternalHooks | undefined = referenceScope ? {
    async onRequestCollaborationCandidates(source, target, query) {
      if (!matchesComposer(source, target)) return { status: "unavailable", items: [], message: "发起会话已变化。" }
      const prefix = /^(会话|成员|任务|知识)(?:[\s:：]*)/.exec(query)
      const group = prefix?.[1]
      const search = query.slice(prefix?.[0].length ?? 0).toLocaleLowerCase()
      if (group === "知识") {
        if (!host) return { status: "unavailable", items: [], message: "团队知识暂不可用。" }
        const items = await readPages(
          afterId => host.listKnowledge(referenceScope.workspaceId, search, afterId),
          page => page.items, () => matchesComposer(source, target),
        )
        return { status: "ready", items: items.filter(item => !item.archived).map(item => ({
          kind: "knowledge", id: knowledgeReferenceId({ knowledgeId: item.knowledgeId, versionId: item.currentVersionId }),
          title: item.title, detail: item.category,
        })) }
      }
      const items: ConversationCollaborationCandidate[] = []
      if (!group || group === "会话") {
        items.push(...integration.listProjectConversations(referenceScope).map(item => ({
          kind: "conversation" as const, id: item.conversationId,
          title: item.title || "未命名会话", detail: resolveOwnerName(item.ownerUserId),
        })))
      }
      if (onChooseMember && (!group || group === "成员")) {
        items.push(...(members ?? []).map(item => ({ kind: "member" as const, id: item.id, title: item.name, detail: "" })))
      }
      if (onOpenTask && (!group || group === "任务")) {
        items.push(...(tasks ?? []).map(item => ({
          kind: "task" as const, id: item.taskId, title: item.title, detail: resolveOwnerName(item.assigneeId),
        })))
      }
      return { status: "ready", items: items.filter(item =>
        item.title.toLocaleLowerCase().includes(search) || item.detail.toLocaleLowerCase().includes(search)) }
    },
    onSelectCollaborationCandidate(source, target, candidate, mention) {
      if (matchesComposer(source, target) && mention.conversationId === referenceScope.conversationId) {
        if (candidate.kind === "conversation") references.previewConversation(candidate.id, mention)
        if (candidate.kind === "knowledge") references.previewFixed(candidate.id, mention)
        if (candidate.kind === "member" && members?.some(member => member.id === candidate.id)) onChooseMember?.(candidate.id)
        if (candidate.kind === "task" && tasks?.some(task => task.taskId === candidate.id)) onOpenTask?.(candidate.id)
      }
    },
    onQuoteConversation: localDeviceId ? conversation => {
      if (currentOrigin.current === referenceScope && conversation.conversationId === referenceScope.conversationId) {
        references.previewConversation(conversation.conversationId)
      }
    } : undefined,
    onReferenceAction(source, id, action) {
      if (action === "refresh" && !fixedMaterial(id) && matchesComposer(source, referenceScope)) {
        retryReads(revision => revision + 1)
      } else references.onReferenceAction(source, id, action)
    },
    references: draftIds.map(referenceView),
    renderHistoryReferences(entries) {
      return entries.flatMap<ConversationTimelineEntry>(entry => {
        if (entry.kind !== "message" || !entry.referenceIds?.length) return [entry]
        return [entry, {
          kind: "extension", id: `${entry.id}:references`,
          content: <div className="wb-composer-references" aria-label="消息引用">
            {entry.referenceIds.map(id => {
              const view = referenceView(id)
              return <details className="wb-composer-reference" key={id}>
                <summary>{view.sourceLabel} {view.rangeLabel}</summary>
                <pre className="conversation-reference-text">{view.snapshotText || view.message}</pre>
              </details>
            })}
          </div>,
        }]
      })
    },
    composerExtra: references.notice ? <p role="alert">{references.notice}</p> : undefined,
  } : undefined

  return {
    hooks,
    dialog: references.dialog,
    canReference: Boolean(referenceScope && localDeviceId),
    previewFixed: references.previewFixed,
    draftMaterials: draftIds.flatMap(id => {
      const material = fixedMaterial(id)
      return material ? [material] : []
    }),
  }
}
