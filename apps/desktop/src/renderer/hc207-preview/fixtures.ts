/** 受控文件与变更样例仅用于组件预览，不访问文件系统、Git 或协作服务。 */
import type { ProjectChangesView, ProjectFileView, ProjectPersonalView, ProjectScope, ProjectTreeRow } from "@workbench/ui"

export type PreviewCondition = "online" | "offline" | "denied" | "readonly"
export type PreviewTreeMode = "normal" | "loading" | "empty" | "error" | "limited"
export type PreviewGitOutcome = "success" | "push-failed" | "push-unknown" | "commit-unknown" | "commit-failed"
export type PreviewProject = {
  personal: ProjectPersonalView
  expanded: readonly string[]
  files: Readonly<Record<string, ProjectFileView>>
  centralPaths: readonly string[]
  centralActive: string | null
  condition: PreviewCondition
  treeMode: PreviewTreeMode
  treeMessage?: string
  changes: ProjectChangesView
  gitRevision: number
  gitOutcome: PreviewGitOutcome
  gitAction: string
  selectionRevision: number
  messageRevision: number
}

export const previewScopes: readonly { label: string; scope: ProjectScope }[] = [
  { label: "身份域 A · 设备 1", scope: { namespace: "domain-a", accountId: "user-01", workspaceId: "workspace-01", deviceId: "device-01", projectId: "project-01" } },
  { label: "身份域 B · 同名目标", scope: { namespace: "domain-b", accountId: "user-01", workspaceId: "workspace-01", deviceId: "device-01", projectId: "project-01" } },
  { label: "身份域 A · 设备 2", scope: { namespace: "domain-a", accountId: "user-01", workspaceId: "workspace-01", deviceId: "device-02", projectId: "project-01" } },
]

export function previewScopeKey(scope: ProjectScope): string {
  return JSON.stringify([scope.namespace, scope.accountId, scope.workspaceId, scope.deviceId, scope.projectId])
}

export function initialPreviewProject(scope: ProjectScope): PreviewProject {
  return {
    personal: { dockOpen: true, dockWidthPx: 340, panel: "files", selectedPath: null, fileTabs: [], activeFilePath: null, selectedChanges: [], commitMessage: "" },
    expanded: ["src", "tests", "samples"], files: {}, centralPaths: [], centralActive: null, condition: "online", treeMode: "normal",
    changes: previewChanges(scope), gitRevision: 1, gitOutcome: "push-failed", gitAction: "尚无 Git 意图。",
    selectionRevision: 0, messageRevision: 0,
  }
}

/** 标记和内容均为固定夹具，不对应真实仓库或真实提交。 */
export function previewChanges(scope: ProjectScope): ProjectChangesView {
  return {
    status: "ready", busy: false, freshness: "live",
    repository: {
      snapshot: `preview-${scope.namespace}-${scope.deviceId}-1`, branch: "preview/main",
      head: "1111111111111111111111111111111111111111",
      upstream: { remote: "origin", branch: "main", ahead: 1, behind: 0 },
      files: [
        { path: "src/index.ts", status: "M", version: "v1" },
        { path: "tests/index.ts", status: "M", version: "v1" },
        { path: "assets/logo.png", status: "M", version: "v1" },
        { path: "docs/new-name.md", oldPath: "docs/old-name.md", status: "R", version: "v1" },
      ],
    },
  }
}

export function previewDiff(path: string): { text: string; truncated: boolean } {
  if (path === "src/index.ts") return { text: [
    "diff --git a/src/index.ts b/src/index.ts", "--- a/src/index.ts", "+++ b/src/index.ts",
    "@@ -1,3 +1,3 @@", " // 受控变更示例", "-export const value = 1", "+export const value = 2", " console.log(value)",
  ].join("\n"), truncated: false }
  if (path === "tests/index.ts") return { text: "@@ 此处是无法解析的受控 Diff @@\n<这段文本保持原文，不作为 HTML>", truncated: false }
  if (path === "assets/logo.png") return { text: "Binary files a/assets/logo.png and b/assets/logo.png differ", truncated: false }
  return { text: "--- a/docs/old-name.md\n+++ b/docs/new-name.md\n@@ -1 +1 @@\n-旧名称\n+新名称\n[diff 因行数或字节上限截断]", truncated: true }
}

const rows: readonly Omit<ProjectTreeRow, "expanded">[] = [
  { path: "src", name: "src", kind: "directory", depth: 0, loading: false, hasChildren: true },
  { path: "src/index.ts", name: "index.ts", kind: "file", depth: 1, loading: false, hasChildren: false },
  { path: "tests", name: "tests", kind: "directory", depth: 0, loading: false, hasChildren: true },
  { path: "tests/index.ts", name: "index.ts", kind: "file", depth: 1, loading: false, hasChildren: false },
  { path: "samples", name: "samples", kind: "directory", depth: 0, loading: false, hasChildren: true },
  { path: "samples/large.log", name: "large.log", kind: "file", depth: 1, loading: false, hasChildren: false },
  { path: "samples/partial.log", name: "partial.log", kind: "file", depth: 1, loading: false, hasChildren: false },
  { path: "samples/image.png", name: "image.png", kind: "file", depth: 1, loading: false, hasChildren: false },
  { path: "README.md", name: "README.md", kind: "file", depth: 0, loading: false, hasChildren: false },
  { path: "project-link", name: "project-link", kind: "symlink", depth: 0, loading: false, hasChildren: false },
]

export function previewRows(expanded: readonly string[]): readonly ProjectTreeRow[] {
  return rows.map(row => ({ ...row, expanded: row.kind === "directory" && expanded.includes(row.path) }))
}

/** 所有内容是静态字符串；相同路径在不同 scope 使用不同文本，便于观察隔离。 */
export function previewFile(scope: ProjectScope, path: string): ProjectFileView {
  if (path === "samples/large.log") return { status: "too-large", path, reason: "文件过大，无法预览（受控示例）", sizeBytes: 9_000_000 }
  if (path === "samples/image.png") return { status: "unsupported", path, reason: "二进制文件暂不支持预览", sizeBytes: 2048 }
  if (path === "project-link") return { status: "error", path, message: "链接目标不可读取（受控示例）" }
  const content = path === "src/index.ts"
    ? `// ${scope.namespace} / ${scope.deviceId}\nexport const message = "你好，文件视图 👋"\nconsole.log(message)`
    : path === "tests/index.ts"
      ? `// ${scope.namespace} / tests\nconst result = "另一个同名文件"\nconsole.log(result)`
      : path === "README.md"
        ? `# 只读 Markdown 源码\n\n当前身份域：${scope.namespace}\n\n- 不连接真实项目\n- 保留行号和源码高亮`
        : `第一行：受控截断样例\n第二行：仅显示部分内容\n身份域：${scope.namespace}`
  const size = new TextEncoder().encode(content).length
  return { status: "ready", file: {
    path, content, language: path.endsWith(".ts") ? "typescript" : path.endsWith(".md") ? "markdown" : null,
    sizeBytes: path === "samples/partial.log" ? 524_288 : size,
    lineCount: content.split("\n").length, truncated: path === "samples/partial.log",
    ...(path === "samples/partial.log" ? { displayedBytes: size } : {}), freshness: "live",
  } }
}
