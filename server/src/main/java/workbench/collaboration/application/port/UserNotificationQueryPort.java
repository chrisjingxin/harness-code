package workbench.collaboration.application.port;

import workbench.collaboration.interfaces.dto.NotificationDtos.UserNotificationEvent;

import java.util.List;

/**
 * 模块：用户级跨团队轻量通知查询端口 (UserNotificationQueryPort)
 *
 * <p>【功能定义】
 * 为跨团队通知分页、SSE 游标推进及 Inbox 初始通知水位读取提供统一访问端口，
 * 每次查询均在线复核用户启用状态、团队活跃成员及项目活跃成员资格。
 */
public interface UserNotificationQueryPort {

    /** 跨所有有效团队按全局 outbox id 递增翻页读取用户可见通知。 */
    List<UserNotificationEvent> afterForUser(String userId, long cursor, int limit);

    /** 按单个团队独立游标递增读取用户在该团队内可见通知，避免跨团队提交 id 交错漏读。 */
    List<UserNotificationEvent> afterInWorkspace(String workspaceId, String userId, long cursor, int limit);

    /** 查询用户当前所有可见通知中的最大 outbox id（无记录时返回 0）。 */
    long latestCursorForUser(String userId);
}
