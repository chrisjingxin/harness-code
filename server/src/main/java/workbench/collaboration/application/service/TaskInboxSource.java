package workbench.collaboration.application.service;

import org.springframework.stereotype.Component;
import workbench.collaboration.application.port.InboxActionabilityChecker;
import workbench.collaboration.application.port.InboxItemSource;
import workbench.collaboration.application.port.TaskInboxRepository;
import workbench.collaboration.application.port.TaskInboxRepository.InboxTaskRow;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.task.TaskStatus;
import workbench.collaboration.interfaces.dto.InboxDtos.InboxItem;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * 模块：任务域全局收件箱来源与现态复核实现 (TaskInboxSource)
 *
 * <p>【功能定义】
 * 将跨 Workspace / 跨 Project 的 Task 业务表实时投影为全局 Inbox 条目：
 * - action_required（待我处理，仅统计活跃项目，不含 doing）：
 *   1) review 状态且本人为创建人（或原创建人已离开团队/停用且本人为 Project owner 代管）→ urgent；
 *   2) todo 状态且本人为受让人 → normal；
 * - sent（我发起的，仅活跃项目）：本人创建且指派给他人的 todo / doing / review；
 * - resolved（已处理，含已归档项目）：最近 30 天内更新的 done / cancelled 任务。
 *
 * <p>【协作边界】
 * - 上游调用方：InboxAppService（收件箱聚合）、停点 2 外部通知调度器（现态复核）。
 * - 下游依赖方：TaskInboxRepository。
 */
@Component
public class TaskInboxSource implements InboxItemSource, InboxActionabilityChecker {

    public static final String SOURCE_TYPE = "task";
    static final long RESOLVED_WINDOW_MS = 30L * 86_400_000L;

    private final TaskInboxRepository tasks;

    public TaskInboxSource(TaskInboxRepository tasks) {
        this.tasks = tasks;
    }

    @Override
    public String sourceType() {
        return SOURCE_TYPE;
    }

    @Override
    public List<InboxItem> listForUser(String userId, InboxSourceQuery query) {
        List<InboxTaskRow> rows = tasks.listVisibleTasksForUser(userId, query.workspaceIdFilter());
        List<InboxItem> items = new ArrayList<>();
        long resolvedCutoff = query.nowMs() - RESOLVED_WINDOW_MS;

        for (InboxTaskRow row : rows) {
            boolean activeProject = row.projectStatus() == ProjectStatus.ACTIVE.db();
            switch (query.bucket()) {
                case "action_required" -> {
                    if (!activeProject) continue;
                    // doing 属于本人正在推进的日常任务，不计入需要拍板的待办角标。
                    if (row.taskStatus() == TaskStatus.REVIEW.code && canReview(userId, row)) {
                        items.add(toItem(row, "task_review", "urgent", TaskStatus.REVIEW.wire,
                                row.assigneeId(), !row.creatorId().equals(userId)));
                    } else if (row.taskStatus() == TaskStatus.TODO.code && row.assigneeId().equals(userId)) {
                        items.add(toItem(row, "task_assigned", "normal", TaskStatus.TODO.wire,
                                row.creatorId(), false));
                    }
                }
                case "sent" -> {
                    if (!activeProject) continue;
                    if (row.creatorId().equals(userId) && !row.assigneeId().equals(userId)) {
                        String category = sentCategory(row.taskStatus());
                        if (category != null) {
                            items.add(toItem(row, category, "normal", TaskStatus.fromCode(row.taskStatus()).wire,
                                    row.assigneeId(), false));
                        }
                    }
                }
                case "resolved" -> {
                    if ((row.taskStatus() == TaskStatus.DONE.code || row.taskStatus() == TaskStatus.CANCELLED.code)
                            && row.updatedAtMs() >= resolvedCutoff
                            && canSeeResolved(userId, row)) {
                        String actorId = row.creatorId().equals(userId) ? row.assigneeId() : row.creatorId();
                        boolean delegated = !row.creatorId().equals(userId) && !row.assigneeId().equals(userId);
                        items.add(toItem(row, "task_resolved", "normal", TaskStatus.fromCode(row.taskStatus()).wire,
                                actorId, delegated));
                    }
                }
                default -> {}
            }
        }
        return items;
    }

    @Override
    public boolean supports(String eventType) {
        return "task.assigned".equals(eventType)
                || "task.review_requested".equals(eventType)
                || "task.returned".equals(eventType);
    }

    @Override
    public boolean isStillActionable(String userId, String workspaceId, String projectId, String eventType, String objectId) {
        if (!supports(eventType) || projectId == null || projectId.isEmpty()) {
            return false;
        }
        Optional<InboxTaskRow> found = tasks.findVisibleTaskForUser(userId, workspaceId, projectId, objectId);
        if (found.isEmpty()) {
            return false;
        }
        InboxTaskRow row = found.get();
        if (row.projectStatus() != ProjectStatus.ACTIVE.db()) {
            return false;
        }
        return switch (eventType) {
            case "task.assigned", "task.returned" ->
                    row.taskStatus() == TaskStatus.TODO.code && row.assigneeId().equals(userId);
            case "task.review_requested" ->
                    row.taskStatus() == TaskStatus.REVIEW.code && canReview(userId, row);
            default -> false;
        };
    }

    private static boolean canReview(String userId, InboxTaskRow row) {
        return row.creatorId().equals(userId)
                || (!row.creatorActiveInWorkspace() && row.projectOwnerUserId().equals(userId));
    }

    private static boolean canSeeResolved(String userId, InboxTaskRow row) {
        return row.assigneeId().equals(userId) || canReview(userId, row);
    }

    private static String sentCategory(int statusCode) {
        if (statusCode == TaskStatus.TODO.code) return "task_assigned";
        if (statusCode == TaskStatus.DOING.code) return "task_in_progress";
        if (statusCode == TaskStatus.REVIEW.code) return "task_review";
        return null;
    }

    private static InboxItem toItem(InboxTaskRow row, String category, String urgency, String statusWire,
                                    String actorId, boolean delegated) {
        return new InboxItem(
                SOURCE_TYPE + ":" + row.taskId(),
                SOURCE_TYPE,
                category,
                urgency,
                row.workspaceId(),
                row.projectId(),
                row.projectName(),
                row.taskId(),
                row.title(),
                statusWire,
                actorId,
                delegated,
                row.updatedAtMs()
        );
    }
}
