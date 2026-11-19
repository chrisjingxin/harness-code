/**
 * 【功能定义】固定引用（快照 / 团队知识版本）的标识符编解码工具。
 * 【协作边界】仅依赖 `@workbench/collaboration-client/types`，供主进程校验与渲染层选择材料共用。
 */
import type { KnowledgeRef } from "@workbench/collaboration-client/types"

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
