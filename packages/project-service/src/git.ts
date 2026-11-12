/** 本机项目 Git 入口。读入稳定快照后才写入，组合操作分开确认提交与推送。 */
import { fresh, inspect, MAX_GIT_FILES, openRepository, readDiff, targetKey } from "./git-state.js"
import type { GitInspection, GitRepository } from "./git-state.js"
import { commitSelection, pushTarget } from "./git-write.js"
import { filesystemError, ProjectRoot } from "./root.js"
import { ProjectServiceError } from "./types.js"
import type { ProjectCommitInput, ProjectCommitResult, ProjectGitDiff, ProjectGitStatus, ProjectPushInput, ProjectPushResult } from "./types.js"

type ConfirmedCommit = {
  sha: string
  branchRef: string | null
  target: string | null
  push: ProjectPushResult
}

// 同一宿主中的多个服务实例按真实工作树及共享 Git 目录串行，外部 Git 仍由索引锁保护。
const occupied = new Set<string>()
const notRequested: ProjectPushResult = { status: "not-requested" }

function skippedPush(code: ProjectServiceError["code"], message: string): ProjectPushResult {
  return { status: "not-started", code, message }
}

function checkPaths(state: GitInspection, input: ProjectCommitInput): string[] {
  if (!input.message.trim() || input.message.includes("\0") || input.message.length > 8192) {
    throw new ProjectServiceError("invalid-selection", "请填写 1–8192 字符的有效提交说明。")
  }
  if (!input.paths.length || input.paths.length > MAX_GIT_FILES || new Set(input.paths).size !== input.paths.length) {
    throw new ProjectServiceError("invalid-selection", "请选择有效且不重复的文件。")
  }
  const files = new Map(state.status.files.map(file => [file.path, file]))
  const selected = new Set<string>()
  for (const path of input.paths) {
    const file = files.get(path)
    if (!file) throw new ProjectServiceError("invalid-selection", "所选文件不属于当前变更。")
    selected.add(file.path)
    if (file.oldPath !== undefined) selected.add(file.oldPath)
  }
  return [...selected]
}

export class ProjectGit {
  private confirmed: ConfirmedCommit | undefined

  constructor(private readonly root: ProjectRoot) {}

  async status(): Promise<ProjectGitStatus> {
    return this.withReadableRepository(async repository => (await inspect(repository)).status)
  }

  async diff(input: { snapshot: string; path: string }): Promise<ProjectGitDiff> {
    return this.withReadableRepository(repository => readDiff(repository, input.snapshot, input.path))
  }

  async commit(input: ProjectCommitInput): Promise<ProjectCommitResult> {
    try {
      return await this.withWriteRepository(async repository => {
        const state = await fresh(repository, input.snapshot)
        if (state.status.blockedReason) throw new ProjectServiceError("git-blocked", state.status.blockedReason)
        const paths = checkPaths(state, input)
        const originalTarget = targetKey(state.target)
        if (input.alsoPush && !originalTarget) {
          throw new ProjectServiceError("upstream-unavailable", "请先在原设备配置既有 upstream，或仅提交。")
        }
        const commit = await commitSelection(repository, state, paths, input.message)
        if (commit.status !== "succeeded") {
          if (commit.status === "unknown") this.confirmed = undefined
          const push = input.alsoPush ? skippedPush(commit.code, "提交未确认，未开始推送。") : notRequested
          return { ...commit, push }
        }

        const confirmed: ConfirmedCommit = {
          sha: commit.commitSha, branchRef: state.branchRef, target: originalTarget, push: notRequested,
        }
        this.confirmed = confirmed
        if (input.alsoPush) {
          if (commit.warning) confirmed.push = skippedPush("git-failed", "提交已确认，请检查提交警告后再推送。")
          else confirmed.push = await this.pushConfirmed(repository, confirmed)
        }
        return { ...commit, push: confirmed.push }
      })
    } catch (error) {
      const failure = filesystemError(error)
      return { status: "not-started", code: failure.code, message: failure.message,
        push: input.alsoPush ? skippedPush(failure.code, "提交未开始，未开始推送。") : notRequested }
    }
  }

  async push(input: ProjectPushInput): Promise<ProjectPushResult> {
    try {
      return await this.withWriteRepository(async repository => {
        const confirmed = this.confirmed
        if (!confirmed || confirmed.sha !== input.commitSha) {
          return skippedPush("invalid-selection", "仅可推送本机端口已确认的提交。")
        }
        if (confirmed.push.status === "unknown" || confirmed.push.status === "succeeded") return confirmed.push
        confirmed.push = await this.pushConfirmed(repository, confirmed, input.snapshot)
        return confirmed.push
      })
    } catch (error) {
      const failure = filesystemError(error)
      return skippedPush(failure.code, failure.message)
    }
  }

  private async pushConfirmed(repository: GitRepository, commit: ConfirmedCommit, snapshot?: string): Promise<ProjectPushResult> {
    try {
      // 组合调用没有提交后快照，必须重新读取。单独推送则复核调用者刚取得的快照。
      const state = snapshot === undefined ? await inspect(repository) : await fresh(repository, snapshot)
      if (state.branchRef !== commit.branchRef) return skippedPush("git-stale", "提交后分支已变化，本次没有推送。")
      return await pushTarget(repository, state, commit.sha, commit.target)
    } catch (error) {
      const failure = filesystemError(error)
      return skippedPush(failure.code, failure.message)
    }
  }

  private async withReadableRepository<T>(action: (repository: GitRepository) => Promise<T>): Promise<T> {
    try {
      const repository = await openRepository(this.root)
      const keys = [this.root.identity, repository.commonDir]
      if (keys.some(key => occupied.has(key))) throw new ProjectServiceError("git-busy", "当前项目正在写入 Git，请稍后刷新。")
      const result = await action(repository)
      if (keys.some(key => occupied.has(key))) throw new ProjectServiceError("git-busy", "当前项目正在写入 Git，请稍后刷新。")
      return result
    } catch (error) {
      throw filesystemError(error)
    }
  }

  private async withWriteRepository<T>(action: (repository: GitRepository) => Promise<T>): Promise<T> {
    const repository = await openRepository(this.root)
    const keys = [this.root.identity, repository.commonDir]
    if (keys.some(key => occupied.has(key))) throw new ProjectServiceError("git-busy", "当前项目正在写入 Git，请稍后刷新。")
    for (const key of keys) occupied.add(key)
    try {
      return await action(repository)
    } finally {
      for (const key of keys) occupied.delete(key)
    }
  }
}
