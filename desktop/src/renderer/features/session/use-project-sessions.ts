/**
 * 项目会话真实数据流协调器：
 *
 * 【功能定义】
 * 1. 按当前导航范围 (scope) 拉取 HC-211 项目会话元数据与简报，投影为左栏条目与五态同步徽标；
 * 2. 严格遵守“正文不静默下载”不变量：仅在用户点击「同步会话 / 同步更新」时按序号分页增量拉取历史正文；
 * 3. 通过 PersonalStore 持久化每条会话的阅读位置、折叠、工作目录与 800KB 容限正文缓存 (`conversation`)，
 *    以及新会话准备页的目录与草稿 (`projectDraft`)；
 * 4. 任何范围切换、账号退出、网络失败都严格隔离代次并保留已有简报与缓存正文。
 */
import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type {
  MemberSummary,
  UserSummary,
} from "@workbench/collaboration-client/types"
import {
  MAX_SENT_IMAGE_RECORDS,
  localExecutionKey,
  type ConversationPersonal,
  type DesktopHost,
  type DesktopLocalExecutionHost,
  type LocalDirectoryHost,
  type LocalExecutionScope,
  type PersonalDraftImage,
  type ProjectConversationHost,
  type ProjectDraftPersonal,
} from "../../../shared/index.js"
import { mergeAttachmentPaths } from "../../../ui/index.js"
import type { ConversationDraftImage, ConversationPersonalState, ConversationScope, RenderingActions } from "../../../ui/index.js"
import type { PersonalPersistence } from "../../personal-persistence.js"
import type { NavigationSessionSource, ProjectNavigationScope } from "../project-navigation/contracts.js"
import type {
  LocalSessionExecutionPort,
  NewSessionDraft,
  ProjectConversationSummary,
  SessionIntegrationApi,
  SessionSyncState,
} from "./contracts.js"
import { SessionRightDock } from "./session-center.js"
import type { SessionCentralFilesState } from "./session-center.js"
import {
  applyConversationTitleOverrides,
  boundCachedMessages,
  classifyConversation,
  emptySyncState,
  mergeIncrementalHistory,
  toNavigationSessionEntries,
} from "./session-model.js"
import {
  EMPTY_PERSONAL_STATE,
  applyConversationPersonalChange,
} from "./session-provider.js"
import type { SessionPageController } from "./session-provider.js"
import { useLocalDirectory } from "./use-local-directory.js"
import { NEW_SESSION_DRAFT_ID } from "./contracts.js"
import { newSessionConversationDraft, restoreNewSessionDraft } from "./new-session-draft.js"
import { mergeReferenceDraft } from "./reference-draft.js"
import { useLocalExecution } from "./use-local-execution.js"

const HISTORY_PAGE_LIMIT = 200
const MAX_HISTORY_PAGES = 50
const EMPTY_CONVERSATIONS: ProjectConversationSummary[] = []
const EMPTY_NEW_DRAFT = restoreNewSessionDraft(null)

type ScopeListState = {
  readonly status: "loading" | "ready" | "failed"
  readonly conversations: ProjectConversationSummary[]
  readonly error: string
}

type DraftEntry = {
  readonly loaded: boolean
  readonly value: NewSessionDraft
}

type ConversationRecordState = {
  readonly loaded: boolean
  readonly loadError: string | null
  readonly personal: ConversationPersonalState
  readonly directoryPath: string | null
  readonly providerId: string | null
  readonly customTitle?: string
  readonly sentImages?: Readonly<Record<string, readonly PersonalDraftImage[]>>
  readonly syncState: SessionSyncState
}

const DEFAULT_RECORD: ConversationRecordState = {
  loaded: false,
  loadError: null,
  personal: EMPTY_PERSONAL_STATE,
  directoryPath: null,
  providerId: null,
  syncState: emptySyncState(),
}

const defaultExecutionPort: LocalSessionExecutionPort = {
  getAvailability: () => ({
    available: false,
    reason: "本机 Agent 与运行内核（ACP/Runner）尚未接入，暂不能发送消息或取消执行。",
  }),
}

function makeScopeKey(scope: ProjectNavigationScope | null): string {
  return scope ? JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.projectId]) : ""
}

function makeRecordKey(sKey: string, conversationId: string): string {
  return JSON.stringify([sKey, conversationId])
}

function syncStateFromPersonal(saved: ConversationPersonal | null): SessionSyncState {
  if (!saved?.syncCache) return emptySyncState()
  return {
    localSyncedSequence: saved.syncCache.syncedSequence,
    lastSyncedAtMs: saved.syncCache.syncedAtMs,
    syncing: false,
    syncError: null,
    messages: saved.syncCache.messages,
    ...(saved.syncCache.cacheTruncated ? { cacheTruncated: true } : {}),
  }
}

function toPersistedDraftImages(images: readonly ConversationDraftImage[] | undefined): readonly PersonalDraftImage[] {
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

function personalFromSaved(saved: ConversationPersonal | null): ConversationPersonalState {
  if (!saved) return EMPTY_PERSONAL_STATE
  return {
    scroll: saved.scroll,
    expandedTools: [...saved.expandedTools],
    expandedOutputs: [...saved.expandedOutputs],
    draft: {
      ...saved.draft,
      annotations: Array.isArray(saved.draft.annotations) ? [...saved.draft.annotations] : [],
      images: Array.isArray(saved.draft.images) ? [...saved.draft.images] : [],
    },
    interactions: {},
  }
}

function toPersistablePersonal(
  personal: ConversationPersonalState,
  directoryPath: string | null,
  syncState: SessionSyncState,
  providerId: string | null,
  sentImages?: Readonly<Record<string, readonly PersonalDraftImage[]>>,
): ConversationPersonal {
  const { interactions: _ignored, ...rest } = personal
  const persistedImages = toPersistedDraftImages(rest.draft.images)
  const boundedSentImages = boundSentImages(sentImages)
  const hasSyncData = syncState.localSyncedSequence > 0 || syncState.messages.length > 0
  const bounded = hasSyncData ? boundCachedMessages(syncState.messages) : null
  return {
    ...rest,
    draft: {
      ...rest.draft,
      images: persistedImages,
    },
    localDirectoryPath: directoryPath,
    ...(providerId ? { providerId } : {}),
    ...(boundedSentImages ? { sentImages: boundedSentImages } : {}),
    syncCache: bounded
      ? {
          syncedSequence: syncState.localSyncedSequence,
          syncedAtMs: syncState.lastSyncedAtMs ?? Date.now(),
          messages: bounded.messages,
          ...(syncState.cacheTruncated || bounded.truncated ? { cacheTruncated: true } : {}),
        }
      : null,
  }
}

function deriveSessionTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0) ?? ""
  const normalized = firstLine.replace(/\s+/g, " ").trim()
  if (!normalized) return "新会话"
  return normalized.length > 48 ? `${normalized.slice(0, 48)}…` : normalized
}

export type UseProjectSessionsOptions = {
  readonly host: DesktopHost
  readonly projectConversations: ProjectConversationHost
  readonly localDirectory?: LocalDirectoryHost
  readonly localExecution?: DesktopLocalExecutionHost
  readonly persistence: PersonalPersistence
  readonly scope: ProjectNavigationScope | null
  readonly projectName: string
  readonly userId: string
  readonly members: readonly MemberSummary[]
  readonly selectedConversationId: string | null
  readonly execution?: LocalSessionExecutionPort
  readonly onOpenConversation?: (conversation: ProjectConversationSummary) => void
  /** @ 提及点击「预览」时展开右侧文件预览面板，无需切出中央对话。 */
  readonly onOpenRightPanel?: () => void
}

/** 协调当前项目的会话元数据列表、按需正文增量拉取、草稿与个人同步缓存持久化。 */
export function useProjectSessions(options: UseProjectSessionsOptions) {
  const {
    host,
    projectConversations,
    localDirectory,
    localExecution,
    persistence,
    scope,
    projectName,
    userId,
    members,
    selectedConversationId,
    execution,
    onOpenConversation,
    onOpenRightPanel,
  } = options

  const currentScopeKey = makeScopeKey(scope)
  const activeScopeKeyRef = useRef(currentScopeKey)
  activeScopeKeyRef.current = currentScopeKey
  const draftContext = useMemo(() => ({ currentScopeKey, userId, selectedConversationId }), [
    currentScopeKey, userId, selectedConversationId, persistence,
  ])
  const activeDraftContext = useRef<typeof draftContext | null>(null)
  useLayoutEffect(() => {
    activeDraftContext.current = draftContext
    return () => { activeDraftContext.current = null }
  }, [draftContext])
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const [listsByScope, setListsByScope] = useState<Readonly<Record<string, ScopeListState>>>({})
  const listsRef = useRef(listsByScope)
  listsRef.current = listsByScope

  const [draftsByScope, setDraftsByScope] = useState<Readonly<Record<string, DraftEntry>>>({})
  const draftsRef = useRef(draftsByScope)
  draftsRef.current = draftsByScope

  const [recordsByKey, setRecordsByKey] = useState<Readonly<Record<string, ConversationRecordState>>>({})
  const recordsRef = useRef(recordsByKey)
  recordsRef.current = recordsByKey

  const listGenRef = useRef(0)
  const loadInFlightRef = useRef(new Map<string, Promise<ConversationRecordState | null>>())
  const syncInFlightRef = useRef(new Set<string>())
  const briefInFlightRef = useRef(new Set<string>())
  const [newSessionBusy, setNewSessionBusy] = useState(false)
  const [newSessionError, setNewSessionError] = useState<string | null>(null)
  const [newProviderId, setNewProviderId] = useState<string | null>(null)
  const [agentTitles, setAgentTitles] = useState<Readonly<Record<string, string | undefined>>>({})
  const agentTitlesRef = useRef(agentTitles)
  agentTitlesRef.current = agentTitles
  const handleSessionTitleChange = useCallback((execScope: LocalExecutionScope, title: string | undefined) => {
    const key = localExecutionKey(execScope)
    if (agentTitlesRef.current[key] === title) return
    const next = { ...agentTitlesRef.current, [key]: title }
    agentTitlesRef.current = next
    setAgentTitles(next)
  }, [])
  const pendingRequestRef = useRef<{ signature: string; requestId: string; conversation?: ProjectConversationSummary } | null>(null)
  const pendingAutoSendRef = useRef<{
    readonly scope: ProjectNavigationScope
    readonly conversationId: string
    readonly directoryPath: string
    readonly draftRevision: number
    readonly text: string
    readonly referenceIds: readonly string[]
    readonly scopeKey: string
  } | null>(null)
  const creatingRef = useRef(false)

  const stillActive = (targetKey: string) =>
    mountedRef.current && activeScopeKeyRef.current === targetKey

  const refreshMetadata = useCallback(async (targetScope: ProjectNavigationScope): Promise<void> => {
    const targetKey = makeScopeKey(targetScope)
    const requestGen = ++listGenRef.current
    const existing = listsRef.current[targetKey]
    if (!existing) {
      setListsByScope(prev => ({
        ...prev,
        [targetKey]: { status: "loading", conversations: [], error: "" },
      }))
    }
    const result = await projectConversations.listConversations(targetScope.workspaceId, targetScope.projectId)
    if (!stillActive(targetKey) || listGenRef.current !== requestGen) return
    if (!result.ok) {
      // 已有元数据时的后台刷新失败不应清空左栏简报列表。
      if (!existing || existing.status !== "ready") {
        setListsByScope(prev => ({
          ...prev,
          [targetKey]: { status: "failed", conversations: [], error: result.error.message },
        }))
      }
      return
    }
    if (result.value.projectId !== targetScope.projectId) {
      if (!existing || existing.status !== "ready") {
        setListsByScope(prev => ({
          ...prev,
          [targetKey]: { status: "failed", conversations: [], error: "服务返回项目会话数据与当前项目不匹配。" },
        }))
      }
      return
    }
    setListsByScope(prev => ({
      ...prev,
      [targetKey]: { status: "ready", conversations: [...result.value.conversations], error: "" },
    }))
  }, [projectConversations])

  // 切换项目后自动刷新当前项目元数据与新会话草稿，绝不调用 readHistory。
  useEffect(() => {
    if (!scope || !currentScopeKey) return
    void refreshMetadata(scope)
    if (draftsRef.current[currentScopeKey]?.loaded) return
    const targetScope = scope
    const targetKey = currentScopeKey
    const beforeLoad = draftsRef.current[targetKey]
    void persistence.load({
      kind: "projectDraft",
      workspaceId: targetScope.workspaceId,
      projectId: targetScope.projectId,
    }).then(result => {
      if (!stillActive(targetKey)) return
      const saved = result.ok ? result.value.data as ProjectDraftPersonal | null : null
      const edited = draftsRef.current[targetKey] !== beforeLoad ? draftsRef.current[targetKey]?.value : undefined
      const restored = restoreNewSessionDraft(saved)
      const before = beforeLoad?.value ?? EMPTY_NEW_DRAFT
      // 恢复期间的输入保留，尚未改动的目录与引用仍采用磁盘记录。
      const value = edited ? {
        ...restored,
        ...(edited.directoryPath !== before.directoryPath ? { directoryPath: edited.directoryPath } : {}),
        ...(edited.draftText !== before.draftText ? { draftText: edited.draftText } : {}),
        selectionStart: edited.selectionStart, selectionEnd: edited.selectionEnd,
        revision: Math.max(restored.revision, edited.revision) + 1,
      } : restored
      const entry = { loaded: result.ok, value }
      draftsRef.current = { ...draftsRef.current, [targetKey]: entry }
      setDraftsByScope(prev => ({ ...prev, [targetKey]: entry }))
      if (edited && result.ok) persistence.save({
        kind: "projectDraft", workspaceId: targetScope.workspaceId, projectId: targetScope.projectId,
      }, value)
    })
  }, [currentScopeKey, persistence, refreshMetadata])

  const ensureRecordLoaded = useCallback(async (
    targetScope: ProjectNavigationScope,
    targetKey: string,
    conversationId: string,
  ): Promise<ConversationRecordState | null> => {
    const recKey = makeRecordKey(targetKey, conversationId)
    const cached = recordsRef.current[recKey]
    if (cached?.loaded) return cached
    const existingPromise = loadInFlightRef.current.get(recKey)
    if (existingPromise) return existingPromise

    const promise = (async (): Promise<ConversationRecordState | null> => {
      const result = await persistence.load({
        kind: "conversation",
        workspaceId: targetScope.workspaceId,
        projectId: targetScope.projectId,
        conversationId,
      })
      if (!stillActive(targetKey)) return null
      if (!result.ok) {
        const failedRecord: ConversationRecordState = {
          ...(recordsRef.current[recKey] ?? DEFAULT_RECORD),
          loaded: false,
          loadError: result.message,
        }
        recordsRef.current = { ...recordsRef.current, [recKey]: failedRecord }
        setRecordsByKey(prev => ({ ...prev, [recKey]: failedRecord }))
        return null
      }
      const saved = result.value.data as ConversationPersonal | null
      const loadedRecord: ConversationRecordState = {
        loaded: true,
        loadError: null,
        personal: personalFromSaved(saved),
        directoryPath: saved?.localDirectoryPath ?? null,
        providerId: saved?.providerId ?? null,
        customTitle: saved?.customTitle,
        ...(saved?.sentImages ? { sentImages: saved.sentImages } : {}),
        syncState: syncStateFromPersonal(saved),
      }
      // 等待恢复的草稿动作可能先于 React 重新渲染，直接从同一记录读取最新值。
      recordsRef.current = { ...recordsRef.current, [recKey]: loadedRecord }
      setRecordsByKey(prev => ({ ...prev, [recKey]: loadedRecord }))
      return loadedRecord
    })().finally(() => {
      if (loadInFlightRef.current.get(recKey) === promise) {
        loadInFlightRef.current.delete(recKey)
      }
    })
    loadInFlightRef.current.set(recKey, promise)
    return promise
  }, [persistence])

  const activeList = currentScopeKey ? listsByScope[currentScopeKey] : undefined
  const activeConversations = activeList?.conversations ?? EMPTY_CONVERSATIONS

  // 本人会话即使从未同步也可能已改名。复用限并发的个人记录恢复，远端正文仍由原入口按需读取。
  useEffect(() => {
    if (!scope || !currentScopeKey || activeConversations.length === 0) return
    const pending = activeConversations
      .filter(item => item.ownerUserId === scope.accountId || item.syncedSequence > 0)
      .filter(item => {
        const recKey = makeRecordKey(currentScopeKey, item.conversationId)
        return !recordsRef.current[recKey]?.loaded && !loadInFlightRef.current.has(recKey)
      })
      .map(item => item.conversationId)
    if (pending.length === 0) return

    let cancelled = false
    const targetScope = scope
    const targetKey = currentScopeKey
    let cursor = 0
    const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (!cancelled && stillActive(targetKey)) {
        const index = cursor++
        if (index >= pending.length) return
        await ensureRecordLoaded(targetScope, targetKey, pending[index])
      }
    })
    void Promise.all(workers)
    return () => { cancelled = true }
  }, [scope, currentScopeKey, activeConversations, ensureRecordLoaded])

  // 当选中某条会话且它确实属于当前项目列表时，按需从 PersonalStore 加载个人状态与已缓存正文。
  useEffect(() => {
    if (!scope || !currentScopeKey || !selectedConversationId) return
    if (!activeConversations.some(item => item.conversationId === selectedConversationId)) return
    const recKey = makeRecordKey(currentScopeKey, selectedConversationId)
    if (recordsRef.current[recKey]?.loaded) return
    void ensureRecordLoaded(scope, currentScopeKey, selectedConversationId)
  }, [scope, currentScopeKey, selectedConversationId, activeConversations, ensureRecordLoaded])

  const updateRecord = useCallback((
    targetScope: ProjectNavigationScope,
    targetKey: string,
    conversationId: string,
    updater: (previous: ConversationRecordState) => ConversationRecordState,
    persist: boolean,
  ) => {
    const recKey = makeRecordKey(targetKey, conversationId)
    const prev = recordsRef.current[recKey] ?? DEFAULT_RECORD
    const next = updater(prev)
    recordsRef.current = { ...recordsRef.current, [recKey]: next }
    setRecordsByKey(current => ({ ...current, [recKey]: next }))
    if (persist && next.loaded) {
      persistence.save(
        {
          kind: "conversation",
          workspaceId: targetScope.workspaceId,
          projectId: targetScope.projectId,
          conversationId,
        },
        toPersistablePersonal(next.personal, next.directoryPath, next.syncState, next.providerId, next.sentImages),
      )
    }
  }, [persistence])

  const syncConversation = useCallback(async (conversationId: string) => {
    if (!scope || !currentScopeKey) return
    const targetScope = scope
    const targetKey = currentScopeKey
    const recKey = makeRecordKey(targetKey, conversationId)
    if (syncInFlightRef.current.has(recKey)) return

    const conv = listsRef.current[targetKey]?.conversations.find(item => item.conversationId === conversationId)
    if (!conv) return

    syncInFlightRef.current.add(recKey)
    try {
      const existingRecord = recordsRef.current[recKey]?.loaded
        ? recordsRef.current[recKey]!
        : await ensureRecordLoaded(targetScope, targetKey, conversationId)
      if (!stillActive(targetKey)) return
      if (!existingRecord) {
        updateRecord(targetScope, targetKey, conversationId, prev => ({
          ...prev,
          syncState: {
            ...prev.syncState,
            syncing: false,
            syncError: prev.loadError ?? "无法确认会话访问权限，未能同步。",
          },
        }), false)
        return
      }

      updateRecord(targetScope, targetKey, conversationId, prev => ({
        ...prev,
        syncState: { ...prev.syncState, syncing: true, syncError: null },
      }), false)

      const startFromZero = Boolean(
        existingRecord.syncState.cacheTruncated && conv.syncedSequence <= existingRecord.syncState.localSyncedSequence,
      )
      let cursor = startFromZero ? 0 : existingRecord.syncState.localSyncedSequence
      let accumulated = startFromZero ? [] : [...existingRecord.syncState.messages]
      let currentSequence = cursor
      let reportedWatermark = conv.syncedSequence
      let pageCount = 0

      while (true) {
        const res = await projectConversations.readHistory(
          targetScope.workspaceId,
          targetScope.projectId,
          conversationId,
          cursor,
          HISTORY_PAGE_LIMIT,
        )
        if (!stillActive(targetKey)) return
        if (!res.ok) {
          updateRecord(targetScope, targetKey, conversationId, prev => ({
            ...prev,
            syncState: { ...prev.syncState, syncing: false, syncError: res.error.message },
          }), false)
          return
        }
        if (
          res.value.conversationId !== conversationId
          || !Number.isSafeInteger(res.value.syncedSequence)
          || res.value.syncedSequence < 0
        ) {
          updateRecord(targetScope, targetKey, conversationId, prev => ({
            ...prev,
            syncState: { ...prev.syncState, syncing: false, syncError: "服务返回数据异常，已中止本次同步。" },
          }), false)
          return
        }

        let merged: ReturnType<typeof mergeIncrementalHistory>
        try {
          merged = mergeIncrementalHistory(accumulated, currentSequence, res.value.messages, res.value.syncedSequence)
        } catch {
          updateRecord(targetScope, targetKey, conversationId, prev => ({
            ...prev,
            syncState: { ...prev.syncState, syncing: false, syncError: "服务返回的历史消息序号异常，已中止本次同步。" },
          }), false)
          return
        }

        accumulated = merged.messages
        const fetchedThrough = res.value.messages.at(-1)?.sequence ?? currentSequence
        reportedWatermark = Math.max(reportedWatermark, res.value.syncedSequence)
        pageCount += 1

        if (
          res.value.messages.length === HISTORY_PAGE_LIMIT
          && fetchedThrough > currentSequence
          && fetchedThrough < res.value.syncedSequence
          && pageCount < MAX_HISTORY_PAGES
        ) {
          currentSequence = fetchedThrough
          cursor = fetchedThrough
          continue
        }
        currentSequence = res.value.messages.length === HISTORY_PAGE_LIMIT && fetchedThrough < res.value.syncedSequence
          ? fetchedThrough
          : merged.syncedSequence
        break
      }

      const bounded = boundCachedMessages(accumulated)
      const nextSyncState: SessionSyncState = {
        localSyncedSequence: currentSequence,
        lastSyncedAtMs: Date.now(),
        syncing: false,
        syncError: null,
        messages: bounded.messages,
        ...(bounded.truncated ? { cacheTruncated: true } : {}),
      }

      setListsByScope(prev => {
        const currentList = prev[targetKey]
        if (!currentList) return prev
        return {
          ...prev,
          [targetKey]: {
            ...currentList,
            conversations: currentList.conversations.map(item =>
              item.conversationId === conversationId && reportedWatermark > item.syncedSequence
                ? { ...item, syncedSequence: reportedWatermark }
                : item,
            ),
          },
        }
      })

      updateRecord(targetScope, targetKey, conversationId, prev => ({
        ...prev,
        syncState: nextSyncState,
      }), true)
    } finally {
      syncInFlightRef.current.delete(recKey)
    }
  }, [scope, currentScopeKey, projectConversations, ensureRecordLoaded, updateRecord])

  const refreshBrief = useCallback(async (conversationId: string) => {
    if (!scope || !currentScopeKey) return
    const targetScope = scope
    const targetKey = currentScopeKey
    const recKey = makeRecordKey(targetKey, conversationId)
    if (briefInFlightRef.current.has(recKey)) return
    briefInFlightRef.current.add(recKey)
    try {
      const res = await projectConversations.getConversation(targetScope.workspaceId, targetScope.projectId, conversationId)
      if (!stillActive(targetKey)) return
      if (!res.ok) {
        updateRecord(targetScope, targetKey, conversationId, prev => ({
          ...prev,
          syncState: { ...prev.syncState, syncError: res.error.message },
        }), false)
        return
      }
      setListsByScope(prev => {
        const currentList = prev[targetKey]
        if (!currentList) return prev
        return {
          ...prev,
          [targetKey]: {
            ...currentList,
            conversations: currentList.conversations.map(item =>
              item.conversationId === conversationId ? res.value.conversation : item,
            ),
          },
        }
      })
      updateRecord(targetScope, targetKey, conversationId, prev => ({
        ...prev,
        syncState: prev.syncState.syncError ? { ...prev.syncState, syncError: null } : prev.syncState,
      }), false)
    } finally {
      briefInFlightRef.current.delete(recKey)
    }
  }, [scope, currentScopeKey, projectConversations, updateRecord])

  const saveDraftValue = useCallback((
    targetScope: ProjectNavigationScope,
    targetKey: string,
    nextValue: NewSessionDraft,
  ) => {
    const existing = draftsRef.current[targetKey]
    const loaded = existing?.loaded ?? false
    draftsRef.current = { ...draftsRef.current, [targetKey]: { loaded, value: nextValue } }
    setDraftsByScope(prev => ({ ...prev, [targetKey]: { loaded, value: nextValue } }))
    if (loaded) {
      persistence.save(
        { kind: "projectDraft", workspaceId: targetScope.workspaceId, projectId: targetScope.projectId },
        nextValue,
      )
    }
  }, [persistence])

  const onChooseNewDirectory = useCallback(() => {
    if (!scope || !currentScopeKey) return
    const targetScope = scope
    const targetKey = currentScopeKey
    void host.chooseDirectory().then(picked => {
      if (!picked || !stillActive(targetKey)) return
      setNewSessionError(null)
      const currentDraft = draftsRef.current[targetKey]?.value ?? EMPTY_NEW_DRAFT
      if (picked !== currentDraft.directoryPath) pendingRequestRef.current = null
      saveDraftValue(targetScope, targetKey, { ...currentDraft, directoryPath: picked, revision: currentDraft.revision + 1 })
    }).catch(() => {})
  }, [scope, currentScopeKey, host, saveDraftValue])

  const onSelectNewDirectory = useCallback((directoryPath: string) => {
    if (!scope || !currentScopeKey || !directoryPath.trim()) return
    setNewSessionError(null)
    const currentDraft = draftsRef.current[currentScopeKey]?.value ?? EMPTY_NEW_DRAFT
    if (directoryPath !== currentDraft.directoryPath) pendingRequestRef.current = null
    saveDraftValue(scope, currentScopeKey, { ...currentDraft, directoryPath, revision: currentDraft.revision + 1 })
  }, [scope, currentScopeKey, saveDraftValue])

  const onNewDraftChange = useCallback((text: string, selectionStart = text.length, selectionEnd = selectionStart) => {
    if (!scope || !currentScopeKey) return
    setNewSessionError(null)
    const currentDraft = draftsRef.current[currentScopeKey]?.value ?? EMPTY_NEW_DRAFT
    if (text !== currentDraft.draftText) pendingRequestRef.current = null
    saveDraftValue(scope, currentScopeKey, {
      ...currentDraft, draftText: text, selectionStart, selectionEnd, revision: currentDraft.revision + 1,
    })
  }, [scope, currentScopeKey, saveDraftValue])

  /** 两条新建路径共用已有登记端口。调用方用同一个请求 ID 重试未确认的登记。 */
  const registerLocalConversation = useCallback(async (
    targetScope: ProjectNavigationScope,
    title: string,
    requestId: string,
  ): Promise<{ ok: true; conversation: ProjectConversationSummary } | { ok: false; message: string }> => {
    if (creatingRef.current) return { ok: false, message: "已有会话正在登记，请稍后重试。" }
    creatingRef.current = true
    try {
      const result = await projectConversations.registerConversation(targetScope.workspaceId, targetScope.projectId, {
        title, requestId,
      })
      if (!result.ok) return { ok: false, message: result.error.message }
      const created = result.value.conversation
      if (created.projectId !== targetScope.projectId || classifyConversation(created, targetScope.accountId) !== "local") {
        return { ok: false, message: "登记结果与本人本机会话的范围不符。" }
      }
      return { ok: true, conversation: created }
    } catch {
      return { ok: false, message: "未能确认会话登记结果，请重试。" }
    } finally {
      creatingRef.current = false
    }
  }, [projectConversations])

  const includeRegisteredConversation = useCallback((targetKey: string, created: ProjectConversationSummary) => {
    // 登记前发出的列表请求可能不含新会话，避免它撤销刚登记的条目。
    listGenRef.current++
    const others = (listsRef.current[targetKey]?.conversations ?? EMPTY_CONVERSATIONS)
      .filter(item => item.conversationId !== created.conversationId)
    const nextList: ScopeListState = { status: "ready", error: "", conversations: [created, ...others] }
    listsRef.current = { ...listsRef.current, [targetKey]: nextList }
    setListsByScope(prev => ({ ...prev, [targetKey]: nextList }))
  }, [])

  const onStartNewSession = useCallback(async () => {
    if (!scope || !currentScopeKey || newSessionBusy || creatingRef.current) return
    const targetScope = scope
    const targetKey = currentScopeKey
    const currentDraft = draftsRef.current[targetKey]?.value ?? EMPTY_NEW_DRAFT
    const chosenDir = currentDraft.directoryPath
    const trimmedPrompt = currentDraft.draftText.trim()
    if (!draftsRef.current[targetKey]?.loaded || !chosenDir || (!trimmedPrompt && !currentDraft.referenceIds.length)) return

    // 光标修订不改变登记请求。首次内容与目录相同时，未知结果仍用原请求号重试。
    const signature = JSON.stringify([targetKey, chosenDir, currentDraft.draftText, currentDraft.referenceIds])
    if (!pendingRequestRef.current || pendingRequestRef.current.signature !== signature) {
      pendingRequestRef.current = { signature, requestId: crypto.randomUUID() }
    }
    const request = pendingRequestRef.current

    setNewSessionBusy(true)
    setNewSessionError(null)
    try {
      const res = request.conversation ? { ok: true as const, conversation: request.conversation }
        : await registerLocalConversation(targetScope, deriveSessionTitle(trimmedPrompt), request.requestId)
      if (res.ok) request.conversation = res.conversation
      if (activeDraftContext.current !== draftContext) return
      if (!res.ok) {
        setNewSessionError(res.message)
        return
      }

      const created = res.conversation
      includeRegisteredConversation(targetKey, created)

      const restored = await ensureRecordLoaded(targetScope, targetKey, created.conversationId)
      if (activeDraftContext.current !== draftContext) return
      if (!restored) { setNewSessionError("会话已登记，无法恢复草稿。请重试继续准备。"); return }
      let nextDraftRevision = 1
      updateRecord(targetScope, targetKey, created.conversationId, prev => {
        nextDraftRevision = prev.personal.draft.revision + 1
        return {
          ...prev,
          loaded: true,
          directoryPath: chosenDir,
          providerId: newProviderId ?? prev.providerId,
          personal: {
            ...prev.personal,
            draft: {
              ...prev.personal.draft,
              text: currentDraft.draftText,
              referenceIds: [...currentDraft.referenceIds],
              selectionStart: currentDraft.selectionStart,
              selectionEnd: currentDraft.selectionEnd,
              revision: nextDraftRevision,
            },
          },
        }
      }, true)

      pendingAutoSendRef.current = {
        scope: targetScope,
        conversationId: created.conversationId,
        directoryPath: chosenDir,
        draftRevision: nextDraftRevision,
        text: currentDraft.draftText,
        referenceIds: [...currentDraft.referenceIds],
        scopeKey: targetKey,
      }
      if (draftsRef.current[targetKey]?.value === currentDraft) {
        saveDraftValue(targetScope, targetKey, { ...EMPTY_NEW_DRAFT, revision: currentDraft.revision + 1 })
      }
      if (pendingRequestRef.current === request) pendingRequestRef.current = null
      onOpenConversation?.(created)
    } finally {
      if (mountedRef.current) setNewSessionBusy(false)
    }
  }, [
    scope,
    currentScopeKey,
    newSessionBusy,
    draftContext,
    registerLocalConversation,
    includeRegisteredConversation,
    ensureRecordLoaded,
    updateRecord,
    saveDraftValue,
    onOpenConversation,
    newProviderId,
  ])

  const [directorySelectionRevision, confirmDirectorySelection] = useState(0)
  const onSelectSessionDirectory = useCallback((conversationId: string, directoryPath: string) => {
    if (!scope || !currentScopeKey || !directoryPath.trim()) return
    updateRecord(scope, currentScopeKey, conversationId, prev => ({
      ...prev,
      directoryPath,
    }), true)
    confirmDirectorySelection(value => value + 1)
  }, [scope, currentScopeKey, updateRecord])

  const onChooseSessionDirectory = useCallback((conversationId: string) => {
    if (!scope || !currentScopeKey) return
    const targetScope = scope
    const targetKey = currentScopeKey
    void host.chooseDirectory().then(picked => {
      if (!picked || !stillActive(targetKey)) return
      updateRecord(targetScope, targetKey, conversationId, prev => ({
        ...prev,
        directoryPath: picked,
      }), true)
      // 从个人记录恢复的同一路径也需要原生选择器重新授权执行。
      confirmDirectorySelection(value => value + 1)
    }).catch(() => {})
  }, [scope, currentScopeKey, host, updateRecord])

  const appendLocalAttachments = useCallback((conversationId: string, choose: () => Promise<readonly string[]>) => {
    if (!scope || !currentScopeKey) return
    const targetScope = scope
    const targetKey = currentScopeKey
    void choose().then(picked => {
      if (picked.length === 0 || !stillActive(targetKey)) return
      updateRecord(targetScope, targetKey, conversationId, prev => ({
        ...prev,
        personal: applyConversationPersonalChange(prev.personal, {
          kind: "draft-attachments",
          attachmentIds: mergeAttachmentPaths(prev.personal.draft.attachmentIds, picked),
        }),
      }), true)
    }).catch(() => {})
  }, [scope, currentScopeKey, updateRecord])

  const onChooseLocalFiles = useCallback((conversationId: string) => {
    appendLocalAttachments(conversationId, () => host.chooseFiles())
  }, [appendLocalAttachments, host])

  const onChooseLocalDirectories = useCallback((conversationId: string) => {
    appendLocalAttachments(conversationId, () => host.chooseContextDirectories())
  }, [appendLocalAttachments, host])

  const onPersonalChange = useCallback((targetConvScope: ConversationScope, change: Parameters<typeof applyConversationPersonalChange>[1]) => {
    if (!scope || !currentScopeKey) return
    if (targetConvScope.workspaceId !== scope.workspaceId || targetConvScope.accountId !== scope.accountId) return
    updateRecord(scope, currentScopeKey, targetConvScope.conversationId, prev => ({
      ...prev,
      personal: applyConversationPersonalChange(prev.personal, change),
    }), true)
  }, [scope, currentScopeKey, updateRecord])

  // 提取当前项目下各会话的内存态供纯模型组装徽标与页面参数。
  const currentSyncStates = useMemo(() => {
    const map: Record<string, SessionSyncState> = {}
    if (!currentScopeKey) return map
    for (const conv of activeConversations) {
      const rec = recordsByKey[makeRecordKey(currentScopeKey, conv.conversationId)]
      if (rec) map[conv.conversationId] = rec.syncState
    }
    return map
  }, [currentScopeKey, activeConversations, recordsByKey])

  const currentPersonalStates = useMemo(() => {
    const map: Record<string, ConversationPersonalState> = {}
    if (!currentScopeKey) return map
    for (const conv of activeConversations) {
      const rec = recordsByKey[makeRecordKey(currentScopeKey, conv.conversationId)]
      if (rec) map[conv.conversationId] = rec.personal
    }
    return map
  }, [currentScopeKey, activeConversations, recordsByKey])

  const currentDirectories = useMemo(() => {
    const map: Record<string, string | null> = {}
    if (!currentScopeKey) return map
    for (const conv of activeConversations) {
      const rec = recordsByKey[makeRecordKey(currentScopeKey, conv.conversationId)]
      if (rec) map[conv.conversationId] = rec.directoryPath
    }
    return map
  }, [currentScopeKey, activeConversations, recordsByKey])

  const currentProviders = useMemo(() => {
    const map: Record<string, string> = {}
    if (!currentScopeKey) return map
    for (const conv of activeConversations) {
      const rec = recordsByKey[makeRecordKey(currentScopeKey, conv.conversationId)]
      if (rec?.providerId) map[conv.conversationId] = rec.providerId
    }
    return map
  }, [currentScopeKey, activeConversations, recordsByKey])

  const currentSentImages = useMemo(() => {
    const map: Record<string, Readonly<Record<string, readonly PersonalDraftImage[]>>> = {}
    if (!currentScopeKey) return map
    for (const conv of activeConversations) {
      const rec = recordsByKey[makeRecordKey(currentScopeKey, conv.conversationId)]
      if (rec?.sentImages) map[conv.conversationId] = rec.sentImages
    }
    return map
  }, [currentScopeKey, activeConversations, recordsByKey])

  const memberById = useMemo(() => {
    const map = new Map<string, UserSummary>()
    for (const member of members) map.set(member.user.id, member.user)
    return map
  }, [members])

  const withDisplayTitles = useCallback((
    conversations: readonly ProjectConversationSummary[],
    targetScope: ProjectNavigationScope | null,
    records: typeof recordsByKey,
    suggestions: typeof agentTitles,
  ) => {
    if (!targetScope) return conversations
    const key = makeScopeKey(targetScope)
    return applyConversationTitleOverrides(conversations, targetScope, conversationId => ({
      customTitle: records[makeRecordKey(key, conversationId)]?.customTitle,
      sessionTitle: suggestions[localExecutionKey({ ...targetScope, conversationId })],
    }))
  }, [])

  const effectiveConversations = useMemo(
    () => withDisplayTitles(activeConversations, scope, recordsByKey, agentTitles),
    [activeConversations, scope, recordsByKey, agentTitles, withDisplayTitles],
  )

  const renameConversation = useCallback(async (conversationId: string, title: string): Promise<string | null> => {
    if (!scope || !stillActive(currentScopeKey) || !listsRef.current[currentScopeKey]?.conversations.some(
      item => item.conversationId === conversationId && item.ownerUserId === scope.accountId,
    )) return "当前会话不可重命名。"

    const loaded = await ensureRecordLoaded(scope, currentScopeKey, conversationId)
    if (!stillActive(currentScopeKey)) return "当前项目已变化。"
    if (!loaded) return "无法读取会话的个人记录，请重试。"
    const result = await persistence.renameConversation({
      kind: "conversation", workspaceId: scope.workspaceId, projectId: scope.projectId, conversationId,
    }, title)
    if (!result.ok) return result.message
    if (mountedRef.current) {
      updateRecord(scope, currentScopeKey, conversationId, previous => ({ ...previous, customTitle: result.value }), false)
    }
    return null
  }, [scope, currentScopeKey, persistence, ensureRecordLoaded, updateRecord])

  const navigationSource: NavigationSessionSource = useMemo(() => {
    if (!scope || !currentScopeKey) {
      return { entries: [], availability: { state: "unavailable", message: "请先选择项目。" }, retry: () => {} }
    }
    const status = activeList?.status ?? "loading"
    return {
      entries: toNavigationSessionEntries(effectiveConversations, userId, currentSyncStates),
      availability: status === "failed"
        ? { state: "failed", message: activeList?.error || "无法加载会话列表。" }
        : status === "ready"
          ? { state: "ready" }
          : { state: "loading" },
      retry: () => { void refreshMetadata(scope) },
      renameConversation,
    }
  }, [scope, currentScopeKey, activeList, effectiveConversations, userId, currentSyncStates, refreshMetadata, renameConversation])

  const selectedConv = selectedConversationId
    ? effectiveConversations.find(item => item.conversationId === selectedConversationId) ?? null
    : null
  const selectedIsLocal = Boolean(
    selectedConv && classifyConversation(selectedConv, userId) === "local",
  )
  const selectedDirectoryPath = selectedIsLocal && selectedConversationId
    ? (currentDirectories[selectedConversationId] ?? null)
    : null
  const commitAcceptedDraft = useCallback((source: ProjectNavigationScope, id: string, revision: number) => {
    if (!mountedRef.current) return
    updateRecord(source, makeScopeKey(source), id, previous => ({
      ...previous,
      personal: applyConversationPersonalChange(previous.personal, { kind: "clear-draft", expectedRevision: revision }),
    }), true)
  }, [updateRecord])
  const handleProviderChange = useCallback((execScope: LocalExecutionScope, providerId: string) => {
    const trimmed = providerId.trim()
    if (!trimmed || !scope || !currentScopeKey) return
    if (
      execScope.accountId !== scope.accountId
      || execScope.workspaceId !== scope.workspaceId
      || execScope.projectId !== scope.projectId
    ) return
    const recKey = makeRecordKey(currentScopeKey, execScope.conversationId)
    const current = recordsRef.current[recKey]
    if (!current?.loaded || current.providerId === trimmed) return
    updateRecord(scope, currentScopeKey, execScope.conversationId, prev => (
      prev.providerId === trimmed ? prev : { ...prev, providerId: trimmed }
    ), true)
  }, [scope, currentScopeKey, updateRecord])
  const handleTurnUploaded = useCallback((
    execScope: LocalExecutionScope,
    userSequence: number,
    images: readonly PersonalDraftImage[],
  ) => {
    if (!mountedRef.current || !images.length || userSequence < 1 || !scope || !currentScopeKey) return
    if (
      execScope.accountId !== scope.accountId
      || execScope.workspaceId !== scope.workspaceId
      || execScope.projectId !== scope.projectId
    ) return
    const seqKey = String(userSequence)
    updateRecord(scope, currentScopeKey, execScope.conversationId, prev => {
      if (!prev.loaded) return prev
      const merged = boundSentImages({
        ...(prev.sentImages ?? {}),
        [seqKey]: images,
      })
      return {
        ...prev,
        ...(merged ? { sentImages: merged } : {}),
      }
    }, true)
  }, [scope, currentScopeKey, updateRecord])
  const refreshWorkspaceRef = useRef<((source: ProjectNavigationScope, id: string) => Promise<void>) | null>(null)
  const refreshExecutionWorkspace = useCallback((source: ProjectNavigationScope, id: string) => {
    if (!mountedRef.current) return
    void refreshWorkspaceRef.current?.(source, id)
  }, [])
  const localExecutionPort = useLocalExecution(
    localExecution, scope, selectedIsLocal ? selectedConversationId : null,
    selectedDirectoryPath, directorySelectionRevision, memberById.get(userId)?.userName ?? "我",
    commitAcceptedDraft,
    refreshExecutionWorkspace,
    currentProviders,
    handleSessionTitleChange,
    handleProviderChange,
    handleTurnUploaded,
  )

  const selectedRecKey = currentScopeKey && selectedConversationId ? makeRecordKey(currentScopeKey, selectedConversationId) : ""
  const selectedRecord = selectedRecKey ? recordsByKey[selectedRecKey] : undefined
  useEffect(() => {
    if (!selectedConv || !selectedIsLocal || !selectedRecord?.loaded) return
    if (selectedConv.syncedSequence <= selectedRecord.syncState.localSyncedSequence) return
    if (selectedRecord.syncState.syncing || selectedRecord.syncState.syncError) return
    void syncConversation(selectedConv.conversationId)
  }, [selectedConv, selectedIsLocal, selectedRecord, syncConversation])

  const selectedAvailability = selectedIsLocal && selectedConversationId
    ? localExecutionPort?.getAvailability(selectedConversationId)
    : undefined
  useEffect(() => {
    const pending = pendingAutoSendRef.current
    if (pending && pending.scopeKey !== currentScopeKey) { pendingAutoSendRef.current = null; return }
    if (!pending || pending.conversationId !== selectedConversationId || !selectedIsLocal) return
    if (!localExecutionPort?.send || !selectedAvailability?.available) return
    pendingAutoSendRef.current = null
    void localExecutionPort.send({
      scope: pending.scope,
      conversationId: pending.conversationId,
      directoryPath: pending.directoryPath,
      draftRevision: pending.draftRevision,
      text: pending.text,
      referenceIds: pending.referenceIds,
      attachmentIds: [],
    })
  }, [currentScopeKey, selectedConversationId, selectedIsLocal, localExecutionPort, selectedAvailability?.available])

  const localDir = useLocalDirectory({
    localDirectory,
    persistence,
    scope,
    selectedConversationId,
    selectedDirectoryPath,
    selectedIsLocal,
  })

  refreshWorkspaceRef.current = localDir.refreshWorkspace
  const [draftToReveal, setDraftToReveal] = useState<{ scopeKey: string; deviceId: string; id: string } | null>(null)
  useLayoutEffect(() => {
    if (!draftToReveal) return
    if (!scope || draftToReveal.scopeKey !== currentScopeKey || draftToReveal.deviceId !== userId
      || draftToReveal.id !== selectedConversationId || !selectedIsLocal) {
      setDraftToReveal(null)
      return
    }
    // 文件页签可能仍在恢复。等恢复完成才选中会话页签，避免旧的活动文件覆盖这次定位。
    const runtime = localDir.getRuntime(scope, draftToReveal.id)
    if (!runtime.loaded) return
    if (runtime.personal.activeCentral !== null) localDir.selectConversationCentralTab(scope, draftToReveal.id)
    setDraftToReveal(null)
  }, [draftToReveal, scope, currentScopeKey, userId, selectedConversationId, selectedIsLocal, localDir])

  const currentDraft = (currentScopeKey ? draftsByScope[currentScopeKey]?.value : undefined) ?? EMPTY_NEW_DRAFT
  const canCreateConversation = Boolean(scope && draftsByScope[currentScopeKey]?.loaded)
  const createBlockedReason = canCreateConversation ? undefined : "正在恢复新建草稿，请稍候。"
  const recentDirectories = useMemo(() => {
    const unique: string[] = []
    const pushIfNew = (dir: string | null | undefined) => {
      const trimmed = dir?.trim()
      if (trimmed && !unique.includes(trimmed)) unique.push(trimmed)
    }
    pushIfNew(currentDraft.directoryPath)
    for (const dir of Object.values(currentDirectories)) pushIfNew(dir)
    return unique.slice(0, 6)
  }, [currentDraft.directoryPath, currentDirectories])

  const rendering: RenderingActions = useMemo(() => ({
    copyText: text => host.copyText(text),
    openExternal: href => host.openExternal(href),
  }), [host])

  const pageController: SessionPageController = useMemo(() => ({
    projectName,
    currentUserId: userId,
    conversations: effectiveConversations,
    syncStates: currentSyncStates,
    personalStates: currentPersonalStates,
    sentImagesByConversation: currentSentImages,
    directories: currentDirectories,
    recentDirectories,
    newDraft: currentDraft,
    newSessionBusy,
    canCreateConversation,
    createBlockedReason,
    newSessionError,
    newProviderId,
    execution: localExecutionPort ?? execution ?? defaultExecutionPort,
    rendering,
    resolveOwner: ownerId => memberById.get(ownerId),
    resolveOwnerName: ownerId => { const member = memberById.get(ownerId); return member ? `${member.userName}${members.find(m => m.user.id === ownerId)?.status === "removed" ? "（原成员已离开）" : ""}` : `成员 (${ownerId.slice(0, 6)})` },
    onChooseNewDirectory,
    onSelectNewDirectory,
    onSelectNewProvider: providerId => setNewProviderId(providerId),
    onNewDraftChange,
    onStartNewSession: () => { void onStartNewSession() },
    onChooseSessionDirectory,
    onSelectSessionDirectory,
    onChooseLocalFiles,
    onChooseLocalDirectories,
    getGitSummary: conversationId => (scope ? localDir.getGitSummary(scope, conversationId) : null),
    onOpenChangesPanel: conversationId => {
      if (!scope) return
      localDir.openChangesPanel(scope, conversationId)
      onOpenRightPanel?.()
    },
    onRefreshGitStatus: conversationId => {
      if (scope) localDir.refreshGitStatus(scope, conversationId)
    },
    onSyncConversation: conversationId => { void syncConversation(conversationId) },
    onRefreshBrief: conversationId => { void refreshBrief(conversationId) },
    onPersonalChange,
    onRequestFileCandidates: async (targetConvScope, targetProject, request) =>
      localDir.requestFileCandidates(
        {
          namespace: targetConvScope.namespace,
          accountId: targetConvScope.accountId,
          workspaceId: targetConvScope.workspaceId,
          projectId: targetProject.projectId,
        },
        targetConvScope.conversationId,
        request,
      ),
    onOpenFile: (targetConvScope, targetProject, relativePath, destination, lineRange) => {
      const mode = destination === "preview" ? "preview" : "central"
      localDir.openFileTab(
        {
          namespace: targetConvScope.namespace,
          accountId: targetConvScope.accountId,
          workspaceId: targetConvScope.workspaceId,
          projectId: targetProject.projectId,
        },
        targetConvScope.conversationId,
        relativePath,
        mode,
        "code",
        lineRange,
      )
      if (mode === "preview") onOpenRightPanel?.()
    },
    getCentralFiles: ({ scope: pageScope, conversation }): SessionCentralFilesState => {
      const central = localDir.getCentralState(pageScope, conversation.conversationId)
      return {
        uiScope: {
          namespace: pageScope.namespace,
          accountId: pageScope.accountId,
          workspaceId: pageScope.workspaceId,
          deviceId: conversation.ownerUserId,
          projectId: pageScope.projectId,
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
        onSelectConversation: () => localDir.selectConversationCentralTab(pageScope, conversation.conversationId),
        onSelectFile: path => localDir.selectCentralFileTab(pageScope, conversation.conversationId, path),
        onCloseFile: path => localDir.closeCentralFileTab(pageScope, conversation.conversationId, path),
        onRefreshFile: path => localDir.refreshFile(pageScope, conversation.conversationId, path),
        onSetMode: mode => localDir.setCentralMode(pageScope, conversation.conversationId, mode),
        onOpenDiffFile: path => localDir.openDiffFile(pageScope, conversation.conversationId, path),
        onSaveScroll: (area, path, top, left) =>
          localDir.savePosition(pageScope, conversation.conversationId, area, path, top, left),
      }
    },
    renderLocalRight: ({ scope: pageScope, conversation, slot }) => {
      const dirPath = currentDirectories[conversation.conversationId] ?? null
      const runtime = localDir.getRuntime(pageScope, conversation.conversationId)
      const dockProps = localDir.buildDockProps({
        scope: pageScope,
        conversationId: conversation.conversationId,
        deviceId: conversation.ownerUserId,
        projectName,
        directoryPath: dirPath,
        slot,
      })
      return createElement(SessionRightDock, {
        directoryPath: dirPath,
        bindingError: runtime.directory.error,
        dockProps,
        onChooseDirectory: () => onChooseSessionDirectory(conversation.conversationId),
        onRefreshBind: () => onChooseSessionDirectory(conversation.conversationId),
      })
    },
  }), [
    projectName,
    userId,
    effectiveConversations,
    currentSyncStates,
    currentPersonalStates,
    currentDirectories,
    currentDraft,
    newSessionBusy,
    canCreateConversation,
    createBlockedReason,
    newSessionError,
    newProviderId,
    execution,
    localExecutionPort,
    rendering,
    memberById,
    onChooseNewDirectory,
    onSelectNewDirectory,
    onNewDraftChange,
    onStartNewSession,
    onChooseSessionDirectory,
    onSelectSessionDirectory,
    onChooseLocalFiles,
    onChooseLocalDirectories,
    syncConversation,
    refreshBrief,
    onPersonalChange,
    localDir,
    scope,
    recentDirectories,
    onOpenRightPanel,
  ])

  const listProjectConversations = useCallback<SessionIntegrationApi["listProjectConversations"]>(targetScope => {
    const targetKey = makeScopeKey(targetScope)
    if (!stillActive(targetKey)) return EMPTY_CONVERSATIONS
    const base = (listsRef.current[targetKey]?.conversations ?? EMPTY_CONVERSATIONS)
      .filter(item => item.projectId === targetScope.projectId)
    return withDisplayTitles(base, targetScope, recordsRef.current, agentTitlesRef.current)
  }, [withDisplayTitles])

  const listMyLocalConversations = useCallback<SessionIntegrationApi["listMyLocalConversations"]>(targetScope => {
    return listProjectConversations(targetScope).filter(item => classifyConversation(item, userId) === "local")
  }, [listProjectConversations, userId])

  const applyReferenceDraft = useCallback<SessionIntegrationApi["applyReferenceDraft"]>(async (targetScope, change) => {
    const targetKey = makeScopeKey(targetScope)
    const isCurrent = () => activeDraftContext.current === draftContext
      && draftContext.currentScopeKey === targetKey
      && draftContext.userId === targetScope.deviceId
      && draftContext.selectedConversationId === targetScope.conversationId
      && (targetScope.conversationId === null
        || listProjectConversations(targetScope).some(item => item.conversationId === targetScope.conversationId))
    if (!isCurrent()) return { ok: false, message: "发起会话已变化，请重新选择引用。" }

    const target = change.kind === "add" ? change.target : { kind: "existing" as const, conversationId: targetScope.conversationId }
    let conversationId = target.kind === "existing" ? target.conversationId : target.preparedConversationId
    if (target.kind === "new" && !conversationId) {
      const result = await registerLocalConversation(targetScope, "新会话", target.requestId)
      if (!result.ok) return result
      conversationId = result.conversation.conversationId
      if (isCurrent()) includeRegisteredConversation(targetKey, result.conversation)
    }

    if (!conversationId) return { ok: false, message: "无法确认目标会话，请重新选择。" }
    const preparedConversationId = target.kind === "new" ? conversationId : undefined
    const failure = (message: string) => ({
      ok: false as const, message, ...(preparedConversationId ? { preparedConversationId } : {}),
    })
    const hasLocalTarget = () => listMyLocalConversations(targetScope).some(item => item.conversationId === conversationId)
    if (!isCurrent() || !hasLocalTarget()) return failure("目标会话已不可用，请重新选择。")

    await ensureRecordLoaded(targetScope, targetKey, conversationId)
    if (!isCurrent() || !hasLocalTarget()) return failure("目标会话已不可用，请重新选择。")

    // 在恢复完成后读最新值，将片段移除和引用变更放在同一次个人记录更新中。
    const record = recordsRef.current[makeRecordKey(targetKey, conversationId)]
    if (!record?.loaded) return failure(record?.loadError ?? "无法恢复目标草稿，请重试。")
    const previous = record.personal.draft
    const merged = mergeReferenceDraft(previous, change, conversationId === targetScope.conversationId ? conversationId : "")
    if (!merged) return failure("原引用已移除，请重新选择。")
    const initialText = change.kind === "add" ? change.initialText : undefined
    const text = initialText
      ? (merged.text ? `${merged.text}\n\n${initialText}` : initialText)
      : merged.text
    const draft = {
      ...merged,
      text,
      ...(initialText ? { selectionStart: text.length, selectionEnd: text.length } : {}),
    }
    updateRecord(targetScope, targetKey, conversationId, current => ({
      ...current,
      directoryPath: current.directoryPath ?? (target.kind === "new" ? target.directory : null),
      personal: { ...current.personal, draft },
    }), true)
    return { ok: true, value: { conversationId, draftRevision: draft.revision } }
  }, [
    draftContext,
    listProjectConversations,
    listMyLocalConversations,
    registerLocalConversation,
    includeRegisteredConversation,
    ensureRecordLoaded,
    updateRecord,
  ])

  const applyNewSessionReference = useCallback<SessionIntegrationApi["applyNewSessionReference"]>(async (origin, change) => {
    const key = makeScopeKey(origin)
    if (activeDraftContext.current !== draftContext || key !== currentScopeKey
      || origin.accountId !== userId || origin.deviceId !== userId || origin.conversationId !== null) {
      return { ok: false, message: "新建草稿范围已变化，请重新选择。" }
    }
    const entry = draftsRef.current[key]
    if (!entry?.loaded) return { ok: false, message: "新建草稿尚未恢复，请稍后重试。" }
    const draft = mergeReferenceDraft(newSessionConversationDraft(entry.value), change, NEW_SESSION_DRAFT_ID)
    if (!draft) return { ok: false, message: "原引用已移除，请重新选择。" }
    pendingRequestRef.current = null
    saveDraftValue(origin, key, {
      ...entry.value, draftText: draft.text, referenceIds: draft.referenceIds, revision: draft.revision,
      selectionStart: draft.selectionStart, selectionEnd: draft.selectionEnd,
    })
    return { ok: true, value: { draftRevision: draft.revision } }
  }, [draftContext, currentScopeKey, userId, saveDraftValue])

  const integration: SessionIntegrationApi = useMemo(() => ({
    refreshMetadata,
    listProjectConversations,
    listMyLocalConversations,
    applyReferenceDraft,
    applyNewSessionReference,
    revealReferenceDraft: (targetScope, id) => {
      setDraftToReveal({ scopeKey: makeScopeKey(targetScope), deviceId: targetScope.deviceId, id })
    },
  }), [refreshMetadata, listProjectConversations, listMyLocalConversations, applyReferenceDraft, applyNewSessionReference])

  return { navigationSource, pageController, integration }
}
