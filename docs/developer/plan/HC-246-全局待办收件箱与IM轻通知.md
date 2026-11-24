# HC-246 全局待办收件箱与 IM 轻通知 · 实施计划

[需求卡](../task/HC-246-全局待办收件箱与IM轻通知.md) · [行为规格](../spec/HC-246-全局待办收件箱与IM轻通知.md) · [执行清单](../todo/HC-246-全局待办收件箱与IM轻通知.md) · [用户旅程总纲](../architecture/个人与团队协同用户旅程.md) · [方案 B 交互原型](../previews/personal-team-workbench/README.md)

按四个可演示停点全栈推进（`contracts/`、`server/`、`packages/collaboration-client/` 与 `desktop/`），沿用当前 `harness_lody` 工作区与既有未提交保护原则（不切换分支、不自动提交推送）。每到达一个停点完成必要构建、契约/边界与测试验证并停下请用户确认，全部交付后更新 `docs/user/独立桌面工作台.md` 与架构增量说明。

---

## 模块改动与职责归属

| 层 | 本卡改动范围 | 严守边界 |
| --- | --- | --- |
| `contracts/` | `collaboration.schema.json`、`collaboration.openapi.json`、`fixtures/collaboration.json` | 仅增量追加 `/api/v1/me/*` 契约与 DTO，不破坏既有 `/workspaces/{id}/notifications` 兼容 |
| `server/` | `schema.sql`、`Foundation.java`、Inbox 聚合服务与 `InboxItemSource` / `TaskInboxSource`、用户级跨团队通知流与偏好接口、`ExternalNotification*` SPI 及调度引擎、`TaskAppService` / `WorkspaceAppService` 接入 | 不写死企微/飞书/钉钉；绝不在数据库事务或 HTTP 线程内同步请求外部 IM；绝不让正文进入外部载荷 |
| `packages/collaboration-client/` | `types/collaboration.ts`、`collaboration-client.ts`、用户级跨团队通知订阅服务（`user-updates-service.ts`）与单测 | 零 Node/Electron 依赖；维持 Ajv 严格校验与既有 `ProjectUpdatesService` 稳定 |
| `desktop/` | `shared/` 宿主契约、`main/` IPC 桥接 + 单实例锁 + `deep-link.ts`、`preload/`、`ui/navigation/` 顶置入口、`renderer/` Inbox 页面与方案 A 本机置顶区 + 设置「通知与提醒」 | 不重画中央对话或右侧文件面板；不把本机 `waiting_approval`/`error` 写入云端或混入云端红点；不自动触发 Agent 执行 |
| `docs/` | 同名 Spec/Plan/Todo、`docs/user/独立桌面工作台.md`、`docs/developer/architecture/` 增量 | 所有本地 Markdown 链接与任务编号必须通过 `npm run project:check` |

---

## 停点 1 · 共享契约、数据库结构、跨团队 Inbox 与用户级通知流

1. **数据库与启动校验**：
   - 在 [schema.sql](../../../server/src/main/resources/db/schema.sql) 新增 `wb_user_notification_pref` 与 `wb_external_notification_delivery`（严格遵守 InnoDB、`utf8mb4`、`ascii_bin`、`NOT NULL`、`DATETIME(3)`、`TINYINT` 状态码规范）；
   - 为 `wb_notification_outbox` 新增 `idx_user_id_id (user_id, id)`，为 `wb_task` 新增 `idx_creator_id_status (creator_id, status)`；
   - 在 [Foundation.java](../../../server/src/main/java/workbench/collaboration/infrastructure/contract/Foundation.java) 将 `REQUIRED_TABLES` 增至 22 张表并登记两张新表的必检列清单。
2. **线上契约与夹具**：
   - 更新 [collaboration.schema.json](../../../contracts/schema/collaboration.schema.json)、[collaboration.openapi.json](../../../contracts/openapi/collaboration.openapi.json) 与 [collaboration.json](../../../contracts/fixtures/collaboration.json)，定义 `InboxItem`、`InboxCounts`、`InboxResponse`、`UserNotificationEvent`、`UserNotificationPage`、`NotificationPreferences`、`NotificationPreferencesUpdateRequest` 及 `/api/v1/me/inbox`、`/api/v1/me/notifications`、`/api/v1/me/notifications/stream`、`/api/v1/me/notification-preferences`。
   - 同步登记 [RouteCatalog.java](../../../server/src/main/java/workbench/collaboration/interfaces/http/RouteCatalog.java)。
3. **服务端 Inbox 聚合 SPI 与用户级跨团队通知流**：
   - 新增 `InboxItemSource` 与 `InboxActionabilityChecker` 接口，落地 `TaskInboxSource`（按 `action_required` = 活跃项目 `todo` + `review` 含 HC-240 离职代管、`sent`、`resolved` 30 天内现态投影与 `urgent → normal → updatedAtMs` 排序，在线复核团队与项目成员资格）；
   - 新增 `InboxAppService`、`UserNotificationAppService`、`NotificationPreferenceAppService` 与 `MeController`；
   - 升级 `NotificationStore` / `TaskAppService`：补全离职代管场景 `effectiveCreatorId` 接收人解析，保持 `wb_notification_outbox` 兼容 `task.assigned` / `task.changed`，并在 `/api/v1/me/notifications/stream` 中按活跃 Workspace 分别跟踪单调游标，消除跨团队事务 `id` 交错漏读风险。
4. **纯 TS 客户端封装**：
   - 更新 `packages/collaboration-client/src/types/collaboration.ts`、`collaboration-client.ts`（新增 `getInbox`、`listUserNotifications`、`streamUserNotifications`、`getNotificationPreferences`、`updateNotificationPreferences`）；
   - 新增 `UserUpdatesService`（支持跨团队流重连与退避，断开或终端错误时安全收敛）。

**演示与验证方式**：运行 `npm run contracts:smoke`、Java Maven 对应单测（`ContractsTest`、`FoundationTest`、`InboxAppServiceTest`、`UserNotificationStreamTest`、`NotificationPreferenceAppServiceTest`）及 `collaboration-client` 单测，验证跨两个 Workspace / 多个 Project 聚合 `todo + review`（排除 `doing`）、离职后 Project owner 代管 `review` 出现在 Inbox、移除成员即时消退、跨团队 SSE 实时收到带 `workspaceId` 事件与偏好乐观锁 `409`。

---

## 停点 2 · 面向企业自研 IM 的可插拔外部通知出站引擎与单测保障

1. **三个强类型扩展接口（SPI）与安全构造器**：
   - 在 `server/src/main/java/workbench/collaboration/application/port/` 新增 `ExternalNotificationChannel`（含密封 `DeliveryResult`）、`ExternalRecipientResolver`、`DeepLinkBuilder`；
   - 新增默认实现：`UserNoRecipientResolver`（透传 `wb_user.user_no` 工号）、`WorkbenchSchemeDeepLinkBuilder`（生成 `workbench://open/...` 白名单链接）、`NoopNotificationChannel`（`channelType="noop"`）与 `LoggingNotificationChannel`（`channelType="logging"`）；
   - 实现不可绕过的 `SafeNotificationBuilder`：强制白名单映射事件与单行标题截断（≤ 80 字，清除换行/控制符），硬隔离任务长描述、会话正文、代码与本机路径。
2. **异步出站队列与调度引擎**：
   - 扩展 [WorkbenchProperties.java](../../../server/src/main/java/workbench/collaboration/infrastructure/config/WorkbenchProperties.java) 与 [application.yml](../../../server/src/main/resources/application.yml)，增加 `workbench.notifications.external` 配置段（默认 `enabled: false`、`channel: noop`）；
   - 实现 `ExternalNotificationStore` 与 `ExternalNotificationEnqueuer`：在 `TaskAppService`（`create`、`transition`）与 `WorkspaceAppService`（成员交接转派）同一写事务中写入 `wb_external_notification_delivery`，并在进入终结状态时立即清理同对象同用户未发 `pending` 记录；
   - 实现 `ExternalNotificationDispatcher`：支持定时轮询与单测直调 `dispatchDueBatch()`，完成抢占加锁、`(user_id, merge_key)` 合批合并、偏好与免打扰顺延（跨天时间计算）、发送前 `InboxActionabilityChecker` 现态复核（已处理标 `skipped(already_resolved)`）、渠道调用与 30s/120s/300s 指数退避重试（上限 3 次）。
3. **企业接入说明**：
   - 在服务端代码 Javadoc 与开发文档中给出清晰简洁的企业内 3 步接入自研 IM 示例（实现 `ExternalNotificationChannel` + 注册 Bean + 修改 `application.yml`）。

**演示与验证方式**：通过隔离单元测试与服务集成测试（`SafeNotificationBuilderTest`、`ExternalNotificationDispatcherTest`、`ExternalChannelExtensionTest`）验证：合批合并、窗口内已办取消推送、免打扰顺延、防泄漏安全断言、`user_no` 寻址、可重试失败指数退避、不可恢复失败停发，以及注入一个自定义 `ExternalNotificationChannel` 实现类即可零改动收到标准脱敏卡片与 deep-link。

---

## 停点 3 · 桌面端左栏全局 Inbox、方案 A 本机置顶区与通知设置

1. **宿主端口与预加载桥**：
   - 扩展 `desktop/src/shared/desktop-hosts.ts`（新增 `InboxHost` 接口与 IPC 通道常量）、`desktop/src/main/inbox-ipc.ts`、`desktop/src/preload/` 与 `desktop/src/main/index.ts`；
   - 主进程维持跨团队 `UserUpdatesService` 订阅（遵循登录态与 `isCurrent` 守卫，退出或失效立即中止）。
2. **左栏双轨顶置入口与跨空间提示**：
   - 改造 [desktop/src/ui/navigation/index.tsx](../../../desktop/src/ui/navigation/index.tsx) 与 `navigation.css`：在「个人 | 团队」切换器下方放置全局「收件箱」条目；仅将云端 `counts.actionRequired` 渲染为红点角标，当本机存在非当前查看的 `waiting_approval` / `error` 会话时展示独立的琥珀色本机状态指示（绝不混入云端数字）。
3. **方案 A 本机待确认收集器与 Inbox 主页面**：
   - 在渲染层构建本机待确认会话摘要模型（聚合 `LocalConversations` 与项目内本机会话的 `waiting_approval`（权限审批 / Plan 确认 / Goal 确认 / 澄清问答）与 `error` 状态，排除当前正在查看的会话）；
   - 新建 `desktop/src/renderer/features/inbox/`（`inbox-model.ts`、`use-inbox.ts`、`inbox-page.tsx`、`inbox.css`）：
     - 顶部动态「本机等待你确认」提醒条，点击一键跳回原会话现场处理；
     - 云端「待我处理 / 我发起的 / 已处理（30 天）」分页、团队筛选与类型筛选，支持跨 Workspace / 跨 Project 直达 Task 详情并支持一键返回收件箱；
     - 在 [desktop-workbench.tsx](../../../desktop/src/renderer/desktop-workbench.tsx) 系统设置中新增「通知与提醒」表单面板。

**演示与验证方式**：运行 `npm run dev` 启动桌面端与本地协作服务端：1）在「个人」空间中实时收到跨两个团队的 `todo` / `review` 待办角标，进入 Inbox 按紧迫度排序查看并一键直达 Task 详情完成接收/验收后即时消退；2）在个人会话触发工具权限审批或 Plan 确认后切到看板/收件箱，确认顶部出现「本机等待你确认」而不污染云端计数，点击跳回原会话批准后自动消失；3）在设置页调整通知与免打扰配置并刷新保留。

---

## 停点 4 · Electron 单实例唤醒、Deep-Link 安全路由与全栈收口

1. **Electron 单实例锁与协议注册**：
   - 新建 `desktop/src/main/deep-link.ts`（`parseWorkbenchDeepLink` 强白名单解析 `workbench://open/inbox` 与 `workbench://open/task?workspaceId=...&projectId=...&taskId=...`，校验 UUID，拒绝畸形/未声明路径）；
   - 更新 [desktop/src/main/index.ts](../../../desktop/src/main/index.ts) 与 `window.ts` / `desktop-ipc.ts`：接入 `app.requestSingleInstanceLock()`、正式模式下注册 `app.setAsDefaultProtocolClient("workbench")`、处理 `open-url`、`second-instance` 与冷启动 `process.argv`，支持主窗口恢复聚焦与未登录挂起暂存（登出/切号清空）。
2. **渲染层安全跳转与异常边界**：
   - 渲染层消费 Deep-Link 目标：仅做只读定位跳转（绝不触发 Agent 执行）；若目标团队/项目无权或任务不存在，显示明确无权/不可用提示；
   - 补齐 `desktop/tests/` 单测（`deep-link.test.ts`、`inbox-model.test.ts` 等）。
3. **用户文档、架构增量与全栈核对**：
   - 更新 `docs/user/独立桌面工作台.md`（收件箱、本机待确认隔离、通知偏好与企业 IM 扩展说明）；
   - 同步 `docs/developer/architecture/个人与团队协同用户旅程.md` 或相关架构文档说明外部通知 SPI 与跨团队 Inbox 边界；
   - 运行全栈构建、类型、边界、契约、文档、Java 单测与工作区测试，记录实测证据至 Task 并将状态标为 `待验收`。

**演示与验证方式**：验证冷启动及已有窗口最小化状态下传入 `workbench://open/task?...` 唤醒唯一主窗口并直达任务详情；畸形链接与无权限任务安全拦截提示；完成全套自动化检查并输出实测记录。
