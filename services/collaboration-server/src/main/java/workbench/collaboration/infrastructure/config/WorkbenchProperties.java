package workbench.collaboration.infrastructure.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 模块：服务全局运行参数配置属性 (WorkbenchProperties)
 *
 * <p>【功能定义】
 * 对应 application.yml 中 "workbench" 前缀的自定义配置属性。
 * 集中管理命令行启动模式、跨域与安全 Origin、HikariCP 连接池调优参数，
 * 以及 Redis、Kafka、Elasticsearch 等分布式中间件的运行模式（standalone 内存单机 vs cluster 生产集群）。
 *
 * <p>【协作边界】
 * - 上游调用方：Spring Boot @ConfigurationPropertiesScan 自动装配扫描器。
 * - 下游依赖方：ServerConfiguration、WebSecurityConfig、MiddlewareConfig。
 */
@ConfigurationProperties(prefix = "workbench")
public class WorkbenchProperties {

    /** 运行命令：start（默认常驻启动）、contracts（契约自检）、migrate（表结构迁移）、init-demo（演示数据初始化） */
    private String command = "start";

    /** 浏览器允许跨域交互与回调的白名单源（Origin），例如 "http://127.0.0.1:18084" */
    private String origin;

    /** 数据库物理连接池配置 */
    private Pool pool = new Pool();

    /** 分布式中间件运行模式与网络端点配置 */
    private Middleware middleware = new Middleware();

    public String getCommand() {
        return command;
    }

    public void setCommand(String command) {
        this.command = command;
    }

    public String getOrigin() {
        return origin;
    }

    public void setOrigin(String origin) {
        this.origin = origin;
    }

    public Pool getPool() {
        return pool;
    }

    public void setPool(Pool pool) {
        this.pool = pool;
    }

    public Middleware getMiddleware() {
        return middleware;
    }

    public void setMiddleware(Middleware middleware) {
        this.middleware = middleware;
    }

    /**
     * 判断当前是否处于分布式集群模式。
     *
     * @return 若 mode 属性为 "cluster"（忽略大小写）则返回 true，否则为 false（单机内存模式）
     */
    public boolean cluster() {
        return "cluster".equalsIgnoreCase(middleware.getMode());
    }

    /**
     * HikariCP 物理连接池参数配置。
     */
    public static class Pool {
        private int maximumSize = 4;
        private int minimumIdle = 0;
        private long connectionTimeoutMs = 3000;
        private long validationTimeoutMs = 1000;
        private long initializationFailTimeoutMs = 5000;

        public int getMaximumSize() {
            return maximumSize;
        }

        public void setMaximumSize(int maximumSize) {
            this.maximumSize = maximumSize;
        }

        public int getMinimumIdle() {
            return minimumIdle;
        }

        public void setMinimumIdle(int minimumIdle) {
            this.minimumIdle = minimumIdle;
        }

        public long getConnectionTimeoutMs() {
            return connectionTimeoutMs;
        }

        public void setConnectionTimeoutMs(long connectionTimeoutMs) {
            this.connectionTimeoutMs = connectionTimeoutMs;
        }

        public long getValidationTimeoutMs() {
            return validationTimeoutMs;
        }

        public void setValidationTimeoutMs(long validationTimeoutMs) {
            this.validationTimeoutMs = validationTimeoutMs;
        }

        public long getInitializationFailTimeoutMs() {
            return initializationFailTimeoutMs;
        }

        public void setInitializationFailTimeoutMs(long initializationFailTimeoutMs) {
            this.initializationFailTimeoutMs = initializationFailTimeoutMs;
        }
    }

    /**
     * 中间件运行模式配置。
     * standalone：使用 JVM 进程内内存模拟中间件，零外部依赖，极速启动与本地冒烟；
     * cluster：使用外置真实的 Redis、Kafka、Elasticsearch 生产集群。
     */
    public static class Middleware {
        private String mode = "standalone";
        private String nodeId = "local";
        private Redis redis = new Redis();
        private Kafka kafka = new Kafka();
        private Elasticsearch elasticsearch = new Elasticsearch();

        public String getMode() {
            return mode;
        }

        public void setMode(String mode) {
            this.mode = mode;
        }

        public String getNodeId() {
            return nodeId;
        }

        public void setNodeId(String nodeId) {
            this.nodeId = nodeId;
        }

        public Redis getRedis() {
            return redis;
        }

        public void setRedis(Redis redis) {
            this.redis = redis;
        }

        public Kafka getKafka() {
            return kafka;
        }

        public void setKafka(Kafka kafka) {
            this.kafka = kafka;
        }

        public Elasticsearch getElasticsearch() {
            return elasticsearch;
        }

        public void setElasticsearch(Elasticsearch elasticsearch) {
            this.elasticsearch = elasticsearch;
        }
    }

    public static class Redis {
        private String host = "127.0.0.1";
        private int port = 6379;

        public String getHost() {
            return host;
        }

        public void setHost(String host) {
            this.host = host;
        }

        public int getPort() {
            return port;
        }

        public void setPort(int port) {
            this.port = port;
        }
    }

    public static class Kafka {
        private String bootstrapServers = "127.0.0.1:9092";

        public String getBootstrapServers() {
            return bootstrapServers;
        }

        public void setBootstrapServers(String bootstrapServers) {
            this.bootstrapServers = bootstrapServers;
        }
    }

    public static class Elasticsearch {
        private String url = "http://127.0.0.1:9200";

        public String getUrl() {
            return url;
        }

        public void setUrl(String url) {
            this.url = url;
        }
    }
}
