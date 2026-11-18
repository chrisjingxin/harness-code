/**
 * Harness Agent 可执行入口探测与 GUI PATH 增强。
 *
 * 【功能定义】按 `.venv/bin/harness-agent` → `.venv/bin/python3|python -m harness_agent acp`
 * → 活跃虚拟环境 / PATH 中的 `harness-agent` 顺序查找本机可用的 Harness ACP 进程入口。
 * 【协作边界】只检查文件与执行权限，绝不通过 shell 拼接命令；保留虚拟环境原始可执行路径以维持 pyvenv 配置。
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { LocalAcpProviderDiscoveryOptions, LocalAcpProviderResolution } from "./types.js"

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

function resolveSafeHome(env: NodeJS.ProcessEnv, override?: string): string {
  if (override?.trim()) return override.trim()
  if (env.HOME?.trim()) return env.HOME.trim()
  if (env.USERPROFILE?.trim()) return env.USERPROFILE.trim()
  try {
    return userInfo().homedir || homedir()
  } catch {
    return homedir()
  }
}

/** 将 GUI 桌面启动时常缺失的常见命令行目录补入 PATH（保留原 PATH 优先级在最前）。 */
export function buildAugmentedGuiPath(
  env: NodeJS.ProcessEnv = process.env,
  options: LocalAcpProviderDiscoveryOptions = {},
): string {
  const seen = new Set<string>()
  const dirs: string[] = []
  const pushDir = (dir: string | undefined) => {
    const trimmed = dir?.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    dirs.push(trimmed)
  }

  for (const part of (env.PATH ?? "").split(delimiter)) pushDir(part)
  for (const extra of options.extraPathDirs ?? []) pushDir(extra)

  if (options.includeDefaultGuiPath !== false) {
    const home = resolveSafeHome(env, options.homeDir)
    if (home) pushDir(join(home, ".local", "bin"))
    if (process.platform !== "win32") {
      pushDir("/opt/homebrew/bin")
      pushDir("/usr/local/bin")
      pushDir("/usr/bin")
    }
    pushDir(dirname(process.execPath))
  }
  return dirs.join(delimiter)
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

function findVenvCommand(
  venvRoot: string,
  agentPkgDir: string,
  env: NodeJS.ProcessEnv,
  augmentedPath: string,
): LocalAcpProviderResolution | undefined {
  const isWin = process.platform === "win32"
  const venvBin = join(venvRoot, isWin ? "Scripts" : "bin")
  const cli = join(venvBin, isWin ? "harness-agent.exe" : "harness-agent")
  // 注意：不可对虚拟环境内可执行文件做 realpathSync，避免 Python 丢失同目录的 pyvenv.cfg 依赖定位。
  if (isExecutableFile(cli)) {
    return { available: true, source: "venv-cli", command: { executable: cli, args: ["acp"], env: { ...env, PATH: augmentedPath } } }
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
 * 优先级：仓库 `packages/agent/.venv` → 当前激活的 `VIRTUAL_ENV` → PATH 中的 `harness-agent`。
 */
export function resolveHarnessCommand(
  env: NodeJS.ProcessEnv = process.env,
  options: LocalAcpProviderDiscoveryOptions = {},
): LocalAcpProviderResolution {
  const isWin = process.platform === "win32"
  const augmentedPath = buildAugmentedGuiPath(env, options)
  const roots = new Set<string>(
    options.searchFrom
      ? options.searchFrom.flatMap(entry => ancestorDirs(entry))
      : [
          ...ancestorDirs(dirname(fileURLToPath(import.meta.url))),
          ...ancestorDirs(process.cwd()),
        ],
  )

  for (const root of roots) {
    const agentDir = join(root, "packages", "agent")
    const found = findVenvCommand(join(agentDir, ".venv"), agentDir, env, augmentedPath)
    if (found) return found
  }

  const activeVenv = env.VIRTUAL_ENV?.trim()
  if (activeVenv) {
    for (const root of roots) {
      const found = findVenvCommand(activeVenv, join(root, "packages", "agent"), env, augmentedPath)
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
    reason: "未检测到本机 Harness Agent（请准备 packages/agent/.venv 或将 harness-agent 加入 PATH）。",
  }
}
