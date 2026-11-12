package workbench.collaboration.infrastructure.cache;

import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.params.SetParams;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.conversation.MessageStorePort;
import workbench.collaboration.domain.device.DeviceHeartbeatPort;
import workbench.collaboration.infrastructure.search.ElasticsearchMessageStoreAdapter;

import java.util.List;
import java.util.Optional;

/**
 * 模块：分布式 Redis 协作状态与滑窗实现 (JedisCollaborationState)
 *
 * <p>【功能定义】
 * 集群生产模式下基于 JedisPool 实现的分布式协作状态中心。
 * 承接三大分布式热态能力，消除数据库写放大与轮询：
 * 1. 1小时请求幂等池 (Idempotency)：采用 Redis 原生 SET key value NX EX 实现分布式互斥占位；
 * 2. 设备在线心跳 (Heartbeat)：String 结构存最近心跳毫秒时间，TTL 45 秒，仅用于在线展示；
 * 3. 定稿消息热滑窗 (Messages)：采用 ZSet 结构按 sequence 得分存储最近 100 条定稿消息，点查联动 ES 7.6.0。
 *
 * <p>【高可用容灾与鲁棒性原则 (Why)】
 * - 拒绝静默降级：Jedis 连接在 Spring 引导时已经过探活；运行期间若 Redis 故障直接抛出异常（Fail-Closed），
 *   严防在集群多节点运行中因单节点静默降级为本地内存而引发严重的多节点脑裂。
 *
 * <p>【协作边界】
 * - 上游调用方：MiddlewareConfig (cluster 模式)。
 * - 下游依赖方：JedisPool、ElasticsearchMessageStoreAdapter、Jackson JsonMapper。
 */
public final class JedisCollaborationState {

    private final JedisPool pool;
    private final ElasticsearchMessageStoreAdapter search;
    private final JsonMapper json = JsonMapper.builder().build();
    private final Idempotency idempotency = new Idempotency();
    private final Heartbeat heartbeats = new Heartbeat();
    private final Messages messages = new Messages();

    public JedisCollaborationState(JedisPool pool) {
        this(pool, null);
    }

    public JedisCollaborationState(JedisPool pool, ElasticsearchMessageStoreAdapter search) {
        this.pool = pool;
        this.search = search;
    }

    public IdempotencyPort idempotency() {
        return idempotency;
    }

    public DeviceHeartbeatPort heartbeats() {
        return heartbeats;
    }

    public MessageStorePort messages() {
        return messages;
    }

    /**
     * 分布式请求幂等实现内部类。
     */
    private final class Idempotency implements IdempotencyPort {
        @Override
        public Optional<String> begin(String workspaceId, String actorId, String operation, String requestId, String bodySha256) {
            String key = CacheKeys.idempotency(workspaceId, actorId, operation, requestId);
            String created = json.writeValueAsString(new Receipt(bodySha256, null));
            try (Jedis jedis = pool.getResource()) {
                // 原子 SET NX EX：仅当 key 不存在时写入占位符并设置 1 小时过期
                String set = jedis.set(key, created, SetParams.setParams().nx().ex(CacheKeys.IDEMPOTENCY_TTL_SECONDS));
                if ("OK".equals(set)) {
                    return Optional.empty();
                }
                Receipt current = read(jedis.get(key));
                if (current == null || !bodySha256.equals(current.bodySha256)) {
                    throw new IllegalStateException("REQUEST_ID_CONFLICT");
                }
                // 等待并发持有者写入定稿响应
                long deadline = System.nanoTime() + 8_000_000_000L;
                while (current.responseJson == null) {
                    if (System.nanoTime() > deadline) {
                        throw new IllegalStateException("幂等占位超时");
                    }
                    try {
                        Thread.sleep(20);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException("幂等占位被打断", e);
                    }
                    current = read(jedis.get(key));
                    if (current == null) {
                        return begin(workspaceId, actorId, operation, requestId, bodySha256);
                    }
                    if (!bodySha256.equals(current.bodySha256)) {
                        throw new IllegalStateException("REQUEST_ID_CONFLICT");
                    }
                }
                return Optional.of(current.responseJson);
            }
        }

        @Override
        public void remember(String workspaceId, String actorId, String operation, String requestId, String bodySha256, String responseJson) {
            String key = CacheKeys.idempotency(workspaceId, actorId, operation, requestId);
            try (Jedis jedis = pool.getResource()) {
                Receipt current = read(jedis.get(key));
                if (current == null || !bodySha256.equals(current.bodySha256)) {
                    throw new IllegalStateException("REQUEST_ID_CONFLICT");
                }
                jedis.set(key, json.writeValueAsString(new Receipt(bodySha256, responseJson)), SetParams.setParams().xx().ex(CacheKeys.IDEMPOTENCY_TTL_SECONDS));
            }
        }

        @Override
        public void abort(String workspaceId, String actorId, String operation, String requestId) {
            try (Jedis jedis = pool.getResource()) {
                jedis.del(CacheKeys.idempotency(workspaceId, actorId, operation, requestId));
            }
        }

        @Override
        public Optional<String> find(String workspaceId, String actorId, String operation, String requestId) {
            try (Jedis jedis = pool.getResource()) {
                Receipt current = read(jedis.get(CacheKeys.idempotency(workspaceId, actorId, operation, requestId)));
                return current == null || current.responseJson == null ? Optional.empty() : Optional.of(current.responseJson);
            }
        }
    }

    /**
     * 设备在线心跳实现内部类。
     * String 键存最近心跳毫秒时间，TTL 45 秒惰性过期；仅作在线展示，不参与授权判断。
     */
    private final class Heartbeat implements DeviceHeartbeatPort {
        @Override
        public void beat(String deviceId, long atMs) {
            try (Jedis jedis = pool.getResource()) {
                jedis.setex(CacheKeys.deviceHeartbeat(deviceId), CacheKeys.HEARTBEAT_TTL_SECONDS, Long.toString(atMs));
            }
        }

        @Override
        public Optional<Long> lastSeen(String deviceId) {
            try (Jedis jedis = pool.getResource()) {
                String raw = jedis.get(CacheKeys.deviceHeartbeat(deviceId));
                return raw == null ? Optional.empty() : Optional.of(Long.parseLong(raw));
            }
        }

        @Override
        public void remove(String deviceId) {
            try (Jedis jedis = pool.getResource()) {
                jedis.del(CacheKeys.deviceHeartbeat(deviceId));
            }
        }
    }

    /**
     * 定稿消息 100 条热滑窗实现内部类。
     */
    private final class Messages implements MessageStorePort {
        @Override
        public void save(Message message) {
            String key = CacheKeys.messages(message.conversationId());
            try (Jedis jedis = pool.getResource()) {
                jedis.zadd(key, message.sequence(), json.writeValueAsString(message));
                // 原子移除滑窗容量之外的老旧消息，保持窗口尺寸最大为 100
                jedis.zremrangeByRank(key, 0, CacheKeys.trimUntilRank(CacheKeys.MESSAGE_LIMIT));
                jedis.expire(key, CacheKeys.MESSAGE_TTL_SECONDS);
            }
        }

        @Override
        public Optional<Message> find(String workspaceId, String messageId) {
            return search == null ? Optional.empty() : search.findMessage(workspaceId, messageId);
        }

        @Override
        public List<Message> recent(String conversationId, int limit) {
            if (limit <= 0) {
                return List.of();
            }
            try (Jedis jedis = pool.getResource()) {
                List<String> raw = jedis.zrevrange(CacheKeys.messages(conversationId), 0, limit - 1L);
                if (raw == null || raw.isEmpty()) {
                    return List.of();
                }
                return raw.stream().map(item -> json.readValue(item, Message.class)).toList();
            }
        }

        @Override
        public List<Message> after(String workspaceId, String conversationId, long afterSequence, int limit) {
            if (limit <= 0) {
                return List.of();
            }
            // 热窗优先：窗口覆盖区间（最老序号 <= afterSequence+1）即整段可信；
            // 否则说明窗口下沿有淘汰缺段，直接回源 ES 保证完整性
            try (Jedis jedis = pool.getResource()) {
                String key = CacheKeys.messages(conversationId);
                Long oldest = null;
                var range = jedis.zrangeWithScores(key, 0, 0);
                if (range != null && !range.isEmpty()) {
                    oldest = (long) range.getFirst().getScore();
                }
                if (oldest != null && oldest <= afterSequence + 1) {
                    List<String> raw = jedis.zrangeByScore(key, String.valueOf(afterSequence + 1), "+inf", 0, limit);
                    return raw.stream().map(item -> json.readValue(item, Message.class)).toList();
                }
            }
            return search == null ? List.of() : search.listAfter(workspaceId, conversationId, afterSequence, limit);
        }
    }

    private Receipt read(String raw) {
        return raw == null ? null : json.readValue(raw, Receipt.class);
    }

    private record Receipt(String bodySha256, String responseJson) {}
}
