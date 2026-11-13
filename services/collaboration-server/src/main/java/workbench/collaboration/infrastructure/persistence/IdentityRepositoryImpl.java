package workbench.collaboration.infrastructure.persistence;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.springframework.stereotype.Repository;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.Org;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.UserOrg;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.identity.WorkspaceMember;
import workbench.collaboration.infrastructure.persistence.mapper.OrgMapper;
import workbench.collaboration.infrastructure.persistence.mapper.UserMapper;
import workbench.collaboration.infrastructure.persistence.mapper.UserOrgMapper;
import workbench.collaboration.infrastructure.persistence.mapper.WorkspaceMapper;
import workbench.collaboration.infrastructure.persistence.mapper.WorkspaceMemberMapper;

import java.util.List;
import java.util.Optional;

/**
 * 模块：用户与工作区仓储持久化实现 (IdentityRepositoryImpl)
 *
 * <p>【功能定义】
 * 基于 MyBatis-Plus 驱动 TDSQL 核心表（wb_user、wb_org、wb_user_org、wb_workspace、wb_workspace_member）完成身份与组织管理。
 * 提供演示账号过滤（enabled=1）、成员关系跨表查询与成员存在性高效校验。
 *
 * <p>【协作边界】
 * - 上游调用方：IdentityAppService、Foundation。
 * - 下游依赖方：UserMapper、OrgMapper、UserOrgMapper、WorkspaceMapper、WorkspaceMemberMapper、IdentityConverter。
 */
@Repository
public class IdentityRepositoryImpl implements IdentityRepository {

    private final UserMapper users;
    private final OrgMapper orgs;
    private final UserOrgMapper userOrgs;
    private final WorkspaceMapper workspaces;
    private final WorkspaceMemberMapper members;

    public IdentityRepositoryImpl(
            UserMapper users,
            OrgMapper orgs,
            UserOrgMapper userOrgs,
            WorkspaceMapper workspaces,
            WorkspaceMemberMapper members
    ) {
        this.users = users;
        this.orgs = orgs;
        this.userOrgs = userOrgs;
        this.workspaces = workspaces;
        this.members = members;
    }

    @Override
    public Optional<User> findUserById(String id) {
        return Optional.ofNullable(users.selectOne(new QueryWrapper<UserPO>().eq("user_id", id)))
                .map(IdentityConverter::toUser);
    }

    @Override
    public Optional<User> findUserByUserNo(String userNo) {
        return Optional.ofNullable(users.selectOne(new QueryWrapper<UserPO>().eq("user_no", userNo)))
                .map(IdentityConverter::toUser);
    }

    @Override
    public void insertUser(User user) {
        if (users.insert(IdentityConverter.toPo(user)) != 1) {
            throw new IllegalStateException("用户没有写入");
        }
    }

    @Override
    public Optional<Org> findOrgById(String orgId) {
        return Optional.ofNullable(orgs.selectOne(new QueryWrapper<OrgPO>().eq("org_id", orgId)))
                .map(IdentityConverter::toOrg);
    }

    @Override
    public void insertOrg(Org org) {
        if (orgs.insert(IdentityConverter.toPo(org)) != 1) {
            throw new IllegalStateException("机构没有写入");
        }
    }

    @Override
    public boolean userOrgExists(String userId, String orgId) {
        Long count = userOrgs.selectCount(new QueryWrapper<UserOrgPO>()
                .eq("user_id", userId)
                .eq("org_id", orgId));
        return count != null && count > 0;
    }

    @Override
    public void insertUserOrg(UserOrg userOrg) {
        if (userOrgs.insert(IdentityConverter.toPo(userOrg)) != 1) {
            throw new IllegalStateException("用户机构关系没有写入");
        }
    }

    @Override
    public Optional<Workspace> findWorkspaceById(String id) {
        return Optional.ofNullable(workspaces.selectOne(new QueryWrapper<WorkspacePO>().eq("workspace_id", id)))
                .map(IdentityConverter::toWorkspace);
    }

    @Override
    public Optional<Workspace> findWorkspaceBySlug(String slug) {
        return Optional.ofNullable(workspaces.selectOne(new QueryWrapper<WorkspacePO>().eq("slug", slug)))
                .map(IdentityConverter::toWorkspace);
    }

    @Override
    public void insertWorkspace(Workspace workspace) {
        if (workspaces.insert(IdentityConverter.toPo(workspace)) != 1) {
            throw new IllegalStateException("工作区没有写入");
        }
    }

    @Override
    public boolean memberExists(String workspaceId, String userId) {
        Long count = members.selectCount(new QueryWrapper<WorkspaceMemberPO>()
                .eq("workspace_id", workspaceId)
                .eq("user_id", userId));
        return count != null && count > 0;
    }

    @Override
    public void insertMember(WorkspaceMember member) {
        if (members.insert(IdentityConverter.toPo(member)) != 1) {
            throw new IllegalStateException("成员没有写入");
        }
    }

    @Override
    public List<User> listDemoUsers() {
        return users.selectList(new QueryWrapper<UserPO>()
                        .eq("enabled", 1)
                        .ne("user_no", "")
                        .orderByAsc("user_no")
                        .last("LIMIT 50"))
                .stream()
                .map(IdentityConverter::toUser)
                .toList();
    }

    @Override
    public List<Workspace> listWorkspacesForUser(String userId) {
        List<String> ids = members.selectList(new QueryWrapper<WorkspaceMemberPO>().eq("user_id", userId))
                .stream()
                .map(WorkspaceMemberPO::getWorkspaceId)
                .toList();
        if (ids.isEmpty()) {
            return List.of();
        }
        return workspaces.selectList(new QueryWrapper<WorkspacePO>().in("workspace_id", ids).orderByAsc("slug"))
                .stream()
                .map(IdentityConverter::toWorkspace)
                .toList();
    }

    @Override
    public List<User> listMembers(String workspaceId) {
        List<String> ids = members.selectList(new QueryWrapper<WorkspaceMemberPO>().eq("workspace_id", workspaceId))
                .stream()
                .map(WorkspaceMemberPO::getUserId)
                .toList();
        if (ids.isEmpty()) {
            return List.of();
        }
        return users.selectList(new QueryWrapper<UserPO>().in("user_id", ids).eq("enabled", 1).orderByAsc("user_no"))
                .stream()
                .map(IdentityConverter::toUser)
                .toList();
    }
}
