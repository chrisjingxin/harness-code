/** 安装形态与开发形态下定位 Python sidecar 进程。 */
import { existsSync, realpathSync } from "node:fs"
import { basename, delimiter, dirname, resolve } from "node:path"

/** 传给 sidecar 的内部安装根；用户环境和 TOML 不能覆盖 CLI 写入的值。 */
export const CLI_INSTALL_ROOT_ENV = "HARNESS_CLI_INSTALL_ROOT"

/** spawn sidecar 所需的可执行文件 argv，以及仅开发形态注入的源码 PYTHONPATH。 */
export type AgentProcessBinding = {
  argv: readonly [string, ...string[]]
  pythonPath?: string
}

/** 解析内核进程时允许替换的文件系统探测，便于夹具测试。 */
export type AgentProcessBindingLookup = {
  moduleDir: string
  env: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

const MISSING_AGENT = "未找到 Harness 内核。请运行安装器或设置 HARNESS_AGENT_PYTHON。"

/** 解析源码入口和编译后 dist 入口都能使用的 Agent 源码目录与开发 venv。 */
export function resolveAgentRuntimeLocations(moduleDir: string): {
  agentDirectories: readonly string[]
  pythonExecutables: readonly string[]
} {
  const agentDirectories = [...new Set([
    resolve(moduleDir, "../../agent"),
    resolve(moduleDir, "../../../packages/agent"),
  ])]
  return {
    agentDirectories,
    pythonExecutables: agentDirectories.flatMap(directory => [
      resolve(directory, ".venv/bin/python"),
      resolve(directory, ".venv/Scripts/python.exe"),
    ]),
  }
}

/**
 * 按安装器 / 开发覆盖顺序解析 sidecar：
 * `HARNESS_AGENT_PYTHON` → PATH 上的 `harness-agent` → 仓库 `.venv`。
 * 找不到则失败关闭，不落到系统 `python3`。
 */
export function resolveAgentProcessBinding(lookup: AgentProcessBindingLookup): AgentProcessBinding {
  const exists = lookup.exists ?? existsSync
  const override = lookup.env.HARNESS_AGENT_PYTHON?.trim()
  if (override) {
    return { argv: [override, "-m", "harness_agent"] }
  }
  const installed = findHarnessAgentOnPath(lookup.env.PATH, exists)
  if (installed) {
    return { argv: [installed] }
  }
  const locations = resolveAgentRuntimeLocations(lookup.moduleDir)
  const python = locations.pythonExecutables.find(exists)
  const sourceAgent = locations.agentDirectories.find(exists)
  if (python && sourceAgent) {
    return { argv: [python, "-m", "harness_agent"], pythonPath: sourceAgent }
  }
  throw new Error(MISSING_AGENT)
}

/**
 * 从已加载 CLI 模块目录解析可信依赖根。
 * 开发形态回到仓库根；发布形态回到包含 node_modules 的安装前缀。
 */
export function resolveCliInstallRoot(moduleDir: string): string {
  const realModuleDir = realpathSync(moduleDir)
  const leaf = basename(realModuleDir)
  const packageRoot = leaf === "src" || leaf === "dist" ? dirname(realModuleDir) : realModuleDir
  const parent = dirname(packageRoot)
  if (basename(packageRoot) === "cli" && basename(parent) === "packages") return dirname(parent)
  if (basename(parent).startsWith("@") && basename(dirname(parent)) === "node_modules") {
    return dirname(dirname(parent))
  }
  if (basename(parent) === "node_modules") return dirname(parent)
  return packageRoot
}

/** 在 PATH 各目录中查找 `harness-agent` 或 Windows 的 `.exe`。 */
function findHarnessAgentOnPath(pathValue: string | undefined, exists: (path: string) => boolean): string | undefined {
  if (!pathValue) return undefined
  const names = process.platform === "win32"
    ? ["harness-agent.exe", "harness-agent"]
    : ["harness-agent", "harness-agent.exe"]
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    for (const name of names) {
      const candidate = resolve(directory, name)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}
