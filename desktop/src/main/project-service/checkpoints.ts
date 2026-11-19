/**
 * 本机轮次索引。执行协调层登记会话目录及轮次，页面只能按轮次读取 Diff 或确认一次还原。
 * 基线 → Agent prompt → 终态快照 → 对比。还原前重新核对工作树并持久化保护快照。
 */
import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { CodeCheckpointAction, CodeCheckpointReply, CodeCheckpointTurn, LocalExecutionScope } from "../../shared/local-execution-host.js"
import { inspectDirectory, sameDirectory, type DirectoryGrant } from "../local-directory-grants.js"
import {
  applyCheckpointTree, captureCheckpointTree, checkpointChanges, CHECKPOINT_BUDGET_MS, objectId, readCheckpointChanges,
  readCheckpointDiff, readCheckpointTree, verifyRestorePaths, writeCheckpointRef,
} from "./checkpoint-git.js"
import { digest, gitCommand, gitLine, gitRun, gitText } from "./git-command.js"
import { openRepository, type GitRepository } from "./git-state.js"
import { contains, ProjectRoot } from "./root.js"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const scopePattern = /^[0-9a-f]{32}$/
const MAX_RECORDS = 2_000
type Guard = { id: string; createdAtMs: number; oid: string }
type RecordOnDisk = Omit<CodeCheckpointTurn, "guards"> & {
  gitRoot: string; dev: string; ino: string; base: string | null; post: string | null; guards: Guard[]
}
type BindingOnDisk = { scope: string; path: string }
type Phase = "base" | "post" | "guard"
export type CheckpointStart = {
  scope: string; ordinal: number; directory: DirectoryGrant; repo: GitRepository | null; base: string | null; unavailable?: string
}
type Preview = {
  token: string; turnId: string; target: Phase; guardId?: string; oid: string; tree: string;
  directory: DirectoryGrant; gitDir: string; commonDir: string
}

function message(error: unknown): string {
  return error instanceof Error && !("code" in error) ? error.message : "无法访问本机轮次快照。"
}

function validRecord(value: unknown): value is RecordOnDisk {
  if (!value || typeof value !== "object") return false
  const r = value as Partial<RecordOnDisk>
  return typeof r.turnId === "string" && uuid.test(r.turnId)
    && Number.isSafeInteger(r.ordinal) && r.ordinal! > 0 && Number.isFinite(r.createdAtMs)
    && (r.status === "completed" || r.status === "cancelled" || r.status === "failed")
    && typeof r.gitRoot === "string" && typeof r.dev === "string" && typeof r.ino === "string"
    && [r.base, r.post].every(value => value === null || typeof value === "string" && objectId.test(value))
    && (r.unavailable === undefined || typeof r.unavailable === "string")
    && Array.isArray(r.guards) && r.guards.every(g => g && uuid.test(g.id) && objectId.test(g.oid) && Number.isFinite(g.createdAtMs))
}

async function atomicJson(file: string, data: unknown): Promise<void> {
  const temporary = file + "." + randomUUID() + ".tmp"
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, JSON.stringify(data), { flag: "wx", mode: 0o600 })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}

function ref(scope: string, ordinal: number, phase: Phase, guardId?: string): string {
  return "refs/workbench/checkpoints/" + scope + "/" + ordinal + "-" + phase + (guardId ? "-" + guardId : "")
}

export function overlappingDirectories(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left)
}

export class CodeCheckpoints {
  readonly #previews = new Map<string, Preview>()
  readonly #registered = new Set<string>()
  #registrationFailed = false

  constructor(private readonly directory: string, private readonly origin: string) {}

  #scope(scope: LocalExecutionScope): string {
    return digest(JSON.stringify([this.origin, scope.accountId, scope.workspaceId, scope.projectId, scope.conversationId])).slice(0, 32)
  }

  #index(scope: string): string { return join(this.directory, scope + ".json") }

  async #records(scope: string): Promise<RecordOnDisk[]> {
    const raw = await readFile(this.#index(scope), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "[]"
      throw error
    })
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS || !parsed.every(validRecord)
      || parsed.some((r, index) => r.ordinal !== index + 1)) throw new Error("本机轮次快照索引无效。")
    return parsed
  }

  /** 绑定过的空闲会话也可能已写入文件。登记保留到应用重启之后。 */
  async register(scope: LocalExecutionScope, directory: DirectoryGrant): Promise<void> {
    const record: BindingOnDisk = { scope: this.#scope(scope), path: directory.path }
    const key = digest(JSON.stringify(record))
    if (this.#registered.has(key)) return
    try {
      await atomicJson(join(this.directory, "directories", key + ".json"), record)
      this.#registered.add(key)
    } catch { this.#registrationFailed = true }
  }

  async #repository(directory: DirectoryGrant, deadline?: number): Promise<GitRepository | null> {
    if (!sameDirectory(directory, await inspectDirectory(directory.path))) throw new Error("绑定目录已被移动或替换。")
    return openRepository(await ProjectRoot.bind(directory.path), deadline)
  }

  async begin(scope: LocalExecutionScope, directory: DirectoryGrant): Promise<CheckpointStart | undefined> {
    const scopeId = this.#scope(scope)
    let ordinal: number
    try { ordinal = (await this.#records(scopeId)).length + 1 }
    catch { return undefined }
    if (ordinal > MAX_RECORDS) return undefined
    const start: CheckpointStart = { scope: scopeId, ordinal, directory, repo: null, base: null }
    try {
      const deadline = Date.now() + CHECKPOINT_BUDGET_MS
      start.repo = await this.#repository(directory, deadline)
      if (!start.repo) return { ...start, unavailable: "仅在 Git 工作树根目录记录代码快照。" }
      const { tree } = await captureCheckpointTree(start.repo, deadline)
      start.base = await writeCheckpointRef(start.repo, tree, ref(scopeId, ordinal, "base"), deadline)
      return start
    } catch (error) { return { ...start, unavailable: message(error) } }
  }

  async discard(start: CheckpointStart | undefined): Promise<void> {
    if (!start?.repo || !start.base) return
    await start.repo.root.verify().then(() => gitCommand(start.repo!.root.path, [
      "-c", "core.hooksPath=", "update-ref", "--no-deref", "-d", ref(start.scope, start.ordinal, "base"), start.base!,
    ], { timeout: 1_000 })).catch(() => {})
  }

  async finish(start: CheckpointStart, turnId: string, createdAtMs: number, status: CodeCheckpointTurn["status"], stopped: boolean): Promise<void> {
    if (!uuid.test(turnId)) return
    let post: string | null = null
    let unavailable = start.unavailable
    if (!unavailable && start.repo && start.base) {
      if (!stopped) unavailable = "无法确认 Agent 已停止写入，本轮 Diff 不可用。"
      else {
        try {
          const deadline = Date.now() + CHECKPOINT_BUDGET_MS
          const repository = await this.#repository(start.directory, deadline)
          if (repository?.gitDir !== start.repo.gitDir || repository.commonDir !== start.repo.commonDir) throw new Error("Git 工作树已变化。")
          const { tree } = await captureCheckpointTree(repository, deadline)
          post = await writeCheckpointRef(repository, tree, ref(start.scope, start.ordinal, "post"), deadline)
        } catch (error) { unavailable = message(error) }
      }
    }
    const records = await this.#records(start.scope)
    if (records.length + 1 !== start.ordinal) return
    await atomicJson(this.#index(start.scope), [...records, {
      turnId, createdAtMs, status, ordinal: start.ordinal, gitRoot: start.directory.path,
      dev: String(start.directory.dev), ino: String(start.directory.ino), base: start.base, post,
      ...(unavailable ? { unavailable } : {}), guards: [],
    }])
  }

  async #restoreBlocked(scope: string, repo: GitRepository, otherDirectories: () => Promise<readonly string[]>): Promise<string | undefined> {
    if (repo.gitDir === repo.commonDir) return "仅在本会话专用的 Git linked worktree 中恢复代码。"
    if (this.#registrationFailed) return "无法确认其他本机会话的工作目录。"
    const cwd = repo.root.path
    const rows = gitText(await gitRun(cwd, ["worktree", "list", "--porcelain", "-z"], { timeout: 2_000 })).split("\0")
    const paths = rows.filter(row => row.startsWith("worktree ")).map(row => row.slice(9))
    const linked = await Promise.all(paths.slice(1).map(path => realpath(path).catch(() => "")))
    if (!linked.includes(cwd)) return "当前目录不是已登记的 Git linked worktree。"
    const sparse = await gitCommand(cwd, ["config", "--bool", "--get", "core.sparseCheckout"], { timeout: 2_000 })
    if (sparse.state !== "exited" || sparse.code !== 1 && (sparse.code !== 0 || gitLine(sparse.stdout) !== "false")) {
      return "当前工作树使用稀疏检出或无法核对配置。"
    }
    const dir = join(this.directory, "directories")
    const names = (await readdir(dir)).filter(name => /^[0-9a-f]{64}\.json$/.test(name))
    if (names.length > 10_000) return "本机目录登记过多，无法确认隔离。"
    let currentRegistered = false
    const knownOther: string[] = []
    for (const name of names) {
      const row: BindingOnDisk = JSON.parse(await readFile(join(dir, name), "utf8"))
      if (!row || !scopePattern.test(row.scope) || typeof row.path !== "string" || !row.path || digest(JSON.stringify(row)) + ".json" !== name) {
        return "本机目录登记无效。"
      }
      if (row.scope !== scope) knownOther.push(row.path)
      else if (row.path === cwd) currentRegistered = true
    }
    if (!currentRegistered) return "当前会话尚未登记该工作树。"
    for (const path of [...knownOther, ...await otherDirectories()]) {
      const canonical = await realpath(path).catch(() => resolve(path))
      if (overlappingDirectories(cwd, canonical)) return "其他会话也登记了重叠目录，当前工作树只能查看 Diff。"
    }
    return undefined
  }

  #turn(records: RecordOnDisk[], turnId: string, directory: DirectoryGrant): RecordOnDisk {
    const turn = records.find(row => row.turnId === turnId)
    if (!turn || turn.gitRoot !== directory.path || turn.dev !== String(directory.dev) || turn.ino !== String(directory.ino)) {
      throw new Error("轮次快照与当前工作目录不匹配。")
    }
    return turn
  }

  async #oid(repo: GitRepository, scope: string, turn: RecordOnDisk, target: Phase, guardId?: string): Promise<string> {
    const stored = target === "guard" ? turn.guards.find(item => item.id === guardId)?.oid : turn[target]
    if (!stored || target === "guard" && (!guardId || !uuid.test(guardId))) throw new Error(turn.unavailable ?? "当前快照不可用。")
    const storedRef = ref(scope, turn.ordinal, target, target === "guard" ? guardId : undefined)
    const actual = gitLine(await gitRun(repo.root.path, ["rev-parse", "--verify", storedRef + "^{commit}"], { timeout: 2_000 }))
    if (actual !== stored) throw new Error("快照引用已变化。")
    return stored
  }

  hasPreview(scope: LocalExecutionScope, token: string): boolean {
    return this.#previews.get(this.#scope(scope))?.token === token
  }

  async run(
    scope: LocalExecutionScope, directory: DirectoryGrant, action: CodeCheckpointAction,
    authorized: () => boolean, otherDirectories: () => Promise<readonly string[]>,
  ): Promise<CodeCheckpointReply> {
    const scopeId = this.#scope(scope)
    const records = await this.#records(scopeId)
    const repo = await this.#repository(directory)
    const matches = (row: RecordOnDisk) => row.gitRoot === directory.path && row.dev === String(directory.dev) && row.ino === String(directory.ino)
    if (action.kind === "history") {
      const restoreBlocked = repo
        ? await this.#restoreBlocked(scopeId, repo, otherDirectories).catch(() => "无法确认当前工作树的隔离情况。")
        : "仅在 Git 工作树根目录记录代码快照。"
      return {
        kind: "history", ...(restoreBlocked ? { restoreBlocked } : {}),
        turns: records.filter(matches).map(({ turnId, ordinal, createdAtMs, status, unavailable, guards }) => ({
          turnId, ordinal, createdAtMs, status, ...(unavailable ? { unavailable } : {}),
          guards: guards.map(({ id, createdAtMs: time }) => ({ id, createdAtMs: time })),
        })).reverse(),
      }
    }
    if (!repo) throw new Error("当前目录没有 Git 工作树。")
    if (!authorized()) throw new Error("当前会话或目录已变化。")
    if (action.kind === "changes" || action.kind === "diff") {
      const turn = this.#turn(records, action.turnId, directory)
      const [base, post] = await Promise.all([this.#oid(repo, scopeId, turn, "base"), this.#oid(repo, scopeId, turn, "post")])
      return action.kind === "changes"
        ? { kind: "changes", files: await readCheckpointChanges(repo, base, post) }
        : { kind: "diff", ...await readCheckpointDiff(repo, base, post, action.path) }
    }
    const blocked = await this.#restoreBlocked(scopeId, repo, otherDirectories)
    if (blocked) throw new Error(blocked)

    const preview = action.kind === "restore" ? this.#previews.get(scopeId) : undefined
    if (action.kind === "restore") {
      if (!preview || preview.token !== action.token || !sameDirectory(preview.directory, directory)
        || preview.gitDir !== repo.gitDir || preview.commonDir !== repo.commonDir) throw new Error("确认已失效，请重新预览。")
      this.#previews.delete(scopeId)
    }
    const target = action.kind === "preview" ? action : preview!
    const turn = this.#turn(records, target.turnId, directory)
    const oid = await this.#oid(repo, scopeId, turn, target.target, target.guardId)
    const [current, desired] = await Promise.all([captureCheckpointTree(repo), readCheckpointTree(repo, oid)])
    const paths = checkpointChanges(current, desired)
    await verifyRestorePaths(repo, current, desired, paths)
    if (action.kind === "preview") {
      const token = randomUUID()
      this.#previews.set(scopeId, { ...action, token, directory, oid, tree: current.tree, gitDir: repo.gitDir, commonDir: repo.commonDir })
      return { kind: "preview", token, paths }
    }
    if (preview?.tree !== current.tree || preview.oid !== oid) throw new Error("工作树在预览后发生变化，请重新预览。")
    if (!authorized()) throw new Error("当前会话或目录已变化。")
    if (!paths.length) return { kind: "restored", paths: [] }

    const id = randomUUID()
    const guard = await writeCheckpointRef(repo, current.tree, ref(scopeId, turn.ordinal, "guard", id))
    turn.guards.push({ id, createdAtMs: Date.now(), oid: guard })
    await atomicJson(this.#index(scopeId), records)
    const result = await applyCheckpointTree(repo, current, desired, paths, authorized)
    return { kind: "restored", ...result }
  }
}
