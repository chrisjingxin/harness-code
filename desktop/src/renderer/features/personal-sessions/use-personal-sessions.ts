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
  groupPersonalRecordsByDirectory,
  localRecordToConversationSummary,
  localTurnsToTimelineEntries,
  partitionPersonalRecords,
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

type RecordPersonalRuntime = {
  readonly loaded: boolean
  readonly personal: ConversationPersonalState
  readonly providerId: string | null
  readonly sentImages?: Readonly<Record<string, readonly PersonalDraftImage[]>>
}

const DEFAULT_PERSONAL_RUNTIME: RecordPersonalRuntime = {
  loaded: false,
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

function restorePersonalFromSaved(saved: ConversationPersonal | null): RecordPersonalRuntime {
  if (!saved) {
    return { loaded: true, personal: EMPTY_PERSONAL_STATE, providerId: null }
  }
  return {
    loaded: true,
    providerId: saved.providerId ?? null,
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
  runtime: RecordPersonalRuntime,
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

  const [listStatus, setListStatus] = useState<"loading" | "ready" | "failed">(
    localConversations ? "loading" : "ready",
  )
  const [listError, setListError] = useState("")
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null)
  const [detailsById, setDetailsById] = useState<Readonly<Record<string, DetailEntry>>>({})
  const [personalRuntimes, setPersonalRuntimes] = useState<Readonly<Record<string, RecordPersonalRuntime>>>({})
  const personalRuntimesRef = useRef(personalRuntimes)
  personalRuntimesRef.current = personalRuntimes

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

  const ensurePersonalRuntimeLoaded = useCallback(async (record: LocalConversationRecord): Promise<RecordPersonalRuntime> => {
    const existing = personalRuntimesRef.current[record.conversationId]
    if (existing?.loaded) return existing
    const res = await persistence.load({
      kind: "conversation",
      workspaceId: record.workspaceId,
      projectId: record.projectId,
      conversationId: record.conversationId,
    })
    const loaded = res.ok
      ? restorePersonalFromSaved(res.value.data as ConversationPersonal | null)
      : { loaded: true, personal: EMPTY_PERSONAL_STATE, providerId: record.providerId }
    if (!mountedRef.current) return loaded
    setPersonalRuntimes(prev => {
      if (prev[record.conversationId]?.loaded) return prev
      const next = { ...prev, [record.conversationId]: loaded }
      personalRuntimesRef.current = next
      return next
    })
    return loaded
  }, [persistence])

  const mutatePersonalRuntime = useCallback((
    record: LocalConversationRecord,
    updater: (prev: RecordPersonalRuntime) => RecordPersonalRuntime,
    persist = true,
  ) => {
    const prev = personalRuntimesRef.current[record.conversationId] ?? {
      ...DEFAULT_PERSONAL_RUNTIME,
      loaded: true,
    }
    const next = updater(prev)
    const nextMap = { ...personalRuntimesRef.current, [record.conversationId]: next }
    personalRuntimesRef.current = nextMap
    setPersonalRuntimes(nextMap)
    if (persist && next.loaded) {
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
    const rec = recordsRef.current.find(item => item.conversationId === selectedConversationId)
    void loadDetail(selectedConversationId)
    if (rec) void ensurePersonalRuntimeLoaded(rec)
  }, [selectedConversationId, activeSpace, loadDetail, ensurePersonalRuntimeLoaded])

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
    mutatePersonalRuntime(rec, prev => ({
      ...prev,
      loaded: true,
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
    mutatePersonalRuntime(rec, prev => (prev.providerId === providerId ? prev : { ...prev, loaded: true, providerId }), true)
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
      return { ...prev, loaded: true, ...(merged ? { sentImages: merged } : {}) }
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

  // 个人栏位展示所有未处于 active 共享态的个人会话，按工程目录折叠分组（不按团队筛选）。
  const personalPartition = useMemo(() => {
    const { personal, publishedCount } = partitionPersonalRecords(records)
    return {
      personal,
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
      await persistence.load({
        kind: "conversation",
        workspaceId: created.workspaceId,
        projectId: created.projectId,
        conversationId: created.conversationId,
      }).catch(() => null)
      if (!mountedRef.current) return
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
        loaded: true,
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

  const appendLocalAttachments = useCallback((conversationId: string, choose: () => Promise<readonly string[]>) => {
    const rec = recordsRef.current.find(item => item.conversationId === conversationId)
    if (!rec) return
    void choose().then(picked => {
      if (!picked.length || !mountedRef.current) return
      mutatePersonalRuntime(rec, prev => ({
        ...prev,
        loaded: true,
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
      loaded: true,
      personal: applyConversationPersonalChange(prev.personal, change),
    }), true)
  }, [mutatePersonalRuntime])

  const publishConversation = useCallback(async (
    conversationId: string,
    input: PublishConversationSubmitInput,
  ): Promise<string | null> => {
    if (!localConversations) return "本机会话存储尚未启用。"
    if (offline) return "协作服务当前离线，无法发布到 Project。"
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
      return "该会话当前未关联已发布 Project。"
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
    const liveTurnIds = new Set<string>()
    for (const entry of activeEntries ?? []) {
      const match = /^local-execution:([^:]+):/.exec(entry.id)
      if (match?.[1]) liveTurnIds.add(match[1])
    }
    // 仅跳过结尾已在实时 execution.entries 中完整呈现的连续尾段轮次，避免跨空间往返后历史顺序倒错或重复。
    const persisted = selectedDetail.turns
    let cutoff = persisted.length
    while (cutoff > 0 && liveTurnIds.has(persisted[cutoff - 1]!.turnId)) {
      cutoff -= 1
    }
    return localTurnsToTimelineEntries(
      persisted.slice(0, cutoff),
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
    startNewDraft: () => {
      setSelectedConversationId(null)
      setCreateError(null)
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
