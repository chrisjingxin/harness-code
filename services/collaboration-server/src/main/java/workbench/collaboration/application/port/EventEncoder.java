package workbench.collaboration.application.port;

import workbench.collaboration.domain.conversation.Conversation;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.execution.ExecutionState;

/**
 * 模块：事件 JSON 编码端口接口 (EventEncoder)
 *
 * <p>【功能定义】
 * 定义将领域核心模型（会话、消息、执行状态变迁）统一编码序列化为符合平台规范的
 * 协议事件 JSON 串（ConversationEvent）的契约。
 * 编码产出的 JSON 保证满足跨语言双端 Schema 约束，供 SSE 广播、Redis 事件滑窗与历史补齐使用。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService。
 * - 下游实现方：infrastructure/contract/ContractEventEncoder。
 */
public interface EventEncoder {

    /**
     * 将新建会话编码为会话创建事件 JSON。
     *
     * @param conversation 会话实体
     * @param sequence 事件连续序号
     * @param occurredAtMs 事件发生时间戳（毫秒）
     * @return 序列化后的 JSON 字符串
     */
    String conversationCreated(Conversation conversation, long sequence, long occurredAtMs);

    /**
     * 将定稿消息编码为消息产出事件 JSON。
     *
     * @param message 定稿消息实体
     * @param workspaceId 所属工作区标识
     * @param sequence 事件连续序号
     * @param occurredAtMs 事件发生时间戳（毫秒）
     * @return 序列化后的 JSON 字符串
     */
    String messageCreated(Message message, String workspaceId, long sequence, long occurredAtMs);

    /**
     * 将执行状态跃迁编码为执行状态变更事件 JSON。
     *
     * @param workspaceId 所属工作区标识
     * @param state 最新的活跃执行热状态
     * @param sequence 事件连续序号
     * @param occurredAtMs 事件发生时间戳（毫秒）
     * @return 序列化后的 JSON 字符串
     */
    String executionChanged(String workspaceId, ExecutionState state, long sequence, long occurredAtMs);
}
