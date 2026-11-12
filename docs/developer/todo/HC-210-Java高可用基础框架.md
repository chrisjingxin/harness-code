# HC-210 Java高可用基础框架：执行清单

入口：[Task](../task/HC-210-Java高可用基础框架.md)、[Spec](../spec/HC-210-Java高可用基础框架.md)、[Plan](../plan/HC-210-Java高可用基础框架.md)。

---

## 停点一：标准 Spring Boot 工程改造、11 项依赖升级、DDD 四层骨架与 TDSQL 零爆表持久层就绪

**观察方式**：执行 `mvn test package`（或 `npm run server:build`）、`npm run server:contracts`、在隔离 MySQL 上执行 `migrate` 与 `init-demo`，确认标准 `@SpringBootApplication` 启动正常、11 项依赖版本无冲突、DDD 四层目录结构就绪、数据库仅建 6 张带自增物理主键 `pk_id` 的核心表且停点一 JUnit 5 单元测试全部通过。

### A. 标准 Spring Boot 改造、Maven 依赖锁定与日志配置
- [x] 更新 `services/collaboration-server/pom.xml`：升级 `spring-boot-starter-parent` 至 `4.0.6`，锁定 `mybatis-plus-spring-boot4-starter:3.5.16`、`mybatis:3.5.19`、`HikariCP:7.0.2`、`log4j-bom:2.25.4`、`slf4j-api:2.0.17`、`jackson-bom:2.21.2`、`json-schema-validator:3.0.1`、`spring-boot-starter-data-redis:4.0.6` + `jedis:4.4.8`、`spring-boot-starter-kafka:4.0.6` + `kafka-clients:4.1.2`、`okhttp:4.12.0`、`elasticsearch:6.6.1` + `elasticsearch-rest-high-level-client:6.6.1` + `elasticsearch-java:8.19.16`，并引入 `spring-boot-starter-test`。
- [x] 在 `pom.xml` 中全局排除 `spring-boot-starter-logging`、`log4j-to-slf4j` 与 `io.lettuce:lettuce-core`，新增 `src/main/resources/log4j2.xml` 结构化安全日志配置。
- [x] 将 `Application.java` 改造为标准 `@SpringBootApplication` + `@MapperScan` + `@ConfigurationPropertiesScan`，基于 `application.yml` 自动装配 DataSource/MyBatis-Plus/中间件，废除手工 `new` Bean 的非标配置方式，支持 IDE 无参直接启动 Web 服务并兼容 `--workbench.command` CLI 模式。

### B. TDSQL 零分表精简 Schema、MyBatis-Plus 持久层与停点一单元测试
- [x] 重构 `V001__identity_workspace.sql`、`V002__device_project.sql`、`V003__conversation_execution.sql`：仅保留 `wb_user`、`wb_workspace`、`wb_workspace_member`、`wb_device`、`wb_device_project`、`wb_conversation` 6 张表，统一采用 `pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY` 物理主键 + 业务 UUID 唯一索引，移除无限膨胀的消息、执行、事件与回执流水表。
- [x] 按 DDD 四层架构创建 `interfaces`、`application`、`domain`、`infrastructure` 包结构，确保 `domain` 层无任何外部中间件或 ORM 注解依赖。
- [x] 在 `infrastructure.persistence` 下实现 6 张表的 MyBatis-Plus `*PO`、`*Mapper` 与 `@Repository` 仓储实现类，更新 `Foundation` 迁移自检。
- [x] 在 `src/test/java/workbench/collaboration/` 下编写 `domain` 领域模型、`PO <-> Domain` 转换器与 `Contracts` 契约校验的 JUnit 5 单元测试，移除构建脚本中的 `-DskipTests`，验证 `mvn test` 与 `server:build` 通过。

---

## 停点二：Redis 热状态、Kafka 事件驱动总线、ES 7.6.0 消息底座与全量单元测试打通

**观察方式**：运行 `mvn test` 全量单元测试及身份、设备与共享会话冒烟测试，验证 Electron Daemon Push 定稿消息、远端提问、取消执行、1 小时 Redis 幂等防重、最近 100 条热消息滑窗 0 延迟读取、ES `7.6.0` 消息索引与事件驱动 SSE 推送全部正常工作，确认已彻底消除 `200ms` SSE 查库轮询与 `1000ms` 扫库派发轮询。

### A. Redis 分布式状态、Kafka 事件总线与 ES 7.6.0 检索存储
- [x] 在 `infrastructure.cache` 中实现基于 Jedis `4.4.8`（含单机自适应降级）的 `IdempotencyPort`（1h 请求防重）、`DaemonPresencePort`（全局设备在线路由表）、`ExecutionStatePort`（活跃任务状态与来源序号去重）以及会话最近 100 条定稿消息/事件热滑窗。
- [x] 在 `infrastructure.messaging` 中实现 `wb.conversation.events`（驱动多节点 SSE 实时推送）、`wb.daemon.commands`（驱动跨节点 Daemon WebSocket 指令即时下发）与 `wb.search.index`（驱动 ES 异步批量索引）的发布与消费。
- [x] 在 `infrastructure.search` 中实现对接 Elasticsearch `7.6.0` 的 `wb_message_v1` 存储与检索适配器（强制 `_routing = workspaceId` 与 `rest_total_hits_as_int=true`，支持单条 `_doc/{id}` 0 延迟点查、历史翻页与全文检索，内置 800ms 超时熔断保护）。

### B. 应用层用例编排、四层单元测试与端到端冒烟验证
- [x] 在 `application.service` 与 `interfaces` 层基于标准 `@Service` / `@RestController` 完成 `IdentityAppService`、`DeviceAppService`、`ConversationAppService`、`ExecutionAppService` 及事件驱动 `ConversationSseController`（0 数据库轮询）与 `DaemonWebSocketHandler` 装配。
- [x] 在 `src/test/java/workbench/collaboration/` 下补齐 `application`（Mockito 用例编排与幂等测试）、`infrastructure`（Redis 滑窗、Kafka 路由、ES 7.6.0 查询构建与熔断测试）和 `interfaces`（MockMvc 路由边界与认证测试）的 JUnit 5 单元测试，确保 `mvn test` 100% 通过。
- [x] 执行 `npm run server:build`、`npm run server:contracts`、`npm run check:boundaries -- --self-check`、`npm run project:check` 及真实服务冒烟验证，记录验证证据并更新文档。

**停点二验证（2026-11-11，待确认）**

- `npm run server:build`：`Tests run: 30, Failures: 0, Errors: 0, Skipped: 0`，BUILD SUCCESS（23:14:54 +08:00）。测试跑在与冒烟相同的已编译 class 上。覆盖领域状态机、热窗口与幂等、主题路由、ES 查询与 800ms 熔断、应用编排（含 Daemon Push 定稿 Agent 消息与终态闭环）、MockMvc 边界与登录。
- `npm run server:contracts`：退出码 0，engine `java`。
- `npm run check:boundaries -- --self-check`：7 个 workspace 通过，负例夹具通过。
- `npm run project:check`：退出码 0，文档相对链接与边界检查全部通过。
- 真实冒烟：隔离库 `hc210`（`127.0.0.1:33076`），默认 standalone，未连接 Redis、Kafka、Elasticsearch。`server:migrate` 与 `server:init-demo` 成功，schema 停在 003。`http://127.0.0.1:18084` 上 `smoke-identity` 14 项通过；`smoke-conversations` 通过，检查项为 `device-origin-denied`、`device-publish`、`device-and-project-list`、`conversation-list`、`duplicate-query-denied`、`offline-queued`、`concurrent-deduplication`、`different-body-and-target-conflict`、`shared-history-author`、`anonymous-denied`、`history-to-stream`、`last-event-id-reconnect`、`queued-cancel`、`logout-stops-delivery`、`share-revocation-preserves-history`。冒烟结束后 Java 与 MySQL 已停止。

单机用进程内端口。`workbench.middleware.mode=cluster` 才创建 Jedis、Kafka 与 ES 写入。交接索引 `wb_conversation_handoff_v1` 不属于本停点。
