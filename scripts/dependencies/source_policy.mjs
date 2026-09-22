/** 依赖安装的源、锁文件和工具链前置校验。公网与内网都合法，由本机配置决定。 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export const MIN_UV_VERSION = "0.11.1"
export const MIN_NPM_VERSION = "10.0.0"
export const MIN_NODE_VERSION = "20.0.0"
export const PYTHON_MIN_VERSION = "3.11.0"
export const PYTHON_MAX_VERSION = "4.0.0"

const PUBLIC_PACKAGE_HOSTS = [
  "files.pythonhosted.org",
  "github.com",
  "jsdelivr.net",
  "npmjs.org",
  "pypi.org",
  "pythonhosted.org",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "unpkg.com",
]

const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/"
const PUBLIC_PYPI_INDEX = "https://pypi.org/simple"

export class DependencyPreflightError extends Error {
  constructor(issues) {
    super(["依赖前置检查失败：", ...issues.map((issue) => `- ${issue}`)].join("\n"))
    this.name = "DependencyPreflightError"
    this.issues = issues
  }
}

function nonEmpty(...values) {
  return values.find((value) => value?.trim())?.trim()
}

function isPublicHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "")
  return PUBLIC_PACKAGE_HOSTS.some((publicHost) => normalized === publicHost || normalized.endsWith(`.${publicHost}`))
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
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    return `${label} 不得包含凭据/query/hash，且必须包含主机名`
  }
  return url
}

/** 工具配置优先。配置仍指向公网时，后面的内网候选（通常是 HARNESS_*）才接管。 */
function selectPackageSource(values, label) {
  let publicSource
  let firstIssue
  for (const raw of values) {
    if (!raw?.trim()) continue
    const parsed = parsePackageSourceUrl(raw.trim(), label)
    if (!(parsed instanceof URL)) {
      firstIssue ??= parsed
      continue
    }
    if (!isPublicHost(parsed.hostname)) return parsed
    publicSource ??= parsed
  }
  return publicSource ?? firstIssue
}

function hostFromValue(value) {
  const candidate = value.includes("://") ? value : `https://${value}`
  try {
    const url = new URL(candidate)
    return url.hostname.toLowerCase().replace(/\.$/, "") || undefined
  } catch {
    return undefined
  }
}

function collectUrls(text) {
  return (text.match(/https?:\/\/[^\s"'`<>]+/g) ?? []).map((value) => value.replace(/[),\]}]+$/, ""))
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

/** 读取 packageManager 声明的 npm 基准版本；安装器必须是 npm 而不是 Bun。 */
export function expectedNpmVersion(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"))
  if (typeof manifest.packageManager !== "string" || !manifest.packageManager.startsWith("npm@")) {
    throw new DependencyPreflightError(["package.json 缺少 npm@<version> 的 packageManager 约束"])
  }
  return manifest.packageManager.slice("npm@".length)
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
  )
  let pythonValue = selectPackageSource(
    [
      environment.PIP_INDEX_URL,
      configuredSources.pythonIndex,
      environment.UV_DEFAULT_INDEX,
      environment.UV_INDEX_URL,
      environment.HARNESS_PYPI_INDEX,
    ],
    "Python index",
  )
  // 两边都没指定，或一边已是公网而另一边空着：补上对应的公网默认源。
  // 一边已经是内网时不把另一边默认为公网，避免同一次安装混用两套来源。
  if (npmValue === undefined && !(pythonValue instanceof URL && !isPublicHost(pythonValue.hostname))) {
    npmValue = new URL(PUBLIC_NPM_REGISTRY)
  }
  if (pythonValue === undefined && !(npmValue instanceof URL && !isPublicHost(npmValue.hostname))) {
    pythonValue = new URL(PUBLIC_PYPI_INDEX)
  }
  if (typeof npmValue === "string") issues.push(npmValue)
  else if (npmValue === undefined) issues.push("npm 未配置内网 registry；请先执行 npm config set registry <内网地址>，或设置 HARNESS_NPM_REGISTRY")
  if (typeof pythonValue === "string") issues.push(pythonValue)
  else if (pythonValue === undefined) issues.push("pip/uv 未配置可用的内网 index；请先配置 pip global.index-url，或设置 HARNESS_PYPI_INDEX 备用值")
  if (issues.length > 0) throw new DependencyPreflightError(issues)

  const artifactHosts = new Set([pythonValue.hostname.toLowerCase().replace(/\.$/, "")])
  if (isPublicHost(pythonValue.hostname)) {
    artifactHosts.add("pypi.org")
    artifactHosts.add("files.pythonhosted.org")
  }
  const configuredArtifactHosts = nonEmpty(environment.HARNESS_PYPI_ARTIFACT_HOSTS)
  if (configuredArtifactHosts) {
    for (const rawHost of configuredArtifactHosts.split(",")) {
      const hostname = hostFromValue(rawHost.trim())
      if (!hostname) {
        issues.push(`HARNESS_PYPI_ARTIFACT_HOSTS 含无效主机 ${rawHost.trim()}`)
      } else if (isPublicHost(hostname)) {
        issues.push(`HARNESS_PYPI_ARTIFACT_HOSTS 指向公网主机 ${hostname}`)
      } else {
        artifactHosts.add(hostname)
      }
    }
  }
  for (const key of ["UV_INDEX", "UV_EXTRA_INDEX_URL", "PIP_EXTRA_INDEX_URL"]) {
    const configured = nonEmpty(environment[key])
    if (!configured) continue
    const urls = collectUrls(configured)
    if (urls.length === 0) {
      issues.push(`${key} 未包含可验证的 http(s) URL`)
      continue
    }
    for (const url of urls) {
      const issue = validateUrlHost(url, `${key} 配置`, artifactHosts)
      if (issue) issues.push(issue)
    }
  }
  if (issues.length > 0) throw new DependencyPreflightError(issues)
  return { npmRegistry: npmValue, pythonIndex: pythonValue, pythonArtifactHosts: artifactHosts }
}

function validateUrlHost(raw, label, allowedHosts) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return `${label} 含无效 URL ${raw}`
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `${label} 必须使用 http 或 https`
  }
  if (url.username || url.password || url.search || url.hash) {
    return `${label} 不得包含凭据/query/hash`
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
  if (allowedHosts.has(hostname)) return undefined
  if (isPublicHost(hostname)) return `${label} 仍指向公网包源 ${hostname}`
  return `${label} 主机 ${hostname} 与当前源不一致`
}

export function validateNpmLockSource(lockPath, sources) {
  let text
  try {
    text = readFileSync(lockPath, "utf-8")
  } catch {
    return [`找不到 npm 锁文件 ${lockPath}`]
  }
  let lock
  try {
    lock = JSON.parse(text)
  } catch {
    return [`npm 锁文件 ${lockPath} 不是合法 JSON`]
  }
  const allowedHosts = new Set([sources.npmRegistry.hostname.toLowerCase().replace(/\.$/, "")])
  // 只核对下载地址。funding、仓库主页这类链接不是包源，不能把公网开发锁文件判失败。
  const resolvedUrls = Object.values(lock.packages ?? {})
    .map((entry) => entry?.resolved)
    .filter((value) => typeof value === "string" && /^https?:\/\//.test(value))
  return [...new Set(
    resolvedUrls
      .map((url) => validateUrlHost(url, `npm 锁文件 ${lockPath}`, allowedHosts))
      .filter(Boolean),
  )]
}

export function validateUvLockSource(lockPath, sources) {
  let text
  try {
    text = readFileSync(lockPath, "utf-8")
  } catch {
    return [`找不到 uv 锁文件 ${lockPath}`]
  }
  const issues = []
  const allowedHosts = sources.pythonArtifactHosts
  const registryUrls = [...text.matchAll(/source\s*=\s*\{\s*registry\s*=\s*"([^"]+)"/g)].map((match) => match[1])
  if (registryUrls.length === 0) issues.push(`uv 锁文件 ${lockPath} 没有可验证的 registry 来源`)
  for (const url of registryUrls) {
    const issue = validateUrlHost(url, `uv 锁文件 registry ${lockPath}`, allowedHosts)
    if (issue) issues.push(issue)
  }
  const artifactUrls = collectUrls(text)
  if (artifactUrls.length === 0) issues.push(`uv 锁文件 ${lockPath} 没有可验证的制品地址`)
  for (const url of artifactUrls) {
    const issue = validateUrlHost(url, `uv 锁文件制品 ${lockPath}`, allowedHosts)
    if (issue) issues.push(issue)
  }
  return [...new Set(issues)]
}

export function validateLockSources(root, sources) {
  return [
    ...validateNpmLockSource(resolve(root, "package-lock.json"), sources),
    ...validateUvLockSource(resolve(root, "packages/agent/uv.lock"), sources),
  ]
}

export function validateToolchainVersions(versions) {
  const issues = []
  if (versions.npm !== undefined) {
    if (!parseVersion(versions.npm)) {
      issues.push(`无法解析 npm 版本 ${versions.npm}`)
    } else if ((compareVersions(versions.npm, MIN_NPM_VERSION) ?? -1) < 0) {
      issues.push(`npm 版本为 ${versions.npm}，至少需要 ${MIN_NPM_VERSION}`)
    }
  }
  if (versions.node !== undefined) {
    if (!parseVersion(versions.node)) {
      issues.push(`无法解析 node 版本 ${versions.node}`)
    } else if ((compareVersions(versions.node, MIN_NODE_VERSION) ?? -1) < 0) {
      issues.push(`node 版本为 ${versions.node}，至少需要 ${MIN_NODE_VERSION}`)
    }
  }
  if (!parseVersion(versions.uv)) {
    issues.push(`无法解析 uv 版本 ${versions.uv}`)
  } else if ((compareVersions(versions.uv, MIN_UV_VERSION) ?? -1) < 0) {
    issues.push(`uv 版本为 ${versions.uv}，至少需要 ${MIN_UV_VERSION}`)
  }
  const python = parseVersion(versions.python)
  if (!python) {
    issues.push(`无法解析 Python 版本 ${versions.python}`)
  } else {
    const pythonText = python.join(".")
    if ((compareVersions(pythonText, PYTHON_MIN_VERSION) ?? -1) < 0 || (compareVersions(pythonText, PYTHON_MAX_VERSION) ?? 1) >= 0) {
      issues.push(`Python 版本为 ${versions.python}，要求 >=${PYTHON_MIN_VERSION}, <${PYTHON_MAX_VERSION}`)
    }
  }
  return issues
}
