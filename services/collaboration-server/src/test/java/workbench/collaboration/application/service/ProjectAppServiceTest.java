package workbench.collaboration.application.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.infrastructure.cache.MemoryIdempotency;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.support.FakeStores.FakeBindings;
import workbench.collaboration.support.FakeStores.FakeDevices;
import workbench.collaboration.support.FakeStores.FakeIdentity;
import workbench.collaboration.support.FakeStores.FakeProjects;
import workbench.collaboration.support.FakeStores.FakeRepositories;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 项目应用服务全链路核对：权限矩阵（403/404/409）、CAS 版本、
 * 成员翻转语义、引用幂等与克隆设备聚合。
 */
class ProjectAppServiceTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String WS = "22222222-2222-4222-8222-222222222222";
    private static final String OTHER_WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String OWNER = "11111111-1111-4111-8111-111111111111";
    private static final String MEMBER = "55555555-5555-4555-8555-555555555555";
    private static final String OUTSIDER = "99999999-9999-4999-8999-999999999999";
    private static final String REPO = "77777777-7777-4777-8777-777777777777";
    private static final String REQ = "66666666-6666-4666-8666-666666666666";

    private final FakeIdentity identity = new FakeIdentity();
    private final FakeProjects projects = new FakeProjects();
    private final FakeRepositories repositories = new FakeRepositories();
    private final FakeBindings bindings = new FakeBindings();
    private final FakeDevices devices = new FakeDevices();
    private ProjectAppService service;

    @BeforeEach
    void setUp() {
        identity.users.put(OWNER, new User(OWNER, "owner", "负责人", true, 1L));
        identity.users.put(MEMBER, new User(MEMBER, "member", "成员", true, 1L));
        identity.users.put(OUTSIDER, new User(OUTSIDER, "outsider", "外人", true, 1L));
        identity.addMember(WS, OWNER);
        identity.addMember(WS, MEMBER);
        repositories.items.put(REPO, new Repository(
                REPO, WS, "中台服务", "git@example.com:team/middle.git", "main",
                RepositoryStatus.ACTIVE, OWNER, 1L, 1L));
        service = new ProjectAppService(
                new ProjectAccessPolicy(identity, projects, repositories),
                projects, repositories, bindings, devices, identity,
                new MemoryIdempotency(), new Contracts());
    }

    @Test
    void 创建项目携带owner成员且幂等重放一致() {
        String created = service.create(OWNER, WS, createBody());
        var project = JSON.readTree(created);
        String projectId = project.path("projectId").asString();
        assertThat(project.path("ownerUserId").asString()).isEqualTo(OWNER);
        assertThat(project.path("version").asInt()).isEqualTo(1);
        assertThat(projects.findMember(projectId, OWNER).orElseThrow().status()).isEqualTo(MemberStatus.ACTIVE);

        String replay = service.create(OWNER, WS, createBody());
        assertThat(replay).isEqualTo(created);
        assertThat(projects.projects).hasSize(1);
    }

    @Test
    void 非团队成员创建项目被拒403() {
        assertThatThrownBy(() -> service.create(OUTSIDER, WS, createBody()))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(403, "WORKSPACE_MEMBER_REQUIRED");
    }

    @Test
    void 非成员读详情404移出成员同样404() {
        String projectId = projectIdOf(service.create(OWNER, WS, createBody()));
        service.addMember(OWNER, WS, projectId, memberBody(MEMBER));

        assertThatThrownBy(() -> service.detail(OUTSIDER, WS, projectId))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
        // OUTSIDER 连团队都进不去列表语义——直接调 detail 也须 404 而非泄露

        service.removeMember(OWNER, WS, projectId, MEMBER);
        assertThatThrownBy(() -> service.detail(MEMBER, WS, projectId))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
    }

    @Test
    void 跨团队项目按404隐藏() {
        String projectId = projectIdOf(service.create(OWNER, WS, createBody()));
        assertThatThrownBy(() -> service.detail(OWNER, OTHER_WS, projectId))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
    }

    @Test
    void 非owner写操作被拒403() {
        String projectId = projectIdOf(service.create(OWNER, WS, createBody()));
        service.addMember(OWNER, WS, projectId, memberBody(MEMBER));

        assertThatThrownBy(() -> service.patch(MEMBER, WS, projectId, "{\"expectedVersion\":1}"))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(403, "PROJECT_OWNER_REQUIRED");
        assertThatThrownBy(() -> service.addMember(MEMBER, WS, projectId, memberBody(MEMBER)))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(403);
        assertThatThrownBy(() -> service.addReference(MEMBER, WS, projectId, REPO))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(403);
    }

    @Test
    void CAS版本冲突409且成功后版本加一() {
        String projectId = projectIdOf(service.create(OWNER, WS, createBody()));

        assertThatThrownBy(() -> service.patch(OWNER, WS, projectId, "{\"name\":\"改名\",\"expectedVersion\":9}"))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(409, "VERSION_CONFLICT");

        String patched = service.patch(OWNER, WS, projectId, "{\"name\":\"改名\",\"expectedVersion\":1}");
        assertThat(JSON.readTree(patched).path("name").asString()).isEqualTo("改名");
        assertThat(JSON.readTree(patched).path("version").asInt()).isEqualTo(2);
    }

    @Test
    void 归档后一切写操作409() {
        String projectId = projectIdOf(service.create(OWNER, WS, createBody()));
        service.patch(OWNER, WS, projectId, "{\"status\":\"archived\",\"expectedVersion\":1}");

        assertThatThrownBy(() -> service.addMember(OWNER, WS, projectId, memberBody(MEMBER)))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(409, "PROJECT_ARCHIVED");
        assertThatThrownBy(() -> service.addReference(OWNER, WS, projectId, REPO))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(409, "PROJECT_ARCHIVED");
    }

    @Test
    void 成员加入幂等且removed翻回active保留加入时间() {
        String projectId = projectIdOf(service.create(OWNER, WS, createBody()));
        service.addMember(OWNER, WS, projectId, memberBody(MEMBER));
        // 相同 requestId 重放幂等
        service.addMember(OWNER, WS, projectId, memberBody(MEMBER));
        assertThat(projects.countMembers(projectId, MemberStatus.ACTIVE)).isEqualTo(2);

        ProjectMember before = projects.findMember(projectId, MEMBER).orElseThrow();
        service.removeMember(OWNER, WS, projectId, MEMBER);
        assertThat(projects.findMember(projectId, MEMBER).orElseThrow().status()).isEqualTo(MemberStatus.REMOVED);

        service.addMember(OWNER, WS, projectId, memberBody2(MEMBER));
        ProjectMember rejoined = projects.findMember(projectId, MEMBER).orElseThrow();
        assertThat(rejoined.status()).isEqualTo(MemberStatus.ACTIVE);
        assertThat(rejoined.createdAtMs()).isEqualTo(before.createdAtMs());
    }

    @Test
    void owner不能移出自己409非团队成员目标400() {
        String projectId = projectIdOf(service.create(OWNER, WS, createBody()));

        assertThatThrownBy(() -> service.removeMember(OWNER, WS, projectId, OWNER))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(409, "OWNER_CANNOT_LEAVE");
        assertThatThrownBy(() -> service.addMember(OWNER, WS, projectId, memberBody(OUTSIDER)))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(400);
        assertThatThrownBy(() -> service.removeMember(OWNER, WS, projectId, MEMBER))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
    }

    @Test
    void 仓库引用幂等且聚合调用者已克隆设备() {
        String projectId = projectIdOf(service.create(OWNER, WS, createBody()));
        service.addReference(OWNER, WS, projectId, REPO);
        service.addReference(OWNER, WS, projectId, REPO); // 幂等
        assertThat(projects.listReferences(projectId)).hasSize(1);

        String memberDevice = "44444444-4444-4444-8444-444444444444";
        devices.items.put(memberDevice, new workbench.collaboration.domain.device.Device(
                memberDevice, MEMBER, "i", "l", "成员本机", "h", "r", "b", false, 1L, 1L));
        service.addMember(OWNER, WS, projectId, memberBody(MEMBER));
        bindings.upsert(new workbench.collaboration.domain.repository.LocalRepoBinding(memberDevice, REPO, 5L));

        String listed = service.listRepositories(MEMBER, WS, projectId);
        var repos = JSON.readTree(listed).path("repositories");
        assertThat(repos.size()).isEqualTo(1);
        assertThat(repos.get(0).path("clonedDevices").size()).isEqualTo(1);
        assertThat(repos.get(0).path("clonedDevices").get(0).path("deviceId").asString()).isEqualTo(memberDevice);
        // 非本人设备的克隆对调用者不可见
        String ownerView = service.listRepositories(OWNER, WS, projectId);
        assertThat(JSON.readTree(ownerView).path("repositories").get(0).path("clonedDevices").size()).isEqualTo(0);
    }

    @Test
    void 引用归档仓库409移除不存在引用404() {
        String projectId = projectIdOf(service.create(OWNER, WS, createBody()));
        repositories.items.put("archived-repo", new Repository(
                "archived-repo", WS, "旧库", "git@example.com:team/old.git", "main",
                RepositoryStatus.ARCHIVED, OWNER, 1L, 1L));

        assertThatThrownBy(() -> service.addReference(OWNER, WS, projectId, "archived-repo"))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(409, "REPOSITORY_ARCHIVED");
        assertThatThrownBy(() -> service.addReference(OWNER, WS, projectId,
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
        assertThatThrownBy(() -> service.removeReference(OWNER, WS, projectId, REPO))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);

        service.addReference(OWNER, WS, projectId, REPO);
        service.removeReference(OWNER, WS, projectId, REPO);
        assertThat(projects.listReferences(projectId)).isEmpty();
    }

    @Test
    void 成员列表含removed并带leftAt() {
        String projectId = projectIdOf(service.create(OWNER, WS, createBody()));
        service.addMember(OWNER, WS, projectId, memberBody(MEMBER));
        service.removeMember(OWNER, WS, projectId, MEMBER);

        String listed = service.listMembers(OWNER, WS, projectId);
        var members = JSON.readTree(listed).path("members");
        assertThat(members.size()).isEqualTo(2);
        var removed = java.util.stream.StreamSupport.stream(members.spliterator(), false)
                .filter(m -> m.path("userId").asString().equals(MEMBER)).findFirst().orElseThrow();
        assertThat(removed.path("status").asString()).isEqualTo("removed");
        assertThat(removed.path("leftAt").isNull()).isFalse();
    }

    private static String projectIdOf(String json) {
        return JSON.readTree(json).path("projectId").asString();
    }

    private static String createBody() {
        return "{\"name\":\"账单服务\",\"description\":\"计费\",\"requestId\":\"" + REQ + "\"}";
    }

    private static String memberBody(String userId) {
        return "{\"userId\":\"" + userId + "\",\"requestId\":\"" + REQ + "\"}";
    }

    private static String memberBody2(String userId) {
        return "{\"userId\":\"" + userId + "\",\"requestId\":\"88888888-8888-4888-8888-888888888888\"}";
    }
}
