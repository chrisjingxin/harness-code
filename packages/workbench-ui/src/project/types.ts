/** 项目视图的受控输入：由桌面装配方提供数据与动作，组件不访问项目服务。 */

/** 个人项目视图的完整身份；namespace 区分服务或身份域，不包含凭据。 */
export type ProjectScope = {
  namespace: string
  accountId: string
  workspaceId: string
  deviceId: string
  projectId: string
}

/** 当前原项目是否可访问；只读能力通过各动作的可用性分别表达。 */
export type ProjectAvailability =
  | { state: "available" }
  | { state: "offline" | "denied" | "unavailable"; message: string }

/** 一项操作不可用时由调用方提供可读原因。 */
export type ProjectActionAvailability = { enabled: true } | { enabled: false; reason: string }

export type ProjectTreeRow = {
  path: string
  name: string
  kind: "directory" | "file" | "symlink"
  depth: number
  expanded: boolean
  loading: boolean
  hasChildren: boolean
}

export type ProjectTreeView = {
  status: "loading" | "ready" | "error"
  rows: readonly ProjectTreeRow[]
  limited: boolean
  message?: string
  freshness?: "live" | "cached"
}

/** 可展示的文件内容；缓存不是当前设备实时读取的证明。 */
export type ProjectFileContent = {
  path: string
  content: string
  language: string | null
  sizeBytes: number
  lineCount: number
  truncated: boolean
  displayedBytes?: number
  freshness: "live" | "cached"
}

export type ProjectFileView =
  | { status: "loading"; path: string }
  | { status: "ready"; file: ProjectFileContent; refreshError?: string }
  | { status: "unsupported" | "too-large"; path: string; reason: string; sizeBytes?: number }
  | { status: "error"; path: string; message: string }

/** 变更值仅作为受控输入；实际读取、校验与写入属于项目服务。 */
export type ProjectChangedFile = {
  path: string
  oldPath?: string
  status: string
  version: string
}

export type ProjectChangesView = {
  status: "loading" | "ready" | "error"
  busy: boolean
  message?: string
  freshness?: "live" | "cached"
  repository?: {
    snapshot: string
    branch: string
    head?: string
    upstream?: { remote: string; branch: string; ahead: number; behind: number }
    files: readonly ProjectChangedFile[]
  }
  diff?: { snapshot: string; path: string; text: string; truncated: boolean }
  result?:
    | { commit: "succeeded"; commitSha: string; push: "not-requested" | "succeeded" | "failed" | "unknown"; warning?: string; message?: string }
    | { commit: "failed" | "unknown"; push: "not-requested" | "unknown"; warning?: string; message: string }
}

/** 项目各动作分别可用，组件不根据设备名或仓库状态猜测权限。 */
export type ProjectGates = {
  refreshTree: ProjectActionAvailability
  openFile: ProjectActionAvailability
  refreshFile: ProjectActionAvailability
  openCentral: ProjectActionAvailability
  refreshChanges: ProjectActionAvailability
  readDiff: ProjectActionAvailability
  commit: ProjectActionAvailability
  push: ProjectActionAvailability
}

/** 每个 scope 的个人状态由装配方保存，不能随着共享消息广播。 */
export type ProjectPersonalView = {
  dockOpen: boolean
  dockWidthPx: number
  panel: "files" | "changes"
  selectedPath: string | null
  fileTabs: readonly { path: string; name: string }[]
  activeFilePath: string | null
  selectedChanges: readonly { path: string; version: string }[]
  commitMessage: string
}

/**
 * 视图只发送用户意图，回调返回不表示文件或 Git 操作已经成功。
 * 上游负责按 scope、路径与请求次序过滤迟到结果。
 * 宿主接收新变更列表时须同步撤销失效版本的选择；确认提交后只清理由本次意图发起且未被用户更新的草稿。
 */
export type ProjectActions = {
  setDockOpen(scope: ProjectScope, open: boolean): void
  setDockWidth(scope: ProjectScope, widthPx: number): void
  selectPanel(scope: ProjectScope, panel: "files" | "changes"): void
  toggleDirectory(scope: ProjectScope, path: string): void
  refreshTree(scope: ProjectScope): void
  openFile(scope: ProjectScope, path: string): void
  selectFileTab(scope: ProjectScope, path: string): void
  closeFileTab(scope: ProjectScope, path: string): void
  refreshFile(scope: ProjectScope, path: string): void
  openCentralFile(scope: ProjectScope, path: string): void
  refreshChanges(scope: ProjectScope): void
  readDiff(scope: ProjectScope, snapshot: string, path: string): void
  setSelectedChanges(scope: ProjectScope, selected: ProjectPersonalView["selectedChanges"]): void
  setCommitMessage(scope: ProjectScope, message: string): void
  commit(scope: ProjectScope, input: { snapshot: string; paths: readonly string[]; message: string; alsoPush: boolean }): void
  push(scope: ProjectScope, input: { snapshot: string; commitSha: string }): void
}

/** 一个右侧项目区域的全部受控输入和动作。 */
export type ProjectDockProps = {
  scope: ProjectScope
  projectName: string
  availability: ProjectAvailability
  tree: ProjectTreeView
  files: Readonly<Record<string, ProjectFileView>>
  changes: ProjectChangesView
  gates: ProjectGates
  personal: ProjectPersonalView
  actions: ProjectActions
}
