/**
 * 统一版本、发布一致性和 Changelog 生成。
 */

import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
/** 与根显式 workspace 清单共用版本对象，避免新平台再依赖旧 CLI/Python。 */
async function versionFiles(projectRoot: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { workspaces: string[] }
  if (!Array.isArray(manifest.workspaces) || manifest.workspaces.some(path => !/^(apps|packages)\/[a-z0-9-]+$/.test(path))) throw new Error("版本检查需要显式 workspace 清单")
  return manifest.workspaces.map(path => `${path}/package.json`)
}

const semVerPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const
type VersionRecord = { version?: string } & Partial<Record<typeof dependencySections[number], Record<string, string>>>

/** 只迁移新 workspace 间的既有精确版本；外部依赖和范围表达式不属于本次升版。 */
function updateInternalReferences(record: VersionRecord, workspaceNames: ReadonlySet<string>, version: string): void {
  for (const section of dependencySections) {
    for (const [name, reference] of Object.entries(record[section] ?? {})) {
      if (workspaceNames.has(name) && semVerPattern.test(reference)) record[section]![name] = version
    }
  }
}

export type SemVer = {
  raw: string
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

/** 解析严格的 SemVer 字符串，支持预发布和构建元数据。 */
export function parseSemVer(value: string): SemVer {
  const match = value.trim().match(semVerPattern)
  if (!match) throw new Error(`无效 SemVer：${value}`)
  return {
    raw: value.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  }
}

/** 比较两个 SemVer；正数表示左侧版本更高。 */
export function compareSemVer(left: SemVer, right: SemVer): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] !== right[field]) return left[field] > right[field] ? 1 : -1
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0
  if (!left.prerelease.length) return 1
  if (!right.prerelease.length) return -1
  const count = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < count; index++) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === b) continue
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumber = /^\d+$/.test(a)
    const bNumber = /^\d+$/.test(b)
    if (aNumber && bNumber) return Number(a) > Number(b) ? 1 : -1
    if (aNumber !== bNumber) return aNumber ? -1 : 1
    return a > b ? 1 : -1
  }
  return 0
}

/** 按 Conventional Commit 标题生成中文 Changelog 版本节。 */
export function renderChangelogSection(version: string, date: string, subjects: readonly string[]): string {
  const groups = new Map<string, string[]>()
  const labels: Array<[string, string]> = [
    ["feat", "新增"],
    ["fix", "修复"],
    ["perf", "优化"],
    ["refactor", "优化"],
    ["security", "安全"],
    ["docs", "文档"],
  ]
  for (const subject of subjects) {
    const match = subject.match(/^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/i)
    const type = match?.[1].toLowerCase() ?? "other"
    const message = match?.[2] ?? subject
    const label = labels.find(([prefix]) => prefix === type)?.[1] ?? "其他"
    groups.set(label, [...(groups.get(label) ?? []), message])
  }
  const orderedLabels = ["新增", "修复", "优化", "安全", "文档", "其他"]
  const sections = orderedLabels.flatMap(label => {
    const items = groups.get(label)
    return items?.length ? [`### ${label}`, ...items.map(item => `- ${item}`), ""] : []
  })
  if (!sections.length) sections.push("### 其他", "- 初始化版本记录。", "")
  return [`## [${version}] - ${date}`, "", ...sections].join("\n")
}

/** 通过唯一版本来源同步新 workspace 包版本，并在同一操作内刷新 Changelog。 */
export async function setVersion(projectRoot: string, version: string, subjects?: readonly string[]): Promise<void> {
  const target = parseSemVer(version)
  const versionPath = join(projectRoot, "VERSION")
  const changelogPath = join(projectRoot, "CHANGELOG.md")
  const existing = await readOptional(changelogPath) ?? "# 更新日志\n\n"
  const currentSource = await readOptional(versionPath)
  if (currentSource !== undefined) {
    const current = parseSemVer(currentSource.trim())
    const comparison = compareSemVer(target, current)
    // 首次引入本机制时允许以已有版本补建 CHANGELOG；后续版本必须严格递增。
    if (comparison < 0 || (comparison === 0 && existing !== "# 更新日志\n\n")) {
      throw new Error(`新版本必须高于当前版本 ${current.raw}`)
    }
  }

  await writeFile(versionPath, `${target.raw}\n`, "utf8")
  const files = await versionFiles(projectRoot)
  const manifests = await Promise.all(files.map(async file => ({ file, value: JSON.parse(await readFile(join(projectRoot, file), "utf8")) as VersionRecord & { name: string } })))
  const workspaceNames = new Set(manifests.map(({ value }) => value.name))
  for (const { file, value } of manifests) {
    value.version = target.raw
    updateInternalReferences(value, workspaceNames, target.raw)
    await writeFile(join(projectRoot, file), `${JSON.stringify(value, null, 2)}\n`, "utf8")
  }

  // npm ci 冻结读取锁文件；版本变更必须同步 workspace 锁条目，不能留下下一次安装失败的状态。
  const lockPath = join(projectRoot, "package-lock.json")
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as { packages: Record<string, VersionRecord> }
  for (const file of files) {
    const entry = lock.packages[dirname(file)]
    entry.version = target.raw
    updateInternalReferences(entry, workspaceNames, target.raw)
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8")

  if (existing.includes(`## [${target.raw}] -`)) throw new Error(`CHANGELOG 已包含版本 ${target.raw}`)
  const messages = subjects ?? readCommitSubjects(projectRoot)
  await writeFile(changelogPath, `${changelogHeader(existing)}${renderChangelogSection(target.raw, today(), messages)}${changelogBody(existing)}`, "utf8")
}

/** 验证版本字段、顶层 Changelog 节和所有发布文件的一致性。 */
export async function checkRelease(projectRoot = root): Promise<void> {
  const version = parseSemVer((await readFile(join(projectRoot, "VERSION"), "utf8")).trim()).raw
  for (const file of await versionFiles(projectRoot)) {
    const value = JSON.parse(await readFile(join(projectRoot, file), "utf8")) as { version?: unknown }
    if (value.version !== version) throw new Error(`${file} 版本与 VERSION 不一致`)
  }
  const lock = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> }
  for (const file of await versionFiles(projectRoot)) {
    if (lock.packages[dirname(file)]?.version !== version) throw new Error(`package-lock 中 ${dirname(file)} 版本与 VERSION 不一致`)
  }
  const changelog = await readFile(join(projectRoot, "CHANGELOG.md"), "utf8")
  if (!new RegExp(`^# 更新日志\\r?\\n\\r?\\n## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}`).test(changelog)) {
    throw new Error("CHANGELOG 顶部缺少当前 VERSION 的版本节")
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (!isNotFound(error)) throw error
    return undefined
  }
}

function readCommitSubjects(projectRoot: string): string[] {
  let latestTag: string | undefined
  try {
    latestTag = execFileSync("git", ["describe", "--tags", "--match", "v*", "--abbrev=0"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
  } catch {
    latestTag = undefined
  }
  const range = latestTag ? `${latestTag}..HEAD` : "HEAD"
  const output = execFileSync("git", ["log", range, "--format=%s", "--reverse"], { cwd: projectRoot, encoding: "utf8" })
  return output.split("\n").map(value => value.trim()).filter(Boolean)
}

function changelogHeader(existing: string): string {
  return "# 更新日志\n\n"
}

function changelogBody(existing: string): string {
  const body = existing.replace(/^# 更新日志\r?\n*/, "").trim()
  return body ? `${body}\n` : ""
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
