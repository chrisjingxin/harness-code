package workbench.collaboration.domain.identity;

import java.util.List;
import java.util.Optional;

/**
 * 模块：身份与权限仓储端口接口 (IdentityRepository)
 *
 * <p>【功能定义】
 * 定义对用户（User）、工作区（Workspace）以及成员关联（WorkspaceMember）的持久化数据访问契约。
 * 屏蔽底层的 TDSQL 表结构映射细节，为上层应用服务提供纯净的领域对象读写接口。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityAppService、ConversationAppService、DeviceAppService。
 * - 下游实现方：infrastructure/persistence/IdentityRepositoryImpl。
 */
public interface IdentityRepository {

    /**
     * 根据用户业务标识查询用户。
     *
     * @param id 用户全局唯一标识
     * @return 存在时返回包含 User 的 Optional，否则返回 Optional.empty()
     */
    Optional<User> findUserById(String id);

    /**
     * 根据登录用户名查询用户（如 demo-alice、demo-bob）。
     *
     * @param username 唯一用户名
     * @return 存在时返回包含 User 的 Optional，否则返回 Optional.empty()
     */
    Optional<User> findUserByUsername(String username);

    /**
     * 插入一条新用户记录。
     *
     * @param user 用户实体
     */
    void insertUser(User user);

    /**
     * 根据工作区标识查询工作区。
     *
     * @param id 工作区全局唯一标识
     * @return 存在时返回包含 Workspace 的 Optional，否则返回 Optional.empty()
     */
    Optional<Workspace> findWorkspaceById(String id);

    /**
     * 根据工作区友好别名（slug，如 "team-alpha"）查询工作区。
     *
     * @param slug 工作区地址别名
     * @return 存在时返回包含 Workspace 的 Optional，否则返回 Optional.empty()
     */
    Optional<Workspace> findWorkspaceBySlug(String slug);

    /**
     * 插入一条新工作区记录。
     *
     * @param workspace 工作区实体
     */
    void insertWorkspace(Workspace workspace);

    /**
     * 校验指定用户是否属于指定工作区的有效成员。
     *
     * @param workspaceId 工作区标识
     * @param userId 用户标识
     * @return 若是成员返回 true，否则返回 false
     */
    boolean memberExists(String workspaceId, String userId);

    /**
     * 新增工作区成员归属关联。
     *
     * @param member 成员关联实体
     */
    void insertMember(WorkspaceMember member);

    /**
     * 查询所有启用的演示用户账号列表，用于前端登录页面快捷切换身份。
     *
     * <p>【业务约束】
     * 仅返回 enabled = true 的演示用户；已被禁用的用户必须立刻从列表中剔除。
     *
     * @return 启用演示用户列表
     */
    List<User> listDemoUsers();

    /**
     * 查询指定用户所加入的所有工作区列表。
     *
     * @param userId 用户标识
     * @return 工作区列表
     */
    List<Workspace> listWorkspacesForUser(String userId);

    /**
     * 列出指定工作区下的所有成员用户详细信息。
     *
     * @param workspaceId 工作区标识
     * @return 成员用户列表
     */
    List<User> listMembers(String workspaceId);
}
