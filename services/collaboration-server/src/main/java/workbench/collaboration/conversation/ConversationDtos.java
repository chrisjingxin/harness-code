package workbench.collaboration.conversation;

import java.util.List;

/** 共享会话/消息/执行视图与展示事件；字段顺序与唯一 conversation schema 一致。 */
public final class ConversationDtos {
  private ConversationDtos() {}

  public record ConversationSummary(String conversationId, String workspaceId, String title, String createdByUserId,
                                    String currentUserId, String deviceId, String projectId, String agentConfigId, String createdAt) {}
  public record UserAuthor(String kind, String userId, String username, String displayName) {}
  public record AgentAuthor(String kind, String agentConfigId) {}
  public record Message(String messageId, String conversationId, String executionId, Object author,
                        String createdSequence, String createdAt, String text, String state) {}
  public record ExecutionView(String executionId, String conversationId, String inputId, String inputSequence,
                              String initiatedByUserId, String state, String lastConfirmedState, String cancelState,
                              String reasonCode, String createdAt, String updatedAt) {}
  public record ConversationPageCursor(String beforeCreatedAt, String beforeId) {}
  public record ConversationListResponse(List<ConversationSummary> conversations, ConversationPageCursor nextPage) {}
  public record ConversationResponse(ConversationSummary conversation) {}
  public record CreateConversationRequest(String requestId, String title, String deviceId, String projectId, String agentConfigId) {}
  public record CreateConversationResponse(ConversationSummary conversation, String committedSequence) {}
  public record SendInputRequest(String requestId, String text) {}
  public record InputSavedResponse(String conversationId, String inputId, String executionId, String inputSequence,
                                   String committedSequence, String savedAt) {}
  public record CancelExecutionRequest(String requestId) {}
  public record CancelExecutionResponse(String executionId, String cancelState, String stateAtRequest, String committedSequence) {}
  public record ExecutionResponse(ExecutionView execution) {}
  public record HistoryResponse(String conversationId, String throughSequence, List<ConversationEvent> events,
                                String nextAfterSequence, boolean hasMore) {}
  public record RequestReceiptResponse(String operation, Object result) {}

  public record ConversationPayload(ConversationSummary conversation) {}
  public record MessagePayload(Message message) {}
  public record TextPayload(String executionId, String messageId, String text) {}
  public record ClosedPayload(String executionId, String messageId, String state) {}
  public record ExecutionPayload(ExecutionView execution) {}
  public record ConversationEvent(int protocolVersion, String messageId, String type, String occurredAt,
                                  String workspaceId, String conversationId, String sequence, Object payload) {}

  /** 内部会话行；nextSequence/activeExecutionId 不出线上概要。 */
  public record ConversationRow(String id, String workspaceId, String title, String createdByUserId, String currentUserId,
                                String deviceId, String projectId, String agentConfigId, long nextSequence,
                                String activeExecutionId, long createdAtMs, long updatedAtMs) {}
  public record MessageRow(String id, String conversationId, String executionId, String authorKind, String authorUserId,
                           String authorUsername, String authorDisplayName, String agentConfigId, long createdSequence,
                           long createdAtMs, String text, String state) {}
  public record ExecutionRow(String id, String conversationId, String inputId, long inputSequence, String initiatedByUserId,
                             String agentConfigId, long shareVersion, String state, String lastConfirmedState, String cancelState,
                             String reasonCode, String startCommandId, String startBodySha256, String decisionMessageId,
                             String decisionJson, String nativeSessionId, String cancelCommandId, String cancelRequestedBy,
                             long runnerSequence, long lastCommittedRunnerSequence, long createdAtMs, long updatedAtMs) {}
}
