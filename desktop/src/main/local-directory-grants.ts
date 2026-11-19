/**
 * 本机执行目录授权存储与工作区 `@file` 沙箱附件转换。
 *
 * 【功能定义】
 * 1. 按账号隔离记录经原生目录选择器确认过的目录实体（`realpath` + `bigint` `dev`/`ino`），
 *    并在重开应用时校验硬件标识未篡改后恢复授权；
 * 2. 对会话发送附带的相对工作区路径做越界与软链接逃逸拦截，转换通过项为标准 ACP `resource_link`。
 * 【协作边界】仅在桌面主进程运行，不启动子进程，不越过授权目录访问文件系统。
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { LocalAcpPromptBlock } from "@workbench/acp-runtime/types"
import type { CollaborationResult } from "@workbench/collaboration-client/types"
import { identityError } from "@workbench/collaboration-client"
import { CONTROL_CHAR_PATTERN } from "./ipc-guard.js"

export const MAX_PERSISTED_GRANTS = 200
export const MAX_ATTACHMENTS = 200
const MAX_GRANT_FILE_BYTES = 1_048_576

export type DirectoryGrant = {
  readonly path: string
  readonly dev: bigint
  readonly ino: bigint
}

/** 读取当前目录的真实身份；原始路径的符号链接变化也会在恢复核对中被识别。 */
export async function inspectDirectory(path: string): Promise<DirectoryGrant> {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("目录路径无效。")
  const canonical = await realpath(path)
  const info = await stat(canonical, { bigint: true })
  if (!info.isDirectory()) throw new Error("目录不存在。")
  return { path: canonical, dev: info.dev, ino: info.ino }
}

export function sameDirectory(left: DirectoryGrant, right: DirectoryGrant): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino
}

export type GrantLoginContext = {
  readonly accountId: string
  readonly generation: number
}

type PersistedGrantEntry = {
  readonly path: string
  readonly dev: string
  readonly ino: string
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return Boolean(rel) && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)
}

function isSafeRelativeWorkspacePath(rawPath: string): boolean {
  if (!rawPath || typeof rawPath !== "string" || rawPath.length > 1024 || CONTROL_CHAR_PATTERN.test(rawPath)) {
    return false
  }
  if (isAbsolute(rawPath) || rawPath.startsWith("/") || rawPath.startsWith("\\") || /^[a-zA-Z]:/.test(rawPath)) {
    return false
  }
  const normalized = rawPath.replaceAll("\\", "/")
  const segments = normalized.split("/")
  return segments.every(seg => seg.length > 0 && seg !== "." && seg !== ".." && seg.toLowerCase() !== ".git")
}

function parseGrantEntry(value: unknown): PersistedGrantEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.path !== "string" || !isAbsolute(record.path)
    || typeof record.dev !== "string" || !/^\d+$/.test(record.dev)
    || typeof record.ino !== "string" || !/^\d+$/.test(record.ino)) {
    return null
  }
  return { path: record.path, dev: record.dev, ino: record.ino }
}

async function readPersistedGrantMap(filePath: string, strict = false): Promise<Record<string, PersistedGrantEntry>> {
  const clean = Object.create(null) as Record<string, PersistedGrantEntry>
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return clean
    if (strict) throw error
    return clean
  }
  if (bytes.length > MAX_GRANT_FILE_BYTES) {
    if (strict) throw new Error("目录确认记录过大。")
    return clean
  }
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString("utf8"))
  } catch (error) {
    if (strict) throw error
    return clean
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (strict) throw new Error("目录确认记录格式无效。")
    return clean
  }
  for (const [key, value] of Object.entries(raw)) {
    const parsed = parseGrantEntry(value)
    if (!parsed) {
      if (strict) throw new Error("目录确认记录无效。")
      continue
    }
    clean[key] = parsed
  }
  return clean
}

/** 创建按服务来源和账号共同隔离的工作目录授权内存与磁盘存储。 */
export function createLocalDirectoryGrantStore(
  grantsDir: string | undefined,
  isCurrent: (login: GrantLoginContext) => boolean,
  origin = "",
) {
  const grants = new Map<string, DirectoryGrant>()
  let grantIo: Promise<void> = Promise.resolve()

  function enqueueGrantIo<T>(action: () => Promise<T>): Promise<T> {
    const result = grantIo.then(action)
    grantIo = result.then(() => {}, () => {})
    return result
  }

  function grantFileForAccount(accountId: string): string | null {
    if (!grantsDir) return null
    const hash = createHash("sha256").update(JSON.stringify([origin, accountId])).digest("hex")
    return join(grantsDir, `${hash}.json`)
  }

  async function persist(login: GrantLoginContext, selectedPath: string, grant: DirectoryGrant): Promise<void> {
    const filePath = grantFileForAccount(login.accountId)
    if (!filePath || !grantsDir) return
    await enqueueGrantIo(async () => {
      if (!isCurrent(login)) return
      const existing = await readPersistedGrantMap(filePath, false)
      delete existing[selectedPath]
      const entries = Object.entries(existing)
      const trimmed = entries.length >= MAX_PERSISTED_GRANTS
        ? entries.slice(entries.length - MAX_PERSISTED_GRANTS + 1)
        : entries
      const next = Object.create(null) as Record<string, PersistedGrantEntry>
      for (const [key, value] of trimmed) next[key] = value
      next[selectedPath] = { path: grant.path, dev: String(grant.dev), ino: String(grant.ino) }
      await mkdir(grantsDir, { recursive: true, mode: 0o700 })
      const temp = `${filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, JSON.stringify(next), { flag: "wx", mode: 0o600, flush: true })
        await rename(temp, filePath)
      } finally {
        await rm(temp, { force: true }).catch(() => {})
      }
    })
  }

  async function rememberConfirmed(login: GrantLoginContext, path: string, grant: DirectoryGrant): Promise<void> {
    if (!isCurrent(login)) return
    if (grantsDir) await persist(login, path, grant)
    if (isCurrent(login)) grants.set(path, grant)
  }

  async function readPersisted(login: GrantLoginContext, selectedPath: string): Promise<DirectoryGrant | undefined> {
    const filePath = grantFileForAccount(login.accountId)
    if (!filePath) return undefined
    return enqueueGrantIo(async () => {
      if (!isCurrent(login)) return undefined
      const existing = await readPersistedGrantMap(filePath, true)
      if (!Object.hasOwn(existing, selectedPath)) return undefined
      const entry = existing[selectedPath]!
      return { path: entry.path, dev: BigInt(entry.dev), ino: BigInt(entry.ino) }
    })
  }

  return {
    clearMemory(): void {
      grants.clear()
    },
    getMemory(path: string): DirectoryGrant | undefined {
      return grants.get(path)
    },
    rememberConfirmed,
    readPersisted,
    async captureSelection(login: GrantLoginContext | null, path: string): Promise<void> {
      if (!login || !isCurrent(login)) return
      const grant = await inspectDirectory(path)
      if (!isCurrent(login)) return
      await rememberConfirmed(login, path, grant)
    },
  }
}

/** 对工作区相对路径附件做严格目录沙箱校验（含 `realpath` 防软链接逃逸），通过后转为标准 ACP `resource_link`。 */
export async function resolveAttachmentBlocks(
  directory: DirectoryGrant,
  attachments: readonly string[],
): Promise<CollaborationResult<readonly LocalAcpPromptBlock[]> | { readonly rejectedReason: string }> {
  const uniquePaths = [...new Set(attachments)]
  if (uniquePaths.length === 0) return { ok: true, value: [] }
  if (uniquePaths.length > MAX_ATTACHMENTS) {
    return identityError("INVALID_REQUEST", "附件数量超出单次发送上限。")
  }

  try {
    const canonicalRoot = await realpath(directory.path)
    const rootInfo = await stat(canonicalRoot, { bigint: true })
    if (!rootInfo.isDirectory() || canonicalRoot !== directory.path || rootInfo.dev !== directory.dev || rootInfo.ino !== directory.ino) {
      return identityError("PROJECT_ROOT_CHANGED", "所选工作目录已变更，请重新选择。")
    }
  } catch {
    return identityError("PROJECT_ROOT_CHANGED", "所选工作目录已不可访问，请重新选择。")
  }

  const blocks: LocalAcpPromptBlock[] = []
  for (const rawPath of uniquePaths) {
    if (!isSafeRelativeWorkspacePath(rawPath)) {
      return identityError("PROJECT_PATH_INVALID", `附件路径越界或无效，仅允许引用当前工作目录内的文件：${rawPath}`)
    }
    const candidate = resolve(directory.path, rawPath)
    if (!isInsideRoot(directory.path, candidate)) {
      return identityError("PROJECT_PATH_INVALID", `附件路径越界，仅允许引用当前工作目录内的文件：${rawPath}`)
    }
    let canonical: string
    let info
    try {
      canonical = await realpath(candidate)
      info = await stat(canonical)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { rejectedReason: `附件文件不存在：${rawPath}` }
      }
      return identityError("PROJECT_PATH_INVALID", `无法读取附件文件：${rawPath}`)
    }
    if (!isInsideRoot(directory.path, canonical)) {
      return identityError("PROJECT_PATH_INVALID", `附件符号链接指向工作区之外，已被拒绝：${rawPath}`)
    }
    if (!info.isFile()) {
      return { rejectedReason: `仅支持引用普通文件作为附件：${rawPath}` }
    }
    const safeRel = relative(directory.path, canonical).replaceAll("\\", "/")
    blocks.push({
      type: "resource_link",
      uri: pathToFileURL(canonical).href,
      name: safeRel,
      title: basename(canonical),
      size: info.size,
    })
  }
  return { ok: true, value: blocks }
}
