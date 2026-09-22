/** 依赖安装的源与工具链前置校验。 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"

export const MIN_UV_VERSION = "0.11.1"
export const MIN_NPM_VERSION = "10.0.0"
export const MIN_NODE_VERSION = "20.0.0"
export const PYTHON_MIN_VERSION = "3.11.0"
export const PYTHON_MAX_VERSION = "4.0.0"

const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/"
const PUBLIC_PYPI_INDEX = "https://pypi.org/simple"

export class DependencyPreflightError extends Error {
  constructor(issues) {
    super(["依赖前置检查失败：", ...issues.map((issue) => `- ${issue}`)].join("\n"))
    this.name = "DependencyPreflightError"
    this.issues = issues
  }
}

function parsePackageSourceUrl(raw, label) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return `${label} 不是合法 URL`
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `${label} 必须使用 http 或 https`
  }
  return url
}

function selectPackageSource(values, label) {
  for (const raw of values) {
    if (!raw?.trim()) continue
    const parsed = parsePackageSourceUrl(raw.trim(), label)
    if (parsed instanceof URL) return parsed
  }
  return undefined
}

export function resolveInternalSources(environment = process.env, configuredSources = {}) {
  const issues = []
  let npmValue = selectPackageSource(
    [
      configuredSources.npmRegistry,
      environment.npm_config_registry,
      environment.NPM_CONFIG_REGISTRY,
      environment.HARNESS_NPM_REGISTRY,
    ],
    "npm registry",
  ) ?? new URL(PUBLIC_NPM_REGISTRY)

  let pythonValue = selectPackageSource(
    [
      environment.PIP_INDEX_URL,
      configuredSources.pythonIndex,
      environment.UV_DEFAULT_INDEX,
      environment.UV_INDEX_URL,
      environment.HARNESS_PYPI_INDEX,
    ],
    "Python index",
  ) ?? new URL(PUBLIC_PYPI_INDEX)

  return { npmRegistry: npmValue, pythonIndex: pythonValue }
}

export function validateNpmLockSource(lockPath) {
  if (!existsSync(lockPath)) return [`找不到 npm 锁文件 ${lockPath}`]
  return []
}

export function validateUvLockSource(lockPath) {
  if (!existsSync(lockPath)) return [`找不到 uv 锁文件 ${lockPath}`]
  return []
}

export function validateLockSources(root) {
  return [
    ...validateNpmLockSource(resolve(root, "package-lock.json")),
    ...validateUvLockSource(resolve(root, "packages/agent/uv.lock")),
  ]
}

function parseVersion(value) {
  const match = value.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  if (!leftParts || !rightParts) return undefined
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1
  }
  return 0
}

export function validateToolchainVersions(versions) {
  const issues = []
  if (versions.npm !== undefined) {
    if (!parseVersion(versions.npm) || (compareVersions(versions.npm, MIN_NPM_VERSION) ?? -1) < 0) {
      issues.push(`npm 版本为 ${versions.npm}，至少需要 ${MIN_NPM_VERSION}`)
    }
  }
  if (versions.node !== undefined) {
    if (!parseVersion(versions.node) || (compareVersions(versions.node, MIN_NODE_VERSION) ?? -1) < 0) {
      issues.push(`node 版本为 ${versions.node}，至少需要 ${MIN_NODE_VERSION}`)
    }
  }
  if (versions.uv !== undefined) {
    if (!parseVersion(versions.uv) || (compareVersions(versions.uv, MIN_UV_VERSION) ?? -1) < 0) {
      issues.push(`uv 版本为 ${versions.uv}，至少需要 ${MIN_UV_VERSION}`)
    }
  }
  if (versions.python !== undefined) {
    const python = parseVersion(versions.python)
    if (!python) {
      issues.push(`无法解析 Python 版本 ${versions.python}`)
    } else {
      const pythonText = python.join(".")
      if ((compareVersions(pythonText, PYTHON_MIN_VERSION) ?? -1) < 0 || (compareVersions(pythonText, PYTHON_MAX_VERSION) ?? 1) >= 0) {
        issues.push(`Python 版本为 ${versions.python}，要求 >=${PYTHON_MIN_VERSION}, <${PYTHON_MAX_VERSION}`)
      }
    }
  }
  return issues
}
