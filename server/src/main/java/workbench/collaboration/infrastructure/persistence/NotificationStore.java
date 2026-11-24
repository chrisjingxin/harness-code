package workbench.collaboration.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.application.port.UserNotificationQueryPort;
import workbench.collaboration.interfaces.dto.NotificationDtos.NotificationEvent;
import workbench.collaboration.interfaces.dto.NotificationDtos.UserNotificationEvent;

import javax.sql.DataSource;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 轻量通知事务发件箱。事务内锁团队行 → 按接收人保存 → 提交后外部可读。
 * 同团队先分配的游标必先提交，客户端推进游标时不会漏掉晚提交的旧编号。
 */
@Repository
public class NotificationStore implements UserNotificationQueryPort {
    private static final RowMapper<UserNotificationEvent> USER_EVENT = (row, index) -> {
        String project = trim(row.getString("project_id"));
        return new UserNotificationEvent(
                row.getLong("id"),
                trim(row.getString("event_id")),
                trim(row.getString("workspace_id")),
                trim(row.getString("event_type")),
                trim(row.getString("object_id")),
                project.isEmpty() ? null : project,
                Times.ms(row.getObject("created_at", LocalDateTime.class))
        );
    };

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }
    private final JdbcTemplate jdbc;

    public NotificationStore(DataSource dataSource) {
        this.jdbc = new JdbcTemplate(dataSource);
    }

    /** 当前合格接收人。任务相关性限两位角色，其他项目事件面向在册成员。 */
    public List<String> recipients(String workspace, String project, String actor, String creator, String assignee) {
        return jdbc.queryForList("""
                SELECT m.user_id FROM wb_workspace_member m
                JOIN wb_user u ON u.user_id=m.user_id AND u.enabled=1
                WHERE m.workspace_id=? AND m.status=1 AND m.user_id<>?
                  AND (?='' OR EXISTS (SELECT 1 FROM wb_project_member p
                       WHERE p.project_id=? AND p.user_id=m.user_id AND p.status=1))
                  AND (?='' OR m.user_id=? OR m.user_id=?)
                """, String.class, workspace, actor, project, project, creator, creator, assignee);
    }

    /** 调用方必须已开启业务事务。同一事件对同一用户只写入一次。 */
    public void append(String workspace, String project, String eventId, String type, String subject, long now,
                       List<String> recipients) {
        jdbc.queryForObject("SELECT id FROM wb_workspace WHERE workspace_id=? FOR UPDATE", Long.class, workspace);
        jdbc.batchUpdate("""
                INSERT INTO wb_notification_outbox (workspace_id, user_id, project_id, event_id, event_type,
                                                     object_id, created_at) VALUES (?,?,?,?,?,?,?)
                ON DUPLICATE KEY UPDATE event_id=wb_notification_outbox.event_id
                """, recipients.stream().map(user -> new Object[] {
                        workspace, user, project, eventId, type, subject, Times.ofMs(now)
                }).toList());
    }

    /** 读取时再次校验项目在册资格。移出项目后，旧通知也不会被补发。 */
    public List<NotificationEvent> after(String workspace, String user, long cursor, int limit) {
        return jdbc.query("""
                SELECT n.id, n.event_id, n.event_type, n.object_id, n.project_id, n.created_at
                FROM wb_notification_outbox n WHERE n.workspace_id=? AND n.user_id=? AND n.id>?
                  AND (n.project_id='' OR EXISTS (SELECT 1 FROM wb_project_member p
                       WHERE p.project_id=n.project_id AND p.user_id=n.user_id AND p.status=1))
                ORDER BY n.id LIMIT ?
                """, (row, index) -> {
            String project = trim(row.getString("project_id"));
            return new NotificationEvent(
                    row.getLong("id"),
                    trim(row.getString("event_id")),
                    trim(row.getString("event_type")),
                    trim(row.getString("object_id")),
                    project.isEmpty() ? null : project,
                    Times.ms(row.getObject("created_at", LocalDateTime.class))
            );
        }, workspace, user, cursor, limit);
    }

    /** 跨所有有效团队按全局游标翻页读取用户可见通知，每次查询在线核对团队及项目活跃成员资格。 */
    @Override
    public List<UserNotificationEvent> afterForUser(String userId, long cursor, int limit) {
        return jdbc.query("""
                SELECT n.id, n.event_id, n.workspace_id, n.event_type, n.object_id, n.project_id, n.created_at
                FROM wb_notification_outbox n
                JOIN wb_workspace_member wm ON wm.workspace_id = n.workspace_id AND wm.user_id = n.user_id AND wm.status = 1
                JOIN wb_user u ON u.user_id = n.user_id AND u.enabled = 1
                WHERE n.user_id = ? AND n.id > ?
                  AND (n.project_id = '' OR EXISTS (
                    SELECT 1 FROM wb_project_member p
                    WHERE p.project_id = n.project_id AND p.user_id = n.user_id AND p.status = 1
                  ))
                ORDER BY n.id LIMIT ?
                """, USER_EVENT, userId, cursor, limit);
    }

    /** 按指定团队独立游标读取可见通知，消除跨团队事务提交 id 交错导致的漏读风险。 */
    @Override
    public List<UserNotificationEvent> afterInWorkspace(String workspaceId, String userId, long cursor, int limit) {
        return jdbc.query("""
                SELECT n.id, n.event_id, n.workspace_id, n.event_type, n.object_id, n.project_id, n.created_at
                FROM wb_notification_outbox n
                JOIN wb_workspace_member wm ON wm.workspace_id = n.workspace_id AND wm.user_id = n.user_id AND wm.status = 1
                JOIN wb_user u ON u.user_id = n.user_id AND u.enabled = 1
                WHERE n.workspace_id = ? AND n.user_id = ? AND n.id > ?
                  AND (n.project_id = '' OR EXISTS (
                    SELECT 1 FROM wb_project_member p
                    WHERE p.project_id = n.project_id AND p.user_id = n.user_id AND p.status = 1
                  ))
                ORDER BY n.id LIMIT ?
                """, USER_EVENT, workspaceId, userId, cursor, limit);
    }

    /** 查询用户当前可见通知的最大 outbox id 水位，供全局 Inbox 初始化后续 SSE 起点。 */
    @Override
    public long latestCursorForUser(String userId) {
        Long cursor = jdbc.queryForObject("""
                SELECT COALESCE(MAX(n.id), 0)
                FROM wb_notification_outbox n
                JOIN wb_workspace_member wm ON wm.workspace_id = n.workspace_id AND wm.user_id = n.user_id AND wm.status = 1
                JOIN wb_user u ON u.user_id = n.user_id AND u.enabled = 1
                WHERE n.user_id = ?
                  AND (n.project_id = '' OR EXISTS (
                    SELECT 1 FROM wb_project_member p
                    WHERE p.project_id = n.project_id AND p.user_id = n.user_id AND p.status = 1
                  ))
                """, Long.class, userId);
        return cursor == null ? 0L : cursor;
    }
}
