/**
 * Harness Agent 启动入口探测。
 *
 * 【功能定义】基于 `@workbench/acp-runtime` 公共路径探测工具，按优先级定位顶层 `agent/.venv`
 * （含 Git worktree 主仓库回溯）、当前激活虚拟环境或 `PATH` 中的 `harness-agent` 可执行入口。
 * 【协作边界】只检查可执行权限与 Python 入口存在性，绝不通过 shell 启动或修改任何用户文件。
 */
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ancestorDirs,
  buildAugmentedGuiPath,
  findInPath,
  isExecutableFile,
  resolveGitMainWorktreeRoot,
  type AcpAgentDiscoveryOptions,
  type AcpAgentResolution,
} from "@workbench/acp-runtime"

function findVenvCommand(
  venvRoot: string,
  agentPkgDir: string,
  env: Readonly<Record<string, string | undefined>>,
  augmentedPath: string,
): AcpAgentResolution | undefined {
  const isWin = process.platform === "win32"
  const venvBin = join(venvRoot, isWin ? "Scripts" : "bin")
  const cli = join(venvBin, isWin ? "harness-agent.exe" : "harness-agent")
  // 注意：不可对虚拟环境内可执行文件做 realpathSync，避免 Python 丢失同目录的 pyvenv.cfg 依赖定位。
  if (isExecutableFile(cli)) {
    return {
      available: true,
      source: "venv-cli",
      command: { executable: cli, args: ["acp"], env: { ...env, PATH: augmentedPath } },
    }
  }
  const agentMain = join(agentPkgDir, "harness_agent", "__main__.py")
  if (!existsSync(agentMain)) return undefined
  const pyNames = isWin ? ["python.exe", "python3.exe"] : ["python3", "python"]
  for (const pyName of pyNames) {
    const python = join(venvBin, pyName)
    if (!isExecutableFile(python)) continue
    return {
      available: true,
      source: "venv-python",
      command: {
        executable: python,
        args: ["-m", "harness_agent", "acp"],
        env: {
          ...env,
          PATH: augmentedPath,
          PYTHONSAFEPATH: "1",
          PYTHONPATH: agentPkgDir,
        },
      },
    }
  }
  return undefined
}

/**
 * 探测本机 Harness ACP Agent 启动命令。
 * 优先级：仓库 `agent/.venv` → 当前激活的 `VIRTUAL_ENV` → PATH 中的 `harness-agent`。
 */
export function resolveHarnessCommand(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: AcpAgentDiscoveryOptions = {},
): AcpAgentResolution {
  const isWin = process.platform === "win32"
  const augmentedPath = buildAugmentedGuiPath(env, options)
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const seeds = options.searchFrom ?? [moduleDir, process.cwd()]
  const baseRoots = seeds.flatMap(entry => ancestorDirs(entry))
  const roots = new Set<string>(baseRoots)
  for (const seed of seeds) {
    const mainRoot = resolveGitMainWorktreeRoot(seed)
    if (mainRoot) {
      for (const candidate of ancestorDirs(mainRoot)) roots.add(candidate)
    }
  }

  for (const root of roots) {
    const agentDir = join(root, "agent")
    const found = findVenvCommand(join(agentDir, ".venv"), agentDir, env, augmentedPath)
    if (found) return found
  }

  const activeVenv = env.VIRTUAL_ENV?.trim()
  if (activeVenv) {
    for (const root of roots) {
      const found = findVenvCommand(activeVenv, join(root, "agent"), env, augmentedPath)
      if (found) return found
    }
  }

  const pathBin = findInPath(
    isWin ? ["harness-agent.exe", "harness-agent.cmd", "harness.exe"] : ["harness-agent", "harness"],
    augmentedPath,
  )
  if (pathBin) {
    return {
      available: true,
      source: "path",
      command: { executable: pathBin, args: ["acp"], env: { ...env, PATH: augmentedPath } },
    }
  }

  return {
    available: false,
    reason: "未检测到本机 Harness Agent（请准备 agent/.venv 或将 harness-agent 加入 PATH）。",
  }
}
