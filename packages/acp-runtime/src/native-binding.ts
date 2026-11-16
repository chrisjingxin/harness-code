/** 在本机保存不透明的 ACP 会话 ID。文件名由宿主计算，工作目录与 Renderer 都无法指定存储路径。 */
import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type NativeBinding = {
  read(): Promise<string | undefined>
  write(sessionId: string): Promise<void>
}

export function nativeBinding(base: string | undefined, identity: readonly string[]): NativeBinding {
  let nativeId: string | undefined
  if (!base) return { async read() { return nativeId }, async write(id) { nativeId = id } }
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex")
  const path = join(base, key + ".json")
  return {
    async read() {
      let value: unknown
      try { value = JSON.parse(await readFile(path, "utf8")) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
      if (typeof value !== "string" || !value || value.length > 4096) throw new Error("原生会话绑定无效。")
      return value
    },
    async write(id) {
      if (!id || id.length > 4096) throw new Error("原生会话标识无效。")
      await mkdir(base, { recursive: true, mode: 0o700 })
      const temporary = path + "." + randomUUID()
      try {
        await writeFile(temporary, JSON.stringify(id), { mode: 0o600, flag: "wx" })
        // 两个窗口进程使用同一个应用数据目录时，先建立的原生会话绑定优先。
        await link(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    },
  }
}
