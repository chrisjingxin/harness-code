package workbench.collaboration.interfaces.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** 项目 Task 的 HTTP 形状。材料只存可回读的固定版本标识。 */
public final class TaskDtos {
    private TaskDtos() {}

    public record KnowledgeRef(String knowledgeId, String versionId) {}
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record TaskCreateRequest(String title, String description, String assigneeId, String requestId,
                                    List<String> snapshotIds, List<KnowledgeRef> knowledgeRefs) {}
    public record TaskPatchRequest(String description, long expectedVersion, String requestId) {}
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record TaskTransitionRequest(String targetStatus, long expectedVersion, String requestId,
                                        String note, String commitSha) {}
    public record TaskConversationRequest(String conversationId, long expectedVersion, String requestId) {}

    public record TaskSummary(String taskId, String projectId, String title, String creatorId, String assigneeId,
                              String status, long version, String conversationId, long createdAtMs, long updatedAtMs) {}
    public record TaskTransition(String kind, String actorId, String fromStatus, String toStatus, long version,
                                 String note, String commitSha, long occurredAtMs, TaskHandoff handoff) {}
    public record TaskHandoff(String fromAssigneeId,String toAssigneeId,String previousConversationId) {}
    public record TaskDetail(TaskSummary task, String description, List<String> snapshotIds,
                             List<KnowledgeRef> knowledgeRefs, List<TaskTransition> transitions) {}
    public record TaskListResponse(List<TaskSummary> tasks, String nextAfterId) {}
}
