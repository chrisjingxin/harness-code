package workbench.collaboration.application.service;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.domain.project.ProjectRepositoryRef;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.repository.LocalRepoBindingRepository;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryCatalog;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.TimeCodec;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.ProjectDtos;
import workbench.collaboration.interfaces.dto.RepositoryDtos;

import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 模块：业务项目应用服务 (ProjectAppService)
 *
 * <p>【功能定义】
 * 承载"Team → Project"组织面的全部用例：项目创建/查询/CAS 修改归档、
 * 项目成员加入与移出、项目对团队仓库目录的引用管理，
 * 以及项目引用视图下"调用者哪些本机设备已克隆该仓库"的聚合展示。
 *
 * <p>【安全原则 (Why)】
 * - 非项目成员一律 404（requireActiveMember），不泄露项目存在性；
 * - 写路径先过 requireActiveProject，归档项目拒绝任何写；
 * - PATCH 以 expectedVersion 做乐观并发，版本不符 → 409 VERSION_CONFLICT；
 * - 成员只翻状态不删行，removed 视同非成员（D9）。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectController。
 * - 下游依赖方：ProjectAccessPolicy、ProjectRepository、RepositoryCatalog、
 *   LocalRepoBindingRepository、DeviceRepository、IdentityRepository、IdempotencyPort、Contracts。
 */
@Service
public class ProjectAppService {

    private final ProjectAccessPolicy policy;
    private final ProjectRepository projects;
    private final RepositoryCatalog repositories;
    private final LocalRepoBindingRepository bindings;
    private final DeviceRepository devices;
    private final IdentityRepository identity;
    private final IdempotencyPort idempotency;
    private final Contracts contracts;

    public ProjectAppService(
            ProjectAccessPolicy policy,
            ProjectRepository projects,
            RepositoryCatalog repositories,
            LocalRepoBindingRepository bindings,
            DeviceRepository devices,
            IdentityRepository identity,
            IdempotencyPort idempotency,
            Contracts contracts
    ) {
        this.policy = policy;
        this.projects = projects;
        this.repositories = repositories;
        this.bindings = bindings;
        this.devices = devices;
        this.identity = identity;
        this.idempotency = idempotency;
        this.contracts = contracts;
    }

    /**
     * 创建业务项目并把创建者登记为 owner 成员。
     * requestId 幂等：重放返回首次的定稿响应，不重复建行。
     */
    @Transactional
    public String create(String userId, String workspaceId, String rawBody) {
        policy.requireWorkspaceMember(workspaceId, userId);
        ProjectDtos.ProjectCreateRequest request = contracts.decode(
                "ProjectCreateRequest", rawBody, ProjectDtos.ProjectCreateRequest.class);
        return IdempotentCalls.run(idempotency, workspaceId, userId, "project.create", request.requestId(),
                IdempotentCalls.fingerprint(rawBody), () -> {
                    long now = System.currentTimeMillis();
                    Project project = new Project(
                            UUID.randomUUID().toString(), workspaceId, request.name(), request.description(),
                            userId, ProjectStatus.ACTIVE, 1, now, now);
                    projects.insert(project);
                    projects.upsertMember(new ProjectMember(project.id(), userId, MemberStatus.ACTIVE, now, now));
                    return contracts.encode("ProjectResponse", response(project));
                });
    }

    /**
     * 列出调用者以活跃成员身份参与的项目（含 owner 角色）。
     */
    @Transactional(readOnly = true)
    public String listMine(String userId, String workspaceId) {
        policy.requireWorkspaceMember(workspaceId, userId);
        List<ProjectDtos.ProjectSummary> found = projects.listForMember(workspaceId, userId).stream()
                .map(project -> summary(userId, project))
                .toList();
        return contracts.encode("ProjectListResponse", new ProjectDtos.ProjectListResponse(workspaceId, found));
    }

    /**
     * 项目详情：项目本体 + 成员列表（含 removed）+ 已引用仓库目录条目。
     */
    @Transactional(readOnly = true)
    public String detail(String userId, String workspaceId, String projectId) {
        Project project = policy.requireProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        List<RepositoryDtos.RepositorySummary> referenced = projects.listReferences(projectId).stream()
                .map(ref -> repositories.findById(ref.repositoryId()))
                .flatMap(java.util.Optional::stream)
                .map(ProjectAppService::repositorySummary)
                .toList();
        return contracts.encode("ProjectDetailResponse", new ProjectDtos.ProjectDetailResponse(
                summary(userId, project), memberSummaries(projectId), referenced));
    }

    /**
     * CAS 修改项目：expectedVersion 不匹配 → 409 VERSION_CONFLICT。
     * status 仅允许置 archived（单向归档），schema 已排除其他取值。
     */
    @Transactional
    public String patch(String userId, String workspaceId, String projectId, String rawBody) {
        Project project = policy.requireActiveProject(workspaceId, projectId);
        policy.requireOwner(project, userId);
        ProjectDtos.ProjectPatchRequest request = contracts.decode(
                "ProjectPatchRequest", rawBody, ProjectDtos.ProjectPatchRequest.class);
        long now = System.currentTimeMillis();
        Project updated = new Project(
                project.id(), project.workspaceId(),
                request.name() != null ? request.name() : project.name(),
                request.description() != null ? request.description() : project.description(),
                project.ownerUserId(),
                request.status() != null ? ProjectStatus.ARCHIVED : project.status(),
                project.version(), project.createdAtMs(), now);
        if (!projects.updateIfVersion(updated, request.expectedVersion())) {
            throw new ApiProblem(409, "VERSION_CONFLICT");
        }
        Project saved = new Project(
                updated.id(), updated.workspaceId(), updated.name(), updated.description(),
                updated.ownerUserId(), updated.status(), updated.version() + 1,
                updated.createdAtMs(), updated.updatedAtMs());
        return contracts.encode("ProjectResponse", response(saved));
    }

    /**
     * 项目成员列表（active + removed，removed 带 leftAt）。
     */
    @Transactional(readOnly = true)
    public String listMembers(String userId, String workspaceId, String projectId) {
        policy.requireProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        return contracts.encode("ProjectMemberListResponse",
                new ProjectDtos.ProjectMemberListResponse(projectId, memberSummaries(projectId)));
    }

    /**
     * 邀请团队成员加入项目（仅 owner）。
     * 目标是团队活跃成员才允许；已在列 → 幂等返回现状；曾 removed → 翻回 active 保留首次加入时间。
     */
    @Transactional
    public String addMember(String userId, String workspaceId, String projectId, String rawBody) {
        Project project = policy.requireActiveProject(workspaceId, projectId);
        policy.requireOwner(project, userId);
        ProjectDtos.ProjectMemberAddRequest request = contracts.decode(
                "ProjectMemberAddRequest", rawBody, ProjectDtos.ProjectMemberAddRequest.class);
        return IdempotentCalls.run(idempotency, workspaceId, userId, "project.member.add", request.requestId(),
                IdempotentCalls.fingerprint(projectId, rawBody), () -> {
                    boolean teamMember = identity.findUserById(request.userId())
                            .filter(workbench.collaboration.domain.identity.User::enabled)
                            .isPresent()
                            && identity.memberExists(workspaceId, request.userId());
                    if (!teamMember) {
                        throw new ApiProblem(400, "INVALID_REQUEST");
                    }
                    long now = System.currentTimeMillis();
                    ProjectMember member = projects.findMember(projectId, request.userId())
                            .map(existing -> existing.status() == MemberStatus.ACTIVE
                                    ? existing
                                    : new ProjectMember(projectId, request.userId(), MemberStatus.ACTIVE,
                                            existing.createdAtMs(), now))
                            .orElseGet(() -> new ProjectMember(projectId, request.userId(), MemberStatus.ACTIVE, now, now));
                    // upsert 对"已 active"是幂等写，对 removed/新增则翻回或建行
                    projects.upsertMember(member);
                    return contracts.encode("ProjectMemberChangeResponse",
                            new ProjectDtos.ProjectMemberChangeResponse(memberSummary(member)));
                });
    }

    /**
     * 移出项目成员（仅 owner）：置 removed 不删行。
     * owner 不能移出自己 → 409；从未加入 → 404；已 removed → 幂等返回现状。
     */
    @Transactional
    public String removeMember(String userId, String workspaceId, String projectId, String targetUserId) {
        Project project = policy.requireActiveProject(workspaceId, projectId);
        policy.requireOwner(project, userId);
        if (project.ownerUserId().equals(targetUserId)) {
            throw new ApiProblem(409, "OWNER_CANNOT_LEAVE");
        }
        ProjectMember existing = projects.findMember(projectId, targetUserId)
                .orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
        if (existing.status() == MemberStatus.REMOVED) {
            return contracts.encode("ProjectMemberChangeResponse",
                    new ProjectDtos.ProjectMemberChangeResponse(memberSummary(existing)));
        }
        ProjectMember removed = new ProjectMember(projectId, targetUserId, MemberStatus.REMOVED,
                existing.createdAtMs(), System.currentTimeMillis());
        projects.upsertMember(removed);
        return contracts.encode("ProjectMemberChangeResponse",
                new ProjectDtos.ProjectMemberChangeResponse(memberSummary(removed)));
    }

    /**
     * 项目仓库引用视图：目录条目 + 引用时间 + 调用者未吊销设备中已登记克隆的设备列表。
     */
    @Transactional(readOnly = true)
    public String listRepositories(String userId, String workspaceId, String projectId) {
        policy.requireProject(workspaceId, projectId);
        policy.requireActiveMember(projectId, userId);
        Set<String> callerDevices = devices.listByOwner(userId, null, null, 200).stream()
                .filter(device -> !device.revoked())
                .map(workbench.collaboration.domain.device.Device::id)
                .collect(Collectors.toSet());
        List<ProjectDtos.ProjectRepositoryItem> items = projects.listReferences(projectId).stream()
                .map(ref -> {
                    Repository repository = repositories.findById(ref.repositoryId()).orElse(null);
                    if (repository == null) {
                        return null;
                    }
                    List<ProjectDtos.ClonedDeviceSummary> clones = bindings.listByRepository(ref.repositoryId()).stream()
                            .filter(binding -> callerDevices.contains(binding.deviceId()))
                            .map(binding -> new ProjectDtos.ClonedDeviceSummary(
                                    binding.deviceId(), TimeCodec.utc(binding.createdAtMs())))
                            .toList();
                    return new ProjectDtos.ProjectRepositoryItem(
                            repository.id(), repository.name(), repository.remoteUrl(), repository.defaultBranch(),
                            repository.status().code(), TimeCodec.utc(ref.createdAtMs()), clones);
                })
                .filter(java.util.Objects::nonNull)
                .toList();
        return contracts.encode("ProjectRepositoryListResponse",
                new ProjectDtos.ProjectRepositoryListResponse(projectId, items));
    }

    /**
     * 建立项目对团队仓库的引用（仅 owner）。仓库须同团队且未归档；已引用 → 幂等放行。
     */
    @Transactional
    public void addReference(String userId, String workspaceId, String projectId, String repositoryId) {
        Project project = policy.requireActiveProject(workspaceId, projectId);
        policy.requireOwner(project, userId);
        policy.requireActiveRepository(workspaceId, repositoryId);
        if (projects.referenceExists(projectId, repositoryId)) {
            return;
        }
        try {
            projects.insertReference(new ProjectRepositoryRef(projectId, repositoryId, System.currentTimeMillis()));
        } catch (DuplicateKeyException ignored) {
            // 并发下唯一键兜底：引用已存在即幂等成功
        }
    }

    /**
     * 移除项目仓库引用（仅 owner）。引用不存在 → 404。
     */
    @Transactional
    public void removeReference(String userId, String workspaceId, String projectId, String repositoryId) {
        Project project = policy.requireActiveProject(workspaceId, projectId);
        policy.requireOwner(project, userId);
        if (projects.deleteReference(projectId, repositoryId) == 0) {
            throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
        }
    }

    private ProjectDtos.ProjectSummary summary(String userId, Project project) {
        return new ProjectDtos.ProjectSummary(
                project.id(), project.workspaceId(), project.name(), project.description(),
                project.ownerUserId(), project.status().code(),
                policy.isOwner(project, userId) ? "owner" : "member",
                projects.countMembers(project.id(), MemberStatus.ACTIVE),
                project.version(), TimeCodec.utc(project.createdAtMs()), TimeCodec.utc(project.updatedAtMs()));
    }

    private ProjectDtos.ProjectResponse response(Project project) {
        return new ProjectDtos.ProjectResponse(
                project.id(), project.workspaceId(), project.name(), project.description(),
                project.ownerUserId(), project.status().code(), project.version(),
                TimeCodec.utc(project.createdAtMs()), TimeCodec.utc(project.updatedAtMs()));
    }

    private List<ProjectDtos.ProjectMemberSummary> memberSummaries(String projectId) {
        return projects.listMembers(projectId).stream().map(this::memberSummary).toList();
    }

    private ProjectDtos.ProjectMemberSummary memberSummary(ProjectMember member) {
        return new ProjectDtos.ProjectMemberSummary(
                member.userId(), member.status().code(), TimeCodec.utc(member.createdAtMs()),
                member.status() == MemberStatus.REMOVED ? TimeCodec.utc(member.updatedAtMs()) : null);
    }

    static RepositoryDtos.RepositorySummary repositorySummary(Repository repository) {
        return new RepositoryDtos.RepositorySummary(
                repository.id(), repository.workspaceId(), repository.name(), repository.remoteUrl(),
                repository.defaultBranch(), repository.status().code(), repository.createdByUserId(),
                TimeCodec.utc(repository.createdAtMs()), TimeCodec.utc(repository.updatedAtMs()));
    }
}
