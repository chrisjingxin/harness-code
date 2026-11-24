# HC-246 全局待办收件箱与 IM 轻通知行为规格

> 状态：规格草案（2026-11-24，待审阅）。本文定义 [HC-246 Task](../task/HC-246-全局待办收件箱与IM轻通知.md) 的行为契约、数据库增量、跨端接口、企业自研 IM 可扩展出站口子、桌面端 UI 与深链接唤醒规则，对应 [个人与团队协同用户旅程](../architecture/个人与团队协同用户旅程.md) 第 13.2 节与第 15 节，并与 [HC-220 轻量通知](HC-220-项目看板与轻量通知.md)、[HC-239 双轨桌面外壳](HC-239-个人优先使用本机Agent.md) 及 [HC-240 团队角色与代管规则](HC-240-Workspace角色管理.md) 对齐。

[需求卡](../task/HC-246-全局待办收件箱与IM轻通知.md) · [实施计划](../plan/HC-246-全局待办收件箱与IM轻通知.md) · [执行清单](../todo/HC-246-全局待办收件箱与IM轻通知.md) · [用户旅程总纲](../architecture/个人与团队协同用户旅程.md) · [方案 B 交互原型](../previews/personal-team-workbench/README.md)

---

## 1. 现状痛点、解决思路与改后收益

### 1.1 现状痛点

1. **待办散落、角标缺失**：在多团队（Workspace）、多项目（Project）并行的场景下，指派给我的 Task（`todo`）和待我验收的 Task（`review`）分散在各 Project 的看板和任务页里；左栏仅在当前选中项目的「任务」条目上展示局部数量，停留在「个人」空间或团队 A 时，团队 B 的新待办毫无感知。
2. **现有通知流只管单个 Workspace**：[NotificationController](../../../server/src/main/java/workbench/collaboration/interfaces/rest/NotificationController.java) 与 [project-updates-ipc.ts](../../../desktop/src/main/project-updates-ipc.ts) 仅订阅当前激活的单个 Workspace；且 `wb_notification_outbox` 是只追加的事件历史日志，无法直接回答“此刻到底还有几件没拍板的事”。
3. **上游审核卡尚未交付，容易写死架构**：知识分级审核（HC-241）、系统地图审核（HC-243）、技能/MCP 审核（HC-245）与只读会话批注（HC-252）尚未认领实现，若直接把 Inbox 写死成“只查 Task”，后续接入新待办来源需大面积返工。
4. **企业内采用自研 IM，缺乏安全、可插拔出站口子**：团队成员离开桌面客户端后无法收到及时提醒；但企业内使用的是自研 IM（由我方在企业内部自行对接），既不能把第三方厂商（企微/飞书/钉钉）协议写死进主干，更不能把对话正文、代码片段灌进 IM 群引发刷屏和泄密；同时桌面端也尚未接入单实例锁与 `workbench://` 深链接定位。
5. **本机后台会话卡在审批容易被遗忘**：当员工在多个会话间切换或回到「团队」看板时，后台运行的本机会话若因工具执行权限、计划确认、目标确认或澄清问答暂停（`waiting_approval`），或运行出错（`error`），缺少统一提醒入口。

### 1.2 解决思路与改后收益

- **以“业务现态投影 + 可扩展来源 SPI”作为 Inbox 唯一真相**：不靠事件计数拼凑待办，每次查询基于各业务表实时投影并在线校验团队与项目成员资格；通过 `InboxItemSource` SPI（Service Provider Interface，服务端可插拔业务来源扩展接口）解耦待办来源——本期实现 `TaskInboxSource`，后续 HC-241 / HC-243 / HC-245 / HC-252 只需新增一个实现类即可接入全局 Inbox。
- **跨空间顶置 Inbox + 本机置顶隔离（方案 A）**：在双轨左栏顶部提供跨空间「收件箱」入口；云端角标仅统计需真人拍板的跨人异步待办（Task `todo + review`，不含 `doing`）。本机非当前查看会话的 `waiting_approval` / `error` 状态不入云端、不占云端角标、不发 IM，而是在 Inbox 顶部动态呈现「本机等待你确认」提醒区，点击一键跳回原会话现场决策。
- **补齐用户级跨团队通知流与降噪偏好**：新增 `/api/v1/me/inbox`、`/api/v1/me/notifications`、`/api/v1/me/notifications/stream`（跨所有已加入 Workspace 推送轻量事件）与 `/api/v1/me/notification-preferences`（总开关、订阅事件、免打扰时段、合批窗口）。
- **把“企业自研 IM 对接”收敛成清晰的 10% 扩展口子**：服务端把复杂的 90% 基础设施全部做好（同事务入队、合批防抖、免打扰顺延、发送前现态复核消噪、强白名单脱敏卡片构造、指数退避重试与单元测试），只把“怎么发给企业自研 IM”留给 `ExternalNotificationChannel`、`ExternalRecipientResolver` 与 `DeepLinkBuilder` 三个强类型接口（默认内置 `Noop` 与 `Logging` 通道），企业内开发实现 1 个接口、改 3 行配置即可上线。

---

## 2. 核心模型与全局不变量（Invariants）

以下底线全栈强制遵守，任何阶段不得突破：

1. **现态投影真相（Live State Projection）**
   - 云端 Inbox 列表与未处理数量**绝不依赖事件流加减计数**，永远以业务表实时状态投影为准；任务被接收、验收通过、退回、取消、项目归档或成员被移出团队/项目时，条目即时消退或权限收敛，不存在“幽灵红点”。
   - 每次读取 Inbox 或跨团队通知时，服务端必须重新核对 `wb_workspace_member(status=1)`、`wb_project_member(status=1)` 与 `wb_user(enabled=1)`。
2. **本机与云端职责严格隔离（方案 A）**
   - 本机会话的 `waiting_approval`（工具权限审批 `requestPermission`、Plan 确认、Goal 确认、澄清问答 `elicitation/create`）与 `error` 属于**单机瞬时同步态**：只存桌面内存/本地存储，绝不写入服务端数据库，绝不计入云端 Inbox 角标，绝不触发外部 IM 通知。
   - 不允许在 Inbox 页面“盲批”本机工具权限或 Plan——必须点击跳回原会话查看上下文与 Diff 后在现场操作。
3. **外部通知安全白名单底线（Zero Content Leakage）**
   - 外部通知表（`wb_external_notification_delivery`）和发给企业 IM 的载荷（`ExternalNotificationMessage`）**严禁存储或携带**：会话消息正文、代码块、工具终端输出、本机文件系统路径、仓库文件内容、任务长描述正文或附件内容。
   - 仅允许透传经过 `SafeNotificationBuilder` 白名单校验与长度截断（如单行标题 ≤ 80 字符，剔除换行与控制字符）的事件元数据：事件类型、紧迫度、截断标题、发起人展示名、Workspace/Project 名称与安全 Deep-Link。
4. **主事务与外部 IM 故障绝对隔离**
   - 业务写事务（如指派 Task、提交验收）只在同事务向 `wb_external_notification_delivery` 写入待投递元数据记录，**绝不在数据库事务或 HTTP 请求线程中同步调用外部 IM 网络接口**。
   - 事务提交后异步唤醒投递引擎；企业自研 IM 超时、限流或宕机，绝不影响协作主业务提交和端内 SSE 通知。
5. **不抢焦点、不越权执行（Read-Only Navigation）**
   - 端内增量刷新 Inbox 绝不打断用户当前输入框焦点与时间线滚动位置。
   - 无论点击 Inbox 条目还是从企业 IM 点击 `workbench://` Deep-Link 唤起桌面端，**最多只做窗口聚焦、身份校验与页面跳转**，绝不自动发起或恢复任何 Agent 执行，绝不跳过用户审批。
6. **单向轻通知边界**
   - 不支持在企业 IM 中直接回复指令遥控本机或他人 Agent，也不把外部 IM 变成双向任务状态写操作控制台。

---

## 3. 数据库增量设计

严格遵守 [schema.sql](../../../server/src/main/resources/db/schema.sql) 规范：InnoDB 引擎、`utf8mb4_unicode_ci`、ID 关联列覆写 `ascii_bin`、物理自增主键 `id BIGINT UNSIGNED AUTO_INCREMENT`、**全列 `NOT NULL`**（空语义使用 `''` 空串哨兵）、时间列由应用写入 `DATETIME(3)`、状态列使用 `TINYINT UNSIGNED`（从 1 起编）、无外键/触发器/视图。

### 3.1 新增表结构

#### （1）`wb_user_notification_pref`：用户通知降噪与外部通道偏好表

```sql
CREATE TABLE wb_user_notification_pref (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理主键',
  user_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '用户全局唯一业务标识',
  external_enabled TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '是否允许外部IM轻通知：1=启用,2=停用',
  subscribed_events VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '逗号分隔订阅事件类型白名单',
  dnd_enabled TINYINT UNSIGNED NOT NULL DEFAULT 2 COMMENT '免打扰开关：1=开启,2=关闭',
  dnd_start_minute SMALLINT UNSIGNED NOT NULL DEFAULT 1320 COMMENT '免打扰开始分钟(0-1439，默认22:00=1320)',
  dnd_end_minute SMALLINT UNSIGNED NOT NULL DEFAULT 540 COMMENT '免打扰结束分钟(0-1439，默认09:00=540)',
  dnd_timezone VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'Asia/Shanghai' COMMENT 'IANA时区标识',
  merge_window_sec INT UNSIGNED NOT NULL DEFAULT 60 COMMENT '同项目同类事件合批等待窗口秒数(0-600，默认60)',
  version BIGINT NOT NULL DEFAULT 1 COMMENT '乐观并发版本号',
  created_at DATETIME(3) NOT NULL COMMENT '创建时间',
  updated_at DATETIME(3) NOT NULL COMMENT '最近更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户通知降噪与外部通道偏好表';
```

- *缺省策略*：若某用户尚未在表中有记录，读取与调度时返回系统默认偏好（`externalEnabled=true`、`subscribedEvents=["task.assigned","task.review_requested","task.returned"]`、`dndEnabled=false`、`dndStartMinute=1320`、`dndEndMinute=540`、`dndTimezone="Asia/Shanghai"`、`mergeWindowSec=60`、`version=0`），首次 `PUT` 时以 `expectedVersion=0` 初始化落库。

#### （2）`wb_external_notification_delivery`：外部通知异步出站队列与投递审计表

```sql
CREATE TABLE wb_external_notification_delivery (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '物理主键',
  delivery_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '外部投递幂等业务标识(UUID)',
  user_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '目标接收人用户标识',
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '所属团队标识',
  project_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '' COMMENT '所属项目标识(团队级事件为空串)',
  event_type VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '通知事件类型(如task.assigned)',
  object_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '目标对象业务标识(如taskId)',
  actor_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '触发操作人用户标识',
  urgency TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '紧迫度：1=normal,2=urgent',
  title_snapshot VARCHAR(120) NOT NULL COMMENT '经截断脱敏的对象标题快照(严禁含正文)',
  merge_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '合批键(如projectId:eventType)',
  status TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '投递状态：1=pending,2=sending,3=sent,4=skipped,5=failed',
  skip_reason VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '' COMMENT '跳过原因(如already_resolved/disabled/unsubscribed)',
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已尝试投递次数',
  max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 3 COMMENT '最大重试次数',
  available_at DATETIME(3) NOT NULL COMMENT '最早可投递时间(含合批窗口/免打扰顺延/退避时间)',
  last_error VARCHAR(256) NOT NULL DEFAULT '' COMMENT '最近一次投递失败摘要(不含敏感正文)',
  occurred_at DATETIME(3) NOT NULL COMMENT '业务事件发生时间',
  created_at DATETIME(3) NOT NULL COMMENT '入队时间',
  updated_at DATETIME(3) NOT NULL COMMENT '状态更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_delivery_id (delivery_id),
  KEY idx_status_available_at (status, available_at, id),
  KEY idx_user_merge_status (user_id, merge_key, status, available_at),
  KEY idx_object_user_status (object_id, user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='外部IM轻通知出站队列与投递元数据表';
```

### 3.2 既有表索引增量与 `Foundation.java` 同步

- `wb_notification_outbox` 新增索引：`KEY idx_user_id_id (user_id, id)`，支撑 `/api/v1/me/notifications` 跨团队按用户查询。
- `wb_task` 新增索引：`KEY idx_creator_id_status (creator_id, status)`，支撑 `TaskInboxSource` 高效聚合待我验收（`review`）及我发起的任务。
- [Foundation.java](../../../server/src/main/java/workbench/collaboration/infrastructure/contract/Foundation.java) 的 `REQUIRED_TABLES` 从 20 张表增至 **22 张表**（纳入 `wb_user_notification_pref` 与 `wb_external_notification_delivery`），并在 `REQUIRED_COLUMNS` 中登记两张新表的关键列。

---

## 4. 跨团队统一待办聚合、跨团队通知流与可扩展来源 SPI

### 4.1 可扩展来源接口 `InboxItemSource` 与现态复核接口 `InboxActionabilityChecker`

为保证未来 HC-241（知识/经验审核）、HC-243（系统地图审核）、HC-245（团队技能/MCP 审核）、HC-252（只读会话批注/@提醒）落地时**零重构现有收件箱与 IM 通知代码**，在 `workbench.collaboration.application.port` 中定义两个核心 SPI：

```java
/** 全局待办收件箱数据源扩展口子：每类待办来源实现一个 Spring Bean 并自动聚合。 */
public interface InboxItemSource {
    /** 来源类型标识，如 "task"（后续可扩展 "knowledge_proposal"、"skill_proposal"、"comment" 等）。 */
    String sourceType();

    /** 返回当前用户有权限查看且符合筛选桶条件的待办/追踪投影条目（需在线核对成员权限）。 */
    List<InboxItem> listForUser(String userId, InboxSourceQuery query);
}

/** 外部通知发送前的现态复核扩展口子：若待办在合批/退避期间已被处理，返回 false 自动消噪取消推送。 */
public interface InboxActionabilityChecker {
    /** 是否支持复核该事件类型对应的对象。 */
    boolean supports(String eventType);

    /** 复核当前时刻该对象对指定用户是否仍需动作或提醒。 */
    boolean isStillActionable(String userId, String workspaceId, String projectId, String eventType, String objectId);
}
```

### 4.2 本期 `TaskInboxSource` 聚合口径与排序规则

依据已确认决策 #2（仅 `todo + review` 计入「待我处理」角标）：

| 筛选桶 (`bucket`) | 收录条件（全部须满足当前账号为活跃团队成员 + 活跃项目成员 + 项目 `status = active`；`resolved` 放宽至历史可见项目） | 紧迫度 (`urgency`) | 条目种类 (`category`) |
| --- | --- | --- | --- |
| `action_required`（待我处理） | ① `status = review` 且当前用户可代发起人验收（`creatorId == me`，或原创建者已移出团队/停用且 `project.ownerUserId == me`，沿用 HC-240 规则） | `urgent`（待我验收） | `task_review` |
| `action_required`（待我处理） | ② `status = todo` 且 `assigneeId == me`（含 HC-240 离职交接转派给我的待办） | `normal`（任务指派） | `task_assigned` |
| `sent`（我发起的） | `creatorId == me` 且 `assigneeId != me` 且 `status IN (todo, doing, review)` | `normal` | `task_assigned` / `task_review` / `task_in_progress` |
| `resolved`（已处理） | `status IN (done, cancelled)` 且最近 **30 天**（`updatedAt >= now - 30d`）内更新，且当前用户为 `assigneeId`、`creatorId` 或当前代管 `project.ownerUserId` | `normal` | `task_resolved` |

- **关于 `doing` 任务的明确边界**：被指派给我且我已点击接收处于 `doing` 的任务，属于正在进行的日常工作，**不进入 `action_required` 待拍板角标**，仍可在对应 Project 的任务/看板视图处理。
- **默认排序**：
  - `action_required` 桶：`urgency`（`urgent` 置顶，其次 `normal`） → `updatedAtMs` 倒序 → `itemKey` 字典序；
  - `sent` / `resolved` 桶：`updatedAtMs` 倒序 → `itemKey` 字典序。
- **跨 Workspace 成员信息补齐**：响应体返回 `workspaces`（已归属团队名称字典）与 `actors`（发起人/处理人展示名与在职状态字典），确保桌面端哪怕当前正停留在「个人」空间或团队 A，也能直接渲染来自团队 B 的条目发起人姓名与项目名，无需额外发 N 次请求。

### 4.3 HTTP REST 与 SSE 契约

在 [collaboration.schema.json](../../../contracts/schema/collaboration.schema.json)、[collaboration.openapi.json](../../../contracts/openapi/collaboration.openapi.json) 与 [RouteCatalog.java](../../../server/src/main/java/workbench/collaboration/interfaces/http/RouteCatalog.java) 中新增以下 `/api/v1/me/...` 端点（均要求 `Auth.USER` 登录态与 `Origin` / 协议版本头校验）：

| 方法与路径 | Query / Body | 响应结构与核心语义 |
| --- | --- | --- |
| `GET /api/v1/me/inbox` | Query: `bucket` (`action_required\|sent\|resolved`, 默认 `action_required`), `category?`, `workspaceId?`, `limit?` (1..200, 默认 50) | 返回 `InboxResponse`：`items: InboxItem[]`、`counts: { actionRequired, urgent, sent }`（`counts` 为用户全局未筛选的汇总角标，保障红点始终准确）、`notificationCursor: number`（当前用户在 `wb_notification_outbox` 的最新提交水位，供后续 SSE 起点续接）、`workspaces`、`actors`、`truncated: boolean` |
| `GET /api/v1/me/notifications` | Query: `afterId?` (整数 ≥0，默认 0), `limit?` (1..100，默认 50) | 返回 `UserNotificationPage`：`events: UserNotificationEvent[]`、`nextAfterId: number`、`hasMore: boolean`。每条事件在原有 `NotificationEvent` 基础上包含必填 `workspaceId` |
| `GET /api/v1/me/notifications/stream` | Query: `afterId?`；Header: `Last-Event-ID?`（优先于 `afterId`） | `text/event-stream` 长轮询 SSE 流（沿用 60s 寿命、15s 心跳注释、`NotificationSignal` + Kafka 唤醒、并发流信号量上限）。**跨 Workspace 游标防漏读机制**：由于 `NotificationStore.append` 仅按单个 `wb_workspace` 行加锁，不同团队间事务提交的 `id` 可能交错；流内按当前用户加入的每个活跃 Workspace 各自维护独立的递增游标 `wsCursor`（初始均为请求传入的 `afterId`），逐团队拉取合并按 `(id)` 推给客户端，同时每次连接/重连后桌面端自动拉一次 `GET /api/v1/me/inbox` 校准现态 |
| `GET /api/v1/me/notification-preferences` | 无 | 返回 `NotificationPreferences`：`externalEnabled`, `subscribedEvents`, `dndEnabled`, `dndStartMinute`, `dndEndMinute`, `dndTimezone`, `mergeWindowSec`, `version` |
| `PUT /api/v1/me/notification-preferences` | Body: `NotificationPreferencesUpdateRequest`（含 `expectedVersion`） | 严格校验时间范围（分钟 `0..1439`、IANA 时区合法性、事件类型白名单、合批窗口 `0..600` 秒）与 `expectedVersion` 乐观锁（冲突返回 `409 VERSION_CONFLICT`），落库返回最新 `NotificationPreferences` |

### 4.4 `TaskAppService` 与跨团队事件映射

- **端内 SSE 事件（兼容 HC-220）**：`wb_notification_outbox` 维持既有事件名 `task.assigned` 与 `task.changed`。
  - 修复/补全 HC-240 离职代管场景：当 `TaskAppService` 向 `NotificationPort` 发布事件时，若任务进入 `REVIEW`（或 `PATCH`/`CANCEL`）且原 `creatorId` 已不在当前团队有效成员中（`!activeCreator`），将当前有效的 `project.ownerUserId` 作为代管验收人（`effectiveCreatorId`）一并纳入接收人列表，保证代管人能实时收到端内刷新提醒与外部通知。
- **外部 IM 投递入队**：在同一业务写事务中，向 `wb_external_notification_delivery` 登记（操作者触发自身动作时自动排除自己，不自发提醒）：
  - `create()` → `task.assigned`（接收人：`assigneeId`，紧迫度：`normal`）；
  - `transition(doing → review)` → `task.review_requested`（接收人：有效验收人 `effectiveCreatorId`，紧迫度：`urgent`）；
  - `transition(review → todo)` → `task.returned`（接收人：`assigneeId`，紧迫度：`normal`）；
  - `transition(review → done)` / `transition(* → cancelled)` / 成员移除交接（`WorkspaceAppService` 触发的 `task.assigned`）→ 若为新指派则入队 `task.assigned`，若为终结状态则把同一 `(objectId, userId)` 尚未发送的旧 `pending` 记录立即标为 `skipped(already_resolved)`。

---

## 5. 面向企业自研 IM 的可插拔外部通知出站引擎（核心扩展口子）

> **设计原则**：由于企业自研 IM 由用户在企业内自行开发接入，本卡不写死企业微信、飞书或钉钉适配器，而是将 **“业务入队 → 偏好与免打扰 → 同项目合批 → 现态复核 → 安全脱敏构造 → 身份映射 → 通道投递 → 幂等退避重试”** 做成生产级强校验基础设施，并通过 3 个清晰的 Spring 接口暴露扩展口子，配合全套单元测试保障契约稳定。

### 5.1 三个核心扩展接口（SPI）

位于 `server/src/main/java/workbench/collaboration/application/port/`：

1. **`ExternalNotificationChannel`（唯一必须由企业侧实现的消息投递接口）**
   ```java
   public interface ExternalNotificationChannel {
       /** 通道唯一标识（例如 "corp-im"、"noop"、"logging"），与配置 workbench.notifications.external.channel 匹配 */
       String channelType();

       /** 发送一条已完成脱敏白名单校验、频控合批与现态复核的标准轻通知卡片 */
       DeliveryResult send(ExternalNotificationMessage message);
   }
   ```
   - 返回值 `DeliveryResult` 为密封结果类型：
     - `DeliveryResult.sent(String externalMessageId)`：投递成功；
     - `DeliveryResult.retryableFailure(String reason)`：可重试故障（网络超时、5xx、限流），触发指数退避重试；
     - `DeliveryResult.permanentFailure(String reason)`：不可恢复故障（目标用户无权接收、格式非法等），直接标 `failed` 不再重试。
2. **`ExternalRecipientResolver`（收件人身份寻址扩展接口）**
   ```java
   public interface ExternalRecipientResolver {
       /** 将工作台 User 映射为外部 IM 收件人坐标；返回 Optional.empty() 时跳过投递并记录 skipReason="recipient_unmapped" */
       Optional<ExternalRecipient> resolve(User user);
   }
   ```
   - **内置默认实现 `UserNoRecipientResolver`**：直接读取 `wb_user.user_no`（员工工号/一号通），若 `user.userNo()` 非空则生成 `ExternalRecipient(user.id(), user.userNo(), user.userName(), user.userNo())`；若未绑定工号则返回 empty（`recipient_unmapped`）。企业内若需用邮箱或独立 IM OpenID，只需替换该 Bean。
3. **`DeepLinkBuilder`（安全跳转链接构造接口）**
   ```java
   public interface DeepLinkBuilder {
       /** 生成唤醒桌面端定位到对应资源的链接；必须仅使用受信任的业务 ID，禁止拼接外部不可信文本 */
       String buildTaskLink(String workspaceId, String projectId, String taskId);
       String buildInboxLink();
   }
   ```
   - **内置默认实现 `WorkbenchSchemeDeepLinkBuilder`**：生成标准 `workbench://open/task?workspaceId=...&projectId=...&taskId=...` 与 `workbench://open/inbox`。
   - **为什么单独抽象这一层？**：部分企业内部 IM 客户端出于安全策略限制，消息卡片仅允许跳转 `https://` 企业内网地址而不允许直接点击 `workbench://`。留出 `DeepLinkBuilder` 接口后，企业侧无需改动调度逻辑，只需提供一个自定义实现将其包装为企业网关或中转页 URL（例如 `https://im-jump.corp.internal/workbench?target=...`）即可。

### 5.2 强制安全载荷与白名单构造器（`SafeNotificationBuilder`）

- 所有发往 `ExternalNotificationChannel.send(...)` 的消息对象**必须且只能**由基础设施内部的 `SafeNotificationBuilder` 构造（构造逻辑封装在引擎中，不允许业务代码绕过）。
- `ExternalNotificationMessage`（不可变 Java Record）字段严格受限：
  - `deliveryId`（UUID，可用于企业 IM 侧防重幂等键）；
  - `eventType`（枚举白名单：`task.assigned` / `task.review_requested` / `task.returned` / `notification.test`）；
  - `urgency`（`normal` / `urgent`）；
  - `recipient`（`userId`, `userNo`, `userName`, `externalAccountId`）；
  - `actor`（`userId`, `userNo`, `userName`）；
  - `workspaceId`, `workspaceName`, `projectId`, `projectName`；
  - `title`（单行白名单清洗，去除 `\r\n\t` 及控制字符，最长 80 字，超长截断加 `…`）；
  - `summary`（受控模板短句，例如单条时 `"沈北辰 在【支付重构】指派了任务给你"`，合批 `N` 条时 `"【支付重构】有 3 项任务待你处理（最近：核对结算…）"`）；
  - `actionLabel`（固定如 `"在工作台查看"`）、`deepLink`、`mergedCount`（≥1）、`occurredAtMs`。
- **绝对禁止进入的字段**：`description`（任务长描述）、对话 `messages`、代码片段、文件路径、Diff、附件内容。单元测试中将针对构造产物做敏感字段与超长截断断言。

### 5.3 出站调度链路：`ExternalNotificationDispatcher`

完整处理链路（`输入 → 判断 → 执行 → 输出`）：

```text
[输入] 定时器（默认每 2s，可单测直接调用 dispatchDueBatch()）扫描 status=pending 且 available_at <= now 的记录
  │    （使用条件更新抢占 status=sending，防多节点/并发重复投递）
  ▼
[判断 1 · 合批汇聚] 同批内按 (user_id, merge_key) 分组（如同用户+同项目+同事件类型），仅保留 1 条主批次承接发送，其余同组 pending 合并标记为 skipped(merged_into_batch)
  ▼
[判断 2 · 偏好与免打扰] 读取该用户偏好（无记录取默认配置）：
  ├── external_enabled == false ──> 标为 skipped(disabled)
  ├── event_type 不在 subscribed_events ──> 标为 skipped(unsubscribed)
  └── 命中免打扰时段（按 dnd_timezone 计算当前是否落在 [dnd_start, dnd_end) 跨天区间内）
       ──> 不丢弃！将同组记录重新置回 pending，available_at 顺延至本次免打扰结束时刻
  ▼
[判断 3 · 发送前现态复核] 调用匹配的 InboxActionabilityChecker.isStillActionable(...)
  └── 返回 false（说明用户在合批等待的 60 秒内已经自己点开了/验收完了/任务被取消了/用户已被移出项目）
       ──> 标为 skipped(already_resolved)，真正做到“已读/已办免打扰”
  ▼
[判断 4 · 身份映射与安全构造]
  ├── 校验用户 enabled=1 及团队/项目资格；调用 ExternalRecipientResolver.resolve(user)
  │    └── 返回 empty ──> 标为 skipped(recipient_unmapped)
  └── SafeNotificationBuilder 组装强脱敏 ExternalNotificationMessage + DeepLinkBuilder 生成链接
  ▼
[执行 · 调用渠道] 根据配置 workbench.notifications.external.channel 选中匹配的 ExternalNotificationChannel
  ├── SENT ──> 全部同组记录标为 sent
  ├── PERMANENT_FAILURE ──> 标为 failed(last_error)
  └── RETRYABLE_FAILURE ──> attempt_count + 1
       ├── attempt_count < max_attempts(3) ──> 置回 pending，available_at 指数退避（30s → 120s → 300s）
       └── 达到上限(3次) ──> 标为 failed(max_attempts_exceeded)
```

### 5.4 内置通道、配置项与企业接入指南

1. **配置项（`WorkbenchProperties.ExternalNotifications`）**：
   ```yaml
   workbench:
     notifications:
       external:
         enabled: false              # 全局出站调度开关（默认 false；开启后才运行定时分发）
         channel: noop               # 激活的通道标识：noop | logging | <企业自定义channelType>
         dispatch-interval-ms: 2000  # 轮询间隔（毫秒）
         default-merge-window-sec: 60
         max-attempts: 3
   ```
2. **内置默认通道**：
   - `NoopNotificationChannel`（`channelType = "noop"`）：空实现，直接返回 `SENT("noop")`，保障默认零副作用；
   - `LoggingNotificationChannel`（`channelType = "logging"`）：结构化打印将发送的 `ExternalNotificationMessage`（脱敏卡片文本、接收人工号与 `deepLink`）到日志，供本地/测试环境验证链路；
   - 另在服务端测试包与文档提供企业内开发示例（实现 `ExternalNotificationChannel` + 注册 `@Component` + 修改 `workbench.notifications.external.channel` 与 `enabled: true` 三步即可完成企业自研 IM 上线）。

---

## 6. 桌面端 UI、本机待确认置顶区与 Deep-Link 唤醒规格

### 6.1 左栏顶置「收件箱」入口（跨空间全局可见）

- 对齐 [方案 B 交互原型](../previews/personal-team-workbench/src/app.js#L1189-L1196) 与双轨左栏 [ProjectNavigation](../../../desktop/src/ui/navigation/index.tsx#L700-L727)：
  - 在「个人 | 团队」分段切换器正下方（不隶属于个人或某个 Project，在两个空间下都始终置顶可见）增加一行全局「收件箱（Inbox）」导航条目；
  - 右侧展示两类清晰且绝不混算的状态提示：
    1. **云端待拍板红点角标**：仅显示 `counts.actionRequired`（Task `todo + review`）；为 0 时隐藏数字；当角标数值上升时触发一次轻微跳动提示（不抢焦点）；
    2. **本机等待确认独立提示点**：当当前设备有非当前查看会话处于 `waiting_approval` / `error` 时，在左侧或条目尾部显示一个温和的琥珀色状态点及文字计数（如 `本机 1`），**绝不加进云端红点数字**。
- 当工作台处于未入团或离线续用态时：
  - 若有本机待确认会话，收件箱依然可用（顶部展示本机置顶区）；
  - 云端部分友好提示“加入团队或重连协作服务后，这里会汇总跨团队任务与审核待办”。

### 6.2 中央收件箱视图与方案 A 本机置顶区

点击左栏「收件箱」后，中央工作区切换为独立的 `InboxPage`（不改变当前未关闭会话的后台执行）：

1. **顶部动态区域（方案 A）——「本机等待你确认」提醒条**
   - **出现条件**：仅当当前设备内存中至少存在 1 条**非当前打开查看**（或在后台切走）且处于 `waiting_approval` 或 `error` 的本机个人/项目会话时动态浮现；全部处理完毕后自动消失。
   - **展示内容**：会话标题、所属工程目录（或所属 Project 名）、等待类型标签（`权限审批` / `计划确认` / `目标确认` / `问题待答` / `执行出错`）、最近触发的摘要（如正在等待授权的工具/命令标题，截断单行展示）。
   - **交互**：提供「回到会话处理」主按钮，点击直接切回对应会话（个人会话切回「个人」空间定位该会话；已发布项目会话切到对应 Workspace/Project 定位该会话），**绝不在 Inbox 里脱离上下文直接盲批**。
2. **云端跨团队待办列表（主分栏 / 列表 + 详情联动）**
   - **分段标签**：`待我处理 (N)`（`action_required`）、`我发起的 (M)`（`sent`）、`已处理`（`resolved`，说明仅保留最近 30 天）。
   - **筛选栏**：
     - 团队筛选下拉（`全部团队` + 用户已加入的所有 Workspace，仅在所属团队 ≥ 2 时显示）；
     - 类别筛选胶囊（`全部`、`待我验收`、`任务指派`；未来 HC-241/243/245/252 到来后自动出现对应新类别）；
     - 手动刷新按钮与当前跨团队通知流状态指示（`实时同步` / `离线重连中`）。
   - **条目卡片内容**：类别徽标（`待验收` 为醒目强调色、`任务指派` 为常规色）、任务标题、发起人头像与姓名（含已离开团队标注）、所属 `Workspace · Project` 路径、更新时间、当前任务状态标签。
   - **一键直达与返回**：
     - 点击某条待办（或右侧「去处理 / 查看详情」按钮），桌面端自动切换到目标 `workspaceId` → 目标 `projectId` → `openPage({ kind: "task", taskId })`；
     - 若用户从收件箱跳转过去，顶部提供温和的「返回收件箱」返回路径（参考原型 `returnTo`）。
     - 在任务详情页完成接收（`todo → doing`）或验收通过/退回（`review → done/todo`）后，Inbox 状态和左栏角标随 `/me/notifications/stream` 推送与本地乐观刷新即时消退。

### 6.3 设置面板：「通知与提醒」偏好区

在 [desktop-workbench.tsx](../../../desktop/src/renderer/desktop-workbench.tsx#L177-L190) 的系统设置中新增「通知与提醒」分组（当用户已登录且在线时加载与保存；离线时只读提示）：
- **外部 IM 轻通知总开关**（说明：仅发送事件类型、任务标题、发起人、项目与安全跳转链接，绝不发送会话正文或代码）；
- **订阅事件勾选**：新任务指派给我（`task.assigned`）、提交待我验收（`task.review_requested`）、验收退回修订（`task.returned`）；
- **免打扰时段**：开关 + 开始时间 / 结束时间（支持跨午夜如 `22:00 ~ 09:00`）+ 时区展示（默认读取系统时区或 `Asia/Shanghai`）；
- **同项目连续变更合并窗口**：可选 `不合并 (0s)` / `30 秒` / `60 秒（默认）` / `5 分钟`。

### 6.4 Electron 单实例与 `workbench://` Deep-Link 安全路由

在 [desktop/src/main/index.ts](../../../desktop/src/main/index.ts) 与主进程新增 `deep-link.ts` 中实现跨平台深链接唤醒：

1. **单实例锁与 URL 捕获**：
   - 启动早期调用 `app.requestSingleInstanceLock()`；若竞争失败则立即 `app.quit()`（将唤醒参数交给已有主实例）。
   - 主进程启动时调用 `app.setAsDefaultProtocolClient("workbench")`（预览模式 `__WORKBENCH_UI_PREVIEW__` 下严禁注册，避免污染正式工作台协议关联）。
   - 覆盖全部 3 条 OS 入口：
     - **macOS 热/冷启动**：监听 `app.on("open-url", (event, url) => ...)`；
     - **Windows / Linux 热启动**：监听 `app.on("second-instance", (_event, argv) => ...)`，从 `argv` 中提取唯一以 `workbench://` 开头的参数并恢复/聚焦已有主窗口（若最小化先 `restore()` 再 `show()` + `focus()`）；
     - **Windows / Linux 冷启动**：在 `app.whenReady()` 前后从 `process.argv` 解析初始 `workbench://` URL。
2. **白名单 URL 解析器（`parseWorkbenchDeepLink(rawUrl)`）**：
   - 仅接受协议为 `workbench:` 且 `host === "open"` 的链接（长度上限 512 字节，拒绝非预期字符与额外未声明路径）。
   - 首期合法路由仅 2 种：
     - `workbench://open/inbox` → `{ kind: "inbox" }`
     - `workbench://open/task?workspaceId=<uuid>&projectId=<uuid>&taskId=<uuid>` → 强校验 3 个参数均为合法标准 UUID（拒绝非 UUID 或缺少参数），返回 `{ kind: "task", workspaceId, projectId, taskId }`。
   - **安全拒绝与未登录挂起**：
     - 畸形/未知路由：静默记录诊断告警并向界面提示“无效的跳转链接”，**绝不执行任何动作**；
     - 尚未登录完成时：将已校验通过的 `DeepLinkTarget` 暂存于主进程挂起槽，待渲染层确认登录（`signedIn`）并就绪后投递；登出或切换账号时清空挂起目标；
     - 跨团队/无权限访问：渲染层尝试切换目标 Workspace/Project 并读取任务，若目标不在当前账号所属团队或服务端返回 `403/404`，弹窗/横幅明确提示“当前账号无权访问该任务或已不在对应项目”，**不暴露任务标题或额外信息**。

---

## 7. 错误语义、边界条件与可观察验收清单

### 7.1 新增与复用错误语义

复用 [ApiResponses.java](../../../server/src/main/java/workbench/collaboration/interfaces/http/ApiResponses.java) 与 [collaboration-client.ts](../../../packages/collaboration-client/src/collaboration-client.ts) 的统一错误体系：
- 无效的 `bucket` / `category` / `limit` / 偏好时间或时区非法 → `400 INVALID_REQUEST`（`CLB0001`）；
- 未登录或 Session 失效 → `401 AUTHENTICATION_REQUIRED`（`CLB1001`）；
- 用户在筛选参数中显式指定了不属于自己的 `workspaceId` → `403 WORKSPACE_MEMBER_REQUIRED`（`CLB2003`）；
- 更新通知偏好时 `expectedVersion` 过期 → `409 VERSION_CONFLICT`（`CLB3002`）；
- Deep-Link 目标参数非法 → 本地拦截提示“无效的跳转链接”；跨账号无权限 → 提示无权访问。

### 7.2 边界条件清单

1. **同一操作者自指派 / 自验收**：操作人等于接收人时，不向本人写入 `wb_notification_outbox` 也不入队外部通知（避免自己操作还要给自己推 IM 卡片）。
2. **离职交接与代管验收（对齐 HC-240）**：原 Task 创建人离职或被移除团队后，有效 `Project owner` 在 Inbox「待我处理」中直接看到该项目的 `review` 任务并可点击直达验收；被移出团队或项目的成员在 Inbox 与跨团队通知流中即时失去该项目所有条目可见性，未发出的外部通知也在 `already_resolved` / 成员资格复核时自动取消。
3. **本机待确认与切回体验**：后台同时有 2 个会话处于 `waiting_approval` / `error` 时，Inbox 顶部按最近触发时间倒序依次列出；用户点进其中一个会话处理完毕并完成该轮后，返回 Inbox 时该条自动消退，不影响云端 `counts.actionRequired`。
4. **跨团队 SSE 断线补读**：网络断线重连后，桌面端按最后保存的游标重连 `/api/v1/me/notifications/stream`，同时触发一次 `/api/v1/me/inbox` 全量快照校准，确保既不丢事件也不产生陈旧角标。
5. **外部 IM 开关关闭或通道为 `noop`**：业务写入零报错，出站记录不积压阻塞（调度关闭时不扫描，或开启 `noop` 时正常完成链路验证）；企业侧后续接自研 IM 时，仅需实现 `ExternalNotificationChannel` 并调整配置，零修改任何业务控制器或前端代码。

### 7.3 可观察验收标准（每条均须对应实测或自动化验证）

1. **跨团队全局聚合**：同一账号加入 Workspace A 与 Workspace B，分别在两个团队的 2 个 Project 收到 `todo` 指派与 `review` 待验收，且有 1 个 `doing` 任务；左栏顶部 Inbox 红点严格等于 `todo + review` 数量（不含 `doing`），在「个人」空间下仍可见该角标；进入 Inbox 可见全部跨团队待办且 `urgent`（待验收）排在 `normal`（任务指派）之前；点击条跨团队直达 Task 详情并完成接收或验收后，返回可见该条目消退且角标即时减 1。
2. **方案 A 本机置顶隔离**：在个人会话 A 触发一次工具权限审批或 Plan 确认（进入 `waiting_approval`），切换至「团队」空间或 Inbox：云端角标数字不增加、服务端无任何新入库记录；Inbox 顶部动态出现「本机等待你确认」卡片，点击「回到会话处理」精准切回会话 A；批准后该置顶提醒自动消失。
3. **跨团队实时推送与偏好**：用户停留在「个人」空间时，另一账号向其所在的团队 B 派发新 Task，当前桌面端 Inbox 角标自动增长（无抢焦点/断滚动）；在设置「通知与提醒」中修改免打扰时段与合批窗口并保存，重新打开设置完整恢复，并发过期 `expectedVersion` 返回 `409`。
4. **企业 IM 可插拔出站引擎单测保障**：通过服务端单元与集成测试完整验证：
   - 同项目 60 秒窗口内连续触发多条同类事件自动合并为 1 条汇总卡片；
   - 待办在合并等待窗口内被用户处理或取消，发送前复核自动标记 `skipped(already_resolved)` 不发送；
   - 处于免打扰时段自动顺延 `available_at` 至免打扰结束时刻，关闭订阅或开关则跳过；
   - `SafeNotificationBuilder` 强制截断标题并验证消息体绝不包含任务长描述、会话正文、文件路径等字段；
   - `UserNoRecipientResolver` 正确解析 `wb_user.user_no` 工号并支持自定义替换；
   - 模拟 `ExternalNotificationChannel` 返回 `RETRYABLE_FAILURE` 时按 30s/120s/300s 退避重试并在第 3 次失败后转 `failed`，注入自定义测试实现类零改业务代码即可收到完整结构化卡片与 `workbench://` deep-link。
5. **Electron 单实例与 Deep-Link 唤醒**：冷启动与热启动传入 `workbench://open/task?workspaceId=...&projectId=...&taskId=...` 可聚焦单实例主窗口并定位到目标任务详情；传入畸形 URL 被白名单拦截；未登录态暂存目标并在登录后自动跳转。
