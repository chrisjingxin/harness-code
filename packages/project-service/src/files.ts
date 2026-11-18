/**
 * 【功能定义】文件树浏览、@ 候选文件检索与只读正文预览实现。
 * 【协作边界】所有操作都在 `ProjectRoot` 校验与 `.git`/敏感目录保护边界内执行；内容缓存由上层调用方管理。
 */
import { lstat, opendir, realpath, stat } from "node:fs/promises"
import { posix, resolve } from "node:path"
import { digest, gitCommand, gitText, utf8 } from "./git-command.js"
import { detectGitRoot } from "./git-state.js"
import { ProjectRoot, filesystemError, sameFileVersion, validRelativePath } from "./root.js"
import { ProjectServiceError } from "./types.js"
import type { ProjectCandidates, ProjectDirectory, ProjectEntry, ProjectPreview } from "./types.js"

const MAX_INDEX_ROWS = 20_000
const MAX_DIRECTORY_ROWS = 2_000
const PAGE_ROWS = 512
const MAX_CANDIDATES = 1_000
const MAX_PREVIEW_BYTES = 256 * 1024
const MAX_PREVIEW_LINES = 2_000
const MAX_LINE_CHARS = 20_000
const ignored = new Set([".git", "node_modules", ".venv", "__pycache__", ".cache", "dist", "build", "coverage"])
const ranks = { directory: 0, file: 1, symlink: 2 }
const languageAliases = new Map(Object.entries({
  js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", mts: "typescript", cts: "typescript",
  jsonc: "json", py: "python", sh: "bash", shell: "bash", zsh: "bash", h: "c", cc: "cpp", cxx: "cpp",
  hpp: "cpp", hxx: "cpp", "c++": "cpp", htm: "html", yml: "yaml", md: "markdown",
}))
const languages = new Set([
  "javascript", "typescript", "jsx", "tsx", "json", "python", "bash", "go", "java",
  "c", "cpp", "html", "css", "yaml", "markdown",
])

type Index = { entries: ProjectEntry[]; truncated: boolean }

function entry(path: string, kind: ProjectEntry["kind"]): ProjectEntry {
  return { path, name: posix.basename(path), kind, expandable: kind === "directory" }
}

function compare(left: ProjectEntry, right: ProjectEntry): number {
  return ranks[left.kind] - ranks[right.kind]
    || left.name.localeCompare(right.name, "zh", { numeric: true, sensitivity: "base" })
    || (left.path < right.path ? -1 : Number(left.path !== right.path))
}

function parent(path: string): string {
  return posix.dirname(path) === "." ? "" : posix.dirname(path)
}

function hasIgnoredSegment(path: string): boolean {
  return path.split("/").some(segment => ignored.has(segment))
}

function decodePreview(bytes: Buffer, truncated: boolean): string {
  if (bytes.subarray(0, 8192).includes(0)) throw new ProjectServiceError("binary-file", "二进制文件暂不支持预览。")
  for (let trim = 0; trim <= Math.min(truncated ? 3 : 0, bytes.length); trim++) {
    try {
      return utf8.decode(bytes.subarray(0, bytes.length - trim)).replace(/^\uFEFF/, "")
    } catch {
      // 字节上限可能落在 UTF-8 多字节字符中间，最多剥离尾部 3 个残字节重试。
    }
  }
  throw new ProjectServiceError("unsupported-encoding", "非 UTF-8 文本暂不支持预览。")
}

export class ProjectFiles {
  constructor(private readonly root: ProjectRoot) {}

  async listDirectory(directory = "", cursor?: string): Promise<ProjectDirectory> {
    await this.root.verify()
    const { protectedPaths } = await detectGitRoot(this.root.path)
    const listed = await this.scanDirectory(directory, protectedPaths)
    listed.entries.sort(compare)
    const limited = listed.truncated || listed.entries.length > MAX_DIRECTORY_ROWS
    const rows = listed.entries.slice(0, MAX_DIRECTORY_ROWS)
    // 游标绑定原目录及当前可见条目，目录变化时不会续读旧位置。
    const version = digest(JSON.stringify([this.root.identity, directory, rows, limited]))
    const offset = cursor === undefined ? 0 : this.cursorOffset(cursor, version, rows.length)
    const entries = rows.slice(offset, offset + PAGE_ROWS)
    const end = offset + entries.length
    await this.root.verify()
    return { entries, truncated: limited, ...(end < rows.length ? { nextCursor: `${version}:${end}` } : {}) }
  }

  async searchCandidates({ directory, query, limit = MAX_CANDIDATES }: {
    directory: string; query: string; limit?: number
  }): Promise<ProjectCandidates> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || query.length > 4096) {
      throw new ProjectServiceError("limit-exceeded", "文件候选查询超出限制。")
    }
    await this.root.verify()
    const { isGitRepository, protectedPaths } = await detectGitRoot(this.root.path)
    await this.resolveDirectory(directory, protectedPaths)
    const term = query.trim()
    const source = term
      ? (isGitRepository ? await this.gitIndex(protectedPaths, directory) : null) ?? await this.scanTree(protectedPaths, directory)
      : await this.scanDirectory(directory, protectedPaths)
    const matches = term
      ? source.entries.filter(item => item.kind !== "directory").map(item => ({
        item, score: candidateScore(item, term.toLowerCase()),
      })).filter(match => match.score > 0).sort((left, right) => right.score - left.score || compare(left.item, right.item))
        .map(match => match.item)
      : source.entries.sort(compare)
    const take = Math.min(limit, MAX_CANDIDATES)
    const classified = term && isGitRepository ? await this.classify(matches.slice(0, take), protectedPaths) : matches.slice(0, take)
    const pattern = term ? new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu") : null
    const items = classified.map(item => {
      const match = pattern?.exec(item.path)
      return { ...item, matchRanges: match ? [{ start: match.index, end: match.index + match[0].length }] : [] }
    })
    await this.root.verify()
    const complete = !source.truncated && classified.length === Math.min(matches.length, take)
    return { items, ...(complete ? { total: matches.length } : {}), truncated: !complete || matches.length > take }
  }

  async readPreview(path: string): Promise<ProjectPreview> {
    await this.root.verify()
    const { protectedPaths } = await detectGitRoot(this.root.path)
    try {
      return await this.readOnce(path, protectedPaths)
    } catch (error) {
      if (filesystemError(error).code !== "file-changed") throw filesystemError(error)
    }
    try {
      return await this.readOnce(path, protectedPaths)
    } catch (error) {
      throw filesystemError(error)
    }
  }

  private async readOnce(path: string, protectedPaths: readonly string[]): Promise<ProjectPreview> {
    const actual = await this.root.resolveReadable(path, protectedPaths)
    const info = await lstat(actual)
    if (!info.isFile()) throw new ProjectServiceError("unsupported", "仅支持普通文件预览。")
    const bytes = await this.root.readRegular(actual, MAX_PREVIEW_BYTES, protectedPaths, info)
    if (await this.root.resolveReadable(path, protectedPaths) !== actual) {
      throw new ProjectServiceError("file-changed", "文件链接在读取期间变化，请刷新。")
    }
    const byteTruncated = bytes.length < info.size
    const decoded = decodePreview(bytes, byteTruncated)
    const content = decoded.split("\n").slice(0, MAX_PREVIEW_LINES)
      .map(line => line.slice(0, MAX_LINE_CHARS).replace(/[\uD800-\uDBFF]$/u, "")).join("\n")
    const extension = posix.extname(path).slice(1).toLowerCase()
    const language = languageAliases.get(extension) ?? extension
    return {
      path, content, language: languages.has(language) ? language : null, sizeBytes: info.size,
      displayedBytes: Buffer.byteLength(content), lineCount: content ? content.split("\n").length - Number(content.endsWith("\n")) : 0,
      truncated: byteTruncated || content !== decoded,
    }
  }

  private async resolveDirectory(directory: string, protectedPaths: readonly string[]): Promise<string> {
    const path = await this.root.resolveReadable(directory, protectedPaths, true)
    try {
      if (!(await stat(path)).isDirectory()) throw new ProjectServiceError("invalid-path", "目标路径不是目录。")
      return path
    } catch (error) {
      throw filesystemError(error)
    }
  }

  private async scanDirectory(directory: string, protectedPaths: readonly string[]): Promise<Index> {
    const path = await this.resolveDirectory(directory, protectedPaths)
    try {
      const before = await stat(path)
      const entries: ProjectEntry[] = []
      let truncated = false
      for await (const row of await opendir(path)) {
        const relativePath = directory ? `${directory}/${row.name}` : row.name
        if (!validRelativePath(relativePath) || (row.isDirectory() && ignored.has(row.name))) continue
        try {
          this.root.assertReadable(resolve(path, row.name), protectedPaths)
        } catch {
          continue
        }
        if (entries.length === MAX_DIRECTORY_ROWS) {
          truncated = true
          break
        }
        if (row.isDirectory() || row.isFile() || row.isSymbolicLink()) {
          entries.push(entry(relativePath, row.isDirectory() ? "directory" : row.isFile() ? "file" : "symlink"))
        }
      }
      if (await realpath(path) !== path || !sameFileVersion(before, await stat(path))) {
        throw new ProjectServiceError("file-changed", "目录在读取期间变化，请刷新。")
      }
      return { entries, truncated }
    } catch (error) {
      throw filesystemError(error)
    }
  }

  private async scanTree(protectedPaths: readonly string[], startDir = ""): Promise<Index> {
    const queue = [startDir]
    const entries: ProjectEntry[] = []
    let truncated = false
    for (let index = 0; index < queue.length; index++) {
      let page: Index
      try {
        page = await this.scanDirectory(queue[index]!, protectedPaths)
      } catch (error) {
        if (index === 0) throw error
        truncated = true
        continue
      }
      truncated ||= page.truncated
      for (const item of page.entries) {
        if (entries.length === MAX_INDEX_ROWS) return { entries, truncated: true }
        entries.push(item)
        if (item.kind === "directory") queue.push(item.path)
      }
    }
    return { entries, truncated }
  }

  private async gitIndex(protectedPaths: readonly string[], scopeDir = ""): Promise<Index | null> {
    const result = await gitCommand(this.root.path, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      timeout: 5_000, maxBuffer: 16 * 1024 * 1024,
    })
    if (result.state !== "exited" || result.code !== 0) return null
    const entries: ProjectEntry[] = []
    for (const file of gitText(result.stdout).split("\0").filter(Boolean)) {
      if (!validRelativePath(file) || hasIgnoredSegment(file)) continue
      if (scopeDir && file !== scopeDir && !file.startsWith(`${scopeDir}/`)) continue
      try {
        this.root.assertReadable(this.root.relativePath(file), protectedPaths)
      } catch {
        continue
      }
      if (entries.length === MAX_INDEX_ROWS) {
        return { entries, truncated: true }
      }
      entries.push(entry(file, "file"))
    }
    return { entries, truncated: false }
  }

  private async classify(rows: ProjectEntry[], protectedPaths: readonly string[]): Promise<ProjectEntry[]> {
    const result: ProjectEntry[] = []
    for (let offset = 0; offset < rows.length; offset += 32) {
      const batch = await Promise.all(rows.slice(offset, offset + 32).map(async item => {
        try {
          await this.root.resolveReadable(parent(item.path), protectedPaths, true)
          const info = await lstat(this.root.relativePath(item.path))
          if (info.isSymbolicLink()) return entry(item.path, "symlink")
          return info.isDirectory() || info.isFile() ? item : null
        } catch (error) {
          // Git 索引仍可列出刚被删除的条目。根外或链接目录的子项不返回。
          return filesystemError(error).code === "not-found" ? item : null
        }
      }))
      for (const item of batch) if (item) result.push(item)
    }
    return result
  }

  private cursorOffset(cursor: string, version: string, length: number): number {
    const match = /^([a-f0-9]{64}):([1-9][0-9]{0,3})$/.exec(cursor)
    const offset = Number(match?.[2])
    if (!match || match[1] !== version || offset >= length || offset % PAGE_ROWS !== 0) {
      throw new ProjectServiceError("cursor-expired", "目录列表已变化，请从头刷新。")
    }
    return offset
  }
}

function candidateScore(item: ProjectEntry, query: string): number {
  const name = item.name.toLowerCase()
  const path = item.path.toLowerCase()
  const match = name === query ? 100 : name.startsWith(query) ? 80 : path.startsWith(query) ? 60
    : name.includes(query) ? 40 : path.includes(query) ? 20 : 0
  return match - Math.min(10, item.path.split("/").length)
}
