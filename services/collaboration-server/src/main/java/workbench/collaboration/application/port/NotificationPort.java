package workbench.collaboration.application.port;

import java.util.Map;

/**
 * 模块：领域事件通知出站端口 (NotificationPort)
 *
 * <p>【功能定义】
 * 会话等聚合在状态推进后向外广播"某物变了"的轻量事件载荷。
 * 载荷只携带对象 ID 与摘要字段，绝不携带消息正文或本地路径。
 * 本任务为 HC-212 看板通知流预留：事件语义与载荷形状在此定死，
 * 投递通道（wb.collab.notifications Kafka 主题 + SSE）由 HC-212 接通，
 * 当前实现为本地日志，不保证跨进程到达。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService（简报更新广播）及后续任务/知识域。
 * - 下游实现方：LoggingNotificationPort（本任务）、KafkaNotification（HC-212）。
 */
public interface NotificationPort {

    /**
     * 广播一条领域事件。
     *
     * @param eventType 事件类型（如 "conversation.brief_updated"）
     * @param subjectId 事件主体标识（如会话 ID）
     * @param payload 事件载荷（仅 ID 与摘要字段）
     */
    void publish(String eventType, String subjectId, Map<String, Object> payload);
}
