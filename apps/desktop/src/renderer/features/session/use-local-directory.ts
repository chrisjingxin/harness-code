/**
 * 本人本机会话目录工作台状态管理（HC-218 停点 3）：
 *
 * 【功能定义】
 * 围绕 `(workspaceId, projectId, conversationId)` 维护用户主动选择的本机工作目录：
 * - 调用 `LocalDirectoryHost` 校验绑定并只读获取目录树、@ 文件候选、文本正文与只读 Git 状态/差异；
 * - 按 `sessionWorkspace` 个人视图持久化右侧开合/宽度/页签、中央文件页签与滚动位置；
 * - 普通非 Git 文件夹平静降级展示无报错说明，所有 Git 写入口（commit/push）保持暂缓禁用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { LocalDirectoryHost, ProjectReadEntry } from "@workbench/contracts"
import type {
  ConversationFileCandidateResult,
  ConversationFileCandidateRequest,
  ProjectActions,
  ProjectAvailability,
  ProjectChangesView,
  ProjectDockProps,
  ProjectFileView,
  ProjectGates,
  ProjectPersonalView,
  ProjectScope,
  ProjectTreeRow,
  ProjectTreeView,
  WorkbenchRightSlot,
} from "@workbench/ui"
import type { ProjectPersonal, ProjectPersonalRecord } from "../../../personal-host.js"
import type { PersonalPersistence } from "../../personal-persistence.js"
import type { ProjectNavigationScope } from "../project-navigation/contracts.js"

const MAX_DOCK_TABS = 12
const MAX_CENTRAL_TABS = 12
const GIT_WRITE_DISABLED_REASON = "Git 写操作已暂缓，当前仅支持只读查看。"
const NON_GIT_MESSAGE = "当前目录不是 Git 仓库，仅提供本地文件浏览；Git 写操作已暂缓。"

type ScrollArea = "central" | "dock" | "tree"

type DirectoryState = {
  readonly status: "idle" | "binding" | "ready" | "error"
  readonly boundPath: string | null
  readonly isGitRepository: boolean
  readonly error: string | null
}

type TreeState = {
  readonly status: "idle" | "loading" | "ready" | "error"
  readonly entriesByDir: Readonly<Record<string, readonly ProjectReadEntry[]>>
  readonly loadingDirs: readonly string[]
  readonly truncatedDirs: readonly string[]
  readonly error: string | null
}

type SessionWorkspaceRuntime = {
  readonly loaded: boolean
  readonly directory: DirectoryState
  readonly personal: ProjectPersonal
  readonly positions: Readonly<Record<string, { area: ScrollArea; path: string; top: number; left: number }>>
  readonly tree: TreeState
  readonly files: Readonly<Record<string, ProjectFileView>>
  readonly changes: ProjectChangesView
}

const DEFAULT_PERSONAL_VIEW: ProjectPersonalView = {
  dockOpen: true,
  dockWidthPx: 340,
  panel: "files",
  selectedPath: null,
  fileTabs: [],
  activeFilePath: null,
  selectedChanges: [],
  commitMessage: "",
}

const DEFAULT_PROJECT_PERSONAL: ProjectPersonal = {
  view: DEFAULT_PERSONAL_VIEW,
  expanded: [],
  centralPaths: [],
  activeCentral: null,
  diffPath: null,
}

const DEFAULT_RUNTIME: SessionWorkspaceRuntime = {
  loaded: false,
  directory: { status: "idle", boundPath: null, isGitRepository: false, error: null },
  personal: DEFAULT_PROJECT_PERSONAL,
  positions: {},
  tree: { status: "idle", entriesByDir: {}, loadingDirs: [], truncatedDirs: [], error: null },
  files: {},
  changes: { status: "loading", busy: false },
}

function makeKey(scope: ProjectNavigationScope, conversationId: string): string {
  return `${scope.namespace}::${scope.accountId}::${scope.workspaceId}::${scope.projectId}::${conversationId}`
}

function posKey(area: ScrollArea, path: string): string {
  return `${area}\0${path}`
}

function basenameOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/")
  return slash >= 0 ? relativePath.slice(slash + 1) : relativePath
}

function sanitizePersonal(raw: ProjectPersonalRecord | null): {
  personal: ProjectPersonal
  positions: SessionWorkspaceRuntime["positions"]
} {
  if (!raw?.personal) {
    return { personal: DEFAULT_PROJECT_PERSONAL, positions: {} }
  }
  const positions: Record<string, { area: ScrollArea; path: string; top: number; left: number }> = {}
  for (const item of raw.positions ?? []) {
    positions[posKey(item.area, item.path)] = item
  }
  return {
    personal: {
      view: {
        ...DEFAULT_PERSONAL_VIEW,
        ...raw.personal.view,
        fileTabs: (raw.personal.view?.fileTabs ?? []).slice(0, MAX_DOCK_TABS),
        selectedChanges: [],
        commitMessage: "",
      },
      expanded: [...(raw.personal.expanded ?? [])],
      centralPaths: (raw.personal.centralPaths ?? []).slice(0, MAX_CENTRAL_TABS),
      activeCentral: raw.personal.activeCentral ?? null,
      diffPath: raw.personal.diffPath ?? null,
    },
    positions,
  }
}

function toPersistRecord(runtime: SessionWorkspaceRuntime): ProjectPersonalRecord {
  return {
    personal: runtime.personal,
    positions: Object.values(runtime.positions).slice(0, 200),
  }
}

function flattenTreeRows(
  entriesByDir: Readonly<Record<string, readonly ProjectReadEntry[]>>,
  expanded: readonly string[],
  loadingDirs: readonly string[],
): ProjectTreeRow[] {
  const expandedSet = new Set(expanded)
  const loadingSet = new Set(loadingDirs)
  const rows: ProjectTreeRow[] = []

  const walk = (directory: string, depth: number) => {
    const entries = entriesByDir[directory] ?? []
    for (const item of entries) {
      const isExpanded = item.expandable && expandedSet.has(item.path)
      rows.push({
        path: item.path,
        name: item.name,
        kind: item.kind,
        depth,
        expanded: isExpanded,
        loading: loadingSet.has(item.path),
        hasChildren: item.expandable,
      })
      if (isExpanded) {
        walk(item.path, depth + 1)
      }
    }
  }
  walk("", 0)
  return rows
}

export type UseLocalDirectoryOptions = {
  readonly localDirectory?: LocalDirectoryHost
  readonly persistence: PersonalPersistence
  readonly scope: ProjectNavigationScope | null
  readonly selectedConversationId: string | null
  readonly selectedDirectoryPath: string | null
  readonly selectedIsLocal: boolean
}

export function useLocalDirectory(options: UseLocalDirectoryOptions) {
  const {
    localDirectory,
    persistence,
    scope,
    selectedConversationId,
    selectedDirectoryPath,
    selectedIsLocal,
  } = options

  const [runtimes, setRuntimes] = useState<Readonly<Record<string, SessionWorkspaceRuntime>>>({})
  const runtimesRef = useRef(runtimes)
  runtimesRef.current = runtimes

  const activeScopeRef = useRef<string | null>(null)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const activeKey = scope && selectedConversationId ? makeKey(scope, selectedConversationId) : null
  activeScopeRef.current = activeKey

  const bindSeqRef = useRef<Record<string, number>>({})
  const fileSeqRef = useRef<Record<string, number>>({})
  const dirSeqRef = useRef<Record<string, number>>({})
  const changesSeqRef = useRef<Record<string, number>>({})

  const mutateRuntime = useCallback((
    targetScope: ProjectNavigationScope,
    conversationId: string,
    updater: (prev: SessionWorkspaceRuntime) => SessionWorkspaceRuntime,
    persist = false,
  ) => {
    const key = makeKey(targetScope, conversationId)
    const prev = runtimesRef.current[key] ?? DEFAULT_RUNTIME
    const next = updater(prev)
    runtimesRef.current = { ...runtimesRef.current, [key]: next }
    setRuntimes(current => ({ ...current, [key]: next }))
    if (persist && next.loaded) {
      persistence.save(
        {
          kind: "sessionWorkspace",
          workspaceId: targetScope.workspaceId,
          projectId: targetScope.projectId,
          conversationId,
        },
        toPersistRecord(next),
      )
    }
  }, [persistence])

  const loadDirectoryEntries = useCallback(async (
    targetScope: ProjectNavigationScope,
    conversationId: string,
    directory: string,
  ) => {
    if (!localDirectory) return
    const key = makeKey(targetScope, conversationId)
    const seqKey = `${key}\0${directory}`
    const seq = (dirSeqRef.current[seqKey] ?? 0) + 1
    dirSeqRef.current[seqKey] = seq

    mutateRuntime(targetScope, conversationId, prev => ({
      ...prev,
      tree: {
        ...prev.tree,
        status: directory === "" && Object.keys(prev.tree.entriesByDir).length === 0 ? "loading" : prev.tree.status,
        loadingDirs: directory === "" || prev.tree.loadingDirs.includes(directory)
          ? prev.tree.loadingDirs
          : [...prev.tree.loadingDirs, directory],
        error: directory === "" ? null : prev.tree.error,
      },
    }))

    const entries: ProjectReadEntry[] = []
    let cursor: string | undefined
    let truncated = false
    let pageGuard = 0
    while (pageGuard < 20) {
      pageGuard += 1
      const res = await localDirectory.readDirectory(
        targetScope.workspaceId,
        targetScope.projectId,
        conversationId,
        { kind: "listDirectory", directory, ...(cursor ? { cursor } : {}) },
      )
      if (dirSeqRef.current[seqKey] !== seq) return
      if (!res.ok || res.value.kind !== "listDirectory") {
        const message = !res.ok ? res.error.message : "目录读取响应异常。"
        mutateRuntime(targetScope, conversationId, prev => ({
          ...prev,
          tree: {
            ...prev.tree,
            status: directory === "" && Object.keys(prev.tree.entriesByDir).length === 0 ? "error" : prev.tree.status,
            loadingDirs: prev.tree.loadingDirs.filter(item => item !== directory),
            error: message,
          },
        }))
        return
      }
      entries.push(...res.value.value.entries)
      truncated ||= res.value.value.truncated
      if (!res.value.value.nextCursor) break
      cursor = res.value.value.nextCursor
    }

    mutateRuntime(targetScope, conversationId, prev => ({
      ...prev,
      tree: {
        status: "ready",
        entriesByDir: { ...prev.tree.entriesByDir, [directory]: entries },
        loadingDirs: prev.tree.loadingDirs.filter(item => item !== directory),
        truncatedDirs: truncated
          ? (prev.tree.truncatedDirs.includes(directory) ? prev.tree.truncatedDirs : [...prev.tree.truncatedDirs, directory])
          : prev.tree.truncatedDirs.filter(item => item !== directory),
        error: null,
      },
    }))
  }, [localDirectory, mutateRuntime])

  const loadFilePreview = useCallback(async (
    targetScope: ProjectNavigationScope,
    conversationId: string,
    path: string,
  ) => {
    if (!localDirectory) return
    const key = makeKey(targetScope, conversationId)
    const seqKey = `${key}\0${path}`
    const seq = (fileSeqRef.current[seqKey] ?? 0) + 1
    fileSeqRef.current[seqKey] = seq

    const existing = runtimesRef.current[key]?.files[path]
    if (!existing || existing.status !== "ready") {
      mutateRuntime(targetScope, conversationId, prev => ({
        ...prev,
        files: { ...prev.files, [path]: { status: "loading", path } },
      }))
    }

    const res = await localDirectory.readDirectory(
      targetScope.workspaceId,
      targetScope.projectId,
      conversationId,
      { kind: "readPreview", path },
    )
    if (fileSeqRef.current[seqKey] !== seq) return

    if (res.ok && res.value.kind === "readPreview") {
      const value = res.value.value
      mutateRuntime(targetScope, conversationId, prev => ({
        ...prev,
        files: {
          ...prev.files,
          [path]: {
            status: "ready",
            file: { ...value, freshness: "live" },
          },
        },
      }))
      return
    }

    const errCode = !res.ok ? res.error.code : "PROJECT_READ_FAILED"
    const errMsg = !res.ok ? res.error.message : "读取文件失败。"
    mutateRuntime(targetScope, conversationId, prev => {
      const current = prev.files[path]
      if (current?.status === "ready") {
        return {
          ...prev,
          files: { ...prev.files, [path]: { ...current, refreshError: errMsg } },
        }
      }
      if (errCode === "PROJECT_FILE_UNSUPPORTED") {
        return {
          ...prev,
          files: { ...prev.files, [path]: { status: "unsupported", path, reason: errMsg } },
        }
      }
      if (errCode === "PROJECT_LIMIT_EXCEEDED") {
        return {
          ...prev,
          files: { ...prev.files, [path]: { status: "too-large", path, reason: errMsg } },
        }
      }
      return {
        ...prev,
        files: { ...prev.files, [path]: { status: "error", path, message: errMsg } },
      }
    })
  }, [localDirectory, mutateRuntime])

  const loadDiff = useCallback(async (
    targetScope: ProjectNavigationScope,
    conversationId: string,
    snapshot: string,
    path: string,
  ) => {
    if (!localDirectory) return
    const key = makeKey(targetScope, conversationId)
    const seq = (changesSeqRef.current[key] ?? 0) + 1
    changesSeqRef.current[key] = seq

    mutateRuntime(targetScope, conversationId, prev => ({
      ...prev,
      changes: { ...prev.changes, busy: true, message: undefined },
    }))

    const res = await localDirectory.readDirectory(
      targetScope.workspaceId,
      targetScope.projectId,
      conversationId,
      { kind: "gitDiff", snapshot, path },
    )
    if (changesSeqRef.current[key] !== seq) return

    if (res.ok && res.value.kind === "gitDiff") {
      mutateRuntime(targetScope, conversationId, prev => ({
        ...prev,
        changes: {
          ...prev.changes,
          busy: false,
          diff: res.value.kind === "gitDiff" ? res.value.value : undefined,
        },
      }))
      return
    }

    mutateRuntime(targetScope, conversationId, prev => ({
      ...prev,
      changes: {
        ...prev.changes,
        busy: false,
        message: !res.ok ? res.error.message : "读取差异失败。",
      },
    }))
  }, [localDirectory, mutateRuntime])

  const loadGitStatus = useCallback(async (
    targetScope: ProjectNavigationScope,
    conversationId: string,
  ) => {
    if (!localDirectory) return
    const key = makeKey(targetScope, conversationId)
    const seq = (changesSeqRef.current[key] ?? 0) + 1
    changesSeqRef.current[key] = seq

    mutateRuntime(targetScope, conversationId, prev => ({
      ...prev,
      changes: {
        ...prev.changes,
        status: prev.changes.repository ? prev.changes.status : "loading",
        busy: true,
        message: undefined,
      },
    }))

    const res = await localDirectory.readDirectory(
      targetScope.workspaceId,
      targetScope.projectId,
      conversationId,
      { kind: "gitStatus" },
    )
    if (changesSeqRef.current[key] !== seq) return

    if (!res.ok || res.value.kind !== "gitStatus") {
      mutateRuntime(targetScope, conversationId, prev => ({
        ...prev,
        changes: {
          ...prev.changes,
          status: "error",
          busy: false,
          message: !res.ok ? res.error.message : "读取 Git 变更失败。",
        },
      }))
      return
    }

    const value = res.value.value
    if (value.blockedReason && value.files.length === 0) {
      mutateRuntime(targetScope, conversationId, prev => ({
        ...prev,
        changes: {
          status: "ready",
          busy: false,
          message: value.blockedReason ?? NON_GIT_MESSAGE,
        },
      }))
      return
    }

    mutateRuntime(targetScope, conversationId, prev => ({
      ...prev,
      changes: {
        status: "ready",
        busy: false,
        freshness: "live",
        repository: {
          snapshot: value.snapshot,
          branch: value.branch ?? "HEAD (分离)",
          ...(value.head ? { head: value.head } : {}),
          ...(value.upstream ? { upstream: value.upstream } : {}),
          files: value.files,
        },
        ...(prev.changes.diff && value.files.some(f => f.path === prev.changes.diff?.path && f.status !== "D")
          ? { diff: prev.changes.diff.snapshot === value.snapshot ? prev.changes.diff : undefined }
          : {}),
        ...(value.blockedReason ? { message: value.blockedReason } : {}),
      },
    }))
  }, [localDirectory, mutateRuntime])

  // 按需加载 sessionWorkspace 并绑定当前本人本机会话选择的工作目录；以 activeKey 而非 scope 对象引用触发，避免父组件重渲染取消在途绑定造成死循环。
  useEffect(() => {
    const targetScope = scopeRef.current
    if (!targetScope || !activeKey || !selectedConversationId || !selectedIsLocal) return
    const conversationId = selectedConversationId
    const key = makeKey(targetScope, conversationId)
    let cancelled = false

    const syncWorkspace = async () => {
      let runtime = runtimesRef.current[key]
      if (!runtime?.loaded) {
        const res = await persistence.load({
          kind: "sessionWorkspace",
          workspaceId: targetScope.workspaceId,
          projectId: targetScope.projectId,
          conversationId,
        })
        if (cancelled) return
        const restored = res.ok
          ? sanitizePersonal(res.value.data as ProjectPersonalRecord | null)
          : { personal: DEFAULT_PROJECT_PERSONAL, positions: {} }
        mutateRuntime(targetScope, conversationId, prev => ({
          ...prev,
          loaded: true,
          personal: restored.personal,
          positions: restored.positions,
        }))
        runtime = runtimesRef.current[key]
      }

      if (!selectedDirectoryPath || !localDirectory) {
        if (runtime && runtime.directory.boundPath !== null) {
          mutateRuntime(targetScope, conversationId, prev => ({
            ...prev,
            directory: { status: "idle", boundPath: null, isGitRepository: false, error: null },
            tree: DEFAULT_RUNTIME.tree,
            files: {},
            changes: DEFAULT_RUNTIME.changes,
          }))
        }
        return
      }

      if (
        runtime?.directory.status === "ready"
        && runtime.directory.boundPath === selectedDirectoryPath
      ) {
        return
      }

      const bindSeq = (bindSeqRef.current[key] ?? 0) + 1
      bindSeqRef.current[key] = bindSeq
      const switchingDirectory = Boolean(
        runtime?.directory.boundPath && runtime.directory.boundPath !== selectedDirectoryPath,
      )

      mutateRuntime(targetScope, conversationId, prev => ({
        ...prev,
        directory: { status: "binding", boundPath: selectedDirectoryPath, isGitRepository: false, error: null },
        ...(switchingDirectory
          ? {
              personal: { ...DEFAULT_PROJECT_PERSONAL, view: { ...DEFAULT_PERSONAL_VIEW, dockOpen: prev.personal.view.dockOpen, dockWidthPx: prev.personal.view.dockWidthPx } },
              positions: {},
              tree: DEFAULT_RUNTIME.tree,
              files: {},
              changes: DEFAULT_RUNTIME.changes,
            }
          : {}),
      }), switchingDirectory)

      const bindRes = await localDirectory.bindDirectory(
        targetScope.workspaceId,
        targetScope.projectId,
        conversationId,
        selectedDirectoryPath,
      )
      if (cancelled || bindSeqRef.current[key] !== bindSeq) return

      if (!bindRes.ok) {
        mutateRuntime(targetScope, conversationId, prev => ({
          ...prev,
          directory: {
            status: "error",
            boundPath: selectedDirectoryPath,
            isGitRepository: false,
            error: bindRes.error.message,
          },
          tree: { ...prev.tree, status: "error", error: bindRes.error.message },
          changes: { status: "error", busy: false, message: bindRes.error.message },
        }))
        return
      }

      mutateRuntime(targetScope, conversationId, prev => ({
        ...prev,
        directory: {
          status: "ready",
          boundPath: bindRes.value.directoryPath,
          isGitRepository: bindRes.value.isGitRepository,
          error: null,
        },
        changes: bindRes.value.isGitRepository
          ? { status: "loading", busy: false }
          : { status: "ready", busy: false, message: NON_GIT_MESSAGE },
      }))

      const latest = runtimesRef.current[key]
      const dirsToLoad = ["", ...(latest?.personal.expanded ?? [])]
      const filesToLoad = new Set<string>([
        ...(latest?.personal.view.fileTabs.map(tab => tab.path) ?? []),
        ...(latest?.personal.centralPaths ?? []),
      ])
      await Promise.all([
        ...dirsToLoad.map(dir => loadDirectoryEntries(targetScope, conversationId, dir)),
        ...Array.from(filesToLoad).map(path => loadFilePreview(targetScope, conversationId, path)),
        ...(bindRes.value.isGitRepository || latest?.personal.view.panel === "changes"
          ? [loadGitStatus(targetScope, conversationId)]
          : []),
      ])
    }

    void syncWorkspace()
    return () => { cancelled = true }
  }, [
    activeKey,
    selectedConversationId,
    selectedDirectoryPath,
    selectedIsLocal,
    localDirectory,
    persistence,
    mutateRuntime,
    loadDirectoryEntries,
    loadFilePreview,
    loadGitStatus,
  ])

  const openFileTab = useCallback((
    targetScope: ProjectNavigationScope,
    conversationId: string,
    path: string,
    destination: "preview" | "central",
  ) => {
    const name = basenameOf(path)
    mutateRuntime(targetScope, conversationId, prev => {
      if (destination === "central") {
        const exists = prev.personal.centralPaths.includes(path)
        const nextCentralPaths = exists
          ? prev.personal.centralPaths
          : [...prev.personal.centralPaths.slice(-(MAX_CENTRAL_TABS - 1)), path]
        return {
          ...prev,
          personal: {
            ...prev.personal,
            view: { ...prev.personal.view, selectedPath: path },
            centralPaths: nextCentralPaths,
            activeCentral: path,
          },
        }
      }

      const existing = prev.personal.view.fileTabs
      const hasTab = existing.some(tab => tab.path === path)
      const nextTabs = hasTab
        ? existing
        : [...existing.slice(-(MAX_DOCK_TABS - 1)), { path, name }]
      return {
        ...prev,
        personal: {
          ...prev.personal,
          view: {
            ...prev.personal.view,
            dockOpen: true,
            panel: "files",
            selectedPath: path,
            fileTabs: nextTabs,
            activeFilePath: path,
          },
        },
      }
    }, true)
    void loadFilePreview(targetScope, conversationId, path)
  }, [mutateRuntime, loadFilePreview])

  const selectConversationCentralTab = useCallback((targetScope: ProjectNavigationScope, conversationId: string) => {
    mutateRuntime(targetScope, conversationId, prev => ({
      ...prev,
      personal: { ...prev.personal, activeCentral: null },
    }), true)
  }, [mutateRuntime])

  const selectCentralFileTab = useCallback((targetScope: ProjectNavigationScope, conversationId: string, path: string) => {
    mutateRuntime(targetScope, conversationId, prev => ({
      ...prev,
      personal: { ...prev.personal, activeCentral: path },
    }), true)
  }, [mutateRuntime])

  const closeCentralFileTab = useCallback((targetScope: ProjectNavigationScope, conversationId: string, path: string) => {
    mutateRuntime(targetScope, conversationId, prev => {
      const idx = prev.personal.centralPaths.indexOf(path)
      if (idx < 0) return prev
      const nextPaths = prev.personal.centralPaths.filter(item => item !== path)
      let nextActive = prev.personal.activeCentral
      if (nextActive === path) {
        nextActive = nextPaths[idx] ?? nextPaths[idx - 1] ?? null
      }
      return {
        ...prev,
        personal: { ...prev.personal, centralPaths: nextPaths, activeCentral: nextActive },
      }
    }, true)
  }, [mutateRuntime])

  const refreshFile = useCallback((targetScope: ProjectNavigationScope, conversationId: string, path: string) => {
    void loadFilePreview(targetScope, conversationId, path)
  }, [loadFilePreview])

  const savePosition = useCallback((
    targetScope: ProjectNavigationScope,
    conversationId: string,
    area: ScrollArea,
    path: string,
    top: number,
    left: number,
  ) => {
    const key = makeKey(targetScope, conversationId)
    const current = runtimesRef.current[key]
    const pKey = posKey(area, path)
    const prevPos = current?.positions[pKey]
    if (prevPos && Math.abs(prevPos.top - top) < 2 && Math.abs(prevPos.left - left) < 2) return
    mutateRuntime(targetScope, conversationId, prev => ({
      ...prev,
      positions: { ...prev.positions, [pKey]: { area, path, top, left } },
    }), true)
  }, [mutateRuntime])

  const requestFileCandidates = useCallback(async (
    targetScope: ProjectNavigationScope,
    conversationId: string,
    request: ConversationFileCandidateRequest,
  ): Promise<ConversationFileCandidateResult> => {
    if (!localDirectory) {
      return { status: "unavailable", items: [], truncated: false, message: "本机目录服务未就绪" }
    }
    const key = makeKey(targetScope, conversationId)
    const runtime = runtimesRef.current[key]
    if (runtime?.directory.status !== "ready") {
      return {
        status: "unavailable",
        items: [],
        truncated: false,
        message: runtime?.directory.error || "请先选择一个本机工作目录",
      }
    }
    const res = await localDirectory.readDirectory(
      targetScope.workspaceId,
      targetScope.projectId,
      conversationId,
      { kind: "searchCandidates", directory: "", query: request.query, limit: 100 },
    )
    if (!res.ok || res.value.kind !== "searchCandidates") {
      return {
        status: "error",
        items: [],
        truncated: false,
        message: !res.ok ? res.error.message : "搜索本机文件失败",
      }
    }
    return {
      status: "ready",
      items: res.value.value.items.map(item => ({
        relativePath: item.path,
        name: item.name,
        kind: item.kind,
        matchRanges: item.matchRanges,
      })),
      total: res.value.value.total,
      truncated: res.value.value.truncated,
    }
  }, [localDirectory])

  const getRuntime = useCallback((
    targetScope: ProjectNavigationScope,
    conversationId: string,
  ): SessionWorkspaceRuntime => {
    return runtimes[makeKey(targetScope, conversationId)] ?? DEFAULT_RUNTIME
  }, [runtimes])

  const buildDockProps = useCallback((input: {
    readonly scope: ProjectNavigationScope
    readonly conversationId: string
    readonly deviceId: string
    readonly projectName: string
    readonly directoryPath: string | null
    readonly slot: WorkbenchRightSlot
  }): ProjectDockProps | null => {
    if (!input.directoryPath) return null
    const { scope: targetScope, conversationId } = input
    const runtime = getRuntime(targetScope, conversationId)
    const uiScope: ProjectScope = {
      namespace: targetScope.namespace,
      accountId: targetScope.accountId,
      workspaceId: targetScope.workspaceId,
      deviceId: input.deviceId,
      projectId: targetScope.projectId,
    }

    const availability: ProjectAvailability = runtime.directory.status === "error"
      ? { state: "unavailable", message: runtime.directory.error || "当前绑定目录不可访问，请重新选择。" }
      : { state: "available" }

    const rows = flattenTreeRows(
      runtime.tree.entriesByDir,
      runtime.personal.expanded,
      runtime.tree.loadingDirs,
    )
    const tree: ProjectTreeView = {
      status: runtime.tree.status === "idle" || runtime.tree.status === "loading"
        ? "loading"
        : runtime.tree.status === "error"
          ? "error"
          : "ready",
      rows,
      limited: runtime.tree.truncatedDirs.length > 0,
      ...(runtime.tree.error ? { message: runtime.tree.error } : {}),
      freshness: "live",
    }

    const enabledGate = runtime.directory.status === "ready"
      ? ({ enabled: true } as const)
      : ({ enabled: false, reason: runtime.directory.error || "正在准备本机工作目录" } as const)

    const gates: ProjectGates = {
      refreshTree: enabledGate,
      openFile: enabledGate,
      refreshFile: enabledGate,
      openCentral: enabledGate,
      refreshChanges: runtime.directory.status === "ready"
        ? { enabled: true }
        : { enabled: false, reason: runtime.directory.error || "正在准备本机工作目录" },
      readDiff: runtime.directory.isGitRepository
        ? enabledGate
        : { enabled: false, reason: NON_GIT_MESSAGE },
      commit: { enabled: false, reason: GIT_WRITE_DISABLED_REASON },
      push: { enabled: false, reason: GIT_WRITE_DISABLED_REASON },
    }

    const actions: ProjectActions = {
      setDockOpen: (_s, open) => {
        input.slot.setOpen(open)
        mutateRuntime(targetScope, conversationId, prev => ({
          ...prev,
          personal: { ...prev.personal, view: { ...prev.personal.view, dockOpen: open } },
        }), true)
      },
      setDockWidth: (_s, widthPx) => {
        input.slot.setWidth(widthPx)
        mutateRuntime(targetScope, conversationId, prev => ({
          ...prev,
          personal: { ...prev.personal, view: { ...prev.personal.view, dockWidthPx: widthPx } },
        }), true)
      },
      selectPanel: (_s, panel) => {
        mutateRuntime(targetScope, conversationId, prev => ({
          ...prev,
          personal: { ...prev.personal, view: { ...prev.personal.view, panel } },
        }), true)
        if (panel === "changes" && runtime.directory.status === "ready") {
          void loadGitStatus(targetScope, conversationId)
        }
      },
      toggleDirectory: (_s, path) => {
        const isExpanded = runtime.personal.expanded.includes(path)
        mutateRuntime(targetScope, conversationId, prev => ({
          ...prev,
          personal: {
            ...prev.personal,
            expanded: isExpanded
              ? prev.personal.expanded.filter(item => item !== path)
              : [...prev.personal.expanded, path],
          },
        }), true)
        if (!isExpanded && !runtime.tree.entriesByDir[path]) {
          void loadDirectoryEntries(targetScope, conversationId, path)
        }
      },
      refreshTree: () => {
        const dirs = ["", ...runtime.personal.expanded]
        for (const dir of dirs) {
          void loadDirectoryEntries(targetScope, conversationId, dir)
        }
      },
      openFile: (_s, path) => {
        openFileTab(targetScope, conversationId, path, "preview")
      },
      selectFileTab: (_s, path) => {
        mutateRuntime(targetScope, conversationId, prev => ({
          ...prev,
          personal: {
            ...prev.personal,
            view: { ...prev.personal.view, selectedPath: path, activeFilePath: path },
          },
        }), true)
      },
      closeFileTab: (_s, path) => {
        mutateRuntime(targetScope, conversationId, prev => {
          const tabs = prev.personal.view.fileTabs
          const idx = tabs.findIndex(item => item.path === path)
          if (idx < 0) return prev
          const nextTabs = tabs.filter(item => item.path !== path)
          let nextActive = prev.personal.view.activeFilePath
          if (nextActive === path) {
            nextActive = nextTabs[idx]?.path ?? nextTabs[idx - 1]?.path ?? null
          }
          return {
            ...prev,
            personal: {
              ...prev.personal,
              view: { ...prev.personal.view, fileTabs: nextTabs, activeFilePath: nextActive },
            },
          }
        }, true)
      },
      refreshFile: (_s, path) => {
        void loadFilePreview(targetScope, conversationId, path)
      },
      openCentralFile: (_s, path) => {
        openFileTab(targetScope, conversationId, path, "central")
      },
      refreshChanges: () => {
        void loadGitStatus(targetScope, conversationId)
      },
      readDiff: (_s, snapshot, path) => {
        mutateRuntime(targetScope, conversationId, prev => ({
          ...prev,
          personal: { ...prev.personal, diffPath: path },
        }), true)
        void loadDiff(targetScope, conversationId, snapshot, path)
      },
      setSelectedChanges: () => {},
      setCommitMessage: () => {},
      commit: () => {},
      push: () => {},
    }

    const personalView: ProjectPersonalView = {
      ...runtime.personal.view,
      dockOpen: input.slot.open,
      dockWidthPx: input.slot.widthPx,
    }

    return {
      scope: uiScope,
      projectName: input.projectName,
      availability,
      tree,
      files: runtime.files,
      changes: runtime.changes,
      gates,
      personal: personalView,
      actions,
    }
  }, [getRuntime, mutateRuntime, loadDirectoryEntries, loadFilePreview, loadGitStatus, loadDiff, openFileTab])

  const getCentralState = useCallback((targetScope: ProjectNavigationScope, conversationId: string) => {
    const runtime = getRuntime(targetScope, conversationId)
    return {
      centralTabs: runtime.personal.centralPaths.map(path => ({ path, name: basenameOf(path) })),
      activeCentral: runtime.personal.activeCentral,
      files: runtime.files,
      positions: runtime.positions,
      refreshGate: runtime.directory.status === "ready"
        ? ({ enabled: true } as const)
        : ({ enabled: false, reason: runtime.directory.error || "本机工作目录未就绪" } as const),
    }
  }, [getRuntime])

  const stableResult = useMemo(() => ({
    getRuntime,
    buildDockProps,
    getCentralState,
    openFileTab,
    selectConversationCentralTab,
    selectCentralFileTab,
    closeCentralFileTab,
    refreshFile,
    savePosition,
    requestFileCandidates,
  }), [
    getRuntime,
    buildDockProps,
    getCentralState,
    openFileTab,
    selectConversationCentralTab,
    selectCentralFileTab,
    closeCentralFileTab,
    refreshFile,
    savePosition,
    requestFileCandidates,
  ])

  return stableResult
}
