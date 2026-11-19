/** 引用确认与触发片段移除属于同一次草稿修订，旧预览不能删除后来编辑的文字。 */
import type { ConversationDraft } from "../../../ui/index.js"
import type { NewSessionReferenceChange } from "./contracts.js"

export function mergeReferenceDraft(previous: ConversationDraft, change: NewSessionReferenceChange, originId: string): ConversationDraft | null {
  if (change.kind === "replace" && !previous.referenceIds.includes(change.referenceId)) return null
  const referenceIds = change.kind === "add"
    ? [...new Set([...previous.referenceIds, ...change.referenceIds])]
    : change.kind === "replace"
      ? [...new Set(previous.referenceIds.map(id => id === change.referenceId ? change.replacementId : id))]
      : previous.referenceIds.filter(id => id !== change.referenceId)
  const mention = change.kind === "add" ? change.mention : undefined
  const removeToken = mention && mention.conversationId === originId && mention.draftRevision === previous.revision
    && Number.isInteger(mention.tokenStart) && Number.isInteger(mention.tokenEnd)
    && mention.tokenStart >= 0 && mention.tokenStart < mention.tokenEnd && mention.tokenEnd <= previous.text.length
    && mention.tokenText.startsWith("@") && previous.text.slice(mention.tokenStart, mention.tokenEnd) === mention.tokenText
  return {
    ...previous, referenceIds, revision: previous.revision + 1,
    ...(removeToken ? {
      text: previous.text.slice(0, mention.tokenStart) + previous.text.slice(mention.tokenEnd),
      selectionStart: mention.tokenStart, selectionEnd: mention.tokenStart,
    } : {}),
  }
}
