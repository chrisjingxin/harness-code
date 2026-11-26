/**
 * 个人优先会话协同控制器 Hook：
 *
 * 【功能定义】
 * 1. 管理本机个人会话列表（`LocalConversationsHost.list/get/create/rename/updateWorkspace/updateBinding/markPublished/markSharingStopped`）；
 * 2. 维护新建个人会话草稿、冷启动 Agent 连通性预检（`agentPreflight`）、个人时间线阅读与输入框草稿持久化；
 * 3. 串联 `useLocalExecution` 与 `useLocalDirectory` 为未入团、多团队过滤与断网续用提供完整本机对话与右侧文件/Git 面板；
 * 4. 提供「发布到 Project…」（含预留的 `HC-249` 发布前本地脱敏检查钩子）与「停止共享」全链路协调能力。
 *
 * 【协作边界】严禁直接调用 Node/Electron；全部通过具名 Host 端口与 `PersonalPersistence` 通信。
 */
import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import type { AcpAgentList } from "@workbench/acp-runtime/types"
import type { ConversationShareMode, UserSummary } from "@workbench/collaboration-client/types"
import {
  MAX_SENT_IMAGE_RECORDS,
  localExecutionKey,
  type ConversationPersonal,
  type DesktopHost,
  type DesktopLocalExecutionHost,
  type LocalConversationDetail,
  type LocalConversationRecord,
  type LocalConversationsHost,
  type LocalConversationTurn,
  type LocalDirectoryHost,
  type LocalExecutionScope,
  type PersonalDraftImage,
  type ProjectConversationHost,
} from "../../../shared/index.js"
import { mergeAttachmentPaths } from "../../../ui/index.js"
import type {
  ConversationDraftImage,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationScope,
  RenderingActions,
  WorkbenchRightSlot,
} from "../../../ui/index.js"
import type { PersonalPersistence } from "../../personal-persistence.js"
import type { SessionCentralFilesState } from "../session/session-center.js"
import { SessionRightDock } from "../session/session-center.js"
import type { SessionExecutionScope } from "../session/contracts.js"
import { EMPTY_PERSONAL_STATE, applyConversationPersonalChange } from "../session/session-provider.js"
import { useLocalDirectory } from "../session/use-local-directory.js"
import { useLocalExecution } from "../session/use-local-execution.js"
import {
  conversationToMarkdown,
  groupPersonalRecordsByDirectory,
  localRecordToConversationSummary,
  localTurnsToTimelineEntries,
  makePersonalScopeKey,
  mergeLoadedPersonalRuntime,
  localTurnsBeforeLiveTail,
  partitionPersonalRecords,
  shouldPersistAgentTitle,
  type PersonalRuntimeState,
} from "./personal-sessions-model.js"
import type { PersonalNewSessionDraft } from "./personal-new-session-page.js"
import type { PublishConversationSubmitInput } from "./publish-conversation-dialog.js"

const PERSONAL_NAMESPACE = "desktop-personal"

/** 预留给后续 `HC-249` 接入发布前本地隐私/秘钥扫描检查的扩展钩子。 */
export type PrePublishGuardHook = (input: {
  readonly record: LocalConversationRecord
  readonly turns: readonly LocalConversationTurn[]
  readonly targetWorkspaceId: string
  readonly targetProjectId: string
  readonly shareMode: ConversationShareMode
}) => Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }>

export type UsePersonalSessionsOptions = {
  readonly host: DesktopHost
  readonly localConversations?: LocalConversationsHost
  readonly localDirectory?: LocalDirectoryHost
  readonly localExecution?: DesktopLocalExecutionHost
  readonly projectConversations: ProjectConversationHost
  readonly persistence: PersonalPersistence
  readonly user: UserSummary
  readonly activeSpace: "personal" | "team"
  readonly offline: boolean
  readonly prePublishHook?: PrePublishGuardHook
  readonly onPublished?: (result: {
    readonly conversationId: string
    readonly workspaceId: string
    readonly projectId: string
    readonly projectName: string
  }) => void
  readonly onStoppedSharing?: (result: {
    readonly conversationId: string
    readonly workspaceId: string | null
    readonly title: string
  }) => void
  readonly onOpenRightPanel?: () => void
  readonly onNotify?: (message: string) => void
}

type DetailEntry = {
  readonly status: "loading" | "ready" | "failed"
  readonly detail?: LocalConversationDetail
  readonly error?: string
}

const DEFAULT_PERSONAL_RUNTIME: PersonalRuntimeState = {
  loaded: false,
  loadedScopeKey: null,
  personal: EMPTY_PERSONAL_STATE,
  providerId: null,
}

function toPersistedImages(images: readonly ConversationDraftImage[] | undefined): readonly PersonalDraftImage[] {
  if (!images?.length) return []
  return images
    .filter(item => item.status !== "preparing")
    .map(({ id, name, mimeType, sizeBytes, width, height }) => ({
      id,
      name,
      mimeType,
      sizeBytes,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    }))
}

function boundSentImages(
  sentImages: Readonly<Record<string, readonly PersonalDraftImage[]>> | undefined,
): Readonly<Record<string, readonly PersonalDraftImage[]>> | undefined {
  if (!sentImages) return undefined
  const entries = Object.entries(sentImages).filter(([, list]) => list.length > 0)
  if (entries.length === 0) return undefined
  entries.sort((a, b) => Number(a[0]) - Number(b[0]))
  return Object.fromEntries(entries.slice(-MAX_SENT_IMAGE_RECORDS))
}

function restorePersonalFromSaved(
  saved: ConversationPersonal | null,
  loadedScopeKey: string,
  fallbackProviderId: string | null,
): PersonalRuntimeState {
  if (!saved) {
    return {
      loaded: true,
      loadedScopeKey,
      personal: EMPTY_PERSONAL_STATE,
      providerId: fallbackProviderId,
    }
  }
  return {
    loaded: true,
    loadedScopeKey,
    providerId: saved.providerId ?? fallbackProviderId,
    ...(saved.sentImages ? { sentImages: saved.sentImages } : {}),
    personal: {
      scroll: saved.scroll,
      expandedTools: [...saved.expandedTools],
      expandedOutputs: [...saved.expandedOutputs],
      draft: {
        ...saved.draft,
        annotations: Array.isArray(saved.draft.annotations) ? [...saved.draft.annotations] : [],
        images: Array.isArray(saved.draft.images) ? [...saved.draft.images] : [],
      },
      interactions: {},
    },
  }
}

function toPersistablePersonal(
  runtime: PersonalRuntimeState,
  record: LocalConversationRecord | undefined,
): ConversationPersonal {
  const { interactions: _ignored, ...rest } = runtime.personal
  const boundedSent = boundSentImages(runtime.sentImages)
  return {
    ...rest,
    draft: {
      ...rest.draft,
      images: toPersistedImages(rest.draft.images),
    },
    localDirectoryPath: record?.directoryPath ?? null,
    ...(runtime.providerId ?? record?.providerId ? { providerId: runtime.providerId ?? record?.providerId } : {}),
    ...(boundedSent ? { sentImages: boundedSent } : {}),
    syncCache: null,
  }
}

function deriveTitle(text: string): string {
  const first = text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? ""
  const normalized = first.replace(/\s+/g, " ").trim()
  if (!normalized) return "新会话"
  return normalized.length > 48 ? `${normalized.slice(0, 48)}…` : normalized
}

export function usePersonalSessions(options: UsePersonalSessionsOptions) {
  const {
    host,
    localConversations,
    localDirectory,
    localExecution,
    projectConversations,
    persistence,
    user,
    activeSpace,
    offline,
    prePublishHook,
    onPublished,
    onStoppedSharing,
    onOpenRightPanel,
    onNotify,
  } = options

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const [records, setRecords] = useState<readonly LocalConversationRecord[]>([])
  const recordsRef = useRef(records)
  recordsRef.current = records
  const titleActivityRef = useRef(new Set<string>())
  const lastAgentTitleRef = useRef(new Map<string, string>())
  const renameConversationRef = useRef<((conversationId: string, title: string) => Promise<string | null>) | null>(null)

  const [listStatus, setListStatus] = useState<"loading" | "ready" | "failed">(
    localConversations ? "loading" : "ready",
  )
  const [listError, setListError] = useState("")
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [detailsById, setDetailsById] = useState<Readonly<Record<string, DetailEntry>>>({})
  const [personalRuntimes, setPersonalRuntimes] = useState<Readonly<Record<string, PersonalRuntimeState>>>({})
  const personalRuntimesRef = useRef(personalRuntimes)
  personalRuntimesRef.current = personalRuntimes
  const personalLoadInFlightRef = useRef(new Map<string, Promise<PersonalRuntimeState | null>>())

  const [agentTitles, setAgentTitles] = useState<Readonly<Record<string, string>>>({})
  const [checkingProviders, setCheckingProviders] = useState(false)
  const [preflightProviders, setPreflightProviders] = useState<AcpAgentList | undefined>(undefined)

  const [newDraft, setNewDraft] = useState<PersonalNewSessionDraft>({
    directoryPath: null,
    draftText: "",
    providerId: null,
    revision: 0,
    selectionStart: 0,
    selectionEnd: 0,
  })

  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [directorySelectionRevision, setDirectorySelectionRevision] = useState(0)
  const [publishDialogConvId, setPublishDialogConvId] = useState<string | null>(null)
  const [stopSharingTarget, setStopSharingTarget] = useState<{
    readonly conversationId: string
    readonly workspaceId?: string
    readonly projectId?: string
    readonly title?: string
    readonly projectName?: string | null
  } | null>(null)
  const stopSharingDialogConvId = stopSharingTarget?.conversationId ?? null

  const pendingAutoSendRef = useRef<{
    readonly conversationId: string
    readonly directoryPath: string
    readonly draftRevision: number
    readonly text: string
  } | null>(null)

  const reloadList = useCallback(async () => {
    if (!localConversations) {
      setRecords([])
      setListStatus("ready")
      return
    }
    const res = await localConversations.list({ includePublished: true }).catch(() => null)
    if (!mountedRef.current) return
    if (!res) {
      setListStatus("failed")
      setListError("无法读取本机个人会话列表。")
      return
    }
    if (!res.ok) {
      setListStatus("failed")
      setListError(res.error.message)
      return
    }
    setRecords(res.value)
    setListStatus("ready")
    setListError("")
  }, [localConversations])

  const loadDetail = useCallback(async (conversationId: string): Promise<LocalConversationDetail | null> => {
    if (!localConversations) return null
    setDetailsById(prev => (
      prev[conversationId]?.status === "ready"
        ? prev
        : { ...prev, [conversationId]: { status: "loading" } }
    ))
    const res = await localConversations.get(conversationId).catch(() => null)
    if (!mountedRef.current) return null
    if (!res || !res.ok) {
      setDetailsById(prev => ({
        ...prev,
        [conversationId]: { status: "failed", error: res ? res.error.message : "无法读取会话记录。" },
      }))
      return null
    }
    setDetailsById(prev => ({
      ...prev,
      [conversationId]: { status: "ready", detail: res.value },
    }))
    // 同步索引记录的最新状态（例如 syncedSequence / status / title 更新）
    setRecords(prev => {
      const idx = prev.findIndex(item => item.conversationId === conversationId)
      if (idx < 0) return [res.value.record, ...prev]
      const copy = [...prev]
      copy[idx] = res.value.record
      return copy
    })
    return res.value
  }, [localConversations])

  useEffect(() => {
    void reloadList()
  }, [reloadList, user.id])

  // 订阅主进程落盘通知（例如一轮完成后 appendTurn 写盘），确保个人会话轮次列表与发布弹窗摘要实时最新。
  useEffect(() => {
    const unsubscribe = localConversations?.onChanged?.(event => {
      void reloadList()
      void loadDetail(event.conversationId)
    })
    return () => { unsubscribe?.() }
  }, [localConversations, reloadList, loadDetail])

  const ensurePersonalRuntimeLoaded = useCallback(async (record: LocalConversationRecord): Promise<PersonalRuntimeState | null> => {
    const scopeKey = makePersonalScopeKey(record)
    const existing = personalRuntimesRef.current[record.conversationId]
    if (existing?.loaded && existing.loadedScopeKey === scopeKey) return existing
    const flightKey = `${record.conversationId}:${scopeKey}`
    const inFlight = personalLoadInFlightRef.current.get(flightKey)
    if (inFlight) return inFlight

    const promise = (async (): Promise<PersonalRuntimeState | null> => {
      const res = await persistence.load({
        kind: "conversation",
        workspaceId: record.workspaceId,
        projectId: record.projectId,
        conversationId: record.conversationId,
      })
      if (!mountedRef.current || !res.ok) return null
      const loaded = restorePersonalFromSaved(
        res.value.data as ConversationPersonal | null,
        scopeKey,
        record.providerId,
      )
      const merged = mergeLoadedPersonalRuntime(personalRuntimesRef.current[record.conversationId], loaded)
      const nextMap = { ...personalRuntimesRef.current, [record.conversationId]: merged.runtime }
      personalRuntimesRef.current = nextMap
      setPersonalRuntimes(nextMap)
      if (merged.needsPersist) {
        persistence.save(
          {
            kind: "conversation",
            workspaceId: record.workspaceId,
            projectId: record.projectId,
            conversationId: record.conversationId,
          },
          toPersistablePersonal(merged.runtime, record),
        )
      }
      return merged.runtime
    })().finally(() => {
      if (personalLoadInFlightRef.current.get(flightKey) === promise) {
        personalLoadInFlightRef.current.delete(flightKey)
      }
    })
    personalLoadInFlightRef.current.set(flightKey, promise)
    return promise
  }, [persistence])

  const mutatePersonalRuntime = useCallback((
    record: LocalConversationRecord,
    updater: (prev: PersonalRuntimeState) => PersonalRuntimeState,
    persist = true,
  ) => {
    const prev = personalRuntimesRef.current[record.conversationId] ?? DEFAULT_PERSONAL_RUNTIME
    const next = updater(prev)
    const nextMap = { ...personalRuntimesRef.current, [record.conversationId]: next }
    personalRuntimesRef.current = nextMap
    setPersonalRuntimes(nextMap)
    if (persist && next.loaded && next.loadedScopeKey === makePersonalScopeKey(record)) {
      persistence.save(
        {
          kind: "conversation",
          workspaceId: record.workspaceId,
          projectId: record.projectId,
          conversationId: record.conversationId,
        },
        toPersistablePersonal(next, record),
      )
    }
  }, [persistence])

  useEffect(() => {
    if (!selectedConversationId || activeSpace !== "personal") return
    void loadDetail(selectedConversationId)
  }, [selectedConversationId, activeSpace, loadDetail])

  // 当发布或停止共享弹窗针对任意会话打开时，按需加载其已定稿历史轮次以便摘要/历史范围准确预览。
  const modalConversationId = publishDialogConvId ?? stopSharingDialogConvId
  useEffect(() => {
    if (!modalConversationId) return
    void loadDetail(modalConversationId)
  }, [modalConversationId, loadDetail])

  const selectedRecord = useMemo(
    () => (selectedConversationId ? records.find(item => item.conversationId === selectedConversationId) ?? null : null),
    [records, selectedConversationId],
  )
  useEffect(() => {
    if (!selectedRecord || activeSpace !== "personal") return
    void ensurePersonalRuntimeLoaded(selectedRecord)
  }, [selectedRecord, activeSpace, ensurePersonalRuntimeLoaded])
  const selectedDetailEntry = selectedConversationId ? detailsById[selectedConversationId] : undefined
  const selectedDetail = selectedDetailEntry?.detail

  const executionScope = useMemo<SessionExecutionScope | null>(() => {
    if (activeSpace !== "personal" || !selectedRecord) return null
    return {
      namespace: PERSONAL_NAMESPACE,
      accountId: user.id,
      workspaceId: selectedRecord.workspaceId,
      projectId: selectedRecord.projectId,
    }
  }, [activeSpace, selectedRecord, user.id])

  const preferredProviders = useMemo(() => {
    const map: Record<string, string> = {}
    for (const rec of records) {
      const runtimeProvider = personalRuntimes[rec.conversationId]?.providerId
      const chosen = runtimeProvider || rec.providerId
      if (chosen) map[rec.conversationId] = chosen
    }
    return map
  }, [records, personalRuntimes])

  const onExecutionAccepted = useCallback((source: SessionExecutionScope, conversationId: string, revision: number) => {
    const rec = recordsRef.current.find(item => item.conversationId === conversationId)
    if (!rec || source.accountId !== user.id) return
    titleActivityRef.current.add(conversationId)
    mutatePersonalRuntime(rec, prev => ({
      ...prev,
      personal: applyConversationPersonalChange(prev.personal, { kind: "clear-draft", expectedRevision: revision }),
    }), true)
  }, [user.id, mutatePersonalRuntime])

  const localDir = useLocalDirectory({
    localDirectory,
    persistence,
    scope: executionScope,
    selectedConversationId: activeSpace === "personal" ? selectedConversationId : null,
    selectedDirectoryPath: selectedRecord?.directoryPath ?? null,
    selectedIsLocal: Boolean(selectedRecord),
  })

  const refreshWorkspaceRef = useRef<((source: SessionExecutionScope, id: string) => Promise<void>) | null>(null)
  refreshWorkspaceRef.current = localDir.refreshWorkspace
  const onExecutionWorkspaceRefresh = useCallback((source: SessionExecutionScope, conversationId: string) => {
    if (!mountedRef.current) return
    void refreshWorkspaceRef.current?.(source, conversationId)
  }, [])

  const onExecutionSessionTitleChange = useCallback((scope: LocalExecutionScope, title: string | undefined) => {
    if (!mountedRef.current) return
    const key = localExecutionKey(scope)
    if (title) {
      const previousAgentTitle = lastAgentTitleRef.current.get(key)
      lastAgentTitleRef.current.set(key, title)
      const rec = recordsRef.current.find(item => item.conversationId === scope.conversationId)
      if (shouldPersistAgentTitle({
        title,
        previousAgentTitle,
        hadActivity: titleActivityRef.current.has(scope.conversationId),
        recordTitle: rec?.title,
      })) {
        void renameConversationRef.current?.(scope.conversationId, title).catch(() => {})
      }
    }
    setAgentTitles(prev => {
      if (!title) {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      }
      return prev[key] === title ? prev : { ...prev, [key]: title }
    })
  }, [])

  const onExecutionProviderChange = useCallback((scope: LocalExecutionScope, providerId: string) => {
    const rec = recordsRef.current.find(item => item.conversationId === scope.conversationId)
    if (!rec) return
    mutatePersonalRuntime(rec, prev => (prev.providerId === providerId ? prev : { ...prev, providerId }), true)
  }, [mutatePersonalRuntime])

  const onExecutionTurnUploaded = useCallback((
    scope: LocalExecutionScope,
    userSequence: number,
    images: readonly PersonalDraftImage[],
  ) => {
    const rec = recordsRef.current.find(item => item.conversationId === scope.conversationId)
    if (!rec || !images.length || userSequence < 1) return
    mutatePersonalRuntime(rec, prev => {
      const merged = boundSentImages({
        ...(prev.sentImages ?? {}),
        [String(userSequence)]: images,
      })
      return { ...prev, ...(merged ? { sentImages: merged } : {}) }
    }, true)
  }, [mutatePersonalRuntime])

  const localExecutionPortRef = useRef<ReturnType<typeof useLocalExecution>>(undefined)
  const onExecutionTurnFinished = useCallback((scope: LocalExecutionScope) => {
    if (!mountedRef.current) return
    void loadDetail(scope.conversationId)
  }, [loadDetail])

  const onExecutionSharingStopped = useCallback((scope: LocalExecutionScope) => {
    if (!mountedRef.current) return
    void reloadList()
    void loadDetail(scope.conversationId)
  }, [reloadList, loadDetail])

  const localExecutionPort = useLocalExecution(
    localExecution,
    executionScope,
    activeSpace === "personal" ? selectedConversationId : null,
    selectedRecord?.directoryPath ?? null,
    directorySelectionRevision,
    user.userName || "我",
    onExecutionAccepted,
    onExecutionWorkspaceRefresh,
    preferredProviders,
    onExecutionSessionTitleChange,
    onExecutionProviderChange,
    onExecutionTurnUploaded,
    onExecutionTurnFinished,
    onExecutionSharingStopped,
  )
  localExecutionPortRef.current = localExecutionPort

  // 切回个人空间或选中会话后若磁盘存在新轮次（例如在团队空间发出的一轮），清空可能乱序的旧内存缓存由磁盘权威序列重绘。
  useEffect(() => {
    if (activeSpace !== "personal" || !selectedConversationId || !localExecutionPort?.clearEntries) return
    localExecutionPort.clearEntries(selectedConversationId)
    void loadDetail(selectedConversationId)
  }, [activeSpace, selectedConversationId])

  const refreshProviders = useCallback(async () => {
    setCheckingProviders(true)
    try {
      if (localExecutionPortRef.current?.refreshProviders) {
        const res = await localExecutionPortRef.current.refreshProviders()
        if (mountedRef.current && res) setPreflightProviders(res)
      } else if (localExecution?.listProviders) {
        const res = await localExecution.listProviders()
        if (mountedRef.current && res.ok) setPreflightProviders(res.value)
      }
    } finally {
      if (mountedRef.current) setCheckingProviders(false)
    }
  }, [localExecution])

  useEffect(() => {
    const portProviders = localExecutionPort?.getProviders?.()
    if (portProviders) {
      setPreflightProviders(portProviders)
      return
    }
    if (localExecution?.listProviders && !preflightProviders) {
      void refreshProviders()
    }
  }, [localExecutionPort, localExecution, preflightProviders, refreshProviders])

  const selectedAvailability = selectedRecord && executionScope
    ? localExecutionPort?.getAvailability(selectedRecord.conversationId)
    : undefined

  useEffect(() => {
    const pending = pendingAutoSendRef.current
    if (!pending || !selectedRecord || !executionScope) return
    if (pending.conversationId !== selectedRecord.conversationId) return
    if (!localExecutionPort?.send || !selectedAvailability?.available) return
    pendingAutoSendRef.current = null
    void localExecutionPort.send({
      scope: executionScope,
      conversationId: selectedRecord.conversationId,
      directoryPath: pending.directoryPath,
      draftRevision: pending.draftRevision,
      text: pending.text,
      referenceIds: [],
      attachmentIds: [],
    })
  }, [selectedRecord, executionScope, localExecutionPort, selectedAvailability?.available])

  // 个人栏位展示所有未处于 active 共享态的个人会话：置顶区与已归档区独立列出，其余按工程目录折叠分组（不按团队筛选）。
  const personalPartition = useMemo(() => {
    const { pinned, personal, archived, publishedCount } = partitionPersonalRecords(records)
    return {
      pinned,
      personal,
      archived,
      publishedCount,
      groups: groupPersonalRecordsByDirectory(personal),
    }
  }, [records])

  const chooseNewDirectory = useCallback(() => {
    void host.chooseDirectory().then(picked => {
      if (!picked || !mountedRef.current) return
      setNewDraft(prev => ({ ...prev, directoryPath: picked, revision: prev.revision + 1 }))
      setCreateError(null)
    }).catch(() => {})
  }, [host])

  const startNewPersonalSession = useCallback(async () => {
    if (!localConversations || createBusy) return
    const directoryPath = newDraft.directoryPath?.trim()
    const text = newDraft.draftText.trim()
    if (!directoryPath) {
      setCreateError("请先选择一个本机工作目录。")
      return
    }
    if (!text) {
      setCreateError("请输入你想与 Agent 对话的内容。")
      return
    }
    setCreateBusy(true)
    setCreateError(null)
    try {
      const providerId = newDraft.providerId
        ?? preflightProviders?.defaultProviderId
        ?? preflightProviders?.providers.find(p => p.available)?.id
        ?? null
      const res = await localConversations.create({
        workspaceId: null,
        title: deriveTitle(text),
        directoryPath,
        ...(providerId ? { providerId } : {}),
      })
      if (!mountedRef.current) return
      if (!res.ok) {
        setCreateError(res.error.message)
        return
      }
      const created = res.value
      // 新建会话必须先向 PersonalPersistence 完成首次 load 登记，否则随后的 save 会被静默丢弃。
      const loadRes = await persistence.load({
        kind: "conversation",
        workspaceId: created.workspaceId,
        projectId: created.projectId,
        conversationId: created.conversationId,
      }).catch(() => null)
      if (!mountedRef.current) return
      const createdScopeKey = makePersonalScopeKey(created)
      setRecords(prev => [created, ...prev.filter(item => item.conversationId !== created.conversationId)])
      setDetailsById(prev => ({
        ...prev,
        [created.conversationId]: {
          status: "ready",
          detail: { record: created, nextSequence: 1, turns: [] },
        },
      }))
      const draftRevision = 1
      mutatePersonalRuntime(created, () => ({
        loaded: Boolean(loadRes?.ok),
        loadedScopeKey: loadRes?.ok ? createdScopeKey : null,
        providerId: created.providerId,
        personal: {
          ...EMPTY_PERSONAL_STATE,
          draft: {
            ...EMPTY_PERSONAL_STATE.draft,
            text: newDraft.draftText,
            selectionStart: newDraft.selectionStart,
            selectionEnd: newDraft.selectionEnd,
            revision: draftRevision,
          },
        },
      }), true)
      pendingAutoSendRef.current = {
        conversationId: created.conversationId,
        directoryPath,
        draftRevision,
        text: newDraft.draftText,
      }
      setDirectorySelectionRevision(v => v + 1)
      setSelectedConversationId(created.conversationId)
      setNewDraft(prev => ({
        ...prev,
        draftText: "",
        selectionStart: 0,
        selectionEnd: 0,
        revision: prev.revision + 1,
      }))
    } finally {
      if (mountedRef.current) setCreateBusy(false)
    }
  }, [localConversations, createBusy, newDraft, preflightProviders, mutatePersonalRuntime])

  const renameConversation = useCallback(async (conversationId: string, title: string): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    const res = await localConversations.rename(conversationId, title).catch(() => null)
    if (!res) return "保存会话标题失败，请重试。"
    if (!res.ok) return res.error.message
    if (mountedRef.current) {
      setRecords(prev => prev.map(item => (item.conversationId === conversationId ? res.value : item)))
      setDetailsById(prev => {
        const existing = prev[conversationId]
        if (!existing?.detail) return prev
        return {
          ...prev,
          [conversationId]: { ...existing, detail: { ...existing.detail, record: res.value } },
        }
      })
    }
    return null
  }, [localConversations])
  renameConversationRef.current = renameConversation

  const chooseSessionDirectory = useCallback((conversationId: string) => {
    if (!localConversations) return
    void host.chooseDirectory().then(async picked => {
      if (!picked || !mountedRef.current) return
      const res = await localConversations.updateBinding(conversationId, { directoryPath: picked }).catch(() => null)
      if (!res?.ok || !mountedRef.current) return
      setRecords(prev => prev.map(item => (item.conversationId === conversationId ? res.value : item)))
      setDetailsById(prev => {
        const existing = prev[conversationId]
        if (!existing?.detail) return prev
        return {
          ...prev,
          [conversationId]: { ...existing, detail: { ...existing.detail, record: res.value } },
        }
      })
      setDirectorySelectionRevision(v => v + 1)
    }).catch(() => {})
  }, [host, localConversations])

  const selectSessionDirectory = useCallback((conversationId: string, directoryPath: string) => {
    if (!localConversations || !directoryPath.trim()) return
    void localConversations.updateBinding(conversationId, { directoryPath }).then(res => {
      if (!res.ok || !mountedRef.current) return
      setRecords(prev => prev.map(item => (item.conversationId === conversationId ? res.value : item)))
      setDetailsById(prev => {
        const existing = prev[conversationId]
        if (!existing?.detail) return prev
        return {
          ...prev,
          [conversationId]: { ...existing, detail: { ...existing.detail, record: res.value } },
        }
      })
      setDirectorySelectionRevision(v => v + 1)
    }).catch(() => {})
  }, [localConversations])

  /** 将宿主返回的最新记录写回列表与详情缓存（与 renameConversation 同步记录的方式一致）。 */
  const applyUpdatedRecord = useCallback((record: LocalConversationRecord) => {
    setRecords(prev => prev.map(item => (item.conversationId === record.conversationId ? record : item)))
    setDetailsById(prev => {
      const existing = prev[record.conversationId]
      if (!existing?.detail) return prev
      return {
        ...prev,
        [record.conversationId]: { ...existing, detail: { ...existing.detail, record } },
      }
    })
  }, [])

  /** 会话被删除后按 Spec 第 8 节清理列表、详情与个人运行时缓存，选中项被删时回到新建页。 */
  const removeConversationsFromState = useCallback((conversationIds: readonly string[]) => {
    const idSet = new Set(conversationIds)
    setRecords(prev => prev.filter(item => !idSet.has(item.conversationId)))
    setDetailsById(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of conversationIds) {
        if (id in next) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
    const nextRuntimes = { ...personalRuntimesRef.current }
    let runtimeChanged = false
    for (const id of conversationIds) {
      if (id in nextRuntimes) {
        delete nextRuntimes[id]
        runtimeChanged = true
      }
    }
    if (runtimeChanged) {
      personalRuntimesRef.current = nextRuntimes
      setPersonalRuntimes(nextRuntimes)
    }
    setSelectedConversationId(current => (current && idSet.has(current) ? null : current))
    setCreateError(null)
  }, [])

  /** 渲染层判断运行中：仅依据索引记录 `status`，真正的拦截以主进程返回错误为准。 */
  const isRecordRunning = (record: LocalConversationRecord | undefined): boolean =>
    record?.status === "running" || record?.status === "waiting_approval"

  const pinConversation = useCallback(async (conversationId: string, pinned: boolean): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    const res = await localConversations.setPinned(conversationId, pinned).catch(() => null)
    if (!res) {
      onNotify?.(pinned ? "会话置顶失败，请重试。" : "取消置顶失败，请重试。")
      return pinned ? "会话置顶失败，请重试。" : "取消置顶失败，请重试。"
    }
    if (!res.ok) {
      onNotify?.(res.error.message)
      return res.error.message
    }
    if (mountedRef.current) applyUpdatedRecord(res.value)
    return null
  }, [localConversations, applyUpdatedRecord, onNotify])

  const archiveConversation = useCallback(async (conversationId: string): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    const res = await localConversations.setArchived(conversationId, true).catch(() => null)
    if (!res || !res.ok) {
      const message = !res ? "归档会话失败，请重试。" : res.error.message
      onNotify?.(message)
      return message
    }
    if (mountedRef.current) applyUpdatedRecord(res.value)
    onNotify?.(`已归档「${res.value.title || "新会话"}」`)
    return null
  }, [localConversations, applyUpdatedRecord, onNotify])

  const restoreConversation = useCallback(async (conversationId: string): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    const res = await localConversations.setArchived(conversationId, false).catch(() => null)
    if (!res || !res.ok) {
      const message = !res ? "取消归档失败，请重试。" : res.error.message
      onNotify?.(message)
      return message
    }
    if (mountedRef.current) applyUpdatedRecord(res.value)
    return null
  }, [localConversations, applyUpdatedRecord, onNotify])

  const deleteConversation = useCallback(async (conversationId: string): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    const title = recordsRef.current.find(item => item.conversationId === conversationId)?.title
    const res = await localConversations.remove(conversationId).catch(() => null)
    if (!res || !res.ok) {
      const message = !res ? "删除会话失败，请重试。" : res.error.message
      onNotify?.(message)
      return message
    }
    if (mountedRef.current) removeConversationsFromState([conversationId])
    onNotify?.(`已删除「${title || "新会话"}」`)
    return null
  }, [localConversations, removeConversationsFromState, onNotify])

  /**
   * 逐条串行归档一组会话（Spec 第 7 节）：跳过已归档 / active / 运行中会话，
   * 单个失败不中断其余项，结束后汇总提示，全部失败时返回首条失败原因。
   */
  const archiveConversations = useCallback(async (conversationIds: readonly string[]): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    let done = 0
    let skipped = 0
    let failed = 0
    let firstError: string | null = null
    for (const conversationId of conversationIds) {
      const record = recordsRef.current.find(item => item.conversationId === conversationId)
      if (!record || record.archivedAtMs !== undefined || record.shareStatus === "active" || isRecordRunning(record)) {
        skipped += 1
        continue
      }
      const res = await localConversations.setArchived(conversationId, true).catch(() => null)
      if (res?.ok) {
        done += 1
      } else {
        failed += 1
        if (!firstError) firstError = res ? res.error.message : "归档会话失败，请重试。"
      }
    }
    if (mountedRef.current) await reloadList()
    if (failed === conversationIds.length && conversationIds.length > 0) {
      onNotify?.(firstError ?? "归档会话失败，请重试。")
      return firstError ?? "归档会话失败，请重试。"
    }
    const summary = `已归档 ${done} 条${skipped ? `，跳过 ${skipped} 条` : ""}${failed ? `，失败 ${failed} 条` : ""}`
    onNotify?.(summary)
    return null
  }, [localConversations, reloadList, onNotify])

  /**
   * 逐条串行删除一组会话（Spec 第 7 节）：跳过 active / 已停止共享 / 运行中会话，
   * 成功的条目从列表、详情与个人运行时缓存移除，选中项被删时回到新建页。
   */
  const deleteConversations = useCallback(async (conversationIds: readonly string[]): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    let done = 0
    let skipped = 0
    let failed = 0
    let firstError: string | null = null
    const deletedIds: string[] = []
    for (const conversationId of conversationIds) {
      const record = recordsRef.current.find(item => item.conversationId === conversationId)
      if (!record || record.shareStatus !== "local_only" || isRecordRunning(record)) {
        skipped += 1
        continue
      }
      const res = await localConversations.remove(conversationId).catch(() => null)
      if (res?.ok) {
        done += 1
        deletedIds.push(conversationId)
      } else {
        failed += 1
        if (!firstError) firstError = res ? res.error.message : "删除会话失败，请重试。"
      }
    }
    if (deletedIds.length && mountedRef.current) removeConversationsFromState(deletedIds)
    if (mountedRef.current) await reloadList()
    if (failed === conversationIds.length && conversationIds.length > 0) {
      onNotify?.(firstError ?? "删除会话失败，请重试。")
      return firstError ?? "删除会话失败，请重试。"
    }
    const summary = `已删除 ${done} 条${skipped ? `，跳过 ${skipped} 条` : ""}${failed ? `，失败 ${failed} 条` : ""}`
    onNotify?.(summary)
    return null
  }, [localConversations, removeConversationsFromState, reloadList, onNotify])

  const copyConversationMarkdown = useCallback(async (conversationId: string): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    const res = await localConversations.get(conversationId).catch(() => null)
    if (!res || !res.ok) {
      const message = !res ? "读取会话内容失败，请重试。" : res.error.message
      onNotify?.(message)
      return message
    }
    const markdown = conversationToMarkdown(
      res.value.record.title || "新会话",
      res.value.turns,
      { historyTrimmed: res.value.historyTrimmed },
    )
    const copied = await host.copyText(markdown).then(() => true).catch(() => false)
    if (!copied) {
      onNotify?.("复制到剪贴板失败，请重试。")
      return "复制到剪贴板失败，请重试。"
    }
    onNotify?.("已复制为 Markdown")
    return null
  }, [localConversations, host, onNotify])

  const copyDirectoryPath = useCallback(async (conversationId: string): Promise<string | null> => {
    const directoryPath = recordsRef.current.find(item => item.conversationId === conversationId)?.directoryPath?.trim()
    if (!directoryPath) {
      onNotify?.("该会话尚未绑定工作目录。")
      return "该会话尚未绑定工作目录。"
    }
    const copied = await host.copyText(directoryPath).then(() => true).catch(() => false)
    if (!copied) {
      onNotify?.("复制目录路径失败，请重试。")
      return "复制目录路径失败，请重试。"
    }
    onNotify?.("已复制目录路径")
    return null
  }, [host, onNotify])

  const revealDirectory = useCallback(async (conversationId: string): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    const res = await localConversations.revealDirectory(conversationId).catch(() => null)
    if (!res || !res.ok) {
      const message = !res ? "无法打开该目录。" : res.error.message
      onNotify?.(message)
      return message
    }
    return null
  }, [localConversations, onNotify])

  const appendLocalAttachments = useCallback((conversationId: string, choose: () => Promise<readonly string[]>) => {
    const rec = recordsRef.current.find(item => item.conversationId === conversationId)
    if (!rec) return
    void choose().then(picked => {
      if (!picked.length || !mountedRef.current) return
      mutatePersonalRuntime(rec, prev => ({
        ...prev,
        personal: applyConversationPersonalChange(prev.personal, {
          kind: "draft-attachments",
          attachmentIds: mergeAttachmentPaths(prev.personal.draft.attachmentIds, picked),
        }),
      }), true)
    }).catch(() => {})
  }, [mutatePersonalRuntime])

  const onPersonalChange = useCallback((scope: ConversationScope, change: ConversationPersonalChange) => {
    const rec = recordsRef.current.find(item => item.conversationId === scope.conversationId)
    if (!rec) return
    mutatePersonalRuntime(rec, prev => ({
      ...prev,
      personal: applyConversationPersonalChange(prev.personal, change),
    }), true)
  }, [mutatePersonalRuntime])

  const publishConversation = useCallback(async (
    conversationId: string,
    input: PublishConversationSubmitInput,
  ): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    if (offline) return "协作服务当前离线，无法发布到项目。"
    const detailRes = await localConversations.get(conversationId).catch(() => null)
    if (!detailRes?.ok) return detailRes ? detailRes.error.message : "无法读取会话详情。"
    const { record, turns } = detailRes.value
    if (prePublishHook) {
      const check = await prePublishHook({
        record,
        turns,
        targetWorkspaceId: input.workspaceId,
        targetProjectId: input.projectId,
        shareMode: input.shareMode,
      })
      if (!check.allowed) return check.reason
    }
    const regRes = await projectConversations.registerConversation(input.workspaceId, input.projectId, {
      conversationId,
      title: record.title || "未命名会话",
      shareMode: input.shareMode,
      ...(input.initialBrief
        ? { initialBrief: { status: record.status, briefText: input.initialBrief, briefSource: "rule" } }
        : {}),
      requestId: crypto.randomUUID(),
    }).catch(() => null)
    if (!regRes) return "向协作服务登记会话失败，请重试。"
    if (!regRes.ok) return regRes.error.message

    const markRes = await localConversations.markPublished(conversationId, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      shareMode: input.shareMode,
      syncedSequence: regRes.value.conversation.syncedSequence,
      ...(input.shareMode === "full" && input.historyFromTurnIndex !== undefined
        ? { historyFromTurnIndex: input.historyFromTurnIndex }
        : {}),
    }).catch(() => null)
    if (!markRes || !markRes.ok) {
      return markRes ? markRes.error.message : "本地发布状态更新失败，请重试。"
    }
    await persistence.flush().catch(() => false)
    await reloadList()
    await loadDetail(conversationId)
    onNotify?.(`已发布到「${input.projectName}」· 已切换至团队空间`)
    onPublished?.({
      conversationId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectName: input.projectName,
    })
    return null
  }, [
    localConversations,
    offline,
    prePublishHook,
    projectConversations,
    reloadList,
    loadDetail,
    onNotify,
    onPublished,
    persistence,
  ])

  const stopConversationSharing = useCallback(async (conversationId: string): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    if (offline) return "协作服务当前离线，无法执行停止共享。"
    let record = recordsRef.current.find(item => item.conversationId === conversationId) ?? null
    if (!record) {
      const detailRes = await localConversations.get(conversationId).catch(() => null)
      if (detailRes?.ok) record = detailRes.value.record
    }
    const targetWorkspaceId = record?.workspaceId ?? stopSharingTarget?.workspaceId ?? null
    const targetProjectId = record?.projectId ?? stopSharingTarget?.projectId ?? null
    if (!targetWorkspaceId || !targetProjectId) {
      return "该会话当前未关联已发布项目。"
    }
    const remoteRes = await projectConversations.stopSharing(targetWorkspaceId, targetProjectId, conversationId)
      .catch(() => null)
    if (!remoteRes) return "停止共享请求未到达服务端，请重试。"
    if (!remoteRes.ok) return remoteRes.error.message

    if (!record) {
      await localConversations.create({
        conversationId,
        workspaceId: targetWorkspaceId,
        title: remoteRes.value.conversation.title || stopSharingTarget?.title || "新会话",
      }).catch(() => null)
      await localConversations.markPublished(conversationId, {
        workspaceId: targetWorkspaceId,
        projectId: targetProjectId,
        shareMode: remoteRes.value.conversation.shareMode,
        syncedSequence: remoteRes.value.conversation.syncedSequence,
      }).catch(() => null)
    }

    const localRes = await localConversations.markSharingStopped(
      conversationId,
      remoteRes.value.conversation.stoppedAt ? Date.parse(remoteRes.value.conversation.stoppedAt) : undefined,
    ).catch(() => null)
    if (!localRes?.ok) return localRes ? localRes.error.message : "本机状态更新失败。"

    await reloadList()
    await loadDetail(conversationId)
    setSelectedConversationId(conversationId)
    onNotify?.("已停止共享 · 已切回个人空间并保留本机会话")
    onStoppedSharing?.({
      conversationId,
      workspaceId: localRes.value.workspaceId,
      title: localRes.value.title,
    })
    return null
  }, [localConversations, offline, projectConversations, reloadList, loadDetail, onNotify, onStoppedSharing, stopSharingTarget])

  const recentDirectories = useMemo(() => {
    const unique: string[] = []
    const pushIfNew = (dir: string | null | undefined) => {
      const trimmed = dir?.trim()
      if (trimmed && !unique.includes(trimmed)) unique.push(trimmed)
    }
    pushIfNew(newDraft.directoryPath)
    for (const rec of records) pushIfNew(rec.directoryPath)
    return unique.slice(0, 8)
  }, [newDraft.directoryPath, records])

  const rendering: RenderingActions = useMemo(() => ({
    copyText: text => host.copyText(text),
    openExternal: href => host.openExternal(href),
  }), [host])

  const selectedEntries = useMemo(() => {
    if (!selectedDetail) return []
    const activeEntries = selectedConversationId ? localExecutionPort?.getView?.(selectedConversationId)?.entries : undefined
    return localTurnsToTimelineEntries(
      localTurnsBeforeLiveTail(selectedDetail.turns, activeEntries),
      { userId: user.id, displayName: user.userName || "我" },
    )
  }, [selectedDetail, selectedConversationId, localExecutionPort, user.id, user.userName])

  const selectedSummary = useMemo(() => {
    if (!selectedRecord) return null
    const base = localRecordToConversationSummary(selectedRecord, user.id)
    const suggested = agentTitles[localExecutionKey({
      accountId: user.id,
      workspaceId: selectedRecord.workspaceId,
      projectId: selectedRecord.projectId,
      conversationId: selectedRecord.conversationId,
    })]
    return suggested && (!selectedRecord.title || selectedRecord.title === "新会话")
      ? { ...base, title: suggested }
      : base
  }, [selectedRecord, user.id, agentTitles])

  const selectedPersonalState = selectedRecord
    ? (personalRuntimes[selectedRecord.conversationId]?.personal ?? EMPTY_PERSONAL_STATE)
    : EMPTY_PERSONAL_STATE

  const renderRight = useCallback((slot: WorkbenchRightSlot): ReactNode | null => {
    if (activeSpace !== "personal" || !selectedRecord || !executionScope) return null
    const dockProps = localDir.buildDockProps({
      scope: executionScope,
      conversationId: selectedRecord.conversationId,
      deviceId: user.id,
      projectName: selectedRecord.title || "个人会话",
      directoryPath: selectedRecord.directoryPath,
      slot,
    })
    const runtime = localDir.getRuntime(executionScope, selectedRecord.conversationId)
    return createElement(SessionRightDock, {
      directoryPath: selectedRecord.directoryPath,
      bindingError: runtime.directory.error,
      dockProps,
      onChooseDirectory: () => chooseSessionDirectory(selectedRecord.conversationId),
    })
  }, [activeSpace, selectedRecord, executionScope, localDir, user.id, chooseSessionDirectory])

  const getCentralFiles = useCallback((): SessionCentralFilesState | undefined => {
    if (!selectedRecord || !executionScope) return undefined
    const central = localDir.getCentralState(executionScope, selectedRecord.conversationId)
    return {
      uiScope: {
        namespace: executionScope.namespace,
        accountId: executionScope.accountId,
        workspaceId: executionScope.workspaceId ?? "__solo__",
        deviceId: user.id,
        projectId: executionScope.projectId ?? "__personal__",
      },
      tabs: central.centralTabs,
      activeCentral: central.activeCentral,
      mode: central.mode,
      targetLocation: central.targetLocation,
      files: central.files,
      changes: central.changes,
      refreshGate: central.refreshGate,
      positions: central.positions,
      rendering,
      onSelectConversation: () => localDir.selectConversationCentralTab(executionScope, selectedRecord.conversationId),
      onSelectFile: path => localDir.selectCentralFileTab(executionScope, selectedRecord.conversationId, path),
      onCloseFile: path => localDir.closeCentralFileTab(executionScope, selectedRecord.conversationId, path),
      onRefreshFile: path => localDir.refreshFile(executionScope, selectedRecord.conversationId, path),
      onSetMode: mode => localDir.setCentralMode(executionScope, selectedRecord.conversationId, mode),
      onOpenDiffFile: path => localDir.openDiffFile(executionScope, selectedRecord.conversationId, path),
      onSaveScroll: (area, path, top, left) =>
        localDir.savePosition(executionScope, selectedRecord.conversationId, area, path, top, left),
    }
  }, [selectedRecord, executionScope, localDir, user.id, rendering])

  const modalRecord = useMemo(
    () => (modalConversationId ? records.find(item => item.conversationId === modalConversationId) ?? null : null),
    [modalConversationId, records],
  )
  const modalTurns = modalConversationId ? (detailsById[modalConversationId]?.detail?.turns ?? []) : []

  return {
    records,
    listStatus,
    listError,
    reloadList,
    personalPartition,
    selectedConversationId,
    selectConversation: (conversationId: string | null) => setSelectedConversationId(conversationId),
    startNewDraft: (init?: { readonly directoryPath?: string; readonly providerId?: string | null }) => {
      setSelectedConversationId(null)
      setCreateError(null)
      // 供目录分组菜单「在此目录新建会话」预填目录与 Agent；无参调用保持原行为。
      if (init) {
        setNewDraft(prev => ({
          ...prev,
          directoryPath: init.directoryPath ?? null,
          providerId: init.providerId ?? null,
          revision: prev.revision + 1,
        }))
      }
    },
    selectedRecord,
    selectedSummary,
    selectedExecutionScope: executionScope,
    selectedEntries,
    selectedContentRevision: selectedDetail?.turns.length ?? 0,
    selectedPersonalState,
    selectedGitSummary: selectedRecord && executionScope
      ? localDir.getGitSummary(executionScope, selectedRecord.conversationId)
      : null,
    localExecutionPort,
    localDir,
    rendering,
    renderRight,
    getCentralFiles,
    recentDirectories,
    newDraft,
    createBusy,
    createError,
    preflightProviders,
    checkingProviders,
    refreshProviders,
    chooseNewDirectory,
    selectNewDirectory: (directoryPath: string) =>
      setNewDraft(prev => ({ ...prev, directoryPath, revision: prev.revision + 1 })),
    selectNewProvider: (providerId: string) =>
      setNewDraft(prev => ({ ...prev, providerId })),
    updateNewDraftText: (draftText: string, selectionStart: number, selectionEnd: number) =>
      setNewDraft(prev => ({ ...prev, draftText, selectionStart, selectionEnd, revision: prev.revision + 1 })),
    startNewPersonalSession,
    renameConversation,
    chooseSessionDirectory,
    selectSessionDirectory,
    pinConversation,
    archiveConversation,
    restoreConversation,
    deleteConversation,
    archiveConversations,
    deleteConversations,
    copyConversationMarkdown,
    copyDirectoryPath,
    revealDirectory,
    chooseLocalFiles: (id: string) => appendLocalAttachments(id, () => host.chooseFiles()),
    chooseLocalDirectories: (id: string) => appendLocalAttachments(id, () => host.chooseContextDirectories()),
    openChangesPanel: (id: string) => {
      if (!executionScope) return
      localDir.openChangesPanel(executionScope, id)
      onOpenRightPanel?.()
    },
    refreshGitStatus: (id: string) => {
      if (executionScope) localDir.refreshGitStatus(executionScope, id)
    },
    requestFileCandidates: (targetConvScope: ConversationScope, _targetProject: { projectId: string }, request: Parameters<typeof localDir.requestFileCandidates>[2]) =>
      localDir.requestFileCandidates(
        {
          namespace: PERSONAL_NAMESPACE,
          accountId: targetConvScope.accountId,
          workspaceId: executionScope?.workspaceId ?? null,
          projectId: executionScope?.projectId ?? null,
        },
        targetConvScope.conversationId,
        request,
      ),
    openFile: (
      targetConvScope: ConversationScope,
      _targetProject: { projectId: string },
      relativePath: string,
      destination: "preview" | "central",
      lineRange?: { readonly line: number; readonly endLine?: number },
    ) => {
      if (!executionScope) return
      const mode = destination === "preview" ? "preview" : "central"
      localDir.openFileTab(executionScope, targetConvScope.conversationId, relativePath, mode, "code", lineRange)
      if (mode === "preview") onOpenRightPanel?.()
    },
    onPersonalChange,
    findRecord: (conversationId: string) => records.find(item => item.conversationId === conversationId) ?? null,
    publishDialogConvId,
    stopSharingDialogConvId,
    stopSharingTarget,
    modalRecord,
    modalTurns,
    openPublishDialog: (conversationId: string) => {
      setPublishDialogConvId(conversationId)
      void loadDetail(conversationId)
    },
    closePublishDialog: () => setPublishDialogConvId(null),
    openStopSharingDialog: (
      conversationId: string,
      fallback?: {
        readonly workspaceId?: string
        readonly projectId?: string
        readonly title?: string
        readonly projectName?: string | null
      },
    ) => setStopSharingTarget({ conversationId, ...fallback }),
    closeStopSharingDialog: () => setStopSharingTarget(null),
    publishConversation,
    stopConversationSharing,
  }
}
