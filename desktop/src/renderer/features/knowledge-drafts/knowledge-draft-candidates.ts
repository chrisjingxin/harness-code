/**
 * 知识起草会话候选聚合（F-37）：
 * 合并「本机个人会话库（含已发布）」与「团队活跃 Project 下本人已绑定目录会话」，
 * 按最近活跃时间倒序去重展示，使「让本机 Agent 整理」可选到团队空间新建的会话。
 */
import type { ConversationSummary } from "@workbench/collaboration-client/types"
import type {
  ConversationPersonal,
  LocalConversationsHost,
  OrganizationHost,
  PersonalHost,
  ProjectConversationHost,
} from "../../../shared/index.js"

const MAX_PROJECT_CANDIDATES = 30

export interface KnowledgeDraftSessionCandidate {
  readonly conversationId: string
  readonly projectId: string | null
  readonly title: string
  readonly projectName?: string
  readonly updatedAtMs: number
}

export interface LoadKnowledgeDraftCandidatesInput {
  readonly accountId: string
  readonly workspaceId: string
  readonly localConversations: Pick<LocalConversationsHost, "list">
  readonly organization: Pick<OrganizationHost, "listProjects">
  readonly projectConversations: Pick<ProjectConversationHost, "listConversations">
  readonly personal: Pick<PersonalHost, "load">
}

/** 格式化「让本机 Agent 整理」下拉框选项文本，附带所属项目名称以便区分重名会话。 */
export function formatKnowledgeDraftCandidateLabel(candidate: KnowledgeDraftSessionCandidate): string {
  const title = candidate.title.trim() || "未命名会话"
  return candidate.projectName ? `${title} · ${candidate.projectName}` : title
}

function resolveConversationUpdatedAtMs(conv: Pick<ConversationSummary, "updatedAt" | "briefUpdatedAtMs">): number {
  const parsed = Date.parse(conv.updatedAt)
  if (Number.isFinite(parsed)) return parsed
  return conv.briefUpdatedAtMs || 0
}

/** 加载并合并当前团队下本人可执行的本机会话与团队 Project 会话候选。 */
export async function loadKnowledgeDraftCandidates(
  input: LoadKnowledgeDraftCandidatesInput,
): Promise<{ readonly candidates: readonly KnowledgeDraftSessionCandidate[]; readonly error?: string }> {
  const { accountId, workspaceId, localConversations, organization, projectConversations, personal } = input
  const [localRes, projectsRes] = await Promise.all([
    localConversations.list({ workspaceId, includePublished: true }).catch(() => ({
      ok: false as const,
      error: { code: "LOCAL_LIST_FAILED", message: "读取本机会话列表失败。", retryable: true },
    })),
    organization.listProjects(workspaceId).catch(() => ({
      ok: false as const,
      error: { code: "PROJECT_LIST_FAILED", message: "读取团队项目列表失败。", retryable: true },
    })),
  ])

  const projectNameById = new Map<string, string>()
  const activeProjects = projectsRes.ok
    ? projectsRes.value.projects.filter(project => project.status === "active")
    : []
  for (const project of activeProjects) {
    projectNameById.set(project.projectId, project.name)
  }

  const candidates: KnowledgeDraftSessionCandidate[] = []
  const seen = new Set<string>()
  const errors: string[] = []

  const localOk = localRes.ok
  if (localRes.ok) {
    for (const rec of localRes.value) {
      if (!rec.directoryPath?.trim()) continue
      seen.add(rec.conversationId)
      const projectName = rec.projectId ? projectNameById.get(rec.projectId) : undefined
      candidates.push({
        conversationId: rec.conversationId,
        projectId: rec.projectId,
        title: rec.title,
        ...(projectName ? { projectName } : {}),
        updatedAtMs: rec.updatedAtMs,
      })
    }
  } else {
    errors.push(localRes.error.message)
  }

  let teamOk = projectsRes.ok
  if (!projectsRes.ok) {
    errors.push(projectsRes.error.message)
  } else if (activeProjects.length > 0) {
    const projectResults = await Promise.all(
      activeProjects.map(async project => {
        try {
          const res = await projectConversations.listConversations(workspaceId, project.projectId, { ownerId: accountId })
          return { project, res }
        } catch {
          return {
            project,
            res: {
              ok: false as const,
              error: { code: "CONV_LIST_FAILED", message: "读取项目会话列表失败。", retryable: true },
            },
          }
        }
      }),
    )

    let anyProjectConvOk = false
    const pendingProjectConvs: {
      readonly conversationId: string
      readonly projectId: string
      readonly projectName: string
      readonly title: string
      readonly updatedAtMs: number
    }[] = []

    for (const { project, res } of projectResults) {
      if (!res.ok) {
        errors.push(res.error.message)
        continue
      }
      anyProjectConvOk = true
      for (const conv of res.value.conversations) {
        if (conv.ownerUserId !== accountId || conv.shareStatus === "stopped" || seen.has(conv.conversationId)) {
          continue
        }
        seen.add(conv.conversationId)
        pendingProjectConvs.push({
          conversationId: conv.conversationId,
          projectId: conv.projectId || project.projectId,
          projectName: project.name,
          title: conv.title,
          updatedAtMs: resolveConversationUpdatedAtMs(conv),
        })
      }
    }
    teamOk = anyProjectConvOk

    pendingProjectConvs.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.title.localeCompare(b.title))
    const capped = pendingProjectConvs.slice(0, MAX_PROJECT_CANDIDATES)
    const loadedDirectories = await Promise.all(
      capped.map(async item => {
        try {
          const loaded = await personal.load({
            kind: "conversation",
            workspaceId,
            projectId: item.projectId,
            conversationId: item.conversationId,
          })
          const record = loaded.ok ? (loaded.value.data as ConversationPersonal | null) : null
          return { item, hasDirectory: Boolean(record?.localDirectoryPath?.trim()) }
        } catch {
          return { item, hasDirectory: false }
        }
      }),
    )

    for (const { item, hasDirectory } of loadedDirectories) {
      if (!hasDirectory) continue
      candidates.push({
        conversationId: item.conversationId,
        projectId: item.projectId,
        title: item.title,
        projectName: item.projectName,
        updatedAtMs: item.updatedAtMs,
      })
    }
  }

  candidates.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.title.localeCompare(b.title))

  if (!localOk && !teamOk && candidates.length === 0) {
    return { candidates: [], error: errors[0] ?? "读取本人可执行会话失败。" }
  }
  return { candidates }
}
