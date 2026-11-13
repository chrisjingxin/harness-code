package workbench.collaboration.application.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.NotificationPort;
import workbench.collaboration.application.port.SearchIndexBus;
import workbench.collaboration.domain.access.ProjectAccessPolicy;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.support.FakeStores;
import workbench.collaboration.domain.project.MemberStatus;
import workbench.collaboration.domain.project.Project;
import workbench.collaboration.domain.project.ProjectMember;
import workbench.collaboration.domain.project.ProjectStatus;
import workbench.collaboration.infrastructure.cache.MemoryDeviceHeartbeat;
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

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.mock;

/**
 * 设备会话同步核对：Bearer 认证、owner 授权（D9）、序号连续/跳号 409 带期望序号、
 * 重放幂等、类型与尺寸上限、简报/状态/水位推进、通知事件与心跳。
 */
class ConversationSyncAppServiceTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String WS = "22222222-2222-4222-8222-222222222222";
    private static final String PROJECT = "55555555-5555-4555-8555-555555555555";
    private static final String OWNER = "11111111111141118111111111111111";
    private static final String OTHER = "99999999999949998999999999999999";
    private static final String CONV = "88888888-8888-4888-8888-888888888888";
    private static final String DEVICE = "33333333-3333-4333-8333-333333333333";
    private static final String OTHER_DEVICE = "44444444-4444-4444-8444-444444444444";
    private static final String SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

    private final FakeIdentity identity = new FakeIdentity();
    private final FakeProjects projects = new FakeProjects();
    private final FakeConversations conversations = new FakeConversations();
    private final MemoryHotWindow messages = new MemoryHotWindow();
    private final MemoryDeviceHeartbeat heartbeats = new MemoryDeviceHeartbeat();
    private final CapturingIndex index = new CapturingIndex();
    private final CapturingNotifications notifications = new CapturingNotifications();
    private ConversationSyncAppService service;

    @BeforeEach
    void setUp() {
        identity.users.put(OWNER, FakeStores.user(OWNER, "80278667", "负责人", true));
        identity.users.put(OTHER, FakeStores.user(OTHER, "80278669", "外人", true));
        identity.addMember(WS, OWNER);
        identity.addMember(WS, OTHER);
        projects.projects.put(PROJECT, new Project(
                PROJECT, WS, "账单服务", "计费与对账", OWNER, ProjectStatus.ACTIVE, 1L, 1L, 1L));
        projects.upsertMember(new ProjectMember(PROJECT, OWNER, MemberStatus.ACTIVE, 1L, 1L));
        FakeDevices devices = new FakeDevices();
        devices.items.put(DEVICE, new Device(
                DEVICE, OWNER, "inst", "ledger", "owner本机", Digests.sha256Hex(SECRET),
                "reg", "body", false, 1L, 1L));
        devices.items.put(OTHER_DEVICE, new Device(
                OTHER_DEVICE, OTHER, "i", "l", "别人的机", Digests.sha256Hex(SECRET),
                "r", "b", false, 1L, 1L));
        conversations.insert(conversation(0L));

        IdentityAppService identityService = mock(IdentityAppService.class);
        doNothing().when(identityService).requireMember(any(), any());
        DeviceAppService deviceService = new DeviceAppService(
                devices, identityService, new MemoryIdempotency(), heartbeats, new Contracts());
        service = new ConversationSyncAppService(
                deviceService, conversations, messages, index, heartbeats,
                notifications, new ProjectAccessPolicy(identity, projects, new FakeRepositories()),
                new Contracts());
    }

    @Test
    void 同步推进水位写热窗更新简报并发通知() {
        String response = service.sync(auth(), CONV, syncBody(
                "[{\"sequence\":1,\"type\":\"user\",\"occurredAtMs\":10,\"payload\":\"{\\\"text\\\":\\\"hi\\\"}\"},"
                        + "{\"sequence\":2,\"type\":\"assistant\",\"occurredAtMs\":11,\"payload\":\"{\\\"text\\\":\\\"ok\\\"}\"}]",
                "{\"status\":\"running\",\"briefText\":\"正在核对\",\"briefSource\":\"rule\"}"));

        assertThat(JSON.readTree(response).path("syncedSequence").asInt()).isEqualTo(2);
        assertThat(messages.messageCount(CONV)).isEqualTo(2);
        Conversation stored = conversations.items.get(CONV);
        assertThat(stored.syncedSequence()).isEqualTo(2L);
        assertThat(stored.status()).isEqualTo("running");
        assertThat(stored.briefText()).isEqualTo("正在核对");
        assertThat(stored.briefUpdatedAtMs()).isNotNull();
        // 消息 2 条 + 会话头 1 条 → 3 个检索文档
        assertThat(index.docs).hasSize(3);
        assertThat(notifications.events).containsExactly("conversation.brief_updated:" + CONV);
    }

    @Test
    void 非owner设备与owner被移出项目一律403() {
        assertThatThrownBy(() -> service.sync("Bearer " + OTHER_DEVICE + "." + SECRET, CONV, syncBody("[]", null)))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(403, "DEVICE_FORBIDDEN");

        projects.upsertMember(new ProjectMember(PROJECT, OWNER, MemberStatus.REMOVED, 1L, 1L));
        assertThatThrownBy(() -> service.sync(auth(), CONV, syncBody("[]", null)))
                .isInstanceOf(ApiProblem.class).extracting("status", "code")
                .containsExactly(403, "DEVICE_FORBIDDEN");
    }

    @Test
    void 跳号409带expectedSequence且批内断档同样409() {
        assertThatThrownBy(() -> service.sync(auth(), CONV, syncBody(
                "[{\"sequence\":3,\"type\":\"user\",\"occurredAtMs\":10,\"payload\":\"{}\"}]", null)))
                .isInstanceOf(ApiProblem.class).extracting("status", "code", "expectedSequence")
                .containsExactly(409, "SEQUENCE_CONFLICT", 1L);

        assertThatThrownBy(() -> service.sync(auth(), CONV, syncBody(
                "[{\"sequence\":1,\"type\":\"user\",\"occurredAtMs\":10,\"payload\":\"{}\"},"
                        + "{\"sequence\":3,\"type\":\"user\",\"occurredAtMs\":11,\"payload\":\"{}\"}]", null)))
                .isInstanceOf(ApiProblem.class).extracting("status", "code", "expectedSequence")
                .containsExactly(409, "SEQUENCE_CONFLICT", 2L);
        assertThat(messages.messageCount(CONV)).isEqualTo(0);
    }

    @Test
    void 整批重放幂等返回水位且不重复写入() {
        service.sync(auth(), CONV, syncBody(
                "[{\"sequence\":1,\"type\":\"user\",\"occurredAtMs\":10,\"payload\":\"{}\"}]", null));
        String replay = service.sync(auth(), CONV, syncBody(
                "[{\"sequence\":1,\"type\":\"user\",\"occurredAtMs\":10,\"payload\":\"{}\"}]", null));

        assertThat(JSON.readTree(replay).path("syncedSequence").asInt()).isEqualTo(1);
        assertThat(messages.messageCount(CONV)).isEqualTo(1);
    }

    @Test
    void 非法类型契约先拒超限载荷业务拒400() {
        // 类型枚举由契约 schema 先行拒绝（IllegalArgumentException → 接口层同样渲染 400）
        assertThatThrownBy(() -> service.sync(auth(), CONV, syncBody(
                "[{\"sequence\":1,\"type\":\"stream\",\"occurredAtMs\":10,\"payload\":\"{}\"}]", null)))
                .isInstanceOf(IllegalArgumentException.class);

        String big = "x".repeat(33 * 1024);
        assertThatThrownBy(() -> service.sync(auth(), CONV, syncBody(
                "[{\"sequence\":1,\"type\":\"user\",\"occurredAtMs\":10,\"payload\":\"" + big + "\"}]", null)))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(400);
    }

    @Test
    void 整批字节超1MB一律400() {
        StringBuilder batch = new StringBuilder("[");
        String chunk = "x".repeat(32 * 1024);
        for (int i = 1; i <= 33; i++) {
            if (i > 1) {
                batch.append(',');
            }
            batch.append("{\"sequence\":").append(i)
                    .append(",\"type\":\"user\",\"occurredAtMs\":").append(1000 + i)
                    .append(",\"payload\":\"").append(chunk).append("\"}");
        }
        batch.append(']');
        assertThatThrownBy(() -> service.sync(auth(), CONV, syncBody(batch.toString(), null)))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(400);
    }

    @Test
    void 空批仅更新简报水位不变() {
        String response = service.sync(auth(), CONV, syncBody("[]",
                "{\"briefText\":\"阶段性结论\"}"));

        assertThat(JSON.readTree(response).path("syncedSequence").asInt()).isEqualTo(0);
        Conversation stored = conversations.items.get(CONV);
        assertThat(stored.briefText()).isEqualTo("阶段性结论");
        assertThat(stored.status()).isEqualTo("idle");
        assertThat(messages.messageCount(CONV)).isEqualTo(0);
    }

    @Test
    void 心跳仅刷新在线展示键() {
        assertThat(heartbeats.isOnline(DEVICE)).isFalse();
        service.heartbeat(auth());
        assertThat(heartbeats.isOnline(DEVICE)).isTrue();
        assertThatThrownBy(() -> service.heartbeat("Bearer " + DEVICE + ".wrong"))
                .isInstanceOf(ApiProblem.class).extracting("status").isEqualTo(401);
    }

    private static Conversation conversation(long watermark) {
        return new Conversation(
                CONV, WS, PROJECT, OWNER, DEVICE, "", "", "idle", "联调",
                "", "rule", 1L, watermark, "", 1L, 1L);
    }

    private static String auth() {
        return "Bearer " + DEVICE + "." + SECRET;
    }

    private static String syncBody(String messagesArray, String briefObject) {
        if (briefObject == null) {
            return "{\"messages\":" + messagesArray + "}";
        }
        return "{\"messages\":" + messagesArray + ",\"brief\":" + briefObject + "}";
    }

    private static final class CapturingIndex implements SearchIndexBus {
        final List<String> docs = new ArrayList<>();
        @Override public void publishSearchIndex(String workspaceId, String documentJson) {
            docs.add(documentJson);
        }
    }

    private static final class CapturingNotifications implements NotificationPort {
        final List<String> events = new ArrayList<>();
        @Override public void publish(String eventType, String subjectId, Map<String, Object> payload) {
            events.add(eventType + ":" + subjectId);
        }
    }
}
