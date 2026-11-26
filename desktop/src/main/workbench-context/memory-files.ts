/**
 * 本机 Markdown 的安全文件操作；只接受 store 已确定的范围路径，不接受模型路径。
 * 目录校验 → 无链接读取/核对 → 临时同步 → 最终身份及内容检查 → 原子替换。
 */
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

/** 可向 Agent 返回的本地失败，不携带文件绝对路径或原始堆栈。 */
export class MemoryFileError extends Error {
  constructor(readonly reason: string, message: string) { super(message) }
}
export const missingMemoryFile = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT"

/** 逐级创建和核对范围目录；不得把链接目标当作当前账号目录。 */
export async function ensureMemoryDirectory(root: string, target: string): Promise<void> {
  for (const path of [root, join(target, "..", ".."), join(target, ".."), target]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new MemoryFileError("unsafe_path", "记忆目录不安全，未读取或覆盖。")
  }
}

/** 不跟随文件链接；打开后核对文件身份，避免检查与读取之间被替换。 */
export async function readMemoryBytes(path: string): Promise<Buffer | null> {
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new MemoryFileError("unsafe_path", "记忆文件必须是无链接的普通文件。")
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || before.ino !== opened.ino || before.dev !== opened.dev) throw new MemoryFileError("unsafe_path", "记忆文件在读取时发生变化，请重试。")
      const bytes = await handle.readFile()
      const after = await lstat(path)
      if (after.ino !== opened.ino || after.dev !== opened.dev || after.isSymbolicLink() || after.nlink !== 1) throw new MemoryFileError("unsafe_path", "记忆文件在读取时发生变化，请重试。")
      return bytes
    } finally { await handle.close() }
  } catch (error) {
    if (missingMemoryFile(error)) return null
    throw error
  }
}

/** 原件备份只创建一次，已有备份必须与原始字节一致；绝不覆盖它。 */
export async function backupMemoryBytes(path: string, bytes: Buffer): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error
  }
  if (!(await readMemoryBytes(path))?.equals(bytes)) throw new MemoryFileError("backup_failed", "迁移备份不完整或不一致，原件已保留。")
}

/** check 在同步之后、替换之前核对身份与内容；已完成的 rename 不因终态或展示失败回滚。 */
export async function replaceMemoryBytes(path: string, bytes: Buffer, check: () => Promise<void>): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temp, "wx", 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await check()
    await rename(temp, path)
  } finally { await rm(temp, { force: true }).catch(() => {}) }
}
