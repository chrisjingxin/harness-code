package workbench.collaboration.domain.conversation;

/**
 * 模块：定稿消息实体模型 (Message)
 *
 * <p>【功能定义】
 * 表示协作会话中已被确认产出的完整定稿消息（Finalized Message）。
 * 彻底颠覆旧有的服务端拼接 Token 机制：Electron 本机 Daemon 负责流式渲染，
 * 只有在整条消息生成完毕或阶段定稿后，才向中继服务 Push 一条完整的 Message。
 * 热态数据缓存在 Redis，冷态归档与检索由 Elasticsearch 承接，不入 TDSQL 核心状态表。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceAppService、ConversationAppService、MessageStorePort。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param messageId 消息全局唯一业务标识 (UUID)
 * @param workspaceId 所属工作区标识
 * @param conversationId 所属会话标识
 * @param executionId 产生该消息的执行流水标识（用户提问消息亦对应一个触发执行）
 * @param authorKind 作者类别："user"（人类用户）或 "agent"（智能体）
 * @param authorUserId 发送该消息的用户标识
 * @param authorUsername 发送者用户名
 * @param authorDisplayName 发送者展示名称
 * @param agentConfigId 智能体配置标识（若由 Agent 产出）
 * @param sequence 会话内的单调连续序号
 * @param text 消息定稿文本正文
 * @param state 消息终态："committed"（已确认定稿）
 * @param createdAtMs 创建时间戳（毫秒）
 */
public record Message(
        String messageId,
        String workspaceId,
        String conversationId,
        String executionId,
        String authorKind,
        String authorUserId,
        String authorUsername,
        String authorDisplayName,
        String agentConfigId,
        long sequence,
        String text,
        String state,
        long createdAtMs
) {}
