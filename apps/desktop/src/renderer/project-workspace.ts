/**
 * 当前会话的原项目只读装配：用户意图 → 会话级读取 → 核对作用域和请求次序 → 更新受控视图。
 * 项目个人选择由上层按账号/工作区/设备/项目保存；文件正文与 Git 结果只属于当前授权会话。
 */
import { useEffect, useRef, useState } from "react"
import type { CollaborationError, ProjectReadAction, ProjectReadEntry } from "@workbench/contracts"
import type { ProjectReadHost } from "../project-read-host.js"
import type { ProjectPersonal } from "../personal-host.js"
import type {
  ConversationFileCandidateRequest, ConversationFileCandidateResult, ConversationProjectTarget, ConversationScope,
  ProjectActions, ProjectAvailability, ProjectChangesView, ProjectFileView, ProjectGates,
  ProjectScope, ProjectTreeRow, ProjectTreeView,
} from "@workbench/ui"

export type { ProjectPersonal } from "../personal-host.js"

export const emptyProjectPersonal: ProjectPersonal = {
  view: { dockOpen: true, dockWidthPx: 340, panel: "files", selectedPath: null, fileTabs: [], activeFilePath: null, selectedChanges: [], commitMessage: "" },
  expanded: [], centralPaths: [], activeCentral: null, diffPath: null,
}

export function projectScopeKey(scope: ProjectScope): string {
  return JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.deviceId, scope.projectId])
}

export type ProjectSession = { scope: ProjectScope; conversationId: string }
type Directory = { status: "loading" | "ready" | "error"; entries: readonly ProjectReadEntry[]; limited: boolean; message?: string }
type ProjectData = {
  availability: ProjectAvailability
  directories: Readonly<Record<string, Directory>>
  files: Readonly<Record<string, ProjectFileView>>
  changes: ProjectChangesView
  blockedReason: string | null
}
type Box = { key: string | null; data: ProjectData }
const allowed = { enabled: true } as const
const unavailable = (reason: string) => ({ enabled: false, reason } as const)
const emptyData = (): ProjectData => ({
  availability: { state: "unavailable", message: "正在确认原项目…" },
  directories: { "": { status: "loading", entries: [], limited: false } },
  files: {}, changes: { status: "loading", busy: false }, blockedReason: null,
})
const permissionFailures = new Set([
  "AUTHENTICATION_REQUIRED", "RESOURCE_NOT_FOUND", "REQUEST_SOURCE_REJECTED", "PROJECT_NOT_SHARED",
  "SHARE_VERSION_CONFLICT", "PROJECT_ROOT_CHANGED", "PROJECT_SOURCE_UNKNOWN", "PROJECT_REPOSITORY_DENIED", "PROJECT_IDENTITY_UNBOUND",
])

function asCached(data: ProjectData, message: string): ProjectData {
  const files = Object.fromEntries(Object.entries(data.files).map(([path, value]) => [path,
    value.status === "ready" ? { ...value, file: { ...value.file, freshness: "cached" as const } } : value]))
  const directories = Object.fromEntries(Object.entries(data.directories).map(([path, value]) => [path,
    value.status === "loading" ? { ...value, status: value.entries.length ? "ready" as const : "error" as const, message } : value]))
  return { ...data, availability: { state: "offline", message }, files, directories,
    changes: { ...data.changes, busy: false, freshness: data.changes.repository ? "cached" : undefined } }
}

function rowsFrom(directories: ProjectData["directories"], expanded: readonly string[]): ProjectTreeRow[] {
  const expandedSet = new Set(expanded), rows: ProjectTreeRow[] = []
  const visit = (directory: string, depth: number) => {
    for (const entry of directories[directory]?.entries ?? []) {
      const child = directories[entry.path]
      rows.push({ path: entry.path, name: entry.name, kind: entry.kind, depth,
        expanded: expandedSet.has(entry.path), loading: child?.status === "loading", hasChildren: entry.expandable })
      if (entry.kind === "directory" && expandedSet.has(entry.path)) visit(entry.path, depth + 1)
    }
  }
  visit("", 0)
  return rows
}

/** 只对当前会话交付结果；切换时先隐藏旧正文，重新取得授权后才读取。 */
export function useProjectWorkspace(
  host: ProjectReadHost,
  session: ProjectSession | null,
  personal: ProjectPersonal,
  updatePersonal: (scope: ProjectScope, update: (previous: ProjectPersonal) => ProjectPersonal) => void,
) {
  const key = session ? JSON.stringify([projectScopeKey(session.scope), session.conversationId]) : null
  const currentKey = useRef(key); currentKey.current = key
  const generation = useRef(0)
  const serial = useRef(0)
  const requests = useRef(new Map<string, number>())
  const [box, setBox] = useState<Box>({ key: null, data: emptyData() })
  const boxRef = useRef(box)
  const personalRef = useRef(personal); personalRef.current = personal

  function valid(requestKey: string, version: number): boolean {
    return currentKey.current === requestKey && generation.current === version
  }
  function updateData(requestKey: string, version: number, update: (data: ProjectData) => ProjectData): void {
    if (!valid(requestKey, version) || boxRef.current.key !== requestKey) return
    const next = { key: requestKey, data: update(boxRef.current.data) }
    boxRef.current = next; setBox(next)
  }
  function ticket(operation: string): number { const id = ++serial.current; requests.current.set(operation, id); return id }
  function latest(operation: string, id: number): boolean { return requests.current.get(operation) === id }

  function fail(error: CollaborationError, requestKey: string, version: number): boolean {
    if (permissionFailures.has(error.code)) {
      updateData(requestKey, version, () => ({
        availability: { state: "denied", message: error.message },
        directories: { "": { status: "error", entries: [], limited: false, message: error.message } },
        files: {}, changes: { status: "error", busy: false, message: error.message }, blockedReason: null,
      }))
      // 清除所有同范围在途请求，防止较早的成功响应在撤权后恢复正文。
      generation.current++
      requests.current.clear()
      return true
    }
    if (["PROJECT_READ_UNAVAILABLE", "PROJECT_READ_TIMEOUT", "PROJECT_READ_BUSY", "PROJECT_AUTH_UNAVAILABLE", "TARGET_UNAVAILABLE", "NETWORK_UNAVAILABLE", "SERVICE_UNAVAILABLE"].includes(error.code)) {
      updateData(requestKey, version, data => asCached(data, error.message))
      return true
    }
    return false
  }

  async function loadDirectory(directory: string): Promise<void> {
    if (!session || !key) return
    const requestKey = key, version = generation.current, operation = `directory:${directory}`, id = ticket(operation)
    updateData(requestKey, version, data => ({ ...data, directories: { ...data.directories,
      [directory]: { status: "loading", entries: data.directories[directory]?.entries ?? [], limited: false } } }))
    try {
      const entries: ProjectReadEntry[] = [], cursors = new Set<string>()
      let cursor: string | undefined, limited = false, pages = 0
      do {
        const action: ProjectReadAction = { kind: "listDirectory", directory, ...(cursor ? { cursor } : {}) }
        const result = await host.readProject(session.scope.workspaceId, session.conversationId, action)
        if (!valid(requestKey, version) || !latest(operation, id)) return
        if (!result.ok) {
          if (!fail(result.error, requestKey, version)) {
            const denied = result.error.code === "PROJECT_FILE_DENIED"
            updateData(requestKey, version, data => {
              const under = (path: string) => directory === "" || path === directory || path.startsWith(`${directory}/`)
              const directories = denied ? Object.fromEntries(Object.entries(data.directories).filter(([path]) => !under(path))) : data.directories
              const files = denied ? Object.fromEntries(Object.entries(data.files).filter(([path]) => !under(path))) : data.files
              return { ...data, files, directories: { ...directories,
                [directory]: { status: "error", entries: [], limited: false, message: result.error.message } } }
            })
            if (denied) { generation.current++; requests.current.clear() }
          }
          return
        }
        if (result.value.kind !== "listDirectory") throw new Error("目录响应不匹配")
        entries.push(...result.value.value.entries); limited ||= result.value.value.truncated
        cursor = result.value.value.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error("目录游标重复")
        if (cursor) cursors.add(cursor)
        pages++
      } while (cursor && pages < 4)
      limited ||= Boolean(cursor)
      updateData(requestKey, version, data => ({ ...data, availability: { state: "available" }, directories: { ...data.directories,
        [directory]: { status: "ready", entries, limited } } }))
      if (directory === "") {
        // 权限确认后，重新读取已打开的文件；旧会话的正文不会直接复用。
        for (const path of personalRef.current.expanded) void loadDirectory(path)
        for (const path of new Set([...personalRef.current.view.fileTabs.map(tab => tab.path), ...personalRef.current.centralPaths])) void loadFile(path)
        if (personalRef.current.view.panel === "changes") void loadChanges()
      }
    } catch {
      if (valid(requestKey, version) && latest(operation, id)) updateData(requestKey, version, data => ({ ...data, directories: { ...data.directories,
        [directory]: { status: "error", entries: [], limited: false, message: "目录读取失败，请重试。" } } }))
    }
  }

  async function loadFile(path: string): Promise<void> {
    if (!session || !key) return
    const requestKey = key, version = generation.current, operation = `file:${path}`, id = ticket(operation)
    updateData(requestKey, version, data => ({ ...data, files: { ...data.files, [path]: data.files[path]?.status === "ready"
      ? data.files[path]! : { status: "loading", path } } }))
    try {
      const result = await host.readProject(session.scope.workspaceId, session.conversationId, { kind: "readPreview", path })
      if (!valid(requestKey, version) || !latest(operation, id)) return
      if (!result.ok) {
        if (!fail(result.error, requestKey, version)) updateData(requestKey, version, data => ({ ...data, files: { ...data.files,
          [path]: result.error.code === "PROJECT_FILE_UNSUPPORTED" ? { status: "unsupported", path, reason: result.error.message }
            : { status: "error", path, message: result.error.message } } }))
        return
      }
      if (result.value.kind !== "readPreview" || result.value.value.path !== path) throw new Error("文件响应不匹配")
      const preview = result.value.value
      updateData(requestKey, version, data => ({ ...data, availability: { state: "available" }, files: { ...data.files,
        [path]: { status: "ready", file: { ...preview, freshness: "live" } } } }))
    } catch {
      if (valid(requestKey, version) && latest(operation, id)) updateData(requestKey, version, data => ({ ...data, files: { ...data.files,
        [path]: { status: "error", path, message: "文件预览读取失败，请重试。" } } }))
    }
  }

  async function loadChanges(): Promise<void> {
    if (!session || !key) return
    const requestKey = key, version = generation.current, operation = "git-status", id = ticket(operation)
    updateData(requestKey, version, data => ({ ...data, changes: { ...data.changes, status: "loading", busy: false } }))
    try {
      const result = await host.readProject(session.scope.workspaceId, session.conversationId, { kind: "gitStatus" })
      if (!valid(requestKey, version) || !latest(operation, id)) return
      if (!result.ok) {
        if (!fail(result.error, requestKey, version)) updateData(requestKey, version, data => ({ ...data, changes: { status: "error", busy: false, message: result.error.message } }))
        return
      }
      if (result.value.kind !== "gitStatus") throw new Error("Git 状态响应不匹配")
      const status = result.value.value
      updatePersonal(session.scope, previous => ({ ...previous, view: { ...previous.view,
        selectedChanges: previous.view.selectedChanges.filter(item => status.files.some(file => file.path === item.path && file.version === item.version)) },
        diffPath: previous.diffPath && status.files.some(file => file.path === previous.diffPath) ? previous.diffPath : null }))
      updateData(requestKey, version, data => ({ ...data, availability: { state: "available" }, blockedReason: status.blockedReason,
        changes: { status: "ready", busy: false, freshness: "live", ...(status.blockedReason ? { message: status.blockedReason } : {}),
          repository: { snapshot: status.snapshot, branch: status.branch ?? "分离 HEAD", ...(status.head ? { head: status.head } : {}),
            ...(status.upstream ? { upstream: status.upstream } : {}), files: status.files },
          ...(data.changes.diff?.snapshot === status.snapshot ? { diff: data.changes.diff } : {}) } }))
      const diffPath = personalRef.current.diffPath
      if (diffPath && status.files.some(file => file.path === diffPath)) void loadDiff(status.snapshot, diffPath)
    } catch {
      if (valid(requestKey, version) && latest(operation, id)) updateData(requestKey, version, data => ({ ...data,
        changes: { status: "error", busy: false, message: "Git 状态读取失败，请重试。" } }))
    }
  }

  async function loadDiff(snapshot: string, path: string): Promise<void> {
    if (!session || !key) return
    const requestKey = key, version = generation.current, operation = "git-diff", id = ticket(operation)
    updateData(requestKey, version, data => ({ ...data, changes: { ...data.changes, busy: true } }))
    try {
      const result = await host.readProject(session.scope.workspaceId, session.conversationId, { kind: "gitDiff", snapshot, path })
      if (!valid(requestKey, version) || !latest(operation, id) || boxRef.current.data.changes.repository?.snapshot !== snapshot) return
      if (!result.ok) {
        if (!fail(result.error, requestKey, version)) updateData(requestKey, version, data => ({ ...data,
          changes: { ...data.changes, busy: false, message: result.error.message, diff: undefined } }))
        return
      }
      if (result.value.kind !== "gitDiff" || result.value.value.snapshot !== snapshot || result.value.value.path !== path) throw new Error("Diff 响应不匹配")
      const diff = result.value.value
      updateData(requestKey, version, data => ({ ...data, changes: { ...data.changes, busy: false, diff } }))
    } catch {
      if (valid(requestKey, version) && latest(operation, id)) updateData(requestKey, version, data => ({ ...data,
        changes: { ...data.changes, busy: false, message: "Diff 读取失败，请重试。" } }))
    }
  }

  useEffect(() => {
    const version = ++generation.current
    requests.current.clear()
    const next = { key, data: emptyData() }
    boxRef.current = next; setBox(next)
    if (session && key) void loadDirectory("")
    return () => { if (generation.current === version) generation.current++ }
  }, [host, key])

  const data = box.key === key ? box.data : emptyData()
  const root = data.directories[""]
  const directoryError = Object.values(data.directories).find(directory => directory.status === "error" && directory.message)?.message
  const tree: ProjectTreeView = { status: root?.status ?? "loading", rows: rowsFrom(data.directories, personal.expanded),
    limited: Object.values(data.directories).some(directory => directory.limited), ...(directoryError ? { message: directoryError } : {}),
    freshness: data.availability.state === "offline" ? "cached" : "live" }
  const reason = data.availability.state === "available" ? "" : data.availability.message
  const read = reason ? unavailable(reason) : allowed
  const gates: ProjectGates = { refreshTree: read, openFile: read, refreshFile: read,
    openCentral: data.availability.state === "denied" ? unavailable(reason) : allowed,
    refreshChanges: read, readDiff: read,
    commit: unavailable(data.blockedReason ?? "提交尚未接入。"),
    push: unavailable(data.blockedReason ?? "推送尚未接入。") }

  const actions: ProjectActions = {
    setDockOpen: () => {}, setDockWidth: () => {},
    selectPanel: (scope, panel) => { updatePersonal(scope, value => ({ ...value, view: { ...value.view, panel } })); if (panel === "changes") void loadChanges() },
    toggleDirectory: (scope, path) => {
      const wasExpanded = personalRef.current.expanded.includes(path)
      updatePersonal(scope, value => ({ ...value, expanded: wasExpanded ? value.expanded.filter(item => item !== path) : [...value.expanded, path] }))
      if (!wasExpanded) void loadDirectory(path)
    },
    refreshTree: () => { void loadDirectory("") },
    openFile: (scope, path) => {
      updatePersonal(scope, value => {
        const tabs = [{ path, name: path.split("/").at(-1) ?? path }, ...value.view.fileTabs.filter(tab => tab.path !== path)].slice(0, 12)
        return { ...value, view: { ...value.view, panel: "files", selectedPath: path, activeFilePath: path, fileTabs: tabs } }
      })
      void loadFile(path)
    },
    selectFileTab: (scope, path) => updatePersonal(scope, value => ({ ...value, view: { ...value.view, selectedPath: path, activeFilePath: path } })),
    closeFileTab: (scope, path) => updatePersonal(scope, value => {
      const index = value.view.fileTabs.findIndex(tab => tab.path === path)
      const tabs = value.view.fileTabs.filter(tab => tab.path !== path)
      const active = value.view.activeFilePath === path ? tabs[Math.min(index, tabs.length - 1)]?.path ?? null : value.view.activeFilePath
      return { ...value, view: { ...value.view, fileTabs: tabs, activeFilePath: active } }
    }),
    refreshFile: (_scope, path) => { void loadFile(path) },
    openCentralFile: (scope, path) => updatePersonal(scope, value => ({ ...value,
      centralPaths: value.centralPaths.includes(path) ? value.centralPaths : [...value.centralPaths, path], activeCentral: path })),
    refreshChanges: () => { void loadChanges() }, readDiff: (scope, snapshot, path) => {
      updatePersonal(scope, value => ({ ...value, diffPath: path })); void loadDiff(snapshot, path)
    },
    setSelectedChanges: (scope, selectedChanges) => updatePersonal(scope, value => ({ ...value, view: { ...value.view, selectedChanges } })),
    setCommitMessage: (scope, commitMessage) => updatePersonal(scope, value => ({ ...value, view: { ...value.view, commitMessage } })),
    commit: () => {}, push: () => {},
  }

  async function candidates(scope: ConversationScope, target: ConversationProjectTarget, request: ConversationFileCandidateRequest): Promise<ConversationFileCandidateResult> {
    if (!session || !key || scope.namespace !== session.scope.namespace || scope.conversationId !== session.conversationId || scope.accountId !== session.scope.accountId
      || scope.workspaceId !== session.scope.workspaceId || target.deviceId !== session.scope.deviceId || target.projectId !== session.scope.projectId) {
      return { status: "unavailable", items: [], truncated: false, message: "会话项目已变化。" }
    }
    const requestKey = key, version = generation.current
    try {
      const result = await host.readProject(session.scope.workspaceId, session.conversationId,
        { kind: "searchCandidates", directory: request.directory, query: request.query, limit: 1000 })
      if (!valid(requestKey, version)) return { status: "unavailable", items: [], truncated: false, message: "会话项目已变化。" }
      if (!result.ok) {
        fail(result.error, requestKey, version)
        return { status: "error", items: [], truncated: false, message: result.error.message }
      }
      if (result.value.kind !== "searchCandidates") throw new Error("候选响应不匹配")
      return { status: "ready", items: result.value.value.items.map(item => ({ relativePath: item.path, name: item.name, kind: item.kind, matchRanges: item.matchRanges })),
        ...(result.value.value.total === undefined ? {} : { total: result.value.value.total }), truncated: result.value.value.truncated }
    } catch { return { status: "error", items: [], truncated: false, message: "文件候选暂不可用。" } }
  }

  function openFromConversation(scope: ConversationScope, target: ConversationProjectTarget, path: string, destination: "preview" | "central"): boolean {
    if (!session || data.availability.state !== "available" || scope.namespace !== session.scope.namespace || scope.conversationId !== session.conversationId || scope.accountId !== session.scope.accountId
      || scope.workspaceId !== session.scope.workspaceId || target.deviceId !== session.scope.deviceId || target.projectId !== session.scope.projectId) return false
    actions.openFile(session.scope, path)
    if (destination === "central") actions.openCentralFile(session.scope, path)
    return true
  }

  return { data, tree, gates, actions, candidates, openFromConversation, retry: () => { void loadDirectory("") } }
}
