/** 个人草稿和消息只记录 HC-212 的固定标识。知识版本同时需要条目 ID 才能走正式读取路径。 */
import type { KnowledgeRef } from "@workbench/contracts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const knowledgeReferenceId = ({ knowledgeId, versionId }: KnowledgeRef): string => `knowledge:${knowledgeId}:${versionId}`

export type FixedReference =
  | { readonly kind: "snapshot"; readonly snapshotId: string }
  | ({ readonly kind: "knowledge" } & KnowledgeRef)

export function parseFixedReference(id: unknown): FixedReference | null {
  if (typeof id !== "string") return null
  if (uuid.test(id)) return { kind: "snapshot", snapshotId: id }
  const [kind, knowledgeId, versionId, extra] = id.split(":")
  return kind === "knowledge" && extra === undefined && uuid.test(knowledgeId) && uuid.test(versionId)
    ? { kind, knowledgeId, versionId } : null
}
