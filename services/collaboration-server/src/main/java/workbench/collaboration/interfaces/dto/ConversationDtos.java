package workbench.collaboration.interfaces.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * 模块：项目内会话只读共享数据传输对象集 (ConversationDtos)
 *
 * <p>【功能定义】
 * 定义会话登记、简报列表/详情、增量历史与设备同步上传的传输形态。
 * 项目成员只能读到简报与已上传的定稿消息；同步通道只进不出（无下行）。
 * tool_summary 载荷只含摘要字段，不含完整输出（D2）。
 *
 * <p>【协作边界】
 * - 上游调用方：ProjectConversationController、DeviceSyncController、
 *   ConversationAppService、ConversationSyncAppService。
 * - 下游依赖方：Contracts 校验中心。
 */
public final class ConversationDtos {

    private ConversationDtos() {}

    /** 会话涉及的仓库快照项 */
    public record ConversationRepositoryItem(
            String repositoryId,
            String name
    ) {}

    /** 会话简报视图（列表项与详情共用） */
    public record ConversationSummary(
            String conversationId,
            String projectId,
            String ownerUserId,
            String deviceId,
            String title,
            String status,
            String briefText,
            String briefSource,
            Long briefUpdatedAtMs,
            long syncedSequence,
            String updatedAt,
            List<ConversationRepositoryItem> repositories
    ) {}

    /** 登记会话请求：deviceId 必须是调用者本人未吊销设备；repositoryIds ⊆ 项目引用 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ConversationRegisterRequest(
            String deviceId,
            String title,
            List<String> repositoryIds,
            String taskId,
            String requestId
    ) {}

    /** 会话简报列表响应 */
    public record ConversationListResponse(
            String projectId,
            List<ConversationSummary> conversations
    ) {}

    /** 单条会话简报详情响应 */
    public record ConversationDetailResponse(
            ConversationSummary conversation
    ) {}

    /** 增量历史中的单条定稿消息 */
    public record HistoryMessage(
            long sequence,
            String type,
            long occurredAtMs,
            String payload
    ) {}

    /** 增量历史响应：afterSequence 之后的消息 + 当前水位 */
    public record ConversationHistoryResponse(
            String conversationId,
            long syncedSequence,
            List<HistoryMessage> messages
    ) {}

    /** 设备同步上传的消息项 */
    public record SyncMessage(
            long sequence,
            String type,
            long occurredAtMs,
            String payload
    ) {}

    /** 设备同步批次中的简报载荷 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SyncBrief(
            String status,
            String briefText,
            String briefSource
    ) {}

    /** 设备同步请求：消息批次 + 可选简报 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record DeviceSyncRequest(
            List<SyncMessage> messages,
            SyncBrief brief
    ) {}

    /** 设备同步响应：服务端确认后的水位 */
    public record DeviceSyncResponse(
            long syncedSequence
    ) {}
}
