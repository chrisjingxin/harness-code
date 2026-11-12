package workbench.collaboration.application.port;

/**
 * 模块：实时消息广播总线端口接口 (RealtimeBroadcastPort)
 *
 * <p>【功能定义】
 * 定义将平台协作产生的会话事件、设备下发指令与搜索索引异步投递至消息总线（Kafka / Local EventBus）的契约。
 * 遵循非阻塞发布原则：调用方投递后无需等待落盘完成，彻底解耦业务主流程与异步消费端。
 *
 * <p>【协作边界】
 * - 上游调用方：ConversationAppService。
 * - 下游实现方：infrastructure/messaging/KafkaEventBus、infrastructure/messaging/LocalEventBus。
 */
public interface RealtimeBroadcastPort {

    /**
     * 异步发布会话事件（驱动跨实例 SSE 实时流式广播与客户端增量消费）。
     *
     * @param conversationId 会话全局唯一标识
     * @param eventJson 符合平台协议标准的会话事件 JSON 字符串
     */
    void publishConversationEvent(String conversationId, String eventJson);

    /**
     * 异步投递向 Electron Daemon 发送的控制指令（如执行启动 start、取消 cancel）。
     *
     * @param deviceId 目标 Electron 设备标识
     * @param commandJson 指令封包 JSON 字符串
     */
    void publishDaemonCommand(String deviceId, String commandJson);

    /**
     * 异步投递待全文检索索引的实体文档（如 Message 或 Conversation，供 ES 批量索引消费）。
     *
     * @param workspaceId 所属工作区标识（用作 ES 单分片路由键 _routing）
     * @param documentJson 待索引的 JSON 文档载荷
     */
    void publishSearchIndex(String workspaceId, String documentJson);
}
