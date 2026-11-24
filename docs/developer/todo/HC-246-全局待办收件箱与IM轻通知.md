# HC-246 全局待办收件箱与 IM 轻通知 · 执行清单

[需求卡](../task/HC-246-全局待办收件箱与IM轻通知.md) · [行为规格](../spec/HC-246-全局待办收件箱与IM轻通知.md) · [实施计划](../plan/HC-246-全局待办收件箱与IM轻通知.md)

执行依据：[HC-246 Spec](../spec/HC-246-全局待办收件箱与IM轻通知.md)、[HC-246 Plan](../plan/HC-246-全局待办收件箱与IM轻通知.md)。每完成一个停点须通过对应测试与可观察验证后再请用户确认推进下一停点。

---

## 停点 1 · 共享契约、数据库结构、跨团队 Inbox 与用户级通知流

- [x] 更新 `server/src/main/resources/db/schema.sql`：新增 `wb_user_notification_pref` 与 `wb_external_notification_delivery` 表，补齐 `wb_notification_outbox(user_id, id)` 与 `wb_task(creator_id, status)` 索引，并同步更新 `Foundation.java` 的 22 张必检表与列清单。
- [x] 更新 `contracts/schema/collaboration.schema.json`、`contracts/openapi/collaboration.openapi.json`、`contracts/fixtures/collaboration.json` 与 `RouteCatalog.java`，定义 `/api/v1/me/inbox`、`/api/v1/me/notifications`、`/api/v1/me/notifications/stream`、`/api/v1/me/notification-preferences` 契约。
- [x] 在服务端实现 `InboxItemSource` / `InboxActionabilityChecker` SPI 与 `TaskInboxSource`（仅 `todo + review` 含离职代管计入 `action_required`，排除 `doing`；支持 `sent` 与 30 天内 `resolved`），实现 `InboxAppService`、`UserNotificationAppService`、`NotificationPreferenceAppService`、`MeController` 与跨 Workspace 游标防漏读 SSE。
- [x] 在 `TaskAppService` 中补全离职代管 `effectiveCreatorId` 通知接收人逻辑，保持 `wb_notification_outbox` 兼容 `HC-220` 事件名。
- [x] 更新 `packages/collaboration-client`（类型、Ajv 校验、API 客户端方法与跨团队 `UserUpdatesService`）并补齐客户端单测。
- [x] 查看方式与停点验证：通过 `npm run contracts:smoke`、Java 单元测试与客户端测试，验证跨团队/跨项目聚合、离职代管验收进入 Inbox、移除成员即时消退、跨团队 SSE 推送与偏好 `409` 乐观锁。

---

## 停点 2 · 面向企业自研 IM 的可插拔外部通知出站引擎与单测保障

- [x] 定义 `ExternalNotificationChannel`（含 `DeliveryResult`）、`ExternalRecipientResolver`（默认 `UserNoRecipientResolver` 读取 `wb_user.user_no`）与 `DeepLinkBuilder`（默认 `WorkbenchSchemeDeepLinkBuilder`）三个强类型 SPI 接口。
- [x] 实现不可绕过的 `SafeNotificationBuilder`（白名单字段映射、单行标题 ≤ 80 字清洗截断，强制禁止会话正文/长描述/文件路径进入外部卡片）及 `NoopNotificationChannel`、`LoggingNotificationChannel`。
- [x] 扩展 `WorkbenchProperties` 与 `application.yml` 的 `workbench.notifications.external` 配置；在 `TaskAppService`、`WorkspaceAppService` 同事务写入 `wb_external_notification_delivery` 并在终结时自动消噪。
- [x] 实现 `ExternalNotificationDispatcher`（抢占发送、`(user_id, merge_key)` 合批、订阅开关与跨天免打扰顺延、发送前 `InboxActionabilityChecker` 现态复核、指数退避重试 30s/120s/300s 上限 3 次）。
- [x] 补全服务端单元与集成测试（覆盖合批、窗口内已办取消、免打扰顺延、防泄漏安全断言、`user_no` 寻址、重试与失败上限、自定义 `ExternalNotificationChannel` 零侵入扩展），并在 Javadoc/文档给出企业内 3 步接入示例。
- [x] 查看方式与停点验证：运行 `mvn -f server/pom.xml test`，确认全部出站引擎与扩展测试全绿通过。

---

## 停点 3 · 桌面端左栏全局 Inbox、方案 A 本机置顶区与通知设置

- [x] 扩展 `desktop/src/shared/desktop-hosts.ts`、`desktop/src/main/inbox-ipc.ts`、`desktop/src/preload/` 与 `desktop/src/main/index.ts`，接入跨团队 `UserUpdatesService`、Inbox 聚合、偏好读写与状态推送 IPC。
- [x] 改造 `desktop/src/ui/navigation/index.tsx` 与样式：在「个人 | 团队」切换器下方放置跨空间全局「收件箱」入口，独立展示云端 `actionRequired` 红点角标与本机等待确认琥珀色指示（绝不混算）。
- [x] 实现桌面端 `desktop/src/renderer/features/inbox/`：按方案 A 在顶部动态置顶非当前查看的本机 `waiting_approval`（权限审批 / Plan 确认 / Goal 确认 / 澄清问答）与 `error` 会话提醒并支持一键跳回原会话；下方呈现云端分段（待我处理 / 我发起的 / 已处理）、团队与类型筛选、跨团队直达 Task 详情与返回。
- [x] 在 `desktop/src/renderer/desktop-workbench.tsx` 系统设置中接入「通知与提醒」偏好配置（外部开关、订阅事件、免打扰时段与合批窗口）。
- [x] 查看方式与停点验证：运行 `npm run dev` 启动桌面端与本地服务端，验证个人/团队双轨均可见跨团队红点、点击直达并即时消退、本机待审批置顶隔离与回跳、设置页偏好保存恢复。

---

## 停点 4 · Electron 单实例唤醒、Deep-Link 安全路由与全栈收口

- [x] 新增 `desktop/src/main/deep-link.ts` 实现 `parseWorkbenchDeepLink` 白名单校验（仅允许 `workbench://open/inbox` 与严格 UUID 的 `workbench://open/task?...`）。
- [x] 更新 `desktop/src/main/index.ts`、`window.ts` 与 `desktop-ipc.ts`：接入 `requestSingleInstanceLock()`、正式模式 `setAsDefaultProtocolClient("workbench")`、`open-url` / `second-instance` / 冷启动参数处理与未登录暂存。
- [x] 渲染层接通 Deep-Link 只读跳转与跨账号/无权限安全提示，补齐 `desktop/tests/` 单测（`deep-link.test.ts`、`inbox-model.test.ts` 等）。
- [x] 查看方式与停点验证：测试冷/热启动传入 `workbench://` 唤起唯一桌面实例并定位目标 Task，验证畸形链接与越权链接安全拦截。

---

## 收口与交付核对

- [x] 更新 `docs/user/独立桌面工作台.md`（全局收件箱、方案 A 本机待确认、通知降噪设置与企业自研 IM 扩展口子说明）并增量同步 `docs/developer/architecture/`。
- [x] 运行全套构建、类型、边界、契约、项目文档与全工作区测试（`npm run build`、`npm run typecheck`、`npm run check:boundaries -- --self-check`、`npm run contracts:smoke`、`npm run project:check`、各 workspace `test` 与 `mvn -f server/pom.xml test`）。
- [x] 将实测命令、结果与演示证据回写 [HC-246 Task](../task/HC-246-全局待办收件箱与IM轻通知.md)，更新状态为 `待验收` 并执行 `npm run tasks:sync`。
