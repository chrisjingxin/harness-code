package workbench.collaboration.application.service;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.RealtimeBroadcastPort;
import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.ConversationRepository;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.conversation.MessageStorePort;
import workbench.collaboration.domain.device.Device;
import workbench.collaboration.domain.device.DeviceRepository;
import workbench.collaboration.domain.device.SharedProject;
import workbench.collaboration.domain.execution.ExecutionState;
import workbench.collaboration.domain.identity.User;
import workbench.collaboration.infrastructure.cache.MemoryExecutionState;
import workbench.collaboration.infrastructure.cache.MemoryHotWindow;
import workbench.collaboration.infrastructure.cache.MemoryIdempotency;
import workbench.collaboration.infrastructure.cache.MemoryPresence;
import workbench.collaboration.infrastructure.contract.ContractEventEncoder;
import workbench.collaboration.infrastructure.contract.Contracts;
import workbench.collaboration.infrastructure.messaging.ConversationEventHub;
import workbench.collaboration.interfaces.ApiProblem;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 提问只创建一份执行。相同正文重放，换正文或换会话都是 409。事件先于 Daemon 命令。 */
class ConversationAppServiceTest {
  private static final JsonMapper JSON = JsonMapper.builder().build();
  private static final String USER = "11111111-1111-4111-8111-111111111111";
  private static final String WORKSPACE = "22222222-2222-4222-8222-222222222222";
  private static final String DEVICE = "33333333-3333-4333-8333-333333333333";
  private static final String PROJECT = "44444444-4444-4444-8444-444444444444";
  private static final String AGENT = "55555555-5555-4555-8555-555555555555";

  private final IdentityAppService identity = mock(IdentityAppService.class);
  private final ConversationRepository conversations = mock(ConversationRepository.class);
  private final DeviceRepository devices = mock(DeviceRepository.class);
  private final MemoryHotWindow window = new MemoryHotWindow();
  private final MemoryExecutionState states = new MemoryExecutionState();
  private final MemoryPresence presence = new MemoryPresence();
  private final List<String> trace = new ArrayList<>();
  private final AtomicReference<SharedProject> project = new AtomicReference<>();
  private final ConcurrentHashMap<String, Conversation> rows = new ConcurrentHashMap<>();
  private DeviceAppService deviceService;
  private ConversationAppService service;

  @BeforeEach
  void setUp() {
    User user = new User(USER, "user01", "用户 01", true, 1);
    when(identity.requireUser(USER)).thenReturn(user);
    doNothing().when(identity).requireMember(any(), any());
    doAnswer(invocation -> { Conversation row = invocation.getArgument(0); rows.put(row.id(), row); return null; }).when(conversations).insert(any());
    doAnswer(invocation -> { Conversation row = invocation.getArgument(0); rows.put(row.id(), row); return null; }).when(conversations).update(any());
    when(conversations.findById(any())).thenAnswer(invocation -> Optional.ofNullable(rows.get(invocation.getArgument(0))));
    when(conversations.lockById(any())).thenAnswer(invocation -> { trace.add("lock"); return Optional.ofNullable(rows.get(invocation.getArgument(0))); });
    Device device = new Device(DEVICE, WORKSPACE, USER, DEVICE, DEVICE, "冒烟设备", "hash", DEVICE, "hash", false, 1, 1);
    when(devices.findById(DEVICE)).thenReturn(Optional.of(device));
    project.set(new SharedProject(WORKSPACE, DEVICE, PROJECT, "冒烟项目", true, 1, "[{\"agentConfigId\":\"" + AGENT + "\",\"name\":\"受控执行配置\",\"available\":true}]", 1));
    when(devices.findProject(WORKSPACE, PROJECT)).thenAnswer(invocation -> Optional.of(project.get()));
    Contracts contracts = new Contracts();
    RealtimeBroadcastPort bus = new RealtimeBroadcastPort() {
      @Override public void publishConversationEvent(String conversationId, String eventJson) { trace.add("event"); }
      @Override public void publishDaemonCommand(String deviceId, String commandJson) { trace.add("daemon:" + deviceId); }
      @Override public void publishSearchIndex(String workspaceId, String documentJson) { trace.add("search"); }
    };
    MessageStorePort messages = new MessageStorePort() {
      @Override public void save(Message message) { trace.add("message"); window.save(message); }
      @Override public Optional<Message> find(String workspaceId, String messageId) { return window.find(workspaceId, messageId); }
      @Override public List<Message> recent(String conversationId, int limit) { return window.recent(conversationId, limit); }
    };
    var idempotency = new MemoryIdempotency();
    deviceService = new DeviceAppService(devices, identity, idempotency, presence, states, contracts);
    service = new ConversationAppService(identity, conversations, devices, idempotency, messages, window, states,
      new ContractEventEncoder(contracts), bus, new ConversationEventHub(),
      new ExecutionAppService(mock(workbench.collaboration.domain.device.DaemonCommandPort.class)),
      contracts, null);
  }

  @Test
  void sendInputReplaysTheSameBodyAndRejectsADifferentTarget() throws Exception {
    String firstId = conversationId(service.create(USER, WORKSPACE, createBody("66666666-6666-4666-8666-666666666666")));
    String request = "77777777-7777-4777-8777-777777777777";
    String body = input(request, "共享历史");
    ExecutorService pool = Executors.newFixedThreadPool(2);
    CountDownLatch start = new CountDownLatch(1);
    try {
      Future<String> left = pool.submit(() -> { start.await(); return service.sendInput(USER, WORKSPACE, firstId, body); });
      Future<String> right = pool.submit(() -> { start.await(); return service.sendInput(USER, WORKSPACE, firstId, body); });
      start.countDown();
      assertThat(left.get()).isEqualTo(right.get());
    } finally {
      start.countDown();
      pool.shutdownNow();
    }
    assertThat(window.messageCount(firstId)).isEqualTo(1);
    JsonNode saved = JSON.readTree(service.sendInput(USER, WORKSPACE, firstId, body));
    assertThat(saved.path("inputSequence").asString()).isEqualTo("2");
    assertThat(saved.path("committedSequence").asString()).isEqualTo("3");
    assertThat(states.find(saved.path("executionId").asString()).orElseThrow().commandFingerprint()).hasSize(64);
    assertThat(trace).containsSubsequence("lock", "message", "event", "daemon:" + DEVICE);
    assertThatThrownBy(() -> service.sendInput(USER, WORKSPACE, firstId, input(request, "冲突正文")))
      .isInstanceOf(ApiProblem.class).extracting("status", "code").containsExactly(409, "REQUEST_ID_CONFLICT");
    String other = conversationId(service.create(USER, WORKSPACE, createBody("88888888-8888-4888-8888-888888888888")));
    assertThatThrownBy(() -> service.sendInput(USER, WORKSPACE, other, body))
      .isInstanceOf(ApiProblem.class).extracting("code").isEqualTo("REQUEST_ID_CONFLICT");

    JsonNode history = JSON.readTree(service.history(USER, WORKSPACE, firstId, null, null, 50));
    List<JsonNode> authored = new ArrayList<>();
    history.path("events").forEach(event -> { if ("message.created".equals(event.path("type").asString())) authored.add(event); });
    assertThat(authored).hasSize(1);
    assertThat(authored.getFirst().path("payload").path("message").path("author").path("username").asString()).isEqualTo("user01");
    assertThat(JSON.readTree(service.execution(USER, WORKSPACE, firstId, saved.path("executionId").asString())).path("execution").path("state").asString()).isEqualTo("queued");

    String cancelled = service.cancel(USER, WORKSPACE, firstId, saved.path("executionId").asString(), "{\"requestId\":\"99999999-9999-4999-8999-999999999999\"}");
    assertThat(JSON.readTree(cancelled).path("cancelState").asString()).isEqualTo("resolved");
    assertThat(JSON.readTree(service.execution(USER, WORKSPACE, firstId, saved.path("executionId").asString())).path("execution").path("state").asString()).isEqualTo("cancelled");
    int events = window.eventCount(firstId);
    service.cancel(USER, WORKSPACE, firstId, saved.path("executionId").asString(), "{\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\"}");
    assertThat(window.eventCount(firstId)).isEqualTo(events);

    project.set(new SharedProject(WORKSPACE, DEVICE, PROJECT, "冒烟项目", false, 2, project.get().agentConfigsJson(), 2));
    assertThatThrownBy(() -> service.sendInput(USER, WORKSPACE, firstId, input("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "撤回后拒绝")))
      .isInstanceOf(ApiProblem.class).extracting("code").isEqualTo("PROJECT_NOT_SHARED");
  }

  @Test
  void runningExecutionCannotBeCancelledAsQueued() {
    String conversationId = conversationId(service.create(USER, WORKSPACE, createBody("cccccccc-cccc-4ccc-8ccc-cccccccccccc")));
    String saved = service.sendInput(USER, WORKSPACE, conversationId, input("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "进行中"));
    String executionId = JSON.readTree(saved).path("executionId").asString();
    ExecutionState current = states.find(executionId).orElseThrow();
    states.save(new ExecutionState(current.executionId(), current.conversationId(), current.inputId(), current.inputSequence(), current.initiatedByUserId(), "running", "running", "none", null, current.createdAtMs(), current.updatedAtMs(), current.commandFingerprint()));
    assertThatThrownBy(() -> service.cancel(USER, WORKSPACE, conversationId, executionId, "{\"requestId\":\"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee\"}"))
      .isInstanceOf(ApiProblem.class).extracting("code").isEqualTo("EXECUTION_STATE_CONFLICT");
  }

  @Test
  void daemonPushPersistsAgentMessageAndCompletesExecution() {
    String conversationId = conversationId(service.create(USER, WORKSPACE, createBody("ffffffff-ffff-4fff-8fff-ffffffffffff")));
    String saved = service.sendInput(USER, WORKSPACE, conversationId, input("12121212-1212-4212-8212-121212121212", "请分析项目"));
    String executionId = JSON.readTree(saved).path("executionId").asString();
    String connectionId = "34343434-3434-4434-8434-343434343434";
    presence.save(new workbench.collaboration.domain.device.DaemonPresence(DEVICE, "local", connectionId, "ready", System.currentTimeMillis()));

    String agentMsgId = "56565656-5656-4656-8656-565656565656";
    service.recordDaemonPush(deviceService, DEVICE, connectionId, conversationId, executionId, 1L, "fp-1",
      null, null, "accepted", null, null);
    service.recordDaemonPush(deviceService, DEVICE, connectionId, conversationId, executionId, 2L, "fp-2",
      null, null, "running", null, "native-session-1");
    service.recordDaemonPush(deviceService, DEVICE, connectionId, conversationId, executionId, 3L, "fp-3",
      agentMsgId, "Agent 分析结论", "succeeded", null, "native-session-1");
    // 相同 runnerSequence 与指纹重放幂等跳过
    service.recordDaemonPush(deviceService, DEVICE, connectionId, conversationId, executionId, 3L, "fp-3",
      agentMsgId, "Agent 分析结论", "succeeded", null, "native-session-1");

    assertThat(window.messageCount(conversationId)).isEqualTo(2);
    assertThat(window.find(WORKSPACE, agentMsgId)).isPresent()
      .get().extracting(Message::authorKind, Message::text).containsExactly("agent", "Agent 分析结论");
    assertThat(states.find(executionId)).isPresent()
      .get().extracting(ExecutionState::state).isEqualTo("succeeded");
    assertThat(rows.get(conversationId).activeExecutionId()).isNull();
    assertThat(rows.get(conversationId).nativeSessionId()).isEqualTo("native-session-1");

    assertThatThrownBy(() -> service.recordDaemonPush(deviceService, DEVICE, connectionId, conversationId, executionId, 3L, "fp-conflict",
      agentMsgId, "篡改结论", "succeeded", null, "native-session-1"))
      .isInstanceOf(ApiProblem.class).extracting("status", "code").containsExactly(409, "EXECUTION_STATE_CONFLICT");
  }

  private static String conversationId(String json) { return JSON.readTree(json).path("conversation").path("conversationId").asString(); }

  private static String createBody(String requestId) {
    return "{\"requestId\":\"" + requestId + "\",\"title\":\"冒烟会话\",\"deviceId\":\"" + DEVICE + "\",\"projectId\":\"" + PROJECT + "\",\"agentConfigId\":\"" + AGENT + "\"}";
  }

  private static String input(String requestId, String text) {
    return "{\"requestId\":\"" + requestId + "\",\"text\":\"" + text + "\"}";
  }
}
