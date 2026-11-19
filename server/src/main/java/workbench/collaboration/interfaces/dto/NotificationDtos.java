package workbench.collaboration.interfaces.dto;

import java.util.List;

/** 用户级通知只携带资源标识。分页和 SSE 共用同一游标。 */
public final class NotificationDtos {
    private NotificationDtos() {}

    public record NotificationEvent(long id, String eventId, String type, String objectId,
                                    String projectId, long occurredAtMs) {}
    public record NotificationPage(List<NotificationEvent> events, long nextAfterId, boolean hasMore) {}
}
