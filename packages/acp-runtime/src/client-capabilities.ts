/**
 * ACP 客户端反向 RPC 能力（工作区沙箱 `fs/*` 与可选 `terminal/*`）。
 *
 * 1. 所有文件读写与终端工作目录都严格限制在宿主绑定的 `root` 内：
 *    通过 `realpath` 归属判定 + `O_NOFOLLOW` + 字节上限，拦截任何跨目录、软链接逃逸或悬空链接写入。
 * 2. 未开启的能力不仅不在 `initialize` 声明，还会在反向调用时显式抛出 `-32601 Method not found`
 *    （绕开 SDK 在处理器缺省时对 `writeTextFile` / `releaseTerminal` 返回 `{}` 的默认宽松行为）。
 * 3. 终端子进程由控制器统一登记，轮次结束与会话关闭时强制清理，避免孤儿进程残留。
 */
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Readable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import {
  RequestError,
  type Client,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type TerminalExitStatus,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk"

const DEFAULT_FS_MAX_BYTES = 1_048_576
const DEFAULT_TERMINAL_OUTPUT_BYTES = 256 * 1024
const MAX_TERMINAL_OUTPUT_BYTES = 1_048_576
const MAX_ACTIVE_TERMINALS = 16
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

export type ClientCapabilityContext = {
  readonly root: string
  readonly device: bigint
  readonly inode: bigint
  readonly env?: NodeJS.ProcessEnv
  readonly enableFs: boolean
  readonly enableTerminal: boolean
  readonly maxFsFileBytes?: number
  hasSessionId(sessionId: string): boolean
  isActive(): boolean
}

export type ClientCapabilityController = {
  readonly handlers: Pick<
    Client,
    | "readTextFile"
    | "writeTextFile"
    | "createTerminal"
    | "terminalOutput"
    | "waitForTerminalExit"
    | "killTerminal"
    | "releaseTerminal"
  >
  cleanupTerminals(sessionId?: string): Promise<void>
}

type ManagedTerminal = {
  readonly id: string
  readonly sessionId: string
  readonly child: ChildProcessByStdio<null, Readable, Readable>
  readonly exited: Promise<TerminalExitStatus>
  readonly byteLimit: number
  chunks: Buffer[]
  totalBytes: number
  truncated: boolean
  exitStatus?: TerminalExitStatus
  released: boolean
  stopping?: Promise<void>
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)
}

async function assertRootUnchanged(ctx: ClientCapabilityContext): Promise<void> {
  try {
    const [canonical, info] = await Promise.all([realpath(ctx.root), stat(ctx.root, { bigint: true })])
    if (canonical === ctx.root && info.isDirectory() && info.dev === ctx.device && info.ino === ctx.inode) return
  } catch {
    // 下面统一以无效参数报错，拒绝后续文件或终端操作。
  }
  throw RequestError.invalidParams("工作区根目录不可用或已发生变更。")
}

function assertValidSession(ctx: ClientCapabilityContext, sessionId: string): void {
  if (!ctx.isActive() || !sessionId || !ctx.hasSessionId(sessionId)) {
    throw RequestError.invalidParams("会话尚未就绪或 sessionId 不匹配。")
  }
}

function normalizeCandidatePath(root: string, rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string" || rawPath.includes("\0")) {
    throw RequestError.invalidParams("文件路径无效。")
  }
  return resolve(root, rawPath)
}

/** 对已存在的路径验证真实位置（realpath）必须落在工作区 root 内，拦截软链接逃逸。 */
async function resolveExistingPathInRoot(ctx: ClientCapabilityContext, rawPath: string): Promise<string> {
  const resolved = normalizeCandidatePath(ctx.root, rawPath)
  let canonical: string
  try {
    canonical = await realpath(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === "ENOENT" || code === "ENOTDIR") throw RequestError.resourceNotFound(resolved)
    throw RequestError.invalidParams("无法解析目标路径。")
  }
  if (!isInside(ctx.root, canonical) || canonical === ctx.root) {
    throw RequestError.invalidParams("拒绝访问工作区目录之外的路径。")
  }
  return canonical
}

/**
 * 解析待写入目标路径：
 * - 若目标本身已存在且是符号链接或目录，直接拒绝（防止悬空软链接欺骗写入工作区外）；
 * - 若父目录尚不存在，向上找到最近的已有祖先，确认其 realpath 仍在 root 内再创建子目录。
 */
async function resolveWritablePathInRoot(ctx: ClientCapabilityContext, rawPath: string): Promise<string> {
  const resolved = normalizeCandidatePath(ctx.root, rawPath)
  try {
    const targetInfo = await lstat(resolved)
    if (targetInfo.isSymbolicLink() || targetInfo.isDirectory()) {
      throw RequestError.invalidParams("拒绝向符号链接或目录写入文本文件。")
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== "ENOENT") {
      if (error instanceof RequestError) throw error
      throw RequestError.invalidParams("目标写入路径无效。")
    }
  }

  let probe = resolved
  const missingSegments: string[] = []
  while (true) {
    try {
      const info = await lstat(probe)
      if (info.isSymbolicLink()) {
        throw RequestError.invalidParams("拒绝穿过符号链接路径。")
      }
      const canonicalAncestor = await realpath(probe)
      if (!isInside(ctx.root, canonicalAncestor)) {
        throw RequestError.invalidParams("拒绝写入工作区目录之外的路径。")
      }
      let target = canonicalAncestor
      for (let i = missingSegments.length - 1; i >= 0; i--) {
        target = join(target, missingSegments[i]!)
      }
      if (!isInside(ctx.root, target) || target === ctx.root) {
        throw RequestError.invalidParams("拒绝写入工作区目录之外的路径。")
      }
      return target
    } catch (error) {
      if (error instanceof RequestError) throw error
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== "ENOENT") throw RequestError.invalidParams("无法确认写入目标父目录。")
      const parent = dirname(probe)
      if (parent === probe) throw RequestError.invalidParams("拒绝写入工作区目录之外的路径。")
      missingSegments.push(relative(parent, probe))
      probe = parent
    }
  }
}

function sliceLines(text: string, line?: number | null, limit?: number | null): string {
  if (line !== undefined && line !== null && (!Number.isSafeInteger(line) || line < 1)) {
    throw RequestError.invalidParams("line 必须是大于等于 1 的整数。")
  }
  if (limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw RequestError.invalidParams("limit 必须是非负整数。")
  }
  if ((line === undefined || line === null) && (limit === undefined || limit === null)) return text
  const lines = text.split("\n")
  const start = (line ?? 1) - 1
  const end = limit !== undefined && limit !== null ? start + limit : lines.length
  return lines.slice(start, end).join("\n")
}

/** 丢弃开头可能被截断的 UTF-8 续字节（10xxxxxx），保证输出始终是合法 UTF-8 字符串。 */
function decodeRetainedUtf8(chunks: readonly Buffer[]): string {
  if (!chunks.length) return ""
  const combined = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)
  for (let offset = 0; offset <= Math.min(3, combined.length); offset++) {
    try {
      return UTF8_DECODER.decode(combined.subarray(offset))
    } catch {
      // 从前面截断时可能正好落在多字节字符中间，继续向后对齐下一个完整字符边界。
    }
  }
  return combined.toString("utf8")
}

async function stopTerminalProcess(terminal: ManagedTerminal): Promise<void> {
  return terminal.stopping ??= (async () => {
    if (terminal.exitStatus) return
    const pid = terminal.child.pid
    const signalGroupOrChild = (name: NodeJS.Signals) => {
      if (pid !== undefined && process.platform !== "win32") {
        try { process.kill(-pid, name); return }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return
        }
      }
      try { terminal.child.kill(name) } catch {}
    }
    signalGroupOrChild("SIGTERM")
    const settled = await Promise.race([
      terminal.exited.then(() => true),
      delay(800).then(() => false),
    ])
    if (!settled) {
      signalGroupOrChild("SIGKILL")
      await Promise.race([terminal.exited, delay(500)])
    }
  })()
}

/** 构造供 ClientSideConnection 注册的 fs/* 与 terminal/* 处理器及清理句柄。 */
export function createClientCapabilityHandlers(ctx: ClientCapabilityContext): ClientCapabilityController {
  const maxBytes = ctx.maxFsFileBytes ?? DEFAULT_FS_MAX_BYTES
  const terminals = new Map<string, ManagedTerminal>()

  async function readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    if (!ctx.enableFs) throw RequestError.methodNotFound("fs/read_text_file")
    assertValidSession(ctx, params.sessionId)
    await assertRootUnchanged(ctx)

    const canonical = await resolveExistingPathInRoot(ctx, params.path)
    let handle
    try {
      handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === "ENOENT") throw RequestError.resourceNotFound(canonical)
      if (code === "ELOOP") throw RequestError.invalidParams("拒绝读取符号链接文件。")
      throw RequestError.invalidParams("无法打开读取文件。")
    }

    try {
      const info = await handle.stat()
      if (!info.isFile()) throw RequestError.invalidParams("仅支持读取普通文本文件。")
      if (info.size > maxBytes) throw RequestError.invalidParams("文件体积超出读取上限。")
      if (await realpath(canonical) !== canonical || !isInside(ctx.root, canonical)) {
        throw RequestError.invalidParams("文件在读取期间发生越界变化。")
      }
      const buffer = Buffer.alloc(info.size)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      const payload = buffer.subarray(0, offset)
      if (payload.subarray(0, 8192).includes(0)) throw RequestError.invalidParams("暂不支持读取二进制文件。")
      const text = UTF8_DECODER.decode(payload)
      return { content: sliceLines(text, params.line, params.limit) }
    } catch (error) {
      if (error instanceof RequestError) throw error
      throw RequestError.invalidParams("文件不是有效的 UTF-8 文本。")
    } finally {
      await handle.close()
    }
  }

  async function writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    if (!ctx.enableFs) throw RequestError.methodNotFound("fs/write_text_file")
    assertValidSession(ctx, params.sessionId)
    await assertRootUnchanged(ctx)

    const bytes = Buffer.from(params.content, "utf8")
    if (bytes.length > maxBytes) throw RequestError.invalidParams("写入文本超出允许的字节上限。")
    const target = await resolveWritablePathInRoot(ctx, params.path)
    const dir = dirname(target)
    await mkdir(dir, { recursive: true })
    const canonicalDir = await realpath(dir)
    if (!isInside(ctx.root, canonicalDir)) {
      throw RequestError.invalidParams("写入目录在创建后超出工作区范围。")
    }
    const safeTarget = join(canonicalDir, relative(dir, target))

    let handle
    try {
      handle = await open(
        safeTarget,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
        0o644,
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === "ELOOP") throw RequestError.invalidParams("拒绝写入符号链接目标。")
      throw RequestError.invalidParams("无法打开目标文件进行写入。")
    }

    try {
      let written = 0
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, written)
        written += result.bytesWritten
      }
      return {}
    } finally {
      await handle.close()
    }
  }

  function getTerminal(sessionId: string, terminalId: string): ManagedTerminal {
    if (!ctx.enableTerminal) throw RequestError.methodNotFound("terminal")
    assertValidSession(ctx, sessionId)
    const terminal = terminals.get(terminalId)
    if (!terminal || terminal.released || terminal.sessionId !== sessionId) {
      throw RequestError.resourceNotFound(terminalId)
    }
    return terminal
  }

  async function createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    if (!ctx.enableTerminal) throw RequestError.methodNotFound("terminal/create")
    assertValidSession(ctx, params.sessionId)
    await assertRootUnchanged(ctx)
    if (!params.command || typeof params.command !== "string") {
      throw RequestError.invalidParams("terminal/create 缺少有效的 command。")
    }
    if (terminals.size >= MAX_ACTIVE_TERMINALS) {
      throw RequestError.internalError("活动终端数量已达到上限。")
    }

    let cwd = ctx.root
    if (params.cwd) {
      const resolvedCwd = normalizeCandidatePath(ctx.root, params.cwd)
      let canonicalCwd: string
      try {
        canonicalCwd = await realpath(resolvedCwd)
      } catch {
        throw RequestError.invalidParams("指定的终端工作目录不存在。")
      }
      if (!isInside(ctx.root, canonicalCwd)) {
        throw RequestError.invalidParams("拒绝在工作区之外的目录启动终端。")
      }
      const info = await stat(canonicalCwd)
      if (!info.isDirectory()) throw RequestError.invalidParams("终端工作目录必须是文件夹。")
      cwd = canonicalCwd
    }

    const requestedLimit = params.outputByteLimit
    const byteLimit = typeof requestedLimit === "number" && Number.isFinite(requestedLimit) && requestedLimit >= 0
      ? Math.min(Math.floor(requestedLimit), MAX_TERMINAL_OUTPUT_BYTES)
      : DEFAULT_TERMINAL_OUTPUT_BYTES

    const childEnv: NodeJS.ProcessEnv = { ...ctx.env }
    for (const item of params.env ?? []) {
      childEnv[item.name] = item.value
    }

    const id = randomUUID()
    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    })

    let resolveExited!: (status: TerminalExitStatus) => void
    const exited = new Promise<TerminalExitStatus>(resolvePromise => { resolveExited = resolvePromise })
    const terminal: ManagedTerminal = {
      id,
      sessionId: params.sessionId,
      child,
      exited,
      byteLimit,
      chunks: [],
      totalBytes: 0,
      truncated: false,
      released: false,
    }

    const appendOutput = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (!bytes.length) return
      if (terminal.byteLimit === 0) {
        terminal.truncated = true
        return
      }
      terminal.chunks.push(bytes)
      terminal.totalBytes += bytes.length
      if (terminal.totalBytes > terminal.byteLimit) {
        terminal.truncated = true
        let overflow = terminal.totalBytes - terminal.byteLimit
        while (overflow > 0 && terminal.chunks.length) {
          const head = terminal.chunks[0]!
          if (head.length <= overflow) {
            terminal.chunks.shift()
            terminal.totalBytes -= head.length
            overflow -= head.length
          } else {
            terminal.chunks[0] = head.subarray(overflow)
            terminal.totalBytes -= overflow
            overflow = 0
          }
        }
      }
    }

    child.stdout.on("data", appendOutput)
    child.stderr.on("data", appendOutput)
    child.once("error", () => {
      if (terminal.exitStatus) return
      const status: TerminalExitStatus = { exitCode: null, signal: "SIGABRT" }
      terminal.exitStatus = status
      resolveExited(status)
    })
    child.once("close", (code, sig) => {
      if (terminal.exitStatus) return
      const status: TerminalExitStatus = { exitCode: code, signal: sig }
      terminal.exitStatus = status
      resolveExited(status)
    })

    terminals.set(id, terminal)
    return { terminalId: id }
  }

  async function terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    if (!ctx.enableTerminal) throw RequestError.methodNotFound("terminal/output")
    const terminal = getTerminal(params.sessionId, params.terminalId)
    return {
      output: decodeRetainedUtf8(terminal.chunks),
      truncated: terminal.truncated,
      ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}),
    }
  }

  async function waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    if (!ctx.enableTerminal) throw RequestError.methodNotFound("terminal/wait_for_exit")
    const terminal = getTerminal(params.sessionId, params.terminalId)
    const status = await terminal.exited
    return { exitCode: status.exitCode ?? null, signal: status.signal ?? null }
  }

  async function killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    if (!ctx.enableTerminal) throw RequestError.methodNotFound("terminal/kill")
    const terminal = getTerminal(params.sessionId, params.terminalId)
    await stopTerminalProcess(terminal)
    return {}
  }

  async function releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    if (!ctx.enableTerminal) throw RequestError.methodNotFound("terminal/release")
    const terminal = getTerminal(params.sessionId, params.terminalId)
    terminal.released = true
    terminals.delete(params.terminalId)
    await stopTerminalProcess(terminal)
    return {}
  }

  async function cleanupTerminals(sessionId?: string): Promise<void> {
    const active = sessionId === undefined
      ? [...terminals.values()]
      : [...terminals.values()].filter(terminal => terminal.sessionId === sessionId)
    if (sessionId === undefined) {
      terminals.clear()
    } else {
      for (const terminal of active) terminals.delete(terminal.id)
    }
    await Promise.all(active.map(async terminal => {
      terminal.released = true
      await stopTerminalProcess(terminal)
    }))
  }

  return {
    handlers: {
      readTextFile,
      writeTextFile,
      createTerminal,
      terminalOutput,
      waitForTerminalExit,
      killTerminal,
      releaseTerminal,
    },
    cleanupTerminals,
  }
}
