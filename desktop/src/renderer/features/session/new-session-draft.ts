/** 新建草稿在个人记录与公共输入之间的投影，恢复旧记录时保留目录和原文。 */
import type { ConversationDraft } from "../../../ui/index.js"
import type { ProjectDraftPersonal } from "../../../shared/index.js"
import type { NewSessionDraft } from "./contracts.js"

export function restoreNewSessionDraft(saved: ProjectDraftPersonal | null): NewSessionDraft {
  const draftText = saved?.draftText ?? ""
  return {
    directoryPath: saved?.directoryPath ?? null,
    draftText,
    referenceIds: saved?.referenceIds ?? [],
    revision: saved?.revision ?? 0,
    selectionStart: Math.min(saved?.selectionStart ?? draftText.length, draftText.length),
    selectionEnd: Math.min(saved?.selectionEnd ?? draftText.length, draftText.length),
  }
}

export function newSessionConversationDraft(value: NewSessionDraft): ConversationDraft {
  return {
    text: value.draftText, referenceIds: value.referenceIds, revision: value.revision,
    selectionStart: value.selectionStart, selectionEnd: value.selectionEnd, attachmentIds: [],
  }
}
