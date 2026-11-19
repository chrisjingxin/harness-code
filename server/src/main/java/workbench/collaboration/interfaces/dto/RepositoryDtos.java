package workbench.collaboration.interfaces.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * 模块：团队仓库目录数据传输对象集 (RepositoryDtos)
 *
 * <p>【功能定义】
 * 定义团队级仓库目录的登记/查询/修改/归档传输形态。
 * 目录只承载远端地址与默认分支等共享元数据，绝不包含任何本机绝对路径。
 *
 * <p>【协作边界】
 * - 上游调用方：RepositoryController、RepositoryAppService。
 * - 下游依赖方：Contracts 校验中心。
 */
public final class RepositoryDtos {

    private RepositoryDtos() {}

    /** 仓库目录条目 */
    public record RepositorySummary(
            String repositoryId,
            String workspaceId,
            String name,
            String remoteUrl,
            String defaultBranch,
            String status,
            String createdByUserId,
            String createdAt,
            String updatedAt
    ) {}

    /** 仓库目录列表响应 */
    public record RepositoryListResponse(
            String workspaceId,
            List<RepositorySummary> repositories
    ) {}

    /** 引用该仓库的项目概要（仅对调用者可见的项目） */
    public record ReferencingProjectSummary(
            String projectId,
            String name
    ) {}

    /** 仓库详情：条目本体 + 调用者可见的引用项目 */
    public record RepositoryDetailResponse(
            RepositorySummary repository,
            List<ReferencingProjectSummary> projects
    ) {}

    /** 登记仓库请求；defaultBranch 可空字段不序列化 null */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RepositoryCreateRequest(
            String name,
            String remoteUrl,
            String defaultBranch,
            String requestId
    ) {}

    /** 修改仓库请求：status 只允许归档（单向不可逆）；可空字段不序列化 null */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record RepositoryPatchRequest(
            String name,
            String defaultBranch,
            String status
    ) {}
}
