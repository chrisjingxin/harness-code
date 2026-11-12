package workbench.collaboration.domain.access;

import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryCatalog;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.interfaces.ApiProblem;

import java.util.Optional;

/**
 * 模块：项目制授权策略领域服务 (ProjectAccessPolicy)
 *
 * <p>【功能定义】
 * 新协作模型下所有"谁能不能碰什么"的统一判定点。
 * 对外暴露两类方法：require*（不通过直接抛受控异常）与 is*（纯判读返回布尔）。
 *
 * <p>【错误语义】
 * - 401：身份/设备凭据本身无效（用户停用、设备已吊销）；
 * - 403：已认证但角色不足（非团队成员、非负责人、设备越权）；
 * - 404：资源不存在，或**非项目成员访问项目资源**——不泄露项目存在性；
 * - 409：目标存在但状态不可写（已归档、owner 不能移出自己等）。
 *
 * <p>【分层说明】
 * 本类位于 domain 但抛出 interfaces/ApiProblem：它是全服务唯一的受控错误词汇
 * （BoundaryFilter/ApiResponses 统一格式化），为避免在每次调用处加一层异常翻译，
 * 领域策略直接复用；ApiProblem 自身是无框架依赖的纯数据异常，不引入分层倒置风险。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectAppService、RepositoryAppService、RepoBindingAppService、ConversationSyncAppService。
 * - 下游依赖方：IdentityRepository、ProjectRepository、RepositoryCatalog（设备/会话实体由调用方传入）。
 */
public final class ProjectAccessPolicy {

    private final IdentityRepository identity;
    private final ProjectRepository projects;
    private final RepositoryCatalog repositories;

    public ProjectAccessPolicy(IdentityRepository identity, ProjectRepository projects, RepositoryCatalog repositories) {
        this.identity = identity;
        this.projects = projects;
        this.repositories = repositories;
    }

    /**
     * 团队成员门槛（工作区级路由前置检查）。
     * 用户不存在或已停用 → 401；不是该团队成员 → 403。
     *
     * @return 校验通过的用户实体
     */
    public User requireWorkspaceMember(String workspaceId, String userId) {
        User user = identity.findUserById(userId)
                .orElseThrow(() -> new ApiProblem(401, "AUTHENTICATION_REQUIRED"));
        if (!user.enabled()) {
            throw new ApiProblem(401, "AUTHENTICATION_REQUIRED");
        }
        if (!identity.memberExists(workspaceId, userId)) {
            throw new ApiProblem(403, "WORKSPACE_MEMBER_REQUIRED");
        }
        return user;
    }

    /**
     * 项目存在性校验：不存在或不属于该团队一律 404（不暴露真实归属）。
     */
    public Project requireProject(String workspaceId, String projectId) {
        Optional<Project> found = projects.findById(projectId);
        if (found.isEmpty() || !found.get().workspaceId().equals(workspaceId)) {
            throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
        }
        return found.get();
    }

    /**
     * 项目可写校验：存在性同 requireProject；已归档 → 409 PROJECT_ARCHIVED。
     * 所有写路径（PATCH/成员/引用/会话登记）必须先过此门。
     */
    public Project requireActiveProject(String workspaceId, String projectId) {
        Project project = requireProject(workspaceId, projectId);
        if (project.status() == ProjectStatus.ARCHIVED) {
            throw new ApiProblem(409, "PROJECT_ARCHIVED");
        }
        return project;
    }

    /**
     * 项目活跃成员校验：查无记录或已 removed → 404。
     * removed 视同非成员（D9：移出即失去读权，且不泄露项目存在性）。
     */
    public ProjectMember requireActiveMember(String projectId, String userId) {
        Optional<ProjectMember> member = projects.findMember(projectId, userId);
        if (member.isEmpty() || member.get().status() != MemberStatus.ACTIVE) {
            throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
        }
        return member.get();
    }

    /**
     * 负责人校验：调用者不是项目 owner → 403。
     * 前置：项目与成员资格已由 requireProject/requireActiveMember 判过。
     */
    public void requireOwner(Project project, String userId) {
        if (!isOwner(project, userId)) {
            throw new ApiProblem(403, "PROJECT_OWNER_REQUIRED");
        }
    }

    /**
     * 仓库存在性校验：不存在或不属于该团队一律 404。
     */
    public Repository requireRepository(String workspaceId, String repositoryId) {
        Optional<Repository> found = repositories.findById(repositoryId);
        if (found.isEmpty() || !found.get().workspaceId().equals(workspaceId)) {
            throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
        }
        return found.get();
    }

    /**
     * 仓库可引用校验：存在性同 requireRepository；已归档 → 409 REPOSITORY_ARCHIVED。
     * 项目新增引用、设备本机登记必须先过此门。
     */
    public Repository requireActiveRepository(String workspaceId, String repositoryId) {
        Repository repository = requireRepository(workspaceId, repositoryId);
        if (repository.status() == RepositoryStatus.ARCHIVED) {
            throw new ApiProblem(409, "REPOSITORY_ARCHIVED");
        }
        return repository;
    }

    /**
     * 设备仓库登记资格（PUT /device/repo-bindings 前置）。
     * 设备已吊销 → 401；设备 owner 不是该仓库所属团队的成员 → 403 DEVICE_FORBIDDEN。
     * 仓库本身的存在性与活跃校验由 requireActiveRepository 负责。
     */
    public void requireBindingAuthority(Device device, Repository repository) {
        if (device.revoked()) {
            throw new ApiProblem(401, "DEVICE_AUTHENTICATION_REQUIRED");
        }
        if (!identity.memberExists(repository.workspaceId(), device.ownerUserId())) {
            throw new ApiProblem(403, "DEVICE_FORBIDDEN");
        }
    }

    /**
     * 会话同步资格（POST /device/conversations/{c}/sync 前置，D9）。
     * 设备不属于会话 owner → 403；owner 已被移出项目（无活跃成员记录）→ 403。
     * 被移出成员的既有会话保留只读，但其设备不得再推进水位。
     */
    public void requireSyncAuthority(Device device, Conversation conversation) {
        if (!device.ownerUserId().equals(conversation.ownerUserId())) {
            throw new ApiProblem(403, "DEVICE_FORBIDDEN");
        }
        if (!isActiveMember(conversation.projectId(), conversation.ownerUserId())) {
            throw new ApiProblem(403, "DEVICE_FORBIDDEN");
        }
    }

    /**
     * 判读：用户是否为项目活跃成员（removed/无记录均 false）。
     */
    public boolean isActiveMember(String projectId, String userId) {
        return projects.findMember(projectId, userId)
                .map(member -> member.status() == MemberStatus.ACTIVE)
                .orElse(false);
    }

    /**
     * 判读：用户是否为项目负责人。
     */
    public boolean isOwner(Project project, String userId) {
        return project.ownerUserId().equals(userId);
    }
}
