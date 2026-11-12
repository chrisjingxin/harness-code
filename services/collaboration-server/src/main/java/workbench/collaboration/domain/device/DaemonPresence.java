package workbench.collaboration.domain.device;

/**
 * 模块：设备在线状态与路由模型 (DaemonPresence)
 *
 * <p>【功能定义】
 * 记录 Electron 本机 Daemon 当前在服务端集群中的实时在线心跳与 WebSocket 连接宿主位置。
 * 数据存储于 Redis 分布式路由表（wb:daemon:presence:{deviceId}），TTL 自动续期失效，
 * 绝不向 TDSQL 写入高频心跳日志，彻底杜绝数据库写放大。
 *
 * <p>【协作边界】
 * - 上游调用方：DaemonWebSocketHandler、DeviceAppService、ExecutionAppService。
 * - 下游依赖方：纯领域层 Record，无框架注解。
 *
 * <p>【字段语义契约】
 * @param deviceId 设备全局唯一标识
 * @param nodeId 持有该设备 WebSocket 连接的 Java 节点标识（用于集群精准路由）
 * @param connectionId 该长连接在当前节点上的通道唯一会话标识
 * @param state 当前在线状态，例如 "connected"（已建立连接并握手通过）
 * @param lastSeenMs 最近一次收到心跳/通信的时间戳（毫秒）
 */
public record DaemonPresence(
        String deviceId,
        String nodeId,
        String connectionId,
        String state,
        long lastSeenMs
) {}
