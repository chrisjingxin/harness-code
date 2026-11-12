package workbench.collaboration.domain.device;

import java.util.Optional;

/**
 * 模块：设备在线心跳端口 (DeviceHeartbeatPort)
 *
 * <p>【功能定义】
 * 承载"设备是否在线"的展示态数据，替代旧的 WSS 在线路由表。
 * 新协作模型下 Java 不再向设备下发任何命令，设备仅通过 HTTPS 心跳上报存活，
 * 心跳只用于界面展示在线状态与最近活跃时间，不参与任何授权或派发判断。
 *
 * <p>【协作边界】
 * - 上游调用方：DeviceAppService（设备列表展示）、DeviceSyncController（心跳上报）。
 * - 下游实现方：infrastructure/cache/JedisCollaborationState（集群）、MemoryDeviceHeartbeat（单机）。
 */
public interface DeviceHeartbeatPort {

    /**
     * 记录一次设备心跳（续期 TTL）。
     *
     * @param deviceId 设备标识
     * @param atMs 心跳时间戳（毫秒）
     */
    void beat(String deviceId, long atMs);

    /**
     * 查询设备最近心跳时间。
     *
     * @param deviceId 设备标识
     * @return 存在未过期心跳时返回时间戳（毫秒），否则返回 Optional.empty()
     */
    Optional<Long> lastSeen(String deviceId);

    /**
     * 判断设备当前是否在线（存在未过期心跳）。
     */
    default boolean isOnline(String deviceId) {
        return lastSeen(deviceId).isPresent();
    }

    /**
     * 主动移除设备心跳（设备吊销时调用，立即转为离线展示）。
     */
    void remove(String deviceId);
}
