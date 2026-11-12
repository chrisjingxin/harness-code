package workbench.collaboration.application.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectRepositoryRef;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.domain.repository.Repository;
import workbench.collaboration.domain.repository.RepositoryStatus;
import workbench.collaboration.infrastructure.cache.MemoryHotWindow;
import workbench.collaboration.infrastructure.cache.MemoryIdempotency;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.contract.Digests;
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.support.FakeStores.FakeConversations;
import workbench.collaboration.support.FakeStores.FakeDevices;
import workbench.collaboration.support.FakeStores.FakeIdentity;
import workbench.collaboration.support.FakeStores.FakeProjects;
import workbench.collaboration.support.FakeStores.FakeRepositories;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 项目内会话只读共享核对：登记授权（本人设备/引用子集/归档）、
 * 成员只读（404 隐藏）、简报过滤、序号增量历史与仓库快照。
 */
class ConversationAppServiceTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String WS = "22222222-2222-4222-8222-222222222222";
    private static final String OTHER_WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String PROJECT = "55555555-5555-4555-8555-555555555555";
    private static final String OWNER = "11111111-1111-4111-8111-111111111111";
    private static final String MEMBER = "55555555-5555-4555-8555-555555555555";
    private static final String OUTSIDER = "99999999-9999-4999-8999-999999999999";
    private static final String REPO = "77777777-7777-4777-8777-777777777777";
    private static final String OTHER_REPO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static final String DEVICE = "33333333-3333-4333-8333-333333333333";
    private static final String REQ = "66666666-6666-4666-8666-666666666666";

    private final FakeIdentity identity = new FakeIdentity();
    private final FakeProjects projects = new FakeProjects();
    private final FakeRepositories repositories = new FakeRepositories();
    private final FakeDevices devices = new FakeDevices();
    private final FakeConversations conversations = new FakeConversations();
    private final MemoryHotWindow messages = new MemoryHotWindow();
    private ConversationAppService service;

    @BeforeEach
    void setUp() {
        identity.users.put(OWNER, new User(OWNER, "owner", "负责人", true, 1L));
        identity.users.put(MEMBER, new User(MEMBER, "member", "成员", true, 1L));
        identity.users.put(OUTSIDER, new User(OUTSIDER, "outsider", "外人", true, 1L));
        identity.addMember(WS, OWNER);
        identity.addMember(WS, MEMBER);
        projects.projects.put(PROJECT, new Project(
                PROJECT, WS, "账单服务", "计费与对账", OWNER, ProjectStatus.ACTIVE, 1L, 1L, 1L));
        projects.upsertMember(new ProjectMember(PROJECT, OWNER, MemberStatus.ACTIVE, 1L, 1L));
        projects.upsertMember(new ProjectMember(PROJECT, MEMBER, MemberStatus.ACTIVE, 1L, 1L));
        projects.insertReference(new ProjectRepositoryRef(PROJECT, REPO, 1L));
        repositories.items.put(REPO, new Repository(
                REPO, WS, "中台服务", "git@example.com:team/middle.git", "main",
                RepositoryStatus.ACTIVE, OWNER, 1L, 1L));
        devices.items.put(DEVICE, new Device(
                DEVICE, OWNER, "inst", "ledger", "owner本机", Digests.sha256Hex("s"),
                "reg", "body", false, 1L, 1L));
        devices.items.put(memberDevice(), new Device(
                memberDevice(), MEMBER, "i", "l", "成员本机", "h", "r", "b", false, 1L, 1L));
        service = new ConversationAppService(
                new ProjectAccessPolicy(identity, projects, repositories),
                conversations, messages, projects, repositories, devices,
                new MemoryIdempotency(), new Contracts());
    }

    @Test
    void 登记成功带仓库快照且幂等重放一致() {
        String created = service.register(OWNER, WS, PROJECT, registerBody());
        var conversation = JSON.readTree(created).path("conversation");
        String conversationId = conversation.path("conversationId").asString();
        assertThat(conversation.path("ownerUserId").asString()).isEqualTo(OWNER);
        assertThat(conversation.path("status").asString()).isEqualTo("idle");
        assertThat(conversation.path("briefSource").asString()).isEqualTo("rule");
        assertThat(conversation.path("syncedSequence").asInt()).isEqualTo(0);
        assertThat(conversation.path("repositories").size()).isEqualTo(1);
        assertThat(conversations.listRepositoryIds(conversationId)).containsExactly(REPO);

        String replay = service.register(OWNER, WS, PROJECT, registerBody());
        assertThat(replay).isEqualTo(created);
        assertThat(conversations.items).hasSize(1);
    }

    @Test
    void 非项目成员与外人登记一律404() {
        assertThatThrownBy(() -> service.register(OUTSIDER, WS, PROJECT, registerBody()))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
        assertThatThrownBy(() -> service.register(OWNER, OTHER_WS, PROJECT, registerBody()))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
    }

    @Test
    void 登记设备必须是本人未吊销设备否则400() {
        String otherDevice = "44444444-4444-4444-8444-444444444444";
        devices.items.put(otherDevice, new Device(
                otherDevice, MEMBER, "i", "l", "成员本机", "h", "r", "b", false, 1L, 1L));
        assertThatThrownBy(() -> service.register(OWNER, WS, PROJECT,
                "{\"deviceId\":\"" + otherDevice + "\",\"requestId\":\"" + REQ + "\"}"))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(400);
        assertThatThrownBy(() -> service.register(OWNER, WS, PROJECT,
                "{\"deviceId\":\"" + OTHER_REPO + "\",\"requestId\":\"" + REQ + "\"}"))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(400);
    }

    @Test
    void 仓库引用必须是项目引用子集否则400() {
        assertThatThrownBy(() -> service.register(OWNER, WS, PROJECT,
                "{\"deviceId\":\"" + DEVICE + "\",\"repositoryIds\":[\"" + OTHER_REPO + "\"],\"requestId\":\"" + REQ + "\"}"))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(400);
        assertThat(conversations.items).isEmpty();
    }

    @Test
    void 归档项目禁止登记409() {
        projects.projects.put(PROJECT, new Project(
                PROJECT, WS, "账单服务", "计费与对账", OWNER, ProjectStatus.ARCHIVED, 1L, 1L, 1L));
        assertThatThrownBy(() -> service.register(OWNER, WS, PROJECT, registerBody()))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(409, "PROJECT_ARCHIVED");
    }

    @Test
    void 列表按owner与状态过滤且非成员404() {
        service.register(OWNER, WS, PROJECT, registerBody());
        service.register(MEMBER, WS, PROJECT,
                "{\"deviceId\":\"" + memberDevice() + "\",\"requestId\":\"88888888-8888-4888-8888-888888888888\"}");

        String all = service.list(MEMBER, WS, PROJECT, null, null);
        assertThat(JSON.readTree(all).path("conversations").size()).isEqualTo(2);
        String onlyOwner = service.list(MEMBER, WS, PROJECT, OWNER, null);
        assertThat(JSON.readTree(onlyOwner).path("conversations").size()).isEqualTo(1);
        String idle = service.list(MEMBER, WS, PROJECT, null, "idle");
        assertThat(JSON.readTree(idle).path("conversations").size()).isEqualTo(2);
        String running = service.list(MEMBER, WS, PROJECT, null, "running");
        assertThat(JSON.readTree(running).path("conversations").size()).isEqualTo(0);

        assertThatThrownBy(() -> service.list(OUTSIDER, WS, PROJECT, null, null))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
    }

    @Test
    void 详情与历史只对项目成员可见() {
        String conversationId = conversationIdOf(service.register(OWNER, WS, PROJECT, registerBody()));

        String detail = service.detail(MEMBER, WS, PROJECT, conversationId);
        assertThat(JSON.readTree(detail).path("conversation").path("conversationId").asString()).isEqualTo(conversationId);
        assertThatThrownBy(() -> service.detail(OUTSIDER, WS, PROJECT, conversationId))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
        // 跨项目会话同样 404，不泄露存在性
        assertThatThrownBy(() -> service.detail(MEMBER, WS, OTHER_REPO, conversationId))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
    }

    @Test
    void 历史按afterSequence增量返回且带水位() {
        String conversationId = conversationIdOf(service.register(OWNER, WS, PROJECT, registerBody()));
        seedMessages(conversationId, 5);

        String first = service.history(MEMBER, WS, PROJECT, conversationId, 0, 3);
        var page = JSON.readTree(first);
        assertThat(page.path("syncedSequence").asInt()).isEqualTo(0); // 水位以会话头为准
        assertThat(page.path("messages").size()).isEqualTo(3);
        assertThat(page.path("messages").get(0).path("sequence").asInt()).isEqualTo(1);

        String rest = service.history(MEMBER, WS, PROJECT, conversationId, 3, 100);
        var tail = JSON.readTree(rest).path("messages");
        assertThat(tail.size()).isEqualTo(2);
        assertThat(tail.get(0).path("sequence").asInt()).isEqualTo(4);

        assertThatThrownBy(() -> service.history(OUTSIDER, WS, PROJECT, conversationId, 0, 100))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
    }

    private void seedMessages(String conversationId, int count) {
        for (int i = 1; i <= count; i++) {
            messages.save(new Message("m" + i, WS, conversationId, "assistant", i, "{}", i));
        }
    }

    private static String memberDevice() {
        return "44444444-4444-4444-8444-444444444444";
    }

    private static String conversationIdOf(String json) {
        return JSON.readTree(json).path("conversation").path("conversationId").asString();
    }

    private static String registerBody() {
        return "{\"deviceId\":\"" + DEVICE + "\",\"title\":\"联调\",\"repositoryIds\":[\"" + REPO + "\"],\"requestId\":\"" + REQ + "\"}";
    }
}
