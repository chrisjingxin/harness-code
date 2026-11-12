package workbench.collaboration.infrastructure.cache;

/**
 * 模块：分布式缓存与热滑窗键模式常量 (CacheKeys)
 *
 * <p>【功能定义】
 * 统一定义协作中继服务在 Redis（及单机内存映射）中所使用的命名空间键规范、容量上限及过期生存时间 (TTL)。
 * 保证单机内存模式（Memory*）与生产 Redis 集群模式（Jedis*）在数据结构与容量语义上完全对齐。
 *
 * <p>【协作边界】
 * - 上游调用方：JedisCollaborationState、MemoryIdempotency、MemoryPresence、MemoryExecutionState、MemoryHotWindow。
 * - 下游依赖方：无外部依赖。
 */
public final class CacheKeys {

    /** 活跃会话最近定稿消息热滑窗容量（保留最近 100 条） */
    public static final int MESSAGE_LIMIT = 100;

    /** 活跃会话最近事件补齐热滑窗容量（保留最近 200 条） */
    public static final int EVENT_LIMIT = 200;

    /** 请求幂等占位与响应回执 TTL（1 小时，3600 秒） */
    public static final int IDEMPOTENCY_TTL_SECONDS = 3600;

    /** 设备 WebSocket 在线心跳租期（45 秒，超时未收到心跳即判为离线） */
    public static final int PRESENCE_TTL_SECONDS = 45;

    /** 活跃执行状态热快照保留时间（24 小时） */
    public static final int EXECUTION_TTL_SECONDS = 24 * 3600;

    /** 会话定稿消息 Redis ZSet 热滑窗 TTL（7 天，超期由 ES 承接历史翻页） */
    public static final int MESSAGE_TTL_SECONDS = 7 * 24 * 3600;

    /** 会话事件 Redis ZSet 热滑窗 TTL（24 小时，满足离线一天内的断线重连补齐） */
    public static final int EVENT_TTL_SECONDS = 24 * 3600;

    private CacheKeys() {}

    /**
     * 生成请求幂等键：wb:idemp:{workspaceId}:{actorId}:{operation}:{requestId}
     */
    public static String idempotency(String workspaceId, String actorId, String operation, String requestId) {
        return "wb:idemp:" + workspaceId + ":" + actorId + ":" + operation + ":" + requestId;
    }

    /**
     * 生成设备在线路由表键：wb:daemon:presence:{deviceId}
     */
    public static String presence(String deviceId) {
        return "wb:daemon:presence:" + deviceId;
    }

    /**
     * 生成活跃执行状态快照键：wb:exec:state:{executionId}
     */
    public static String execution(String executionId) {
        return "wb:exec:state:" + executionId;
    }

    /**
     * 生成 Daemon 来源事件序号防重指纹键：wb:exec:source:{executionId}:{sequence}
     */
    public static String source(String executionId, long sequence) {
        return "wb:exec:source:" + executionId + ":" + sequence;
    }

    /**
     * 生成活跃会话定稿消息 ZSet 滑窗键：wb:conv:msgs:{conversationId}
     */
    public static String messages(String conversationId) {
        return "wb:conv:msgs:" + conversationId;
    }

    /**
     * 生成活跃会话事件 ZSet 滑窗键：wb:conv:events:{conversationId}
     */
    public static String events(String conversationId) {
        return "wb:conv:events:" + conversationId;
    }

    /**
     * 计算 Redis ZSet 修剪老旧元素时的结束名次。
     *
     * <p>【算法动机 (Why)】
     * 当需要保留得分最高（最新序号）的 limit 条时，执行 ZREMRANGEBYRANK key 0 -(limit + 1)，
     * 即可原子剔除所有排名在倒数第 limit 条之前的老数据。
     *
     * @param limit 期望保留的最高分条数
     * @return ZREMRANGEBYRANK 所需的负数结束名次
     */
    public static long trimUntilRank(int limit) {
        return -(limit + 1L);
    }
}
