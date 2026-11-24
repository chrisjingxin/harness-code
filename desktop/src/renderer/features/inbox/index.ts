/** 全局收件箱模块公开导出（方案 A 本机等待确认 + 跨团队待办 + 通知偏好）。 */
export {
  EXTERNAL_EVENT_OPTIONS,
  INBOX_BUCKETS,
  LOCAL_ATTENTION_LABELS,
  MERGE_WINDOW_OPTIONS,
  applyLocalExecutionNoticeToSignals,
  badgeToneForCategory,
  badgeToneForTaskStatus,
  classifyPermissionKind,
  collectLocalAttentionItems,
  formatDndWindow,
  formatInboxCategoryLabel,
  formatInboxTaskStatusLabel,
  formatRelativeTime,
  minutesToTimeString,
  resolveDeepLinkNavigation,
  resolveInboxTaskActions,
  resolveSelectedInboxItemKey,
  sanitizeSingleLineSummary,
  timeStringToMinutes,
} from "./inbox-model.js"
export type {
  DeepLinkNavigationDecision,
  InboxBadgeTone,
  InboxTaskActionPermissions,
  LocalAttentionItem,
  LocalAttentionKind,
  LocalAttentionSignal,
} from "./inbox-model.js"
export { useLocalAttention } from "./use-local-attention.js"
export { useInbox } from "./use-inbox.js"
export type { InboxStreamState } from "./use-inbox.js"
export { useInboxTaskDetail } from "./use-inbox-task-detail.js"
export { InboxPage } from "./inbox-page.js"
export type { InboxPageProps } from "./inbox-page.js"
export { NotificationPreferencesSection } from "./notification-preferences-section.js"
export type { NotificationPreferencesSectionProps } from "./notification-preferences-section.js"
