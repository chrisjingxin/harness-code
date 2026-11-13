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
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  DesktopHost,
  DeviceSummary,
  LocalDirectoryHost,
  MemberSummary,
  ProjectConversationHost,
} from "@workbench/contracts"
import type { ConversationPersonalState, ConversationScope, RenderingActions } from "@workbench/ui"
import type { ConversationPersonal, ProjectDraftPersonal } from "../../../personal-host.js"
import type { PersonalPersistence } from "../../personal-persistence.js"
import type { NavigationSessionSource, ProjectNavigationScope } from "../project-navigation/contracts.js"
import type {
  LocalSessionExecutionPort,
  NewSessionDraft,
  ProjectConversationSummary,
  SessionExternalHooks,
  SessionIntegrationApi,
  SessionSyncState,
} from "./contracts.js"
import { SessionRightDock } from "./session-center.js"
import type { SessionCentralFilesState } from "./session-center.js"
import {
  boundCachedMessages,
  classifyConversation,
  emptySyncState,
  mergeIncrementalHistory,
  toNavigationSessionEntries,
} from "./session-model.js"
import {
  EMPTY_PERSONAL_STATE,
  applyConversationPersonalChange,
  createSessionPageProvider,
} from "./session-provider.js"
import { useLocalDirectory } from "./use-local-directory.js"

const HISTORY_PAGE_LIMIT = 200
const MAX_HISTORY_PAGES = 50
const EMPTY_CONVERSATIONS: ProjectConversationSummary[] = []
const EMPTY_NEW_DRAFT: NewSessionDraft = { directoryPath: null, draftText: "" }

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
  readonly syncState: SessionSyncState
}

const DEFAULT_RECORD: ConversationRecordState = {
  loaded: false,
  loadError: null,
  personal: EMPTY_PERSONAL_STATE,
  directoryPath: null,
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

function personalFromSaved(saved: ConversationPersonal | null): ConversationPersonalState {
  if (!saved) return EMPTY_PERSONAL_STATE
  return {
    scroll: saved.scroll,
    expandedTools: [...saved.expandedTools],
    expandedOutputs: [...saved.expandedOutputs],
    draft: { ...saved.draft },
    interactions: {},
  }
}

function toPersistablePersonal(
  personal: ConversationPersonalState,
  directoryPath: string | null,
  syncState: SessionSyncState,
): ConversationPersonal {
  const { interactions: _ignored, ...rest } = personal
  const hasSyncData = syncState.localSyncedSequence > 0 || syncState.messages.length > 0
  const bounded = hasSyncData ? boundCachedMessages(syncState.messages) : null
  return {
    ...rest,
    localDirectoryPath: directoryPath,
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
  readonly persistence: PersonalPersistence
  readonly scope: ProjectNavigationScope | null
  readonly projectName: string
  readonly userId: string
  readonly localDeviceId: string | null
  readonly localDeviceName?: string
  readonly localDeviceBlockedReason?: string
  readonly members: readonly MemberSummary[]
  readonly devices: readonly DeviceSummary[]
  readonly selectedConversationId: string | null
  readonly hooks?: SessionExternalHooks
  readonly execution?: LocalSessionExecutionPort
  readonly onOpenConversation?: (conversation: ProjectConversationSummary) => void
  readonly onOpenNewSessionPage?: () => void
}

/** 协调当前项目的会话元数据列表、按需正文增量拉取、草稿与个人同步缓存持久化。 */
export function useProjectSessions(options: UseProjectSessionsOptions) {
  const {
    host,
    projectConversations,
    localDirectory,
    persistence,
    scope,
    projectName,
    userId,
    localDeviceId,
    localDeviceName,
    localDeviceBlockedReason,
    members,
    devices,
    selectedConversationId,
    hooks,
    execution,
    onOpenConversation,
    onOpenNewSessionPage,
  } = options

  const currentScopeKey = makeScopeKey(scope)
  const activeScopeKeyRef = useRef(currentScopeKey)
  activeScopeKeyRef.current = currentScopeKey
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
  const pendingRequestRef = useRef<{ signature: string; requestId: string } | null>(null)
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
    void persistence.load({
      kind: "projectDraft",
      workspaceId: targetScope.workspaceId,
      projectId: targetScope.projectId,
    }).then(result => {
      if (!stillActive(targetKey)) return
      const saved = result.ok ? result.value.data as ProjectDraftPersonal | null : null
      setDraftsByScope(prev => ({
        ...prev,
        [targetKey]: {
          loaded: result.ok,
          value: saved ?? EMPTY_NEW_DRAFT,
        },
      }))
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
        setRecordsByKey(prev => ({ ...prev, [recKey]: failedRecord }))
        return null
      }
      const saved = result.value.data as ConversationPersonal | null
      const loadedRecord: ConversationRecordState = {
        loaded: true,
        loadError: null,
        personal: personalFromSaved(saved),
        directoryPath: saved?.localDirectoryPath ?? null,
        syncState: syncStateFromPersonal(saved),
      }
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

  // 启动或切换项目后预加载已有服务端水位的本地同步缓存（只读本地 PersonalStore，绝不触发 /history），保证重启后左栏立即保留「已同步 / 有更新」状态。
  useEffect(() => {
    if (!scope || !currentScopeKey || activeConversations.length === 0) return
    const pending = activeConversations
      .filter(item => item.syncedSequence > 0)
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
        toPersistablePersonal(next.personal, next.directoryPath, next.syncState),
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
        currentSequence = merged.syncedSequence
        reportedWatermark = Math.max(reportedWatermark, res.value.syncedSequence)
        pageCount += 1

        if (
          res.value.messages.length === HISTORY_PAGE_LIMIT
          && currentSequence < res.value.syncedSequence
          && pageCount < MAX_HISTORY_PAGES
        ) {
          cursor = currentSequence
          continue
        }
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
      pendingRequestRef.current = null
      setNewSessionError(null)
      const currentDraft = draftsRef.current[targetKey]?.value ?? EMPTY_NEW_DRAFT
      saveDraftValue(targetScope, targetKey, { ...currentDraft, directoryPath: picked })
    }).catch(() => {})
  }, [scope, currentScopeKey, host, saveDraftValue])

  const onNewDraftChange = useCallback((text: string) => {
    if (!scope || !currentScopeKey) return
    pendingRequestRef.current = null
    setNewSessionError(null)
    const currentDraft = draftsRef.current[currentScopeKey]?.value ?? EMPTY_NEW_DRAFT
    saveDraftValue(scope, currentScopeKey, { ...currentDraft, draftText: text })
  }, [scope, currentScopeKey, saveDraftValue])

  const onStartNewSession = useCallback(async () => {
    if (!scope || !currentScopeKey || !localDeviceId || creatingRef.current) return
    const targetScope = scope
    const targetKey = currentScopeKey
    const currentDraft = draftsRef.current[targetKey]?.value ?? EMPTY_NEW_DRAFT
    const chosenDir = currentDraft.directoryPath
    const trimmedPrompt = currentDraft.draftText.trim()
    if (!chosenDir || !trimmedPrompt) return

    const signature = `${targetKey}\0${localDeviceId}\0${chosenDir}\0${trimmedPrompt}`
    if (!pendingRequestRef.current || pendingRequestRef.current.signature !== signature) {
      pendingRequestRef.current = { signature, requestId: crypto.randomUUID() }
    }
    const { requestId } = pendingRequestRef.current

    creatingRef.current = true
    setNewSessionBusy(true)
    setNewSessionError(null)
    try {
      const res = await projectConversations.registerConversation(
        targetScope.workspaceId,
        targetScope.projectId,
        {
          deviceId: localDeviceId,
          title: deriveSessionTitle(trimmedPrompt),
          requestId,
        },
      )
      if (!stillActive(targetKey)) return
      if (!res.ok) {
        setNewSessionError(res.error.message)
        return
      }

      const created = res.value.conversation
      pendingRequestRef.current = null
      const currentList = listsRef.current[targetKey] ?? { status: "ready" as const, error: "", conversations: [] }
      const deduped = currentList.conversations.filter(item => item.conversationId !== created.conversationId)
      const nextList: ScopeListState = { status: "ready", error: "", conversations: [created, ...deduped] }
      listsRef.current = { ...listsRef.current, [targetKey]: nextList }
      setListsByScope(prev => ({ ...prev, [targetKey]: nextList }))

      await ensureRecordLoaded(targetScope, targetKey, created.conversationId)
      if (!stillActive(targetKey)) return
      updateRecord(targetScope, targetKey, created.conversationId, prev => ({
        ...prev,
        loaded: true,
        directoryPath: chosenDir,
        personal: {
          ...prev.personal,
          draft: {
            ...prev.personal.draft,
            text: currentDraft.draftText,
            selectionStart: currentDraft.draftText.length,
            selectionEnd: currentDraft.draftText.length,
            revision: prev.personal.draft.revision + 1,
          },
        },
      }), true)

      saveDraftValue(targetScope, targetKey, EMPTY_NEW_DRAFT)
      onOpenConversation?.(created)
    } finally {
      creatingRef.current = false
      if (mountedRef.current) setNewSessionBusy(false)
    }
  }, [
    scope,
    currentScopeKey,
    localDeviceId,
    projectConversations,
    ensureRecordLoaded,
    updateRecord,
    saveDraftValue,
    onOpenConversation,
  ])

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
    }).catch(() => {})
  }, [scope, currentScopeKey, host, updateRecord])

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

  const memberNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const member of members) map.set(member.user.id, member.user.userName)
    return map
  }, [members])

  const deviceNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const device of devices) map.set(device.deviceId, device.name)
    return map
  }, [devices])

  const navigationSource: NavigationSessionSource = useMemo(() => {
    if (!scope || !currentScopeKey) {
      return { entries: [], availability: { state: "unavailable", message: "请先选择项目。" }, retry: () => {} }
    }
    const status = activeList?.status ?? "loading"
    return {
      entries: toNavigationSessionEntries(activeConversations, userId, localDeviceId, currentSyncStates),
      availability: status === "failed"
        ? { state: "failed", message: activeList?.error || "无法加载会话列表。" }
        : status === "ready"
          ? { state: "ready" }
          : { state: "loading" },
      retry: () => { void refreshMetadata(scope) },
    }
  }, [scope, currentScopeKey, activeList, activeConversations, userId, localDeviceId, currentSyncStates, refreshMetadata])

  const selectedConv = selectedConversationId
    ? activeConversations.find(item => item.conversationId === selectedConversationId) ?? null
    : null
  const selectedIsLocal = Boolean(
    selectedConv && classifyConversation(selectedConv, userId, localDeviceId) === "local",
  )
  const selectedDirectoryPath = selectedIsLocal && selectedConversationId
    ? (currentDirectories[selectedConversationId] ?? null)
    : null

  const localDir = useLocalDirectory({
    localDirectory,
    persistence,
    scope,
    selectedConversationId,
    selectedDirectoryPath,
    selectedIsLocal,
  })

  const currentDraft = (currentScopeKey ? draftsByScope[currentScopeKey]?.value : undefined) ?? EMPTY_NEW_DRAFT
  const canCreateConversation = Boolean(localDeviceId)
  const createBlockedReason = canCreateConversation
    ? undefined
    : (localDeviceBlockedReason || "本机设备尚未在当前团队登记（或已吊销），暂不可新建共享会话；可先选择目录并保留草稿。")

  const rendering: RenderingActions = useMemo(() => ({
    copyText: text => host.copyText(text),
  }), [host])

  const provider = useMemo(() => createSessionPageProvider({
    projectName,
    currentUserId: userId,
    localDeviceId,
    ...(localDeviceName ? { localDeviceName } : {}),
    conversations: activeConversations,
    syncStates: currentSyncStates,
    personalStates: currentPersonalStates,
    directories: currentDirectories,
    newDraft: currentDraft,
    newSessionBusy,
    canCreateConversation,
    createBlockedReason,
    newSessionError,
    execution: execution ?? defaultExecutionPort,
    rendering,
    hooks,
    resolveOwnerName: ownerId => memberNameById.get(ownerId) ?? `成员 (${ownerId.slice(0, 6)})`,
    resolveDeviceName: deviceId => deviceNameById.get(deviceId),
    onChooseNewDirectory,
    onNewDraftChange,
    onStartNewSession: () => { void onStartNewSession() },
    onChooseSessionDirectory,
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
    onOpenFile: (targetConvScope, targetProject, relativePath, destination) => {
      localDir.openFileTab(
        {
          namespace: targetConvScope.namespace,
          accountId: targetConvScope.accountId,
          workspaceId: targetConvScope.workspaceId,
          projectId: targetProject.projectId,
        },
        targetConvScope.conversationId,
        relativePath,
        destination,
      )
    },
    getCentralFiles: ({ scope: pageScope, conversation }): SessionCentralFilesState => {
      const central = localDir.getCentralState(pageScope, conversation.conversationId)
      return {
        uiScope: {
          namespace: pageScope.namespace,
          accountId: pageScope.accountId,
          workspaceId: pageScope.workspaceId,
          deviceId: conversation.deviceId,
          projectId: pageScope.projectId,
        },
        tabs: central.centralTabs,
        activeCentral: central.activeCentral,
        files: central.files,
        refreshGate: central.refreshGate,
        positions: central.positions,
        rendering,
        onSelectConversation: () => localDir.selectConversationCentralTab(pageScope, conversation.conversationId),
        onSelectFile: path => localDir.selectCentralFileTab(pageScope, conversation.conversationId, path),
        onCloseFile: path => localDir.closeCentralFileTab(pageScope, conversation.conversationId, path),
        onRefreshFile: path => localDir.refreshFile(pageScope, conversation.conversationId, path),
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
        deviceId: conversation.deviceId,
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
    localDeviceId,
    localDeviceName,
    activeConversations,
    currentSyncStates,
    currentPersonalStates,
    currentDirectories,
    currentDraft,
    newSessionBusy,
    canCreateConversation,
    createBlockedReason,
    newSessionError,
    execution,
    rendering,
    hooks,
    memberNameById,
    deviceNameById,
    onChooseNewDirectory,
    onNewDraftChange,
    onStartNewSession,
    onChooseSessionDirectory,
    syncConversation,
    refreshBrief,
    onPersonalChange,
    localDir,
  ])

  const prepareMySession = useCallback<SessionIntegrationApi["prepareMySession"]>(prepareOptions => {
    const targetKey = makeScopeKey(prepareOptions.scope)
    if (!targetKey || !stillActive(targetKey)) return

    if (prepareOptions.targetConversationId) {
      const targetConv = (listsRef.current[targetKey]?.conversations ?? EMPTY_CONVERSATIONS)
        .find(item => item.conversationId === prepareOptions.targetConversationId)
      if (targetConv && classifyConversation(targetConv, userId, localDeviceId) === "local") {
        onOpenConversation?.(targetConv)
        void (async () => {
          const rec = await ensureRecordLoaded(prepareOptions.scope, targetKey, targetConv.conversationId)
          if (!stillActive(targetKey) || !rec) return
          updateRecord(prepareOptions.scope, targetKey, targetConv.conversationId, prev => {
            const nextText = prepareOptions.initialText
              ? (prev.personal.draft.text.trim().length > 0
                  ? `${prev.personal.draft.text}\n${prepareOptions.initialText}`
                  : prepareOptions.initialText)
              : prev.personal.draft.text
            const nextRefs = prepareOptions.referenceId && !prev.personal.draft.referenceIds.includes(prepareOptions.referenceId)
              ? [...prev.personal.draft.referenceIds, prepareOptions.referenceId]
              : prev.personal.draft.referenceIds
            return {
              ...prev,
              personal: {
                ...prev.personal,
                draft: {
                  ...prev.personal.draft,
                  text: nextText,
                  selectionStart: nextText.length,
                  selectionEnd: nextText.length,
                  referenceIds: nextRefs,
                  revision: prev.personal.draft.revision + 1,
                },
              },
            }
          }, true)
        })()
        return
      }
    }

    onOpenNewSessionPage?.()
    if (prepareOptions.initialText) {
      const currentDraftValue = draftsRef.current[targetKey]?.value ?? EMPTY_NEW_DRAFT
      const nextText = currentDraftValue.draftText.trim().length > 0
        ? `${currentDraftValue.draftText}\n${prepareOptions.initialText}`
        : prepareOptions.initialText
      saveDraftValue(prepareOptions.scope, targetKey, {
        ...currentDraftValue,
        draftText: nextText,
      })
    }
  }, [
    userId,
    localDeviceId,
    onOpenConversation,
    onOpenNewSessionPage,
    ensureRecordLoaded,
    updateRecord,
    saveDraftValue,
  ])

  const integration: SessionIntegrationApi = useMemo(() => ({
    refreshMetadata,
    prepareMySession,
    listMyLocalConversations: targetScope => {
      const targetKey = makeScopeKey(targetScope)
      const list = listsRef.current[targetKey]?.conversations ?? EMPTY_CONVERSATIONS
      if (!localDeviceId) return EMPTY_CONVERSATIONS
      return list.filter(item => item.ownerUserId === userId && item.deviceId === localDeviceId)
    },
  }), [refreshMetadata, prepareMySession, localDeviceId, userId])

  return { navigationSource, provider, integration }
}
