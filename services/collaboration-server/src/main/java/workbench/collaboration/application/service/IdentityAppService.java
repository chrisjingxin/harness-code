package workbench.collaboration.application.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.interfaces.dto.PlatformDtos;

import java.util.List;

/**
 * 模块：用户身份与工作区应用服务 (IdentityAppService)
 *
 * <p>【功能定义】
 * 负责平台用户认证鉴权、工作区准入检查、成员关系校验以及演示账号获取。
 * 遵循高可用安全原则：每一次受保护的业务调用均严格校验当前账号的最新启用状态（enabled）
 * 以及目标工作区的成员关系，防止已被停用或移除的用户凭借旧 Cookie/Session 越权访问。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityController、ConversationAppService、DeviceAppService、BoundaryFilter。
 * - 下游依赖方：IdentityRepository、ApiProblem、PlatformDtos。
 */
@Service
public class IdentityAppService {

    private final IdentityRepository identity;

    public IdentityAppService(IdentityRepository identity) {
        this.identity = identity;
    }

    /**
     * 根据用户名执行快捷认证（常用于演示账号或简易登录）。
     *
     * @param username 用户名
     * @return 认证成功后的用户唯一标识 (UUID)
     * @throws ApiProblem 401 DEMO_LOGIN_REJECTED 当用户不存在或被禁用时
     */
    @Transactional(readOnly = true)
    public String authenticate(String username) {
        return identity.findUserByUsername(username)
                .filter(User::enabled)
                .map(User::id)
                .orElseThrow(() -> new ApiProblem(401, "DEMO_LOGIN_REJECTED"));
    }

    /**
     * 强校验指定用户存在且处于启用状态。
     *
     * @param userId 用户业务标识
     * @return 校验通过的用户实体
     * @throws ApiProblem 401 AUTHENTICATION_REQUIRED 当用户不存在或已被停用时
     */
    @Transactional(readOnly = true)
    public User requireUser(String userId) {
        User user = identity.findUserById(userId)
                .orElseThrow(() -> new ApiProblem(401, "AUTHENTICATION_REQUIRED"));
        if (!user.enabled()) {
            throw new ApiProblem(401, "AUTHENTICATION_REQUIRED");
        }
        return user;
    }

    /**
     * 强校验指定用户是否属于指定工作区的有效成员。
     *
     * <p>【安全底线 (Why)】
     * 严防跨工作区水平越权访问；未加入该工作区的用户一律报 404 RESOURCE_NOT_FOUND，
     * 遵循最小暴露原则，防止外部探测工作区真实存在性。
     *
     * @param workspaceId 工作区标识
     * @param userId 用户标识
     * @throws ApiProblem 404 RESOURCE_NOT_FOUND 当非成员尝试访问时
     */
    @Transactional(readOnly = true)
    public void requireMember(String workspaceId, String userId) {
        requireUser(userId);
        if (!identity.memberExists(workspaceId, userId)) {
            throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
        }
    }

    /**
     * 获取当前登录用户的个人资料及其参与的工作区概览。
     *
     * @param userId 当前用户标识
     * @return 当前用户资料与工作区列表
     */
    @Transactional(readOnly = true)
    public PlatformDtos.CurrentUserResponse current(String userId) {
        User user = requireUser(userId);
        List<PlatformDtos.WorkspaceSummary> workspaces = identity.listWorkspacesForUser(userId)
                .stream()
                .map(this::workspace)
                .toList();
        return new PlatformDtos.CurrentUserResponse(user(user), workspaces);
    }

    /**
     * 获取所有可用的演示账号列表（供登录面板选择）。
     *
     * @return 演示账号列表
     */
    @Transactional(readOnly = true)
    public PlatformDtos.DemoUsersResponse demoUsers() {
        return new PlatformDtos.DemoUsersResponse(
                identity.listDemoUsers().stream().map(this::user).toList()
        );
    }

    /**
     * 获取指定用户所归属的工作区列表。
     *
     * @param userId 用户标识
     * @return 工作区列表响应
     */
    @Transactional(readOnly = true)
    public PlatformDtos.WorkspaceListResponse workspaces(String userId) {
        requireUser(userId);
        return new PlatformDtos.WorkspaceListResponse(
                identity.listWorkspacesForUser(userId).stream().map(this::workspace).toList()
        );
    }

    /**
     * 列出指定工作区下的所有成员用户。
     *
     * @param userId 调用者用户标识
     * @param workspaceId 目标工作区标识
     * @return 成员列表响应
     */
    @Transactional(readOnly = true)
    public PlatformDtos.MembersResponse members(String userId, String workspaceId) {
        requireMember(workspaceId, userId);
        List<PlatformDtos.MemberSummary> members = identity.listMembers(workspaceId)
                .stream()
                .map(member -> new PlatformDtos.MemberSummary(user(member)))
                .toList();
        return new PlatformDtos.MembersResponse(workspaceId, members);
    }

    private PlatformDtos.UserSummary user(User user) {
        return new PlatformDtos.UserSummary(user.id(), user.username(), user.displayName());
    }

    private PlatformDtos.WorkspaceSummary workspace(Workspace workspace) {
        return new PlatformDtos.WorkspaceSummary(workspace.id(), workspace.slug(), workspace.name());
    }
}
