/** 对话区入口；根包导出由统筹按停点顺序集成。 */
export { ConversationView } from "./view.js"
export { ConversationComposer } from "./composer.js"
export { ComposerImagesBar, MessageImagesBar } from "./image-attachments.js"
export { preparePastedImage } from "./image-compression.js"
export {
  IMAGE_ATTACHMENT_MAX_EDGE,
  fitImageAttachmentSize,
  formatImageByteSize,
  formatImageDimensions,
  inferImageMimeFromName,
} from "./image-sizing.js"
export { ConversationToolBlocks } from "./tool-blocks.js"
export { SelectionToolbar, resolveFileSelectionSource } from "./selection-toolbar.js"
export {
  ANNOTATION_BLOCK_HEADER,
  ANNOTATION_SECTION_SEPARATOR,
  MAX_DRAFT_ANNOTATIONS,
  MAX_DRAFT_ANNOTATION_COMMENT_CHARS,
  MAX_DRAFT_ANNOTATION_SOURCE_CHARS,
  MAX_DRAFT_ANNOTATION_TEXT_CHARS,
  MAX_QUEUED_PROMPT_CHARS,
  composeAnnotatedPrompt,
  computeLineRangeFromOffsets,
  normalizeAnnotationComment,
  normalizeAnnotationSelectedText,
  normalizeAnnotationSourceLabel,
  parseAnnotatedUserMessage,
} from "./annotations-codec.js"
export {
  applyLeadingSlashCommand,
  insertMentionTrigger,
  mergeAttachmentPaths,
  removeLeadingCommandOnBackspace,
  splitComposerHighlightSegments,
} from "./mention-policy.js"
export type { ComposerHighlightSegment } from "./mention-policy.js"
export type {
  ConversationActions,
  ConversationAvailability,
  ConversationComposerContextBar,
  ConversationComposerView,
  ConversationContextActionItem,
  ConversationContextMenuIcon,
  ConversationContextMenuItem,
  ConversationContextMenuView,
  ConversationDirectoryContextView,
  ConversationDraft,
  ConversationDraftAnnotation,
  ConversationDraftImage,
  ConversationFileCandidate,
  ConversationFileCandidateRequest,
  ConversationFileCandidateResult,
  ConversationFileLineRange,
  ConversationGitContextView,
  ConversationInteractionAnswer,
  ConversationInteractionView,
  ConversationMentionOrigin,
  ConversationMenuItemView,
  ConversationMessageAttachment,
  ConversationPersonalChange,
  ConversationPersonalState,
  ConversationProjectTarget,
  ConversationReferenceView,
  ConversationScope,
  ConversationSelectionAnnotation,
  ConversationSendResult,
  ConversationCollaborationCandidate,
  ConversationCollaborationCandidateResult,
  ConversationTimelineActivity,
  ConversationTimelineChange,
  ConversationTimelineEntry,
  ConversationTimelineProps,
  ConversationTimelineScroll,
  ConversationTimelineState,
  ConversationToolBlock,
  ConversationToolDetailView,
  ConversationViewProps,
} from "./types.js"
