package workbench.collaboration.infrastructure.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import tools.jackson.databind.json.JsonMapper;
import workbench.collaboration.application.port.IdempotencyPort;
import workbench.collaboration.application.port.RealtimeBroadcastPort;
import workbench.collaboration.domain.conversation.EventWindowPort;
import workbench.collaboration.domain.conversation.MessageStorePort;
import workbench.collaboration.domain.device.DaemonCommandPort;
import workbench.collaboration.domain.device.DaemonPresencePort;
import workbench.collaboration.domain.execution.ExecutionStatePort;
import workbench.collaboration.infrastructure.cache.JedisCollaborationState;
import workbench.collaboration.infrastructure.cache.MemoryExecutionState;
import workbench.collaboration.infrastructure.cache.MemoryHotWindow;
import workbench.collaboration.infrastructure.cache.MemoryIdempotency;
import workbench.collaboration.infrastructure.cache.MemoryPresence;
import workbench.collaboration.infrastructure.messaging.ConversationEventHub;
import workbench.collaboration.infrastructure.messaging.KafkaEventBus;
import workbench.collaboration.infrastructure.messaging.LocalEventBus;
import workbench.collaboration.infrastructure.search.ElasticsearchMessageStoreAdapter;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 模块：分布式中间件多环境自适应装配配置 (MiddlewareConfig)
 *
 * <p>【功能定义】
 * 根据 workbench.middleware.mode 配置属性，决定加载“进程内内存实现”还是“外部分布式生产中间件”：
 * - standalone 模式：装配 MemoryIdempotency、MemoryPresence、MemoryExecutionState、MemoryHotWindow 与 LocalEventBus，
 *   无需任何外部 Redis/Kafka/ES 即可单机极速启动，保障开发与测试开箱即用；
 * - cluster 模式：严格装配 JedisPool、KafkaEventBus、ElasticsearchMessageStoreAdapter。
 *   采用 Fail-Closed 策略：启动即对 Redis 进行 ping 连通性探测，失败立即抛出异常阻止启动，严防多节点脑裂与状态孤岛。
 *
 * <p>【心跳保活设计 (Why)】
 * 为 ConversationEventHub 提供一个 20 秒单线程调度器，向处于长连接中的客户端推送纯注释行（comment-line），
 * 防止网关代理或浏览器在长久无事件时因连接空闲超时切断 SSE 管道，整个过程零数据库查询。
 *
 * <p>【协作边界】
 * - 上游调用方：Spring Boot 容器组件装配。
 * - 下游依赖方：JedisPool、KafkaEventBus、ConversationEventHub、ElasticsearchMessageStoreAdapter。
 */
@Configuration
public class MiddlewareConfig {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    @Bean
    LocalEventBus localEventBus() {
        return new LocalEventBus();
    }

    /**
     * 装配实时广播总线：集群模式使用 KafkaEventBus，单机模式使用 LocalEventBus。
     */
    @Bean
    @Primary
    RealtimeBroadcastPort broadcast(LocalEventBus local, WorkbenchProperties properties) {
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
            return new Ports(state.idempotency(), state.presence(), state.executions(), state.messages(), state.events());
        }
        MemoryHotWindow window = new MemoryHotWindow();
        return new Ports(new MemoryIdempotency(), new MemoryPresence(), new MemoryExecutionState(), window, window);
    }

    @Bean
    IdempotencyPort idempotency(Ports ports) {
        return ports.idempotency();
    }

    @Bean
    DaemonPresencePort presence(Ports ports) {
        return ports.presence();
    }

    @Bean
    ExecutionStatePort executionState(Ports ports) {
        return ports.executions();
    }

    @Bean
    MessageStorePort messages(Ports ports) {
        return ports.messages();
    }

    @Bean
    EventWindowPort events(Ports ports) {
        return ports.events();
    }

    /**
     * 装配本地会话事件集线器，将总线事件投递至 SSE 长连接。
     */
    @Bean
    ConversationEventHub conversationEventHub(LocalEventBus local) {
        ConversationEventHub hub = new ConversationEventHub();
        local.onConversation((conversationId, eventJson) ->
                hub.deliver(conversationId, eventJson, Long.parseLong(JSON.readTree(eventJson).path("sequence").asString()))
        );
        return hub;
    }

    @Bean
    ElasticsearchMessageStoreAdapter search(WorkbenchProperties properties) {
        return new ElasticsearchMessageStoreAdapter(properties.getMiddleware().getElasticsearch().getUrl());
    }

    /**
     * 针对无 Web 容器的运维命令（如 migrate），提供空操作的设备指令下发兜底端口。
     */
    @Bean
    @ConditionalOnMissingBean(DaemonCommandPort.class)
    DaemonCommandPort offlineCommands() {
        return (deviceId, commandJson) -> {};
    }

    /**
     * 注册总线事件与指令监听订阅。
     */
    @Bean
    Object listeners(
            LocalEventBus local,
            ElasticsearchMessageStoreAdapter search,
            DaemonCommandPort commands,
            WorkbenchProperties properties
    ) {
        local.onSearch((workspaceId, document) -> {
            if (properties.cluster()) {
                search.index(workspaceId, document);
            }
        });
        local.onDaemon(commands::dispatch);
        return new Object();
    }

    /**
     * 创建 SSE 轻量保活心跳定时任务调度器。
     */
    @Bean(destroyMethod = "shutdownNow")
    ScheduledExecutorService sseHeartbeats(ConversationEventHub hub) {
        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "sse-heartbeat");
            thread.setDaemon(true);
            return thread;
        });
        // 每 20 秒推送一条 SSE 注释行，维持长连接不断开，避免代理网关超时
        scheduler.scheduleAtFixedRate(hub::heartbeat, 20, 20, TimeUnit.SECONDS);
        return scheduler;
    }

    /**
     * 端口聚合载体。
     */
    public record Ports(
            IdempotencyPort idempotency,
            DaemonPresencePort presence,
            ExecutionStatePort executions,
            MessageStorePort messages,
            EventWindowPort events
    ) {}
}
