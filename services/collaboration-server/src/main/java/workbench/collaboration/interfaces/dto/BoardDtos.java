package workbench.collaboration.interfaces.dto;

import java.util.List;

/** 看板按人汇总项目内简报和任务。成员行引用同一返回内的摘要 ID。 */
public final class BoardDtos {
    private BoardDtos() {}

    public record BoardMember(String userId, String name, String status, boolean deviceOnline,
                              List<String> conversationIds, List<String> receivedTaskIds, List<String> sentTaskIds) {}
    public record BoardConversation(ConversationDtos.ConversationSummary conversation, boolean deviceOnline) {}
    public record BoardResponse(String projectId, List<BoardMember> members, List<BoardConversation> conversations,
                                List<TaskDtos.TaskSummary> tasks, boolean conversationsTruncated, boolean tasksTruncated) {}
}
