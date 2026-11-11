/** 宿主目录绑定与有界文件读取。通过真实目录身份和打开的文件句柄复核范围。 */
import { constants, type Stats } from "node:fs"
import { lstat, open, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { ProjectServiceError } from "./types.js"

export function contains(root: string, candidate: string): boolean {
  const delta = relative(root, candidate)
  return !isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`)
}

export function sameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export function sameFileVersion(left: Stats, right: Stats): boolean {
  return sameObject(left, right) && left.size === right.size && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

export function filesystemError(error: unknown): ProjectServiceError {
  if (error instanceof ProjectServiceError) return error
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT":
    case "ENOTDIR":
      return new ProjectServiceError("not-found", "文件或目录不存在。")
    case "EACCES":
    case "EPERM":
      return new ProjectServiceError("permission-denied", "没有访问权限。")
    case "ELOOP":
      return new ProjectServiceError("outside-project", "无法在项目范围内解析链接。")
    default:
      return new ProjectServiceError("io-error", "本机项目读取失败。")
  }
}

/** 保留合法路径的原字面值，拒绝宿主可能另作解释的路径。 */
export function validRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || /^[a-z]:|^\\\\/i.test(path) || path.includes("\0")) return false
  if (process.platform === "win32" && /[\\:]/.test(path)) return false
  return path.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"
    && !(process.platform === "win32" && (/[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))))
}

export class ProjectRoot {
  readonly identity: string

  private constructor(readonly path: string, private readonly info: Stats) {
    this.identity = JSON.stringify([path, info.dev, info.ino])
  }

  static async bind(path: string): Promise<ProjectRoot> {
    if (!isAbsolute(path)) throw new ProjectServiceError("invalid-path", "宿主须提供项目根的绝对路径。")
    try {
      const canonical = await realpath(path)
      const info = await stat(canonical)
      if (!info.isDirectory()) throw new ProjectServiceError("invalid-path", "项目根须为目录。")
      return new ProjectRoot(canonical, info)
    } catch (error) {
      throw filesystemError(error)
    }
  }

  /** 目录被替换后旧服务实例和它签发的快照都失效。 */
  async verify(): Promise<void> {
    try {
      if (await realpath(this.path) === this.path && sameObject(this.info, await stat(this.path))) return
    } catch {
      // 目录不可达和身份变化都要求宿主重新核对原登记。
    }
    throw new ProjectServiceError("root-changed", "登记的项目根已变化，请重新核对本机目录。")
  }

  relativePath(path: string, allowRoot = false): string {
    if (allowRoot && path === "") return this.path
    if (!validRelativePath(path)) throw new ProjectServiceError("invalid-path", "无效的项目相对路径。")
    return resolve(this.path, path)
  }

  assertReadable(path: string, protectedPaths: readonly string[]): void {
    const parts = relative(this.path, path).split(sep)
    if (!contains(this.path, path) || parts.some(part => part.toLowerCase() === ".git")
      || protectedPaths.some(directory => contains(directory, path))) {
      throw new ProjectServiceError("outside-project", "目标超出项目读取范围。")
    }
  }

  async resolveReadable(path: string, protectedPaths: readonly string[], directory = false): Promise<string> {
    const lexical = this.relativePath(path, directory)
    try {
      const actual = await realpath(lexical)
      this.assertReadable(actual, protectedPaths)
      if (directory && actual !== lexical) throw new ProjectServiceError("unsupported", "目录链接不可展开。")
      return actual
    } catch (error) {
      throw filesystemError(error)
    }
  }

  /** 核对普通文件、真实位置及打开句柄的身份后读取，避免读到替换后的链接或特殊文件。 */
  async readRegular(path: string, limit: number, protectedPaths: readonly string[], expected: Stats): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const actual = await realpath(path)
      this.assertReadable(actual, protectedPaths)
      const before = await handle.stat()
      const located = await lstat(actual)
      if (actual !== path || !before.isFile() || !sameFileVersion(expected, before) || !sameFileVersion(before, located)) {
        throw new ProjectServiceError("file-changed", "文件在读取期间变化，请刷新。")
      }
      const buffer = Buffer.alloc(Math.min(limit, before.size))
      let used = 0
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used)
        if (!bytesRead) break
        used += bytesRead
      }
      if (used !== buffer.length || !sameFileVersion(before, await handle.stat())
        || await realpath(path) !== actual || !sameFileVersion(before, await lstat(actual))) {
        throw new ProjectServiceError("file-changed", "文件在读取期间变化，请刷新。")
      }
      await this.verify()
      return buffer
    } finally {
      await handle.close()
    }
  }
}
