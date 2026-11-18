/**
 * Qwen Code (`qwen --acp`) 可执行入口探测与 GUI PATH 增强。
 *
 * 【功能定义】结合桌面常见 CLI 目录（`~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、
 * `dirname(process.execPath)`）定位本机 `qwen` CLI，并以 `["--acp"]` 参数数组安全启动。
 * 【协作边界】只检查文件与执行权限，绝不使用 shell 拼接命令。
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

function findInPath(names: readonly string[], pathValue: string): string | undefined {
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

/** 探测本机 `qwen` CLI，返回以 `qwen --acp` 启动的命令配置。 */
export function resolveQwenCommand(
  env: NodeJS.ProcessEnv = process.env,
  options: LocalAcpProviderDiscoveryOptions = {},
): LocalAcpProviderResolution {
  const isWin = process.platform === "win32"
  const names = isWin ? ["qwen.cmd", "qwen.exe", "qwen"] : ["qwen"]
  const direct = findInPath(names, env.PATH ?? "")
  const augmentedPath = buildAugmentedGuiPath(env, options)
  const executable = direct ?? findInPath(names, augmentedPath)
  if (!executable) {
    return {
      available: false,
      reason: "未检测到 qwen 可执行文件（已检索 PATH 与 ~/.local/bin、/opt/homebrew/bin、/usr/local/bin）。",
    }
  }

  return {
    available: true,
    source: direct ? "path" : "gui-path",
    command: {
      executable,
      args: ["--acp"],
      env: { ...env, PATH: augmentedPath },
    },
  }
}
