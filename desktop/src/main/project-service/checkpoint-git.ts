/** 轮次快照使用工作树的原始文件内容，恢复只触碰预检确认的普通文件。 */
import { randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { link, lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { gitCommand, gitLine, gitRun, gitText } from "./git-command.js"
import { DIFF_LIMIT, MAX_GIT_FILES, type GitRepository } from "./git-state.js"
import { sameFileVersion, validRelativePath } from "./root.js"

export const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const CHECKPOINT_BUDGET_MS = 5_000
const MAX_BYTES = 32 * 1024 * 1024
type TreeEntry = { mode: string; oid: string }
type CurrentEntry = TreeEntry & { stat: Stats }
export type CapturedTree = { tree: string; files: Map<string, CurrentEntry> }

function checkedPath(path: string): string {
  if (!validRelativePath(path)) throw new Error("快照含无法安全处理的 Git 路径。")
  return path
}

async function fileInfo(path: string): Promise<Stats | undefined> {
  try { return await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function checkParents(repo: GitRepository, path: string, known: Set<string>, create = false): Promise<void> {
  const { root, gitDir, commonDir } = repo
  const parent = dirname(path)
  if (parent === root.path || known.has(parent)) return
  await checkParents(repo, parent, known, create)
  root.assertReadable(parent, [gitDir, commonDir])
  let info = await fileInfo(parent)
  if (!info && create) {
    await mkdir(parent)
    info = await lstat(parent)
  }
  if (!info) return
  if (!info.isDirectory() || await realpath(parent) !== parent || await fileInfo(join(parent, ".git"))) {
    throw new Error("路径经过链接、嵌套仓库或其他无法安全处理的目录。")
  }
  known.add(parent)
}

/** 失败或超限时整轮降级。把经核对的文件复制到临时目录后再交给 Git，避免执行过滤器。 */
export async function captureCheckpointTree(repo: GitRepository, deadline = Date.now() + CHECKPOINT_BUDGET_MS): Promise<CapturedTree> {
  const { root, gitDir, commonDir } = repo
  const temp = await mkdtemp(join(tmpdir(), "workbench-git-"))
  const timeLeft = () => {
    const left = deadline - Date.now()
    if (left < 1) throw new Error("捕获代码快照超时。")
    return left
  }
  const index = join(temp, "index")
  const run = (args: string[], input?: Buffer) =>
    gitRun(root.path, args, { index, input, timeout: timeLeft(), maxBuffer: 2 * 1024 * 1024 })
  try {
    await root.verify()
    // 用真实索引列出暂存路径，用 HEAD 补齐从索引移除但仍留在磁盘的路径。
    const opts = { timeout: timeLeft(), maxBuffer: 2 * 1024 * 1024 }
    const [tracked, untracked, head] = await Promise.all([
      gitRun(root.path, ["ls-files", "--stage", "-z"], opts),
      gitRun(root.path, ["ls-files", "--others", "--exclude-standard", "-z"], opts),
      gitCommand(root.path, ["rev-parse", "--verify", "--quiet", "HEAD"], opts),
    ])
    if (head.state !== "exited" || head.code > 1) throw new Error("无法核对 Git HEAD。")
    const candidates = new Set<string>()
    for (const row of gitText(tracked).split("\0").filter(Boolean)) {
      const tab = row.indexOf("\t")
      if (tab < 0 || row.startsWith("160000 ")) throw new Error("含子模块的仓库暂不支持轮次快照。")
      candidates.add(checkedPath(row.slice(tab + 1)))
    }
    if (head.code === 0) {
      for (const [path] of await readCheckpointTree(repo, gitLine(head.stdout), timeLeft())) candidates.add(path)
    }
    for (const path of gitText(untracked).split("\0").filter(Boolean)) candidates.add(checkedPath(path))
    if (candidates.size > MAX_GIT_FILES) throw new Error("文件数量超出快照上限。")

    const parents = new Set<string>()
    const files: { path: string; stat: Stats; mode: string; copy: string }[] = []
    let bytes = 0
    for (const path of candidates) {
      timeLeft()
      const absolute = root.relativePath(path)
      root.assertReadable(absolute, [gitDir, commonDir])
      await checkParents(repo, absolute, parents)
      const info = await fileInfo(absolute)
      if (!info) continue
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error("工作树包含无法记录的特殊文件。")
      bytes += info.size
      if (bytes > MAX_BYTES) throw new Error("文件数据超出 32 MiB 快照上限。")
      const data = info.isSymbolicLink()
        ? await readlink(absolute, { encoding: "buffer" })
        : await root.readRegular(absolute, info.size, [gitDir, commonDir], info)
      const copy = join(temp, String(files.length))
      await writeFile(copy, data, { flag: "wx" })
      files.push({ path, stat: info, mode: info.isSymbolicLink() ? "120000" : info.mode & 0o100 ? "100755" : "100644", copy })
    }

    const objects: string[] = []
    for (let offset = 0; offset < files.length; offset += 100) {
      const batch = files.slice(offset, offset + 100)
      const output = gitLine(await run(["hash-object", "-w", "--no-filters", "--", ...batch.map(item => item.copy)]))
      objects.push(...output.split("\n"))
    }
    if (objects.length !== files.length || objects.some(oid => !objectId.test(oid))) throw new Error("Git 快照对象不完整。")
    const captured = new Map<string, CurrentEntry>()
    const indexRows = files.map(({ path, stat, mode }, i) => {
      const oid = objects[i]
      captured.set(path, { stat, mode, oid })
      return mode + " " + oid + "\t" + path + "\0"
    })
    await run(["read-tree", "--empty"])
    if (files.length) await run(["update-index", "-z", "--index-info"], Buffer.from(indexRows.join("")))
    const tree = gitLine(await run(["write-tree"]))
    if (!objectId.test(tree)) throw new Error("Git 快照树无效。")
    await root.verify()
    for (const [path, { stat }] of captured) {
      timeLeft()
      if (!sameFileVersion(stat, await lstat(root.relativePath(path)))) throw new Error("文件在快照期间已变化。")
    }
    return { tree, files: captured }
  } finally { await rm(temp, { recursive: true, force: true }).catch(() => {}) }
}

export async function writeCheckpointRef(repo: GitRepository, tree: string, ref: string, deadline = Date.now() + CHECKPOINT_BUDGET_MS): Promise<string> {
  if (!objectId.test(tree)) throw new Error("Git 快照树无效。")
  const cwd = repo.root.path
  const options = () => {
    const timeout = deadline - Date.now()
    if (timeout < 1) throw new Error("捕获代码快照超时。")
    return { timeout: Math.min(timeout, 1000) }
  }
  const oid = gitLine(await gitRun(cwd, [
    "-c", "user.name=Workbench", "-c", "user.email=workbench@localhost", "-c", "core.hooksPath=",
    "commit-tree", "--no-gpg-sign", tree, "-m", "Workbench code checkpoint",
  ], options()))
  if (!objectId.test(oid)) throw new Error("Git 快照提交无效。")
  await gitRun(cwd, ["-c", "core.hooksPath=", "update-ref", "--no-deref", ref, oid], options())
  return oid
}

export async function readCheckpointTree(repo: GitRepository, oid: string, timeout = 5_000): Promise<Map<string, TreeEntry>> {
  if (!objectId.test(oid)) throw new Error("Git 快照引用无效。")
  const raw = gitText(await gitRun(repo.root.path, ["ls-tree", "-r", "-z", "--full-tree", oid], { timeout }))
  const tree = new Map<string, TreeEntry>()
  for (const row of raw.split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t")
    const [mode, type, blob] = row.slice(0, tab).split(" ")
    if (tab < 0 || type !== "blob" || !objectId.test(blob)) throw new Error("含子模块或特殊对象的仓库暂不支持轮次快照。")
    tree.set(checkedPath(row.slice(tab + 1)), { mode, oid: blob })
  }
  return tree
}

const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"]
export async function readCheckpointDiff(repo: GitRepository, base: string, post: string, path: string) {
  const file = (await readCheckpointChanges(repo, base, post)).find(item => item.path === path)
  if (!file) throw new Error("文件不在本轮变更中。")
  const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]
  const raw = await gitRun(repo.root.path, [...diffArgs, "--unified=3", base, post, "--", ...paths], { timeout: 5_000 })
  return { text: raw.subarray(0, DIFF_LIMIT).toString("utf8") || "无可显示的文本差异。", truncated: raw.length > DIFF_LIMIT }
}

export async function readCheckpointChanges(repo: GitRepository, base: string, post: string) {
  if (!objectId.test(base) || !objectId.test(post)) throw new Error("Git 快照无效。")
  const output = gitText(await gitRun(repo.root.path, [...diffArgs, "--numstat", "-z", base, post, "--"], { timeout: 5_000 }))
  const parts = output.split("\0")
  const files: { path: string; oldPath?: string; added: number | null; removed: number | null }[] = []
  for (let i = 0; i < parts.length - 1; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(parts[i])
    if (!match) throw new Error("Git 差异清单格式无效。")
    const oldPath = match[3] ? undefined : checkedPath(parts[++i] ?? "")
    const name = checkedPath(match[3] || parts[++i] || "")
    files.push({ path: name, ...(oldPath === undefined ? {} : { oldPath }), added: match[1] === "-" ? null : Number(match[1]), removed: match[2] === "-" ? null : Number(match[2]) })
  }
  return files
}

export function checkpointChanges(current: CapturedTree, target: Map<string, TreeEntry>): string[] {
  return [...new Set([...current.files.keys(), ...target.keys()])].filter(path => {
    const before = current.files.get(path), after = target.get(path)
    return before?.oid !== after?.oid || before?.mode !== after?.mode
  }).sort()
}

async function verifyPath(repo: GitRepository, path: string, before: CurrentEntry | undefined, after: TreeEntry | undefined) {
  await repo.root.verify()
  const absolute = repo.root.relativePath(path)
  repo.root.assertReadable(absolute, [repo.gitDir, repo.commonDir])
  await checkParents(repo, absolute, new Set())
  const actual = await fileInfo(absolute)
  if (actual && (!before || !actual.isFile() || !sameFileVersion(actual, before.stat))
    || !actual && before || after && after.mode !== "100644" && after.mode !== "100755") {
    throw new Error("路径已变化，或与忽略文件、链接或目录冲突：" + path)
  }
  return absolute
}

export async function verifyRestorePaths(repo: GitRepository, current: CapturedTree, target: Map<string, TreeEntry>, paths: readonly string[]) {
  for (const path of paths) await verifyPath(repo, path, current.files.get(path), target.get(path))
}

/** 每个文件先准备临时副本，再重新核对路径和旧版本。中途失败返回已写入路径供保护快照恢复。 */
export async function applyCheckpointTree(
  repo: GitRepository,
  current: CapturedTree,
  target: Map<string, TreeEntry>,
  paths: readonly string[],
  authorized: () => boolean,
): Promise<{ paths: string[]; failure?: string }> {
  const changed: string[] = []
  try {
    for (const path of paths) {
      if (!authorized()) throw new Error("账号或会话已变化，已停止还原。")
      const before = current.files.get(path), after = target.get(path)
      const absolute = await verifyPath(repo, path, before, after)
      if (!after) {
        if (!authorized()) throw new Error("账号或会话已变化，已停止还原。")
        await unlink(absolute)
      } else {
        const blob = await gitRun(repo.root.path, ["cat-file", "blob", after.oid], { timeout: 5_000, maxBuffer: MAX_BYTES })
        await checkParents(repo, absolute, new Set(), true)
        const temporary = join(dirname(absolute), ".workbench-restore-" + randomUUID())
        try {
          await writeFile(temporary, blob, { flag: "wx", mode: after.mode === "100755" ? 0o755 : 0o644 })
          await verifyPath(repo, path, before, after)
          if (!authorized()) throw new Error("账号或会话已变化，已停止还原。")
          // 缺失的目标使用硬链接原子创建，现存路径则用同目录临时文件替换。
          if (before) await rename(temporary, absolute)
          else await link(temporary, absolute)
        } finally {
          // 父路径变动后不能沿陌生链接删除同名文件。
          if (await realpath(dirname(temporary)).catch(() => "") === dirname(temporary)) await rm(temporary, { force: true }).catch(() => {})
        }
      }
      changed.push(path)
    }
    return { paths: changed }
  } catch (error) {
    return { paths: changed, failure: error instanceof Error && !("code" in error) ? error.message : "写入工作树失败。" }
  }
}
