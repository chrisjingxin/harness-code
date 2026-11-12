/** 原设备 Git 子进程。参数与正文分别传递，所有命令都有输出预算和等待上限。 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { ProjectServiceError } from "./types.js"

export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")
export const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

export type GitCommandResult =
  | { state: "exited"; code: number; stdout: Buffer }
  | { state: "unavailable" | "interrupted" }

function gitEnvironment(index?: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_PREFIX",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_INTERNAL_SUPER_PREFIX",
  ]) delete env[key]
  return {
    ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...(index ? { GIT_INDEX_FILE: index } : {}),
  }
}

export function gitCommand(
  cwd: string,
  args: readonly string[],
  options: { index?: string; input?: string | Buffer; timeout?: number; maxBuffer?: number } = {},
): Promise<GitCommandResult> {
  return new Promise(resolve => {
    const child = execFile("git", ["--no-pager", ...args], {
      cwd, env: gitEnvironment(options.index), encoding: "buffer", windowsHide: true,
      timeout: options.timeout ?? 15_000, maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024, killSignal: "SIGKILL",
    }, (error, stdout) => {
      if (!error || typeof error.code === "number" && !error.killed) {
        resolve({ state: "exited", code: error ? error.code as number : 0, stdout })
      } else {
        resolve({ state: child.pid === undefined ? "unavailable" : "interrupted" })
      }
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(options.input)
  })
}

export async function gitRun(
  cwd: string, args: readonly string[], options?: Parameters<typeof gitCommand>[2],
): Promise<Buffer> {
  const result = await gitCommand(cwd, args, options)
  if (result.state !== "exited") throw new ProjectServiceError("git-unavailable", "Git 不可用或执行超出限制。")
  if (result.code !== 0) throw new ProjectServiceError("git-failed", "Git 操作失败，请在原设备检查仓库。")
  return result.stdout
}

export async function gitOptional(cwd: string, args: readonly string[], absentCode = 1): Promise<Buffer | null> {
  const result = await gitCommand(cwd, args)
  if (result.state !== "exited") throw new ProjectServiceError("git-unavailable", "Git 不可用或执行超出限制。")
  if (result.code === 0) return result.stdout
  if (result.code === absentCode) return null
  throw new ProjectServiceError("git-failed", "无法核对本机 Git 配置。")
}

/** Git 路径使用 NUL 分隔，绝对路径或引用的单值输出只去掉 Git 添加的最后一个换行。 */
export function gitText(value: Buffer): string {
  try {
    return utf8.decode(value)
  } catch {
    throw new ProjectServiceError("unsupported", "Git 返回了无法表示为 UTF-8 的路径或元数据。")
  }
}

export function gitLine(value: Buffer): string {
  return gitText(value).replace(/\n$/, "")
}
