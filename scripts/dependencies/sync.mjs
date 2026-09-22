#!/usr/bin/env node
/** 依赖同步入口：默认冻结安装，显式模式更新锁文件后完成同一套验证。 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DependencyPreflightError,
  resolveInternalSources,
  validateLockSources,
  validateToolchainVersions,
} from "./source_policy.mjs"
import {
  validateExecutionPlatform,
  validateInstalledOpenTuiNativePackage,
  validateInstalledVendoredWorkspace,
  validateVendoredInstallInputs,
  validateVendoredSourceSnapshot,
} from "./vendor_policy.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const agent = resolve(root, "packages/agent")
const environment = process.env.UV_PROJECT_ENVIRONMENT
  ? resolve(agent, process.env.UV_PROJECT_ENVIRONMENT)
  : resolve(agent, ".venv")
const uv = process.env.UV_BIN ?? "uv"
const pythonCommand = process.env.HARNESS_PYTHON ?? (process.platform === "win32" ? "python" : "python3")

/** Windows 的 npm 是 cmd 脚本，无法被直接 spawn，必须经由 cmd 解析。 */
function npmCommand(args) {
  return process.platform === "win32" ? ["cmd", "/c", "npm", ...args] : ["npm", ...args]
}

function capture(command, cwd) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: process.env,
    encoding: "utf8",
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  }
}

function run(command, cwd, env) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  })
  if (result.error) {
    throw new Error(`无法启动命令 ${command[0]}：${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`命令失败（${result.status ?? "unknown"}）：${command.join(" ")}`)
  }
}

function versionFromOutput(tool, result) {
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "无输出"
    throw new DependencyPreflightError([`${tool} 不可用：${detail}`])
  }
  const match = result.stdout.match(/\d+\.\d+(?:\.\d+)?/)
  if (!match) throw new DependencyPreflightError([`无法从 ${tool} 输出解析版本：${result.stdout.trim()}`])
  return match[0]
}

function configuredValue(result) {
  if (result.exitCode !== 0) return undefined
  const value = result.stdout.trim()
  return value && value !== "undefined" && value !== "null" ? value : undefined
}

function modeFromArgs() {
  const args = process.argv.slice(2)
  if (args.length === 0) return "frozen"
  if (args.length === 1 && args[0] === "--update-lock") return "update-lock"
  throw new DependencyPreflightError(["用法：npm run deps:sync（冻结同步）或 npm run deps:sync -- --update-lock（更新锁文件后同步）"])
}

function preflight(mode) {
  const platformIssues = validateExecutionPlatform()
  if (platformIssues.length > 0) throw new DependencyPreflightError(platformIssues)
  const npmVersion = versionFromOutput("npm", capture(npmCommand(["--version"]), root))
  const nodeVersion = process.versions.node
  const uvVersion = versionFromOutput(uv, capture([uv, "--version"], root))
  const pythonVersion = versionFromOutput(pythonCommand, capture([pythonCommand, "--version"], root))
  const toolchainIssues = validateToolchainVersions({
    npm: npmVersion,
    node: nodeVersion,
    uv: uvVersion,
    python: pythonVersion,
  })
  if (toolchainIssues.length > 0) throw new DependencyPreflightError(toolchainIssues)
  const sources = resolveInternalSources(process.env, {
    npmRegistry: configuredValue(capture(npmCommand(["config", "get", "registry"]), root)),
    pythonIndex: configuredValue(capture([pythonCommand, "-m", "pip", "config", "get", "global.index-url"], root)),
  })

  if (mode === "frozen") {
    const lockIssues = validateLockSources(root)
    if (lockIssues.length > 0) {
      throw new DependencyPreflightError([
        ...lockIssues,
        "当前锁文件缺失；请执行 `npm run deps:sync -- --update-lock` 重新解析。",
      ])
    }
  }
  const vendorIssues = mode === "update-lock"
    ? validateVendoredSourceSnapshot(root)
    : validateVendoredInstallInputs(root)
  if (vendorIssues.length > 0) {
    throw new DependencyPreflightError([
      ...vendorIssues,
      "五个目标 npm 包必须保持必需文件与 workspace 依赖边，冻结同步还必须保持本机 lock 解析",
    ])
  }
  return { sources }
}

function validateInstalledVendorOrThrow() {
  const issues = [
    ...validateVendoredInstallInputs(root),
    ...validateInstalledVendoredWorkspace(root, true),
    ...validateInstalledOpenTuiNativePackage(root, process.platform, process.arch, process.env.OPENTUI_LIBC, true),
  ]
  if (issues.length > 0) {
    throw new DependencyPreflightError([
      ...issues,
      "npm 安装完成后五个目标包必须实际解析到 third_party/npm，且当前平台 OpenTUI 原生包必须完整可用",
    ])
  }
}

function pythonPath() {
  const candidates = process.platform === "win32"
    ? [resolve(environment, "Scripts/python.exe")]
    : [resolve(environment, "bin/python")]
  const selected = candidates.find(existsSync)
  if (!selected) throw new Error("uv sync 后未找到 packages/agent/.venv 中的 Python")
  return selected
}

try {
  const mode = modeFromArgs()
  const { sources } = preflight(mode)
  const sourceEnv = {
    HARNESS_NPM_REGISTRY: sources.npmRegistry.toString(),
    HARNESS_PYPI_INDEX: sources.pythonIndex.toString(),
    npm_config_registry: sources.npmRegistry.toString(),
    PIP_INDEX_URL: sources.pythonIndex.toString(),
    UV_DEFAULT_INDEX: sources.pythonIndex.toString(),
    UV_INDEX_URL: sources.pythonIndex.toString(),
  }

  if (mode === "update-lock") {
    // 只改锁、不安装、不跑生命周期脚本。真正安装留给下面唯一的一次 npm ci。
    run(npmCommand(["install", "--package-lock-only", "--ignore-scripts", "--registry", sources.npmRegistry.toString()]), root, sourceEnv)
    const updatedLockIssues = validateVendoredInstallInputs(root)
    if (updatedLockIssues.length > 0) {
      throw new DependencyPreflightError([
        ...updatedLockIssues,
        "更新后的锁必须保持五个目标包的 workspace 解析和当前平台原生包记录",
      ])
    }
    run([uv, "lock", "--refresh", "--default-index", sources.pythonIndex.toString(), "--no-python-downloads"], agent, sourceEnv)
    const lockIssues = validateLockSources(root)
    if (lockIssues.length > 0) throw new DependencyPreflightError(lockIssues)
  }

  // npm ci 等价于冻结安装：lock 与 package.json 不一致即失败，不会改写 lock。
  // peer 策略由根目录 .npmrc 的 legacy-peer-deps 承担。
  run(npmCommand(["ci", "--registry", sources.npmRegistry.toString()]), root, sourceEnv)
  validateInstalledVendorOrThrow()
  run(
    [
      uv,
      "sync",
      "--extra",
      "test",
      "--locked",
      "--no-python-downloads",
      "--link-mode",
      "copy",
      "--default-index",
      sources.pythonIndex.toString(),
    ],
    agent,
    { ...sourceEnv, UV_LINK_MODE: "copy", UV_PROJECT_ENVIRONMENT: environment },
  )
  run([pythonPath(), resolve(root, "scripts/dependencies/apply_deepagents_patch.py")], root)
  run([pythonPath(), resolve(root, "scripts/dependencies/check_dependencies.py")], root)
  run([pythonPath(), resolve(root, "scripts/dependencies/runtime_smoke.py")], root)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
