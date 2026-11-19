package workbench.collaboration.application.port;

import java.util.Map;

/**
 * 模块：领域事件通知出站端口 (NotificationPort)
 *
 * <p>【功能定义】
 * 会话等聚合在状态推进后向外广播"某物变了"的轻量事件载荷。
 * 载荷只携带对象 ID 与摘要字段，绝不携带消息正文或本地路径。
 * 写事务中保存持久通知，业务提交后再唤醒在线流。下游实现为 StoredNotificationPort。
 */
public interface NotificationPort {

    /**
     * 广播一条领域事件。
     *
     * @param eventType 事件类型（如 "conversation.brief_updated"）
     * @param subjectId 事件主体标识（如会话 ID）
     * @param payload 路由字段（workspaceId、actorId、可选 projectId 及任务两方 ID），正文禁止进入端口
     */
    void publish(String eventType, String subjectId, Map<String, Object> payload);
}
