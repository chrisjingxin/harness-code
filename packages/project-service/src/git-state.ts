/** 原设备 Git 状态与审阅版本。只允许对宿主登记的完整工作树操作。 */
import { lstat, open, readlink, realpath } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { digest, gitCommand, gitLine, gitOptional, gitRun, gitText } from "./git-command.js"
import { ProjectRoot, sameFileVersion, validRelativePath } from "./root.js"
import { ProjectServiceError } from "./types.js"
import type { ProjectGitDiff, ProjectGitFile, ProjectGitStatus } from "./types.js"

export const MAX_GIT_FILES = 1_000
export const MAX_GIT_BYTES = 32 * 1024 * 1024
const MAX_INDEX_BYTES = 32 * 1024 * 1024
const DIFF_LIMIT = 96 * 1024

export type GitRepository = { root: ProjectRoot; gitDir: string; commonDir: string; indexPath: string }
export type GitTarget = { remote: string; ref: string; address: string }
export type GitStage = { mode: string; object: string; stage: string }
export type WorkingInput = { kind: "deleted" } | { kind: "file" | "symlink"; bytes: Buffer; executable: number }
export type GitInspection = {
  status: ProjectGitStatus
  branchRef: string | null
  target: GitTarget | null
  worktree: ReadonlyMap<string, string>
}

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (!missing(error)) throw error
    return false
  }
}

export async function openRepository(root: ProjectRoot): Promise<GitRepository> {
  await root.verify()
  const probe = await gitCommand(root.path, ["rev-parse", "--show-toplevel"])
  if (probe.state !== "exited" || probe.code !== 0) {
    throw new ProjectServiceError("git-unavailable", "该项目没有可用的 Git 工作树。")
  }
  if (await realpath(gitLine(probe.stdout)) !== root.path) {
    throw new ProjectServiceError("git-root-required", "Git 操作需要登记完整仓库根。")
  }
  const [gitDir, commonDir, indexPath] = await Promise.all(
    ["--absolute-git-dir", "--git-common-dir", "--git-path"].map(option => gitRun(root.path,
      ["rev-parse", "--path-format=absolute", option, ...(option === "--git-path" ? ["index"] : [])],
    )),
  )
  const canonicalGitDir = await realpath(resolve(root.path, gitLine(gitDir)))
  const canonicalCommonDir = await realpath(resolve(root.path, gitLine(commonDir)))
  await root.verify()
  return { root, gitDir: canonicalGitDir, commonDir: canonicalCommonDir, indexPath: resolve(root.path, gitLine(indexPath)) }
}

export async function readHead(repository: GitRepository): Promise<{ head: string | null; branchRef: string | null }> {
  const [head, branch] = await Promise.all([
    gitOptional(repository.root.path, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    gitOptional(repository.root.path, ["symbolic-ref", "--quiet", "HEAD"]),
  ])
  return { head: head ? gitLine(head) : null, branchRef: branch ? gitLine(branch) : null }
}

async function indexDigest(path: string): Promise<string> {
  try {
    const handle = await open(path, "r")
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_INDEX_BYTES) {
        throw new ProjectServiceError("limit-exceeded", "Git 索引超出安全处理范围。")
      }
      const bytes = Buffer.alloc(info.size + 1)
      let used = 0
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used)
        if (!bytesRead) break
        used += bytesRead
      }
      if (used !== info.size || !sameFileVersion(info, await handle.stat()) || !sameFileVersion(info, await lstat(path))) {
        throw new ProjectServiceError("git-stale", "Git 索引已变化，请刷新。")
      }
      return digest(bytes.subarray(0, used))
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (missing(error)) return "empty"
    throw error
  }
}

export async function readStages(repository: GitRepository, index?: string): Promise<Map<string, GitStage[]>> {
  const output = gitText(await gitRun(repository.root.path, ["ls-files", "--stage", "-z"], { index }))
  const stages = new Map<string, GitStage[]>()
  for (const row of output.split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t")
    const path = row.slice(tab + 1)
    const [mode, object, stage] = row.slice(0, tab).split(" ")
    if (tab < 0 || !mode || !object || !stage) throw new ProjectServiceError("git-failed", "Git 索引格式无效。")
    const item = { mode, object, stage }
    const previous = stages.get(path)
    if (previous) previous.push(item)
    else stages.set(path, [item])
  }
  return stages
}

async function readBaseline(repository: GitRepository, head: string): Promise<Map<string, string>> {
  const output = gitText(await gitRun(repository.root.path, ["ls-tree", "-r", "-z", "--full-tree", head]))
  const files = new Map<string, string>()
  for (const row of output.split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t")
    files.set(row.slice(tab + 1), row.slice(0, tab))
  }
  return files
}

async function readTarget(repository: GitRepository, branch: string | null, head: string | null): Promise<{
  target: GitTarget | null; upstream: ProjectGitStatus["upstream"]
}> {
  const unavailable = { target: null, upstream: null }
  if (!branch || !head) return unavailable
  const cwd = repository.root.path
  const [remoteConfig, refConfig] = await Promise.all([
    gitOptional(cwd, ["config", "--get", `branch.${branch}.remote`]),
    gitOptional(cwd, ["config", "--get", `branch.${branch}.merge`]),
  ])
  if (!remoteConfig || !refConfig) return unavailable
  const remote = gitLine(remoteConfig)
  const ref = gitLine(refConfig)
  if (!/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/.test(remote) || !ref.startsWith("refs/heads/")) return unavailable
  const [addresses, counts] = await Promise.all([
    gitOptional(cwd, ["remote", "get-url", "--push", "--all", "--", remote], 2),
    gitOptional(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], 128),
  ])
  if (!addresses || !counts) return unavailable
  const address = gitLine(addresses)
  const [ahead, behind] = gitLine(counts).split(/\s+/).map(Number)
  if (!address || /[\r\n]/.test(address) || !Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return unavailable
  return { target: { remote, ref, address }, upstream: { remote, branch: ref.slice("refs/heads/".length), ahead, behind } }
}

export function targetKey(target: GitTarget | null): string | null {
  return target && digest(JSON.stringify([target.remote, target.ref, target.address]))
}

/** 按 Git 字面路径读取工作树输入，最终 symlink 只读取链接文本。 */
export async function workingInput(repository: GitRepository, path: string, budget: { remaining: number }): Promise<WorkingInput> {
  const { root, gitDir, commonDir } = repository
  const absolute = root.relativePath(path)
  const protectedPaths = [gitDir, commonDir]
  // 删除的文件可能连父目录也已消失，向上找到仍存在的父目录核对范围。
  let parent = dirname(absolute)
  while (!await exists(parent)) {
    if (parent === root.path) {
      await root.verify()
      throw new ProjectServiceError("root-changed", "登记的项目根已变化。")
    }
    parent = dirname(parent)
  }
  const actualParent = await realpath(parent)
  root.assertReadable(actualParent, protectedPaths)
  if (actualParent !== parent) throw new ProjectServiceError("outside-project", "Git 路径不能穿过目录链接。")
  let info
  try {
    info = await lstat(absolute)
  } catch (error) {
    if (missing(error)) return { kind: "deleted" }
    throw error
  }
  if (!info.isFile() && !info.isSymbolicLink()) {
    throw new ProjectServiceError("unsupported", "Git 变更包含无法安全处理的特殊文件。")
  }
  if (info.size > budget.remaining) throw new ProjectServiceError("limit-exceeded", "Git 变更超出 32 MiB 检查预算。")
  if (info.isSymbolicLink()) {
    const bytes = await readlink(absolute, { encoding: "buffer" })
    if (bytes.length > budget.remaining || !sameFileVersion(info, await lstat(absolute)) || await realpath(parent) !== actualParent) {
      throw new ProjectServiceError("git-stale", "变更链接在检查期间变化，请刷新。")
    }
    budget.remaining -= bytes.length
    return { kind: "symlink", bytes, executable: 0 }
  }
  const bytes = await root.readRegular(absolute, info.size, protectedPaths, info)
  budget.remaining -= bytes.length
  return { kind: "file", bytes, executable: info.mode & 0o111 }
}

export function inputVersion(input: WorkingInput): string {
  return input.kind === "deleted" ? "deleted" : digest(JSON.stringify([input.kind, input.executable, digest(input.bytes)]))
}

function parseChanges(raw: string): Omit<ProjectGitFile, "version">[] {
  const rows = raw.split("\0")
  const files: Omit<ProjectGitFile, "version">[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (!row) continue
    const status = row.slice(0, 2)
    const path = row.slice(3)
    const oldPath = /[RC]/.test(status) ? rows[++index] : undefined
    if (!validRelativePath(path) || (/^[RC]|[RC]$/.test(status) && !oldPath)
      || (oldPath !== undefined && !validRelativePath(oldPath))) {
      throw new ProjectServiceError("invalid-path", "Git 变更含无法安全处理的路径。")
    }
    files.push({ status, path, ...(oldPath !== undefined ? { oldPath } : {}) })
    if (files.length > MAX_GIT_FILES) throw new ProjectServiceError("limit-exceeded", "Git 变更超过 1000 项。")
  }
  return files
}

export async function inspect(repository: GitRepository): Promise<GitInspection> {
  const { root, gitDir, indexPath } = repository
  await root.verify()
  const before = await readHead(repository)
  const index = await indexDigest(indexPath)
  const branch = before.branchRef?.startsWith("refs/heads/") ? before.branchRef.slice("refs/heads/".length) : null
  let blockedReason = branch ? null : "当前为分离 HEAD，请先在原设备切换到分支。"
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer"]) {
    if (await exists(resolve(gitDir, name))) blockedReason = "Git 合并、变基或拣选进行中，请先在原设备处理。"
  }
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]
  const raw = gitText(await gitRun(root.path, statusArgs))
  const files = parseChanges(raw)
  const [stages, baseline, { target, upstream }] = await Promise.all([
    readStages(repository),
    before.head && files.length ? readBaseline(repository, before.head) : new Map<string, string>(),
    readTarget(repository, branch, before.head),
  ])
  for (const entries of stages.values()) {
    if (entries.some(item => item.mode === "160000")) blockedReason = "仓库包含子模块，请在原设备处理。"
    if (entries.some(item => item.stage !== "0")) blockedReason = "存在冲突文件，请在原设备处理。"
  }
  const worktree = new Map<string, string>()
  const budget = { remaining: MAX_GIT_BYTES }
  const versions: ProjectGitFile[] = []
  for (const file of files) {
    const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]
    for (const path of paths) {
      if (!worktree.has(path)) {
        // 子模块只作为 Git 元数据展示，不能由文件提交端口写入或读取它的目录作为文件。
        const isSubmodule = stages.get(path)?.some(item => item.mode === "160000") || baseline.get(path)?.startsWith("160000 ")
        if (isSubmodule) blockedReason = "仓库包含子模块，请在原设备处理。"
        worktree.set(path, isSubmodule ? "submodule" : inputVersion(await workingInput(repository, path, budget)))
      }
    }
    const inputs = paths.map(path => [path, baseline.get(path), stages.get(path), worktree.get(path)])
    versions.push({ ...file, version: digest(JSON.stringify([file.status, inputs])) })
  }
  const after = await readHead(repository)
  if (after.head !== before.head || after.branchRef !== before.branchRef || await indexDigest(indexPath) !== index
    || gitText(await gitRun(root.path, statusArgs)) !== raw) {
    throw new ProjectServiceError("git-stale", "Git 状态已变化，请刷新。")
  }
  await root.verify()
  const snapshot = digest(JSON.stringify([
    root.identity, gitDir, repository.commonDir, indexPath, before.branchRef, before.head, index, versions,
    upstream, targetKey(target), blockedReason,
  ]))
  return { status: { branch, head: before.head, files: versions, snapshot, upstream, blockedReason }, branchRef: before.branchRef, target, worktree }
}

export async function fresh(repository: GitRepository, snapshot: string): Promise<GitInspection> {
  const current = await inspect(repository)
  if (current.status.snapshot !== snapshot) throw new ProjectServiceError("git-stale", "文件、索引或分支已变化，请刷新后重新检查。")
  return current
}

export async function readDiff(repository: GitRepository, snapshot: string, path: string): Promise<ProjectGitDiff> {
  const state = await fresh(repository, snapshot)
  const file = state.status.files.find(item => item.path === path)
  if (!file) throw new ProjectServiceError("invalid-selection", "文件不属于当前变更。")
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"]
  let text: string
  if (file.status === "??" || !state.status.head) {
    const result = await gitCommand(repository.root.path, [
      ...args, "--no-index", "--", process.platform === "win32" ? "NUL" : "/dev/null", file.path,
    ])
    if (result.state !== "exited" || result.code > 1) throw new ProjectServiceError("git-failed", "无法读取该文件的 Diff。")
    text = result.stdout.toString("utf8")
  } else {
    const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]
    text = (await gitRun(repository.root.path, [...args, state.status.head, "--", ...paths])).toString("utf8")
  }
  await fresh(repository, snapshot)
  return {
    path, snapshot, truncated: text.length > DIFF_LIMIT,
    text: text.slice(0, DIFF_LIMIT).replace(/[\uD800-\uDBFF]$/u, "") || "无可显示的文本差异，可能仅权限、二进制或元数据有变化。",
  }
}
