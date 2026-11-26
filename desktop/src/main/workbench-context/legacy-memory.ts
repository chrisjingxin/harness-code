/**
 * HC-233 旧文件的一次性读取迁移。仅识别并验证旧格式，不再为产品生成结构化记忆。
 * 原始字节由 store 先备份；这里保留原正文和来源说明，损坏时交给 store 只读保护。
 */
import type { ProjectMemoryDocument } from "../../shared/workbench-context-host.js"
const MEMORY_ENTRY_LIMIT = 4 * 1024
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")
const safeId = (value: string) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const memoryFile = (kind: MemoryKind): MemoryFile => kind === "personal_directory" ? "personal.md" : "team.md"
type MemoryKind = "team_project" | "team_repository" | "personal_directory"
type MemoryFile = "team.md" | "personal.md"
/** 以下字段只用于辨认和保留旧文件，不参与新记忆的准入或权限判断。 */
type MemorySource = {
  sourceId: string
  kind: "project" | "repository" | "conversation" | "snapshot" | "knowledge" | "user_confirmation"
  projectId?: string
  /** 迁移保留的历史目录说明；不授予目录访问权限。 */
  confirmedDirectory?: string
  repositoryId?: string
  remoteUrl?: string
  upstreamUrl?: string
}
type MemoryFields = {
  name: string
  summary: string
  aliases?: string[]
  projectIds?: string[]
  repositoryId?: string
  repositoryIds?: string[]
  relatedProjectIds?: string[]
  remoteUrl?: string
  upstreamUrl?: string
  rootPath?: string
  relativePath?: string
}
type MemoryEntry = MemoryFields & {
  entryId: string
  entryRevision: number
  kind: MemoryKind
  sources: MemorySource[]
  confirmedAt: string
}
type MemoryDocument = { formatVersion: 1; documentRevision: number; updatedAt: string; entries: MemoryEntry[] }
const fieldNames = ["name", "summary", "aliases", "projectIds", "repositoryId", "repositoryIds", "relatedProjectIds", "remoteUrl", "upstreamUrl", "rootPath", "relativePath"] as const
const arrays = new Set(["aliases", "projectIds", "repositoryIds", "relatedProjectIds"])
const clean = (text: string) => text.replace(/[\r\n\p{Cc}]/gu, " ").trim()

/** 普通 Markdown 正文只由已校验业务字段生成，不携带文件头技术字段。 */
function renderMemory(file: MemoryFile, entries: readonly MemoryEntry[]): string {
  if (!entries.length) return ""
  return [`# ${file === "team.md" ? "团队工程概览" : "个人工程目录"}`, ...entries.map(entry => [
    `## ${entry.name}${entry.aliases?.length ? `（${entry.aliases.join("、")}）` : ""}`,
    entry.summary,
    ...(entry.projectIds?.length ? [`关联 Project：${entry.projectIds.join("、")}`] : []),
    ...(entry.repositoryId ? [`团队仓库 ID：${entry.repositoryId}`] : []),
    ...(entry.repositoryIds?.length ? [`涉及仓库：${entry.repositoryIds.join("、")}`] : []),
    ...(entry.relatedProjectIds?.length ? [`相关 Project：${entry.relatedProjectIds.join("、")}`] : []),
    ...(entry.rootPath ? [`本机根目录：${entry.rootPath}；相对目录：${entry.relativePath ?? "."}`] : []),
    ...(entry.remoteUrl ? [`${file === "team.md" ? "团队" : "本人"}仓库：${entry.remoteUrl}`] : []),
    ...(entry.upstreamUrl ? [`团队上游：${entry.upstreamUrl}`] : []),
  ].filter(Boolean).join("\n"))].join("\n\n") + "\n"
}

function validateFields(value: Partial<MemoryFields>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("变更字段必须是对象。")
  for (const [key, item] of Object.entries(value)) {
    if (!fieldNames.includes(key as typeof fieldNames[number])) throw new Error(`不支持的维护字段：${key}`)
    if (arrays.has(key)) {
      if (!Array.isArray(item) || item.length > 64 || item.some(v => typeof v !== "string" || !v || clean(v) !== v)) throw new Error(`字段 ${key} 无效。`)
    } else if (typeof item !== "string" || clean(item) !== item || item.includes("\0")) throw new Error(`字段 ${key} 无效。`)
  }
}
function decode(text: string, file: MemoryFile): MemoryDocument {
  const match = /^---\nformatVersion: 1\ndocumentRevision: (\d+)\nupdatedAt: (.+)\nentries: (.+)\n---\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`${file} 文件头无法解析，原文件已保留。`)
  const entries: MemoryEntry[] = JSON.parse(match[3])
  const document: MemoryDocument = { formatVersion: 1, documentRevision: Number(match[1]), updatedAt: JSON.parse(match[2]), entries }
  if (!Number.isSafeInteger(document.documentRevision) || typeof document.updatedAt !== "string" || !Array.isArray(entries)) throw new Error(`${file} 维护字段无效。`)
  const ids = new Set<string>()
  for (const entry of entries) {
    const { entryId, entryRevision, kind, sources, confirmedAt, ...fields } = entry
    validateFields(fields)
    if (!safeId(entryId) || ids.has(entryId) || !Number.isSafeInteger(entryRevision) || entryRevision < 1
      || !["team_project", "team_repository", "personal_directory"].includes(kind) || memoryFile(kind) !== file
      || !fields.name || typeof fields.summary !== "string" || !Array.isArray(sources) || !sources.length
      || sources.some(s => !s || typeof s.sourceId !== "string" || !["project", "repository", "conversation", "snapshot", "knowledge", "user_confirmation"].includes(s.kind)
        || s.projectId !== undefined && typeof s.projectId !== "string"
        || s.confirmedDirectory !== undefined && typeof s.confirmedDirectory !== "string"
        || [s.repositoryId, s.remoteUrl, s.upstreamUrl].some(value => value !== undefined && typeof value !== "string"))
      || typeof confirmedAt !== "string" || bytes(entry) > MEMORY_ENTRY_LIMIT) throw new Error(`${file} 条目无效，原文件已保留。`)
    ids.add(entryId)
  }
  if (renderMemory(file, entries) !== match[4]) throw new Error(`${file} 正文与维护字段不一致，原文件已保留，请人工检查。`)
  return document
}

/** 返回 undefined 表示普通 MD；旧格式候选损坏时保留原件，不当空文档处理。 */
export function migrateLegacyMemory(text: string, document: ProjectMemoryDocument): string | undefined {
  const header = /^---\r?\n([\s\S]*?)(?:\r?\n---(?:\r?\n|$)|$)/.exec(text)?.[1]
  // 只认 HC-233 的四字段组合，普通 front matter 不是产品 schema。
  // 值损坏或缺少结束分隔符仍会进入旧解码并只读保护原件。
  if (!header || !["formatVersion", "documentRevision", "updatedAt", "entries"].every(key => new RegExp(`^${key}:`, "m").test(header))) return undefined
  const file: MemoryFile = document === "team" ? "team.md" : "personal.md"
  const parsed = decode(text, file)
  const body = text.slice(text.indexOf("\n---\n", 4) + 5)
  const history = parsed.entries.map(entry => [
    `### ${entry.name}`,
    `原确认时间：${entry.confirmedAt}`,
    ...entry.sources.map(source => `- ${JSON.stringify(source)}`),
  ].join("\n")).join("\n\n")
  return body + (history ? `\n## 历史来源（迁移保留）\n\n${history}\n` : "")
}
