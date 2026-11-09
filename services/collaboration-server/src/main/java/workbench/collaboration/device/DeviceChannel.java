package workbench.collaboration.device;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.Contracts;
import workbench.collaboration.conversation.ConversationDtos.*;
import workbench.collaboration.conversation.ConversationService;
import workbench.collaboration.conversation.ConversationStore;
import workbench.collaboration.device.DeviceDtos.*;
import workbench.collaboration.execution.*;
import workbench.collaboration.execution.ExecutionDtos.*;
import workbench.collaboration.infrastructure.TimeCodec;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import jakarta.annotation.PostConstruct;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import jakarta.annotation.PreDestroy;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 设备通道：握手 Bearer 认证 → 单连接替换 → welcome → resume/ready → 命令下发与来源回执。
 * 旧 socket 的帧/close 不能影响新连接；数据库事务永远不在 socket 回调里跨网络持锁。
 */
public final class DeviceChannel extends AbstractWebSocketHandler implements DeviceDelivery, SubProtocolCapable {
  private record Connection(String connectionId, AuthenticatedDevice device, WebSocketSession session,
                             ConcurrentWebSocketSessionDecorator decorator, String resumeId, Recovery progress) {}

  private static final class Recovery {
    String requestId;
    String after;
    boolean inventoryDone;
    boolean candidatesDone;
    String candidateAfter;
    String lookupRequestId;
    RecoveryCandidate lookup;
    boolean projectsRequested;
    boolean ready;
    long lastProgress = System.currentTimeMillis();
    long lastPong = lastProgress;
    final Map<String, Long> pendingSources = new HashMap<>();
    final Set<String> inventoryCommands = new HashSet<>();
    final Deque<RecoveryCandidate> candidates = new ArrayDeque<>();
    final Set<String> pendingCommands = new HashSet<>();
    final Set<String> pendingProjects = new HashSet<>();
  }

  private final Contracts contracts;
  private final DeviceService devices;
  private final DevicePresence presence;
  private final ConversationStore store;
  private final ExecutionReceiptsService receipts;
  private final ExecutionRecoveryService recovery;
  private final ExecutionCodec codec;
  private final JsonMapper mapper = JsonMapper.builder().build();
  private final Map<String, Connection> byDevice = new ConcurrentHashMap<>();
  private final java.util.concurrent.ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(task -> {
    Thread thread = new Thread(task, "workbench-device-heartbeat");
    thread.setDaemon(true);
    return thread;
  });

  public DeviceChannel(Contracts contracts, DeviceService devices, DevicePresence presence,
                       ConversationStore store, ConversationService conversations, ExecutionReceiptsService receipts,
                       ExecutionRecoveryService recovery, ExecutionCodec codec) {
    this.contracts = contracts; this.devices = devices; this.presence = presence; this.store = store;
    this.receipts = receipts; this.recovery = recovery; this.codec = codec;
  }

  @Override public List<String> getSubProtocols() { return List.of("workbench.device.v1"); }

  @PostConstruct void startHeartbeat() { heartbeat.scheduleAtFixedRate(this::heartbeat, 15, 15, TimeUnit.SECONDS); }

  @PreDestroy void stopHeartbeat() { heartbeat.shutdownNow(); }

  @Override
  public void afterConnectionEstablished(WebSocketSession session) throws Exception {
    Object value = session.getAttributes().get("workbench.device");
    if (!(value instanceof AuthenticatedDevice device)) { session.close(CloseStatus.POLICY_VIOLATION); return; }
    if (!"workbench.device.v1".equals(session.getAcceptedProtocol())) { session.close(CloseStatus.PROTOCOL_ERROR); return; }
    session.setTextMessageSizeLimit(256 * 1024);
    String connectionId = UUID.randomUUID().toString();
    session.getAttributes().put("workbench.connectionId", connectionId);
    Connection connection = new Connection(connectionId, device, session,
      new ConcurrentWebSocketSessionDecorator(session, 5000, 512 * 1024), UUID.randomUUID().toString(), new Recovery());
    Connection old = attach(connection);
    if (old != null && !old.connectionId().equals(connectionId)) {
      try { old.session().close(new CloseStatus(4001, "replaced")); } catch (Exception ignored) {}
    }
    send(connection, new DeviceWelcomeMessage(1, UUID.randomUUID().toString(), "device.welcome", now(),
      new DeviceWelcomePayload(device.deviceId(), device.workspaceId(), device.ownerUserId(), device.ledgerId(),
        connection.resumeId(), 15000, 45000)));
    requestInventory(connection, null);
  }

  /** 先等旧连接正在提交的帧结束，再换身份；旧回调无法以新连接资格落库。 */
  private Connection attach(Connection connection) {
    String deviceId = connection.device().deviceId();
    while (true) {
      Connection old;
      synchronized (byDevice) {
        old = byDevice.get(deviceId);
        if (old == null) {
          byDevice.put(deviceId, connection);
          presence.connected(deviceId, connection.connectionId());
          return null;
        }
      }
      synchronized (old.progress()) {
        synchronized (byDevice) {
          if (!byDevice.replace(deviceId, old, connection)) continue;
          presence.connected(deviceId, connection.connectionId());
          return old;
        }
      }
    }
  }

  @Override
  public void handleTextMessage(WebSocketSession session, TextMessage message) {
    Connection connection = connection(session);
    if (connection == null) return;
    synchronized (connection.progress()) {
      if (connection(session) != connection) return;
      try {
        if (!devices.activeDevice(connection.device().deviceId())) { close(connection, CloseStatus.POLICY_VIOLATION); return; }
        if (message.getPayloadLength() > 256 * 1024) { close(connection, CloseStatus.TOO_BIG_TO_PROCESS); return; }
        JsonNode root = mapper.readTree(message.getPayload());
        if (!connection.connectionId().equals(root.path("connectionId").asText())) { close(connection, CloseStatus.POLICY_VIOLATION); return; }
        if (root.has("messages")) {
          if (!contracts.valid("DeviceBatchEnvelope", message.getPayload())) throw new IllegalArgumentException("来源批次无效");
          receipt(connection, root.get("messages"));
        } else {
          if (!contracts.valid("DeviceEnvelope", message.getPayload())) throw new IllegalArgumentException("控制帧无效");
          JsonNode node = root.get("message");
          switch (node.path("type").asText()) {
            case "device.resume" -> resume(connection, node);
            case "device.command.status" -> commandStatus(connection, node.get("payload"));
            case "device.project.saved" -> projectSaved(connection, node);
            case "device.problem" -> { close(connection, CloseStatus.POLICY_VIOLATION); return; }
            default -> throw new IllegalArgumentException("设备无权请求云端原命令或自行 ready");
          }
        }
        connection.progress().lastProgress = System.currentTimeMillis();
        presence.touch(connection.device().deviceId(), connection.connectionId());
        advance(connection);
      } catch (ExecutionFailure failure) {
        executionProblem(connection, failure);
        if (!failure.kind.equals("gap")) close(connection, CloseStatus.POLICY_VIOLATION);
      } catch (RuntimeException failure) {
        problem(connection, connection.resumeId(), null, "INVALID_CONTROL_FRAME", "控制帧不符合契约");
        close(connection, CloseStatus.POLICY_VIOLATION);
      }
    }
  }

  private void receipt(Connection connection, JsonNode nodes) {
    List<Object> events = new ArrayList<>();
    String executionId = null;
    for (JsonNode node : nodes) {
      if (node.toString().getBytes(StandardCharsets.UTF_8).length > 64 * 1024) throw new IllegalArgumentException("来源消息过大");
      Object event = decode(node.path("type").asText(), node.toString());
      String id = codec.executionId(event);
      if (executionId != null && !executionId.equals(id)) throw new IllegalArgumentException("批次跨执行");
      executionId = id;
      events.add(event);
    }
    RecordBatchResult result = receipts.recordBatch(connection.device().deviceId(), connection.connectionId(), executionId, events);
    sendAcknowledgement(connection, result.ack(), result.startDecision());
    Long high = connection.progress().pendingSources.get(executionId);
    if (high != null && Long.parseLong(result.ack().lastCommittedRunnerSequence()) >= high) connection.progress().pendingSources.remove(executionId);
    for (Object event : events) {
      if (event instanceof ExecutionAcceptedMessage accepted) {
        connection.progress().pendingCommands.remove(accepted.payload().startCommandId());
      } else if (event instanceof ExecutionCancelReceivedMessage cancelled) {
        connection.progress().pendingCommands.remove(cancelled.payload().cancelCommandId());
      }
    }
  }

  private void sendAcknowledgement(Connection connection, ExecutionAck ack, ExecutionStartDecisionMessage decision) {
    if (decision != null) send(connection, decision);
    send(connection, new ExecutionEventsAckMessage(1, UUID.randomUUID().toString(), "execution.events.ack", now(),
      new ExecutionEventsAckPayload(ack.executionId(), ack.lastCommittedRunnerSequence())));
  }

  private void requestInventory(Connection connection, String after) {
    Recovery progress = connection.progress();
    progress.after = after;
    progress.requestId = UUID.randomUUID().toString();
    send(connection, new DeviceResumeRequestMessage(1, progress.requestId, "device.resume.request", now(),
      new DeviceResumeInventoryPayload(connection.resumeId(), "inventory", after)));
  }

  /** Runner 只报告自己账本的事实，云端永不由命令 ID 重建并返回输入正文。 */
  private void resume(Connection connection, JsonNode node) {
    Recovery progress = connection.progress();
    JsonNode payload = node.get("payload");
    if (progress.inventoryDone || !connection.resumeId().equals(payload.path("resumeId").asText())
      || !connection.device().ledgerId().equals(payload.path("ledgerId").asText())
      || !Objects.equals(progress.requestId, payload.path("requestMessageId").asText())
      || !Objects.equals(progress.after, nullable(payload.get("afterStartCommandId")))) throw new IllegalArgumentException("恢复页不匹配");
    String cursor = progress.after;
    for (JsonNode record : payload.get("records")) {
      String command = startId(record);
      if (cursor != null && command.compareTo(cursor) <= 0) throw new IllegalArgumentException("恢复顺序无效");
      reconcileRecord(connection, record, null);
      progress.inventoryCommands.add(command);
      cursor = command;
    }
    String next = nullable(payload.get("nextAfterStartCommandId"));
    if (next != null) {
      if (!next.equals(cursor) || Objects.equals(next, progress.after)) throw new IllegalArgumentException("恢复游标未推进");
      requestInventory(connection, next);
    } else progress.inventoryDone = true;
  }

  private static String startId(JsonNode record) {
    return "cancelBeforeStart".equals(record.path("kind").asText())
      ? record.path("cancel").path("payload").path("startCommandId").asText()
      : record.path("start").path("messageId").asText();
  }

  /** 每个 lookup 仅使用此连接的认证归属，并保留一个等待响应的请求。 */
  private void nextLookup(Connection connection) {
    Recovery progress = connection.progress();
    if (progress.lookup != null) return;
    while (progress.candidates.isEmpty() && !progress.candidatesDone) {
      AuthenticatedDevice device = connection.device();
      List<RecoveryCandidate> page = recovery.listCandidates(device.workspaceId(), device.deviceId(),
        device.ledgerId(), progress.candidateAfter, 100);
      if (!page.isEmpty()) progress.candidateAfter = page.getLast().startCommandId();
      progress.candidatesDone = page.size() < 100;
      for (RecoveryCandidate candidate : page) {
        if (!progress.inventoryCommands.contains(candidate.startCommandId())) progress.candidates.add(candidate);
      }
    }
    progress.lookup = progress.candidates.poll();
    if (progress.lookup == null) return;
    progress.lookupRequestId = UUID.randomUUID().toString();
    send(connection, new DeviceResumeRequestMessage(1, progress.lookupRequestId, "device.resume.request", now(),
      new DeviceResumeLookupPayload(connection.resumeId(), "lookup", progress.lookup.startCommandId())));
  }

  private void commandStatus(Connection connection, JsonNode payload) {
    Recovery progress = connection.progress();
    RecoveryCandidate candidate = progress.lookup;
    if (candidate == null || !connection.resumeId().equals(payload.path("resumeId").asText())
      || !connection.device().ledgerId().equals(payload.path("ledgerId").asText())
      || !progress.lookupRequestId.equals(payload.path("requestMessageId").asText())
      || !candidate.startCommandId().equals(payload.path("startCommandId").asText())) {
      throw new IllegalArgumentException("未发出匹配的恢复查询");
    }
    if ("found".equals(payload.path("result").asText())) {
      reconcileRecord(connection, payload.get("record"), candidate);
    } else {
      ReconcileResult result = recovery.reconcile(connection.device().deviceId(), connection.connectionId(),
        connection.device().ledgerId(), candidate.executionId(), candidate.startCommandId(),
        candidate.startBodySha256(), "notFound", null, null);
      sendReconciledCommand(connection, result);
    }
    progress.lookup = null;
    progress.lookupRequestId = null;
  }

  private void reconcileRecord(Connection connection, JsonNode record, RecoveryCandidate candidate) {
    boolean early = "cancelBeforeStart".equals(record.path("kind").asText());
    JsonNode command = record.get(early ? "cancel" : "start");
    Object decoded = early ? contracts.decode("ExecutionCancelMessage", command.toString(), ExecutionCancelMessage.class)
      : contracts.decode("ExecutionStartMessage", command.toString(), ExecutionStartMessage.class);
    if (!codec.verify(decoded)) throw new IllegalArgumentException("恢复原命令指纹不一致");
    JsonNode target = command.get("payload");
    String executionId = target.path("executionId").asText();
    if (!connection.device().deviceId().equals(target.path("deviceId").asText())
      || !connection.device().workspaceId().equals(target.path("workspaceId").asText())) throw new ExecutionFailure("targetMismatch", executionId);
    String startId = startId(record);
    String hash = target.path(early ? "startBodySha256" : "bodySha256").asText();
    if (candidate != null && (!candidate.startCommandId().equals(startId) || !candidate.executionId().equals(executionId)
      || !candidate.startBodySha256().equals(hash))) throw new ExecutionFailure("conflict", candidate.executionId());
    long high = Long.parseLong(record.path("lastRunnerSequence").asText());
    long localAck = Long.parseLong(record.path("lastCommittedRunnerSequence").asText());
    if (localAck > high) throw new ExecutionFailure("conflict", executionId);
    String decisionId = early || record.get("decision").isNull() ? null : record.get("decision").path("messageId").asText();
    ReconcileResult result = recovery.reconcile(connection.device().deviceId(), connection.connectionId(), connection.device().ledgerId(),
      executionId, startId, hash, early ? "terminalPending" : record.path("localState").asText(), decisionId,
      early ? null : nullable(record.get("nativeSessionId")));
    long committed = Long.parseLong(result.ack().lastCommittedRunnerSequence());
    if (localAck > committed || committed > high) throw new ExecutionFailure("conflict", executionId);
    if (committed < high) connection.progress().pendingSources.put(executionId, high);
    sendAcknowledgement(connection, result.ack(), result.startDecision());
    sendReconciledCommand(connection, result);
  }

  /** 原命令已在 HC-195 事务内保存，设备通道只套当前连接外壳。 */
  private void sendReconciledCommand(Connection connection, ReconcileResult result) {
    String original = switch (result.action()) {
      case "resendSame" -> Objects.requireNonNull(result.startJson());
      case "waitForEvidence" -> result.cancelJson();
      default -> null;
    };
    if (original == null) return;
    JsonNode command = mapper.readTree(original);
    if ("execution.cancel".equals(command.path("type").asText())
      && "0".equals(result.ack().lastCommittedRunnerSequence())) {
      connection.progress().pendingSources.merge(result.ack().executionId(), 2L, Math::max);
    }
    connection.progress().pendingCommands.add(command.path("messageId").asText());
    send(connection, command);
  }

  private void projectSaved(Connection connection, JsonNode node) {
    JsonNode payload = node.get("payload");
    if (connection.progress().ready && payload.get("resumeId").isNull()) return;
    if (!connection.resumeId().equals(payload.path("resumeId").asText())
      || !connection.progress().pendingProjects.remove(payload.path("requestMessageId").asText() + ":" + payload.path("projectId").asText() + ":" + payload.path("shareVersion").asText())) {
      throw new IllegalArgumentException("项目确认不匹配");
    }
  }

  private void advance(Connection connection) {
    Recovery progress = connection.progress();
    if (!progress.inventoryDone || progress.ready) return;
    nextLookup(connection);
    if (progress.lookup != null || !progress.pendingSources.isEmpty() || !progress.pendingCommands.isEmpty()) return;
    progress.inventoryCommands.clear();
    if (!progress.projectsRequested) {
      progress.projectsRequested = true;
      for (DeviceProjectChangedPayload project : devices.projectVersions(connection.device().deviceId(), connection.resumeId())) {
        String id = UUID.randomUUID().toString();
        progress.pendingProjects.add(id + ":" + project.projectId() + ":" + project.shareVersion());
        send(connection, new DeviceProjectChangedMessage(1, id, "device.project.changed", now(), project));
      }
    }
    if (!progress.pendingProjects.isEmpty()) return;
    if (send(connection, new DeviceReadyMessage(1, UUID.randomUUID().toString(), "device.ready", now(),
      new DeviceReadyPayload(connection.resumeId(), connection.device().ledgerId())))) {
      progress.ready = true;
      presence.ready(connection.device().deviceId(), connection.connectionId());
    }
  }

  private static String nullable(JsonNode node) { return node == null || node.isNull() ? null : node.asText(); }

  @Override protected void handlePongMessage(WebSocketSession session, PongMessage message) {
    Connection connection = connection(session);
    if (connection != null) synchronized (connection.progress()) { connection.progress().lastPong = System.currentTimeMillis(); }
  }

  private void heartbeat() {
    for (Connection connection : byDevice.values()) synchronized (connection.progress()) {
      long now = System.currentTimeMillis();
      try {
        if (now - connection.progress().lastPong >= 45_000 || (!connection.progress().ready && now - connection.progress().lastProgress >= 30_000)
          || !devices.activeDevice(connection.device().deviceId())) close(connection, CloseStatus.GOING_AWAY);
        else connection.decorator().sendMessage(new PingMessage(ByteBuffer.allocate(0)));
      } catch (Exception failure) { close(connection, CloseStatus.SERVER_ERROR); }
    }
  }

  private void close(Connection connection, CloseStatus status) {
    synchronized (connection.progress()) {
      byDevice.remove(connection.device().deviceId(), connection);
      presence.disconnected(connection.device().deviceId(), connection.connectionId());
    }
    try { connection.session().close(status); } catch (Exception ignored) { /* 当前连接资格已撤销 */ }
  }

  private Object decode(String type, String json) {
    return switch (type) {
      case "execution.accepted" -> contracts.decode("ExecutionAcceptedMessage", json, ExecutionAcceptedMessage.class);
      case "execution.native.bound" -> contracts.decode("ExecutionNativeBoundMessage", json, ExecutionNativeBoundMessage.class);
      case "execution.running" -> contracts.decode("ExecutionRunningMessage", json, ExecutionRunningMessage.class);
      case "execution.output" -> contracts.decode("ExecutionOutputMessage", json, ExecutionOutputMessage.class);
      case "execution.terminal" -> contracts.decode("ExecutionTerminalMessage", json, ExecutionTerminalMessage.class);
      case "execution.cancel.received" -> contracts.decode("ExecutionCancelReceivedMessage", json, ExecutionCancelReceivedMessage.class);
      case "execution.events.ack" -> contracts.decode("ExecutionEventsAckMessage", json, ExecutionEventsAckMessage.class);
      default -> throw new IllegalArgumentException("未知执行消息");
    };
  }

  @Override
  public void handleTransportError(WebSocketSession session, Throwable exception) {
    Connection connection = connection(session);
    if (connection != null) close(connection, CloseStatus.SERVER_ERROR);
  }

  @Override
  public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
    Connection connection = connection(session);
    if (connection == null) return;
    synchronized (connection.progress()) {
      byDevice.remove(connection.device().deviceId(), connection);
      presence.disconnected(connection.device().deviceId(), connection.connectionId());
    }
  }

  private Connection connection(WebSocketSession session) {
    if (!(session.getAttributes().get("workbench.device") instanceof AuthenticatedDevice device)) return null;
    Connection connection = byDevice.get(device.deviceId());
    return connection != null && connection.session() == session ? connection : null;
  }

  private boolean send(Connection connection, Object message) {
    try {
      if (byDevice.get(connection.device().deviceId()) != connection) return false;
      Map<String, Object> envelope = new LinkedHashMap<>();
      envelope.put("connectionId", connection.connectionId());
      envelope.put("message", message);
      connection.decorator().sendMessage(new TextMessage(contracts.encode("DeviceEnvelope", envelope)));
      return true;
    } catch (Exception failure) {
      close(connection, CloseStatus.SERVER_ERROR);
      return false;
    }
  }

  private void executionProblem(Connection connection, ExecutionFailure failure) {
    Map<String, Object> problem = new LinkedHashMap<>();
    problem.put("kind", failure.kind);
    problem.put("executionId", failure.executionId);
    if (failure.kind.equals("gap")) {
      problem.put("expectedRunnerSequence", String.valueOf(failure.expectedRunnerSequence));
      problem.put("lastCommittedRunnerSequence", String.valueOf(failure.lastCommittedRunnerSequence));
    }
    send(connection, new DeviceExecutionProblemMessage(1, UUID.randomUUID().toString(), "device.execution.problem", now(), problem));
  }

  private void problem(Connection connection, String resumeId, String requestMessageId, String code, String message) {
    send(connection, new DeviceProblemMessage(1, UUID.randomUUID().toString(), "device.problem", now(),
      new DeviceProblemPayload(resumeId, requestMessageId, code, message)));
  }

  @Override
  public boolean deliverStart(ExecutionRow execution, ExecutionStartMessage start) {
    return deliver(execution, start);
  }

  @Override
  public boolean deliverCancel(ExecutionRow execution, ExecutionCancelMessage cancel) {
    return deliver(execution, cancel);
  }

  private boolean deliver(ExecutionRow execution, Object original) {
    Connection connection = byDevice.get(store.conversation(execution.conversationId()).deviceId());
    if (connection == null) return false;
    synchronized (connection.progress()) {
      return connection.progress().ready && byDevice.get(connection.device().deviceId()) == connection
        && devices.activeDevice(connection.device().deviceId()) && send(connection, original);
    }
  }

  @Override
  public boolean isReady(String deviceId) { return presence.isReady(deviceId) && byDevice.containsKey(deviceId); }

  /** 项目写入提交后重新核对共享版本，避免在旧版本待确认时派发下一项。 */
  public void projectChanged(String deviceId) {
    Connection connection = byDevice.get(deviceId);
    if (connection != null) close(connection, CloseStatus.SERVICE_RESTARTED);
  }

  public void deviceRevoked(String deviceId) {
    Connection connection = byDevice.get(deviceId);
    if (connection != null) close(connection, CloseStatus.POLICY_VIOLATION);
  }

  private String now() { return TimeCodec.utc(System.currentTimeMillis()); }
}
