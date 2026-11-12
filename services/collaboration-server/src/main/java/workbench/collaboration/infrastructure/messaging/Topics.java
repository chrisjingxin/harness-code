package workbench.collaboration.infrastructure.messaging;

/**
 * 模块：Kafka 主题与分区路由契约 (Topics)
 *
 * <p>【功能定义】
 * 定义协作中继服务当前唯一保留的 Kafka 通道：wb.search.index 全文检索异步索引主题，
 * 以 workspaceId 作为分区键，与 Elasticsearch 单分片路由规则（_routing）对齐。
 * 旧的 wb.conversation.events 会话广播与 wb.daemon.commands 设备指令主题已随远程派发链路一并拆除（HC-211）。
 *
 * <p>【协作边界】
 * - 上游调用方：KafkaEventBus、MiddlewareConfig。
 * - 下游依赖方：无外部依赖。
 */
public final class Topics {

    /** 全文检索异步索引主题（驱动定稿文档批量异步写入 Elasticsearch） */
    public static final String SEARCH = "wb.search.index";

    private Topics() {}

    /**
     * 生成检索索引分区键。
     */
    public static String searchKey(String workspaceId) {
        return workspaceId;
    }
}
