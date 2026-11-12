package workbench.collaboration.application.service;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryCatalog;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.ProjectDtos;
import workbench.collaboration.interfaces.dto.RepositoryDtos;

import java.util.List;
import java.util.UUID;

/**
 * 模块：团队仓库目录应用服务 (RepositoryAppService)
 *
 * <p>【功能定义】
 * 承载团队级仓库目录的登记、列表、详情与修改/归档。
 * 目录条目只描述共享远端（remoteUrl + defaultBranch）；
 * remoteUrl 全库唯一由数据库兜底，冲突 → 409 REPOSITORY_CONFLICT。
 *
 * <p>【安全原则 (Why)】
 * - 工作区路由前置 requireWorkspaceMember（403 门槛）；
 * - 仓库详情中"引用它的项目"只回调用者可见（活跃成员）的项目，防存在性泄露；
 * - 归档单向不可逆：已归档仓库拒绝修改 → 409 REPOSITORY_ARCHIVED。
 *
 * <p>【协作边界】
 * - 上游调用方：RepositoryController。
 * - 下游依赖方：ProjectAccessPolicy、RepositoryCatalog、ProjectRepository（反向查引用）、
 *   IdempotencyPort、Contracts。
 */
@Service
public class RepositoryAppService {

    private final ProjectAccessPolicy policy;
    private final RepositoryCatalog repositories;
    private final ProjectRepository projects;
    private final IdempotencyPort idempotency;
    private final Contracts contracts;

    public RepositoryAppService(
            ProjectAccessPolicy policy,
            RepositoryCatalog repositories,
            ProjectRepository projects,
            IdempotencyPort idempotency,
            Contracts contracts
    ) {
        this.policy = policy;
        this.repositories = repositories;
        this.projects = projects;
        this.idempotency = idempotency;
        this.contracts = contracts;
    }

    /**
     * 登记团队仓库目录条目。defaultBranch 缺省为 main；remoteUrl 冲突 → 409。
     */
    @Transactional
    public String create(String userId, String workspaceId, String rawBody) {
        policy.requireWorkspaceMember(workspaceId, userId);
        RepositoryDtos.RepositoryCreateRequest request = contracts.decode(
                "RepositoryCreateRequest", rawBody, RepositoryDtos.RepositoryCreateRequest.class);
        return IdempotentCalls.run(idempotency, workspaceId, userId, "repository.create", request.requestId(),
                IdempotentCalls.fingerprint(rawBody), () -> {
                    long now = System.currentTimeMillis();
                    Repository repository = new Repository(
                            UUID.randomUUID().toString(), workspaceId, request.name(), request.remoteUrl(),
                            request.defaultBranch() != null && !request.defaultBranch().isEmpty()
                                    ? request.defaultBranch() : "main",
                            RepositoryStatus.ACTIVE, userId, now, now);
                    try {
                        repositories.insert(repository);
                    } catch (DuplicateKeyException conflict) {
                        throw new ApiProblem(409, "REPOSITORY_CONFLICT");
                    }
                    return contracts.encode("RepositorySummary", ProjectAppService.repositorySummary(repository));
                });
    }

    /**
     * 团队仓库目录列表，可按 status=active|archived 过滤。
     */
    @Transactional(readOnly = true)
    public String list(String userId, String workspaceId, String status) {
        policy.requireWorkspaceMember(workspaceId, userId);
        List<RepositoryDtos.RepositorySummary> found = repositories
                .listByWorkspace(workspaceId, status == null ? null : RepositoryStatus.fromCode(status))
                .stream()
                .map(ProjectAppService::repositorySummary)
                .toList();
        return contracts.encode("RepositoryListResponse", new RepositoryDtos.RepositoryListResponse(workspaceId, found));
    }

    /**
     * 仓库详情：目录条目 + 引用它的项目（仅返回调用者是活跃成员的项目，防存在性泄露）。
     */
    @Transactional(readOnly = true)
    public String detail(String userId, String workspaceId, String repositoryId) {
        policy.requireWorkspaceMember(workspaceId, userId);
        Repository repository = policy.requireRepository(workspaceId, repositoryId);
        List<RepositoryDtos.ReferencingProjectSummary> referencing = projects
                .listReferencesByRepository(repositoryId).stream()
                .map(ref -> projects.findById(ref.projectId()))
                .flatMap(java.util.Optional::stream)
                .filter(project -> policy.isActiveMember(project.id(), userId))
                .map(project -> new RepositoryDtos.ReferencingProjectSummary(project.id(), project.name()))
                .toList();
        return contracts.encode("RepositoryDetailResponse", new RepositoryDtos.RepositoryDetailResponse(
                ProjectAppService.repositorySummary(repository), referencing));
    }

    /**
     * 修改仓库目录条目（名称/默认分支/归档）。
     * 已归档 → 409 REPOSITORY_ARCHIVED；status 只允许置 archived（schema 已限定取值）。
     */
    @Transactional
    public String patch(String userId, String workspaceId, String repositoryId, String rawBody) {
        policy.requireWorkspaceMember(workspaceId, userId);
        Repository repository = policy.requireRepository(workspaceId, repositoryId);
        if (repository.status() == RepositoryStatus.ARCHIVED) {
            throw new ApiProblem(409, "REPOSITORY_ARCHIVED");
        }
        RepositoryDtos.RepositoryPatchRequest request = contracts.decode(
                "RepositoryPatchRequest", rawBody, RepositoryDtos.RepositoryPatchRequest.class);
        Repository updated = new Repository(
                repository.id(), repository.workspaceId(),
                request.name() != null ? request.name() : repository.name(),
                repository.remoteUrl(),
                request.defaultBranch() != null ? request.defaultBranch() : repository.defaultBranch(),
                request.status() != null ? RepositoryStatus.ARCHIVED : repository.status(),
                repository.createdByUserId(), repository.createdAtMs(), System.currentTimeMillis());
        repositories.update(updated);
        return contracts.encode("RepositorySummary", ProjectAppService.repositorySummary(updated));
    }
}
