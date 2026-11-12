package workbench.collaboration.domain.conversation;

/**
 * 模块：会话聚合根模型 (Conversation)
 *
 * <p>【功能定义】
 * 表示协作工作台中的一个多人/多设备共享会话头（Control Header）。
 * 遵循“控制面与数据面存算分离”原则：本模型仅在 TDSQL 中持久化会话的控制状态、绑定的执行设备与连续序号发生器，
 * 不承载具体的对话正文或流式消息。消息正文统一由 Redis 热滑窗与 ES 持久化承接。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService、ConversationRepository、ConversationConverter。
 * - 下游依赖方：无外部框架依赖（纯领域层 Record）。
 *
 * <p>【字段语义契约】
 * @param id 会话全局唯一业务标识 (UUID)
 * @param workspaceId 所属工作区标识
 * @param title 会话标题
 * @param createdByUserId 创建者用户标识
 * @param currentUserId 当前持有该会话控制权的用户标识
 * @param deviceId 绑定的执行设备标识（Electron Daemon 所在设备）
 * @param projectId 绑定的共享项目标识
 * @param agentConfigId 会话所绑定的智能体配置标识
 * @param nextSequence 该会话下分配给下一个事件/消息的递增序号（单调递增，用于保证时序唯一性）
 * @param nativeSessionId 绑定到底层 ACP Agent 的本地底层会话标识
 * @param activeExecutionId 当前正在运行的执行标识（为空表示当前空闲无执行任务）
 * @param createdAtMs 创建时间戳（毫秒）
 * @param updatedAtMs 最近一次更新时间戳（毫秒）
 */
public record Conversation(
        String id,
        String workspaceId,
        String title,
        String createdByUserId,
        String currentUserId,
        String deviceId,
        String projectId,
        String agentConfigId,
        long nextSequence,
        String nativeSessionId,
        String activeExecutionId,
        long createdAtMs,
        long updatedAtMs
) {}
