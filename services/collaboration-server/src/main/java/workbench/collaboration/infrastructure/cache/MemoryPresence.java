package workbench.collaboration.infrastructure.cache;

import workbench.collaboration.domain.device.DaemonPresence;
import workbench.collaboration.domain.device.DaemonPresencePort;

import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 模块：进程内设备在线状态管理 (MemoryPresence)
 *
 * <p>【功能定义】
 * 单机内存模式下的设备在线路由表实现。
 * 遵循 45 秒租期主动过期机制：若超过 45 秒未收到端侧心跳更新，
 * 查询时自动剔除并返回离线状态，防止异常断网或崩溃后依然显示虚假在线。
 *
 * <p>【协作边界】
 * - 上游调用方：MiddlewareConfig (standalone 模式)、DaemonWebSocketHandler。
 * - 下游依赖方：CacheKeys。
 */
public final class MemoryPresence implements DaemonPresencePort {

    private final ConcurrentHashMap<String, Timed> rows = new ConcurrentHashMap<>();

    @Override
    public void save(DaemonPresence presence) {
        rows.put(presence.deviceId(), new Timed(
                presence,
                System.currentTimeMillis() + CacheKeys.PRESENCE_TTL_SECONDS * 1000L
        ));
    }

    @Override
    public Optional<DaemonPresence> find(String deviceId) {
        Timed timed = rows.get(deviceId);
        if (timed == null) {
            return Optional.empty();
        }
        if (timed.expiresAtMs < System.currentTimeMillis()) {
            rows.remove(deviceId, timed);
            return Optional.empty();
        }
        return Optional.of(timed.presence);
    }

    @Override
    public void remove(String deviceId) {
        rows.remove(deviceId);
    }

    private record Timed(DaemonPresence presence, long expiresAtMs) {}
}
