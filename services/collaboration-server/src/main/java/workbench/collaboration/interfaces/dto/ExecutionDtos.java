package workbench.collaboration.interfaces.dto;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

import java.util.List;

/**
 * 模块：执行生命周期指令与事件数据传输对象集 (ExecutionDtos)
 *
 * <p>【功能定义】
 * 统一定义执行域相关的控制信令（启动 start、取消 cancel、状态跃迁 running/terminal 等）的线上报文结构。
 * 遵循确定性与防篡改不变量：字段声明顺序严格与 execution.json Schema 一致；
 * 通过 ExecutionCodec.seal 计算规范化载荷哈希并回填 payload.bodySha256，供两端确定性验签。
 *
 * <p>【协作边界】
 * - 上游调用方：ExecutionAppService、ConversationAppService、DaemonWebSocketHandler、ExecutionCodec。
 * - 下游依赖方：Contracts 校验中心。
 */
public final class ExecutionDtos {

    private ExecutionDtos() {}

    /** 执行输入正文载荷 */
    public record ExecutionInput(String text) {}

    /** 任务启动载荷 */
    public record ExecutionStartPayload(
            String workspaceId,
            String conversationId,
            String executionId,
            String inputId,
            String deviceId,
            String projectId,
            String inputSequence,
            String initiatedByUserId,
            String agentConfigId,
            String shareVersion,
            String nativeSessionId,
            ExecutionInput input,
            String bodySha256
    ) {}

    /** 任务取消载荷 */
    public record ExecutionCancelPayload(
            String workspaceId,
            String conversationId,
            String executionId,
            String inputId,
            String deviceId,
            String projectId,
            String startCommandId,
            String startBodySha256,
            String requestedByUserId,
            String bodySha256
    ) {}

    /** 启动决议载荷 */
    public record ExecutionStartDecisionPayload(
            String workspaceId,
            String conversationId,
            String executionId,
            String inputId,
            String deviceId,
            String projectId,
            String startCommandId,
            String startBodySha256,
            String decision,
            String reasonCode,
            String bodySha256
    ) {}

    /** 端侧接单确认载荷 */
    public record ExecutionAcceptedPayload(
            String workspaceId,
            String conversationId,
            String executionId,
            String inputId,
            String deviceId,
            String projectId,
            String startCommandId,
            String runnerSequence,
            String startBodySha256,
            String bodySha256
    ) {}

    /** 本地会话绑定载荷 */
    public record ExecutionNativeBoundPayload(
            String workspaceId,
            String conversationId,
            String executionId,
            String inputId,
            String deviceId,
            String projectId,
            String startCommandId,
            String runnerSequence,
            String startBodySha256,
            String startDecisionMessageId,
            String nativeSessionId,
            String bodySha256
    ) {}

    /** 正在执行载荷 */
    public record ExecutionRunningPayload(
            String workspaceId,
            String conversationId,
            String executionId,
            String inputId,
            String deviceId,
            String projectId,
            String startCommandId,
            String runnerSequence,
            String startBodySha256,
            String startDecisionMessageId,
            String nativeSessionId,
            String bodySha256
    ) {}

    /** 执行输出增量载荷 */
    public record ExecutionOutputPayload(
            String workspaceId,
            String conversationId,
            String executionId,
            String inputId,
            String deviceId,
            String projectId,
            String startCommandId,
            String runnerSequence,
            String startBodySha256,
            String startDecisionMessageId,
            ExecutionChange change,
            String bodySha256
    ) {}

    /** 执行终态载荷 */
    public record ExecutionTerminalPayload(
            String workspaceId,
            String conversationId,
            String executionId,
            String inputId,
            String deviceId,
            String projectId,
            String startCommandId,
            String runnerSequence,
            String startBodySha256,
            String startDecisionMessageId,
            String nativeSessionId,
            String state,
            String reasonCode,
            String invocationState,
            String bodySha256
    ) {}

    /** 取消请求已送达载荷 */
    public record ExecutionCancelReceivedPayload(
            String workspaceId,
            String conversationId,
            String executionId,
            String inputId,
            String deviceId,
            String projectId,
            String startCommandId,
            String runnerSequence,
            String startBodySha256,
            String cancelCommandId,
            String bodySha256
    ) {}

    /** 执行事件 ACK 载荷 */
    public record ExecutionEventsAckPayload(
            String executionId,
            String lastCommittedRunnerSequence
    ) {}

    // ─── 执行域完整消息外层封装 ───

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

    /**
     * 执行变更密封接口（按 type 属性多态反序列化）。
     */
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
    public record RecoveryCandidate(String executionId, String startCommandId, String startBodySha256) {}

    public record ReconcileResult(
            String action,
            ExecutionAck ack,
            ExecutionStartDecisionMessage startDecision,
            @JsonIgnore String startJson,
            @JsonIgnore String cancelJson
    ) {}

    public record ExecutionProblem(String kind, String executionId, String expectedRunnerSequence, String lastCommittedRunnerSequence) {}

    public record RecordBatchRequest(String deviceId, String connectionId, String executionId, List<?> events) {}

    public record ReconcileRequest(
            String deviceId,
            String connectionId,
            String ledgerId,
            String executionId,
            String startCommandId,
            String startBodySha256,
            String localState,
            String storedDecisionMessageId,
            String nativeSessionId
    ) {}
}
