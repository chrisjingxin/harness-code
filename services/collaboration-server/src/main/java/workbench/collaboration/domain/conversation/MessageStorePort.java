package workbench.collaboration.domain.conversation;

import java.util.List;
import java.util.Optional;

/**
 * 模块：定稿消息存储端口接口 (MessageStorePort)
 *
 * <p>【功能定义】
 * 定义定稿消息（Message）的高速写入、按 ID 实时检索与最近活跃消息查询契约。
 * 屏蔽底层存算分离实现（Redis 热滑窗 + Elasticsearch 7.6.0 深度存储），
 * 杜绝向 TDSQL 写入海量膨胀文本。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceAppService、ConversationAppService。
 * - 下游实现方：infrastructure/search/ElasticsearchMessageStoreAdapter、infrastructure/cache/JedisCollaborationState。
 */
public interface MessageStorePort {

    /**
     * 保存一条定稿消息。
     * 通常由适配器双写 Redis 热列表并向 Kafka 发送削峰消息异步入库 ES。
     *
     * @param message 待存储的定稿消息实体
     */
    void save(Message message);

    /**
     * 根据工作区与消息标识点查单条定稿消息。
     *
     * @param workspaceId 所属工作区标识（用于 ES 路由隔离）
     * @param messageId 消息全局唯一标识
     * @return 存在时返回包含 Message 的 Optional，否则返回 Optional.empty()
     */
    Optional<Message> find(String workspaceId, String messageId);

    /**
     * 查询指定会话最近定稿的消息列表（按序号升序）。
     *
     * <p>【契约约束】
     * 优先从 Redis 热滑窗读取（< 1ms）；若滑窗条数不足或未命中，则回退至 Elasticsearch 检索补齐。
     *
     * @param conversationId 会话标识
     * @param limit 最大返回条数
     * @return 最近定稿消息列表
     */
    List<Message> recent(String conversationId, int limit);

    /**
     * 读取序号大于 afterSequence 的定稿消息（按序号升序，供只读增量历史）。
     *
     * <p>【契约约束】
     * 集群实现先查 Redis 热窗；热窗覆盖该区间则直接返回，存在缺段（窗口最老序号
     * 仍大于 afterSequence+1，说明更早消息已淘汰）时回源 Elasticsearch 补齐。
     * standalone 内存实现无 ES 回源，窗口外历史不可读（开发态取舍）。
     *
     * @param workspaceId 所属工作区标识（ES 路由隔离键）
     * @param conversationId 会话标识
     * @param afterSequence 起点序号（不含）
     * @param limit 最大返回条数
     * @return 序号升序的增量消息列表
     */
    List<Message> after(String workspaceId, String conversationId, long afterSequence, int limit);
}
