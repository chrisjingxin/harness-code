package workbench.collaboration.interfaces.dto;

import java.util.List;
import java.util.Map;

/** 团队角色和离职交接的封闭线上形状；职责来自数据库，客户端只提交选择。 */
public final class WorkspaceDtos {
    private WorkspaceDtos() {}
    public record WorkspaceAccess(String workspaceId, String role, long memberVersion, long accessVersion) {}
    public record WorkspaceMemberAddRequest(String userNo, String requestId) {}
    public record WorkspaceRoleChangeRequest(String role, long expectedVersion, String requestId) {}
    public record WorkspaceMemberChangeResponse(PlatformDtos.MemberSummary member, long accessVersion) {}
    public record ProjectSuccessor(String projectId, String userId) {}
    public record TaskSuccessor(String taskId, String userId) {}
    public record RepositorySuccessor(String repositoryId, String userId) {}
    public record WorkspaceMemberRemovalRequest(String requestId, long expectedMemberVersion, String previewVersion,
            String defaultSuccessorUserId, List<ProjectSuccessor> projectSuccessors, List<TaskSuccessor> taskSuccessors,
            List<RepositorySuccessor> repositorySuccessors, List<ProjectSuccessor> addToProjects,
            boolean confirmResetTasks, boolean confirmRetainHistory) {}
    public record ProjectEligibility(String projectId, List<String> activeSuccessorUserIds) {}
    public record WorkspaceRemovalPreview(String workspaceId, PlatformDtos.MemberSummary targetMember,
            long accessVersion, int effectiveAdminCount, String previewVersion, List<Map<String,Object>> items,
            String nextAfterId, Map<String,Integer> counts, List<ProjectEligibility> projectEligibility) {}
    public record WorkspaceMemberRemovalResponse(String workspaceId, PlatformDtos.MemberSummary member,
            long accessVersion, String requestId, int transferredTaskCount, int transferredProjectCount,
            int transferredRepositoryCount, int unclaimedRepositoryCount, int stoppedConversationCount) {}
}
