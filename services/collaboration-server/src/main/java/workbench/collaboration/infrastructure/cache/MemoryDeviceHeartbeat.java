package workbench.collaboration.infrastructure.cache;

import workbench.collaboration.domain.device.DeviceHeartbeatPort;

import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 模块：进程内设备心跳实现 (MemoryDeviceHeartbeat)
 *
 * <p>【功能定义】
 * 单机内存模式下的设备在线心跳存储：以 ConcurrentHashMap 保存设备最近心跳时间，
 * 在线判定按 TTL（45 秒）惰性过期——读取时比对当前时间，无需后台清理线程。
 *
 * <p>【协作边界】
 * - 上游调用方：MiddlewareConfig (standalone 模式)。
 * - 下游依赖方：CacheKeys。
 */
public final class MemoryDeviceHeartbeat implements DeviceHeartbeatPort {

    private final ConcurrentHashMap<String, Long> beats = new ConcurrentHashMap<>();

    @Override
    public void beat(String deviceId, long atMs) {
        beats.put(deviceId, atMs);
    }

    @Override
    public Optional<Long> lastSeen(String deviceId) {
        Long atMs = beats.get(deviceId);
        if (atMs == null) {
            return Optional.empty();
        }
        if (System.currentTimeMillis() - atMs > CacheKeys.HEARTBEAT_TTL_SECONDS * 1000L) {
            beats.remove(deviceId, atMs);
            return Optional.empty();
        }
        return Optional.of(atMs);
    }

    @Override
    public void remove(String deviceId) {
        beats.remove(deviceId);
    }
}
