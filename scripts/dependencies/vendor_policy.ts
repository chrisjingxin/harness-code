/** 校验临时分支源码化 npm 发布工件、workspace 链路与 Windows x64 目标。 */

import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

export interface VendoredPackageSpec {
  name: string
  version: string
  path: string
  tarball: string
  integrity: string
  requiredFiles: readonly string[]
}

export const VENDORED_PACKAGE_SPECS: readonly VendoredPackageSpec[] = [
  {
    name: "@opentui/core",
    version: "0.4.3",
    path: "third_party/npm/@opentui/core",
    tarball: "https://registry.npmjs.org/@opentui/core/-/core-0.4.3.tgz",
    integrity: "sha512-rrJfAk13tALDqldYjhc78eWQ+aKq1iknJgffIOg3OwyZoqQo+p6gtuqyhmWvXIfQzlNUbpgpCPcxbXlhMnlaHQ==",
    requiredFiles: ["package.json", "index.js", "index.d.ts"],
  },
  {
    name: "@opentui/react",
    version: "0.4.3",
    path: "third_party/npm/@opentui/react",
    tarball: "https://registry.npmjs.org/@opentui/react/-/react-0.4.3.tgz",
    integrity: "sha512-HtC/+lMURaZlifiJNVsn84YqKMywXQmkeSNbUTlbbeS6YM6reahaacnZEYZdnEUgklO6+r/J1tG8UBhqO26X7Q==",
    requiredFiles: ["package.json", "index.js", "src/index.d.ts", "jsx-runtime.js", "jsx-runtime.d.ts"],
  },
  {
    name: "@opentui/core-win32-x64",
    version: "0.4.3",
    path: "third_party/npm/@opentui/core-win32-x64",
    tarball: "https://registry.npmjs.org/@opentui/core-win32-x64/-/core-win32-x64-0.4.3.tgz",
    integrity: "sha512-NuoqvWKGXaYnmlqvu7Gg2lLI6yVMnS9OfWBvxp+7Q+McSgHFSTQmYBXaPpvQ8HikpQXE1nCeMPtuSG4PdZHe2w==",
    requiredFiles: ["package.json", "index.js", "index.bun.js", "index.d.ts", "opentui.dll"],
  },
  {
    name: "bun-ffi-structs",
    version: "0.2.4",
    path: "third_party/npm/bun-ffi-structs",
    tarball: "https://registry.npmjs.org/bun-ffi-structs/-/bun-ffi-structs-0.2.4.tgz",
    integrity: "sha512-AJzsqoVFs1KBbJbWHIYrVZLDC3NhTqqh25awRXqzoLzmBAKr5oqk6+CwuYHAekKx+VBCYVohBoKuRq40dV+TYg==",
    requiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"],
  },
  {
    name: "react-devtools-core",
    version: "7.0.1",
    path: "third_party/npm/react-devtools-core",
    tarball: "https://registry.npmjs.org/react-devtools-core/-/react-devtools-core-7.0.1.tgz",
    integrity: "sha512-C3yNvRHaizlpiASzy7b9vbnBGLrhvdhl1CbdU6EnZgxPNbai60szdLtl+VL76UNOt5bOoVTOz5rNWZxgGt+Gsw==",
    requiredFiles: ["package.json", "backend.js", "standalone.js", "dist/backend.js", "dist/standalone.js"],
  },
]

/** 每个源码包在安装后必须能从这些真实消费者位置解析。 */
export const VENDORED_PACKAGE_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  "@opentui/core": ["packages/cli", "third_party/npm/@opentui/react"],
  "@opentui/react": ["packages/cli"],
  "@opentui/core-win32-x64": ["third_party/npm/@opentui/core"],
  "bun-ffi-structs": ["third_party/npm/@opentui/core"],
  "react-devtools-core": ["packages/cli", "third_party/npm/@opentui/react"],
}

const TARGET_PLATFORM = { os: "win32", cpu: "x64" } as const
const PATCH_SOURCE = "patches/react-devtools-core@7.0.1.patch"

type JsonRecord = Record<string, unknown>

/** 校验只允许在目标 Windows x64 环境执行依赖安装或重新解析。 */
export function validateExecutionPlatform(platform = process.platform, arch = process.arch): string[] {
  if (platform === TARGET_PLATFORM.os && arch === TARGET_PLATFORM.cpu) return []
  return [`依赖安装与重新解析仅允许在 ${TARGET_PLATFORM.os}/${TARGET_PLATFORM.cpu} 执行，当前为 ${platform}/${arch}`]
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown
  } catch {
    return undefined
  }
}

/** 计算 provenance 使用的无平台差异目录摘要。 */
export function directorySha256(directory: string): string {
  const entries: string[] = []

  function visit(current: string): void {
    for (const name of readdirSync(current).sort()) {
      // 安装器（Bun/npm）会在各 workspace 包下创建链接；它们是安装产物，
      // 不属于 npm tarball，不得影响目录摘要。
      if (name === "node_modules" || name === ".bun") continue
      const absolute = join(current, name)
      const relativePath = relative(directory, absolute).split("\\").join("/")
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) {
        entries.push(`${relativePath}\tsymlink:${readlinkSync(absolute)}\t0\n`)
      } else if (stats.isDirectory()) {
        visit(absolute)
      } else if (stats.isFile()) {
        const payload = readFileSync(absolute)
        entries.push(`${relativePath}\t${sha256Hex(payload)}\t${payload.byteLength}\n`)
      }
    }
  }

  visit(directory)
  return sha256Hex(entries.join(""))
}

export function sha256Hex(payload: Uint8Array | string): string {
  return createHash("sha256").update(payload).digest("hex")
}

function packageRoot(root: string, spec: VendoredPackageSpec): string {
  return resolve(root, spec.path)
}

function lockJson(path: string): JsonRecord | undefined {
  try {
    // package-lock.json 是严格 JSON；解析失败视为锁文件无效。
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function packageManifest(root: string, spec: VendoredPackageSpec): JsonRecord | undefined {
  const parsed = readJson(join(packageRoot(root, spec), "package.json"))
  return isRecord(parsed) ? parsed : undefined
}

function stringValue(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

function objectValue(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = record?.[key]
  return isRecord(value) ? value : undefined
}

/** npm 以精确版本链接 workspace；断言依赖声明精确锁定 vendored 版本。 */
function hasVendoredDependency(record: JsonRecord | undefined, key: string, version: string): boolean {
  return stringValue(record, key) === version
}

function manifestEntrypoints(manifest: JsonRecord): string[] {
  return ["main", "module", "types"]
    .map((field) => stringValue(manifest, field))
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/^\.\//, ""))
}

function requiredFiles(spec: VendoredPackageSpec, manifest: JsonRecord): string[] {
  return [...new Set([...spec.requiredFiles, ...manifestEntrypoints(manifest)])]
}

function validateRequiredFiles(directory: string, spec: VendoredPackageSpec, manifest: JsonRecord): string[] {
  const issues: string[] = []
  for (const requiredFile of requiredFiles(spec, manifest)) {
    const path = join(directory, requiredFile)
    try {
      if (!lstatSync(path).isFile()) issues.push(`${spec.name}: required file is not a regular file: ${requiredFile}`)
    } catch {
      issues.push(`${spec.name}: required file missing: ${requiredFile}`)
    }
  }
  return issues
}

function validatePackageFiles(root: string, spec: VendoredPackageSpec): string[] {
  const issues: string[] = []
  const directory = packageRoot(root, spec)
  const manifest = packageManifest(root, spec)
  if (!existsSync(directory)) {
    issues.push(`${spec.name}: missing vendored directory ${spec.path}`)
    return issues
  }
  if (!manifest) {
    issues.push(`${spec.name}: invalid or missing package.json`)
    return issues
  }
  if (stringValue(manifest, "name") !== spec.name) {
    issues.push(`${spec.name}: package name mismatch`)
  }
  if (stringValue(manifest, "version") !== spec.version) {
    issues.push(`${spec.name}: version mismatch; expected ${spec.version}`)
  }
  if (stringValue(manifest, "license") !== "MIT") {
    issues.push(`${spec.name}: license must be MIT`)
  }
  issues.push(...validateRequiredFiles(directory, spec, manifest))
  if (spec.name === "@opentui/core-win32-x64") {
    // npm 对带 os/cpu 的 workspace 成员在平台不符时直接 notsup，无法跨平台
    // 共用 lock；平台定位由 tarball provenance 与 DLL 门禁保障，清单必须
    // 移除平台声明。
    if (manifest.os !== undefined || manifest.cpu !== undefined) {
      issues.push(`${spec.name}: manifest must not declare os/cpu; platform targeting is proven by tarball provenance and the DLL gate`)
    }
    const dll = join(directory, "opentui.dll")
    if (!existsSync(dll) || !statSync(dll).isFile() || statSync(dll).size === 0) {
      issues.push(`${spec.name}: missing opentui.dll`)
    }
  }
  return issues
}

function validateProvenance(root: string): string[] {
  const issues: string[] = []
  const provenancePath = resolve(root, "third_party/npm/provenance.json")
  const provenance = readJson(provenancePath)
  if (!isRecord(provenance)) return [`missing or invalid provenance ${provenancePath}`]
  if (provenance.schemaVersion !== 1) issues.push("provenance schemaVersion must be 1")
  const target = objectValue(provenance, "target")
  if (target?.os !== TARGET_PLATFORM.os || target?.cpu !== TARGET_PLATFORM.cpu) {
    issues.push("provenance target must be win32/x64")
  }
  const packages = objectValue(provenance, "packages")
  if (!packages) return [...issues, "provenance packages must be an object"]

  for (const spec of VENDORED_PACKAGE_SPECS) {
    const entry = objectValue(packages, spec.name)
    if (!entry) {
      issues.push(`${spec.name}: missing provenance entry`)
      continue
    }
    if (entry.path !== spec.path || entry.name !== spec.name || entry.version !== spec.version) {
      issues.push(`${spec.name}: provenance identity mismatch`)
    }
    if (entry.integrity !== spec.integrity) {
      issues.push(`${spec.name}: provenance integrity mismatch`)
    }
    if (entry.tarball !== spec.tarball) {
      issues.push(`${spec.name}: provenance tarball mismatch`)
    }
    if (entry.license !== "MIT") issues.push(`${spec.name}: provenance license mismatch`)
    const expectedDirectoryHash = stringValue(entry, "directorySha256")
    const directory = packageRoot(root, spec)
    if (!expectedDirectoryHash || !existsSync(directory) || directorySha256(directory) !== expectedDirectoryHash) {
      issues.push(`${spec.name}: directory hash mismatch`)
    }
  }

  const patches = objectValue(provenance, "patches")
  const patch = objectValue(patches, "react-devtools-core")
  const patchPath = resolve(root, PATCH_SOURCE)
  if (!patch || patch.source !== PATCH_SOURCE || !existsSync(patchPath) || patch.sourceSha256 !== sha256Hex(readFileSync(patchPath))) {
    issues.push("react-devtools-core: patch source provenance mismatch")
  }
  return issues
}

function validateWorkspaceEdges(root: string): string[] {
  const issues: string[] = []
  const rootManifest = readJson(resolve(root, "package.json"))
  const rootRecord = isRecord(rootManifest) ? rootManifest : undefined
  const workspaces = rootRecord?.workspaces
  if (!Array.isArray(workspaces) || !workspaces.includes("third_party/npm/*") || !workspaces.includes("third_party/npm/@opentui/*")) {
    issues.push("root workspaces must include third_party/npm/* and third_party/npm/@opentui/*")
  }
  const patchedDependencies = objectValue(rootRecord, "patchedDependencies")
  if (patchedDependencies && Object.keys(patchedDependencies).some((key) => key.startsWith("react-devtools-core@"))) {
    issues.push("duplicate root patchedDependencies for react-devtools-core")
  }

  // npm 不支持 workspace: 协议（EUNSUPPORTEDPROTOCOL），残留该协议会让
  // npm install / npm ci 直接失败；在门禁层 fail closed。
  const manifestPaths = [
    resolve(root, "packages/cli/package.json"),
    resolve(root, "packages/protocol/package.json"),
    ...VENDORED_PACKAGE_SPECS.map((spec) => join(packageRoot(root, spec), "package.json")),
  ]
  for (const manifestPath of manifestPaths) {
    const record = readJson(manifestPath)
    if (!isRecord(record)) continue
    for (const section of ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"]) {
      for (const [dependency, version] of Object.entries(objectValue(record, section) ?? {})) {
        if (typeof version === "string" && version.startsWith("workspace:")) {
          issues.push(`workspace: protocol is unsupported by npm: ${relative(root, manifestPath)} ${section}.${dependency}`)
        }
      }
    }
  }

  const [coreSpec, reactSpec, win32Spec, ffiSpec, devtoolsSpec] = VENDORED_PACKAGE_SPECS
  const cli = readJson(resolve(root, "packages/cli/package.json"))
  const cliRecord = isRecord(cli) ? cli : undefined
  if (!hasVendoredDependency(objectValue(cliRecord, "dependencies"), "@opentui/core", coreSpec.version)) {
    issues.push(`CLI @opentui/core must pin the vendored version ${coreSpec.version}`)
  }
  if (!hasVendoredDependency(objectValue(cliRecord, "dependencies"), "@opentui/react", reactSpec.version)) {
    issues.push(`CLI @opentui/react must pin the vendored version ${reactSpec.version}`)
  }
  if (!hasVendoredDependency(objectValue(cliRecord, "devDependencies"), "react-devtools-core", devtoolsSpec.version)) {
    issues.push(`CLI react-devtools-core must pin the vendored version ${devtoolsSpec.version}`)
  }

  const core = packageManifest(root, coreSpec)
  const react = packageManifest(root, reactSpec)
  const devtools = packageManifest(root, devtoolsSpec)
  if (!hasVendoredDependency(objectValue(core, "dependencies"), "bun-ffi-structs", ffiSpec.version)) {
    issues.push(`@opentui/core -> bun-ffi-structs must pin the vendored version ${ffiSpec.version}`)
  }
  if (!hasVendoredDependency(objectValue(core, "optionalDependencies"), "@opentui/core-win32-x64", win32Spec.version)) {
    issues.push(`@opentui/core -> @opentui/core-win32-x64 must pin the vendored version ${win32Spec.version}`)
  }
  if (!hasVendoredDependency(objectValue(react, "dependencies"), "@opentui/core", coreSpec.version)) {
    issues.push(`@opentui/react -> @opentui/core must pin the vendored version ${coreSpec.version}`)
  }
  if (stringValue(objectValue(react, "devDependencies"), "@types/react") !== "19.2.14") {
    issues.push("@opentui/react must retain the CLI React type dependency for workspace declaration resolution")
  }
  if (stringValue(objectValue(devtools, "dependencies"), "ws") !== "7.5.10") {
    issues.push("react-devtools-core ws dependency must be exactly 7.5.10")
  }
  return issues
}

function packageSegments(name: string): string[] {
  return name.startsWith("@") ? name.split("/") : [name]
}

function isWithinPath(parent: string, child: string): boolean {
  const normalizedParent = process.platform === "win32" ? parent.toLowerCase() : parent
  const normalizedChild = process.platform === "win32" ? child.toLowerCase() : child
  const relativePath = relative(normalizedParent, normalizedChild)
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function samePath(left: string, right: string): boolean {
  return isWithinPath(left, right) && isWithinPath(right, left)
}

function findInstalledPackage(root: string, consumer: string, spec: VendoredPackageSpec): string | undefined {
  const rootPath = resolve(root)
  let current = resolve(root, consumer)
  while (isWithinPath(rootPath, current)) {
    const candidate = join(current, "node_modules", ...packageSegments(spec.name))
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

function validateInstalledPackage(
  root: string,
  spec: VendoredPackageSpec,
  consumer: string,
  installedPath: string,
): string[] {
  const issues: string[] = []
  const expectedPath = realPath(packageRoot(root, spec))
  const actualPath = realPath(installedPath)
  if (!expectedPath || !actualPath || !samePath(expectedPath, actualPath)) {
    issues.push(`${spec.name}: installed package from ${consumer} must resolve to third_party/npm`)
    return issues
  }

  const manifest = readJson(join(actualPath, "package.json"))
  if (!isRecord(manifest)) {
    issues.push(`${spec.name}: installed package from ${consumer} has no readable package.json`)
    return issues
  }
  if (stringValue(manifest, "name") !== spec.name || stringValue(manifest, "version") !== spec.version) {
    issues.push(`${spec.name}: installed package from ${consumer} has the wrong package identity`)
  }
  for (const requiredFile of requiredFiles(spec, manifest)) {
    const entryPath = join(actualPath, requiredFile)
    const entryRealPath = realPath(entryPath)
    if (!entryRealPath) {
      issues.push(`${spec.name}: installed entrypoint missing from ${consumer}: ${requiredFile}`)
    } else if (!isWithinPath(expectedPath, entryRealPath)) {
      issues.push(`${spec.name}: installed entrypoint escapes third_party/npm from ${consumer}: ${requiredFile}`)
    } else {
      try {
        if (!statSync(entryPath).isFile()) issues.push(`${spec.name}: installed entrypoint is not a file: ${requiredFile}`)
      } catch {
        issues.push(`${spec.name}: installed entrypoint missing from ${consumer}: ${requiredFile}`)
      }
    }
  }
  return issues
}

/** 判断是否已经存在至少一个 Bun 安装生成的源码包解析入口。 */
export function hasInstalledVendoredWorkspace(root: string): boolean {
  return VENDORED_PACKAGE_SPECS.some((spec) =>
    (VENDORED_PACKAGE_CONSUMERS[spec.name] ?? []).some((consumer) => Boolean(findInstalledPackage(root, consumer, spec))))
}

/** 校验安装后实际解析路径；未安装时默认跳过，避免污染安装前静态门禁。 */
export function validateInstalledVendoredWorkspace(root: string, requireInstalled = false): string[] {
  if (!hasInstalledVendoredWorkspace(root)) {
    return requireInstalled ? ["安装后未找到五个源码化 npm 包的 node_modules 解析入口"] : []
  }

  const issues: string[] = []
  for (const spec of VENDORED_PACKAGE_SPECS) {
    for (const consumer of VENDORED_PACKAGE_CONSUMERS[spec.name] ?? []) {
      const installedPath = findInstalledPackage(root, consumer, spec)
      if (!installedPath) {
        issues.push(`${spec.name}: no installed workspace resolution from ${consumer}`)
      } else {
        issues.push(...validateInstalledPackage(root, spec, consumer, installedPath))
      }
    }
  }
  return issues
}

/** 校验 package-lock.json：五个源码包必须是 workspace link 解析，禁止 registry 回退与嵌套 locator。 */
function validateLock(root: string): string[] {
  const path = resolve(root, "package-lock.json")
  const parsed = lockJson(path)
  if (!parsed) return [`invalid or missing npm lockfile ${path}`]
  const packages = objectValue(parsed, "packages")
  if (!packages) return ["npm lockfile packages must be an object"]
  const issues: string[] = []
  const linkRecords = new Set<string>()

  for (const spec of VENDORED_PACKAGE_SPECS) {
    const entry = packages[`node_modules/${spec.name}`]
    if (!isRecord(entry)) continue
    const resolved = typeof entry.resolved === "string" ? entry.resolved.split("\\").join("/") : ""
    if (entry.link === true && resolved === spec.path) linkRecords.add(spec.name)
  }

  for (const [key, entry] of Object.entries(packages)) {
    if (!isRecord(entry)) continue
    for (const spec of VENDORED_PACKAGE_SPECS) {
      // 精确匹配包名结尾，避免 @opentui/core 前缀误匹配 @opentui/core-win32-x64。
      const directKey = key === `node_modules/${spec.name}`
      const nestedKey = !directKey && key.endsWith(`/node_modules/${spec.name}`)
      if (!directKey && !nestedKey) continue
      if (nestedKey) {
        issues.push(`${spec.name}: nested registry locator in npm lockfile (${key})`)
        continue
      }
      const resolved = typeof entry.resolved === "string" ? entry.resolved.split("\\").join("/") : ""
      if (entry.link !== true || resolved !== spec.path) {
        issues.push(`${spec.name}: registry fallback in npm lockfile (${key})`)
      }
    }
  }
  for (const spec of VENDORED_PACKAGE_SPECS) {
    if (!linkRecords.has(spec.name)) issues.push(`${spec.name}: registry fallback in npm lockfile`)
  }
  return issues
}

/** 汇总安装前和安装后共用的源码化 npm 门禁。 */
export function validateVendoredWorkspace(root: string): string[] {
  const issues = VENDORED_PACKAGE_SPECS.flatMap((spec) => validatePackageFiles(root, spec))
  return [...issues, ...validateProvenance(root), ...validateWorkspaceEdges(root), ...validateLock(root)]
}
