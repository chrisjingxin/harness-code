package workbench.collaboration.infrastructure.cache;

import workbench.collaboration.application.port.IdempotencyPort;

import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 模块：进程内请求幂等防重实现 (MemoryIdempotency)
 *
 * <p>【功能定义】
 * 提供单机环境下基于内存 ConcurrentHashMap 与 Java 监视器锁（wait/notifyAll）实现的 1 小时请求幂等池。
 * 针对并发相同请求提供阻塞等待机制：后到的并发相同请求线程进入阻塞等待，
 * 待首个线程完成业务写入并填充响应后，唤醒等待线程直接重放结果，避免并发产生两笔执行。
 *
 * <p>【协作边界】
 * - 上游调用方：MiddlewareConfig (standalone 模式)、IdempotentCalls。
 * - 下游依赖方：CacheKeys。
 */
public final class MemoryIdempotency implements IdempotencyPort {

    private final ConcurrentHashMap<String, Slot> slots = new ConcurrentHashMap<>();

    @Override
    public Optional<String> begin(String workspaceId, String actorId, String operation, String requestId, String bodySha256) {
        String key = CacheKeys.idempotency(workspaceId, actorId, operation, requestId);
        Slot created = new Slot(bodySha256, System.currentTimeMillis() + CacheKeys.IDEMPOTENCY_TTL_SECONDS * 1000L);
        Slot slot = slots.computeIfAbsent(key, ignored -> created);

        synchronized (slot) {
            expireIfNeeded(key, slot);
            if (slot != slots.get(key)) {
                return begin(workspaceId, actorId, operation, requestId, bodySha256);
            }
            if (!slot.bodySha256.equals(bodySha256)) {
                throw new IllegalStateException("REQUEST_ID_CONFLICT");
            }
            // 首次占位成功或已有定稿响应
            if (slot == created || slot.response != null) {
                return Optional.ofNullable(slot.response);
            }

            // 并发相同请求：最多阻塞等待 8 秒
            long deadline = System.nanoTime() + 8_000_000_000L;
            while (slot.response == null && !slot.failed) {
                long waitMs = (deadline - System.nanoTime()) / 1_000_000L;
                if (waitMs <= 0) {
                    throw new IllegalStateException("幂等占位超时");
                }
                try {
                    slot.wait(waitMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("幂等占位被打断", e);
                }
            }

            if (!slot.bodySha256.equals(bodySha256)) {
                throw new IllegalStateException("REQUEST_ID_CONFLICT");
            }
            // 若先行写入的线程执行失败放开了占位，等待方需重新争抢占位，而非错误判定为指纹冲突
            if (slot.failed) {
                return begin(workspaceId, actorId, operation, requestId, bodySha256);
            }
            return Optional.ofNullable(slot.response);
        }
    }

    @Override
    public void remember(String workspaceId, String actorId, String operation, String requestId, String bodySha256, String responseJson) {
        Slot slot = required(workspaceId, actorId, operation, requestId, bodySha256);
        synchronized (slot) {
            slot.response = responseJson;
            slot.notifyAll();
        }
    }

    @Override
    public void abort(String workspaceId, String actorId, String operation, String requestId) {
        Slot slot = slots.remove(CacheKeys.idempotency(workspaceId, actorId, operation, requestId));
        if (slot == null) {
            return;
        }
        synchronized (slot) {
            slot.failed = true;
            slot.notifyAll();
        }
    }

    @Override
    public Optional<String> find(String workspaceId, String actorId, String operation, String requestId) {
        Slot slot = slots.get(CacheKeys.idempotency(workspaceId, actorId, operation, requestId));
        if (slot == null || slot.response == null || slot.expiresAtMs < System.currentTimeMillis()) {
            return Optional.empty();
        }
        return Optional.of(slot.response);
    }

    private Slot required(String workspaceId, String actorId, String operation, String requestId, String bodySha256) {
        Slot slot = slots.get(CacheKeys.idempotency(workspaceId, actorId, operation, requestId));
        if (slot == null || !slot.bodySha256.equals(bodySha256)) {
            throw new IllegalStateException("REQUEST_ID_CONFLICT");
        }
        return slot;
    }

    private void expireIfNeeded(String key, Slot slot) {
        if (slot.expiresAtMs >= System.currentTimeMillis()) {
            return;
        }
        slots.remove(key, slot);
    }

    private static final class Slot {
        private final String bodySha256;
        private final long expiresAtMs;
        private String response;
        private boolean failed;

        private Slot(String bodySha256, long expiresAtMs) {
            this.bodySha256 = bodySha256;
            this.expiresAtMs = expiresAtMs;
        }
    }
}
