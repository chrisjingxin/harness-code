/** Git 写入策略。原索引用 Git 自己的锁名保护，独立索引只接收已审阅的路径。 */
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { gitCommand, gitLine, gitRun } from "./git-command.js"
import { fresh, inputVersion, MAX_GIT_BYTES, missing, readHead, readStages, targetKey, workingInput } from "./git-state.js"
import type { GitInspection, GitRepository } from "./git-state.js"
import { ProjectServiceError } from "./types.js"
import type { ProjectPushResult } from "./types.js"

type CommitAttempt =
  | { status: "succeeded"; commitSha: string; warning?: string }
  | { status: "not-started" | "failed" | "unknown"; code: "git-unavailable" | "git-failed" | "result-unknown"; message: string }

const quote = (text: string): string => "'" + text.replaceAll("'", "'\\''") + "'"

async function guardHooks(repository: GitRepository, directory: string, tree: string): Promise<{ hooks: string; receipt: string }> {
  const root = repository.root.path
  const original = resolve(root, gitLine(await gitRun(root, ["rev-parse", "--git-path", "hooks"])))
  const hooks = join(directory, "hooks")
  const receipt = join(directory, "commit-head")
  await mkdir(hooks)
  for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
    const target = quote(join(original, name))
    const callOriginal = `if [ -x ${target} ]; then\n  ${target} "$@" || exit $?\nfi\n`
    // post-commit 记录本次调用实际写入的 HEAD，其他进程后来移动 HEAD 时不能误认其提交。
    const script = name === "post-commit"
      ? `head=$(git rev-parse --verify HEAD) || exit 1\nprintf '%s\\n' "$head" > ${quote(receipt)} || exit 1\n${callOriginal}`
      : `${callOriginal}actual=$(git write-tree) || exit 1\nif [ "$actual" != ${quote(tree)} ]; then\n  echo 'Git hook changed reviewed index' >&2\n  exit 1\nfi\n`
    await writeFile(join(hooks, name), `#!/bin/sh\n${script}`, { mode: 0o700 })
  }
  return { hooks, receipt }
}

async function verifySelectedTree(
  repository: GitRepository, state: GitInspection, index: string, paths: readonly string[],
): Promise<void> {
  const root = repository.root.path
  const stages = await readStages(repository, index)
  const budget = { remaining: MAX_GIT_BYTES }
  for (const path of paths) {
    const input = await workingInput(repository, path, budget)
    const stage = stages.get(path)?.[0]
    if (inputVersion(input) !== state.worktree.get(path) || (input.kind === "deleted") !== !stage) {
      throw new ProjectServiceError("git-stale", "所选文件已变化，请重新审阅。")
    }
    if (input.kind === "deleted" || !stage) continue
    // Git 可能按仓库配置处理换行和 clean filter。用相同规则校验独立索引确实来自审阅的字节。
    const hashArgs = stage.mode === "120000" ? [] : [`--path=${path}`]
    const object = gitLine(await gitRun(root, ["hash-object", ...hashArgs, "--stdin"], { index, input: input.bytes }))
    if (stage.object !== object || (input.kind === "symlink" && stage.mode !== "120000")) {
      throw new ProjectServiceError("git-stale", "独立索引与审阅内容不符，请刷新。")
    }
  }
}

export async function commitSelection(
  repository: GitRepository, state: GitInspection, paths: readonly string[], message: string,
): Promise<CommitAttempt> {
  const { root, indexPath, gitDir } = repository
  const lockPath = indexPath + ".lock"
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new ProjectServiceError("git-busy", "Git 索引正被其他操作使用，请刷新后重试。")
    throw error
  })
  let directory: string | undefined
  let ownsLock = true
  try {
    directory = await mkdtemp(join(gitDir, "workbench-index-"))
    const selected = join(directory, "selected")
    const merged = join(directory, "merged")
    const pathspec = paths.join("\0") + "\0"
    await fresh(repository, state.status.snapshot)
    await gitRun(root.path, ["read-tree", state.status.head ?? "--empty"], { index: selected })
    await gitRun(root.path, ["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], { index: selected, input: pathspec })
    const diffPaths = (await gitRun(root.path, ["diff", "--cached", "--no-renames", "--name-only", "-z"], { index: selected }))
      .toString("utf8").split("\0").filter(Boolean)
    if (!diffPaths.length) throw new ProjectServiceError("invalid-selection", "所选文件没有可提交的改动。")
    const allowed = new Set(paths)
    if (diffPaths.some(path => !allowed.has(path))) throw new ProjectServiceError("git-stale", "独立索引包含未选路径，请刷新。")
    await verifySelectedTree(repository, state, selected, paths)
    const tree = gitLine(await gitRun(root.path, ["write-tree"], { index: selected }))
    const { hooks, receipt } = await guardHooks(repository, directory, tree)
    await fresh(repository, state.status.snapshot)

    const result = await gitCommand(root.path, ["-c", `core.hooksPath=${hooks}`, "commit", "--file=-"], {
      index: selected, input: message, timeout: 60_000,
    })
    if (result.state === "unavailable") return { status: "not-started", code: "git-unavailable", message: "无法启动 Git 提交。" }

    const unknown: CommitAttempt = { status: "unknown", code: "result-unknown", message: "提交结果待确认，请在原设备核对，勿重复提交。" }
    let commitSha: string
    try {
      const after = await readHead(repository)
      const marked = await readFile(receipt, "utf8").catch(error => {
        if (missing(error)) return ""
        throw error
      })
      if (result.state === "exited" && result.code !== 0 && !marked
        && after.head === state.status.head && after.branchRef === state.branchRef) {
        return { status: "failed", code: "git-failed", message: "Git 拒绝提交，请检查本机身份、签名或 hooks。" }
      }
      if (!after.head || after.branchRef !== state.branchRef || marked !== after.head + "\n" || after.head === state.status.head) return unknown
      const metadata = gitLine(await gitRun(root.path, ["show", "--no-patch", "--no-show-signature", "--format=%T%x00%P", after.head]))
      if (metadata !== tree + "\0" + (state.status.head ?? "")) return unknown
      commitSha = after.head
    } catch {
      return unknown
    }

    let warning = result.state === "exited" && result.code === 0 ? undefined
      : "提交已生成，但 Git 命令异常结束。请在原设备检查后再推送。"
    try {
      const original = await lstat(indexPath).catch(error => {
        if (missing(error)) return null
        throw error
      })
      if (original) await copyFile(indexPath, merged)
      else await gitRun(root.path, ["read-tree", "--empty"], { index: merged })
      // 只推进原索引的选中项。未选文件的暂存条目沿用原索引。
      await gitRun(root.path, ["reset", "--quiet", commitSha, "--pathspec-from-file=-", "--pathspec-file-nul"], {
        index: merged, input: pathspec,
      })
      const after = await readHead(repository)
      if (after.head !== commitSha || after.branchRef !== state.branchRef) throw new Error("HEAD changed")
      await lock.writeFile(await readFile(merged))
      await lock.close()
      await rename(lockPath, indexPath)
      ownsLock = false
    } catch {
      warning = "提交已成功，但原索引同步未完成。请在原设备检查暂存区，勿重复提交。"
    }
    return { status: "succeeded", commitSha, ...(warning ? { warning } : {}) }
  } finally {
    await lock.close().catch(() => {})
    // rename 后锁名可能已被外部 Git 重新取得，不能清理它的新锁。
    if (ownsLock) await rm(lockPath, { force: true }).catch(() => {})
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

export async function pushTarget(
  repository: GitRepository, state: GitInspection, commitSha: string, originalTarget: string | null,
): Promise<ProjectPushResult> {
  if (state.status.blockedReason) throw new ProjectServiceError("git-blocked", state.status.blockedReason)
  if (state.status.head !== commitSha) throw new ProjectServiceError("git-stale", "当前 HEAD 与已确认的提交不同。")
  const target = state.target
  if (!target || !originalTarget) throw new ProjectServiceError("upstream-unavailable", "当前提交没有可用的既有 upstream。")
  if (targetKey(target) !== originalTarget) throw new ProjectServiceError("upstream-changed", "upstream 已变化，本次没有推送。")
  const cwd = repository.root.path
  const probe = await gitCommand(cwd, ["ls-remote", "--exit-code", "--refs", "--", target.address, target.ref], { timeout: 60_000 })
  if (probe.state !== "exited" || probe.code !== 0
    || !probe.stdout.toString("utf8").split("\n").some(line => line.split("\t")[1] === target.ref)) {
    throw new ProjectServiceError("upstream-unavailable", "无法确认既有远端分支，本次没有推送。")
  }
  await fresh(repository, state.status.snapshot)
  const result = await gitCommand(cwd, [
    "-c", `remote.${target.remote}.mirror=false`, "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no",
    "--", target.remote, `${commitSha}:${target.ref}`,
  ], { timeout: 60_000 })
  if (result.state === "exited" && result.code === 0) return { status: "succeeded" }
  if (result.state === "unavailable") {
    return { status: "not-started", code: "git-unavailable", message: "无法启动 Git 推送。" }
  }
  if (result.state === "exited" && result.stdout.toString("utf8").split("\n").some(line => {
    const [flag, refs, summary] = line.split("\t")
    return flag === "!" && refs?.endsWith(`:${target.ref}`) && /^\[(?:rejected|remote rejected)\]/.test(summary ?? "")
  })) {
    return { status: "failed", code: "git-failed", message: "远端拒绝推送，已确认的提交仍保留。" }
  }
  return { status: "unknown", code: "result-unknown", message: "推送结果待确认，请在原设备核对，勿重复推送。" }
}
