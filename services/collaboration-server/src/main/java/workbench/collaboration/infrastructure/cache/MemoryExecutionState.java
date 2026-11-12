package workbench.collaboration.infrastructure.cache;

import workbench.collaboration.domain.execution.ExecutionState;
import workbench.collaboration.domain.execution.ExecutionStatePort;

import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 模块：进程内执行快照与指纹防重实现 (MemoryExecutionState)
 *
 * <p>【功能定义】
 * 单机内存模式下的活跃执行热状态快照与来源事件序号指纹去重器。
 * 遵循 24 小时 TTL 与指纹强一致校验：相同序号相同指纹安全跳过；相同序号不同指纹拒绝处理。
 *
 * <p>【协作边界】
 * - 上游调用方：MiddlewareConfig (standalone 模式)、ExecutionAppService、DeviceAppService。
 * - 下游依赖方：CacheKeys。
 */
public final class MemoryExecutionState implements ExecutionStatePort {

    private final ConcurrentHashMap<String, Timed<ExecutionState>> states = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Timed<String>> sources = new ConcurrentHashMap<>();

    @Override
    public void save(ExecutionState state) {
        states.put(state.executionId(), new Timed<>(state, expiry()));
    }

    @Override
    public Optional<ExecutionState> find(String executionId) {
        return fresh(states, executionId).map(Timed::value);
    }

    @Override
    public boolean rememberSource(String executionId, long sequence, String fingerprint) {
        String key = CacheKeys.source(executionId, sequence);
        Timed<String> created = new Timed<>(fingerprint, expiry());
        Timed<String> current = sources.computeIfAbsent(key, ignored -> created);

        if (current.expiresAtMs < System.currentTimeMillis()) {
            sources.remove(key, current);
            return rememberSource(executionId, sequence, fingerprint);
        }
        if (current.value.equals(fingerprint)) {
            return current == created;
        }
        throw new IllegalStateException("来源序号指纹冲突");
    }

    private static long expiry() {
        return System.currentTimeMillis() + CacheKeys.EXECUTION_TTL_SECONDS * 1000L;
    }

    private static <T> Optional<Timed<T>> fresh(ConcurrentHashMap<String, Timed<T>> map, String key) {
        Timed<T> timed = map.get(key);
        if (timed == null) {
            return Optional.empty();
        }
        if (timed.expiresAtMs < System.currentTimeMillis()) {
            map.remove(key, timed);
            return Optional.empty();
        }
        return Optional.of(timed);
    }

    private record Timed<T>(T value, long expiresAtMs) {}
}
