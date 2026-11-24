package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import workbench.collaboration.application.port.ExternalNotificationRepository;
import workbench.collaboration.application.port.ExternalNotificationRepository.NewDelivery;
import workbench.collaboration.application.port.NotificationPreferenceRepository;
import workbench.collaboration.infrastructure.config.WorkbenchProperties;
import workbench.collaboration.infrastructure.notification.SafeNotificationBuilder;
import workbench.collaboration.interfaces.dto.InboxDtos.NotificationPreferences;

import java.util.UUID;

/**
 * 模块：外部 IM 轻通知同事务入队与消噪助手 (ExternalNotificationEnqueuer)
 *
 * <p>【功能定义】
 * 在业务写事务内把需触达的元数据写入 {@code wb_external_notification_delivery}，
 * 并按接收人合批等待窗口计算初始 {@code available_at}；
 * 当待办被接手、完结或成员移出时，立即取消同对象未发出的 pending 记录（消噪）。
 *
 * <p>【安全与故障隔离底线】
 * 本类仅写本地表记录，绝不发起任何外部 HTTP/IM 网络请求；入队前即对标题执行单行白名单清洗截断。
 */
@Service
public class ExternalNotificationEnqueuer {

    public static final String SKIP_ALREADY_RESOLVED = "already_resolved";

    private final ExternalNotificationRepository repository;
    private final NotificationPreferenceRepository preferences;
    private final WorkbenchProperties properties;

    public ExternalNotificationEnqueuer(ExternalNotificationRepository repository,
                                        NotificationPreferenceRepository preferences,
                                        WorkbenchProperties properties) {
        this.repository = repository;
        this.preferences = preferences;
        this.properties = properties;
    }

    /**
     * 在当前业务写事务内入队一条任务类外部轻通知；若触发人与接收人为同一人则自动跳过。
     */
    public void enqueueTaskEvent(
            String workspaceId,
            String projectId,
            String taskId,
            String eventType,
            String recipientUserId,
            String actorUserId,
            int urgency,
            String rawTitle,
            long nowMs
    ) {
        if (recipientUserId == null || recipientUserId.isEmpty() || recipientUserId.equals(actorUserId)) {
            return;
        }
        int mergeWindowSec = preferences.findByUserId(recipientUserId)
                .map(NotificationPreferences::mergeWindowSec)
                .orElse(properties.getNotifications().getExternal().getDefaultMergeWindowSec());
        int clampedWindowSec = Math.max(0, Math.min(600, mergeWindowSec));
        int maxAttempts = Math.max(1, properties.getNotifications().getExternal().getMaxAttempts());

        String cleanProjectId = projectId == null ? "" : projectId;
        String cleanTitle = SafeNotificationBuilder.sanitizeTitle(rawTitle);
        String mergeKey = cleanProjectId + ":" + eventType;
        long availableAtMs = nowMs + clampedWindowSec * 1000L;

        repository.enqueue(new NewDelivery(
                UUID.randomUUID().toString(),
                recipientUserId,
                workspaceId,
                cleanProjectId,
                eventType,
                taskId,
                actorUserId,
                urgency,
                cleanTitle,
                mergeKey,
                maxAttempts,
                availableAtMs,
                nowMs
        ));
    }

    /** 任务终结或退回后，取消针对该任务尚未发出的全部待投递记录。 */
    public void cancelPendingForTask(String taskId, long nowMs) {
        repository.cancelPendingByObject(taskId, SKIP_ALREADY_RESOLVED, nowMs);
    }

    /** 受让人开始处理任务（如 todo→doing 或离职转交）时，取消原针对该用户的待投递记录。 */
    public void cancelPendingForTaskAndUser(String taskId, String userId, long nowMs) {
        if (userId == null || userId.isEmpty()) return;
        repository.cancelPendingByObjectAndUser(taskId, userId, SKIP_ALREADY_RESOLVED, nowMs);
    }

    /** 成员被移出团队时，取消该成员在该团队下的全部待投递外部通知。 */
    public void cancelPendingForWorkspaceMember(String workspaceId, String userId, long nowMs) {
        if (userId == null || userId.isEmpty()) return;
        repository.cancelPendingByWorkspaceAndUser(workspaceId, userId, SKIP_ALREADY_RESOLVED, nowMs);
    }
}
