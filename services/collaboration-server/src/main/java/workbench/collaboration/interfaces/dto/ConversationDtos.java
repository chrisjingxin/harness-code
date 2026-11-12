package workbench.collaboration.interfaces.dto;

import java.util.List;

/**
 * 模块：协作会话与消息数据传输对象集 (ConversationDtos)
 *
 * <p>【功能定义】
 * 统一定义协作会话、定稿消息、执行视图以及会话 SSE 事件（ConversationEvent）在网络传输中的线上数据形态。
 * 字段名称与顺序严格对齐平台 JSON Schema 规范（platform/schema/conversation.json），
 * 确保跨端与双端序列化确定性。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationController、ConversationSseController、ConversationAppService、ContractEventEncoder。
 * - 下游依赖方：Contracts 校验中心。
 */
public final class ConversationDtos {

    private ConversationDtos() {}

    /** 会话概要展示对象 */
    public record ConversationSummary(
            String conversationId,
            String workspaceId,
            String title,
            String createdByUserId,
            String currentUserId,
            String deviceId,
            String projectId,
            String agentConfigId,
            String createdAt
    ) {}

    /** 人类用户作者信息 */
    public record UserAuthor(
            String kind,
            String userId,
            String username,
            String displayName
    ) {}

    /** 智能体作者信息 */
    public record AgentAuthor(
            String kind,
            String agentConfigId
    ) {}

    /** 消息传输视图 */
    public record Message(
            String messageId,
            String conversationId,
            String executionId,
            Object author,
            String createdSequence,
            String createdAt,
            String text,
            String state
    ) {}

    /** 活跃执行视图 */
    public record ExecutionView(
            String executionId,
            String conversationId,
            String inputId,
            String inputSequence,
            String initiatedByUserId,
            String state,
            String lastConfirmedState,
            String cancelState,
            String reasonCode,
            String createdAt,
            String updatedAt
    ) {}

    /** 会话列表分页游标 */
    public record ConversationPageCursor(
            String beforeCreatedAt,
            String beforeId
    ) {}

    /** 会话分页列表响应 */
    public record ConversationListResponse(
            List<ConversationSummary> conversations,
            ConversationPageCursor nextPage
    ) {}

    /** 单个会话详情响应 */
    public record ConversationResponse(
            ConversationSummary conversation
    ) {}

    /** 创建会话请求 */
    public record CreateConversationRequest(
            String requestId,
            String title,
            String deviceId,
            String projectId,
            String agentConfigId
    ) {}

    /** 创建会话成功响应 */
    public record CreateConversationResponse(
            ConversationSummary conversation,
            String committedSequence
    ) {}

    /** 发送输入提问请求 */
    public record SendInputRequest(
            String requestId,
            String text
    ) {}

    /** 输入保存确认响应 */
    public record InputSavedResponse(
            String conversationId,
            String inputId,
            String executionId,
            String inputSequence,
            String committedSequence,
            String savedAt
    ) {}

    /** 取消执行请求 */
    public record CancelExecutionRequest(
            String requestId
    ) {}

    /** 取消执行确认响应 */
    public record CancelExecutionResponse(
            String executionId,
            String cancelState,
            String stateAtRequest,
            String committedSequence
    ) {}

    /** 查询执行状态响应 */
    public record ExecutionResponse(
            ExecutionView execution
    ) {}

    /** 历史事件分页响应 */
    public record HistoryResponse(
            String conversationId,
            String throughSequence,
            List<ConversationEvent> events,
            String nextAfterSequence,
            boolean hasMore
    ) {}

    /** 幂等回执响应 */
    public record RequestReceiptResponse(
            String operation,
            Object result
    ) {}

    public record ConversationPayload(ConversationSummary conversation) {}
    public record MessagePayload(Message message) {}
    public record TextPayload(String executionId, String messageId, String text) {}
    public record ClosedPayload(String executionId, String messageId, String state) {}
    public record ExecutionPayload(ExecutionView execution) {}

    /** 会话实时事件统一外层封包 */
    public record ConversationEvent(
            int protocolVersion,
            String messageId,
            String type,
            String occurredAt,
            String workspaceId,
            String conversationId,
            String sequence,
            Object payload
    ) {}
}
