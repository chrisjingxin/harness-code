package workbench.collaboration.conversation;

import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.conversation.ConversationDtos.*;
import workbench.collaboration.infrastructure.TimeCodec;
import workbench.collaboration.transport.ApiProblem;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import javax.sql.DataSource;
import java.util.*;

/**
 * 会话/消息/执行/事件/派发的唯一 SQL 入口。所有方法加入调用方事务；
 * 本类不自行 commit、不跨网络持锁，也不定义第二份内存队列。
 */
public final class ConversationStore {
  private final JdbcTemplate jdbc;
  private final JsonMapper mapper = JsonMapper.builder().build();

  public ConversationStore(DataSource source) { jdbc = new JdbcTemplate(source); jdbc.setQueryTimeout(3); }

  /** 锁定会话头，串行分配连续 sequence；只允许在同一短事务内调用。 */
  public ConversationRow lockConversation(String conversationId) {
    try {
      return jdbc.queryForObject("SELECT id,workspace_id,title,created_by_user_id,current_user_id,device_id,project_id,agent_config_id,next_sequence,active_execution_id,created_at_ms,updated_at_ms FROM wb_conversation WHERE id = ? FOR UPDATE",
        (row, n) -> new ConversationRow(row.getString(1), row.getString(2), row.getString(3), row.getString(4), row.getString(5), row.getString(6), row.getString(7), row.getString(8), row.getLong(9), row.getString(10), row.getLong(11), row.getLong(12)), conversationId);
    } catch (EmptyResultDataAccessException e) { throw new ApiProblem(404, "RESOURCE_NOT_FOUND"); }
  }

  public ConversationRow conversation(String conversationId) {
    try {
      return jdbc.queryForObject("SELECT id,workspace_id,title,created_by_user_id,current_user_id,device_id,project_id,agent_config_id,next_sequence,active_execution_id,created_at_ms,updated_at_ms FROM wb_conversation WHERE id = ?",
        (row, n) -> new ConversationRow(row.getString(1), row.getString(2), row.getString(3), row.getString(4), row.getString(5), row.getString(6), row.getString(7), row.getString(8), row.getLong(9), row.getString(10), row.getLong(11), row.getLong(12)), conversationId);
    } catch (EmptyResultDataAccessException e) { throw new ApiProblem(404, "RESOURCE_NOT_FOUND"); }
  }

  public void insertConversation(ConversationRow row) {
    jdbc.update("INSERT INTO wb_conversation (id,workspace_id,title,created_by_user_id,current_user_id,device_id,project_id,agent_config_id,next_sequence,active_execution_id,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      row.id(), row.workspaceId(), row.title(), row.createdByUserId(), row.currentUserId(), row.deviceId(), row.projectId(), row.agentConfigId(), row.nextSequence(), row.activeExecutionId(), row.createdAtMs(), row.updatedAtMs());
  }

  /** 推进 next_sequence 并返回本次分配的第一个序号；调用前必须已锁会话行。 */
  public long allocateSequence(String conversationId, long count) {
    Long next = jdbc.queryForObject("SELECT next_sequence FROM wb_conversation WHERE id = ? FOR UPDATE", Long.class, conversationId);
    if (next == null) throw new ApiProblem(404, "RESOURCE_NOT_FOUND");
    jdbc.update("UPDATE wb_conversation SET next_sequence = next_sequence + ?, updated_at_ms = ? WHERE id = ?", count, System.currentTimeMillis(), conversationId);
    return next;
  }

  public void setActiveExecution(String conversationId, String executionId) {
    jdbc.update("UPDATE wb_conversation SET active_execution_id = ?, updated_at_ms = ? WHERE id = ? AND (active_execution_id IS NULL OR active_execution_id = ?)",
      executionId, System.currentTimeMillis(), conversationId, executionId);
  }

  /** 只有当前 active 与该执行一致时才释放，避免清掉后来者。 */
  public void releaseActiveExecution(String conversationId, String executionId) {
    jdbc.update("UPDATE wb_conversation SET active_execution_id = NULL, updated_at_ms = ? WHERE id = ? AND active_execution_id = ?", System.currentTimeMillis(), conversationId, executionId);
  }

  public void insertMessage(MessageRow row) {
    jdbc.update("INSERT INTO wb_message (id,conversation_id,execution_id,author_kind,author_user_id,author_username,author_display_name,agent_config_id,created_sequence,created_at_ms,text,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      row.id(), row.conversationId(), row.executionId(), row.authorKind(), row.authorUserId(), row.authorUsername(), row.authorDisplayName(), row.agentConfigId(), row.createdSequence(), row.createdAtMs(), row.text(), row.state());
  }

  public void updateMessageText(String messageId, String text, String state) {
    jdbc.update("UPDATE wb_message SET text = ?, state = ? WHERE id = ?", text, state, messageId);
  }

  public Optional<MessageRow> message(String messageId) {
    var rows = jdbc.query("SELECT id,conversation_id,execution_id,author_kind,author_user_id,author_username,author_display_name,agent_config_id,created_sequence,created_at_ms,text,state FROM wb_message WHERE id = ?",
      (row, n) -> new MessageRow(row.getString(1), row.getString(2), row.getString(3), row.getString(4), row.getString(5), row.getString(6), row.getString(7), row.getString(8), row.getLong(9), row.getLong(10), row.getString(11), row.getString(12)), messageId);
    return rows.stream().findFirst();
  }

  public Optional<MessageRow> messageByExecution(String executionId, String authorKind) {
    var rows = jdbc.query("SELECT id,conversation_id,execution_id,author_kind,author_user_id,author_username,author_display_name,agent_config_id,created_sequence,created_at_ms,text,state FROM wb_message WHERE execution_id = ? AND author_kind = ? ORDER BY created_sequence LIMIT 1",
      (row, n) -> new MessageRow(row.getString(1), row.getString(2), row.getString(3), row.getString(4), row.getString(5), row.getString(6), row.getString(7), row.getString(8), row.getLong(9), row.getLong(10), row.getString(11), row.getString(12)), executionId, authorKind);
    return rows.stream().findFirst();
  }

  public void appendEvent(String conversationId, long sequence, String type, Object payload, long occurredAtMs) {
    String messageId = UUID.randomUUID().toString();
    jdbc.update("INSERT INTO wb_execution_event (id,conversation_id,sequence,event_message_id,event_type,payload_json,occurred_at_ms) VALUES (?,?,?,?,?,?,?)",
      UUID.randomUUID().toString(), conversationId, sequence, messageId, type, mapper.writeValueAsString(payload), occurredAtMs);
  }

  /** history 只返回已提交事件；throughSequence 固定为调用时已存在的连续前缀。 */
  public List<ConversationEvent> events(String conversationId, long afterSequence, long throughSequence, int limit) {
    return jdbc.query("SELECT e.event_message_id,e.event_type,e.payload_json,e.sequence,e.occurred_at_ms,e.conversation_id,c.workspace_id FROM wb_execution_event e JOIN wb_conversation c ON c.id = e.conversation_id WHERE e.conversation_id = ? AND e.sequence > ? AND e.sequence <= ? ORDER BY e.sequence ASC LIMIT ?",
      (row, n) -> new ConversationEvent(1, row.getString(1), row.getString(2), TimeCodec.utc(row.getLong(5)), row.getString(7), row.getString(6), Long.toString(row.getLong(4)), readPayload(row.getString(3))),
      conversationId, afterSequence, throughSequence, limit);
  }

  private Object readPayload(String json) {
    try { return mapper.readValue(json, Object.class); }
    catch (RuntimeException e) { throw new IllegalStateException("事件载荷损坏", e); }
  }

  public ExecutionRow lockExecution(String executionId) {
    try {
      return jdbc.queryForObject("SELECT id,conversation_id,input_id,input_sequence,initiated_by_user_id,agent_config_id,share_version,state,last_confirmed_state,cancel_state,reason_code,start_command_id,start_body_sha256,decision_message_id,decision_json,native_session_id,cancel_command_id,cancel_requested_by,runner_sequence,last_committed_runner_sequence,created_at_ms,updated_at_ms FROM wb_execution WHERE id = ? FOR UPDATE",
        (row, n) -> executionRow(row), executionId);
    } catch (EmptyResultDataAccessException e) { throw new ApiProblem(404, "RESOURCE_NOT_FOUND"); }
  }

  public ExecutionRow execution(String executionId) {
    try {
      return jdbc.queryForObject("SELECT id,conversation_id,input_id,input_sequence,initiated_by_user_id,agent_config_id,share_version,state,last_confirmed_state,cancel_state,reason_code,start_command_id,start_body_sha256,decision_message_id,decision_json,native_session_id,cancel_command_id,cancel_requested_by,runner_sequence,last_committed_runner_sequence,created_at_ms,updated_at_ms FROM wb_execution WHERE id = ?",
        (row, n) -> executionRow(row), executionId);
    } catch (EmptyResultDataAccessException e) { throw new ApiProblem(404, "RESOURCE_NOT_FOUND"); }
  }

  private static ExecutionRow executionRow(java.sql.ResultSet row) throws java.sql.SQLException {
    return new ExecutionRow(row.getString(1), row.getString(2), row.getString(3), row.getLong(4), row.getString(5), row.getString(6), row.getLong(7),
      row.getString(8), row.getString(9), row.getString(10), row.getString(11), row.getString(12), row.getString(13), row.getString(14), row.getString(15),
      row.getString(16), row.getString(17), row.getString(18), row.getLong(19), row.getLong(20), row.getLong(21), row.getLong(22));
  }

  public Optional<ExecutionRow> executionByStartCommandId(String commandId) {
    var rows = jdbc.query("SELECT id,conversation_id,input_id,input_sequence,initiated_by_user_id,agent_config_id,share_version,state,last_confirmed_state,cancel_state,reason_code,start_command_id,start_body_sha256,decision_message_id,decision_json,native_session_id,cancel_command_id,cancel_requested_by,runner_sequence,last_committed_runner_sequence,created_at_ms,updated_at_ms FROM wb_execution WHERE start_command_id = ?",
      (row, n) -> executionRow(row), commandId);
    return rows.stream().findFirst();
  }

  public void insertExecution(ExecutionRow row) {
    jdbc.update("INSERT INTO wb_execution (id,conversation_id,input_id,input_sequence,initiated_by_user_id,agent_config_id,share_version,state,last_confirmed_state,cancel_state,reason_code,start_command_id,start_body_sha256,decision_message_id,decision_json,native_session_id,cancel_command_id,cancel_requested_by,runner_sequence,last_committed_runner_sequence,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      row.id(), row.conversationId(), row.inputId(), row.inputSequence(), row.initiatedByUserId(), row.agentConfigId(), row.shareVersion(), row.state(),
      row.lastConfirmedState(), row.cancelState(), row.reasonCode(), row.startCommandId(), row.startBodySha256(), row.decisionMessageId(), row.decisionJson(),
      row.nativeSessionId(), row.cancelCommandId(), row.cancelRequestedBy(), row.runnerSequence(), row.lastCommittedRunnerSequence(), row.createdAtMs(), row.updatedAtMs());
  }

  public void updateExecution(ExecutionRow row) {
    jdbc.update("UPDATE wb_execution SET state = ?, last_confirmed_state = ?, cancel_state = ?, reason_code = ?, start_command_id = ?, start_body_sha256 = ?, decision_message_id = ?, decision_json = ?, native_session_id = ?, cancel_command_id = ?, cancel_requested_by = ?, runner_sequence = ?, last_committed_runner_sequence = ?, updated_at_ms = ? WHERE id = ?",
      row.state(), row.lastConfirmedState(), row.cancelState(), row.reasonCode(), row.startCommandId(), row.startBodySha256(), row.decisionMessageId(),
      row.decisionJson(), row.nativeSessionId(), row.cancelCommandId(), row.cancelRequestedBy(), row.runnerSequence(), row.lastCommittedRunnerSequence(), row.updatedAtMs(), row.id());
  }

  /** 执行行本身就是持久队列，同一会话按输入序号选最早未终结的一项。 */
  public List<String> claimableHeads(int limit) {
    return jdbc.queryForList("SELECT e.id FROM wb_execution e JOIN wb_conversation c ON c.id = e.conversation_id "
      + "WHERE c.active_execution_id IS NULL AND e.state = 'queued' AND NOT EXISTS (SELECT 1 FROM wb_execution p "
      + "WHERE p.conversation_id = e.conversation_id AND p.input_sequence < e.input_sequence AND p.state = 'queued') "
      + "ORDER BY e.created_at_ms, e.id LIMIT ?", String.class, limit);
  }

  public void saveStart(String executionId, String canonicalBody) {
    jdbc.update("UPDATE wb_execution SET start_json = ? WHERE id = ? AND start_json IS NULL", canonicalBody, executionId);
  }

  public void saveCancel(String executionId, String canonicalBody) {
    jdbc.update("UPDATE wb_execution SET cancel_json = ? WHERE id = ? AND cancel_json IS NULL", canonicalBody, executionId);
  }

  public String cancelJson(String executionId) {
    return jdbc.queryForObject("SELECT cancel_json FROM wb_execution WHERE id = ? FOR UPDATE", String.class, executionId);
  }

  public String startJson(String executionId) {
    return jdbc.queryForObject("SELECT start_json FROM wb_execution WHERE id = ? FOR UPDATE", String.class, executionId);
  }

  public String nativeSession(String conversationId) {
    return jdbc.queryForObject("SELECT native_session_id FROM wb_conversation WHERE id = ? FOR UPDATE", String.class, conversationId);
  }

  public void bindNativeSession(String conversationId, String nativeSessionId) {
    jdbc.update("UPDATE wb_conversation SET native_session_id = ? WHERE id = ? AND native_session_id IS NULL",
      nativeSessionId, conversationId);
  }

  /** 已提交来源身份与正文独立于 SSE 投影保存，即使没有公开事件也可精确去重。 */
  public Optional<String> sourceReceipt(String sourceId, String executionId, long sequence) {
    return jdbc.query("SELECT canonical_body FROM wb_execution_receipt WHERE source_event_id = ? AND execution_id = ? AND runner_sequence = ?",
      (row, n) -> row.getString(1), sourceId, executionId, sequence).stream().findFirst();
  }

  public void saveSourceReceipt(String sourceId, String executionId, long sequence, String body) {
    jdbc.update("INSERT INTO wb_execution_receipt (source_event_id,execution_id,runner_sequence,canonical_body) VALUES (?,?,?,?)",
      sourceId, executionId, sequence, body);
  }

  /** 已写出但 15 秒内未受理的执行；只用于同一 start 的核对/重发。 */
  public List<String> staleDispatch(long beforeMs, int limit) {
    return jdbc.queryForList("SELECT id FROM wb_execution WHERE state = 'dispatching' AND updated_at_ms < ? ORDER BY updated_at_ms LIMIT ?", String.class, beforeMs, limit);
  }

  /** 已经持久取消但尚未送达的执行；同一 commandId 由 Runner 去重。 */
  public List<String> pendingCancels(int limit) {
    return jdbc.queryForList("SELECT id FROM wb_execution WHERE cancel_state = 'requested' AND state IN ('dispatching','accepted','running','unknown') AND cancel_command_id IS NOT NULL ORDER BY updated_at_ms LIMIT ?", String.class, limit);
  }

  public List<ConversationSummary> listConversations(String workspaceId, long beforeCreatedAt, String beforeId, int limit) {
    return jdbc.query("SELECT id,workspace_id,title,created_by_user_id,current_user_id,device_id,project_id,agent_config_id,created_at_ms FROM wb_conversation WHERE workspace_id = ? AND (created_at_ms < ? OR (created_at_ms = ? AND id < ?)) ORDER BY created_at_ms DESC, id DESC LIMIT ?",
      (row, n) -> new ConversationSummary(row.getString(1), row.getString(2), row.getString(3), row.getString(4), row.getString(5), row.getString(6), row.getString(7), row.getString(8), TimeCodec.utc(row.getLong(9))),
      workspaceId, beforeCreatedAt, beforeCreatedAt, beforeId == null ? "" : beforeId, limit);
  }

  public record Receipt(String body, String response) {}

  /** 查询与重试均按工作区、作者、操作、业务 ID 四项隔离。 */
  public Optional<Receipt> receipt(String workspaceId, String userId, String operation, String requestId) {
    return jdbc.query("SELECT canonical_body,response_json FROM wb_request_receipt WHERE workspace_id = ? AND user_id = ? AND operation = ? AND request_id = ?",
      (row, n) -> new Receipt(row.getString(1), row.getString(2)), workspaceId, userId, operation, requestId).stream().findFirst();
  }

  public void saveReceipt(String workspaceId, String userId, String operation, String requestId, String body, String response) {
    jdbc.update("INSERT INTO wb_request_receipt (request_id,workspace_id,user_id,operation,canonical_body,response_json,created_at_ms) VALUES (?,?,?,?,?,?,?)",
      requestId, workspaceId, userId, operation, body, response, System.currentTimeMillis());
  }

  public String json(Object value) { return mapper.writeValueAsString(value); }
}
