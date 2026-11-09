package workbench.collaboration.execution;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

import java.util.List;

/**
 * 执行域线上形状：内层头 + 完整 payload；字段顺序与唯一 execution schema 一致，
 * 供确定性字节与设备通道复用。这里不定义第二套决定或 ID 类型。
 */
public final class ExecutionDtos {
  private ExecutionDtos() {}

  public record ExecutionInput(String text) {}

  public record ExecutionStartPayload(
    String workspaceId, String conversationId, String executionId, String inputId, String deviceId, String projectId,
    String inputSequence, String initiatedByUserId, String agentConfigId, String shareVersion,
    String nativeSessionId, ExecutionInput input, String bodySha256) {}

  public record ExecutionCancelPayload(
    String workspaceId, String conversationId, String executionId, String inputId, String deviceId, String projectId,
    String startCommandId, String startBodySha256, String requestedByUserId, String bodySha256) {}

  public record ExecutionStartDecisionPayload(
    String workspaceId, String conversationId, String executionId, String inputId, String deviceId, String projectId,
    String startCommandId, String startBodySha256, String decision, String reasonCode, String bodySha256) {}

  public record ExecutionAcceptedPayload(
    String workspaceId, String conversationId, String executionId, String inputId, String deviceId, String projectId,
    String startCommandId, String runnerSequence, String startBodySha256, String bodySha256) {}

  public record ExecutionNativeBoundPayload(
    String workspaceId, String conversationId, String executionId, String inputId, String deviceId, String projectId,
    String startCommandId, String runnerSequence, String startBodySha256, String startDecisionMessageId,
    String nativeSessionId, String bodySha256) {}

  public record ExecutionRunningPayload(
    String workspaceId, String conversationId, String executionId, String inputId, String deviceId, String projectId,
    String startCommandId, String runnerSequence, String startBodySha256, String startDecisionMessageId,
    String nativeSessionId, String bodySha256) {}

  public record ExecutionOutputPayload(
    String workspaceId, String conversationId, String executionId, String inputId, String deviceId, String projectId,
    String startCommandId, String runnerSequence, String startBodySha256, String startDecisionMessageId,
    ExecutionChange change, String bodySha256) {}

  public record ExecutionTerminalPayload(
    String workspaceId, String conversationId, String executionId, String inputId, String deviceId, String projectId,
    String startCommandId, String runnerSequence, String startBodySha256, String startDecisionMessageId,
    String nativeSessionId, String state, String reasonCode, String invocationState, String bodySha256) {}

  public record ExecutionCancelReceivedPayload(
    String workspaceId, String conversationId, String executionId, String inputId, String deviceId, String projectId,
    String startCommandId, String runnerSequence, String startBodySha256, String cancelCommandId, String bodySha256) {}

  public record ExecutionEventsAckPayload(String executionId, String lastCommittedRunnerSequence) {}

  public record ExecutionStartMessage(int protocolVersion, String messageId, String type, String occurredAt, ExecutionStartPayload payload) {}
  public record ExecutionCancelMessage(int protocolVersion, String messageId, String type, String occurredAt, ExecutionCancelPayload payload) {}
  public record ExecutionStartDecisionMessage(int protocolVersion, String messageId, String type, String occurredAt, ExecutionStartDecisionPayload payload) {}
  public record ExecutionAcceptedMessage(int protocolVersion, String messageId, String type, String occurredAt, ExecutionAcceptedPayload payload) {}
  public record ExecutionNativeBoundMessage(int protocolVersion, String messageId, String type, String occurredAt, ExecutionNativeBoundPayload payload) {}
  public record ExecutionRunningMessage(int protocolVersion, String messageId, String type, String occurredAt, ExecutionRunningPayload payload) {}
  public record ExecutionOutputMessage(int protocolVersion, String messageId, String type, String occurredAt, ExecutionOutputPayload payload) {}
  public record ExecutionTerminalMessage(int protocolVersion, String messageId, String type, String occurredAt, ExecutionTerminalPayload payload) {}
  public record ExecutionCancelReceivedMessage(int protocolVersion, String messageId, String type, String occurredAt, ExecutionCancelReceivedPayload payload) {}
  public record ExecutionEventsAckMessage(int protocolVersion, String messageId, String type, String occurredAt, ExecutionEventsAckPayload payload) {}

  /** 按线上已有的 type 解码，保留字段及顺序供验签和消息投影使用。 */
  @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.EXISTING_PROPERTY, property = "type", visible = true)
  @JsonSubTypes({
    @JsonSubTypes.Type(value = MessageCreatedChange.class, name = "message.created"),
    @JsonSubTypes.Type(value = MessageTextAppendedChange.class, name = "message.text.appended"),
    @JsonSubTypes.Type(value = MessageClosedChange.class, name = "message.closed")
  })
  public sealed interface ExecutionChange permits MessageCreatedChange, MessageTextAppendedChange, MessageClosedChange {
    String messageId();
  }

  public record MessageCreatedChange(String type, String messageId) implements ExecutionChange {}
  public record MessageTextAppendedChange(String type, String messageId, String text) implements ExecutionChange {}
  public record MessageClosedChange(String type, String messageId, String state) implements ExecutionChange {}

  public record ExecutionAck(String executionId, String lastCommittedRunnerSequence) {}
  public record RecordBatchResult(ExecutionAck ack, ExecutionStartDecisionMessage startDecision) {}
  /** 供已认证设备通道逐项发关联查询，只公开原命令标识和摘要。 */
  public record RecoveryCandidate(String executionId, String startCommandId, String startBodySha256) {}

  /** 重发正文来自已持久化的完整内层 JSON，通道只加本次连接外壳。 */
  public record ReconcileResult(String action, ExecutionAck ack, ExecutionStartDecisionMessage startDecision,
                                @JsonIgnore String startJson, @JsonIgnore String cancelJson) {}
  public record ExecutionProblem(String kind, String executionId, String expectedRunnerSequence, String lastCommittedRunnerSequence) {}

  /** Runner 提交的一组来源事件；connectionId 来自当前真实连接，不接受帧内自报。 */
  public record RecordBatchRequest(String deviceId, String connectionId, String executionId, List<?> events) {}
  public record ReconcileRequest(String deviceId, String connectionId, String ledgerId, String executionId,
                                 String startCommandId, String startBodySha256, String localState,
                                 String storedDecisionMessageId, String nativeSessionId) {}
}
