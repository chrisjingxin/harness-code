# HC-210 Java高可用基础框架：行为规格与技术契约

入口：[Task](../task/archive/HC-210-Java高可用基础框架.md)、[Plan](../plan/HC-210-Java高可用基础框架.md)、[Todo](../todo/HC-210-Java高可用基础框架.md)。

---

## 1. 背景、定位与核心架构不变量

### 1.1 现状问题与重构目标
初版 `services/collaboration-server` 在单机 MySQL 上混合存储了会话状态、流式 Token 增量、执行队列、SSE 事件流与请求幂等回执，并通过 `200ms` 数据库轮询驱动 SSE、`1000ms` 单线程扫库驱动派发。在 AI Coding Agent 高频输出与多实例部署场景下，该设计会导致单表千万行级膨胀、连接池耗尽以及多节点内存状态割裂。

本规格将 Java 协作服务端重构为**基于 DDD 四层架构与四大中间件（TDSQL + Redis + Kafka + Elasticsearch 7.6.0）的无状态高可用云端协作中枢**，作为后续 [HC-198 会话交接与内容引用](../task/HC-198-会话交接与内容引用.md) 及全平台协作能力的统一底座。

### 1.2 五条核心架构不变量（Invariants）
1. **端云流式分离（Electron Daemon Push 模型）**：
   - 模型执行与高频流式 Token 渲染 100% 在 Electron 客户端（本机 Daemon）闭环完成；
   - 仅当模型**真正产出完整定稿消息（或任务达到生命周期节点）时**，由 Electron Daemon 主动异步 Push 到远端 Java 服务；Java 服务端不存储、不拼接任何半成品流式 Token 碎片。
2. **TDSQL 零分表、零流水表（彻底杜绝单表爆炸）**：
   - TDSQL（MySQL 8）**只存核心资产、控制面状态头与协作契约小表**（`wb_user`、`wb_workspace`、`wb_workspace_member`、`wb_device`、`wb_device_project`、`wb_conversation`，以及 [HC-198](../task/HC-198-会话交接与内容引用.md) 的 `wb_handoff` 与 `wb_message_reference`）；
   - **彻底移除** `wb_message`、`wb_execution_event`、`wb_execution`、`wb_execution_receipt`、`wb_request_receipt`、`wb_outbox_event` 等随消息量/请求量无限增长的流水表；
   - 所有 TDSQL 表统一采用 `pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY` 作为 InnoDB 物理聚簇主键（100% 顺序追加写磁盘，0 随机页分裂），业务 UUID 通过唯一索引 `uk_*_id` 约束。
3. **海量定稿消息存算分离（Redis 热滑窗 + Kafka + ES 7.6.0 全量底座）**：
   - 定稿消息写入时同步进入 **Redis 会话热滑窗（保留最近 100 条，TTL 7 天）** 并投递 **Kafka** 异步批量写入 **Elasticsearch 7.6.0（`wb_message_v1` 索引）**；
   - 打开会话默认读 Redis 热滑窗（`< 1ms` 零延迟，规避 ES 1s `refresh_interval` 延迟）；向上翻阅超过 100 条的历史消息或跨会话搜索时查 ES `7.6.0`；按消息 ID 单条点查走 Redis 或 ES Realtime GET（`/_doc/{id}`，读取 ES Translog 零延迟）。
4. **事件驱动取代数据库轮询**：
   - 会话 SSE 实时流由消费 Kafka `wb.conversation.events` 直接触发内存推送，**严禁对每个 SSE 连接启动 `200ms` 数据库轮询**；
   - 远端提问与取消指令通过 Redis 全局设备在线路由表（`wb:daemon:presence:{deviceId}`）+ Kafka `wb.daemon.commands` 实时路由至持有目标 Daemon WebSocket 的 Java 节点，**严禁靠单线程 `1000ms` 轮询数据库派发**。
5. **DDD 四层严格依赖倒置（DIP）**：
   - 包结构严格划分为 `interfaces` → `application` → `domain` → `infrastructure`；
   - `domain` 层保持纯 Java 实现，严禁导入 MyBatis-Plus、Jedis、Kafka、Elasticsearch 或 Servlet API；所有中间件访问通过实现 `domain` 层定义的 Repository / Port 接口在 `infrastructure` 层完成。
6. **标准 Spring Boot 工程形态与完整单元测试闭环**：
   - 彻底废除原手工 `new` 拼装全部 Bean 的非标配置方式，改造为标准 `@SpringBootApplication` + `@MapperScan` + `@ConfigurationPropertiesScan` 工程；
   - 使用标准 `application.yml` 配置驱动 DataSource（HikariCP）、MyBatis-Plus、Redis、Kafka、Elasticsearch 与自定义 `WorkbenchProperties`；无参数直接运行 `Application.main()` 默认以 `start` 模式启动标准 Spring Boot Web 服务（支持 IDE 一键 Run/Debug），同时兼容 `--workbench.command=migrate|init-demo|contracts|start` 命令行入口；
   - 引入 `spring-boot-starter-test`（JUnit 5 + Mockito + AssertJ + MockMvc），在 `src/test/java/workbench/collaboration/` 下建立覆盖四层的完整单元测试，构建脚本执行真实 `mvn test`（移除 `-DskipTests`）。

---

## 2. 技术栈与 Maven 依赖版本契约

[`services/collaboration-server/pom.xml`](../../../services/collaboration-server/pom.xml) 必须精确锁定以下 11 项依赖版本并治理传递冲突：

| 序号 | 组件名称 | Maven 坐标 | 锁定版本 | 强制冲突治理规则 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Spring Boot | `org.springframework.boot:spring-boot-starter-parent` | `4.0.6` | 统一管控全部 Spring Boot Starters |
| 2 | MyBatis-Plus & MyBatis | `com.baomidou:mybatis-plus-spring-boot4-starter`<br>`org.mybatis:mybatis` | `3.5.16`<br>`3.5.19` | 在 `<dependencyManagement>` 中显式锁定 `mybatis:3.5.19` |
| 3 | HikariCP | `com.zaxxer:HikariCP` | `7.0.2` | 显式锁定 `7.0.2`，连接池支持预编译语句缓存 |
| 4 | Log4j2 | `org.apache.logging.log4j:log4j-bom`<br>`org.springframework.boot:spring-boot-starter-log4j2` | `2.25.4` | 全局排除 `spring-boot-starter-logging`（Logback）与 `log4j-to-slf4j`，防止 SLF4J 循环绑定 |
| 5 | SLF4J | `org.slf4j:slf4j-api` | `2.0.17` | 统一通过 `log4j-slf4j2-impl:2.25.4` 桥接至 Log4j2 |
| 6 | Jackson | `com.fasterxml.jackson:jackson-bom` | `2.21.2` | 统一管理 `jackson-core`、`jackson-databind`、`jackson-annotations`、`jackson-datatype-jsr310` |
| 7 | JSON Schema Validator | `com.networknt:json-schema-validator` | `3.0.1` | 校验 `packages/workbench-contracts` 下的全部 Schema 与正反例夹具 |
| 8 | Redis & Jedis | `org.springframework.boot:spring-boot-starter-data-redis`<br>`redis.clients:jedis` | `4.0.6`<br>`4.4.8` | 排除 `io.lettuce:lettuce-core`，显式装配 `JedisConnectionFactory` |
| 9 | Kafka | `org.springframework.boot:spring-boot-starter-kafka`<br>`org.apache.kafka:kafka-clients` | `4.0.6`<br>`4.1.2` | 显式锁定 `kafka-clients:4.1.2` |
| 10 | OkHttp | `com.squareup.okhttp3:okhttp` | `4.12.0` | 全局复用的出站 HTTP 客户端与 ES 7.6.0 REST 传输层 |
| 11 | Elasticsearch 客户端 | `org.elasticsearch:elasticsearch`<br>`org.elasticsearch.client:elasticsearch-rest-high-level-client`<br>`co.elastic.clients:elasticsearch-java` | `6.6.1`<br>`6.6.1`<br>`8.19.16` | 排除 `org.elasticsearch` 传递的旧版 `log4j-api`；对接服务端 **ES `7.6.0`** |

---

## 3. DDD 四层工程结构规范

Java 源码根包为 `workbench.collaboration`，严格按以下四层分包：

```text
workbench.collaboration
├── Application.java                        # 显式命令入口：build / migrate / init-demo / start / contracts
├── interfaces                              # 【1. 用户接口层】
│   ├── rest                                # IdentityController, DeviceController, ConversationController, FoundationController
│   ├── stream                              # ConversationSseController, DaemonWebSocketHandler, DaemonHandshakeInterceptor
│   ├── consumer                            # ConversationEventKafkaListener, DaemonCommandKafkaListener, SearchIndexKafkaListener
│   ├── filter                              # BoundaryFilter (RouteCatalog 校验), DemoLoginFilter, ApiExceptionHandler
│   ├── dto                                 # 外部协议请求/响应 DTO (PlatformDtos, DeviceDtos, ConversationDtos, ExecutionDtos)
│   └── assembler                           # DTO <-> Application Command/Query 转换器
├── application                             # 【2. 应用层】
│   ├── service                             # IdentityAppService, DeviceAppService, ConversationAppService, ExecutionAppService
│   ├── command                             # 写用例入参对象
│   ├── query                               # 读用例入参对象
│   └── port                                # 应用级支撑端口 (IdempotencyPort, RealtimeBroadcastPort)
├── domain                                  # 【3. 领域层 (纯 Java，无外部框架依赖)】
│   ├── identity                            # model (User, Workspace, WorkspaceMember) + repository (IdentityRepository)
│   ├── device                              # model (Device, SharedProject, DaemonPresence) + repository (DeviceRepository, DaemonPresencePort, DaemonCommandPort)
│   ├── conversation                        # model (Conversation, Message, ConversationEvent) + repository (ConversationRepository, MessageStorePort)
│   └── execution                           # model (Execution, ExecutionState, ExecutionDecision) + service (ExecutionAuthDomainService) + repository (ExecutionStatePort)
└── infrastructure                          # 【4. 基础设施层】
    ├── config                              # ServerConfiguration, WebSecurityConfig, MybatisPlusConfig, MiddlewareConfig
    ├── persistence                         # MyBatis-Plus PO (*PO.java) + Mapper (*Mapper.java) + Converter + TDSQL Repository 实现
    ├── cache                               # Redis (Jedis 4.4.8) 实现：Session/权限/Daemon在线表/1h幂等回执/活跃Execution/最近100条热消息滑窗
    ├── messaging                           # Kafka (4.1.2) 实现：事件发布、跨节点 SSE 广播与 Daemon 指令路由
    ├── search                              # Elasticsearch 7.6.0 实现：定稿消息索引、Realtime GET 点查、历史翻页与全文检索
    └── contract                            # Contracts (json-schema-validator 3.0.1), Foundation (Flyway 迁移校验), TimeCodec
```

> **多环境高可用自适应契约**：
> - 当配置 `workbench.middleware.mode=cluster`（生产/集群模式）时，装配真实 `JedisConnectionFactory`、`KafkaTemplate` 与 `Elasticsearch 7.6.0` 客户端；
> - 当在未启动外部 Redis/Kafka/ES 进程的隔离单机冒烟环境（默认 `workbench.middleware.mode=standalone` 或连接不可达自动降级）下，基础设施层通过同一组 Domain Port 接口透明提供进程内高并发内存/队列实现，确保既有 `smoke-identity.mjs`、`smoke-conversations.mjs` 等隔离冒烟脚本无需额外部署三套外部守护进程即可 100% 跑通验证。

---

## 4. 四大中间件数据存储契约

### 4.1 TDSQL（MySQL 8）零分表精简 Schema（`V001`～`V003` 重构）

TDSQL 仅保留以下 **6 张基础表**（[HC-198](../task/HC-198-会话交接与内容引用.md) 实施时再在 `V004` 新增 `wb_handoff` 与 `wb_message_reference` 2 张表，全库封顶 8 张小表）：

1. **`wb_user`（用户表）**：
   - `pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`
   - `id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`（`UNIQUE KEY uk_user_id`）
   - `username VARCHAR(32) NOT NULL`（`UNIQUE KEY uk_user_username`）
   - `display_name VARCHAR(80) NOT NULL`, `enabled TINYINT(1) NOT NULL`, `created_at_ms BIGINT NOT NULL`
2. **`wb_workspace`（工作区表）**：
   - `pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`
   - `id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`（`UNIQUE KEY uk_workspace_id`）
   - `slug VARCHAR(40) NOT NULL`（`UNIQUE KEY uk_workspace_slug`）
   - `name VARCHAR(80) NOT NULL`, `created_at_ms BIGINT NOT NULL`
3. **`wb_workspace_member`（工作区成员表）**：
   - `pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`
   - `workspace_id CHAR(36) NOT NULL`, `user_id CHAR(36) NOT NULL`, `created_at_ms BIGINT NOT NULL`
   - `UNIQUE KEY uk_workspace_member (workspace_id, user_id)`，`KEY idx_member_user (user_id, workspace_id)`
4. **`wb_device`（Electron Daemon 设备表）**：
   - `pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`
   - `id CHAR(36) NOT NULL`（`UNIQUE KEY uk_device_id`）
   - `workspace_id CHAR(36) NOT NULL`, `owner_user_id CHAR(36) NOT NULL`
   - `installation_id CHAR(36) NOT NULL`, `ledger_id CHAR(36) NOT NULL`, `name VARCHAR(80) NOT NULL`
   - `secret_sha256 CHAR(64) NOT NULL`, `registration_id CHAR(36) NOT NULL`, `registration_body_sha256 CHAR(64) NOT NULL`
   - `revoked TINYINT(1) NOT NULL DEFAULT 0`, `created_at_ms BIGINT NOT NULL`, `updated_at_ms BIGINT NOT NULL`
5. **`wb_device_project`（共享项目配置表）**：
   - `pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`
   - `workspace_id CHAR(36) NOT NULL`, `device_id CHAR(36) NOT NULL`, `project_id CHAR(36) NOT NULL`
   - `name VARCHAR(120) NOT NULL`, `share_enabled TINYINT(1) NOT NULL`, `share_version BIGINT NOT NULL`
   - `agent_configs_json TEXT NOT NULL`, `updated_at_ms BIGINT NOT NULL`
   - `UNIQUE KEY uk_workspace_project (workspace_id, project_id)`
6. **`wb_conversation`（会话头与当前状态表 —— 1 个会话仅 1 行）**：
   - `pk_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`
   - `id CHAR(36) NOT NULL`（`UNIQUE KEY uk_conversation_id`）
   - `workspace_id CHAR(36) NOT NULL`, `title VARCHAR(120) NOT NULL`
   - `created_by_user_id CHAR(36) NOT NULL`, `current_user_id CHAR(36) NOT NULL`
   - `device_id CHAR(36) NOT NULL`, `project_id CHAR(36) NOT NULL`, `agent_config_id CHAR(36) NOT NULL`
   - `next_sequence BIGINT NOT NULL`, `native_session_id VARCHAR(512) NULL`, `active_execution_id CHAR(36) NULL`
   - `created_at_ms BIGINT NOT NULL`, `updated_at_ms BIGINT NOT NULL`
   - `KEY idx_conversation_workspace (workspace_id, created_at_ms, id)`

---

### 4.2 Redis（Jedis `4.4.8`）Key 空间与 TTL 契约

| 用途 | Key 格式 | 数据结构 | TTL | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **1. 请求幂等防重** | `wb:idemp:{workspaceId}:{actorId}:{op}:{reqId}` | String (JSON: `{bodySha256, responseJson}`) | `1h` | 替代原 `wb_request_receipt` 表；相同 `reqId` 校验 `bodySha256`，一致则重放响应，不一致返回 `409 REQUEST_ID_CONFLICT` |
| **2. Daemon 在线路由表** | `wb:daemon:presence:{deviceId}` | Hash (`nodeId`, `connectionId`, `state`, `lastSeenMs`) | `45s` | 跨 Java 节点共享 Electron Daemon 在线状态与所在节点路由 |
| **3. 活跃任务与历史索引** | `wb:exec:state:{executionId}`<br>`wb:exec:source:{executionId}:{seq}` | String (JSON) | `24h` | 存储任务状态、启动/取消命令指纹及 Daemon Push 来源去重指纹（替代原 `wb_execution` 与 `wb_execution_receipt` 表） |
| **4. 会话最近消息热滑窗** | `wb:conv:msgs:{conversationId}` | ZSet (`score = sequence`, `member = MessageJSON`) | `7d` | 固定保留最近 `100` 条定稿消息，打开会话 `< 1ms` 零延迟返回 |
| **5. 会话最近事件滑窗** | `wb:conv:events:{conversationId}` | ZSet (`score = sequence`, `member = EventJSON`) | `24h` | 保留最近 `200` 条会话事件，供 `/history` 与 SSE 断线重连毫秒级补齐 |

---

### 4.3 Kafka（`4.1.2`）Topic 与消息契约

| Topic 名称 | Partition Key | 生产者 | 消费者 | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| `wb.conversation.events` | `conversationId` | `ConversationAppService`<br>`DaemonSyncAppService` | 各节点 `ConversationEventKafkaListener` | 实时将 `conversation.created`、`message.created`、`execution.changed` 等事件推送给本节点订阅该会话的 `SseEmitter` |
| `wb.daemon.commands` | `deviceId` | `ConversationAppService`<br>`ExecutionAppService` | 各节点 `DaemonCommandKafkaListener` | 将 `execution.start` 与 `execution.cancel` 指令精准路由至持有该 Daemon WebSocket 连接的 Java 节点立即下发 |
| `wb.search.index` | `workspaceId` | `ConversationAppService`<br>`DaemonSyncAppService` | `SearchIndexKafkaListener` | 异步批量（`_bulk`）将定稿消息与会话元数据写入 Elasticsearch `7.6.0` |

---

### 4.4 Elasticsearch `7.6.0` 索引契约

1. **定稿消息主索引：`wb_message_v1`**
   - **Routing**：强制使用 `_routing = workspaceId`；
   - **兼容参数**：针对 ES `7.6.0`，写入与点查路径统一使用 `/_doc/{messageId}?routing={workspaceId}`，查询统一携带 `rest_total_hits_as_int=true`；
   - **核心字段**：`messageId` (`keyword`)、`workspaceId` (`keyword`)、`conversationId` (`keyword`)、`conversationTitle` (`text` + `keyword`)、`executionId` (`keyword`)、`authorKind` (`keyword`)、`authorUserId` (`keyword`)、`authorUsername` (`keyword`)、`authorDisplayName` (`keyword`)、`agentConfigId` (`keyword`)、`sequence` (`long`)、`text` (`text`)、`state` (`keyword`)、`createdAtMs` (`long`)。
2. **会话与交接索引：`wb_conversation_handoff_v1`**
   - 存储会话标题、当前接续人及后续 [HC-198](../task/HC-198-会话交接与内容引用.md) 的交接单三段总结，支撑工作区全局搜索。

---

## 5. 核心业务流转规格（输入 → 判断 → 执行 → 输出）

### 5.1 发送提问与任务派发（`ConversationAppService.sendInput`）
1. **输入**：`userId, workspaceId, conversationId, SendInputRequest(requestId, text)`。
2. **校验与判断**：
   - 检查工作区活跃成员权限（`WorkspaceAccess`）；
   - 通过 `IdempotencyPort`（Redis `wb:idemp:*`）检查 `(workspaceId, userId, "input.send", requestId)`：若已存在且请求体指纹一致则直接重放，若请求体不同则抛出 `409 REQUEST_ID_CONFLICT`；
   - 校验会话绑定的共享项目处于 `share_enabled = 1` 且执行配置可用。
3. **执行**：
   - 在 TDSQL 短事务内锁定 `wb_conversation` 行，原子分配 `sequence`（推进 `next_sequence`）；
   - 构建定稿用户 `Message` 与 `queued` 状态的 `Execution`；
   - 写入 Redis 热消息滑窗（`wb:conv:msgs:{conversationId}`）、事件滑窗（`wb:conv:events:{conversationId}`）、执行状态（`wb:exec:state:{executionId}`）与幂等回执；
   - 发布事件至 Kafka `wb.conversation.events`、`wb.search.index`（异步入 ES `7.6.0`）与 `wb.daemon.commands`（立即唤醒目标 Daemon 派发，消除 `1000ms` 轮询等待）。
4. **输出**：返回 `InputSavedResponse`，在线 SSE 客户端毫秒级收到 `message.created` 与 `execution.changed` 事件。

### 5.2 Electron Daemon Push 定稿消息与执行状态（`DaemonSyncAppService.recordBatch`）
1. **输入**：`deviceId, connectionId, executionId, List<RunnerMessage>`。
2. **校验与判断**：
   - 校验设备身份、消息签名（`bodySha256`）、目标归属（`workspaceId/conversationId/deviceId/projectId`）与连续 `runnerSequence`；
   - 对已处理过的 `runnerSequence` 比对 Redis 去重指纹，相同则幂等跳过，冲突则拒绝。
3. **执行**：
   - 当收到模型产出的消息或终态时，在 TDSQL 更新 `wb_conversation` 游标/原生会话绑定，将定稿消息写入 Redis 热滑窗并经 Kafka 同步至 ES `7.6.0`；
   - 通过 Kafka `wb.conversation.events` 实时广播给所有在线 SSE 订阅者。
4. **输出**：返回 `ExecutionAck`（及首次 `accepted` 时的唯一 `ExecutionStartDecisionMessage`）。

---

## 6. 标准 Spring Boot 工程形态与单元测试规格

### 6.1 标准 `@SpringBootApplication` 启动与配置规范
1. **启动类规范**：
   - `workbench.collaboration.Application` 标注 `@SpringBootApplication`、`@MapperScan("workbench.collaboration.infrastructure.persistence.mapper")`、`@ConfigurationPropertiesScan("workbench.collaboration.infrastructure.config")`；
   - 默认支持在 IDE 或通过 `spring-boot:run` 无参直接启动 Web 服务（`workbench.command` 默认值为 `start`）；当显式传入 `--workbench.command=contracts|migrate|init-demo` 时，按对应一次性生命周期执行后安全退出。
2. **依赖注入与配置外置**：
   - 控制器统一标注 `@RestController`，应用服务标注 `@Service` 与 `@Transactional`，仓储实现标注 `@Repository`，MyBatis-Plus 接口标注 `@Mapper`；
   - 所有连接池、MyBatis-Plus、Redis、Kafka、Elasticsearch 参数通过 `src/main/resources/application.yml` 与 `@ConfigurationProperties` 类型安全绑定，不再在配置类中硬编码手工 `new` 业务服务。

### 6.2 JUnit 5 单元测试体系（`src/test/java/workbench/collaboration`）
在 `pom.xml` 中引入 `org.springframework.boot:spring-boot-starter-test`（`<scope>test</scope>`，排除 `spring-boot-starter-logging`），单元测试覆盖以下四个维度：
1. **`domain` 层单元测试**：验证 `Conversation`、`Execution`、`Device`、`User` 领域模型的业务不变量、序号分配、执行状态机合法/非法迁移与授权裁决规则；
2. **`application` 层单元测试（Mockito）**：验证 `IdentityAppService`、`DeviceAppService`、`ConversationAppService`、`ExecutionAppService` 的用例编排、请求幂等重放与 `409 REQUEST_ID_CONFLICT` 拦截、跨层调用顺序；
3. **`infrastructure` 层单元测试**：验证 MyBatis-Plus `PO <-> Domain` 双向转换器、Redis 1h 幂等与最近 100 条热消息/事件滑窗、Kafka 事件路由、Elasticsearch `7.6.0` 查询构建（`_routing=workspaceId` + `rest_total_hits_as_int=true`）与超时熔断降级、JSON Schema `3.0.1` 契约校验；
4. **`interfaces` 层切片测试（MockMvc）**：验证 `BoundaryFilter` 路由/方法/Query/体积/Origin 拦截、登录认证与 REST 控制器响应格式。

