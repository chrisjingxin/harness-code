/**
 * Pi (`pi-acp`) 可执行入口探测与用户配置目录修复。
 *
 * 【功能定义】
 * 1. 为 Electron GUI 补齐 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin` 与 `dirname(process.execPath)` 后查找 `pi-acp`；
 * 2. 当 `env.PI_CODING_AGENT_DIR` 未设置时，使用真实系统用户主目录 `os.userInfo().homedir/.pi/agent` 注入，
 *    避免 macOS 桌面或沙盒进程篡改 `HOME` 后找不到 auth/models 配置。
 * 【协作边界】只检查文件与执行权限，不通过 shell 执行，不读取 Pi 私有配置文件内容。
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { delimiter, dirname, isAbsolute, join } from "node:path"
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

/** 优先通过 `os.userInfo().homedir` 解析真实操作系统用户主目录，避开受沙盒/容器改写的 `env.HOME`。 */
export function resolveRealUserHomeDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override?.trim()) return override.trim()
  try {
    const infoHome = userInfo().homedir?.trim()
    if (infoHome) return infoHome
  } catch {
    // 容器内无 passwd 记录时回退到标准主目录解析。
  }
  return homedir() || env.HOME?.trim() || env.USERPROFILE?.trim() || ""
}

/** 构造适用于桌面 GUI 环境的增强 `PATH`（原 `env.PATH` 优先）。 */
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
    const home = options.homeDir?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || resolveRealUserHomeDir(undefined, env)
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

function findInPath(names: readonly string[], pathValue: string): { path: string; fromEnvPath: boolean } | undefined {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (!isExecutableFile(candidate)) continue
      try {
        return { path: realpathSync(candidate), fromEnvPath: true }
      } catch {
        return { path: candidate, fromEnvPath: true }
      }
    }
  }
  return undefined
}

/** 探测本机 `pi-acp` 并补齐 `PATH` 与 `PI_CODING_AGENT_DIR`。 */
export function resolvePiCommand(
  env: NodeJS.ProcessEnv = process.env,
  options: LocalAcpProviderDiscoveryOptions = {},
): LocalAcpProviderResolution {
  const isWin = process.platform === "win32"
  const names = isWin ? ["pi-acp.cmd", "pi-acp.exe", "pi-acp"] : ["pi-acp"]
  const direct = findInPath(names, env.PATH ?? "")
  const augmentedPath = buildAugmentedGuiPath(env, options)
  const resolved = direct ?? findInPath(names, augmentedPath)
  if (!resolved) {
    return {
      available: false,
      reason: "未检测到 pi-acp 可执行文件（已检索 PATH 与 ~/.local/bin、/opt/homebrew/bin、/usr/local/bin）。",
    }
  }

  const configuredAgentDir = env.PI_CODING_AGENT_DIR?.trim()
  const realHome = resolveRealUserHomeDir(options.userHomeDir, env)
  const piAgentDir = configuredAgentDir || (realHome ? join(realHome, ".pi", "agent") : undefined)

  return {
    available: true,
    source: direct ? "path" : "gui-path",
    command: {
      executable: resolved.path,
      args: [],
      env: {
        ...env,
        PATH: augmentedPath,
        ...(piAgentDir ? { PI_CODING_AGENT_DIR: piAgentDir } : {}),
      },
    },
  }
}
