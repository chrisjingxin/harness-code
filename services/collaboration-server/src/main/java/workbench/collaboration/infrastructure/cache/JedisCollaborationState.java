package workbench.collaboration.infrastructure.cache;

import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.params.SetParams;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.domain.conversation.EventWindowPort;
import workbench.collaboration.domain.conversation.Message;
import workbench.collaboration.domain.conversation.MessageStorePort;
import workbench.collaboration.domain.device.DaemonPresence;
import workbench.collaboration.domain.device.DaemonPresencePort;
import workbench.collaboration.domain.execution.ExecutionState;
import workbench.collaboration.domain.execution.ExecutionStatePort;
import workbench.collaboration.infrastructure.search.ElasticsearchMessageStoreAdapter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 模块：分布式 Redis 协作状态与滑窗实现 (JedisCollaborationState)
 *
 * <p>【功能定义】
 * 集群生产模式下基于 JedisPool 实现的分布式协作状态中心。
 * 全面承接平台五大分布式热态能力，消除数据库写放大与轮询：
 * 1. 1小时请求幂等池 (Idempotency)：采用 Redis 原生 SET key value NX EX 实现分布式互斥占位；
 * 2. 设备实时在线表 (Presence)：采用 Hash 结构存储设备 WebSocket 路由，TTL 45秒心跳自动续期；
 * 3. 活跃执行热快照 (Executions)：以 String 形式存储执行状态，TTL 24小时；
 * 4. 定稿消息热滑窗 (Messages)：采用 ZSet 结构按 sequence 得分存储最近 100 条定稿消息，点查联动 ES 7.6.0；
 * 5. 事件断线补齐滑窗 (Events)：采用 ZSet 结构按 sequence 得分存储最近 200 条事件，支持 (after, through] 开闭区间查询。
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
    private final Presence presence = new Presence();
    private final Executions executions = new Executions();
    private final Messages messages = new Messages();
    private final Events events = new Events();

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

    public DaemonPresencePort presence() {
        return presence;
    }

    public ExecutionStatePort executions() {
        return executions;
    }

    public MessageStorePort messages() {
        return messages;
    }

    public EventWindowPort events() {
        return events;
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
     * 设备在线路由表实现内部类。
     */
    private final class Presence implements DaemonPresencePort {
        @Override
        public void save(DaemonPresence value) {
            String key = CacheKeys.presence(value.deviceId());
            try (Jedis jedis = pool.getResource()) {
                jedis.hset(key, Map.of(
                        "nodeId", value.nodeId(),
                        "connectionId", value.connectionId(),
                        "state", value.state(),
                        "lastSeenMs", Long.toString(value.lastSeenMs())
                ));
                jedis.expire(key, CacheKeys.PRESENCE_TTL_SECONDS);
            }
        }

        @Override
        public Optional<DaemonPresence> find(String deviceId) {
            try (Jedis jedis = pool.getResource()) {
                Map<String, String> fields = jedis.hgetAll(CacheKeys.presence(deviceId));
                if (fields == null || fields.isEmpty()) {
                    return Optional.empty();
                }
                return Optional.of(new DaemonPresence(
                        deviceId,
                        fields.get("nodeId"),
                        fields.get("connectionId"),
                        fields.get("state"),
                        Long.parseLong(fields.get("lastSeenMs"))
                ));
            }
        }

        @Override
        public void remove(String deviceId) {
            try (Jedis jedis = pool.getResource()) {
                jedis.del(CacheKeys.presence(deviceId));
            }
        }
    }

    /**
     * 活跃执行热快照与来源序号去重内部类。
     */
    private final class Executions implements ExecutionStatePort {
        @Override
        public void save(ExecutionState state) {
            try (Jedis jedis = pool.getResource()) {
                jedis.setex(CacheKeys.execution(state.executionId()), CacheKeys.EXECUTION_TTL_SECONDS, json.writeValueAsString(state));
            }
        }

        @Override
        public Optional<ExecutionState> find(String executionId) {
            try (Jedis jedis = pool.getResource()) {
                String raw = jedis.get(CacheKeys.execution(executionId));
                return raw == null ? Optional.empty() : Optional.of(json.readValue(raw, ExecutionState.class));
            }
        }

        @Override
        public boolean rememberSource(String executionId, long sequence, String fingerprint) {
            String key = CacheKeys.source(executionId, sequence);
            try (Jedis jedis = pool.getResource()) {
                String set = jedis.set(key, fingerprint, SetParams.setParams().nx().ex(CacheKeys.EXECUTION_TTL_SECONDS));
                if ("OK".equals(set)) {
                    return true;
                }
                if (fingerprint.equals(jedis.get(key))) {
                    return false;
                }
                throw new IllegalStateException("来源序号指纹冲突");
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
    }

    /**
     * 会话事件 200 条补齐热滑窗内部类。
     */
    private final class Events implements EventWindowPort {
        @Override
        public void append(String conversationId, long sequence, String eventJson) {
            String key = CacheKeys.events(conversationId);
            try (Jedis jedis = pool.getResource()) {
                jedis.zadd(key, sequence, eventJson);
                jedis.zremrangeByRank(key, 0, CacheKeys.trimUntilRank(CacheKeys.EVENT_LIMIT));
                jedis.expire(key, CacheKeys.EVENT_TTL_SECONDS);
            }
        }

        @Override
        public List<StoredEvent> range(String conversationId, long afterSequence, long throughSequence, int limit) {
            if (limit <= 0 || afterSequence >= throughSequence) {
                return List.of();
            }
            try (Jedis jedis = pool.getResource()) {
                List<String> raw = jedis.zrangeByScore(CacheKeys.events(conversationId), "(" + afterSequence, Double.toString(throughSequence), 0, limit);
                if (raw == null) {
                    return List.of();
                }
                List<StoredEvent> found = new ArrayList<>();
                for (String event : raw) {
                    found.add(new StoredEvent(sequenceOf(event), event));
                }
                return List.copyOf(found);
            }
        }
    }

    private Receipt read(String raw) {
        return raw == null ? null : json.readValue(raw, Receipt.class);
    }

    private long sequenceOf(String eventJson) {
        String value = json.readTree(eventJson).path("sequence").asString();
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    private record Receipt(String bodySha256, String responseJson) {}
}
