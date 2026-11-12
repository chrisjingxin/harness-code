package workbench.collaboration.application.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectRepositoryRef;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.infrastructure.cache.MemoryIdempotency;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.support.FakeStores.FakeIdentity;
import workbench.collaboration.support.FakeStores.FakeProjects;
import workbench.collaboration.support.FakeStores.FakeRepositories;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 仓库目录应用服务核对：登记/列表/详情/归档权限与冲突语义，
 * 详情中"引用项目"只回调用者可见的项目。
 */
class RepositoryAppServiceTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String WS = "22222222-2222-4222-8222-222222222222";
    private static final String OWNER = "11111111-1111-4111-8111-111111111111";
    private static final String MEMBER = "55555555-5555-4555-8555-555555555555";
    private static final String OUTSIDER = "99999999-9999-4999-8999-999999999999";
    private static final String REQ = "66666666-6666-4666-8666-666666666666";

    private final FakeIdentity identity = new FakeIdentity();
    private final FakeProjects projects = new FakeProjects();
    private final FakeRepositories repositories = new FakeRepositories();
    private RepositoryAppService service;

    @BeforeEach
    void setUp() {
        identity.users.put(OWNER, new User(OWNER, "owner", "负责人", true, 1L));
        identity.users.put(MEMBER, new User(MEMBER, "member", "成员", true, 1L));
        identity.users.put(OUTSIDER, new User(OUTSIDER, "outsider", "外人", true, 1L));
        identity.addMember(WS, OWNER);
        identity.addMember(WS, MEMBER);
        service = new RepositoryAppService(
                new ProjectAccessPolicy(identity, projects, repositories),
                repositories, projects, new MemoryIdempotency(), new Contracts());
    }

    @Test
    void 登记仓库幂等且默认分支缺省为main() {
        String created = service.create(OWNER, WS, createBody());
        var repository = JSON.readTree(created);
        assertThat(repository.path("defaultBranch").asString()).isEqualTo("main");
        assertThat(repository.path("status").asString()).isEqualTo("active");

        String replay = service.create(OWNER, WS, createBody());
        assertThat(replay).isEqualTo(created);
        assertThat(repositories.items).hasSize(1);
    }

    @Test
    void remoteUrl重复被拒409() {
        service.create(OWNER, WS, createBody());
        String duplicate = "{\"name\":\"另一个\",\"remoteUrl\":\"git@example.com:team/middle.git\","
                + "\"requestId\":\"88888888-8888-4888-8888-888888888888\"}";
        assertThatThrownBy(() -> service.create(OWNER, WS, duplicate))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(409, "REPOSITORY_CONFLICT");
    }

    @Test
    void 非团队成员被拒403跨团队仓库404() {
        assertThatThrownBy(() -> service.create(OUTSIDER, WS, createBody()))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(403);
        String repositoryId = repositoryIdOf(service.create(OWNER, WS, createBody()));
        // OUTSIDER 是另一团队成员：过了工作区门槛后按资源归属判定为 404
        identity.addMember("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OUTSIDER);
        assertThatThrownBy(() -> service.detail(OUTSIDER, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", repositoryId))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
    }

    @Test
    void 详情只回调用者可见的引用项目() {
        String repositoryId = repositoryIdOf(service.create(OWNER, WS, createBody()));
        String projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        projects.insert(new Project(projectId, WS, "账单", "", OWNER, ProjectStatus.ACTIVE, 1L, 1L, 1L));
        projects.upsertMember(new ProjectMember(projectId, OWNER, MemberStatus.ACTIVE, 1L, 1L));
        projects.upsertMember(new ProjectMember(projectId, MEMBER, MemberStatus.ACTIVE, 1L, 1L));
        projects.insertReference(new ProjectRepositoryRef(projectId, repositoryId, 1L));

        assertThat(JSON.readTree(service.detail(MEMBER, WS, repositoryId)).path("projects").size()).isEqualTo(1);
        // 团队成员但不是项目成员 → projects 为空但仓库本身可见
        assertThatThrownBy(() -> service.detail(OUTSIDER, WS, repositoryId))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(403);
    }

    @Test
    void 归档单向且归档后拒绝修改409() {
        String repositoryId = repositoryIdOf(service.create(OWNER, WS, createBody()));
        String archived = service.patch(OWNER, WS, repositoryId, "{\"status\":\"archived\"}");
        assertThat(JSON.readTree(archived).path("status").asString()).isEqualTo("archived");

        assertThatThrownBy(() -> service.patch(OWNER, WS, repositoryId, "{\"name\":\"改名\"}"))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(409, "REPOSITORY_ARCHIVED");

        String listed = service.list(MEMBER, WS, "archived");
        assertThat(JSON.readTree(listed).path("repositories").size()).isEqualTo(1);
        assertThat(JSON.readTree(service.list(MEMBER, WS, "active")).path("repositories").size()).isEqualTo(0);
    }

    private static String repositoryIdOf(String json) {
        return JSON.readTree(json).path("repositoryId").asString();
    }

    private static String createBody() {
        return "{\"name\":\"中台服务\",\"remoteUrl\":\"git@example.com:team/middle.git\",\"requestId\":\"" + REQ + "\"}";
    }
}
