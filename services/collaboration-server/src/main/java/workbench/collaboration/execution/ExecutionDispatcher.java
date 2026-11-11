package workbench.collaboration.execution;

import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.conversation.ConversationDtos;
import workbench.collaboration.conversation.ConversationDtos.*;
import workbench.collaboration.conversation.ConversationService;
import workbench.collaboration.conversation.ConversationStore;
import workbench.collaboration.execution.ExecutionDtos.*;
import workbench.collaboration.infrastructure.TimeCodec;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/**
 * 唯一调度器：数据库队首 → 登记 dispatching → 提交后发送；15 秒无受理保留未知占位。
 * 设备离线/暂忙不越过队首；written 不等于 accepted；终态才释放会话占位。
 */
public final class ExecutionDispatcher {
  private record Delivery(ExecutionRow execution, Object message, boolean cancel) {}

  private final TransactionTemplate transaction;
  private final ConversationStore store;
  private final ConversationService conversations;
  private final ExecutionStartAuthorization authorization;
  private final DeviceDelivery delivery;
  private final ExecutionCodec codec;
  private final JsonMapper mapper = JsonMapper.builder().build();
  private volatile ScheduledExecutorService scheduler;

  public ExecutionDispatcher(DataSource source, ConversationStore store, ConversationService conversations,
                             DeviceDelivery delivery, ExecutionCodec codec) {
    this.transaction = new TransactionTemplate(new JdbcTransactionManager(source));
    this.authorization = new ExecutionStartAuthorization(source);
    this.store = store; this.conversations = conversations; this.delivery = delivery; this.codec = codec;
  }

  public void start() {
    if (scheduler != null) return;
    scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
      Thread thread = new Thread(runnable, "execution-dispatcher");
      thread.setDaemon(true);
      return thread;
    });
    scheduler.scheduleWithFixedDelay(this::tick, 250, 1000, TimeUnit.MILLISECONDS);
  }

  public void stop() {
    ScheduledExecutorService current = scheduler;
    scheduler = null;
    if (current != null) current.shutdownNow();
  }

  /** 事务只准备并提交事实；真实网络发送在提交后。 */
  public void tick() {
    try {
      List<Delivery> pending = new ArrayList<>();
      for (String executionId : store.claimableHeads(20)) {
        Delivery prepared = transaction.execute(status -> prepare(executionId));
        if (prepared != null) pending.add(prepared);
      }
      for (Delivery item : pending) deliver(item);
      long staleBefore = System.currentTimeMillis() - 15_000;
      for (String executionId : store.staleDispatch(staleBefore, 20)) {
        transaction.executeWithoutResult(status -> markUnknown(executionId, staleBefore));
      }
      for (String executionId : store.pendingCancels(20)) {
        Delivery prepared = transaction.execute(status -> cancel(executionId));
        if (prepared != null) deliver(prepared);
      }
    } catch (RuntimeException ignored) {
      // 单个坏记录不终止调度；下一次 tick 重新从已提交事实核对。
    }
  }

  private Delivery prepare(String executionId) {
    ExecutionRow probe = store.execution(executionId);
    // 队列可能在作者停用后才被唤醒，生成新命令前须按统一顺序锁定现时授权。
    ExecutionStartAuthorization.Result authorizationResult = "queued".equals(probe.state())
      ? authorization.check(store.conversation(probe.conversationId()), probe) : null;
    ConversationRow conversation = store.lockConversation(probe.conversationId());
    ExecutionRow execution = store.lockExecution(executionId);
    if (!execution.state().equals("queued") || conversation.activeExecutionId() != null) return null;
    long now = System.currentTimeMillis();
    if ("requested".equals(execution.cancelState())) {
      ExecutionRow cancelled = copy(execution, "cancelled", "cancelled", "resolved", "CANCELLED_BEFORE_DISPATCH", now);
      store.updateExecution(cancelled);
      store.releaseActiveExecution(conversation.id(), executionId);
      store.appendEvent(conversation.id(), store.allocateSequence(conversation.id(), 1), "execution.changed",
        new ConversationDtos.ExecutionPayload(conversations.view(cancelled)), now);
      return null;
    }
    if (authorizationResult == null) return null;
    if (authorizationResult.denial() != null) {
      ExecutionRow rejected = copy(execution, "rejected", "rejected", execution.cancelState(), authorizationResult.denial(), now);
      store.updateExecution(rejected);
      store.releaseActiveExecution(conversation.id(), executionId);
      store.appendEvent(conversation.id(), store.allocateSequence(conversation.id(), 1), "execution.changed",
        new ConversationDtos.ExecutionPayload(conversations.view(rejected)), now);
      return null;
    }
    if (!authorizationResult.available() || !delivery.isReady(conversation.deviceId())) return null;
    String text = store.message(execution.inputId()).orElseThrow().text();
    String startCommandId = execution.startCommandId() != null ? execution.startCommandId()
      : UUID.nameUUIDFromBytes(("start:" + executionId).getBytes(StandardCharsets.UTF_8)).toString();
    ExecutionStartMessage start = codec.seal(new ExecutionStartMessage(1, startCommandId, "execution.start",
      TimeCodec.utc(execution.createdAtMs()),
      new ExecutionStartPayload(conversation.workspaceId(), conversation.id(), executionId, execution.inputId(),
        conversation.deviceId(), conversation.projectId(), Long.toString(execution.inputSequence()), execution.initiatedByUserId(),
        execution.agentConfigId(), Long.toString(execution.shareVersion()), store.nativeSession(conversation.id()), new ExecutionInput(text), null)),
      ExecutionStartMessage.class);
    String hash = start.payload().bodySha256();
    ExecutionRow dispatched = new ExecutionRow(execution.id(), execution.conversationId(), execution.inputId(), execution.inputSequence(),
      execution.initiatedByUserId(), execution.agentConfigId(), execution.shareVersion(), "dispatching", "dispatching",
      execution.cancelState(), execution.reasonCode(), startCommandId, hash, execution.decisionMessageId(), execution.decisionJson(),
      execution.nativeSessionId(), execution.cancelCommandId(), execution.cancelRequestedBy(), execution.runnerSequence(),
      execution.lastCommittedRunnerSequence(), execution.createdAtMs(), now);
    store.updateExecution(dispatched);
    store.saveStart(executionId, codec.json(start));
    store.setActiveExecution(conversation.id(), executionId);
    store.appendEvent(conversation.id(), store.allocateSequence(conversation.id(), 1), "execution.changed",
      new ConversationDtos.ExecutionPayload(conversations.view(dispatched)), now);
    return new Delivery(dispatched, start, false);
  }

  /** 未收到持久受理事实时只标未知。重送须由原设备账本核对授权。 */
  private void markUnknown(String executionId, long staleBefore) {
    ExecutionRow probe = store.execution(executionId);
    ConversationRow conversation = store.lockConversation(probe.conversationId());
    ExecutionRow execution = store.lockExecution(executionId);
    if (!execution.state().equals("dispatching") || execution.updatedAtMs() >= staleBefore) return;
    long now = System.currentTimeMillis();
    ExecutionRow unknown = copy(execution, "unknown", execution.lastConfirmedState(), execution.cancelState(), "DELIVERY_UNCONFIRMED", now);
    store.updateExecution(unknown);
    store.appendEvent(conversation.id(), store.allocateSequence(conversation.id(), 1), "execution.changed",
      new ConversationDtos.ExecutionPayload(conversations.view(unknown)), now);
  }

  private Delivery cancel(String executionId) {
    ExecutionRow probe = store.execution(executionId);
    ConversationRow conversation = store.lockConversation(probe.conversationId());
    ExecutionRow execution = store.lockExecution(executionId);
    if (!"requested".equals(execution.cancelState()) || execution.startCommandId() == null || execution.cancelCommandId() == null) return null;
    String original = store.cancelJson(executionId);
    if (original == null) return null;
    ExecutionCancelMessage cancel = mapper.readValue(original, ExecutionCancelMessage.class);
    return new Delivery(execution, cancel, true);
  }

  private void deliver(Delivery item) {
    if (item.cancel()) delivery.deliverCancel(item.execution(), (ExecutionCancelMessage) item.message());
    else delivery.deliverStart(item.execution(), (ExecutionStartMessage) item.message());
  }

  private static ExecutionRow copy(ExecutionRow row, String state, String lastConfirmed, String cancelState, String reason, long now) {
    return new ExecutionRow(row.id(), row.conversationId(), row.inputId(), row.inputSequence(), row.initiatedByUserId(),
      row.agentConfigId(), row.shareVersion(), state, lastConfirmed, cancelState, reason, row.startCommandId(), row.startBodySha256(),
      row.decisionMessageId(), row.decisionJson(), row.nativeSessionId(), row.cancelCommandId(), row.cancelRequestedBy(),
      row.runnerSequence(), row.lastCommittedRunnerSequence(), row.createdAtMs(), now);
  }
}
