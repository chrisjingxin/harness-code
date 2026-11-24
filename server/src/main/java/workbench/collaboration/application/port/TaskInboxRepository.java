package workbench.collaboration.application.port;

import java.util.List;
import java.util.Optional;

/**
 * 模块：跨团队任务收件箱只读查询端口 (TaskInboxRepository)
 *
 * <p>【功能定义】
 * 为 TaskInboxSource 提供跨 Workspace / Project 的任务现态投影查询，
 * 屏蔽底层 SQL 关联细节并便于单元测试注入内存假实现。
 */
public interface TaskInboxRepository {

    /**
     * 任务投影只读行：包含项目归属、负责人、创建人团队在职状态及任务关键状态，不含任务正文。
     */
    record InboxTaskRow(
            String taskId,
            String workspaceId,
            String projectId,
            String projectName,
            String projectOwnerUserId,
            int projectStatus,
            String title,
            String creatorId,
            boolean creatorActiveInWorkspace,
            String assigneeId,
            int taskStatus,
            long updatedAtMs
    ) {}

    /** 查询指定用户（启用且为活跃团队/项目成员）相关的可见任务行；workspaceIdFilter 可为 null。 */
    List<InboxTaskRow> listVisibleTasksForUser(String userId, String workspaceIdFilter);

    /** 精确查询指定任务对指定用户的可见现态；用于发送前现态复核。 */
    Optional<InboxTaskRow> findVisibleTaskForUser(String userId, String workspaceId, String projectId, String taskId);
}
