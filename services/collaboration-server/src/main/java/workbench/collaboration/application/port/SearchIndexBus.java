package workbench.collaboration.application.port;

/**
 * 模块：检索索引异步投递端口 (SearchIndexBus)
 *
 * <p>【功能定义】
 * 向 wb.search.index 通道投递待写入 Elasticsearch 的定稿文档 JSON。
 * 单机模式由 LocalEventBus 进程内直发；集群模式由 KafkaEventBus 跨节点广播，
 * 消费端按文档 ID 幂等 upsert，天然去重。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationSyncAppService（同步入库后异步索引）。
 * - 下游实现方：LocalEventBus（standalone）、KafkaEventBus（cluster）。
 */
public interface SearchIndexBus {

    /**
     * 投递一条检索索引文档。
     *
     * @param workspaceId 所属工作区标识（Kafka 分区键与 ES _routing 对齐）
     * @param documentJson 待索引文档 JSON
     */
    void publishSearchIndex(String workspaceId, String documentJson);
}
