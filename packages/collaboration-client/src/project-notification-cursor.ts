/**
 * 【功能定义】通知游标持久化工具：仅记录已经交给消费端确认的最大服务端事件序号，按服务、账号及团队单独原子保存。
 * 【协作边界】纯 Node 文件系统持久化，不依赖 Electron；通过串行写入队列避免并发切换团队时游标乱序覆盖。
 */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const pendingWrites = new Map<string, Promise<void>>()

export function isNotificationCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function notificationCursor(directory: string, origin: string, accountId: string, workspaceId: string) {
  const key = createHash("sha256").update(JSON.stringify([origin, accountId, workspaceId])).digest("hex")
  const path = join(directory, key)

  async function readFileCursor(): Promise<number> {
    try {
      const text = (await readFile(path, "utf8")).trim()
      const id = Number(text)
      return String(id) === text && isNotificationCursor(id) ? id : 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return 0
    }
  }

  return {
    async read(): Promise<number> {
      // 在切换回同一团队前，等待旧订阅已确认的最后一次写入落盘。
      await pendingWrites.get(path)?.catch(() => {})
      return readFileCursor()
    },
    async save(id: number): Promise<void> {
      const previous = pendingWrites.get(path)
      const current = (async () => {
        await previous?.catch(() => {})
        if (id <= await readFileCursor()) return
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, String(id), { mode: 0o600 })
          await rename(temporary, path)
        } finally { await rm(temporary, { force: true }) }
      })()
      pendingWrites.set(path, current)
      try { await current }
      finally { if (pendingWrites.get(path) === current) pendingWrites.delete(path) }
    },
  }
}
