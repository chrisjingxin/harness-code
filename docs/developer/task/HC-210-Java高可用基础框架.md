---
id: HC-210
title: Java高可用基础框架
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P0
status: 待认领
owner: 未认领
branch: -
scope: 基于标准 Spring Boot 4.0.6、DDD 四层架构与 TDSQL、Redis、Kafka、ES 7.6.0 重构 Java 协作服务端，落地 Electron Daemon Push 定稿消息模型、TDSQL 零分表精简状态表、MyBatis-Plus 持久层与完整 JUnit 5 单元测试体系。
acceptance: 11 项指定技术栈版本对齐；改造为标准 @SpringBootApplication 工程并支持 application.yml 自动装配；严格遵循 DDD 四层架构；TDSQL 不存海量消息与事件流水表，Message 全量经 Redis 热滑窗与 Kafka 落入 ES 7.6.0；SSE 与 Daemon 指令改为事件驱动推送；新增 src/test/java 完整单元测试并全部通过。
user_docs: 实现阶段按需同步更新服务部署与中间件配置说明；当前不改变桌面端用户操作入口
developer_docs: docs/developer/architecture/多人协作工作台顶层设计.md；docs/developer/spec/HC-210-Java高可用基础框架.md；docs/developer/plan/HC-210-Java高可用基础框架.md；docs/developer/todo/HC-210-Java高可用基础框架.md
test_evidence: 2026-11-11 完成 Code Review 8 项问题（2 Critical + 6 Required）闭环修复；mvn test package 30 个 JUnit 5 单元测试全部通过；server:contracts 69 例契约自检通过；check:boundaries --self-check 与 project:check 全部通过；隔离 MySQL 8.4 上 smoke-identity 14 项与 smoke-conversations 15 项通过。
references: docs/developer/task/HC-192-协作工作台与会话交接.md；docs/developer/task/HC-198-会话交接与内容引用.md
completed_at: -
---

# HC-210 Java高可用基础框架

## 现状痛点与解决思路

### 1. 现状痛点
现有 `services/collaboration-server`（HC-194～196 初版实现）为单机原型设计，在面向真实 AI Coding Agent 高频协作场景时存在五大架构瓶颈：
- **流式写放大与单表爆炸**：AI 模型流式输出期间，现有逻辑对每个分片执行全量 `UPDATE wb_message` 并向 `wb_execution_event`、`wb_execution_receipt` 插入碎片记录；同时 `wb_execution`、`wb_request_receipt` 随对话轮次无限堆积大量 `MEDIUMTEXT` 报文，极易导致单表千万行级膨胀。
- **高频数据库轮询拖垮连接池**：`ConversationStreamService` 对每个打开的 SSE 连接每 `200ms` 开启事务执行 3 条 SQL；`ExecutionDispatcher` 每 `1000ms` 单线程扫库轮询待派发任务。
- **单机内存孤岛，无法水平扩容**：登录态 `HttpSession`、CSRF Token 与设备在线状态 `DevicePresence`（`ConcurrentHashMap`）均锁死在单台 JVM 内存中，多实例部署时会出现跨节点鉴权失效与 WebSocket 指令无法下发。
- **全量手写 `JdbcTemplate` 长 SQL，缺少清晰分层**：业务规则、SQL 拼接与传输控制混杂，缺乏标准的 DDD 领域分层与 ORM 支撑。
- **非标准 Spring Boot 工程形态且无单元测试**：启动类未使用标准 `@SpringBootApplication`，所有组件在配置类中手工 `new` 拼装，未利用 Spring Boot 标准依赖注入（`@Service` / `@Repository` / `@RestController` / `@MapperScan` / `@ConfigurationProperties`）与 `application.yml` 自动装配，无法在 IDE 中直接按标准 Spring Boot 方式启动调试；且完全缺少 `src/test/java` 单元测试。
- **缺少全文检索引擎**：跨会话、跨消息的 `@` 内容引用检索若依赖 MySQL `LIKE '%keyword%'` 模糊扫描，在高并发下会迅速耗尽数据库连接。

### 2. 核心解决思路（端云协同 + 四大中间件 + DDD 四层架构）
1. **端云职责重塑（Electron Daemon Push 模型）**：
   - Electron 客户端作为本机 Daemon 服务，在本地运行 ACP Agent 并 **100% 在客户端内存处理流式渲染**；
   - 等模型**真正产出完整定稿消息（或执行终态）后，由 Electron Daemon 主动异步 Push 到远端 Java 服务**。Java 服务端彻底告别流式 Token 碎片拼接与高频 `UPDATE`。
2. **四大中间件存算分离（TDSQL 零分表、永不爆表）**：
   - **TDSQL（MySQL 8 模拟）**：**彻底移除 `wb_message`、`wb_execution_event`、`wb_execution`、`wb_request_receipt`、`wb_outbox_event` 等海量膨胀流水表**！只保留高价值的**控制面与协作契约小表**（账号 `wb_user`、工作区 `wb_workspace`、成员 `wb_workspace_member`、设备 `wb_device`、共享项目 `wb_device_project`、会话头 `wb_conversation`、以及 [HC-198](./HC-198-会话交接与内容引用.md) 的交接单 `wb_handoff` 和正式引用快照 `wb_message_reference`）。所有表采用自增 `BIGINT UNSIGNED` 物理聚簇主键 + 业务 UUID 唯一索引，无需任何 MySQL 分库分表即可长期稳定运行。
   - **Redis（Spring Data Redis + Jedis）**：承接所有带 TTL 的分布式热状态——分布式登录 Session/CSRF、成员权限热缓存、全局 Electron Daemon 在线路由表（`wb:daemon:presence:{deviceId}`）、1 小时请求幂等防重（替代 `wb_request_receipt`）、当前活跃执行状态（替代 `wb_execution` 热态）、发送前的临时引用草稿（替代 `wb_reference_draft`），以及**活跃会话最近 100 条定稿消息热滑窗（`wb:conv:msgs:{conversationId}`，消除 ES 1s 刷新延迟，保障打开会话 `< 1ms` 零延迟读取）**。
   - **Kafka**：作为高可靠异步事件与指令总动脉——承接 Daemon Push 定稿消息削峰填谷异步入 ES、驱动跨节点 SSE 实时广播（`wb.conversation.events`，彻底取代 200ms 数据库轮询）、驱动跨节点向目标 Daemon 下发执行/取消指令（`wb.daemon.commands`，彻底取代 1000ms 扫库轮询）。
   - **Elasticsearch 7.6.0**：作为**全量定稿 Message 的持久化分片存储与全文检索引擎**（`wb_message_v1` 与 `wb_conversation_handoff_v1`，统一设置 `_routing = workspaceId` 单分片路由与 `rest_total_hits_as_int=true` 兼容参数），同时承接：
     - 超过 Redis 热滑窗（100 条以前）的历史消息翻页拉取；
     - 单条消息 `GET /_doc/{messageId}` 实时 Translog 0 延迟点查；
     - 同工作区跨会话、跨消息、跨交接单的毫秒级 `@` 引用全文检索与高亮摘要。
3. **严格遵循 DDD 四层架构**：
   - 按照 `interfaces`（用户接口层）→ `application`（应用编排层）→ `domain`（纯净领域层，零框架污染）→ `infrastructure`（基础设施与四大中间件实现层）重构 `services/collaboration-server` 目录结构。

---

## 技术栈与依赖版本锁定（11 项硬性指标）

`services/collaboration-server/pom.xml` 统一锁定以下组件与精确版本：

| 序号 | 组件领域 | Maven 坐标 (`groupId:artifactId`) | 锁定版本 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **Spring Boot** | `org.springframework.boot:spring-boot-starter-parent` | **`4.0.6`** | 统一管控 WebMVC、Security、JDBC、WebSocket 等 Starter |
| 2 | **ORM 框架** | `com.baomidou:mybatis-plus-spring-boot4-starter`<br>`org.mybatis:mybatis` | **`3.5.16`**<br>**`3.5.19`** | 全面替代手写 `JdbcTemplate`，映射 TDSQL 核心状态小表 |
| 3 | **连接池** | `com.zaxxer:HikariCP` | **`7.0.2`** | 高性能 JDBC 连接池，开启 MySQL 预编译缓存 |
| 4 | **日志实现** | `org.apache.logging.log4j:log4j-bom`<br>`org.springframework.boot:spring-boot-starter-log4j2` | **`2.25.4`** | 全局排除 `spring-boot-starter-logging` (Logback) 与 `log4j-to-slf4j` |
| 5 | **日志门面** | `org.slf4j:slf4j-api` | **`2.0.17`** | 配合 MDC 贯穿 `requestId` 结构化安全日志 |
| 6 | **JSON 引擎** | `com.fasterxml.jackson:jackson-bom` | **`2.21.2`** | 统一序列化、Redis/Kafka 编解码与 ES 文档映射 |
| 7 | **契约校验** | `com.networknt:json-schema-validator` | **`3.0.1`** | 校验 HTTP/WebSocket 请求与平台契约 Schema |
| 8 | **Redis 缓存** | `org.springframework.boot:spring-boot-starter-data-redis`<br>`redis.clients:jedis` | **`4.0.6`**<br>**`4.4.8`** | 排除默认 Lettuce，使用 Jedis 连接池管理分布式状态与热滑窗 |
| 9 | **消息队列** | `org.springframework.boot:spring-boot-starter-kafka`<br>`org.apache.kafka:kafka-clients` | **`4.0.6`**<br>**`4.1.2`** | 驱动跨节点 SSE 推送、Daemon 指令路由与 ES 异步批量索引 |
| 10 | **HTTP 客户端** | `com.squareup.okhttp3:okhttp` | **`4.12.0`** | 统一出站 HTTP 连接池与 ES REST 通讯 |
| 11 | **全文检索** | `org.elasticsearch:elasticsearch`<br>`org.elasticsearch.client:elasticsearch-rest-high-level-client`<br>`co.elastic.clients:elasticsearch-java` | **`6.6.1`**<br>**`6.6.1`**<br>**`8.19.16`** | 对接服务端 **Elasticsearch `7.6.0`**（带 `_routing=workspaceId` 与 `rest_total_hits_as_int=true`） |

---

## DDD 四层架构与模块范围

1. **`interfaces`（用户接口层）**：
   - `rest`：`IdentityController`、`DeviceController`（含 Electron Daemon Push 完整定稿消息接口）、`ConversationController`（后续由 [HC-198](./HC-198-会话交接与内容引用.md) 扩展 `HandoffController` 与 `ReferenceController`）；
   - `stream`：`ConversationSseController`（事件驱动 SSE）、`DaemonWebSocketHandler`（Daemon 指令与心跳通道）；
   - `consumer`：`ConversationEventKafkaListener`、`DaemonCommandKafkaListener`、`MessageIndexKafkaListener`；
   - `filter`、`dto`、`assembler`：安全边界过滤、契约校验与 DTO 转换。
2. **`application`（应用层）**：
   - `IdentityAppService`、`DaemonSyncAppService`、`ConversationAppService`；
   - 负责事务编排、Redis 幂等拦截（`IdempotencyGuard`）、跨领域协调与 Kafka 事件发布。
3. **`domain`（领域层）**：
   - 纯粹 Java 领域模型，零中间件注解污染；
   - 包含 `identity`、`device`、`conversation`、`execution`（及后续 [HC-198](./HC-198-会话交接与内容引用.md) 的 `handoff`、`reference`）聚合根、实体、值对象、领域服务与仓储/端口接口（`*Repository`、`MessageStorePort`、`DaemonPresencePort`、`EventBusPort`）。
4. **`infrastructure`（基础设施层）**：
   - `persistence`：基于 MyBatis-Plus `3.5.16` 的 `*PO`、`*Mapper`、`*Converter` 与 TDSQL 仓储实现；
   - `cache`：基于 Jedis `4.4.8` 的分布式 Session、Daemon 在线路由表、1h 请求幂等池、当前活跃执行状态与会话最近 100 条热消息滑窗实现；
   - `messaging`：基于 Kafka `4.1.2` 的事件总线与跨节点指令路由实现；
   - `search`：基于 ES `7.6.0` 的定稿消息全量存储、翻页查询与全文检索实现（含超时熔断保护）。

---

## 依赖与推进顺序

- 本任务属于 [HC-192 总任务](./HC-192-协作工作台与会话交接.md) 下新增的 Java 服务端底座重构任务，优先于 [HC-198 会话交接与内容引用](./HC-198-会话交接与内容引用.md) 实施。
- `HC-210` 完成后，[HC-198](./HC-198-会话交接与内容引用.md) 直接在 DDD 四层结构上新增 `handoff` 与 `reference` 领域包、TDSQL `wb_handoff` / `wb_message_reference` 表、Redis 引用草稿缓存与 ES `7.6.0` 引用检索。
- 继续遵守 [协作任务并行开发约定](../project/协作任务并行开发约定.md#0-当前调度等待同事交付-acp2026-11-10) 第 0 节：本任务不涉及 ACP 协议改动。

---

## 验收标准（可观察结果）

- [x] **标准 Spring Boot 工程形态**：改造为标准 `@SpringBootApplication` + `@MapperScan` + `@ConfigurationPropertiesScan` 工程，使用标准 Spring 注解（`@RestController`、`@Service`、`@Repository`、`@Configuration`）与 `application.yml` 自动装配，支持直接运行 `Application.main()` 启动 Web 服务，同时兼容 CLI 命令（`migrate / init-demo / contracts / start`）。
- [x] **依赖版本与构建**：`services/collaboration-server/pom.xml` 精确对齐上述 11 项依赖版本，排除 Logback 与 Lettuce 冲突，`mvn test package` 构建与契约自检通过。
- [x] **DDD 四层包结构**：Java 源码按 `interfaces`、`application`、`domain`、`infrastructure` 四层组织，`domain` 层不直接引用 MyBatis-Plus、Jedis、Kafka、ES 或 Servlet 类。
- [x] **TDSQL 零分表防爆表结构**：Flyway 迁移脚本重构完成，TDSQL 仅保留身份、工作区、设备、项目、会话头（`wb_conversation`）等轻量状态表（自增 `BIGINT` 物理主键 + 业务 UUID 唯一索引），不含 `wb_message`、`wb_execution_event`、`wb_execution`、`wb_request_receipt`、`wb_outbox_event` 等无限增长流水表。
- [x] **Electron Daemon Push 与消息存算分离**：定稿消息 Push 后同步写入 Redis 热会话滑窗（最近 100 条，打开会话 `< 1ms` 零延迟可见）并经 Kafka 批量持久化至 Elasticsearch `7.6.0`（支持 `_routing = workspaceId` 单分片路由、`_doc/{id}` 实时点查、历史翻页与全文检索）。
- [x] **零轮询实时同步与指令路由**：SSE 订阅通过消费 Kafka `wb.conversation.events` 实时推送，消除 `200ms` 数据库轮询；远端提问与取消通过 Redis 全局设备路由表 + Kafka `wb.daemon.commands` 即时下发至目标 Daemon，消除 `1000ms` 扫库轮询。
- [x] **完整单元测试覆盖（`src/test/java`）**：引入 `spring-boot-starter-test`（JUnit 5 + Mockito + AssertJ + MockMvc），建立覆盖 `domain`、`application`、`infrastructure`、`interfaces` 四层的单元测试套件，构建阶段不再跳过测试（移除 `-DskipTests`），`mvn test` 全部通过。

---

## 后续流程

本 Task 确认后，按 `Spec → Plan → Todo → implement → review` 顺序推进 `HC-210-Java高可用基础框架`，验收通过后再启动 [HC-198 会话交接与内容引用](./HC-198-会话交接与内容引用.md)。

---

## Code Review 结论（2026-11-11）

依据 `code-review-and-quality` 五维审查标准（正确性、可读性与简洁性、架构、安全、性能）及 [HC-210 Spec](../spec/HC-210-Java高可用基础框架.md) 检视当前 `services/collaboration-server` 实现与测试：

### 总体结论：**Approved（初审 2 Critical + 6 Required 已全部修复并通过复验）**

本轮实现已完成标准 `@SpringBootApplication` 改造、[pom.xml](../../../services/collaboration-server/pom.xml) 11 项依赖锁定、Flyway 6 张 `pk_id` 控制面表迁移、MyBatis-Plus 仓储、SSE 零数据库轮询改造以及 12 个测试类（30 个 JUnit 5 用例）。初审发现的 **2 项 Critical（阻断）** 与 **6 项 Required（必改）** 问题已全部闭环修复：

1. **Critical（已修复）— Daemon Push 定稿消息与执行状态闭环，对齐 `runner-core` WebSocket 协议**：
   - 在 [ConversationAppService.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/application/service/ConversationAppService.java) 新增 `recordDaemonPush(...)`，支持接收 Electron Daemon 推送的 Agent 定稿消息（`authorKind="agent"`）与执行状态流转（`accepted / running / succeeded / failed / cancelled / rejected`），落入 `MessageStorePort`（Redis 热滑窗）、广播 `message.created / execution.changed` 至 `EventWindowPort` 与 SSE，并异步投递 `wb.search.index`（ES 7.6.0）。
   - [DaemonWebSocketHandler.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/interfaces/stream/DaemonWebSocketHandler.java) 实现 `SubProtocolCapable`（`workbench.device.v1`），生成 UUID `connectionId`，以 `DeviceEnvelope`（`{connectionId, message}`）包装 `DeviceWelcomeMessage`、`DeviceReadyMessage`、`ExecutionEventsAckMessage` 与下发命令，并在断连/吊销时调用 `presence.remove(deviceId)` 即时驱逐在线状态。
2. **Critical（已修复）— 收窄数据库短事务边界，消除跨网络 I/O 行锁**：
   - [ConversationAppService.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/application/service/ConversationAppService.java) 改为通过 `TransactionTemplate`（`inShortTransaction`）仅在锁读并更新 `wb_conversation` 序号与元数据行时开启短事务；事务提交后再执行 Redis 热窗口写入、SSE 推送、Kafka 发布与 Daemon WebSocket 下发。
3. **Required（已修复）— `cluster` 模式严格 `fail closed`**：
   - [MiddlewareConfig.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/infrastructure/config/MiddlewareConfig.java) 移除 `cluster` 模式下捕获 Redis/Kafka 异常后静默回退单机内存的逻辑，集群中间件不可用时直接失败关闭。
4. **Required（已修复）— 补齐 Redis `MessageStorePort` 读接口与 ES 7.6.0 安全 JSON 查询**：
   - [JedisCollaborationState.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/infrastructure/cache/JedisCollaborationState.java) 实现 `Messages.recent`（`zrevrange` 倒序读取再翻转为正序）与 `Messages.find`（委派 ES 点查）；[ElasticsearchMessageStoreAdapter.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/infrastructure/search/ElasticsearchMessageStoreAdapter.java) 与 [EsMessageRequests.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/infrastructure/search/EsMessageRequests.java) 改用 Jackson `JsonMapper` 构造查询 JSON，支持 `wb_conversation_handoff_v1` 会话索引及游标/关键词检索。
5. **Required（已修复）— `WorkbenchProperties.Pool` 接入 `ServerConfiguration.dataSource`**：
   - [ServerConfiguration.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/infrastructure/config/ServerConfiguration.java) 已读取 [WorkbenchProperties.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/infrastructure/config/WorkbenchProperties.java) 的 `pool` 配置。
6. **Required（已修复）— 补齐 `ExecutionState.commandFingerprint`**：
   - `ConversationAppService.sendInput` 通过 `ExecutionAppService.createStart(...)` 预先生成签名后的 `ExecutionStartMessage`，将 64 位 SHA-256 `bodySha256` 存入 `ExecutionState.commandFingerprint`。
7. **Required（已修复）— 消除 `IdentityRepositoryImpl` 的 `1 + N` 查询**：
   - [IdentityRepositoryImpl.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/infrastructure/persistence/IdentityRepositoryImpl.java) 的 `listWorkspacesForUser` 与 `listMembers` 改为 `IN` 批量查询并保持 `slug / username` 稳定升序与启用过滤。
8. **Required（已修复）— 清理死代码、补齐 `MDC` 日志追踪与修复文档断链**：
   - [BoundaryFilter.java](../../../services/collaboration-server/src/main/java/workbench/collaboration/interfaces/filter/BoundaryFilter.java) 写入并在 `finally` 清理 `MDC.put("requestId", requestId)`；
   - 删除未使用的 `Execution.java`、`ExecutionDecision.java`、`ConversationEvent.java` 及 `.DS_Store`；
   - 更新 `docs/developer/research/198-会话交接与内容引用.md` 与 `199-文件与Git服务迁移.md` 中的新 DDD 类路径链接，`npm run project:check` 通过。
