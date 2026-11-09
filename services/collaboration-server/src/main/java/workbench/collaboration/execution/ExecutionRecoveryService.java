package workbench.collaboration.execution;

import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.conversation.ConversationDtos.*;
import workbench.collaboration.conversation.ConversationStore;
import workbench.collaboration.execution.ExecutionDtos.*;
import workbench.collaboration.transport.ApiProblem;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.JdbcTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import javax.sql.DataSource;
import java.util.List;
import java.util.Objects;

/**
 * 恢复端口：只按原账本/原命令回答，notFound 不代表可以换机器重跑；
 * 摘要或绑定不一致保留 unknown，不造终态。
 */
public final class ExecutionRecoveryService {
  private final TransactionTemplate transaction;
  private final ConversationStore store;
  private final JdbcTemplate jdbc;
  private final ExecutionStartAuthorization authorization;
  private final ExecutionCodec codec;
  private final JsonMapper mapper = JsonMapper.builder().build();

  public ExecutionRecoveryService(DataSource source, ConversationStore store, ExecutionCodec codec) {
    this.transaction = new TransactionTemplate(new JdbcTransactionManager(source));
    this.store = store;
    this.jdbc = new JdbcTemplate(source);
    this.jdbc.setQueryTimeout(3);
    this.authorization = new ExecutionStartAuthorization(source);
    this.codec = codec;
  }

  /** 通道使用握手认证得出的三项归属。按原 start ID 升序翻页，首个游标传 null。 */
  public List<RecoveryCandidate> listCandidates(String workspaceId, String deviceId, String ledgerId,
                                                String afterStartCommandId, int limit) {
    if (limit < 1 || limit > 100) throw new IllegalArgumentException("恢复清单页大小无效");
    return jdbc.query("""
      SELECT e.id,e.start_command_id,e.start_body_sha256
      FROM wb_execution e JOIN wb_conversation c ON c.id = e.conversation_id
      JOIN wb_device d ON d.id = c.device_id AND d.workspace_id = c.workspace_id
      WHERE d.workspace_id = ? AND d.id = ? AND d.ledger_id = ? AND d.revoked_at_ms IS NULL
        AND e.start_json IS NOT NULL AND e.start_command_id > ?
        AND e.state IN ('dispatching','accepted','running','unknown')
      ORDER BY e.start_command_id LIMIT ?
      """, (row, n) -> new RecoveryCandidate(row.getString(1), row.getString(2), row.getString(3)),
      workspaceId, deviceId, ledgerId, afterStartCommandId == null ? "" : afterStartCommandId, limit);
  }

  /** notFound 只由已匹配本轮关联查询的当前连接传入，不能把 Runner 主动报文直接当证据。 */
  public ReconcileResult reconcile(String deviceId, String connectionId, String ledgerId, String executionId,
                                   String startCommandId, String startBodySha256, String localState,
                                   String storedDecisionMessageId, String nativeSessionId) {
    return transaction.execute(status -> {
      ExecutionRow probe = store.execution(executionId);
      ConversationRow target = store.conversation(probe.conversationId());
      if (!target.deviceId().equals(deviceId)) throw new ExecutionFailure("targetMismatch", executionId);
      var ledger = jdbc.queryForList("SELECT ledger_id FROM wb_device WHERE id = ? AND workspace_id = ? AND revoked_at_ms IS NULL",
        String.class, deviceId, target.workspaceId());
      if (ledger.isEmpty() || !Objects.equals(ledger.getFirst(), ledgerId)) throw new ExecutionFailure("conflict", executionId);
      boolean missing = "notFound".equals(localState);
      ExecutionStartAuthorization.Result authorizationResult = missing && probe.lastCommittedRunnerSequence() == 0
        && probe.cancelCommandId() == null && !terminal(probe) ? authorization.check(target, probe) : null;
      ConversationRow conversation = store.lockConversation(probe.conversationId());
      ExecutionRow execution = store.lockExecution(executionId);
      if (!Objects.equals(startCommandId, execution.startCommandId())) throw new ExecutionFailure("targetMismatch", executionId);
      if (!Objects.equals(startBodySha256, execution.startBodySha256())) throw new ExecutionFailure("conflict", executionId);
      ExecutionStartDecisionMessage decision = execution.decisionJson() == null ? null
        : mapper.readValue(execution.decisionJson(), ExecutionStartDecisionMessage.class);
      if (storedDecisionMessageId != null && (decision == null || !storedDecisionMessageId.equals(decision.messageId())))
        throw new ExecutionFailure("conflict", executionId);
      if (execution.nativeSessionId() != null && nativeSessionId != null && !execution.nativeSessionId().equals(nativeSessionId))
        throw new ExecutionFailure("bindingConflict", executionId);
      ExecutionAck ack = new ExecutionAck(execution.id(), Long.toString(execution.lastCommittedRunnerSequence()));
      if (missing) {
        if (execution.lastCommittedRunnerSequence() != 0 || decision != null || storedDecisionMessageId != null || nativeSessionId != null)
          throw new ExecutionFailure("conflict", executionId);
        if (terminal(execution) || !execution.id().equals(conversation.activeExecutionId())
          || !"dispatching".equals(execution.lastConfirmedState()))
          return new ReconcileResult("waitForEvidence", ack, null, null, null);
        if (execution.cancelCommandId() != null) {
          String original = store.cancelJson(executionId);
          if (original == null) throw new ExecutionFailure("conflict", executionId);
          ExecutionCancelMessage cancel = mapper.readValue(original, ExecutionCancelMessage.class);
          if (!codec.verify(cancel) || !execution.cancelCommandId().equals(cancel.messageId())
            || !startCommandId.equals(cancel.payload().startCommandId()) || !startBodySha256.equals(cancel.payload().startBodySha256()))
            throw new ExecutionFailure("conflict", executionId);
          return new ReconcileResult("waitForEvidence", ack, null, null, original);
        }
        if (authorizationResult == null || authorizationResult.denial() != null || !authorizationResult.available()
          || !"none".equals(execution.cancelState()))
          return new ReconcileResult("waitForEvidence", ack, null, null, null);
        String original = store.startJson(executionId);
        if (original == null) throw new ExecutionFailure("conflict", executionId);
        ExecutionStartMessage start = mapper.readValue(original, ExecutionStartMessage.class);
        if (!codec.verify(start) || !startCommandId.equals(start.messageId()) || !startBodySha256.equals(start.payload().bodySha256())
          || !executionId.equals(start.payload().executionId()) || !deviceId.equals(start.payload().deviceId())
          || !conversation.workspaceId().equals(start.payload().workspaceId())) throw new ExecutionFailure("conflict", executionId);
        return new ReconcileResult("resendSame", ack, null, original, null);
      }
      String action = switch (localState) {
        case "accepted", "notInvoked" -> "continueOriginal";
        case "terminalPending" -> terminal(execution) ? "terminalSaved" : "waitForEvidence";
        case "invoking", "running", "unknown" -> "waitForEvidence";
        default -> throw new ApiProblem(400, "INVALID_REQUEST");
      };
      return new ReconcileResult(action, ack, decision, null, null);
    });
  }

  private static boolean terminal(ExecutionRow execution) {
    return switch (execution.state()) {
      case "succeeded", "failed", "cancelled", "rejected" -> true;
      default -> false;
    };
  }
}
