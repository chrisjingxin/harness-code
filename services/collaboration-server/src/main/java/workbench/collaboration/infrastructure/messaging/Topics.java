package workbench.collaboration.infrastructure.messaging;

/**
 * 模块：Kafka 主题与分区路由契约 (Topics)
 *
 * <p>【功能定义】
 * 统一定义协作中继服务在 Kafka 中使用的三大事件与指令通道主题名称及其分区路由键规则：
 * 1. wb.conversation.events：会话事件广播主题，以 conversationId 作为分区键，确保单个会话内事件严格单分区全局保序；
 * 2. wb.daemon.commands：物理设备指令下发主题，以 deviceId 作为分区键，将同一设备的控制指令路由至对应分区；
 * 3. wb.search.index：全文检索异步索引主题，以 workspaceId 作为分区键，与 Elasticsearch 单分片路由规则（_routing）对齐。
 *
 * <p>【协作边界】
 * - 上游调用方：KafkaEventBus、MiddlewareConfig。
 * - 下游依赖方：无外部依赖。
 */
public final class Topics {

    /** 会话实时事件主题（驱动跨实例 SSE 实时广播） */
    public static final String CONVERSATION = "wb.conversation.events";

    /** 目标设备指令下发主题（驱动跨实例 WebSocket 命令路由） */
    public static final String DAEMON = "wb.daemon.commands";

    /** 全文检索异步索引主题（驱动定稿文档批量异步写入 Elasticsearch） */
    public static final String SEARCH = "wb.search.index";

    private Topics() {}

    /**
     * 生成会话事件分区键（相同会话的消息进入同一 Kafka 分区，保障时序保序）。
     */
    public static String conversationKey(String conversationId) {
        return conversationId;
    }

    /**
     * 生成设备指令分区键。
     */
    public static String daemonKey(String deviceId) {
        return deviceId;
    }

    /**
     * 生成检索索引分区键。
     */
    public static String searchKey(String workspaceId) {
        return workspaceId;
    }
}
