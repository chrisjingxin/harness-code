/**
 * 【功能定义】本机授权目录只读宿主服务（HC-218）：仅对用户通过系统目录选择器显式选定的目录，
 * 提供防路径逃逸的只读目录浏览、@ 文件提及候选检索、文本正文预览，以及 Git 仓库的只读状态与差异查看。
 *
 * 【协作边界】
 * - 运行于 Electron 主进程，通过 `collaboration-ipc.ts` 暴露给 Preload/Renderer，仅依赖 Node 内置模块与 `@workbench/contracts`。
 * - 普通非 Git 目录与 Git 仓库一视同仁可浏览文件；非 Git 目录查询变更时平静返回空变更与说明，不报错。
 * - 不提供任何文件写入、Git 暂存、提交（commit）或推送（push）能力，也不对外暴露绝大部分本机敏感路径（如 `.git` 内部目录与符号链接逃逸目标）。
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, open, opendir, realpath, stat } from "node:fs/promises"
import { isAbsolute, posix, relative, resolve, sep } from "node:path"
import type {
  CollaborationResult,
  LocalDirectoryHost,
  ProjectCandidatesValue,
  ProjectDirectoryValue,
  ProjectGitDiffValue,
  ProjectGitStatusValue,
  ProjectPreviewValue,
  ProjectReadAction,
  ProjectReadEntry,
  ProjectReadFailureCode,
  ProjectReadResponse,
} from "@workbench/contracts"
import { identityError } from "./collaboration-state.js"

const MAX_INDEX_ROWS = 10_000
const MAX_DIRECTORY_ROWS = 2_000
const PAGE_ROWS = 512
const MAX_CANDIDATES = 1_000
const MAX_PREVIEW_BYTES = 256 * 1024
const MAX_PREVIEW_LINES = 2_000
const MAX_LINE_CHARS = 20_000
const DIFF_LIMIT = 96 * 1024
const MAX_GIT_FILES = 1_000

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".cache",
  "dist",
  "build",
  "coverage",
])

const KIND_RANKS: Record<ProjectReadEntry["kind"], number> = {
  directory: 0,
  file: 1,
  symlink: 2,
}

const LANGUAGE_ALIASES = new Map(Object.entries({
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsonc: "json",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  h: "c",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  "c++": "cpp",
  htm: "html",
  yml: "yaml",
  md: "markdown",
}))

const SUPPORTED_LANGUAGES = new Set([
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "json",
  "python",
  "bash",
  "go",
  "java",
  "c",
  "cpp",
  "html",
  "css",
  "yaml",
  "markdown",
])

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

class LocalDirectoryError extends Error {
  constructor(
    readonly code: ProjectReadFailureCode,
    message: string,
  ) {
    super(message)
  }
}

type BoundRoot = {
  readonly path: string
  readonly stats: Stats
  readonly identity: string
  readonly isGitRepository: boolean
  readonly protectedPaths: readonly string[]
}

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex")
}

function contains(root: string, candidate: string): boolean {
  const delta = relative(root, candidate)
  return !isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`)
}

function sameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return sameObject(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

/** 仅接受规范的正斜杠相对路径，拒绝绝对路径、空字节、盘符、`.`/`..` 及 `.git` 目录片段。 */
export function validLocalRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || /^[a-z]:|^\\\\/i.test(path) || path.includes("\0") || path.includes("\\")) {
    return false
  }
  return path.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
}

function parentRelative(path: string): string {
  const dir = posix.dirname(path)
  return dir === "." ? "" : dir
}

function makeEntry(path: string, kind: ProjectReadEntry["kind"]): ProjectReadEntry {
  return {
    path,
    name: posix.basename(path),
    kind,
    expandable: kind === "directory",
  }
}

function compareEntries(left: ProjectReadEntry, right: ProjectReadEntry): number {
  return KIND_RANKS[left.kind] - KIND_RANKS[right.kind]
    || left.name.localeCompare(right.name, "zh", { numeric: true, sensitivity: "base" })
    || (left.path < right.path ? -1 : Number(left.path !== right.path))
}

function scoreCandidate(item: ProjectReadEntry, lowerQuery: string): number {
  const name = item.name.toLowerCase()
  const path = item.path.toLowerCase()
  const match = name === lowerQuery
    ? 100
    : name.startsWith(lowerQuery)
      ? 80
      : path.startsWith(lowerQuery)
        ? 60
        : name.includes(lowerQuery)
          ? 40
          : path.includes(lowerQuery)
            ? 20
            : 0
  return match - Math.min(10, item.path.split("/").length)
}

function decodeUtf8Preview(bytes: Buffer, truncated: boolean): string {
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new LocalDirectoryError("PROJECT_FILE_UNSUPPORTED", "二进制文件暂不支持预览。")
  }
  for (let trim = 0; trim <= Math.min(truncated ? 3 : 0, bytes.length); trim++) {
    try {
      return UTF8_DECODER.decode(bytes.subarray(0, bytes.length - trim)).replace(/^\uFEFF/, "")
    } catch {
      // 截断位置可能落在多字节 UTF-8 字符中间，允许剥离最多 3 个尾部残字节后重试解码。
    }
  }
  throw new LocalDirectoryError("PROJECT_FILE_UNSUPPORTED", "非 UTF-8 文本暂不支持预览。")
}

function mapFsError(error: unknown): LocalDirectoryError {
  if (error instanceof LocalDirectoryError) return error
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT":
    case "ENOTDIR":
      return new LocalDirectoryError("PROJECT_FILE_NOT_FOUND", "文件或目录不存在。")
    case "EACCES":
    case "EPERM":
      return new LocalDirectoryError("PROJECT_FILE_DENIED", "没有读取该路径的权限。")
    case "ELOOP":
      return new LocalDirectoryError("PROJECT_FILE_DENIED", "链接超出工作目录读取范围。")
    default:
      return new LocalDirectoryError("PROJECT_READ_FAILED", "本机工作目录读取失败。")
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_INTERNAL_SUPER_PREFIX",
  ]) {
    delete env[key]
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  }
}

function execGit(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{ state: "exited"; code: number; stdout: Buffer } | { state: "unavailable" | "interrupted" }> {
  return new Promise(resolvePromise => {
    const child = execFile("git", ["--no-pager", ...args], {
      cwd,
      env: gitEnvironment(),
      encoding: "buffer",
      windowsHide: true,
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      killSignal: "SIGKILL",
    }, (error, stdout) => {
      if (!error || (typeof error.code === "number" && !error.killed)) {
        resolvePromise({ state: "exited", code: error ? Number(error.code) : 0, stdout })
      } else {
        resolvePromise({ state: child.pid === undefined ? "unavailable" : "interrupted" })
      }
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end()
  })
}

async function detectGitRoot(canonicalRoot: string): Promise<{ isGitRepository: boolean; protectedPaths: string[] }> {
  const toplevel = await execGit(canonicalRoot, ["rev-parse", "--show-toplevel"], { timeoutMs: 3_000 })
  if (toplevel.state !== "exited" || toplevel.code !== 0) {
    return { isGitRepository: false, protectedPaths: [] }
  }
  const actualTop = await realpath(UTF8_DECODER.decode(toplevel.stdout).replace(/\n$/, "")).catch(() => "")
  if (actualTop !== canonicalRoot) {
    return { isGitRepository: false, protectedPaths: [] }
  }
  const protectedPaths = new Set<string>()
  for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
    const res = await execGit(canonicalRoot, ["rev-parse", "--path-format=absolute", flag], { timeoutMs: 3_000 })
    if (res.state === "exited" && res.code === 0) {
      const target = resolve(canonicalRoot, UTF8_DECODER.decode(res.stdout).replace(/\n$/, ""))
      protectedPaths.add(target)
      protectedPaths.add(await realpath(target).catch(() => target))
    }
  }
  return { isGitRepository: true, protectedPaths: [...protectedPaths] }
}

function bindingKey(accountId: string, workspaceId: string, projectId: string, conversationKey: string): string {
  return `${accountId}\0${workspaceId}\0${projectId}\0${conversationKey}`
}

function nonGitStatus(): ProjectGitStatusValue {
  return {
    branch: null,
    head: null,
    files: [],
    snapshot: "non-git",
    upstream: null,
    blockedReason: "当前目录不是 Git 仓库，仅提供本地文件浏览；Git 写操作已暂缓。",
  }
}

/**
 * 本机工作目录只读宿主的内存实现：
 * - 按账号 + 工作区 + 项目 + 会话键保存用户主动绑定的绝对路径；
 * - 每次读取均复核目录实体未漂移且目标仍在受保护的边界内。
 */
export class LocalDirectoryService implements LocalDirectoryHost {
  readonly #getAccountId: () => string | null
  readonly #bindings = new Map<string, BoundRoot>()

  constructor(getAccountId: () => string | null) {
    this.#getAccountId = getAccountId
  }

  async bindDirectory(
    workspaceId: string,
    projectId: string,
    conversationKey: string,
    directoryPath: string,
  ): Promise<CollaborationResult<{ directoryPath: string; isGitRepository: boolean }>> {
    const accountId = this.#getAccountId()
    if (!accountId) {
      return identityError("AUTHENTICATION_REQUIRED", "请先登录后再选择本机工作目录。")
    }
    if (!workspaceId.trim() || !projectId.trim() || !conversationKey.trim()) {
      return identityError("INVALID_REQUEST", "缺少会话标识，无法绑定本机工作目录。")
    }
    if (!directoryPath || !isAbsolute(directoryPath) || directoryPath.includes("\0")) {
      return identityError("PROJECT_PATH_INVALID", "请选择有效的工作目录绝对路径。")
    }

    try {
      const canonical = await realpath(directoryPath)
      const info = await stat(canonical)
      if (!info.isDirectory()) {
        return identityError("PROJECT_PATH_INVALID", "所选路径不是文件夹，请重新选择工作目录。")
      }
      const git = await detectGitRoot(canonical)
      const bound: BoundRoot = {
        path: canonical,
        stats: info,
        identity: JSON.stringify([canonical, info.dev, info.ino]),
        isGitRepository: git.isGitRepository,
        protectedPaths: git.protectedPaths,
      }
      this.#bindings.set(bindingKey(accountId, workspaceId, projectId, conversationKey), bound)
      return {
        ok: true,
        value: {
          directoryPath: canonical,
          isGitRepository: git.isGitRepository,
        },
      }
    } catch (error) {
      const mapped = mapFsError(error)
      return identityError(mapped.code, mapped.message)
    }
  }

  async readDirectory(
    workspaceId: string,
    projectId: string,
    conversationKey: string,
    action: ProjectReadAction,
  ): Promise<CollaborationResult<ProjectReadResponse>> {
    const accountId = this.#getAccountId()
    if (!accountId) {
      return identityError("AUTHENTICATION_REQUIRED", "请先登录后再读取本机工作目录。")
    }
    const bound = this.#bindings.get(bindingKey(accountId, workspaceId, projectId, conversationKey))
    if (!bound) {
      return identityError("RESOURCE_NOT_FOUND", "当前会话尚未绑定本机工作目录。")
    }

    try {
      await this.#verifyRoot(bound)
      switch (action.kind) {
        case "listDirectory":
          return { ok: true, value: { kind: "listDirectory", value: await this.#listDirectory(bound, action.directory, action.cursor) } }
        case "searchCandidates":
          return { ok: true, value: { kind: "searchCandidates", value: await this.#searchCandidates(bound, action.directory, action.query, action.limit) } }
        case "readPreview":
          return { ok: true, value: { kind: "readPreview", value: await this.#readPreview(bound, action.path) } }
        case "gitStatus":
          return { ok: true, value: { kind: "gitStatus", value: await this.#readGitStatus(bound) } }
        case "gitDiff":
          return { ok: true, value: { kind: "gitDiff", value: await this.#readGitDiff(bound, action.snapshot, action.path) } }
      }
    } catch (error) {
      const mapped = mapFsError(error)
      return identityError(mapped.code, mapped.message)
    }
  }

  async #verifyRoot(bound: BoundRoot): Promise<void> {
    try {
      if (await realpath(bound.path) === bound.path && sameObject(bound.stats, await stat(bound.path))) {
        return
      }
    } catch {
      // 目录不存在或已变更时统一触发 root changed 错误，避免继续读取新目录实体。
    }
    throw new LocalDirectoryError("PROJECT_ROOT_CHANGED", "绑定的本机工作目录已变更或不可访问，请重新选择。")
  }

  #assertInside(bound: BoundRoot, targetPath: string): void {
    const parts = relative(bound.path, targetPath).split(sep)
    if (
      !contains(bound.path, targetPath)
      || parts.some(part => part.toLowerCase() === ".git")
      || bound.protectedPaths.some(protectedDir => contains(protectedDir, targetPath))
    ) {
      throw new LocalDirectoryError("PROJECT_FILE_DENIED", "目标路径超出当前会话工作目录范围。")
    }
  }

  #resolveLexical(bound: BoundRoot, relPath: string, allowRoot = false): string {
    if (allowRoot && relPath === "") return bound.path
    if (!validLocalRelativePath(relPath)) {
      throw new LocalDirectoryError("PROJECT_PATH_INVALID", "路径格式不合法。")
    }
    return resolve(bound.path, relPath)
  }

  async #resolveReadable(bound: BoundRoot, relPath: string, directory = false): Promise<string> {
    const lexical = this.#resolveLexical(bound, relPath, directory)
    try {
      const actual = await realpath(lexical)
      this.#assertInside(bound, actual)
      if (directory && actual !== lexical) {
        throw new LocalDirectoryError("PROJECT_FILE_DENIED", "不支持展开指向工作目录内外的目录符号链接。")
      }
      return actual
    } catch (error) {
      throw mapFsError(error)
    }
  }

  async #scanSingleDirectory(bound: BoundRoot, relDir: string): Promise<{ entries: ProjectReadEntry[]; truncated: boolean }> {
    const dirPath = await this.#resolveReadable(bound, relDir, true)
    const dirInfo = await stat(dirPath)
    if (!dirInfo.isDirectory()) {
      throw new LocalDirectoryError("PROJECT_PATH_INVALID", "目标路径不是目录。")
    }

    const entries: ProjectReadEntry[] = []
    let truncated = false
    const dir = await opendir(dirPath)
    try {
      for await (const row of dir) {
        const relativePath = relDir ? `${relDir}/${row.name}` : row.name
        if (!validLocalRelativePath(relativePath)) continue
        if (row.isDirectory() && IGNORED_DIRECTORIES.has(row.name)) continue
        if (entries.length >= MAX_DIRECTORY_ROWS) {
          truncated = true
          break
        }
        if (row.isDirectory()) {
          entries.push(makeEntry(relativePath, "directory"))
        } else if (row.isFile()) {
          entries.push(makeEntry(relativePath, "file"))
        } else if (row.isSymbolicLink()) {
          entries.push(makeEntry(relativePath, "symlink"))
        }
      }
    } catch (error) {
      throw mapFsError(error)
    }
    if (await realpath(dirPath) !== dirPath || !sameFileVersion(dirInfo, await stat(dirPath))) {
      throw new LocalDirectoryError("PROJECT_FILE_CHANGED", "目录在读取期间变化，请刷新。")
    }
    return { entries, truncated }
  }

  async #listDirectory(bound: BoundRoot, directory: string, cursor?: string): Promise<ProjectDirectoryValue> {
    const listed = await this.#scanSingleDirectory(bound, directory)
    listed.entries.sort(compareEntries)
    const rows = listed.entries.slice(0, MAX_DIRECTORY_ROWS)
    const version = sha256(JSON.stringify([bound.identity, directory, rows, listed.truncated]))

    let offset = 0
    if (cursor !== undefined) {
      const match = /^([a-f0-9]{64}):([1-9][0-9]{0,4})$/.exec(cursor)
      const parsed = Number(match?.[2])
      if (!match || match[1] !== version || parsed >= rows.length || parsed % PAGE_ROWS !== 0) {
        throw new LocalDirectoryError("PROJECT_CURSOR_EXPIRED", "目录内容已变化，请从头刷新。")
      }
      offset = parsed
    }

    const page = rows.slice(offset, offset + PAGE_ROWS)
    const end = offset + page.length
    await this.#verifyRoot(bound)
    return {
      entries: page,
      truncated: listed.truncated,
      ...(end < rows.length ? { nextCursor: `${version}:${end}` } : {}),
    }
  }

  async #scanTree(bound: BoundRoot, startDir: string): Promise<{ entries: ProjectReadEntry[]; truncated: boolean }> {
    const queue = [startDir]
    const entries: ProjectReadEntry[] = []
    let truncated = false

    for (let i = 0; i < queue.length; i++) {
      let page: { entries: ProjectReadEntry[]; truncated: boolean }
      try {
        page = await this.#scanSingleDirectory(bound, queue[i]!)
      } catch (error) {
        if (i === 0) throw error
        truncated = true
        continue
      }
      truncated ||= page.truncated
      for (const item of page.entries) {
        if (entries.length >= MAX_INDEX_ROWS) {
          return { entries, truncated: true }
        }
        entries.push(item)
        if (item.kind === "directory") {
          queue.push(item.path)
        }
      }
    }
    return { entries, truncated }
  }

  async #gitFileList(bound: BoundRoot, scopeDir: string): Promise<{ entries: ProjectReadEntry[]; truncated: boolean } | null> {
    if (!bound.isGitRepository) return null
    const res = await execGit(bound.path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      timeoutMs: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (res.state !== "exited" || res.code !== 0) return null

    const rawFiles = UTF8_DECODER.decode(res.stdout).split("\0").filter(Boolean)
    const entries: ProjectReadEntry[] = []
    for (const file of rawFiles) {
      if (!validLocalRelativePath(file)) continue
      if (scopeDir && file !== scopeDir && !file.startsWith(`${scopeDir}/`)) continue
      if (entries.length >= MAX_INDEX_ROWS) {
        return { entries, truncated: true }
      }
      entries.push(makeEntry(file, "file"))
    }
    return { entries, truncated: false }
  }

  async #searchCandidates(
    bound: BoundRoot,
    directory: string,
    query: string,
    limit = 200,
  ): Promise<ProjectCandidatesValue> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || query.length > 4096) {
      throw new LocalDirectoryError("PROJECT_LIMIT_EXCEEDED", "文件搜索请求超出允许范围。")
    }
    await this.#resolveReadable(bound, directory, true)
    const term = query.trim()

    let sourceEntries: ProjectReadEntry[]
    let sourceTruncated: boolean
    if (term) {
      const gitSource = await this.#gitFileList(bound, directory)
      if (gitSource) {
        sourceEntries = gitSource.entries
        sourceTruncated = gitSource.truncated
      } else {
        const scanned = await this.#scanTree(bound, directory)
        sourceEntries = scanned.entries
        sourceTruncated = scanned.truncated
      }
    } else {
      const dirPage = await this.#scanSingleDirectory(bound, directory)
      sourceEntries = dirPage.entries
      sourceTruncated = dirPage.truncated
    }

    const candidates = term
      ? sourceEntries
          .filter(item => item.kind !== "directory")
          .map(item => ({ item, score: scoreCandidate(item, term.toLowerCase()) }))
          .filter(matched => matched.score > 0)
          .sort((a, b) => b.score - a.score || compareEntries(a.item, b.item))
          .map(matched => matched.item)
      : [...sourceEntries].sort(compareEntries)

    const take = Math.min(limit, MAX_CANDIDATES)
    const pattern = term ? new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu") : null
    const items = candidates.slice(0, take).map(item => {
      const match = pattern?.exec(item.path)
      return {
        ...item,
        matchRanges: match ? [{ start: match.index, end: match.index + match[0].length }] : [],
      }
    })
    await this.#verifyRoot(bound)
    const complete = !sourceTruncated && items.length === Math.min(candidates.length, take)
    return {
      items,
      ...(complete ? { total: candidates.length } : {}),
      truncated: !complete || candidates.length > take,
    }
  }

  async #readPreview(bound: BoundRoot, relPath: string): Promise<ProjectPreviewValue> {
    const actual = await this.#resolveReadable(bound, relPath, false)
    const expected = await lstat(actual)
    if (!expected.isFile()) {
      throw new LocalDirectoryError("PROJECT_FILE_UNSUPPORTED", "仅支持普通文本文件预览。")
    }

    // 通过 O_NOFOLLOW 打开句柄并二次比对真实路径和文件版本，防止读取瞬间发生符号链接替换。
    const handle = await open(
      actual,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    )
    let bytes: Buffer
    try {
      const resolvedAgain = await realpath(actual)
      this.#assertInside(bound, resolvedAgain)
      const openedStats = await handle.stat()
      const currentLstat = await lstat(resolvedAgain)
      if (
        resolvedAgain !== actual
        || !openedStats.isFile()
        || !sameFileVersion(expected, openedStats)
        || !sameFileVersion(openedStats, currentLstat)
      ) {
        throw new LocalDirectoryError("PROJECT_FILE_CHANGED", "文件在读取期间发生变更，请刷新重试。")
      }
      const buffer = Buffer.alloc(Math.min(MAX_PREVIEW_BYTES, openedStats.size))
      let used = 0
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used)
        if (!bytesRead) break
        used += bytesRead
      }
      if (
        used !== buffer.length
        || !sameFileVersion(openedStats, await handle.stat())
        || await realpath(actual) !== resolvedAgain
      ) {
        throw new LocalDirectoryError("PROJECT_FILE_CHANGED", "文件在读取期间发生变更，请刷新重试。")
      }
      bytes = buffer
    } finally {
      await handle.close()
    }

    await this.#verifyRoot(bound)
    const byteTruncated = bytes.length < expected.size
    const decoded = decodeUtf8Preview(bytes, byteTruncated)
    const content = decoded
      .split("\n")
      .slice(0, MAX_PREVIEW_LINES)
      .map(line => line.slice(0, MAX_LINE_CHARS).replace(/[\uD800-\uDBFF]$/u, ""))
      .join("\n")

    const ext = posix.extname(relPath).slice(1).toLowerCase()
    const normalizedLang = LANGUAGE_ALIASES.get(ext) ?? ext
    return {
      path: relPath,
      content,
      language: SUPPORTED_LANGUAGES.has(normalizedLang) ? normalizedLang : null,
      sizeBytes: expected.size,
      displayedBytes: Buffer.byteLength(content),
      lineCount: content ? content.split("\n").length - Number(content.endsWith("\n")) : 0,
      truncated: byteTruncated || content !== decoded,
    }
  }

  async #readGitStatus(bound: BoundRoot): Promise<ProjectGitStatusValue> {
    if (!bound.isGitRepository) {
      return nonGitStatus()
    }
    const gitCheck = await detectGitRoot(bound.path)
    if (!gitCheck.isGitRepository) {
      return nonGitStatus()
    }

    const [headRes, branchRes, statusRes] = await Promise.all([
      execGit(bound.path, ["rev-parse", "--verify", "--quiet", "HEAD"], { timeoutMs: 3_000 }),
      execGit(bound.path, ["symbolic-ref", "--quiet", "HEAD"], { timeoutMs: 3_000 }),
      execGit(bound.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], {
        timeoutMs: 8_000,
      }),
    ])
    if (statusRes.state !== "exited" || statusRes.code !== 0) {
      throw new LocalDirectoryError("PROJECT_READ_FAILED", "Git 状态读取失败，请在本机仓库检查。")
    }

    const head = headRes.state === "exited" && headRes.code === 0
      ? UTF8_DECODER.decode(headRes.stdout).trim()
      : null
    const branchRef = branchRes.state === "exited" && branchRes.code === 0
      ? UTF8_DECODER.decode(branchRes.stdout).trim()
      : null
    const branch = branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : null

    const rawStatus = UTF8_DECODER.decode(statusRes.stdout)
    const rows = rawStatus.split("\0")
    const files: ProjectGitStatusValue["files"] = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (!row) continue
      const status = row.slice(0, 2)
      const filePath = row.slice(3)
      const oldPath = /[RC]/.test(status) ? rows[++i] : undefined
      if (!validLocalRelativePath(filePath) || (oldPath !== undefined && !validLocalRelativePath(oldPath))) {
        continue
      }
      files.push({
        status,
        path: filePath,
        ...(oldPath !== undefined ? { oldPath } : {}),
        version: sha256(JSON.stringify([status, filePath, oldPath ?? null])),
      })
      if (files.length >= MAX_GIT_FILES) break
    }

    let upstream: ProjectGitStatusValue["upstream"] = null
    if (branch) {
      const revList = await execGit(
        bound.path,
        ["rev-list", "--left-right", "--count", `HEAD...@{upstream}`],
        { timeoutMs: 3_000 },
      )
      if (revList.state === "exited" && revList.code === 0) {
        const parts = UTF8_DECODER.decode(revList.stdout).trim().split(/\s+/)
        const ahead = Number(parts[0])
        const behind = Number(parts[1])
        const upstreamRefRes = await execGit(
          bound.path,
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
          { timeoutMs: 3_000 },
        )
        if (upstreamRefRes.state === "exited" && upstreamRefRes.code === 0 && Number.isFinite(ahead) && Number.isFinite(behind)) {
          const full = UTF8_DECODER.decode(upstreamRefRes.stdout).trim()
          const slash = full.indexOf("/")
          if (slash > 0) {
            upstream = {
              remote: full.slice(0, slash),
              branch: full.slice(slash + 1),
              ahead,
              behind,
            }
          }
        }
      }
    }

    const snapshot = sha256(JSON.stringify([bound.identity, head, branch, rawStatus]))
    return {
      branch,
      head,
      files,
      snapshot,
      upstream,
      blockedReason: null,
    }
  }

  async #readGitDiff(bound: BoundRoot, snapshot: string, relPath: string): Promise<ProjectGitDiffValue> {
    if (!bound.isGitRepository) {
      throw new LocalDirectoryError("PROJECT_GIT_UNAVAILABLE", "当前目录不是 Git 仓库，无差异可查看。")
    }
    const status = await this.#readGitStatus(bound)
    if (status.snapshot !== snapshot) {
      throw new LocalDirectoryError("PROJECT_GIT_STALE", "工作区变更已更新，请先刷新变更列表。")
    }
    const file = status.files.find(item => item.path === relPath)
    if (!file) {
      throw new LocalDirectoryError("PROJECT_FILE_NOT_FOUND", "该文件不在当前变更列表中。")
    }

    const diffBaseArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"]
    let text = ""
    if (file.status === "??" || !status.head) {
      const res = await execGit(bound.path, [
        ...diffBaseArgs,
        "--no-index",
        "--",
        process.platform === "win32" ? "NUL" : "/dev/null",
        file.path,
      ])
      if (res.state !== "exited" || res.code > 1) {
        throw new LocalDirectoryError("PROJECT_READ_FAILED", "读取未跟踪文件差异失败。")
      }
      text = res.stdout.toString("utf8")
    } else {
      const paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path]
      const res = await execGit(bound.path, [...diffBaseArgs, status.head, "--", ...paths])
      if (res.state !== "exited" || res.code !== 0) {
        throw new LocalDirectoryError("PROJECT_READ_FAILED", "读取文件差异失败。")
      }
      text = res.stdout.toString("utf8")
    }

    return {
      snapshot,
      path: relPath,
      truncated: text.length > DIFF_LIMIT,
      text: text.slice(0, DIFF_LIMIT).replace(/[\uD800-\uDBFF]$/u, "") || "无可显示的文本差异，可能仅权限、二进制或元数据有变化。",
    }
  }
}
