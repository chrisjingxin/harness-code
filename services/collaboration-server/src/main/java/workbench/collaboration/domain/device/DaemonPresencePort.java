package workbench.collaboration.domain.device;

import java.util.Optional;

/**
 * 模块：设备在线状态端口接口 (DaemonPresencePort)
 *
 * <p>【功能定义】
 * 定义对全局 Electron Daemon 在线状态与连接路由信息的查询、写入与注销契约。
 * 支持分布式多节点部署场景下，任意节点均可实时获知指定设备的在线状态与长连接所在节点。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceAppService、ExecutionAppService、DaemonWebSocketHandler。
 * - 下游实现方：infrastructure/cache/JedisCollaborationState、infrastructure/cache/MemoryPresence。
 */
public interface DaemonPresencePort {

    /**
     * 保存或刷新指定设备的在线状态（通常写入 Redis 并设置 TTL）。
     *
     * @param presence 设备在线状态与宿主路由对象
     */
    void save(DaemonPresence presence);

    /**
     * 查询指定设备的在线状态。
     *
     * @param deviceId 设备全局唯一标识
     * @return 若在线且未超时则返回包含 DaemonPresence 的 Optional，否则返回 Optional.empty()
     */
    Optional<DaemonPresence> find(String deviceId);

    /**
     * 当设备断开长连接或主动离线时，注销其在线路由记录。
     *
     * @param deviceId 设备全局唯一标识
     */
    default void remove(String deviceId) {}
}
