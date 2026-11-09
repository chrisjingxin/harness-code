package workbench.collaboration.execution;

import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.Contracts;
import workbench.collaboration.conversation.ConversationDtos;
import workbench.collaboration.conversation.ConversationDtos.*;
import workbench.collaboration.conversation.ConversationService;
import workbench.collaboration.conversation.ConversationStore;
import workbench.collaboration.execution.ExecutionDtos.*;
import workbench.collaboration.infrastructure.TimeCodec;
import workbench.collaboration.transport.ApiProblem;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Runner 来源事件的事务边界：完整来源比较 → 连续前缀 → 首次 accepted 与唯一决定同事务。
 * 重复/冲突/缺号都不会提前推进游标或释放队首；已保存的决定不因后来权限变化重算。
 */
public final class ExecutionReceiptsService {
  private final ExecutionStartAuthorization authorization;
  private final TransactionTemplate transaction;
  private final Contracts contracts;
  private final ExecutionCodec codec;
  private final ConversationStore store;
  private final ConversationService conversations;
  private final JsonMapper mapper = JsonMapper.builder().build();

  public ExecutionReceiptsService(DataSource source, Contracts contracts, ExecutionCodec codec, ConversationStore store, ConversationService conversations) {
    this.authorization = new ExecutionStartAuthorization(source);
    transaction = new TransactionTemplate(new JdbcTransactionManager(source));
    this.contracts = contracts; this.codec = codec; this.store = store; this.conversations = conversations;
  }

  public RecordBatchResult recordBatch(String deviceId, String connectionId, String executionId, List<Object> messages) {
    try {
      return transaction.execute(status -> {
        ExecutionRow probe = store.execution(executionId);
        String authorizationFailure = messages.stream().anyMatch(ExecutionAcceptedMessage.class::isInstance) && probe.decisionJson() == null
          ? authorization.check(store.conversation(probe.conversationId()), probe).denial() : null;
        ConversationRow conversation = store.lockConversation(probe.conversationId());
        ExecutionRow execution = store.lockExecution(executionId);
        if (!conversation.deviceId().equals(deviceId)) throw new ExecutionFailure("targetMismatch", executionId);
        if (messages.isEmpty() || messages.size() > 64) throw new ExecutionFailure("invalidTransition", executionId);
        long previous = 0;
        long bytes = 0;
        long expected = execution.lastCommittedRunnerSequence() + 1;
        ExecutionStartDecisionMessage decision = readDecision(execution);
        for (Object message : messages) {
          if (!codec.verify(message)) throw new ExecutionFailure("conflict", executionId);
          if (!executionId.equals(codec.executionId(message))) throw new ExecutionFailure("targetMismatch", executionId);
          if (!Set.of("ExecutionAcceptedMessage", "ExecutionNativeBoundMessage", "ExecutionRunningMessage", "ExecutionOutputMessage",
            "ExecutionTerminalMessage", "ExecutionCancelReceivedMessage").contains(codec.schemaName(message)))
            throw new ExecutionFailure("invalidTransition", executionId);
          long sequence = sequence(message, executionId);
          if (sequence <= previous) throw new ExecutionFailure("invalidTransition", executionId);
          previous = sequence;
          String sourceId = codec.messageId(message);
          String body = codec.json(message);
          bytes += body.getBytes(StandardCharsets.UTF_8).length;
          if (bytes > 262_144) throw new ExecutionFailure("invalidTransition", executionId);
          var payload = mapper.readTree(body).path("payload");
          if (!conversation.workspaceId().equals(payload.path("workspaceId").asText())
            || !conversation.id().equals(payload.path("conversationId").asText())
            || !conversation.deviceId().equals(payload.path("deviceId").asText())
            || !conversation.projectId().equals(payload.path("projectId").asText())
            || !execution.inputId().equals(payload.path("inputId").asText()))
            throw new ExecutionFailure("targetMismatch", executionId);
          if (sequence < expected) {
            if (!store.sourceReceipt(sourceId, executionId, sequence).filter(body::equals).isPresent())
              throw new ExecutionFailure("conflict", executionId);
            continue;
          }
          if (sequence > expected) throw new ExecutionFailure("gap", executionId, expected, execution.lastCommittedRunnerSequence());
          // 每个来源都必须引用首次命令的固定指纹。
          if (!Objects.equals(startCommandId(message), execution.startCommandId())
            || !Objects.equals(startBodySha256(message), execution.startBodySha256()))
            throw new ExecutionFailure("conflict", executionId);
          if (terminalState(execution.state())) throw new ExecutionFailure("invalidTransition", executionId);
          if (message instanceof ExecutionDtos.ExecutionAcceptedMessage) {
            if (sequence != 1 || decision != null || !"dispatching".equals(execution.lastConfirmedState()))
              throw new ExecutionFailure("invalidTransition", executionId);
            String denial = "none".equals(execution.cancelState()) ? authorizationFailure : "CANCEL_REQUESTED";
            decision = createDecision(execution, denial);
            execution = applyAccepted(execution, decision);
          } else if (message instanceof ExecutionDtos.ExecutionNativeBoundMessage bound) {
            requireAllow(execution, decision, bound.payload().startDecisionMessageId());
            if (execution.nativeSessionId() != null) throw new ExecutionFailure("invalidTransition", executionId);
            String boundSession = store.nativeSession(conversation.id());
            if (boundSession != null && !boundSession.equals(bound.payload().nativeSessionId()))
              throw new ExecutionFailure("bindingConflict", executionId);
            store.bindNativeSession(conversation.id(), bound.payload().nativeSessionId());
            execution = nativeBound(execution, bound.payload().nativeSessionId());
          } else if (message instanceof ExecutionDtos.ExecutionRunningMessage running) {
            requireAllow(execution, decision, running.payload().startDecisionMessageId());
            if (execution.nativeSessionId() == null || !execution.nativeSessionId().equals(running.payload().nativeSessionId()))
              throw new ExecutionFailure("bindingConflict", executionId);
            if (!"accepted".equals(execution.lastConfirmedState())) throw new ExecutionFailure("invalidTransition", executionId);
            execution = running(execution, running.payload().nativeSessionId());
          } else if (message instanceof ExecutionDtos.ExecutionOutputMessage output) {
            requireAllow(execution, decision, output.payload().startDecisionMessageId());
            if (!"running".equals(execution.lastConfirmedState())) throw new ExecutionFailure("invalidTransition", executionId);
            execution = output(execution, conversation, output);
          } else if (message instanceof ExecutionDtos.ExecutionTerminalMessage terminal) {
            validateTerminal(execution, decision, terminal.payload());
            execution = terminal(execution, conversation, terminal);
          } else if (message instanceof ExecutionDtos.ExecutionCancelReceivedMessage received) {
            if (!"requested".equals(execution.cancelState()) || !Objects.equals(execution.cancelCommandId(), received.payload().cancelCommandId()))
              throw new ExecutionFailure("invalidTransition", executionId);
            execution = cancelReceived(execution, received);
          }
          store.saveSourceReceipt(sourceId, executionId, sequence, body);
          expected++;
          execution = new ExecutionRow(execution.id(), execution.conversationId(), execution.inputId(), execution.inputSequence(),
            execution.initiatedByUserId(), execution.agentConfigId(), execution.shareVersion(), execution.state(), execution.lastConfirmedState(),
            execution.cancelState(), execution.reasonCode(), execution.startCommandId(), execution.startBodySha256(), execution.decisionMessageId(),
            execution.decisionJson(), execution.nativeSessionId(), execution.cancelCommandId(), execution.cancelRequestedBy(),
            expected - 1, expected - 1, execution.createdAtMs(), System.currentTimeMillis());
        }
        store.updateExecution(execution);
        return new RecordBatchResult(new ExecutionAck(execution.id(), Long.toString(execution.lastCommittedRunnerSequence())), decision);
      });
    } catch (DuplicateKeyException collision) {
      throw new ExecutionFailure("conflict", executionId);
    }
  }

  private static void requireAllow(ExecutionRow execution, ExecutionStartDecisionMessage decision, String decisionId) {
    if (decision == null || !"allow".equals(decision.payload().decision()) || !decision.messageId().equals(decisionId))
      throw new ExecutionFailure("invalidTransition", execution.id());
  }

  private static void validateTerminal(ExecutionRow execution, ExecutionStartDecisionMessage decision, ExecutionTerminalPayload terminal) {
    boolean notInvoked = "notInvoked".equals(terminal.invocationState());
    boolean cancelled = "cancelled".equals(terminal.state());
    // 终态须带一致的结束证明，不能把未调用或任意错误文字写成成功/失败。
    boolean validOutcome = switch (terminal.state()) {
      case "succeeded" -> !notInvoked && terminal.reasonCode() == null;
      case "failed" -> !notInvoked && "EXECUTION_FAILED".equals(terminal.reasonCode());
      case "cancelled" -> "CANCELLED_BY_RUNNER".equals(terminal.reasonCode());
      case "rejected" -> notInvoked && terminal.reasonCode() != null && Set.of("AUTHOR_UNAVAILABLE",
        "PROJECT_NOT_SHARED", "SHARE_VERSION_CHANGED", "DEVICE_REVOKED", "TARGET_INVALID",
        "NATIVE_SESSION_UNAVAILABLE", "PROJECT_ROOT_CHANGED", "CAPABILITY_UNAVAILABLE").contains(terminal.reasonCode());
      default -> false;
    };
    if (!validOutcome) throw new ExecutionFailure("invalidTransition", execution.id());
    if (terminal.nativeSessionId() != null && !terminal.nativeSessionId().equals(execution.nativeSessionId()))
      throw new ExecutionFailure("bindingConflict", execution.id());
    if (notInvoked && "running".equals(execution.lastConfirmedState()))
      throw new ExecutionFailure("invalidTransition", execution.id());
    if (decision == null) {
      if (!cancelled || !notInvoked || !"delivered".equals(execution.cancelState()) || terminal.startDecisionMessageId() != null)
        throw new ExecutionFailure("invalidTransition", execution.id());
      return;
    }
    if (!decision.messageId().equals(terminal.startDecisionMessageId()))
      throw new ExecutionFailure("invalidTransition", execution.id());
    if ("deny".equals(decision.payload().decision()) && (!notInvoked || (!cancelled && !"rejected".equals(terminal.state()))))
      throw new ExecutionFailure("invalidTransition", execution.id());
    if (!notInvoked && execution.nativeSessionId() == null) throw new ExecutionFailure("invalidTransition", execution.id());
  }

  private static boolean terminalState(String state) {
    return Set.of("succeeded", "failed", "cancelled", "rejected").contains(state);
  }

  private ExecutionRow applyAccepted(ExecutionRow execution, ExecutionStartDecisionMessage decision) {
    String reason = decision.payload().decision().equals("deny") ? decision.payload().reasonCode() : null;
    ExecutionRow updated = copy(execution, "accepted", "accepted", execution.cancelState(), reason, System.currentTimeMillis());
    updated = withDecision(updated, decision);
    store.updateExecution(updated);
    long sequence = store.allocateSequence(execution.conversationId(), 1);
    store.appendEvent(execution.conversationId(), sequence, "execution.changed", new ExecutionPayload(conversations.view(updated)), System.currentTimeMillis());
    return updated;
  }

  private ExecutionRow nativeBound(ExecutionRow execution, String nativeSessionId) {
    // native.bound 可无公开投影；仍独立保存并确认，不产生事件。
    return new ExecutionRow(execution.id(), execution.conversationId(), execution.inputId(), execution.inputSequence(),
      execution.initiatedByUserId(), execution.agentConfigId(), execution.shareVersion(), execution.state(), execution.lastConfirmedState(),
      execution.cancelState(), execution.reasonCode(), execution.startCommandId(), execution.startBodySha256(), execution.decisionMessageId(),
      execution.decisionJson(), nativeSessionId, execution.cancelCommandId(), execution.cancelRequestedBy(),
      execution.runnerSequence(), execution.lastCommittedRunnerSequence(), execution.createdAtMs(), System.currentTimeMillis());
  }

  private ExecutionRow running(ExecutionRow execution, String nativeSessionId) {
    ExecutionRow updated = copy(execution, "running", "running", execution.cancelState(), execution.reasonCode(), System.currentTimeMillis());
    updated = new ExecutionRow(updated.id(), updated.conversationId(), updated.inputId(), updated.inputSequence(), updated.initiatedByUserId(),
      updated.agentConfigId(), updated.shareVersion(), updated.state(), updated.lastConfirmedState(), updated.cancelState(), updated.reasonCode(),
      updated.startCommandId(), updated.startBodySha256(), updated.decisionMessageId(), updated.decisionJson(), nativeSessionId,
      updated.cancelCommandId(), updated.cancelRequestedBy(), updated.runnerSequence(), updated.lastCommittedRunnerSequence(),
      updated.createdAtMs(), updated.updatedAtMs());
    store.updateExecution(updated);
    long sequence = store.allocateSequence(execution.conversationId(), 1);
    store.appendEvent(execution.conversationId(), sequence, "execution.changed", new ExecutionPayload(conversations.view(updated)), System.currentTimeMillis());
    return updated;
  }

  /** 输出变更只追加已提交消息事件；message.created 必须早于 text/close。 */
  private ExecutionRow output(ExecutionRow execution, ConversationRow conversation, ExecutionOutputMessage output) {
    ExecutionChange change = output.payload().change();
    String messageId = change.messageId();
    long now = System.currentTimeMillis();
    if (change instanceof ExecutionDtos.MessageCreatedChange) {
      if (store.message(messageId).isPresent()) throw new ExecutionFailure("conflict", execution.id());
      long sequence = store.allocateSequence(conversation.id(), 1);
      MessageRow message = new MessageRow(messageId, conversation.id(), execution.id(), "agent", null, null, null,
        conversation.agentConfigId(), sequence, now, "", "streaming");
      store.insertMessage(message);
      store.appendEvent(conversation.id(), sequence, "message.created", new ConversationDtos.MessagePayload(conversations.message(message)), now);
    } else if (change instanceof ExecutionDtos.MessageTextAppendedChange appended) {
      MessageRow message = requireAgentMessage(messageId, execution, conversation);
      String text = message.text() + appended.text();
      if (text.length() > 16384) throw new ExecutionFailure("invalidTransition", execution.id());
      store.updateMessageText(messageId, text, "streaming");
      long sequence = store.allocateSequence(conversation.id(), 1);
      store.appendEvent(conversation.id(), sequence, "message.text.appended",
        new ConversationDtos.TextPayload(execution.id(), messageId, appended.text()), now);
    } else if (change instanceof ExecutionDtos.MessageClosedChange closed) {
      MessageRow message = requireAgentMessage(messageId, execution, conversation);
      store.updateMessageText(messageId, message.text(), closed.state());
      long sequence = store.allocateSequence(conversation.id(), 1);
      store.appendEvent(conversation.id(), sequence, "message.closed",
        new ConversationDtos.ClosedPayload(execution.id(), messageId, closed.state()), now);
    } else throw new ExecutionFailure("invalidTransition", execution.id());
    ExecutionRow updated = execution.state().equals("running") ? execution
      : copy(execution, "running", "running", execution.cancelState(), execution.reasonCode(), now);
    store.updateExecution(updated);
    return updated;
  }

  private ExecutionRow terminal(ExecutionRow execution, ConversationRow conversation, ExecutionTerminalMessage terminal) {
    long now = System.currentTimeMillis();
    String cancelState = execution.cancelState().equals("none") ? "none" : "resolved";
    ExecutionRow updated = copy(execution, terminal.payload().state(), terminal.payload().state(),
      cancelState, terminal.payload().reasonCode(), now);
    updated = new ExecutionRow(updated.id(), updated.conversationId(), updated.inputId(), updated.inputSequence(), updated.initiatedByUserId(),
      updated.agentConfigId(), updated.shareVersion(), updated.state(), updated.lastConfirmedState(), updated.cancelState(), updated.reasonCode(),
      updated.startCommandId(), updated.startBodySha256(), updated.decisionMessageId(), updated.decisionJson(),
      terminal.payload().nativeSessionId() == null ? updated.nativeSessionId() : terminal.payload().nativeSessionId(),
      updated.cancelCommandId(), updated.cancelRequestedBy(), updated.runnerSequence(), updated.lastCommittedRunnerSequence(),
      updated.createdAtMs(), updated.updatedAtMs());
    store.updateExecution(updated);
    store.messageByExecution(execution.id(), "agent").ifPresent(message -> {
      if (message.state().equals("streaming")) {
        String state = terminal.payload().state().equals("succeeded") ? "completed" : "interrupted";
        store.updateMessageText(message.id(), message.text(), state);
        long sequence = store.allocateSequence(conversation.id(), 1);
        store.appendEvent(conversation.id(), sequence, "message.closed",
          new ConversationDtos.ClosedPayload(execution.id(), message.id(), state), now);
      }
    });
    long sequence = store.allocateSequence(conversation.id(), 1);
    store.appendEvent(conversation.id(), sequence, "execution.changed", new ExecutionPayload(conversations.view(updated)), now);
    store.releaseActiveExecution(conversation.id(), execution.id());
    return updated;
  }

  private ExecutionRow cancelReceived(ExecutionRow execution, ExecutionCancelReceivedMessage received) {
    ExecutionRow updated = copy(execution, execution.state(), execution.lastConfirmedState(), "delivered",
      execution.reasonCode(), System.currentTimeMillis());
    store.updateExecution(updated);
    long sequence = store.allocateSequence(execution.conversationId(), 1);
    store.appendEvent(execution.conversationId(), sequence, "execution.changed", new ExecutionPayload(conversations.view(updated)), System.currentTimeMillis());
    return updated;
  }

  /** 首次 accepted 时生成唯一决定：取消先到/权限失效一律 deny，且永不改写。 */
  private ExecutionStartDecisionMessage createDecision(ExecutionRow execution, String reason) {
    String occurredAt = TimeCodec.utc(System.currentTimeMillis());
    String id = UUID.nameUUIDFromBytes(("decision:" + execution.id()).getBytes(StandardCharsets.UTF_8)).toString();
    ExecutionStartDecisionPayload payload = new ExecutionStartDecisionPayload(execution.conversationId() == null ? null : workspaceOf(execution),
      execution.conversationId(), execution.id(), execution.inputId(), deviceOf(execution), projectOf(execution),
      execution.startCommandId(), execution.startBodySha256(), reason == null ? "allow" : "deny", reason, null);
    return codec.seal(new ExecutionStartDecisionMessage(1, id, "execution.start.decision", occurredAt, payload), ExecutionStartDecisionMessage.class);
  }

  private ExecutionStartDecisionMessage readDecision(ExecutionRow execution) {
    if (execution.decisionJson() == null) return null;
    return mapper.readValue(execution.decisionJson(), ExecutionStartDecisionMessage.class);
  }

  private MessageRow requireAgentMessage(String messageId, ExecutionRow execution, ConversationRow conversation) {
    MessageRow message = store.message(messageId).orElseThrow(() -> new ExecutionFailure("invalidTransition", execution.id()));
    if (!message.executionId().equals(execution.id()) || !message.conversationId().equals(conversation.id())
      || !"agent".equals(message.authorKind())) throw new ExecutionFailure("targetMismatch", execution.id());
    if (!"streaming".equals(message.state())) throw new ExecutionFailure("invalidTransition", execution.id());
    return message;
  }

  private long sequence(Object message, String executionId) {
    String value = codec.runnerSequence(message);
    if (value == null) throw new ExecutionFailure("invalidTransition", executionId);
    return Long.parseLong(value);
  }

  private static String startCommandId(Object message) {
    return switch (message) {
      case ExecutionDtos.ExecutionAcceptedMessage value -> value.payload().startCommandId();
      case ExecutionDtos.ExecutionNativeBoundMessage value -> value.payload().startCommandId();
      case ExecutionDtos.ExecutionRunningMessage value -> value.payload().startCommandId();
      case ExecutionDtos.ExecutionOutputMessage value -> value.payload().startCommandId();
      case ExecutionDtos.ExecutionTerminalMessage value -> value.payload().startCommandId();
      case ExecutionDtos.ExecutionCancelReceivedMessage value -> value.payload().startCommandId();
      default -> null;
    };
  }

  private static String startBodySha256(Object message) {
    return switch (message) {
      case ExecutionDtos.ExecutionAcceptedMessage value -> value.payload().startBodySha256();
      case ExecutionDtos.ExecutionNativeBoundMessage value -> value.payload().startBodySha256();
      case ExecutionDtos.ExecutionRunningMessage value -> value.payload().startBodySha256();
      case ExecutionDtos.ExecutionOutputMessage value -> value.payload().startBodySha256();
      case ExecutionDtos.ExecutionTerminalMessage value -> value.payload().startBodySha256();
      case ExecutionDtos.ExecutionCancelReceivedMessage value -> value.payload().startBodySha256();
      default -> null;
    };
  }

  private String workspaceOf(ExecutionRow execution) {
    return store.conversation(execution.conversationId()).workspaceId();
  }
  private String deviceOf(ExecutionRow execution) { return store.conversation(execution.conversationId()).deviceId(); }
  private String projectOf(ExecutionRow execution) { return store.conversation(execution.conversationId()).projectId(); }

  private ExecutionRow withDecision(ExecutionRow row, ExecutionStartDecisionMessage decision) {
    return new ExecutionRow(row.id(), row.conversationId(), row.inputId(), row.inputSequence(), row.initiatedByUserId(),
      row.agentConfigId(), row.shareVersion(), row.state(), row.lastConfirmedState(), row.cancelState(), row.reasonCode(),
      row.startCommandId(), row.startBodySha256(), decision.messageId(), codec.json(decision), row.nativeSessionId(),
      row.cancelCommandId(), row.cancelRequestedBy(), row.runnerSequence(), row.lastCommittedRunnerSequence(), row.createdAtMs(), row.updatedAtMs());
  }

  private static ExecutionRow copy(ExecutionRow row, String state, String lastConfirmed, String cancelState, String reason, long now) {
    return new ExecutionRow(row.id(), row.conversationId(), row.inputId(), row.inputSequence(), row.initiatedByUserId(),
      row.agentConfigId(), row.shareVersion(), state, lastConfirmed, cancelState, reason, row.startCommandId(), row.startBodySha256(),
      row.decisionMessageId(), row.decisionJson(), row.nativeSessionId(), row.cancelCommandId(), row.cancelRequestedBy(),
      row.runnerSequence(), row.lastCommittedRunnerSequence(), row.createdAtMs(), now);
  }
}
