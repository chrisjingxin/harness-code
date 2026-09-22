/** 校验源码化 npm 发布工件、workspace 链路与 OpenTUI 跨平台原生包。 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

export const VENDORED_PACKAGE_SPECS = [
  { name: "@opentui/core", version: "0.4.3", path: "third_party/npm/@opentui/core" },
  { name: "@opentui/react", version: "0.4.3", path: "third_party/npm/@opentui/react" },
  { name: "@opentui/core-win32-x64", version: "0.4.3", path: "third_party/npm/@opentui/core-win32-x64" },
  { name: "bun-ffi-structs", version: "0.2.4", path: "third_party/npm/bun-ffi-structs" },
  { name: "react-devtools-core", version: "7.0.1", path: "third_party/npm/react-devtools-core" },
]

export const VENDORED_PACKAGE_CONSUMERS = {
  "@opentui/core": ["packages/cli", "third_party/npm/@opentui/react"],
  "@opentui/react": ["packages/cli"],
  "@opentui/core-win32-x64": ["third_party/npm/@opentui/core"],
  "bun-ffi-structs": ["third_party/npm/@opentui/core"],
  "react-devtools-core": ["packages/cli", "third_party/npm/@opentui/react"],
}

export const OPENTUI_NATIVE_PACKAGE_SPECS = [
  { platform: "darwin", arch: "x64", name: "@opentui/core-darwin-x64", version: "0.4.3", extension: ".dylib" },
  { platform: "darwin", arch: "arm64", name: "@opentui/core-darwin-arm64", version: "0.4.3", extension: ".dylib" },
  { platform: "win32", arch: "x64", name: "@opentui/core-win32-x64", version: "0.4.3", extension: ".dll" },
  { platform: "win32", arch: "arm64", name: "@opentui/core-win32-arm64", version: "0.4.3", extension: ".dll" },
  { platform: "linux", arch: "x64", libc: "glibc", name: "@opentui/core-linux-x64", version: "0.4.3", extension: ".so" },
  { platform: "linux", arch: "arm64", libc: "glibc", name: "@opentui/core-linux-arm64", version: "0.4.3", extension: ".so" },
  { platform: "linux", arch: "x64", libc: "musl", name: "@opentui/core-linux-x64-musl", version: "0.4.3", extension: ".so" },
  { platform: "linux", arch: "arm64", libc: "musl", name: "@opentui/core-linux-arm64-musl", version: "0.4.3", extension: ".so" },
]

export function nativePackageSpec(platform, arch, linuxLibc) {
  const libc = platform === "linux" ? (linuxLibc === "musl" ? "musl" : "glibc") : undefined
  return OPENTUI_NATIVE_PACKAGE_SPECS.find((spec) =>
    spec.platform === platform && spec.arch === arch && spec.libc === libc)
}

/** 校验当前执行平台是否被 OpenTUI 0.4.3 原生包支持。 */
export function validateExecutionPlatform(platform = process.platform, arch = process.arch, linuxLibc = process.env.OPENTUI_LIBC) {
  if (platform === "linux" && ![undefined, "", "glibc", "musl"].includes(linuxLibc)) {
    return [`Linux 的 OPENTUI_LIBC 只允许为空、glibc 或 musl，当前为 ${linuxLibc}`]
  }
  if (nativePackageSpec(platform, arch, linuxLibc)) return []
  return [`OpenTUI 0.4.3 不支持当前依赖同步平台 ${platform}/${arch}`]
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return undefined
  }
}

/** 校验源码快照：5个包目录与基本清单存在、Windows DLL 存在且非空、root workspaces 包含 vendor 路径。 */
export function validateVendoredSourceSnapshot(root) {
  const issues = []
  const rootManifest = readJson(resolve(root, "package.json"))
  const workspaces = rootManifest?.workspaces
  if (!Array.isArray(workspaces) || !workspaces.includes("third_party/npm/*") || !workspaces.includes("third_party/npm/@opentui/*")) {
    issues.push("root workspaces must include third_party/npm/* and third_party/npm/@opentui/*")
  }

  for (const spec of VENDORED_PACKAGE_SPECS) {
    const pkgDir = resolve(root, spec.path)
    const manifest = readJson(join(pkgDir, "package.json"))
    if (!manifest) {
      issues.push(`${spec.name}: missing or invalid package.json in ${spec.path}`)
      continue
    }
    if (manifest.name !== spec.name || manifest.version !== spec.version) {
      issues.push(`${spec.name}: package identity mismatch in ${spec.path}`)
    }
    if (spec.name === "@opentui/core-win32-x64") {
      const dll = join(pkgDir, "opentui.dll")
      if (!existsSync(dll) || statSync(dll).size === 0) {
        issues.push(`${spec.name}: missing non-empty opentui.dll`)
      }
    }
  }
  return issues
}

/** 校验 package-lock.json：5 个源码包必须是 workspace link。 */
export function validateLock(root, nativeSpecs = []) {
  const lock = readJson(resolve(root, "package-lock.json"))
  if (!lock?.packages) return [] // 允许在锁未生成或更新锁前跳过
  const issues = []

  for (const spec of VENDORED_PACKAGE_SPECS) {
    const entry = lock.packages[`node_modules/${spec.name}`]
    if (!entry) {
      issues.push(`${spec.name}: missing in npm lockfile`)
      continue
    }
    const resolved = typeof entry.resolved === "string" ? entry.resolved.split("\\").join("/") : ""
    if (entry.link !== true || resolved !== spec.path) {
      issues.push(`${spec.name}: must be a workspace link in npm lockfile`)
    }
  }

  for (const nativeSpec of nativeSpecs) {
    if (nativeSpec.name === "@opentui/core-win32-x64") continue
    const entry = lock.packages[`node_modules/${nativeSpec.name}`]
    if (!entry) {
      issues.push(`${nativeSpec.name}: missing native optional package in npm lockfile`)
    }
  }
  return issues
}

/** 本机安装输入校验：源码快照 + 平台支持 + 本机 native lock 存在。 */
export function validateVendoredInstallInputs(
  root,
  platform = process.platform,
  arch = process.arch,
  linuxLibc = process.env.OPENTUI_LIBC,
) {
  const platformIssues = validateExecutionPlatform(platform, arch, linuxLibc)
  const currentNative = nativePackageSpec(platform, arch, linuxLibc)
  return [
    ...validateVendoredSourceSnapshot(root),
    ...platformIssues,
    ...(currentNative ? validateLock(root, [currentNative]) : []),
  ]
}

/** 审计校验（兼容既有接口）。 */
export function validateVendoredWorkspace(root) {
  return [
    ...validateVendoredSourceSnapshot(root),
    ...validateLock(root, OPENTUI_NATIVE_PACKAGE_SPECS),
  ]
}

/** 判断 node_modules 中是否已建立 vendored workspace 软链。 */
export function hasInstalledVendoredWorkspace(root) {
  return VENDORED_PACKAGE_SPECS.some((spec) => existsSync(resolve(root, "node_modules", spec.name)))
}

/** 校验安装后 node_modules 中的软链是否正确指向 third_party/npm。 */
export function validateInstalledVendoredWorkspace(root, requireInstalled = false) {
  if (!hasInstalledVendoredWorkspace(root)) {
    return requireInstalled ? ["安装后未找到五个源码化 npm 包的 node_modules 解析入口"] : []
  }

  const issues = []
  for (const spec of VENDORED_PACKAGE_SPECS) {
    const linkPath = resolve(root, "node_modules", spec.name)
    if (!existsSync(linkPath)) {
      issues.push(`${spec.name}: missing node_modules link`)
      continue
    }
    try {
      const actualTarget = realpathSync(linkPath)
      const expectedTarget = realpathSync(resolve(root, spec.path))
      if (actualTarget !== expectedTarget) {
        issues.push(`${spec.name}: installed link resolves to ${actualTarget}, expected ${expectedTarget}`)
      }
    } catch (err) {
      issues.push(`${spec.name}: failed to resolve realpath: ${err.message}`)
    }
  }
  return issues
}

/** 校验安装后当前平台的 OpenTUI 原生二进制包。 */
export function validateInstalledOpenTuiNativePackage(
  root,
  platform = process.platform,
  arch = process.arch,
  linuxLibc = process.env.OPENTUI_LIBC,
  requireInstalled = false,
) {
  const platformIssues = validateExecutionPlatform(platform, arch, linuxLibc)
  if (platformIssues.length > 0) return platformIssues

  const spec = nativePackageSpec(platform, arch, linuxLibc)
  const targetDir = resolve(root, "node_modules", spec.name)
  const installedExists = existsSync(targetDir)
  if (!installedExists) {
    return requireInstalled || existsSync(resolve(root, "node_modules"))
      ? [`${spec.name}: installed native package missing in node_modules`]
      : []
  }

  try {
    const files = readdirSync(targetDir)
    const hasLib = files.some((file) => file.endsWith(spec.extension) && statSync(join(targetDir, file)).size > 0)
    if (!hasLib) {
      return [`${spec.name}: installed native package missing non-empty ${spec.extension} library`]
    }
  } catch (err) {
    return [`${spec.name}: failed to read native package directory: ${err.message}`]
  }

  return []
}
