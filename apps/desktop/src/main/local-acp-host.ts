/** HC-218 的主进程接点。优先读取启动配置，未显式指定时自动探测本机 Harness Code ACP 入口。 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { LocalAcpHost, type AgentCommand } from "@workbench/acp-runtime"
import type { LocalExecutionRuntime } from "./local-execution-ipc.js"

function isExecutableFile(candidate: string): boolean {
  if (!isAbsolute(candidate)) return false
  try {
    if (!statSync(candidate).isFile()) return false
    if (process.platform !== "win32") accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function ancestorDirs(start: string, depth = 7): string[] {
  const dirs: string[] = []
  let current = resolve(start)
  for (let i = 0; i < depth; i++) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

function findInPath(names: readonly string[], pathValue?: string): string | undefined {
  if (!pathValue) return undefined
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (!isExecutableFile(candidate)) continue
      try { return realpathSync(candidate) } catch { return candidate }
    }
  }
  return undefined
}

/** 解析本机 ACP Agent 启动命令：显式环境变量优先，否则自动查找仓库 .venv 或 PATH 中的 harness-agent。 */
export function resolveDesktopLocalAcpCommand(env: NodeJS.ProcessEnv = process.env): AgentCommand | undefined {
  const executable = env.WORKBENCH_ACP_EXECUTABLE?.trim()
  if (executable) {
    const args: unknown = JSON.parse(env.WORKBENCH_ACP_ARGS_JSON ?? "[]")
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) {
      throw new Error("WORKBENCH_ACP_ARGS_JSON 必须是字符串数组。")
    }
    return { executable, args, env }
  }

  const isWin = process.platform === "win32"
  const roots = new Set<string>([
    ...ancestorDirs(dirname(fileURLToPath(import.meta.url))),
    ...ancestorDirs(process.cwd()),
  ])
  for (const root of roots) {
    const venvBin = join(root, "packages", "agent", ".venv", isWin ? "Scripts" : "bin")
    const cli = join(venvBin, isWin ? "harness-agent.exe" : "harness-agent")
    if (isExecutableFile(cli)) {
      return { executable: cli, args: ["acp"], env }
    }
    const python = join(venvBin, isWin ? "python.exe" : "python")
    const agentMain = join(root, "packages", "agent", "harness_agent", "__main__.py")
    if (isExecutableFile(python) && existsSync(agentMain)) {
      return {
        executable: python,
        args: ["-m", "harness_agent", "acp"],
        env: {
          ...env,
          PYTHONSAFEPATH: "1",
          PYTHONPATH: join(root, "packages", "agent"),
        },
      }
    }
  }

  const pathBin = findInPath(
    isWin ? ["harness-agent.exe", "harness.exe"] : ["harness-agent", "harness"],
    env.PATH,
  )
  if (pathBin) return { executable: pathBin, args: ["acp"], env }
  return undefined
}

export function createDesktopLocalAcpHost(env: NodeJS.ProcessEnv = process.env, bindingDirectory?: string): LocalAcpHost {
  const command = resolveDesktopLocalAcpCommand(env)
  if (!command) return new LocalAcpHost()
  return new LocalAcpHost(command, { bindingDirectory, bindingNamespace: env.WORKBENCH_SERVICE_ORIGIN })
}

export type DesktopLocalExecutionRuntime = {
  readonly localExecution: LocalExecutionRuntime
  readonly dispose: () => Promise<void>
}

/** 创建应用级本机执行运行时及退出收口句柄，屏蔽具体 Agent 装配细节。 */
export function createDesktopLocalExecutionRuntime(
  env: NodeJS.ProcessEnv,
  userDataDir: string,
): DesktopLocalExecutionRuntime {
  let localExecution: LocalExecutionRuntime
  try {
    const command = resolveDesktopLocalAcpCommand(env)
    if (!command) {
      localExecution = { error: "尚未配置本机 Agent。请确认本机已安装 harness-agent，或设置 WORKBENCH_ACP_EXECUTABLE 后重启工作台。" }
    } else {
      localExecution = { host: createDesktopLocalAcpHost(env, join(userDataDir, "local-acp-bindings")) }
    }
  } catch {
    localExecution = { error: "本机 Agent 配置无效。请检查可执行文件的绝对路径及 WORKBENCH_ACP_ARGS_JSON 字符串数组。" }
  }
  return {
    localExecution,
    dispose: () => ("host" in localExecution ? localExecution.host.close() : Promise.resolve()),
  }
}
