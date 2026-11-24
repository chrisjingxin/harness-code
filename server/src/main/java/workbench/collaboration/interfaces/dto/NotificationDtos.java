package workbench.collaboration.interfaces.dto;

import java.util.List;

/** 用户级通知只携带资源标识。分页和 SSE 共用同一游标。 */
public final class NotificationDtos {
    private NotificationDtos() {}

    public record NotificationEvent(long id, String eventId, String type, String objectId,
                                    String projectId, long occurredAtMs) {}
    public record NotificationPage(List<NotificationEvent> events, long nextAfterId, boolean hasMore) {}

    /** 跨 Workspace 用户级轻量通知事件，携带 workspaceId 便于桌面全局收件箱精准路由。 */
    public record UserNotificationEvent(long id, String eventId, String workspaceId, String type,
                                        String objectId, String projectId, long occurredAtMs) {}
    public record UserNotificationPage(List<UserNotificationEvent> events, long nextAfterId, boolean hasMore) {}
}
