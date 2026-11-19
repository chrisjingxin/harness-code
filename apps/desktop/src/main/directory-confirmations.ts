/**
 * 主进程记住用户通过原生窗口确认的目录。服务来源和账号共同隔离记录，
 * 恢复时比较规范路径及目录实体，防止同名路径被替换后沿用旧确认。
 * 会话归属与该会话保存的目录由 local-execution-ipc 在读取前核对。
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

export type ConfirmedDirectory = {
  readonly path: string
  readonly dev: string
  readonly ino: string
}

/** 读取当前目录的真实身份；原始路径的符号链接变化也会在恢复核对中被识别。 */
export async function inspectDirectory(path: string): Promise<ConfirmedDirectory> {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("目录路径无效。")
  const canonical = await realpath(path)
  const info = await stat(canonical, { bigint: true })
  if (!info.isDirectory()) throw new Error("目录不存在。")
  return { path: canonical, dev: String(info.dev), ino: String(info.ino) }
}

export function sameDirectory(left: ConfirmedDirectory, right: ConfirmedDirectory): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino
}

export class DirectoryConfirmations {
  constructor(private readonly root: string, private readonly origin: string) {}

  #file(accountId: string, path: string): string {
    const key = createHash("sha256").update(JSON.stringify([this.origin, accountId, path])).digest("hex")
    return join(this.root, key + ".json")
  }

  /** 原子替换单个目录记录，保存失败由调用方显示真实原因。 */
  async remember(accountId: string, path: string, directory: ConfirmedDirectory): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const file = this.#file(accountId, path)
    const temporary = file + "." + randomUUID() + ".tmp"
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, ...directory }), { mode: 0o600, flag: "wx" })
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
  }

  async read(accountId: string, path: string): Promise<ConfirmedDirectory | null> {
    let bytes: Buffer
    try { bytes = await readFile(this.#file(accountId, path)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    if (bytes.length > 32_768) throw new Error("目录确认记录过大。")
    const value = JSON.parse(bytes.toString("utf8"))
    if (value?.version !== 1 || typeof value.path !== "string" || !isAbsolute(value.path)
      || typeof value.dev !== "string" || !/^\d+$/.test(value.dev)
      || typeof value.ino !== "string" || !/^\d+$/.test(value.ino)) throw new Error("目录确认记录无效。")
    return { path: value.path, dev: value.dev, ino: value.ino }
  }
}
