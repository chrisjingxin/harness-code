/**
 * 【功能定义】原设备只读 Git 状态与差异读取。
 * 【协作边界】仅对宿主登记的完整仓库根返回变更与差异；普通非 Git 目录及仓库子目录均平静降级为非 Git 状态。
 */
import { lstat, open, readlink, realpath } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { digest, gitCommand, gitLine, gitRun, gitText } from "./git-command.js"
import { ProjectRoot, sameFileVersion, validRelativePath } from "./root.js"
import { ProjectServiceError } from "./types.js"
import type { ProjectGitDiff, ProjectGitFile, ProjectGitStatus } from "./types.js"

export const MAX_GIT_FILES = 1_000
const MAX_INDEX_BYTES = 32 * 1024 * 1024
const MAX_HASH_FILE_BYTES = 1024 * 1024
const DIFF_LIMIT = 96 * 1024

export type GitRepository = { root: ProjectRoot; gitDir: string; commonDir: string; indexPath: string }
export type WorkingInput = { kind: "deleted" } | { kind: "file" | "symlink"; digest: string; executable: number }
export type GitInspection = {
  status: ProjectGitStatus
  branchRef: string | null
}

function missing(error: unknown): boolean {
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

/** 仅当规范路径恰好是 Git 仓库顶层目录时视为 Git 仓库根，防止子目录误借上层仓库边界。 */
export async function detectGitRoot(canonicalRoot: string): Promise<{ isGitRepository: boolean; protectedPaths: string[] }> {
  const probe = await gitCommand(canonicalRoot, ["rev-parse", "--show-toplevel"], { timeout: 3_000 })
  if (probe.state !== "exited" || probe.code !== 0) {
    return { isGitRepository: false, protectedPaths: [] }
  }
  const actualTop = await realpath(gitLine(probe.stdout)).catch(() => "")
  if (actualTop !== canonicalRoot) {
    return { isGitRepository: false, protectedPaths: [] }
  }
  const protectedPaths = new Set<string>()
  for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
    const result = await gitCommand(canonicalRoot, ["rev-parse", "--path-format=absolute", flag], { timeout: 3_000 })
    if (result.state === "exited" && result.code === 0) {
      const target = resolve(canonicalRoot, gitLine(result.stdout))
      protectedPaths.add(target)
      protectedPaths.add(await realpath(target).catch(() => target))
    }
  }
  return { isGitRepository: true, protectedPaths: [...protectedPaths] }
}

/** 普通非 Git 文件夹或仓库子目录的平静降级状态。 */
export function nonGitStatus(): ProjectGitStatus {
  return {
    branch: null,
    head: null,
    files: [],
    snapshot: "non-git",
    upstream: null,
    blockedReason: "当前目录不是 Git 仓库，仅提供本地文件浏览；Git 写操作已暂缓。",
  }
}

export async function openRepository(root: ProjectRoot): Promise<GitRepository | null> {
  await root.verify()
  const detected = await detectGitRoot(root.path)
  if (!detected.isGitRepository) return null
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

async function readHead(repository: GitRepository): Promise<{ head: string | null; branchRef: string | null }> {
  const [headRes, branchRes] = await Promise.all([
    gitCommand(repository.root.path, ["rev-parse", "--verify", "--quiet", "HEAD"], { timeout: 3_000 }),
    gitCommand(repository.root.path, ["symbolic-ref", "--quiet", "HEAD"], { timeout: 3_000 }),
  ])
  return {
    head: headRes.state === "exited" && headRes.code === 0 ? gitLine(headRes.stdout) : null,
    branchRef: branchRes.state === "exited" && branchRes.code === 0 ? gitLine(branchRes.stdout) : null,
  }
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

async function readStages(repository: GitRepository): Promise<Map<string, { mode: string; object: string; stage: string }[]>> {
  const output = gitText(await gitRun(repository.root.path, ["ls-files", "--stage", "-z"]))
  const stages = new Map<string, { mode: string; object: string; stage: string }[]>()
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

async function readUpstream(repository: GitRepository, branch: string | null, head: string | null): Promise<ProjectGitStatus["upstream"]> {
  if (!branch || !head) return null
  const cwd = repository.root.path
  const [counts, fullRef] = await Promise.all([
    gitCommand(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { timeout: 3_000 }),
    gitCommand(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { timeout: 3_000 }),
  ])
  if (counts.state !== "exited" || counts.code !== 0 || fullRef.state !== "exited" || fullRef.code !== 0) {
    return null
  }
  const [ahead, behind] = gitLine(counts.stdout).trim().split(/\s+/).map(Number)
  const full = gitLine(fullRef.stdout).trim()
  const slash = full.indexOf("/")
  if (slash <= 0 || !Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return null
  return { remote: full.slice(0, slash), branch: full.slice(slash + 1), ahead, behind }
}

/** 按 Git 字面路径核对并采集文件版本摘要；超过 1 MiB 的大文件改用元数据摘要避免撑爆内存。 */
async function workingInput(repository: GitRepository, path: string): Promise<WorkingInput> {
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
    return { kind: "file", digest: digest(JSON.stringify(["special", info.mode, info.size, info.mtimeMs])), executable: 0 }
  }
  if (info.isSymbolicLink()) {
    const bytes = await readlink(absolute, { encoding: "buffer" })
    if (!sameFileVersion(info, await lstat(absolute)) || await realpath(parent) !== actualParent) {
      throw new ProjectServiceError("git-stale", "变更链接在检查期间变化，请刷新。")
    }
    return { kind: "symlink", digest: digest(bytes), executable: 0 }
  }
  if (info.size > MAX_HASH_FILE_BYTES) {
    return {
      kind: "file",
      digest: digest(JSON.stringify(["large", info.size, info.mtimeMs, info.ctimeMs])),
      executable: info.mode & 0o111,
    }
  }
  const bytes = await root.readRegular(absolute, info.size, protectedPaths, info)
  return { kind: "file", digest: digest(bytes), executable: info.mode & 0o111 }
}

function inputVersion(input: WorkingInput): string {
  return input.kind === "deleted" ? "deleted" : digest(JSON.stringify([input.kind, input.executable, input.digest]))
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
    if (files.length >= MAX_GIT_FILES) break
  }
  return files
}

export async function inspect(repository: GitRepository): Promise<GitInspection> {
  const { root, gitDir, indexPath } = repository
  await root.verify()
  const before = await readHead(repository)
  const index = await indexDigest(indexPath)
  const branch = before.branchRef?.startsWith("refs/heads/") ? before.branchRef.slice("refs/heads/".length) : null
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]
  const raw = gitText(await gitRun(root.path, statusArgs))
  const files = parseChanges(raw)
  const [stages, baseline, upstream] = await Promise.all([
    readStages(repository),
    before.head && files.length ? readBaseline(repository, before.head) : new Map<string, string>(),
    readUpstream(repository, branch, before.head),
  ])
  const worktree = new Map<string, string>()
  const versions: ProjectGitFile[] = []
  for (const file of files) {
    const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]
    for (const path of paths) {
      if (!worktree.has(path)) {
        // 子模块只作为 Git 元数据展示，不能把子模块目录当作普通文件读取。
        const isSubmodule = stages.get(path)?.some(item => item.mode === "160000") || baseline.get(path)?.startsWith("160000 ")
        worktree.set(path, isSubmodule ? "submodule" : inputVersion(await workingInput(repository, path)))
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
    root.identity, gitDir, repository.commonDir, indexPath, before.branchRef, before.head, index, versions, upstream,
  ]))
  return {
    status: { branch, head: before.head, files: versions, snapshot, upstream, blockedReason: null },
    branchRef: before.branchRef,
  }
}

export async function readDiff(repository: GitRepository, snapshot: string, path: string): Promise<ProjectGitDiff> {
  const state = await inspect(repository)
  if (state.status.snapshot !== snapshot) {
    throw new ProjectServiceError("git-stale", "文件、索引或分支已变化，请刷新后重新检查。")
  }
  const file = state.status.files.find(item => item.path === path)
  if (!file) throw new ProjectServiceError("not-found", "该文件不在当前变更列表中。")
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
  const after = await inspect(repository)
  if (after.status.snapshot !== snapshot) {
    throw new ProjectServiceError("git-stale", "工作区变更已更新，请先刷新变更列表。")
  }
  return {
    path,
    snapshot,
    truncated: text.length > DIFF_LIMIT,
    text: text.slice(0, DIFF_LIMIT).replace(/[\uD800-\uDBFF]$/u, "") || "无可显示的文本差异，可能仅权限、二进制或元数据有变化。",
  }
}
