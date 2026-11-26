/**
 * 轮次代码变更与时间线归位纯模型。
 *
 * 【功能定义】
 * 1. 从本机/实时时间线条目 ID 提取 turnId，并把 `CodeCheckpointTurn` 精准挂载到对应用户消息与轮次末尾；
 * 2. 汇总单轮增删行数，并将扁平文件路径列表整理为“单子目录折叠 + 目录优先排序”的文件树供卡片就地渲染。
 * 【协作边界】纯 TypeScript 数据变换，不依赖 React、Electron 或文件系统。
 */
import type { CodeCheckpointFileChange, CodeCheckpointTurn } from "../../../shared/local-execution-host.js"
import type { ConversationTimelineEntry } from "../../../ui/index.js"

export type TurnDiffTreeNode =
  | { readonly kind: "directory"; readonly name: string; readonly path: string; readonly children: readonly TurnDiffTreeNode[] }
  | { readonly kind: "file"; readonly name: string; readonly file: CodeCheckpointFileChange }

export type MatchedTurnSpan = {
  readonly turn: CodeCheckpointTurn
  readonly userIndex: number
  readonly endIndex: number
}

/** 从 `local-execution:<turnId>:*` 或 `local-turn:<turnId>:*` 中提取轮次 ID。 */
export function extractTimelineTurnId(entryId: string): string | null {
  const match = /^(?:local-execution|local-turn):([^:]+):/.exec(entryId)
  return match?.[1] ?? null
}

/** 汇总单轮文件总数与总增删行数（二进制文件按 0 行计入行统计，仍计入文件总数）。 */
export function summarizeCheckpointFiles(files: readonly CodeCheckpointFileChange[]): {
  readonly count: number
  readonly additions: number
  readonly deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    if (typeof file.added === "number") additions += file.added
    if (typeof file.removed === "number") deletions += file.removed
  }
  return { count: files.length, additions, deletions }
}

type MutableDirNode = {
  readonly kind: "directory"
  readonly name: string
  readonly path: string
  readonly dirs: Map<string, MutableDirNode>
  readonly files: Array<{ readonly kind: "file"; readonly name: string; readonly file: CodeCheckpointFileChange }>
}

function finalizeTreeNodes(dir: MutableDirNode): readonly TurnDiffTreeNode[] {
  const dirNodes: TurnDiffTreeNode[] = [...dir.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(child => {
      // 连续只有单一子目录的链条折叠为 `a/b/c`，与 T3 Code 变更树保持一致，减少无效缩进。
      let current = child
      let compactedName = child.name
      let compactedPath = child.path
      while (current.dirs.size === 1 && current.files.length === 0) {
        const onlyChild = [...current.dirs.values()][0]!
        compactedName = `${compactedName}/${onlyChild.name}`
        compactedPath = onlyChild.path
        current = onlyChild
      }
      return {
        kind: "directory" as const,
        name: compactedName,
        path: compactedPath,
        children: finalizeTreeNodes(current),
      }
    })
  const fileNodes: TurnDiffTreeNode[] = [...dir.files].sort((a, b) => a.name.localeCompare(b.name))
  return [...dirNodes, ...fileNodes]
}

/** 将单轮变更文件列表整理为“单子目录折叠 + 目录优先排序”的文件树。 */
export function buildTurnDiffTree(files: readonly CodeCheckpointFileChange[]): readonly TurnDiffTreeNode[] {
  const root: MutableDirNode = { kind: "directory", name: "", path: "", dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean)
    if (parts.length === 0) continue
    let current = root
    for (let i = 0; i < parts.length - 1; i += 1) {
      const segment = parts[i]!
      const nextPath = current.path ? `${current.path}/${segment}` : segment
      let child = current.dirs.get(segment)
      if (!child) {
        child = { kind: "directory", name: segment, path: nextPath, dirs: new Map(), files: [] }
        current.dirs.set(segment, child)
      }
      current = child
    }
    current.files.push({
      kind: "file",
      name: parts[parts.length - 1]!,
      file,
    })
  }
  return finalizeTreeNodes(root)
}

/**
 * 为已结束的轮次快照匹配时间线上的用户消息起点与轮次末尾下标：
 * 1. 跳过当前仍在运行中的 `activeTurnId`，避免未收敛的轮次提前挂出变更卡片；
 * 2. 优先按 `turnId` 精确匹配用户消息（忽略同轮内后续追加的 steer/followup 用户条）；
 * 3. 对仅保留云端序号 ID（`seq-*`）的历史消息，按唯一时间戳 `createdAtMs` 回填对应轮次。
 */
export function matchTurnSpans(
  entries: readonly ConversationTimelineEntry[],
  turns: readonly CodeCheckpointTurn[],
  activeTurnId?: string | null,
): readonly MatchedTurnSpan[] {
  if (entries.length === 0 || turns.length === 0) return []
  const turnById = new Map<string, CodeCheckpointTurn>()
  for (const turn of turns) {
    if (activeTurnId && turn.turnId === activeTurnId) continue
    turnById.set(turn.turnId, turn)
  }
  if (turnById.size === 0) return []

  const matched = new Map<string, number>()
  const claimedUserIndexes = new Set<number>()

  // 第一轮：按条目 ID 中的 turnId 精确配对主用户消息，同轮仅认首条主用户消息。
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.kind !== "message" || entry.role !== "user") continue
    const turnId = extractTimelineTurnId(entry.id)
    if (!turnId || matched.has(turnId) || !turnById.has(turnId)) continue
    if (entry.id.includes(":followup:") || entry.id.includes(":steer:")) continue
    matched.set(turnId, index)
    claimedUserIndexes.add(index)
  }

  // 第二轮：对重开后以云端 `seq-*` 呈现的历史消息，在未认领的用户消息中按唯一毫秒时间戳匹配。
  const remainingByTimestamp = new Map<number, CodeCheckpointTurn[]>()
  for (const turn of turnById.values()) {
    if (matched.has(turn.turnId)) continue
    const list = remainingByTimestamp.get(turn.createdAtMs) ?? []
    list.push(turn)
    remainingByTimestamp.set(turn.createdAtMs, list)
  }
  if (remainingByTimestamp.size > 0) {
    const userIndexByTimestamp = new Map<number, number[]>()
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!
      if (entry.kind !== "message" || entry.role !== "user" || claimedUserIndexes.has(index)) continue
      if (typeof entry.createdAtMs !== "number") continue
      const list = userIndexByTimestamp.get(entry.createdAtMs) ?? []
      list.push(index)
      userIndexByTimestamp.set(entry.createdAtMs, list)
    }
    for (const [ts, candidateTurns] of remainingByTimestamp.entries()) {
      const candidateUsers = userIndexByTimestamp.get(ts)
      if (candidateTurns.length === 1 && candidateUsers?.length === 1) {
        const turnId = candidateTurns[0]!.turnId
        const userIndex = candidateUsers[0]!
        matched.set(turnId, userIndex)
        claimedUserIndexes.add(userIndex)
      }
    }
  }

  const spans: MatchedTurnSpan[] = []
  for (const [turnId, userIndex] of matched.entries()) {
    const turn = turnById.get(turnId)!
    let endIndex = userIndex
    for (let i = userIndex + 1; i < entries.length; i += 1) {
      const next = entries[i]!
      if (next.kind === "message" && next.role === "user") {
        // 属于同一轮中途插入的 follow-up / steer 指令仍划归本轮，不提前截断轮末卡片位置。
        if (extractTimelineTurnId(next.id) === turnId) {
          endIndex = i
          continue
        }
        break
      }
      endIndex = i
    }
    spans.push({ turn, userIndex, endIndex })
  }
  spans.sort((a, b) => a.userIndex - b.userIndex)
  return spans
}
