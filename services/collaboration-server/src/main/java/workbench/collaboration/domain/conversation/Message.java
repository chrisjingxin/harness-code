package workbench.collaboration.domain.conversation;

/**
 * 模块：定稿消息实体模型 (Message)
 *
 * <p>【功能定义】
 * 表示主人 Runner 通过同步上传通道递交的完整定稿消息（Finalized Message）。
 * 只承载"生成完毕"的消息与工具调用摘要：type 限定 user/assistant/tool_summary/status，
 * tool_summary 仅含工具名、目标简述、成败与改动行数等摘要字段，不含完整输出与流式碎片（D2）。
 * 热态数据缓存在 Redis 热滑窗，冷态归档与检索由 Elasticsearch 承接，不入 TDSQL。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService、MessageStorePort。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param messageId 消息全局唯一业务标识 (UUID)
 * @param workspaceId 所属工作区标识（ES 路由隔离键）
 * @param conversationId 所属会话标识
 * @param type 消息类型：user/assistant/tool_summary/status
 * @param sequence 会话内由主人 Runner 分配的单调连续序号
 * @param payload 类型化载荷的 JSON 序列化文本（各 type 对应不同载荷结构）
 * @param occurredAtMs 消息在主人本机的发生时间戳（毫秒）
 */
public record Message(
        String messageId,
        String workspaceId,
        String conversationId,
        String type,
        long sequence,
        String payload,
        long occurredAtMs
) {}
