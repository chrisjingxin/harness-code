# HC-210 Java高可用基础框架：实施计划

入口：[Task](../task/HC-210-Java高可用基础框架.md)、[Spec](../spec/HC-210-Java高可用基础框架.md)、[Todo](../todo/HC-210-Java高可用基础框架.md)。

---

## 1. 实施范围与总体原则

本计划将 `services/collaboration-server` 从单机 `JdbcTemplate` + 全表塞 MySQL 原型，一步到位升级为 **DDD 四层架构 + 四大中间件（TDSQL + Redis + Kafka + Elasticsearch 7.6.0）** 的高可用基础框架，并为紧随其后的 [HC-198 会话交接与内容引用](../task/HC-198-会话交接与内容引用.md) 提供直接可用的领域与基础设施底座。

实施遵循以下原则：
1. **单一 canonical 路径，不留旧包袱**：直接将存量代码迁移至 `interfaces`、`application`、`domain`、`infrastructure` 四层结构，删除旧的手写 22 参数 `JdbcTemplate` Store 与 `200ms` 查库轮询 SSE 泵，不保留双写或废弃包装类。
2. **TDSQL 零分表、零流水表**：数据库迁移脚本重构后，TDSQL 仅保留 `wb_user`、`wb_workspace`、`wb_workspace_member`、`wb_device`、`wb_device_project`、`wb_conversation` 6 张小表（物理主键统一为 `pk_id BIGINT UNSIGNED AUTO_INCREMENT`）；海量定稿消息、事件滑窗、活跃执行状态与 1 小时请求幂等回执全部交由 Redis + Kafka + Elasticsearch `7.6.0` 承载。
3. **集群/单机自适应高可用**：通过 Domain Port 抽象，在配置外部 Redis/Kafka/ES `7.6.0` 时直连真实中间件集群；在仅提供隔离 MySQL 的本地冒烟环境（如 `run-identity-smoke.mjs`、`smoke-conversations.mjs`）下自动启用内置高并发组件，确保生产高可用与本地测试零外部依赖兼得。

---

## 2. 停点一：标准 Spring Boot 工程改造、11 项依赖升级、DDD 四层骨架与 TDSQL 零爆表持久层就绪

**可观察结果**：
- `services/collaboration-server` 改造为标准 `@SpringBootApplication` + `@MapperScan` + `@ConfigurationPropertiesScan` 工程，支持 `application.yml` 自动装配与标准 `@RestController/@Service/@Repository` 注入；
- `services/collaboration-server/pom.xml` 完成 11 项指定依赖版本升级及 `spring-boot-starter-test` 引入，`mvn test package`（不再跳过测试）与 `npm run server:contracts` 校验通过，无 Logback/Log4j2 或 Lettuce/Jedis 冲突；
- Java 源码目录按 `interfaces`、`application`、`domain`、`infrastructure` 四层重构完毕，并补齐 `domain` 与 `infrastructure.persistence/contract` 单元测试；
- Flyway 迁移脚本 `V001`～`V003` 与 `Foundation` 校验更新为 6 张精简核心表（含 `pk_id BIGINT UNSIGNED AUTO_INCREMENT` 聚簇主键），MyBatis-Plus Mapper 完成身份、工作区、设备、会话头的 CRUD 映射，`server:migrate` 与 `server:init-demo` 验证通过。

### 实施步骤
1. **升级 `pom.xml`、标准 Spring Boot 启动类与日志配置**：
   - 将 `spring-boot-starter-parent` 升至 `4.0.6`，改造 `Application.java` 为标准 `@SpringBootApplication`；
   - 引入并锁定 `mybatis-plus-spring-boot4-starter:3.5.16`、`mybatis:3.5.19`、`HikariCP:7.0.2`、`log4j-bom:2.25.4`、`slf4j-api:2.0.17`、`jackson-bom:2.21.2`、`json-schema-validator:3.0.1`、`spring-boot-starter-data-redis:4.0.6` + `jedis:4.4.8`、`spring-boot-starter-kafka:4.0.6` + `kafka-clients:4.1.2`、`okhttp:4.12.0`、`elasticsearch:6.6.1` + `elasticsearch-rest-high-level-client:6.6.1` + `elasticsearch-java:8.19.16` 以及测试依赖 `spring-boot-starter-test`；
   - 全局排除 `spring-boot-starter-logging`、`log4j-to-slf4j` 与 `lettuce-core`，新增 `src/main/resources/log4j2.xml` 安全结构化日志配置与 `application.yml` 标准配置绑定。
2. **重构 Flyway 迁移脚本与 `Foundation` 自检**：
   - 更新 `V001__identity_workspace.sql`、`V002__device_project.sql`、`V003__conversation_execution.sql`：为 6 张核心表统一设置 `pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY` 物理主键与业务 `id` 唯一索引；移除 `wb_device_request`、`wb_message`、`wb_execution`、`wb_execution_event`、`wb_execution_receipt`、`wb_request_receipt` 等流水表；
   - 更新 `Foundation` 表清单校验与 `init-demo` 幂等初始化逻辑。
3. **搭建 DDD 四层结构、MyBatis-Plus 持久层与停点一单元测试**：
   - 建立 `domain.identity`、`domain.device`、`domain.conversation`、`domain.execution` 的领域模型与 Repository/Port 接口；
   - 在 `infrastructure.persistence` 下创建 6 张表的 `*PO`（带 `@TableName`、`@TableId(type = IdType.AUTO)`）与 MyBatis-Plus `*Mapper extends BaseMapper<*PO>`，采用标准 `@Repository` / `@Service` 注解注入；
   - 在 `src/test/java/workbench/collaboration/` 下编写领域模型、PO 转换器与契约校验器的 JUnit 5 单元测试，并在 `scripts/workbench/server.mjs` 中启用真实测试执行。

---

## 3. 停点二：Redis 热状态、Kafka 事件驱动总线与 ES 7.6.0 消息底座全链路打通

**可观察结果**：
- Electron Daemon Push 定稿消息、用户发送提问、取消执行、历史查询与 SSE 实时订阅在 DDD 四层架构下全部接通；
- `ConversationStreamService` 不再存在 `200ms` 数据库轮询定时器，改为由 `wb.conversation.events` 事件实时驱动推送；
- `ExecutionDispatcher` 改为由 `wb.daemon.commands` 事件实时触发派发；
- 定稿消息与事件通过 Redis 热滑窗（最近 100 条 0 延迟读取）+ Kafka + Elasticsearch `7.6.0`（`_routing=workspaceId` + `rest_total_hits_as_int=true`）完成存取；
- 既有身份冒烟与共享会话/设备冒烟检查全部通过。

### 实施步骤
1. **实现 Redis 分布式状态与热滑窗适配器（`infrastructure.cache`）**：
   - 实现 `IdempotencyPort`：基于 `wb:idemp:{workspaceId}:{actorId}:{op}:{reqId}`（TTL 1h）实现请求防重与响应重放；
   - 实现 `DaemonPresencePort`：基于 `wb:daemon:presence:{deviceId}`（TTL 45s）维护全局设备在线状态与所在节点路由；
   - 实现 `ExecutionStatePort`：管理活跃任务状态、命令快照与 Daemon Push 来源序号去重；
   - 实现会话最近 100 条定稿消息热滑窗（`wb:conv:msgs:{conversationId}`）与事件滑窗（`wb:conv:events:{conversationId}`）。
2. **实现 Kafka 事件总线与 ES 7.6.0 消息存储/检索适配器（`infrastructure.messaging` & `infrastructure.search`）**：
   - 实现 `wb.conversation.events`、`wb.daemon.commands`、`wb.search.index` 的发布与消费监听；
   - 实现 `ElasticsearchMessageStoreAdapter`（使用 `OkHttp 4.12.0` / ES 客户端访问 ES `7.6.0` 的 `wb_message_v1` 索引，强制 `_routing = workspaceId` 与 `rest_total_hits_as_int=true`，并提供 800ms 超时熔断保护）。
3. **重构应用层与接口层（`application` & `interfaces`）并补齐完整单元测试**：
   - 实现 `IdentityAppService`、`DeviceAppService`、`ConversationAppService`、`ExecutionAppService`；
   - 重写事件驱动的 `ConversationSseController` / `ConversationEventHub`（连接建立时从热滑窗补齐历史，驻留期间由事件总线直接推送内存 `SseEmitter`）；
   - 补齐 `application` 用例服务（Mockito）、`infrastructure`（Redis 幂等/热滑窗、Kafka 事件路由、ES `7.6.0` 查询构建与熔断降级）与 `interfaces`（MockMvc 控制器与安全边界过滤）的 JUnit 5 单元测试；
   - 运行 `mvn test package`、契约检查与 HTTP/SSE/WebSocket 真实链路冒烟验证。
