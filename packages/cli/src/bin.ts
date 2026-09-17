#!/usr/bin/env node
/** Node CLI 引导层：在加载 Ink 与业务模块前执行最低版本门禁。 */
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

type CliModule = { main(argv?: string[]): Promise<void> }

export type CliBootstrapDependencies = {
  nodeVersion?: string
  load?: () => Promise<CliModule>
}

/** 拒绝 Node 20 以下版本，避免在错误 Runtime 中先解析 Ink。 */
export function assertSupportedNode(version = process.versions.node): void {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10)
  if (!Number.isInteger(major) || major < 20) {
    throw new Error(`Harness Code requires Node.js >=20 (current: ${version})`)
  }
}

/** 版本门禁通过后才动态加载应用入口。 */
export async function runCli(argv = process.argv.slice(2), dependencies: CliBootstrapDependencies = {}): Promise<void> {
  assertSupportedNode(dependencies.nodeVersion)
  const application = await (dependencies.load ?? (() => import("./index")))()
  await application.main(argv)
}

/** 保留启动期稳定错误码，同时避免向终端展开任意异常对象。 */
export function formatCliError(error: unknown): string {
  if (error instanceof Error && error.message === "THREAD_STORE_UNAVAILABLE") {
    const data = (error as Error & { data?: unknown }).data
    if (data && typeof data === "object" && "code" in data && typeof data.code === "string") {
      return `${error.message}: ${data.code}`
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/** npm bin 通过符号链接启动，比较真实路径才能识别当前模块是命令入口。 */
export function isDirectEntry(
  entry = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
  canonicalize: (path: string) => string = realpathSync,
): boolean {
  if (!entry) return false
  try {
    return canonicalize(resolve(entry)) === canonicalize(resolve(modulePath))
  } catch {
    return resolve(entry) === resolve(modulePath)
  }
}

if (isDirectEntry()) {
  runCli().catch(error => {
    console.error(`za38: ${formatCliError(error)}`)
    process.exitCode = 1
  })
}
