/**
 * 【功能定义】通用 ACP 进程可执行入口与 GUI 环境 PATH 探测公共工具。
 * 【协作边界】只检查文件与执行权限，绝不通过 shell 拼接命令；零特定 Agent 硬编码。
 */
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import type { AcpAgentDiscoveryOptions } from "./descriptor.js"

/** 校验候选路径为绝对路径且具备可执行权限（非目录）。 */
export function isExecutableFile(candidate: string): boolean {
  if (!isAbsolute(candidate)) return false
  try {
    if (!statSync(candidate).isFile()) return false
    if (process.platform !== "win32") accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 从指定路径向上枚举至多 `depth` 层祖先目录（用于探测仓库根与环境变量目录）。 */
export function ancestorDirs(start: string, depth = 7): string[] {
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

/**
 * 若当前目录位于 Git 关联 worktree 内（`.git` 为指向主仓库 `.git/worktrees/<name>` 的文本文件），
 * 解析并返回主仓库根目录，以便 worktree 环境也能复用主仓库下已准备的虚拟环境或本地工具。
 */
export function resolveGitMainWorktreeRoot(startDir: string): string | undefined {
  for (const dir of ancestorDirs(startDir)) {
    const dotGit = join(dir, ".git")
    try {
      if (!existsSync(dotGit) || !statSync(dotGit).isFile()) continue
      const content = readFileSync(dotGit, "utf8").slice(0, 2048)
      const match = /^gitdir:\s*(.+)$/m.exec(content)
      if (!match?.[1]) continue
      const rawGitDir = match[1].trim()
      const gitDir = isAbsolute(rawGitDir) ? resolve(rawGitDir) : resolve(dir, rawGitDir)
      const commonDirFile = join(gitDir, "commondir")
      if (existsSync(commonDirFile)) {
        const commonRel = readFileSync(commonDirFile, "utf8").trim()
        if (commonRel) {
          const commonGitDir = isAbsolute(commonRel) ? resolve(commonRel) : resolve(gitDir, commonRel)
          return dirname(commonGitDir)
        }
      }
      if (basename(dirname(gitDir)) === "worktrees" && basename(dirname(dirname(gitDir))) === ".git") {
        return dirname(dirname(dirname(gitDir)))
      }
    } catch {
      continue
    }
  }
  return undefined
}

function resolveSafeHome(env: Readonly<Record<string, string | undefined>>, override?: string): string {
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
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: AcpAgentDiscoveryOptions = {},
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

/** 按给定候选可执行文件名在 PATH 列表中按顺序查找首个可执行文件并规范化路径。 */
export function findInPath(names: readonly string[], pathValue?: string): string | undefined {
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
