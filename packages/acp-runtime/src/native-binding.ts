/** 在本机保存不透明的 ACP 会话 ID。文件名由宿主计算，工作目录与 Renderer 都无法指定存储路径。 */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export type NativeBinding = {
  read(): Promise<string | undefined>
  write(sessionId: string): Promise<void>
  clear(): Promise<void>
}

/** 计算与 `LocalAcpHost.bind` 一致的原生绑定标识数组（剥离 workspaceId/projectId 以保持发布与停止共享前后连续）。 */
export function buildNativeBindingIdentity(
  bindingNamespace: string | undefined,
  scope: {
    readonly accountId: string
    readonly workspaceId?: string | null
    readonly projectId?: string | null
    readonly conversationId: string
  },
  root: string,
  dev: bigint,
  ino: bigint,
  command?: {
    readonly executable: string
    readonly args?: readonly string[]
    readonly env?: Readonly<Record<string, string | undefined>>
  },
): string[] {
  const env = command ? (command.env ?? process.env) : undefined
  return [
    bindingNamespace ?? "",
    scope.accountId,
    scope.conversationId,
    root,
    String(dev),
    String(ino),
    command?.executable ?? "",
    JSON.stringify(command?.args ?? []),
    env?.HOME ?? env?.USERPROFILE ?? "",
  ]
}

export function nativeBinding(base: string | undefined, identity: readonly string[]): NativeBinding {
  let nativeId: string | undefined
  if (!base) {
    return {
      async read() { return nativeId },
      async write(id) {
        if (!id || id.length > 4096) throw new Error("原生会话标识无效。")
        nativeId = id
      },
      async clear() { nativeId = undefined },
    }
  }
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
        // 通过临时独占文件 + rename 原子替换绑定，允许在旧原生会话失效后覆盖写入新会话 ID。
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    },
    async clear() {
      await rm(path, { force: true })
    },
  }
}
