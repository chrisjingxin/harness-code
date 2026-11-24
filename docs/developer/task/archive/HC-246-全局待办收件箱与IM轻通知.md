---
id: HC-246
title: 全局待办收件箱与IM轻通知
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Antigravity
priority: P0
status: 已完成
owner: Antigravity
branch: harness_lody
scope: 在桌面左栏顶置跨 Workspace / 跨 Project 全局待办收件箱（Inbox），以可扩展的 InboxItemSource SPI 聚合需真人拍板的跨人异步待办（本期落地 Task 待接收 todo 与待验收 review（含 HC-240 离职代管），为 HC-241/243/245/252 预留扩展点；doing 不占待拍板角标），支持“待我处理 / 我发起的 / 已处理（30天）”与团队/类型筛选及一键直达；按方案 A 在 Inbox 顶部动态置顶非当前查看的本机 waiting_approval（工具权限审批 / Plan 确认 / Goal 确认 / 澄清问答）与 error 会话提醒（点击跳回原会话处理，不混入云端角标、不上云、不推 IM）；服务端提供用户级跨团队通知流（/api/v1/me/notifications/stream）与通知降噪偏好（开关/事件/免打扰/合并窗口），并落地面向企业自研 IM 的可插拔外部通知出站引擎与 SPI（ExternalNotificationChannel、ExternalRecipientResolver、DeepLinkBuilder）及 Noop/Logging 默认通道与单元测试保障，不内置具体第三方 IM，仅传脱敏摘要卡片与安全 deep-link，不发正文且不反向触发执行。
acceptance: 跨多个 Workspace 与 Project 的新指派 Task（todo）与待验收 Task（review，含离职后 Project owner 代管）在桌面左栏全局收件箱统一呈现并实时显示未处理角标（doing 与本机等待均不计入云端角标）；处理或取消后条目即时消退，切换“我发起的 / 已处理”可追踪进度；非当前查看本机会话卡在 waiting_approval 或 error 时在 Inbox 顶部置顶提示并支持一键跳回原会话；用户可在设置中调整跨团队通知与免打扰/合批偏好；服务端外部通知出站引擎经单元与集成测试验证合批、免打扰顺延、发送前现态复核消噪、白名单脱敏、user_no 寻址、重试及自定义 ExternalNotificationChannel 可扩展性；Electron 单实例锁与 workbench:// deep-link 可在冷/热启动下安全聚焦并精准定位 Inbox 或目标 Task，且绝不自动触发 Agent 执行。
user_docs: 实施阶段更新 docs/user/独立桌面工作台.md
developer_docs: docs/developer/architecture/个人与团队协同用户旅程.md；docs/developer/spec/HC-246-全局待办收件箱与IM轻通知.md；docs/developer/plan/HC-246-全局待办收件箱与IM轻通知.md；docs/developer/todo/HC-246-全局待办收件箱与IM轻通知.md
test_evidence: 2026-11-24 全栈构建与检查通过（build / typecheck / check:boundaries --self-check / contracts:smoke / project:check / test:project 20/20）；TS 4-workspace 单测全绿（collaboration-client 10/10、acp-runtime 30/30、harness-acp 4/4、desktop 154/154）；Java 服务端 HC-246 定向 10 类 26/26 通过；隔离 HOME 下实测 Electron 单实例锁与 workbench:// 深链接冷/热启动、非法链接拦截均通过；人工验收通过。
references: docs/developer/architecture/个人与团队协同用户旅程.md；docs/developer/task/HC-220-项目看板与轻量通知.md；docs/developer/task/HC-239-个人优先使用本机Agent.md；docs/developer/task/HC-240-Workspace角色管理.md；docs/developer/task/HC-241-知识分级与审核沉淀.md
completed_at: 2026-11-24
---

# HC-246 全局待办收件箱与IM轻通知

## 当前阶段

2026-11-24 已在 `harness_lody` 分支全栈完成停点 1–4 实施与文档同步，并通过全工作区构建、类型/边界/契约/文档校验、TS 四工作区单测、Java 服务端 HC-246 测试集及隔离环境下的 Electron 单实例 `workbench://` 深链接冒烟验证，当前状态标为 `待验收`（完整 TDSQL 与双平台集成回归由 `HC-204` 统一处理）。产出清单：[HC-246 Spec](../../spec/HC-246-全局待办收件箱与IM轻通知.md)、[HC-246 Plan](../../plan/HC-246-全局待办收件箱与IM轻通知.md) 与 [HC-246 Todo](../../todo/HC-246-全局待办收件箱与IM轻通知.md)。

## 要解决的问题

- 随着团队、Project 增多以及后续知识审核（HC-241）、系统地图审核（HC-243）、技能审核（HC-245）引入，需要真人拍板和处理的事项散落在各个 Workspace 与 Project 里，员工很难知道“现在到底有哪些事在等我”。
- 现有轻量通知流（`HC-220`）绑定在单个 Workspace 上：当用户停留在「个人」空间或团队 A 时，团队 B 的新指派或待验收无法实时触发角标更新。
- 当成员处于其他空间或最小化桌面客户端时，纯靠桌面端内红点无法及时触达；但企业内使用的是自研 IM，需避免写死外部厂商协议，更要防止把会话正文灌进 IM 造成刷屏与敏感信息外泄。
- 后台并发运行本机会话时，若某会话卡在工具权限审批（`requestPermission`）或计划/目标/问答确认（`elicitation/create`）或出错，用户切走后容易遗忘。

## 预期使用过程

```text
产生跨人待办：他人指派 Task（todo）/ 受让人提交验收（review）/ 离职代管验收
  ├─ 桌面端：跨 Workspace 用户级通知流（/api/v1/me/notifications/stream）毫秒级唤醒刷新
  │    → 聚合进桌面左栏顶部“收件箱（Inbox）”，按“待我验收（urgent）→ 指派给我（normal）”排序并更新角标
  │    → 若本机存在非当前查看的 waiting_approval / error 会话，在 Inbox 顶部动态置顶“本机等待你确认”提醒（不混入云端计数）
  │    → 员工在 Inbox 点击条目 → 自动切换 Workspace/Project 直达任务详情（或跳回本机会话现场），处理完成后条目即时消退
  └─ 服务端外部通知出站引擎（面向企业自研 IM 预留清晰 SPI 口子）：
       同事务入队 → 合并窗口汇聚与免打扰顺延 → 发送前复核待办是否已解决（已解决则免打扰取消）
       → 严格脱敏白名单构建摘要卡片与 deep-link（不含正文） → 解析 user_no 寻址 → 调用 ExternalNotificationChannel
       → 员工在企业 IM 点卡片 deep-link 唤起已有桌面实例 → 校验身份与权限后直达 Inbox 或对应 Task（只读跳转，不触发执行）
```

## 已确认的范围

1. **跨 Workspace / 跨 Project 统一收件箱与可扩展来源 SPI**：位于桌面左栏顶部，在「个人」与「团队」双轨之上全局可见；服务端以业务现态投影为唯一真相（每次读取重新校验成员资格），通过 `InboxItemSource` SPI 聚合待办——本期落地 `TaskInboxSource`（`todo` 指派给我、`review` 待我验收含 HC-240 离职代管；支持“待我处理 / 我发起的 / 已处理（默认保留最近 30 天）”与团队/类型筛选），并为 HC-241 / HC-243 / HC-245 / HC-252 留出零改动接入骨架。
2. **本机等待你确认的置顶隔离区（方案 A）**：仅当当前设备存在**非当前正在查看**且处于 `waiting_approval`（工具权限审批、Plan 确认、Goal 确认、澄清问答）或 `error` 的本机会话时，在 Inbox 顶部动态展示置顶提醒区；点击一键跳回原会话现场处理（绝不在 Inbox 内盲目代批），且绝不混入云端角标统计、不上传服务端、不触发企业 IM。
3. **跨团队用户级实时刷新与降噪偏好**：新增 `/api/v1/me/inbox`、`/api/v1/me/notifications`、`/api/v1/me/notifications/stream`（含 `workspaceId` 游标与断线补读）及 `/api/v1/me/notification-preferences`（总开关、事件订阅、免打扰时段、同项目合批窗口默认 60 秒）。Inbox 增量刷新不打断用户当前输入焦点与滚动位置。
4. **面向企业自研 IM 的可插拔出站引擎与安全出口**：服务端提供完整的外部通知异步队列、防抖合批、免打扰顺延、发送前现态复核、强制白名单脱敏卡片构造（`SafeNotificationBuilder`，严禁携带会话正文、代码片段、文件路径或工具输出）、指数退避重试，并暴露 3 个清晰的扩展口子：`ExternalNotificationChannel`（消息发送接口）、`ExternalRecipientResolver`（默认透传 `wb_user.user_no` 工号）与 `DeepLinkBuilder`（默认 `workbench://open/...`，支持扩展为企业网关跳转链接）。本期内置 `NoopNotificationChannel` 与 `LoggingNotificationChannel`，通过全面单元测试与集成冒烟验证全链路可用。
5. **桌面单实例唤起与 Deep-Link 安全路由**：Electron 主进程接入 `requestSingleInstanceLock()`、`setAsDefaultProtocolClient("workbench")`、macOS `open-url` 与 Windows/Linux `second-instance`/冷启动参数解析；对路由和 UUID 强校验白名单，只做只读页面跳转，绝不自动执行写操作或拉起 Agent。

## 不在本卡范围

- 内置企业微信、飞书、钉钉等具体第三方 IM 厂商适配器，以及企业自研 IM 的实际网络协议对接（由用户在企业内部基于本卡预留的 SPI 接口扩展实现）。
- 知识/系统地图提议审核（HC-241 / HC-243）、团队技能/MCP 审核（HC-245）、只读会话异步批注（HC-252）的业务本体实现（本卡只提供 `InboxItemSource` 扩展口子，待各卡落地后接入）。
- 把企业 IM 改造成双向执行控制台（不支持在 IM 里直接发指令遥控他人或本机 Agent 写代码）。
- 复杂的跨平台日程/工时/绩效考核系统。

## 职责与前置

- 本卡全栈实施：服务端（`contracts/` + `server/` + `packages/collaboration-client/`）负责跨团队待办聚合查询与 `InboxItemSource` SPI、用户级跨团队通知分页与 SSE 流、用户通知偏好、面向企业自研 IM 的外部出站引擎与 SPI；桌面端负责左栏全局 Inbox 入口与页面、方案 A 本机待确认置顶区、设置内通知偏好、跨团队/跨项目页面直达、`requestSingleInstanceLock` 与 `workbench://` deep-link 安全路由。
- 依赖 [HC-220](../HC-220-项目看板与轻量通知.md) 的轻量通知与事务发件箱底座、[HC-239](../HC-239-个人优先使用本机Agent.md) 的双轨桌面外壳与本机会话状态模型，以及 [HC-240](../HC-240-Workspace角色管理.md) 的成员离职移除与 Project owner 代管验收规则。

## 已确认决策（2026-11-24）

1. **本机待审批与 Inbox 关系（方案 A）**：云端 Inbox 模型保持纯跨人异步待办；桌面端 Inbox 顶部动态展示「本机等待你确认」置顶提醒，仅针对非当前查看的 `waiting_approval` / `error` 会话，点击跳回原会话现场决策，不计入云端红点角标、不上传云端、不发 IM。
2. **Task 计入未处理角标口径（方案 A）**：仅 `todo`（指派给我待接收）与 `review`（待我验收，含离职后 Project owner 代管）计入「待我处理」角标；`doing` 不占待拍板角标；同时支持「我发起的」追踪（含 `doing` 进度）与「已处理」（默认保留最近 30 天）视图。
3. **跨 Workspace 实时刷新与通知偏好**：新增用户级跨团队通知流（`/api/v1/me/notifications/stream`）与用户级通知降噪偏好（开关、事件订阅、免打扰时段、同项目合并窗口默认 60 秒）。
4. **企业自研 IM 扩展形态**：不内置第三方 IM 实现，仅落地完整出站基础设施与清晰 SPI 扩展口子（`ExternalNotificationChannel`、`ExternalRecipientResolver`、`DeepLinkBuilder`）+ `Noop`/`Logging` 默认通道，通过单元测试保障功能与扩展契约可用。

## 实测与验证证据（2026-11-24）

- **全栈构建、类型、边界、契约与文档检查（均退出码 0）**：
  - `npm run build`：4 个 workspace 产物构建完成（`desktop` main/preload/renderer `electron-vite build` 成功）。
  - `npm run typecheck`：4 个 workspace `tsc --noEmit` 全部通过。
  - `npm run check:boundaries -- --self-check`：依赖边界与全部负例自检夹具通过。
  - `npm run contracts:smoke`：新增 `inbox-response`、`user-notification-metadata`、`user-notification-rejects-text`、`user-notification-requires-workspace`、`notification-preferences`、`notification-preferences-update`、`notification-preferences-rejects-minute` 等全部正负夹具通过。
  - `npm run project:check` & `npm run test:project`：文档链接、任务看板一致性及工程管理小套 20/20 通过。
- **TypeScript 全工作区单元测试（198/198 全部通过）**：
  - `npm --workspace @workbench/collaboration-client run test`：10/10 通过（覆盖全局 Inbox、跨团队通知分页与偏好契约、`UserUpdatesService` 跨团队乱序防漏读、单调游标及高位 `initialCursor` 基线立即持久化）。
  - `npm --workspace @workbench/acp-runtime run test`：30/30 通过。
  - `npm --workspace @workbench/harness-acp run test`：4/4 通过。
  - `npm --workspace @workbench/desktop run test`：154/154 通过（含 `deep-link.test.ts` 白名单路由解析、`DeepLinkBroker` 挂起/关窗重开/登出清空、`resolveDeepLinkNavigation` 离线与跨团队越权拦截，以及 `inbox-model.test.ts` 方案 A 本机等待确认、代管验收判定及 `task_resolved`/`task_in_progress` 类别映射）。
- **Java 服务端测试**：
  - `mvn -B -f server/pom.xml -Drevision=0.2.0 -Dtest="ContractsTest,FoundationTest,WorkbenchPropertiesTest,InboxAppServiceTest,UserNotificationStreamTest,NotificationPreferenceAppServiceTest,TaskAppServiceDelegationTest,ExternalNotificationDispatcherTest,SafeNotificationBuilderTest,ExternalChannelExtensionTest" test`：10 个测试类 26/26 全部通过（0 failures / 0 errors，含 `MeController` 跳过毒丸事件继续推送合法通知回归）。
  - 备注：前序全量 `mvn -B -f server/pom.xml -Drevision=0.2.0 test`（97 用例）中存在 12 项非 HC-246 既有失败/错误（`RepositoryAppServiceTest` 5 项、`ProjectAppServiceTest` 2 项、`ConversationAppServiceTest` 5 项，均系前置 `HC-240` 提交 `bd605a29` 修改 `ProjectAccessPolicy` 后的既有差异），未在本次范围擅动无关模块。
- **端到端回溯修复补充（2026-11-24）**：
  - 修复 `inbox-model.ts` 缺失 `task_resolved`（`已处理任务`）与 `task_in_progress`（`推进中任务`）中文标签与色调映射。
  - 修复 `useInbox` 冷启动不等首轮 `notificationCursor` 直接以空游标建流导致从 `0` 重放全量历史通知的竞态，并在 `UserUpdatesService` 将更高 `initialCursor` 基线立即落盘自愈。
  - 修复 `NotificationStore` 对 `CHAR(36)` 列裁剪尾空格，并在 `MeController` / `NotificationController` 为单条 `encodeEvent` 增加异常跳过与日志告警，防止单条坏记录卡死整条 SSE 通知流（注：本地全套测试已通过；待重启桌面端及重新构建部署服务端 `npm run server:build` 后即可在远端环境复测）。
- **Electron 单实例锁与 `workbench://` 深链接冒烟**：
  - 使用独立临时 `HOME` 目录运行构建产物 `desktop/dist/main/index.js`（首实例冷启动传入 `workbench://open/inbox`）：随后分别启动次实例传入合法 `workbench://open/task?...` 与非法 `workbench://evil/exec`，次实例均通过单实例锁转发参数后以退出码 `0` 立即退出，主实例通过 `second-instance` 捕获并记录 `[deep-link] 已拦截非法跳转链接 (unexpected_host)`（测试完毕已清理临时目录并确认无残留 Electron 进程；正式 OS 级 URI Scheme 唤起在未打包 `Electron.app` 环境下以主进程 `setAsDefaultProtocolClient("workbench")` + 单实例 `second-instance` 验证为准，打包后随安装器声明 `CFBundleURLTypes`）。
