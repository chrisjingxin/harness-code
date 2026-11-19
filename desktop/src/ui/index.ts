/** 通用桌面基础视图的公开入口；宿主原生能力由 props 注入。 */
export { IdentityPanel } from "./identity/identity-panel.js"
export { useCollaborationIdentity } from "./identity/use-collaboration-identity.js"
export { BrandMark, RoleAvatar } from "./common/brand.js"
export { ACCENT_OPTIONS, DEFAULT_ACCENT, isAccentId } from "./theme/accent.js"
export type { AccentId } from "./theme/accent.js"
export { formatDuration, formatElapsed, formatUsage, formatContext } from "./common/formatters.js"
export { Markdown } from "./rendering/markdown.js"
export { CodeBlock } from "./rendering/code-block.js"
export { HighlightedCode } from "./rendering/highlighted-code.js"
export { renderSpans } from "./rendering/render-spans.js"
export { useSyntaxHighlight } from "./rendering/syntax/use-syntax-highlight.js"
export { resolveLanguage, resolveLanguageForPath } from "./rendering/syntax/language-catalog.js"
export type { RenderingActions, MarkdownProps, CodeBlockProps } from "./rendering/types.js"
export type { SyntaxScope, SyntaxSpan } from "./rendering/syntax/protocol.js"
export type { HighlightResult } from "./rendering/syntax/use-syntax-highlight.js"
export type { LanguageId } from "./rendering/syntax/language-catalog.js"
export { FileTypeIcon, fileIconFor } from "./common/file-type-icon.js"
export type { FileIconType, FileIconSpec } from "./common/file-type-icon.js"
export { parseFileDiff, alignFileDiffHunk } from "./rendering/file-diff.js"
export type { FileDiffLineKind, FileDiffLine, FileDiffHunk, ParsedFileDiff, FileDiffSplitRow } from "./rendering/file-diff.js"
export { ProjectDock, ProjectFileTab, ProjectFilePanel } from "./project/index.js"
export type {
  ProjectFilePanelProps, ProjectFileTabProps, ProjectScope, ProjectAvailability, ProjectActionAvailability,
  ProjectTreeRow, ProjectTreeView, ProjectFileContent, ProjectFileTargetLine, ProjectFileView, ProjectChangedFile, ProjectChangesView,
  ProjectGates, ProjectPersonalView, ProjectActions, ProjectDockProps, ProjectGitCommitItem,
} from "./project/index.js"
export { ConversationComposer, ConversationView, ConversationToolBlocks } from "./conversation/index.js"
export type {
  ConversationActions, ConversationAvailability, ConversationComposerView, ConversationDraft,
  ConversationFileCandidate, ConversationFileCandidateRequest, ConversationFileCandidateResult,
  ConversationFileLineRange, ConversationInteractionAnswer, ConversationInteractionView,
  ConversationMentionOrigin, ConversationMenuItemView, ConversationPersonalChange, ConversationPersonalState, ConversationProjectTarget,
  ConversationReferenceView, ConversationScope, ConversationSendResult, ConversationCollaborationCandidate, ConversationCollaborationCandidateResult,
  ConversationTimelineActivity,
  ConversationTimelineEntry, ConversationTimelineScroll, ConversationToolBlock, ConversationToolDetailView,
  ConversationViewProps,
} from "./conversation/index.js"
export { MemberAvatar, ProjectNavigation, buildMemberGroups } from "./navigation/index.js"
export type {
  MemberGroupInput, NavigationAvailability, NavigationMember, NavigationMemberGroup, NavigationPageKind,
  NavigationProjectItem, NavigationRetryArea, NavigationSessionEntry, NavigationWorkspaceItem,
  ProjectNavigationActions, ProjectNavigationProps, ProjectNavigationView,
} from "./navigation/index.js"
export { WorkbenchLayout } from "./layout/index.js"
export type { CollaborationContextView, WorkbenchLayoutProps, WorkbenchPanelMode, WorkbenchRightSlot } from "./layout/index.js"
