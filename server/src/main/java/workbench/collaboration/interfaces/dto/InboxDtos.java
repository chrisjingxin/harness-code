package workbench.collaboration.interfaces.dto;

import java.util.List;

/**
 * 模块：全局待办收件箱与用户通知偏好契约 DTO (InboxDtos)
 *
 * <p>【功能定义】
 * 定义 `/api/v1/me/inbox` 与 `/api/v1/me/notification-preferences` 端点的序列化模型，
 * 严格对齐 `contracts/schema/collaboration.schema.json`。
 */
public final class InboxDtos {
    private InboxDtos() {}

    public record InboxItem(
            String itemKey,
            String sourceType,
            String category,
            String urgency,
            String workspaceId,
            String projectId,
            String projectName,
            String objectId,
            String title,
            String status,
            String actorId,
            boolean delegated,
            long updatedAtMs
    ) {}

    public record InboxCounts(int actionRequired, int urgent, int sent) {}

    public record InboxWorkspaceSummary(String workspaceId, String name, String slug) {}

    public record InboxActorSummary(String userId, String userNo, String name, boolean active) {}

    public record InboxResponse(
            String bucket,
            List<InboxItem> items,
            InboxCounts counts,
            long notificationCursor,
            List<InboxWorkspaceSummary> workspaces,
            List<InboxActorSummary> actors,
            boolean truncated
    ) {}

    public record NotificationPreferences(
            boolean externalEnabled,
            List<String> subscribedEvents,
            boolean dndEnabled,
            int dndStartMinute,
            int dndEndMinute,
            String dndTimezone,
            int mergeWindowSec,
            long version
    ) {}

    public record NotificationPreferencesUpdateRequest(
            boolean externalEnabled,
            List<String> subscribedEvents,
            boolean dndEnabled,
            int dndStartMinute,
            int dndEndMinute,
            String dndTimezone,
            int mergeWindowSec,
            long expectedVersion
    ) {}
}
