/** Runner 的只读项目端口。项目根由宿主解析，通信只携带项目标识和相对路径。 */
import type {
  ProjectReadAction, ProjectReadFailureCode, ProjectReadReply, ProjectReadResponse,
} from "@workbench/contracts"

export type ProjectReadOutcome =
  | { status: "ok"; response: ProjectReadResponse }
  | { status: "error"; code: ProjectReadFailureCode }

export interface ProjectReadPort {
  read(projectId: string, shareVersion: string, action: ProjectReadAction): Promise<ProjectReadOutcome>
}

/** 设备控制帧在 Runner 入口校验闭合字段，避免向本机端口转交任意命令。 */
export function isProjectReadAction(value: unknown): value is ProjectReadAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const exact = (...names: string[]) => Object.keys(item).every(name => names.includes(name))
  const bounded = (field: unknown, minimum: number, maximum: number) =>
    typeof field === "string" && field.length >= minimum && field.length <= maximum
  switch (item.kind) {
    case "listDirectory":
      return exact("kind", "directory", "cursor") && bounded(item.directory, 0, 4096)
        && (item.cursor === undefined || bounded(item.cursor, 1, 256))
    case "searchCandidates":
      return exact("kind", "directory", "query", "limit") && bounded(item.directory, 0, 4096)
        && bounded(item.query, 0, 4096)
        && (item.limit === undefined || Number.isInteger(item.limit) && Number(item.limit) >= 1 && Number(item.limit) <= 1000)
    case "readPreview":
      return exact("kind", "path") && bounded(item.path, 1, 4096)
    case "gitStatus":
      return exact("kind")
    case "gitDiff":
      return exact("kind", "snapshot", "path") && bounded(item.snapshot, 1, 128) && bounded(item.path, 1, 4096)
    default:
      return false
  }
}

const MAX_FRAME_BYTES = 256 * 1024

/** 完整 JSON 外壳参与计算，超长结果按可读边界缩小，并明确标记截断。 */
export function fitProjectReply(connectionId: string, reply: ProjectReadReply): ProjectReadReply {
  const fits = () => Buffer.byteLength(JSON.stringify({ connectionId, message: reply }), "utf8") <= MAX_FRAME_BYTES
  if (fits()) return reply
  const result = reply.payload.result
  if (result.status === "ok") {
    const response = result.response
    if (response.kind === "readPreview" || response.kind === "gitDiff") {
      const key = response.kind === "readPreview" ? "content" : "text"
      const value = response.value as { content?: string; text?: string; truncated: boolean; displayedBytes?: number; lineCount?: number }
      const chars = Array.from(value[key] ?? "")
      let low = 0
      let high = chars.length
      const set = (length: number) => {
        const text = chars.slice(0, length).join("")
        value[key] = text
        value.truncated = true
        if (response.kind === "readPreview") {
          value.displayedBytes = Buffer.byteLength(text)
          value.lineCount = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0
        }
      }
      set(0)
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        set(mid)
        if (fits()) low = mid
        else high = mid - 1
      }
      set(low)
    } else if (response.kind === "listDirectory" || response.kind === "searchCandidates") {
      const value = response.value
      const entries = response.kind === "listDirectory" ? response.value.entries : response.value.items
      let low = 0
      let high = entries.length
      const set = (length: number) => {
        if (response.kind === "listDirectory") {
          response.value.entries = entries.slice(0, length) as typeof response.value.entries
          // 本机游标只能从原整页末尾续读，压缩页时省略它以避免跳过条目。
          delete response.value.nextCursor
        } else {
          response.value.items = entries.slice(0, length) as typeof response.value.items
        }
        value.truncated = true
      }
      set(0)
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        set(mid)
        if (fits()) low = mid
        else high = mid - 1
      }
      set(low)
    }
  }
  if (!fits()) reply.payload.result = { status: "error", code: "PROJECT_LIMIT_EXCEEDED" }
  return reply
}
