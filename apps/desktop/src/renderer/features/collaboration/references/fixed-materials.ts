/** 投影 HC-212 的实际固定材料。正文保留接口原值，日期、范围和来源只用于展示。 */
import type { CollaborationAppsHost, CollaborationResult, KnowledgeVersion, SnapshotResponse } from "@workbench/contracts"
import { knowledgeReferenceId, parseFixedReference } from "../../../../collaboration-reference.js"
import type { ProjectNavigationScope } from "../../project-navigation/index.js"
import type { ConversationSnapshot } from "./conversation-references.js"

export function snapshotMaterial(value: SnapshotResponse, ownerName: (id: string) => string): ConversationSnapshot {
  return {
    id: value.snapshotId,
    title: value.sourceTitle || "未命名会话",
    owner: ownerName(value.sourceOwnerUserId),
    version: value.snapshotId,
    uploadedAt: new Date(value.sourceSyncedAtMs).toLocaleString(),
    rangeLabel: value.fromSequence === null ? "已同步简报" : `已上传消息 ${value.fromSequence}–${value.toSequence}（${value.messageCount} 条）`,
    text: value.text,
    sourceConversationId: value.sourceConversationId,
  }
}

export function knowledgeMaterial(value: KnowledgeVersion, ownerName: (id: string) => string): ConversationSnapshot {
  return {
    id: knowledgeReferenceId({ knowledgeId: value.knowledgeId, versionId: value.version.versionId }),
    title: value.version.title,
    owner: ownerName(value.version.authorId),
    version: `v${value.version.version}`,
    uploadedAt: new Date(value.version.createdAtMs).toLocaleString(),
    rangeLabel: `${value.version.category} · 团队知识`,
    text: value.text,
    archived: value.archived,
  }
}

export async function readFixedMaterial(host: CollaborationAppsHost, scope: ProjectNavigationScope, id: string,
  ownerName: (id: string) => string): Promise<CollaborationResult<ConversationSnapshot>> {
  const reference = parseFixedReference(id)
  if (!reference) return { ok: false, error: { code: "INVALID_REQUEST", message: "引用标识不可用。", requestId: "", retryable: false } }
  if (reference.kind === "snapshot") {
    const result = await host.readSnapshot(scope.workspaceId, scope.projectId, reference.snapshotId)
    return result.ok ? { ok: true, value: snapshotMaterial(result.value, ownerName) } : result
  }
  const result = await host.readKnowledgeVersion(scope.workspaceId, reference.knowledgeId, reference.versionId)
  return result.ok ? { ok: true, value: knowledgeMaterial(result.value, ownerName) } : result
}
