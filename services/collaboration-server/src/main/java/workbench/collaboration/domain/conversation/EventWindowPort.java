package workbench.collaboration.domain.conversation;

import java.util.List;

/**
 * 模块：会话事件热滑窗端口接口 (EventWindowPort)
 *
 * <p>【功能定义】
 * 定义协作会话的最近实时事件暂存滑窗（Hot Window）能力。
 * 客户端断线重连、历史补齐拉取或 SSE 推送均直接操作此高速存储，避免对底层数据库发起高频回表轮询。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService、ConversationSseController。
 * - 下游实现方：infrastructure/cache/JedisCollaborationState、infrastructure/cache/MemoryHotWindow。
 */
public interface EventWindowPort {

    /**
     * 向指定会话的热滑窗追加一条序列化事件。
     *
     * @param conversationId 会话标识
     * @param sequence 事件在当前会话中的连续单调序号
     * @param eventJson 符合跨端协议规格的事件 JSON 字符串
     */
    void append(String conversationId, long sequence, String eventJson);

    /**
     * 按序号区间范围查询会话事件，主要用于断线重连补齐。
     *
     * <p>【契约约束】
     * 仅返回 sequence > afterSequence 且 sequence <= throughSequence 的事件集合，
     * 结果严格按 sequence 升序排列，最多返回 limit 条。
     *
     * @param conversationId 会话标识
     * @param afterSequence 起始序号（开区间，不包含此序号）
     * @param throughSequence 截止序号（闭区间，包含此序号）
     * @param limit 最大拉取条数
     * @return 存储事件列表
     */
    List<StoredEvent> range(String conversationId, long afterSequence, long throughSequence, int limit);

    /**
     * 热滑窗中存储的单个事件记录。
     *
     * @param sequence 事件连续序号
     * @param eventJson 事件的原始 JSON 载荷
     */
    record StoredEvent(long sequence, String eventJson) {}
}
