package workbench.collaboration.domain.access;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.identity.IdentityRepository;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.identity.Workspace;
import workbench.collaboration.domain.identity.WorkspaceMember;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectRepository;
import workbench.collaboration.domain.project.ProjectRepositoryRef;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.repository.LocalRepoBinding;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryCatalog;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.interfaces.ApiProblem;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ProjectAccessPolicy 全分支核对：401/403/404/409 四种拒绝语义 + 放行路径。
 * 三个仓储端口用内存 fake，只装本测试需要的状态。
 */
class ProjectAccessPolicyTest {

    private FakeIdentity identity;
    private FakeProjects projects;
    private FakeRepositories repositories;
    private ProjectAccessPolicy policy;

    private static final String WS = "ws-1";
    private static final String OTHER_WS = "ws-2";
    private static final String PROJECT = "p-1";
    private static final String OWNER = "u-owner";
    private static final String MEMBER = "u-member";
    private static final String OUTSIDER = "u-outsider";

    @BeforeEach
    void setUp() {
        identity = new FakeIdentity();
        projects = new FakeProjects();
        repositories = new FakeRepositories();
        policy = new ProjectAccessPolicy(identity, projects, repositories);

        identity.users.put(OWNER, new User(OWNER, "owner", "负责人", true, 1L));
        identity.users.put(MEMBER, new User(MEMBER, "member", "成员", true, 1L));
        identity.users.put(OUTSIDER, new User(OUTSIDER, "outsider", "外人", true, 1L));
        identity.members.add(WS + ":" + OWNER);
        identity.members.add(WS + ":" + MEMBER);
        identity.members.add(WS + ":" + OUTSIDER);
        projects.projects.put(PROJECT, new Project(PROJECT, WS, "账单", "desc", OWNER, ProjectStatus.ACTIVE, 1L, 1L, 1L));
        projects.members.put(PROJECT + ":" + OWNER, new ProjectMember(PROJECT, OWNER, MemberStatus.ACTIVE, 1L, 1L));
        projects.members.put(PROJECT + ":" + MEMBER, new ProjectMember(PROJECT, MEMBER, MemberStatus.ACTIVE, 1L, 1L));
    }

    // ---------- requireWorkspaceMember ----------

    @Test
    void 团队成员通过门槛() {
        assertSame(identity.users.get(MEMBER), policy.requireWorkspaceMember(WS, MEMBER));
    }

    @Test
    void 用户不存在或停用拒绝401() {
        ApiProblem missing = assertThrows(ApiProblem.class, () -> policy.requireWorkspaceMember(WS, "ghost"));
        assertEquals(401, missing.status);
        identity.users.put("disabled", new User("disabled", "x", "停用", false, 1L));
        assertEquals(401, assertThrows(ApiProblem.class, () -> policy.requireWorkspaceMember(WS, "disabled")).status);
    }

    @Test
    void 非团队成员拒绝403() {
        identity.members.remove(WS + ":" + OUTSIDER);
        ApiProblem error = assertThrows(ApiProblem.class, () -> policy.requireWorkspaceMember(WS, OUTSIDER));
        assertEquals(403, error.status);
        assertEquals("WORKSPACE_MEMBER_REQUIRED", error.code);
    }

    // ---------- requireProject / requireActiveProject ----------

    @Test
    void 项目不存在或跨团队均404() {
        assertEquals(404, assertThrows(ApiProblem.class, () -> policy.requireProject(WS, "p-none")).status);
        assertEquals(404, assertThrows(ApiProblem.class, () -> policy.requireProject(OTHER_WS, PROJECT)).status);
    }

    @Test
    void 归档项目写路径拒绝409读路径放行() {
        projects.projects.put(PROJECT, new Project(PROJECT, WS, "账单", "desc", OWNER, ProjectStatus.ARCHIVED, 2L, 1L, 1L));
        ApiProblem error = assertThrows(ApiProblem.class, () -> policy.requireActiveProject(WS, PROJECT));
        assertEquals(409, error.status);
        assertEquals("PROJECT_ARCHIVED", error.code);
        assertSame(projects.projects.get(PROJECT), policy.requireProject(WS, PROJECT));
    }

    // ---------- requireActiveMember / requireOwner / is* ----------

    @Test
    void 非成员与已移出成员访问项目均404() {
        assertEquals(404, assertThrows(ApiProblem.class, () -> policy.requireActiveMember(PROJECT, OUTSIDER)).status);
        projects.members.put(PROJECT + ":" + OUTSIDER, new ProjectMember(PROJECT, OUTSIDER, MemberStatus.REMOVED, 1L, 2L));
        assertEquals(404, assertThrows(ApiProblem.class, () -> policy.requireActiveMember(PROJECT, OUTSIDER)).status);
        assertFalse(policy.isActiveMember(PROJECT, OUTSIDER));
    }

    @Test
    void 活跃成员通过且is判读正确() {
        ProjectMember member = policy.requireActiveMember(PROJECT, MEMBER);
        assertEquals(MemberStatus.ACTIVE, member.status());
        assertTrue(policy.isActiveMember(PROJECT, MEMBER));
        assertTrue(policy.isOwner(projects.projects.get(PROJECT), OWNER));
        assertFalse(policy.isOwner(projects.projects.get(PROJECT), MEMBER));
    }

    @Test
    void 非负责人拒绝403() {
        ApiProblem error = assertThrows(ApiProblem.class, () -> policy.requireOwner(projects.projects.get(PROJECT), MEMBER));
        assertEquals(403, error.status);
        assertEquals("PROJECT_OWNER_REQUIRED", error.code);
        policy.requireOwner(projects.projects.get(PROJECT), OWNER);
    }

    // ---------- requireRepository / requireActiveRepository ----------

    @Test
    void 仓库不存在或跨团队均404() {
        assertEquals(404, assertThrows(ApiProblem.class, () -> policy.requireRepository(WS, "r-none")).status);
        repositories.items.put("r-1", new Repository("r-1", OTHER_WS, "x", "u", "main", RepositoryStatus.ACTIVE, OWNER, 1L, 1L));
        assertEquals(404, assertThrows(ApiProblem.class, () -> policy.requireRepository(WS, "r-1")).status);
    }

    @Test
    void 归档仓库拒绝被新引用409() {
        repositories.items.put("r-1", new Repository("r-1", WS, "x", "u", "main", RepositoryStatus.ARCHIVED, OWNER, 1L, 1L));
        ApiProblem error = assertThrows(ApiProblem.class, () -> policy.requireActiveRepository(WS, "r-1"));
        assertEquals(409, error.status);
        assertEquals("REPOSITORY_ARCHIVED", error.code);
    }

    // ---------- requireBindingAuthority / requireSyncAuthority ----------

    @Test
    void 已吊销设备登记资格拒绝401() {
        Device revoked = device("d-1", MEMBER, true);
        Repository repo = new Repository("r-1", WS, "x", "u", "main", RepositoryStatus.ACTIVE, OWNER, 1L, 1L);
        assertEquals(401, assertThrows(ApiProblem.class, () -> policy.requireBindingAuthority(revoked, repo)).status);
    }

    @Test
    void 设备owner非仓库团队成员拒绝403() {
        Repository repo = new Repository("r-1", OTHER_WS, "x", "u", "main", RepositoryStatus.ACTIVE, OWNER, 1L, 1L);
        ApiProblem error = assertThrows(ApiProblem.class, () -> policy.requireBindingAuthority(device("d-1", MEMBER, false), repo));
        assertEquals(403, error.status);
        assertEquals("DEVICE_FORBIDDEN", error.code);
        // 本人仓库所在团队有成员资格则放行
        Repository own = new Repository("r-2", WS, "x", "u", "main", RepositoryStatus.ACTIVE, OWNER, 1L, 1L);
        policy.requireBindingAuthority(device("d-1", MEMBER, false), own);
    }

    @Test
    void 非会话owner的设备同步拒绝403() {
        Conversation conversation = conversation(PROJECT, OWNER);
        ApiProblem error = assertThrows(ApiProblem.class, () -> policy.requireSyncAuthority(device("d-1", MEMBER, false), conversation));
        assertEquals(403, error.status);
        assertEquals("DEVICE_FORBIDDEN", error.code);
    }

    @Test
    void owner被移出项目后其设备同步拒绝403() {
        Conversation conversation = conversation(PROJECT, MEMBER);
        projects.members.put(PROJECT + ":" + MEMBER, new ProjectMember(PROJECT, MEMBER, MemberStatus.REMOVED, 1L, 2L));
        assertEquals(403, assertThrows(ApiProblem.class, () -> policy.requireSyncAuthority(device("d-1", MEMBER, false), conversation)).status);
        // owner 仍是活跃成员时放行
        projects.members.put(PROJECT + ":" + MEMBER, new ProjectMember(PROJECT, MEMBER, MemberStatus.ACTIVE, 1L, 1L));
        policy.requireSyncAuthority(device("d-1", MEMBER, false), conversation);
    }

    // ---------- 测试夹具 ----------

    private static Device device(String id, String owner, boolean revoked) {
        return new Device(id, owner, "inst", "ledger", "本机", "hash", "reg", "body", revoked, 1L, 1L);
    }

    private static Conversation conversation(String projectId, String owner) {
        return new Conversation("c-1", WS, projectId, owner, "d-1", "", "", "idle", "t", "", "rule", 1L, 0L, "", 1L, 1L);
    }

    private static final class FakeIdentity implements IdentityRepository {
        final Map<String, User> users = new HashMap<>();
        final List<String> members = new ArrayList<>();

        @Override public Optional<User> findUserById(String id) { return Optional.ofNullable(users.get(id)); }
        @Override public Optional<User> findUserByUsername(String username) { return Optional.empty(); }
        @Override public void insertUser(User user) { users.put(user.id(), user); }
        @Override public Optional<Workspace> findWorkspaceById(String id) { return Optional.empty(); }
        @Override public Optional<Workspace> findWorkspaceBySlug(String slug) { return Optional.empty(); }
        @Override public void insertWorkspace(Workspace workspace) {}
        @Override public boolean memberExists(String workspaceId, String userId) { return members.contains(workspaceId + ":" + userId); }
        @Override public void insertMember(WorkspaceMember member) { members.add(member.workspaceId() + ":" + member.userId()); }
        @Override public List<User> listDemoUsers() { return List.of(); }
        @Override public List<Workspace> listWorkspacesForUser(String userId) { return List.of(); }
        @Override public List<User> listMembers(String workspaceId) { return List.of(); }
    }

    private static final class FakeProjects implements ProjectRepository {
        final Map<String, Project> projects = new HashMap<>();
        final Map<String, ProjectMember> members = new HashMap<>();

        @Override public Optional<Project> findById(String id) { return Optional.ofNullable(projects.get(id)); }
        @Override public void insert(Project project) { projects.put(project.id(), project); }
        @Override public boolean updateIfVersion(Project project, long expectedVersion) { return false; }
        @Override public List<Project> listForMember(String workspaceId, String userId) { return List.of(); }
        @Override public Optional<ProjectMember> findMember(String projectId, String userId) { return Optional.ofNullable(members.get(projectId + ":" + userId)); }
        @Override public List<ProjectMember> listMembers(String projectId) { return List.of(); }
        @Override public void upsertMember(ProjectMember member) { members.put(member.projectId() + ":" + member.userId(), member); }
        @Override public int countMembers(String projectId, MemberStatus status) { return 0; }
        @Override public boolean referenceExists(String projectId, String repositoryId) { return false; }
        @Override public void insertReference(ProjectRepositoryRef reference) {}
        @Override public int deleteReference(String projectId, String repositoryId) { return 0; }
        @Override public List<ProjectRepositoryRef> listReferences(String projectId) { return List.of(); }
        @Override public List<ProjectRepositoryRef> listReferencesByRepository(String repositoryId) { return List.of(); }
    }

    private static final class FakeRepositories implements RepositoryCatalog {
        final Map<String, Repository> items = new HashMap<>();

        @Override public Optional<Repository> findById(String id) { return Optional.ofNullable(items.get(id)); }
        @Override public void insert(Repository repository) { items.put(repository.id(), repository); }
        @Override public void update(Repository repository) { items.put(repository.id(), repository); }
        @Override public List<Repository> listByWorkspace(String workspaceId, RepositoryStatus status) { return List.of(); }
    }
}
