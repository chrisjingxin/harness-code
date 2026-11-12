package workbench.collaboration.interfaces.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * 模块：业务项目数据传输对象集 (ProjectDtos)
 *
 * <p>【功能定义】
 * 定义业务项目的创建/查询/变更、项目成员管理与项目仓库引用的传输形态。
 * 字段与 workbench-contracts 的 organization.schema.json 逐一对齐，
 * 成员列表保留 removed 行供"已离开项目"标注。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectController、ProjectAppService。
 * - 下游依赖方：Contracts 校验中心。
 */
public final class ProjectDtos {

    private ProjectDtos() {}

    /** 项目概要（列表项，附调用者角色与成员数） */
    public record ProjectSummary(
            String projectId,
            String workspaceId,
            String name,
            String description,
            String ownerUserId,
            String status,
            String role,
            int memberCount,
            long version,
            String createdAt,
            String updatedAt
    ) {}

    /** 项目创建/修改后的响应 */
    public record ProjectResponse(
            String projectId,
            String workspaceId,
            String name,
            String description,
            String ownerUserId,
            String status,
            long version,
            String createdAt,
            String updatedAt
    ) {}

    /** 项目成员概要：removed 成员携 leftAt 供客户端标注 */
    public record ProjectMemberSummary(
            String userId,
            String status,
            String joinedAt,
            String leftAt
    ) {}

    /** 项目详情：项目本体 + 成员 + 已引用仓库 */
    public record ProjectDetailResponse(
            ProjectSummary project,
            List<ProjectMemberSummary> members,
            List<RepositoryDtos.RepositorySummary> repositories
    ) {}

    /** 项目列表响应 */
    public record ProjectListResponse(
            String workspaceId,
            List<ProjectSummary> projects
    ) {}

    /** 项目成员列表响应 */
    public record ProjectMemberListResponse(
            String projectId,
            List<ProjectMemberSummary> members
    ) {}

    /** 成员加入/移出后的变更确认 */
    public record ProjectMemberChangeResponse(
            ProjectMemberSummary member
    ) {}

    /** 项目内单个仓库引用视图：含调用者本机已登记克隆的设备 */
    public record ProjectRepositoryItem(
            String repositoryId,
            String name,
            String remoteUrl,
            String defaultBranch,
            String status,
            String referencedAt,
            List<ClonedDeviceSummary> clonedDevices
    ) {}

    /** 本机仓库登记视图：只暴露设备标识与登记时间，绝不含本地路径 */
    public record ClonedDeviceSummary(
            String deviceId,
            String boundAt
    ) {}

    /** 项目仓库引用列表响应 */
    public record ProjectRepositoryListResponse(
            String projectId,
            List<ProjectRepositoryItem> repositories
    ) {}

    /** 创建项目请求 */
    public record ProjectCreateRequest(
            String name,
            String description,
            String requestId
    ) {}

    /** 修改项目请求：expectedVersion 必填做 CAS，status 只允许归档；可空字段不序列化 null */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ProjectPatchRequest(
            String name,
            String description,
            String status,
            Long expectedVersion
    ) {}

    /** 邀请成员请求 */
    public record ProjectMemberAddRequest(
            String userId,
            String requestId
    ) {}
}
