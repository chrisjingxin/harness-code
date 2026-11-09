package workbench.collaboration.conversation;

import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.Contracts;
import workbench.collaboration.PlatformDtos.UserSummary;
import workbench.collaboration.conversation.ConversationDtos.*;
import workbench.collaboration.device.DeviceDtos.SharedProject;
import workbench.collaboration.device.DeviceService;
import workbench.collaboration.identity.WorkspaceAccess;
import workbench.collaboration.infrastructure.TimeCodec;
import workbench.collaboration.execution.ExecutionCodec;
import workbench.collaboration.execution.ExecutionDtos.ExecutionCancelMessage;
import workbench.collaboration.execution.ExecutionDtos.ExecutionCancelPayload;
import workbench.collaboration.transport.ApiProblem;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.Supplier;

/**
 * 共享会话主事务：成员授权 → 共享目标 → 锁定会话 → 分配连续序号 →
 * 保存消息/执行/事件/回执/待派发一次提交。网络发送永远在事务提交之后。
 */
public final class ConversationService {
  public record Outcome<T>(boolean created, T response) {}

  private final WorkspaceAccess access;
  private final DeviceService devices;
  private final ConversationStore store;
  private final Contracts contracts;
  private final TransactionTemplate transaction;
  private final ExecutionCodec executionCodec = new ExecutionCodec();
  private final JsonMapper mapper = JsonMapper.builder().build();

  public ConversationService(DataSource source, Contracts contracts, WorkspaceAccess access, DeviceService devices, ConversationStore store) {
    this.access = access; this.devices = devices; this.store = store; this.contracts = contracts;
    this.transaction = new TransactionTemplate(new JdbcTransactionManager(source));
  }

  public ConversationListResponse list(String userId, String workspaceId, String limit, String beforeCreatedAt, String beforeId) {
    return transaction.execute(status -> {
      access.requireMember(workspaceId, userId);
      int size = pageSize(limit);
      long before = beforeCreatedAt == null ? Long.MAX_VALUE : TimeCodec.epoch(beforeCreatedAt);
      List<ConversationSummary> rows = store.listConversations(workspaceId, before, beforeId, size + 1);
      List<ConversationSummary> conversations = rows.stream().limit(size).toList();
      ConversationPageCursor next = rows.size() > size
        ? new ConversationPageCursor(conversations.getLast().createdAt(), conversations.getLast().conversationId()) : null;
      return new ConversationListResponse(conversations, next);
    });
  }

  public Outcome<CreateConversationResponse> create(String userId, String workspaceId, CreateConversationRequest request) {
    String body = store.json(request);
    return write(() -> {
      access.requireMember(workspaceId, userId);
      CreateConversationResponse replay = replay(workspaceId, userId, "conversation.create", request.requestId(), body, CreateConversationResponse.class);
      if (replay != null) return new Outcome<>(false, replay);
      devices.requireSharedProject(workspaceId, request.deviceId(), request.projectId(), request.agentConfigId());
      long now = System.currentTimeMillis();
      String conversationId = UUID.randomUUID().toString();
      ConversationRow row = new ConversationRow(conversationId, workspaceId, request.title(), userId, userId, request.deviceId(),
        request.projectId(), request.agentConfigId(), 2, null, now, now);
      store.insertConversation(row);
      ConversationSummary summary = summary(row);
      store.appendEvent(conversationId, 1, "conversation.created", new ConversationPayload(summary), now);
      CreateConversationResponse response = new CreateConversationResponse(summary, "1");
      store.saveReceipt(workspaceId, userId, "conversation.create", request.requestId(), body, contracts.encode("CreateConversationResponse", response));
      return new Outcome<>(true, response);
    });
  }

  public ConversationResponse get(String userId, String workspaceId, String conversationId) {
    return transaction.execute(status -> {
      access.requireMember(workspaceId, userId);
      ConversationRow row = requireConversation(workspaceId, conversationId);
      return new ConversationResponse(summary(row));
    });
  }

  public Outcome<InputSavedResponse> sendInput(String userId, String workspaceId, String conversationId, SendInputRequest request) {
    String body = store.json(List.of(conversationId, request));
    return write(() -> {
      UserSummary user = access.requireMember(workspaceId, userId);
      ConversationRow conversation = requireConversation(workspaceId, conversationId);
      if (!conversation.workspaceId().equals(workspaceId)) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
      InputSavedResponse replay = replay(workspaceId, userId, "input.send", request.requestId(), body, InputSavedResponse.class);
      if (replay != null) return new Outcome<>(false, replay);
      // 停止共享/目标失效拒绝新保存；离线或 Runner 未 ready 不是授权失败。
      SharedProject shared = devices.requireSharedProject(conversation.workspaceId(), conversation.deviceId(), conversation.projectId(), conversation.agentConfigId());
      ConversationRow locked = store.lockConversation(conversationId);
      long sequence = store.allocateSequence(conversationId, 2);
      long now = System.currentTimeMillis();
      String inputId = UUID.randomUUID().toString();
      String executionId = UUID.randomUUID().toString();
      MessageRow message = new MessageRow(inputId, conversationId, executionId, "user", userId, user.username(), user.displayName(),
        null, sequence, now, request.text(), "completed");
      store.insertMessage(message);
      ExecutionRow execution = new ExecutionRow(executionId, conversationId, inputId, sequence, userId, locked.agentConfigId(),
        shared.shareVersion(), "queued", "queued", "none", null, null, null, null, null, null, null, null, 0, 0, now, now);
      store.insertExecution(execution);
      store.appendEvent(conversationId, sequence, "message.created", new MessagePayload(message(message)), now);
      store.appendEvent(conversationId, sequence + 1, "execution.changed", new ExecutionPayload(view(execution)), now);
      InputSavedResponse response = new InputSavedResponse(conversationId, inputId, executionId, Long.toString(sequence),
        Long.toString(sequence + 1), TimeCodec.utc(now));
      store.saveReceipt(workspaceId, userId, "input.send", request.requestId(), body, contracts.encode("InputSavedResponse", response));
      return new Outcome<>(true, response);
    });
  }

  /**
   * 取消：queued 直接落终态并移除待派发；已登记项只持久请求，不改写 Runner 原决定。
   * 终态重复取消返回当前事实，不追加事件。
   */
  public CancelExecutionResponse cancel(String userId, String workspaceId, String conversationId, String executionId, CancelExecutionRequest request) {
    String body = store.json(List.of(conversationId, executionId, request));
    return write(() -> {
      access.requireMember(workspaceId, userId);
      ConversationRow conversation = requireConversation(workspaceId, conversationId);
      if (!conversation.workspaceId().equals(workspaceId)) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
      if (!store.execution(executionId).conversationId().equals(conversationId)) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
      CancelExecutionResponse replay = replay(workspaceId, userId, "execution.cancel", request.requestId(), body, CancelExecutionResponse.class);
      if (replay != null) return replay;
      devices.requireSharedProject(workspaceId, conversation.deviceId(), conversation.projectId(), conversation.agentConfigId());
      store.lockConversation(conversationId);
      ExecutionRow execution = store.lockExecution(executionId);
      long now = System.currentTimeMillis();
      CancelExecutionResponse response;
      if (terminal(execution.state())) {
        response = new CancelExecutionResponse(executionId, execution.cancelState(), execution.state(), committed(conversationId));
      } else if (execution.state().equals("queued")) {
        ExecutionRow cancelled = copy(execution, "cancelled", "cancelled", "resolved", "CANCELLED_BEFORE_DISPATCH", now);
        store.updateExecution(cancelled);
        store.releaseActiveExecution(conversationId, executionId);
        long sequence = store.allocateSequence(conversationId, 1);
        store.appendEvent(conversationId, sequence, "execution.changed", new ExecutionPayload(view(cancelled)), now);
        response = new CancelExecutionResponse(executionId, "resolved", "queued", Long.toString(sequence));
      } else if (!execution.cancelState().equals("none")) {
        response = new CancelExecutionResponse(executionId, execution.cancelState(), execution.state(), committed(conversationId));
      } else {
        // 固定 cancel 命令：同一执行只生成一个 commandId 与正文；重复取消不重造。
        String cancelId = execution.cancelCommandId() != null ? execution.cancelCommandId()
          : UUID.nameUUIDFromBytes(("cancel:" + executionId).getBytes(StandardCharsets.UTF_8)).toString();
        ExecutionRow requested = new ExecutionRow(execution.id(), execution.conversationId(), execution.inputId(), execution.inputSequence(),
          execution.initiatedByUserId(), execution.agentConfigId(), execution.shareVersion(), execution.state(), execution.lastConfirmedState(),
          "requested", execution.reasonCode(), execution.startCommandId(), execution.startBodySha256(), execution.decisionMessageId(),
          execution.decisionJson(), execution.nativeSessionId(), cancelId, userId, execution.runnerSequence(),
          execution.lastCommittedRunnerSequence(), execution.createdAtMs(), now);
        ExecutionCancelMessage cancel = executionCodec.seal(new ExecutionCancelMessage(1, cancelId, "execution.cancel",
          TimeCodec.utc(now), new ExecutionCancelPayload(workspaceId, conversationId, executionId, execution.inputId(),
            conversation.deviceId(), conversation.projectId(), execution.startCommandId(), execution.startBodySha256(), userId, null)),
          ExecutionCancelMessage.class);
        store.updateExecution(requested);
        store.saveCancel(executionId, executionCodec.json(cancel));
        long sequence = store.allocateSequence(conversationId, 1);
        store.appendEvent(conversationId, sequence, "execution.changed", new ExecutionPayload(view(requested)), now);
        response = new CancelExecutionResponse(executionId, "requested", execution.state(), Long.toString(sequence));
      }
      store.saveReceipt(workspaceId, userId, "execution.cancel", request.requestId(), body, contracts.encode("CancelExecutionResponse", response));
      return response;
    });
  }

  public ExecutionResponse execution(String userId, String workspaceId, String conversationId, String executionId) {
    return transaction.execute(status -> {
      access.requireMember(workspaceId, userId);
      ConversationRow conversation = requireConversation(workspaceId, conversationId);
      if (!conversation.workspaceId().equals(workspaceId)) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
      ExecutionRow execution = store.execution(executionId);
      if (!execution.conversationId().equals(conversationId)) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
      return new ExecutionResponse(view(execution));
    });
  }

  public HistoryResponse history(String userId, String workspaceId, String conversationId, String afterSequence, String throughSequence, String limit) {
    return transaction.execute(status -> {
      access.requireMember(workspaceId, userId);
      ConversationRow conversation = requireConversation(workspaceId, conversationId);
      if (!conversation.workspaceId().equals(workspaceId)) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
      long after = afterSequence == null ? 0 : Long.parseLong(afterSequence);
      long high = conversation.nextSequence() - 1;
      long through = throughSequence == null ? high : Long.parseLong(throughSequence);
      if (through > high || (throughSequence == null && after > high)) throw new ApiProblem(409, "CURSOR_AHEAD");
      if (after > through) throw new ApiProblem(400, "INVALID_REQUEST");
      int size = pageSize(limit);
      List<ConversationEvent> events = store.events(conversationId, after, through, size + 1);
      boolean hasMore = events.size() > size;
      List<ConversationEvent> page = hasMore ? events.subList(0, size) : events;
      long next = page.isEmpty() ? after : Long.parseLong(page.getLast().sequence());
      return new HistoryResponse(conversationId, Long.toString(through), page, Long.toString(next), hasMore);
    });
  }

  /** 回执查询只返回首次保存的业务结果，不重新执行原写操作。 */
  public RequestReceiptResponse receipt(String userId, String workspaceId, String requestId, String operation) {
    return transaction.execute(status -> {
      access.requireMember(workspaceId, userId);
      String json = store.receipt(workspaceId, userId, operation, requestId).map(ConversationStore.Receipt::response).orElseThrow(() -> new ApiProblem(404, "RESOURCE_NOT_FOUND"));
      return new RequestReceiptResponse(operation, mapper.readValue(json, Object.class));
    });
  }

  private ConversationRow requireConversation(String workspaceId, String conversationId) {
    ConversationRow row = store.conversation(conversationId);
    if (!row.workspaceId().equals(workspaceId)) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
    return row;
  }

  private <T> T replay(String workspaceId, String userId, String operation, String requestId, String body, Class<T> type) {
    var existing = store.receipt(workspaceId, userId, operation, requestId);
    if (existing.isEmpty()) return null;
    if (!existing.get().body().equals(body)) throw new ApiProblem(409, "REQUEST_ID_CONFLICT");
    return contracts.decode(type.getSimpleName(), existing.get().response(), type);
  }

  /** 并发重试撞唯一键时先退出失败事务，再用新的读视图取得已提交的首次结果。 */
  private <T> T write(Supplier<T> operation) {
    try { return transaction.execute(status -> operation.get()); }
    catch (DuplicateKeyException collision) { return transaction.execute(status -> operation.get()); }
  }

  private String committed(String conversationId) {
    return Long.toString(store.conversation(conversationId).nextSequence() - 1);
  }

  private static boolean terminal(String state) {
    return Set.of("succeeded", "failed", "cancelled", "rejected").contains(state);
  }

  private static ExecutionRow copy(ExecutionRow row, String state, String lastConfirmed, String cancelState, String reason, long now) {
    return new ExecutionRow(row.id(), row.conversationId(), row.inputId(), row.inputSequence(), row.initiatedByUserId(),
      row.agentConfigId(), row.shareVersion(), state, lastConfirmed, cancelState, reason, row.startCommandId(), row.startBodySha256(),
      row.decisionMessageId(), row.decisionJson(), row.nativeSessionId(), row.cancelCommandId(), row.cancelRequestedBy(),
      row.runnerSequence(), row.lastCommittedRunnerSequence(), row.createdAtMs(), now);
  }

  public ConversationSummary summary(ConversationRow row) {
    return new ConversationSummary(row.id(), row.workspaceId(), row.title(), row.createdByUserId(), row.currentUserId(),
      row.deviceId(), row.projectId(), row.agentConfigId(), TimeCodec.utc(row.createdAtMs()));
  }

  public Message message(MessageRow row) {
    Object author = row.authorKind().equals("user")
      ? new UserAuthor("user", row.authorUserId(), row.authorUsername(), row.authorDisplayName())
      : new AgentAuthor("agent", row.agentConfigId());
    return new Message(row.id(), row.conversationId(), row.executionId(), author, Long.toString(row.createdSequence()),
      TimeCodec.utc(row.createdAtMs()), row.text(), row.state());
  }

  public ExecutionView view(ExecutionRow row) {
    return new ExecutionView(row.id(), row.conversationId(), row.inputId(), Long.toString(row.inputSequence()),
      row.initiatedByUserId(), row.state(), row.lastConfirmedState(), row.cancelState(), row.reasonCode(),
      TimeCodec.utc(row.createdAtMs()), TimeCodec.utc(row.updatedAtMs()));
  }

  private int pageSize(String limit) {
    if (limit == null) return 50;
    int value = Integer.parseInt(limit);
    if (value < 1 || value > 100) throw new ApiProblem(400, "INVALID_REQUEST");
    return value;
  }

}
