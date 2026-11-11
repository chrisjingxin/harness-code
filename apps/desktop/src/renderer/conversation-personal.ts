/** 会话草稿和阅读位置只由当前窗口按完整作用域保存。 */
import type { ConversationPersonalChange, ConversationPersonalState } from "@workbench/ui"

export const emptyConversationPersonal: ConversationPersonalState = {
  scroll: { anchorEntryId: null, offsetPx: 0, following: true, seenContentRevision: null },
  expandedTools: [],
  expandedOutputs: [],
  draft: { text: "", selectionStart: 0, selectionEnd: 0, revision: 0, referenceIds: [], attachmentIds: [] },
  interactions: {},
}

/** 局部更新只修改对应字段，避免滚动事件覆盖草稿。 */
export function updateConversationPersonal(current: ConversationPersonalState, change: ConversationPersonalChange): ConversationPersonalState {
  if (change.kind === "scroll") return { ...current, scroll: change.value }
  if (change.kind === "tool" || change.kind === "output") {
    const field = change.kind === "tool" ? "expandedTools" : "expandedOutputs"
    const existing = current[field]
    const selected = change.expanded
      ? existing.includes(change.entryId) ? existing : [...existing, change.entryId]
      : existing.filter(id => id !== change.entryId)
    return { ...current, [field]: selected }
  }
  if (change.kind === "interaction") {
    const interactions = { ...current.interactions }
    if (change.answer === null) delete interactions[change.interactionId]
    else interactions[change.interactionId] = change.answer
    return { ...current, interactions }
  }
  const draft = current.draft
  if (change.kind === "draft-text") {
    const selectionStart = Math.max(0, Math.min(change.text.length, change.selectionStart))
    const selectionEnd = Math.max(selectionStart, Math.min(change.text.length, change.selectionEnd))
    return {
      ...current,
      draft: { ...draft, text: change.text, selectionStart, selectionEnd, revision: draft.revision + (change.text === draft.text ? 0 : 1) },
    }
  }
  if (change.kind === "draft-references" || change.kind === "draft-attachments") {
    const field = change.kind === "draft-references" ? "referenceIds" : "attachmentIds"
    const next = change.kind === "draft-references" ? change.referenceIds : change.attachmentIds
    if (draft[field].length === next.length && draft[field].every((id, index) => id === next[index])) return current
    return { ...current, draft: { ...draft, [field]: [...next], revision: draft.revision + 1 } }
  }
  if (change.kind === "clear-draft" && draft.revision === change.expectedRevision) {
    return { ...current, draft: { ...emptyConversationPersonal.draft, revision: draft.revision + 1 } }
  }
  return current
}
