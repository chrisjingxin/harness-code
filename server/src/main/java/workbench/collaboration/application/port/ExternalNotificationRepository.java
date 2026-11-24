package workbench.collaboration.application.port;

import java.util.List;
import java.util.Optional;

/**
 * 模块：外部通知异步出站队列仓储端口 (ExternalNotificationRepository)
 *
 * <p>【功能定义】
 * 对应 `wb_external_notification_delivery` 表的同事务入队、未发消噪、并发抢占与投递终态落库，
 * 支撑单元测试在不依赖物理数据库的情况下完整验证调度引擎状态机。
 */
public interface ExternalNotificationRepository {

    int STATUS_PENDING = 1;
    int STATUS_SENDING = 2;
    int STATUS_SENT = 3;
    int STATUS_SKIPPED = 4;
    int STATUS_FAILED = 5;

    int URGENCY_NORMAL = 1;
    int URGENCY_URGENT = 2;

    record NewDelivery(
            String deliveryId,
            String userId,
            String workspaceId,
            String projectId,
            String eventType,
            String objectId,
            String actorId,
            int urgency,
            String titleSnapshot,
            String mergeKey,
            int maxAttempts,
            long availableAtMs,
            long occurredAtMs
    ) {}

    record DeliveryRecord(
            long rowId,
            String deliveryId,
            String userId,
            String workspaceId,
            String projectId,
            String eventType,
            String objectId,
            String actorId,
            int urgency,
            String titleSnapshot,
            String mergeKey,
            int status,
            String skipReason,
            int attemptCount,
            int maxAttempts,
            long availableAtMs,
            String lastError,
            long occurredAtMs
    ) {}

    /** 在业务写事务内登记一条待投递元数据。 */
    void enqueue(NewDelivery delivery);

    /** 业务对象进入终结态时，将同一对象尚未发出的 pending 记录立即标记跳过。 */
    int cancelPendingByObject(String objectId, String skipReason, long nowMs);

    /** 用户开始处理某待办（如接手任务或撤回/转移）时，取消针对该用户的 pending 记录。 */
    int cancelPendingByObjectAndUser(String objectId, String userId, String skipReason, long nowMs);

    /** 用户被移出团队时，取消该用户在该团队下所有 pending 外部通知。 */
    int cancelPendingByWorkspaceAndUser(String workspaceId, String userId, String skipReason, long nowMs);

    /** 抢占一批到达可投递时间的 pending 记录（条件更新置为 sending，防止多实例重复投递）。 */
    List<DeliveryRecord> claimDueBatch(long nowMs, int limit);

    /** 抢占同 (userId, mergeKey) 下已到期或处于合批等待窗内的其余 pending 记录，实现防抖合并。 */
    List<DeliveryRecord> claimPendingInMergeGroup(String userId, String mergeKey, long nowMs);

    Optional<DeliveryRecord> findByDeliveryId(String deliveryId);

    void markSent(List<Long> rowIds, long nowMs);

    void markSkipped(List<Long> rowIds, String skipReason, long nowMs);

    /** 命中免打扰时段时顺延至免打扰结束时刻，不消耗重试次数。 */
    void markDeferred(List<Long> rowIds, long nextAvailableAtMs, long nowMs);

    void markRetry(List<Long> rowIds, int nextAttemptCount, long nextAvailableAtMs, String lastError, long nowMs);

    void markFailed(List<Long> rowIds, int attemptCount, String lastError, long nowMs);
}
