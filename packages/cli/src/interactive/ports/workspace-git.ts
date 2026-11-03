/** 人工 Git 操作端口：只传结构化工作区事实，不向 renderer 暴露 Shell。 */
export type GitFile = { path: string; oldPath: string | null; status: string; fingerprint: string }
export type GitRepository = {
  snapshot: string
  branch: string | null
  head: string | null
  files: readonly GitFile[]
  upstream: { remote: string; branch: string; ahead: number; behind: number } | null
  blockedReason: string | null
}
export type GitCommitInput = { snapshot: string; paths: readonly string[]; message: string }
export type GitDiff = { path: string; text: string; truncated: boolean }
export type GitResult = { sha: string; pushed: boolean; pushError?: string; warning?: string }
export type WorkspaceGitView = {
  busy: boolean
  repository: GitRepository | null
  diff: GitDiff | null
  result: GitResult | null
  error: string | null
}
/** 每个 Controller 独立持有只读投影；读写操作由本机 adapter 实现。 */
export function emptyWorkspaceGitView(): WorkspaceGitView {
  return { busy: false, repository: null, diff: null, result: null, error: null }
}
export interface WorkspaceGit {
  /** 读取可提交文件与不可变核验摘要。 */
  status(): Promise<GitRepository>
  /** 展示快照中某个文件的工作区 Diff。 */
  diff(snapshot: string, path: string): Promise<GitDiff>
  /** 提交完整选中文件并保留未选暂存条目。 */
  commit(input: GitCommitInput): Promise<{ sha: string; warning?: string }>
  /** 只推送已确认提交，不重复创建 commit。 */
  push(input: { snapshot: string; head: string }): Promise<void>
}
