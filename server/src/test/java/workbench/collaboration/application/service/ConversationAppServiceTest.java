package workbench.collaboration.application.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.application.port.SearchIndexBus;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.support.FakeStores;
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
import workbench.collaboration.interfaces.ApiProblem;
import workbench.collaboration.support.FakeStores.FakeConversations;
import workbench.collaboration.support.FakeStores.FakeIdentity;
import workbench.collaboration.support.FakeStores.FakeProjects;
import workbench.collaboration.support.FakeStores.FakeRepositories;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 项目内会话共享核对：登记授权（项目成员/引用子集/归档）、
 * 成员只读（404 隐藏）、简报过滤、序号增量历史与仓库快照。
 */
class ConversationAppServiceTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String WS = "22222222-2222-4222-8222-222222222222";
    private static final String OTHER_WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String PROJECT = "55555555-5555-4555-8555-555555555555";
    private static final String OWNER = "11111111111141118111111111111111";
    private static final String MEMBER = "55555555555545558555555555555555";
    private static final String OUTSIDER = "99999999999949998999999999999999";
    private static final String REPO = "77777777-7777-4777-8777-777777777777";
    private static final String OTHER_REPO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static final String REQ = "66666666-6666-4666-8666-666666666666";

    private final FakeIdentity identity = new FakeIdentity();
    private final FakeProjects projects = new FakeProjects();
    private final FakeRepositories repositories = new FakeRepositories();
    private final FakeConversations conversations = new FakeConversations();
    private final MemoryHotWindow messages = new MemoryHotWindow();
    private final List<String> indexedDocs = new ArrayList<>();
    private final List<String> notifications = new ArrayList<>();
    private ConversationAppService service;

    @BeforeEach
    void setUp() {
        identity.users.put(OWNER, FakeStores.user(OWNER, "80278667", "负责人", true));
        identity.users.put(MEMBER, FakeStores.user(MEMBER, "80278668", "成员", true));
        identity.users.put(OUTSIDER, FakeStores.user(OUTSIDER, "80278669", "外人", true));
        identity.addMember(WS, OWNER);
        identity.addMember(WS, MEMBER);
        projects.projects.put(PROJECT, new Project(
                PROJECT, WS, "账单服务", "计费与对账", OWNER, ProjectStatus.ACTIVE, 1L, 1L, 1L));
        projects.upsertMember(new ProjectMember(PROJECT, OWNER, MemberStatus.ACTIVE, 1L, 1L));
        projects.upsertMember(new ProjectMember(PROJECT, MEMBER, MemberStatus.ACTIVE, 1L, 1L));
        projects.insertReference(new ProjectRepositoryRef(PROJECT, REPO, 1L));
        repositories.items.put(REPO, new Repository(
                REPO, WS, "中台服务", "git@example.com:team/middle.git", "main",
                RepositoryStatus.ACTIVE, OWNER, null, 1L, 1L, 1L));
        NotificationPort notificationPort = (eventType, subjectId, payload) -> notifications.add(eventType + ":" + subjectId);
        SearchIndexBus indexBus = (workspaceId, docJson) -> indexedDocs.add(docJson);
        service = new ConversationAppService(
                new ProjectAccessPolicy(identity, projects, repositories),
                conversations, messages, projects, repositories,
                new MemoryIdempotency(), new Contracts(), notificationPort, indexBus);
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
    void 仓库引用必须是项目引用子集否则400() {
        assertThatThrownBy(() -> service.register(OWNER, WS, PROJECT,
                "{\"repositoryIds\":[\"" + OTHER_REPO + "\"],\"requestId\":\"" + REQ + "\"}"))
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
                "{\"requestId\":\"88888888-8888-4888-8888-888888888888\"}");

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

    @Test
    void 摘要档位支持指定conversationId与初始简报且历史始终返回空() {
        String presetId = "88888888-8888-4888-8888-888888888888";
        String otherProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        String req1 = "12121212-1212-4121-8121-121212121212";
        String req2 = "34343434-3434-4343-8343-343434343434";
        projects.projects.put(otherProject, new Project(
                otherProject, WS, "订单服务", "", OWNER, ProjectStatus.ACTIVE, 1L, 1L, 1L));
        projects.upsertMember(new ProjectMember(otherProject, OWNER, MemberStatus.ACTIVE, 1L, 1L));

        String body = "{\"title\":\"仅共享结论\",\"repositoryIds\":[\"" + REPO + "\"],"
                + "\"conversationId\":\"" + presetId + "\",\"shareMode\":\"summary_only\","
                + "\"initialBrief\":{\"status\":\"idle\",\"briefText\":\"已定位死锁并给出修复方案\",\"briefSource\":\"rule\"},"
                + "\"requestId\":\"" + req1 + "\"}";

        String created = service.register(OWNER, WS, PROJECT, body);
        var summary = JSON.readTree(created).path("conversation");
        assertThat(summary.path("conversationId").asString()).isEqualTo(presetId);
        assertThat(summary.path("shareMode").asString()).isEqualTo("summary_only");
        assertThat(summary.path("shareStatus").asString()).isEqualTo("active");
        assertThat(summary.path("stoppedAt").isNull()).isTrue();
        assertThat(summary.path("briefText").asString()).isEqualTo("已定位死锁并给出修复方案");
        assertThat(summary.path("briefSource").asString()).isEqualTo("rule");
        assertThat(notifications).containsExactly("conversation.brief_updated:" + presetId);

        // 同 requestId 幂等重放
        String replay = service.register(OWNER, WS, PROJECT, body);
        assertThat(replay).isEqualTo(created);

        // 相同 conversationId 跨项目或换 requestId 冲突 409 CONVERSATION_CONFLICT
        String conflictBody = "{\"title\":\"冲突\",\"conversationId\":\"" + presetId + "\",\"requestId\":\"" + req2 + "\"}";
        assertThatThrownBy(() -> service.register(OWNER, WS, otherProject, conflictBody))
                .isInstanceOf(ApiProblem.class)
                .extracting("status", "code")
                .containsExactly(409, "CONVERSATION_CONFLICT");

        // 即使底层消息库已有误写入记录，summary_only 会话历史查询也始终返回 0 水位空列表
        seedMessages(presetId, 2);
        String historyJson = service.history(MEMBER, WS, PROJECT, presetId, 0, 100);
        var history = JSON.readTree(historyJson);
        assertThat(history.path("syncedSequence").asLong()).isEqualTo(0L);
        assertThat(history.path("messages").size()).isEqualTo(0);
    }

    @Test
    void 停止共享仅owner可用且幂等并允许归档项目止损() {
        String created = service.register(OWNER, WS, PROJECT, registerBody());
        String conversationId = conversationIdOf(created);
        assertThat(JSON.readTree(created).path("conversation").path("shareMode").asString()).isEqualTo("full");
        assertThat(JSON.readTree(created).path("conversation").path("shareStatus").asString()).isEqualTo("active");
        assertThat(JSON.readTree(created).path("conversation").path("stoppedAt").isNull()).isTrue();

        assertThatThrownBy(() -> service.stopSharing(OUTSIDER, WS, PROJECT, conversationId))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(404);
        assertThatThrownBy(() -> service.stopSharing(MEMBER, WS, PROJECT, conversationId))
                .isInstanceOf(ApiProblem.class)
                .extracting("status", "code")
                .containsExactly(403, "CONVERSATION_FORBIDDEN");

        // 模拟项目归档后 owner 仍可执行停止共享止损
        projects.projects.put(PROJECT, new Project(
                PROJECT, WS, "账单服务", "计费与对账", OWNER, ProjectStatus.ARCHIVED, 2L, 1L, 2L));
        notifications.clear();
        indexedDocs.clear();

        String stopped = service.stopSharing(OWNER, WS, PROJECT, conversationId);
        var stoppedSummary = JSON.readTree(stopped).path("conversation");
        assertThat(stoppedSummary.path("shareStatus").asString()).isEqualTo("stopped");
        String stoppedAt = stoppedSummary.path("stoppedAt").asString();
        assertThat(stoppedAt).isNotBlank();
        assertThat(notifications).containsExactly("conversation.brief_updated:" + conversationId);
        assertThat(indexedDocs).hasSize(1);
        assertThat(indexedDocs.get(0)).contains("\"shareStatus\":\"stopped\"");

        // 幂等重复调用：保持首次 stoppedAt 且不再重复发送通知或写索引
        String repeated = service.stopSharing(OWNER, WS, PROJECT, conversationId);
        assertThat(JSON.readTree(repeated).path("conversation").path("stoppedAt").asString()).isEqualTo(stoppedAt);
        assertThat(notifications).hasSize(1);
        assertThat(indexedDocs).hasSize(1);
    }

    private void seedMessages(String conversationId, int count) {
        for (int i = 1; i <= count; i++) {
            messages.save(new Message("m" + i, WS, conversationId, "assistant", i, "{}", i));
        }
    }

    private static String conversationIdOf(String json) {
        return JSON.readTree(json).path("conversation").path("conversationId").asString();
    }

    private static String registerBody() {
        return "{\"title\":\"联调\",\"repositoryIds\":[\"" + REPO + "\"],\"requestId\":\"" + REQ + "\"}";
    }
}
