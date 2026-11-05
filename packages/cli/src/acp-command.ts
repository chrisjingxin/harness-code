/**
 * `harness acp` 的透传实现：把 CLI 的 stdio 原样交给 Python sidecar 的 ACP 模式。
 *
 * 【这是做什么的？】
 * ACP（Agent Client Protocol）是编辑器与 Agent 之间的 JSON-RPC 协议，走 stdin/stdout。
 * 所以这个子命令不建立 v3 握手、不创建 CLI 侧诊断日志、不读 stdin、不写 stdout：
 * 它只是按 runtime-binding 找到 sidecar，把 `acp` 参数追加到 argv 末尾，然后用
 * `stdio: "inherit"` 让父子进程共享同一对管道。任何额外字节都会污染协议流。
 *
 * 【上下游】
 * 上游：`args.ts` 的 `parseAcpCommand`（已校验选项）与 `index.ts` 的 `execute` 短路分支。
 * 下游：`runtime-binding.ts` 的可执行文件解析，以及子进程本身。
 */

import { spawn } from "node:child_process"
import { delimiter } from "node:path"

import type { Command } from "./args"
import { CLI_INSTALL_ROOT_ENV, resolveAgentProcessBinding, resolveCliInstallRoot } from "./runtime-binding"

export type AcpCommand = Extract<Command, { kind: "acp" }>

/** spawn sidecar 所需的完整计划；纯数据，便于单测断言。 */
export type AcpSpawnPlan = {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * 构造 `harness acp` 的 spawn 计划。
 *
 * 环境变量与 v3 的 `startAgent` 保持同一套约定：`HARNESS_COMMAND_KIND=acp` 让 sidecar
 * 诊断日志把组件标成 acp，`HARNESS_CLI_INSTALL_ROOT` 提供可信依赖根，`--config` 映射成
 * `HARNESS_AGENT_CONFIG_PATH`，开发形态再把源码目录拼进 `PYTHONPATH`。
 *
 * 这里刻意不抽公共构造函数：v3 路径的 env 拼装与 stdio 模式完全不同，共用会逼着
 * `startAgent` 长出一堆分支，收益为负。
 */
export function buildAcpSpawnPlan(
  command: AcpCommand,
  lookup: { moduleDir: string; env: NodeJS.ProcessEnv },
): AcpSpawnPlan {
  const binding = resolveAgentProcessBinding({ moduleDir: lookup.moduleDir, env: lookup.env })
  const [executable, ...argv] = binding.argv
  // PYTHONSAFEPATH=1：`python -m` 不再把当前工作目录放进 sys.path。否则工作区里恰好有
  // 顶层 `acp/` 目录或 `acp.py` 时，会遮住官方 SDK，sidecar 启动即报 ModuleNotFoundError。
  const env: NodeJS.ProcessEnv = {
    ...lookup.env,
    PYTHONSAFEPATH: "1",
    HARNESS_COMMAND_KIND: "acp",
    [CLI_INSTALL_ROOT_ENV]: resolveCliInstallRoot(lookup.moduleDir),
  }
  if (command.configPath) env.HARNESS_AGENT_CONFIG_PATH = command.configPath
  if (binding.pythonPath) {
    env.PYTHONPATH = lookup.env.PYTHONPATH
      ? `${binding.pythonPath}${delimiter}${lookup.env.PYTHONPATH}`
      : binding.pythonPath
  }
  return { executable: executable!, args: [...argv, "acp"], cwd: command.cwd, env }
}

/**
 * 运行 `harness acp`，返回子进程退出码。
 *
 * 退出码约定：正常退出透传；被信号杀死时换算成 `128 + signal`（与 shell 一致）；
 * spawn 本身失败（例如找不到可执行文件）向上抛，由 `main` 打到 stderr 并以 1 退出。
 * 透传 SIGINT/SIGTERM/SIGHUP 给子进程，终端 Ctrl-C 才能真的停下 ACP 会话。
 */
export async function runAcpPassthrough(
  command: AcpCommand,
  deps: { spawn?: typeof spawn; lookup?: { moduleDir: string; env: NodeJS.ProcessEnv } } = {},
): Promise<number> {
  const plan = buildAcpSpawnPlan(command, deps.lookup ?? { moduleDir: import.meta.dir, env: process.env })
  const spawnImpl = deps.spawn ?? spawn
  const child = spawnImpl(plan.executable, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: "inherit",
  })
  const signals: NodeJS.Signals[] = process.platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"]
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal)
  }
  for (const signal of signals) process.on(signal, forward)
  const cleanup = () => {
    for (const signal of signals) process.off(signal, forward)
  }
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    child.once("error", error => {
      cleanup()
      rejectPromise(error)
    })
    child.once("exit", (code, signal) => {
      cleanup()
      if (code !== null) {
        resolvePromise(code)
        return
      }
      resolvePromise(128 + (signal ? signalNumber(signal) : 0))
    })
  })
}

/** 把信号名换成数值，用于 `128 + n` 的退出码换算。 */
function signalNumber(signal: string): number {
  const constants = (process as NodeJS.Process & { constants?: { signals?: Record<string, number> } }).constants
  return constants?.signals?.[signal] ?? 0
}

export { spawn }
