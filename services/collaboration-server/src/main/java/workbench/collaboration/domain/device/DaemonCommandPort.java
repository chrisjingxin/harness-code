package workbench.collaboration.domain.device;

/**
 * 模块：设备指令下发端口接口 (DaemonCommandPort)
 *
 * <p>【功能定义】
 * 定义向远端 Electron 本机 Daemon 下发命令（如触发执行 start、取消执行 cancel）的路由契约。
 * 屏蔽多实例部署下的跨节点通信细节：当目标设备连接在其他 Java 服务节点时，
 * 实现类负责将指令路由转发到持有该 WebSocket 连接的特定节点上。
 *
 * <p>【协作边界】
 * - 上游调用方：ExecutionAppService。
 * - 下游实现方：infrastructure/messaging/ConversationEventHub、infrastructure/messaging/KafkaEventBus。
 */
public interface DaemonCommandPort {

    /**
     * 将指令分发给指定的目标 Electron Daemon。
     *
     * <p>【执行机制】
     * 本方法首先比对目标设备是否在本机节点在线：
     * - 若在线，直接走本地 WebSocket 管道推送；
     * - 若在集群其他节点，则打包投递至 Kafka 指令主题（wb.daemon.commands）进行跨节点广播。
     *
     * @param deviceId 目标 Electron 设备标识
     * @param commandJson 符合跨端协议格式的 JSON 指令报文
     */
    void dispatch(String deviceId, String commandJson);
}
