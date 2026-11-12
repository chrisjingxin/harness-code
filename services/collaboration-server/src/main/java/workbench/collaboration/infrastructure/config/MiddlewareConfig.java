package workbench.collaboration.infrastructure.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.application.port.SearchIndexBus;
import workbench.collaboration.domain.conversation.MessageStorePort;
import workbench.collaboration.domain.device.DeviceHeartbeatPort;
import workbench.collaboration.infrastructure.cache.JedisCollaborationState;
import workbench.collaboration.infrastructure.cache.MemoryDeviceHeartbeat;
import workbench.collaboration.infrastructure.cache.MemoryHotWindow;
import workbench.collaboration.infrastructure.cache.MemoryIdempotency;
import workbench.collaboration.infrastructure.messaging.KafkaEventBus;
import workbench.collaboration.infrastructure.messaging.LocalEventBus;
import workbench.collaboration.infrastructure.search.ElasticsearchMessageStoreAdapter;

/**
 * 模块：分布式中间件多环境自适应装配配置 (MiddlewareConfig)
 *
 * <p>【功能定义】
 * 根据 workbench.middleware.mode 配置属性，决定加载"进程内内存实现"还是"外部分布式生产中间件"：
 * - standalone 模式：装配 MemoryIdempotency、MemoryDeviceHeartbeat、MemoryHotWindow 与 LocalEventBus，
 *   无需任何外部 Redis/Kafka/ES 即可单机极速启动，保障开发与测试开箱即用；
 * - cluster 模式：严格装配 JedisPool、KafkaEventBus、ElasticsearchMessageStoreAdapter。
 *   采用 Fail-Closed 策略：启动即对 Redis 进行 ping 连通性探测，失败立即抛出异常阻止启动，严防多节点脑裂与状态孤岛。
 *
 * <p>【协作边界】
 * - 上游调用方：Spring Boot 容器组件装配。
 * - 下游依赖方：JedisPool、KafkaEventBus、ElasticsearchMessageStoreAdapter。
 */
@Configuration
public class MiddlewareConfig {

    @Bean
    LocalEventBus localEventBus() {
        return new LocalEventBus();
    }

    /**
     * 装配检索索引总线：集群模式使用 KafkaEventBus，单机模式使用 LocalEventBus。
     */
    @Bean
    @Primary
    SearchIndexBus searchIndexBus(LocalEventBus local, WorkbenchProperties properties) {
        if (!properties.cluster()) {
            return local;
        }
        return new KafkaEventBus(
                local,
                properties.getMiddleware().getNodeId(),
                properties.getMiddleware().getKafka().getBootstrapServers()
        );
    }

    /**
     * 依据运行模式装配领域端口实现簇。
     */
    @Bean
    Ports ports(WorkbenchProperties properties, ElasticsearchMessageStoreAdapter search) {
        if (properties.cluster()) {
            JedisPoolConfig config = new JedisPoolConfig();
            config.setMaxTotal(8);
            WorkbenchProperties.Redis redis = properties.getMiddleware().getRedis();
            JedisPool pool = new JedisPool(config, redis.getHost(), redis.getPort(), 300);
            // 启动时立即探测 Redis 连通性（Fail-Closed 原则）
            try (Jedis jedis = pool.getResource()) {
                jedis.ping();
            }
            JedisCollaborationState state = new JedisCollaborationState(pool, search);
            return new Ports(state.idempotency(), state.heartbeats(), state.messages());
        }
        return new Ports(new MemoryIdempotency(), new MemoryDeviceHeartbeat(), new MemoryHotWindow());
    }

    @Bean
    IdempotencyPort idempotency(Ports ports) {
        return ports.idempotency();
    }

    @Bean
    DeviceHeartbeatPort deviceHeartbeats(Ports ports) {
        return ports.heartbeats();
    }

    @Bean
    MessageStorePort messages(Ports ports) {
        return ports.messages();
    }

    @Bean
    ElasticsearchMessageStoreAdapter search(WorkbenchProperties properties) {
        return new ElasticsearchMessageStoreAdapter(properties.getMiddleware().getElasticsearch().getUrl());
    }

    /**
     * 注册检索索引监听订阅：集群模式下总线文档写入 ES（按文档 ID upsert，天然幂等）。
     */
    @Bean
    Object listeners(
            LocalEventBus local,
            ElasticsearchMessageStoreAdapter search,
            WorkbenchProperties properties
    ) {
        local.onSearch((workspaceId, document) -> {
            if (properties.cluster()) {
                search.index(workspaceId, document);
            }
        });
        return new Object();
    }

    /**
     * 端口聚合载体。
     */
    public record Ports(
            IdempotencyPort idempotency,
            DeviceHeartbeatPort heartbeats,
            MessageStorePort messages
    ) {}
}
