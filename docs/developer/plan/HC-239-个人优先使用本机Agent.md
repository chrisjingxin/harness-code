# HC-239 个人优先使用本机 Agent · 实施计划

[Task](../task/HC-239-个人优先使用本机Agent.md) · [Spec](../spec/HC-239-个人优先使用本机Agent.md) · [Todo](../todo/HC-239-个人优先使用本机Agent.md) · [方案 B 交互原型](../previews/personal-team-workbench/README.md)

按四个可演示停点全栈推进（`contracts/`、`server/`、`packages/` 与 `desktop/`），沿用当前 `harness_lody` 分支与既有工作区。每到达一个停点走一遍必要构建、边界与真实冒烟后再推进下一停点；界面布局、芯片与发布/停止共享转场严格对照[方案 B 交互原型](../previews/personal-team-workbench/README.md)，同时严格遵守“我的会话按当前选中团队过滤”和“个人会话（含无团队会话）可主动发布到团队 Project”的已确认规则。

---

## 停点 1 · 全栈共享契约、服务端两档发布与停止共享

1. **数据库与启动校验**：在 [schema.sql](../../../server/src/main/resources/db/schema.sql) 的 `wb_conversation` 末尾新增 `share_mode`（`1=full`, `2=summary_only`）、`share_status`（`1=active`, `2=stopped`）和 `stopped_at`（`DATETIME(3) NOT NULL`），并在 [Foundation.java](../../../server/src/main/java/workbench/collaboration/infrastructure/contract/Foundation.java) 的 `REQUIRED_COLUMNS` 中登记这三列。
2. **线上契约与夹具**：更新 [organization.schema.json](../../../contracts/schema/organization.schema.json)、[organization.openapi.json](../../../contracts/openapi/organization.openapi.json) 与 [organization.json](../../../contracts/fixtures/organization.json)，新增 `ConversationShareMode`、`ConversationShareStatus`、`ConversationSummary` 三字段（`shareMode`、`shareStatus`、`stoppedAt`）、`ConversationRegisterRequest` 可选字段（`conversationId`、`shareMode`、`initialBrief`）以及 `POST /api/v1/workspaces/{workspaceId}/projects/{projectId}/conversations/{conversationId}/stop-sharing` 端点定义。
3. **Java 服务端领域与控制器**：
   - 更新 `Conversation.java`、`ConversationPO.java`、`ConversationConverter.java`、`ConversationMapper` / `ConversationRepositoryImpl.java` 与 `ConversationDtos.java`；
   - 更新 `ConversationAppService.java`：支持可选传入 `conversationId` 登记会话头（同 owner + 同项目 + 同 `requestId` 幂等返回，跨项目/他人同 ID 返回 `409 CONFLICT`）、支持登记时写入 `shareMode` 与 `initialBrief`；在 `history()` 中对 `summary_only` 会话恒返回空消息列表与 `syncedSequence: 0`；新增幂等 `stopSharing()` 方法（允许在已归档项目上止损停止共享，首次置 `stopped` 写入 `stopped_at` 并广播 `conversation.brief_updated`）；
   - 更新 `ConversationSyncAppService.java`：对 `shareStatus === "stopped"` 会话返回 `409 CONVERSATION_SHARING_STOPPED`；对 `shareMode === "summary_only"` 会话拒绝非空 `messages` 批次（`400 INVALID_REQUEST`），仅允许推进 `brief`；
   - 在 [ProjectConversationController.java](../../../server/src/main/java/workbench/collaboration/interfaces/rest/ProjectConversationController.java) 暴露 `POST .../stop-sharing` 接口。
4. **纯 TS 客户端与上传账本**：
   - 更新 `packages/collaboration-client/src/types/organization.ts`、`collaboration-client.ts`（新增 `stopSharingConversation()`，扩展 `registerConversation` 与 `ConversationSummary` 解码校验）；
   - 更新 [collaboration-state.ts](../../../packages/collaboration-client/src/collaboration-state.ts)：增加断网续用快照逻辑（当本进程已确认登录、因网络进入 `connectionError` 且 `lastKnownUser` 存在时，`personalIdentity()` 保留账号与已知团队快照并标示离线状态；主动 `signOut` 或收到 `401` 仍立即清空）；
   - 更新 [conversation-uploads.ts](../../../packages/collaboration-client/src/conversation-uploads.ts)：支持按 `shareMode` 发送（`summary_only` 仅传 `brief`、`messages: []`），收到 `409 CONVERSATION_SHARING_STOPPED` 时停止重试、清理待传批次并通知前端收敛为“已停止同步”。

**演示方式**：运行 `npm run contracts:smoke`、Java Maven 测试以及本地服务端冒烟脚本，验证能以 `summary_only` / `full` + 指定 `conversationId` 登记会话、阻断 `summary_only` 上传正文、成功调用 `stop-sharing` 幂等返回并在后续 `sync` 触发 `409 CONVERSATION_SHARING_STOPPED`。

**最小回归**：扩展 `ContractsTest.java`、`FoundationTest.java`、`PersistenceConverterTest.java`、`ConversationAppServiceTest.java`、`ConversationSyncAppServiceTest.java`，以及 `packages/collaboration-client/tests/` 中的 `collaboration-client.test.ts` 与 `collaboration-state.test.ts`（补齐断网续用、`summary_only` 仅传简报与 `409` 停传用例）。

---

## 停点 2 · 执行作用域解耦、本机个人会话独立存储与离线执行

1. **可空作用域与统一标识键（对齐 `HC-233`）**：
   - 修改 `packages/acp-runtime/src/types.ts` 与 [native-binding.ts](../../../packages/acp-runtime/src/native-binding.ts)：`LocalAcpScope` 的 `workspaceId`、`projectId` 改为 `string | null`；`buildNativeBindingIdentity` 剥离 `workspaceId` 与 `projectId`，按 `(bindingNamespace, accountId, conversationId, ...)` 计算；
   - 修改 [local-execution-host.ts](../../../desktop/src/shared/local-execution-host.ts)：`LocalExecutionScope` 支持可空 `workspaceId` / `projectId`，`localExecutionKey` 统一为 `(accountId, conversationId)`；新增 `desktop/src/shared/local-conversations-host.ts` 声明本机个人会话列表、详情读写、重命名、发布绑定与停止共享更新的受限 IPC 端口；
   - 修改 [checkpoints.ts](../../../desktop/src/main/project-service/checkpoints.ts)：`CodeCheckpoints.#scope` 同步剥离 `workspaceId` 与 `projectId`。
2. **独立本机存储 `LocalConversationStore` 与 `PersonalStore` 扩展**：
   - 在 `desktop/src/main/local-conversation-store.ts` 实现按 `<userData>/workbench/local-conversations/<originSha256>/<accountId>/` 隔离的 `index.json` 与 `conversations/<conversationId>.json`（原子写入 `0o600`、4 MiB 超过阈值折叠旧轮次摘要保留最近 20 轮完整、单账号上限 500 条、读损保护）；
   - 更新 [personal.ts](../../../desktop/src/shared/personal.ts) 与 [personal-store.ts](../../../desktop/src/main/personal-store.ts)：`PersonalKey` 的 `conversation` / `sessionWorkspace` 支持 `workspaceId: string | null`、`projectId: string | null`，`AccountPersonal` 增加 `activeView?: "workspace" | "solo"`；当 `projectId === null` 时由 `LocalConversationStore` 校验本机归属，不再调云端 `getProjectConversation`。
3. **协调器授权分离与上下文扩展点**：
   - 改造 [local-execution-coordinator.ts](../../../desktop/src/main/local-execution-coordinator.ts)：
     - 拆分 `authorizeLocal(scope, login)`（纯本机核对登录身份、账号与 `LocalConversationStore` 会话归属，断网照常通过）与上传路由判断（仅当绑定了 `projectId` 且 `shareStatus === "active"` 时投递 `ConversationUploads`）；
     - 每次成功终态优先写入 `LocalConversationStore`；`previousPrompt` 支持从本机历史轮次构造前情；
     - 在 `LocalExecutionCoordinatorOptions` 新增 `contextAssembler?: LocalExecutionContextAssembler` 扩展槽（`workspaceId === null` 时跳过调用，供后续 `HC-233` 接入）。
   - 在 `desktop/src/main/index.ts`、`local-execution-ipc.ts` 与 `desktop/src/preload/index.ts` 注册 `LocalConversationsHost` 具名 IPC 端口。

**演示方式**：通过主进程集成测试或受控 Electron 启动，使用无团队账号或在协作服务端关闭状态下新建本机个人会话、选目录连接本机 ACP Agent 完成多轮对话，重启窗口验证本机会话列表、消息正文、草稿与检查点完整恢复且零云端请求发出。

**最小回归**：更新并新增 `packages/acp-runtime/tests/conformance.test.ts`、`session.test.ts`，以及 `desktop/tests/` 中的 `personal-store.test.ts`、`code-checkpoints.test.ts`、`local-execution-ipc.test.ts` 与新增的 `local-conversation-store.test.ts`（覆盖无团队执行、断网继续、4 MiB 裁剪、写失败保护、跨账号隔离与剥离 `projectId/workspaceId` 后绑定连续性）。

---

## 停点 3 · 对齐方案 B 原型的双轨左栏、登录即用与冷启动预检

1. **方案 B 单层纵向双轨左栏**：
   - 参照 [方案 B 交互原型](../previews/personal-team-workbench/README.md) 改造 `desktop/src/ui/navigation/index.tsx` 与 `navigation.css`：
     - 顶部 `个人 | 团队` 分段切换器（`space-sw-h`，团队 Tab 支持队友更新提示点）；
     - 「个人」空间：`+ 新建个人会话` 按钮、搜索触发器、按当前团队/无团队过滤的「个人会话」列表（按本机目录折叠分组，严守不展示跨团队全部会话的已确认规则）以及底部 `另有 N 个会话已发布，在「团队」空间里` 提示；
     - 「团队」空间：多 Workspace 下拉切换器（切换后同步刷新团队区与个人空间当前团队过滤）、看板/团队知识导航、按 Project 折叠分组的协作会话列表（本机已发布会话 + 队友只读会话及“已停止同步”标志）与未入团空态引导（「回到个人空间」）。
2. **登录即用、离线非阻塞与 Agent 连通性预检**：
   - 改造 [desktop-workbench.tsx](../../../desktop/src/renderer/desktop-workbench.tsx)：移除 `signedIn && workspace` 才进工作台的阻塞分支，未加入任何团队或处于离线续用态（`connectionError` 且有已确认账号）时直接渲染完整工作台主界面；
   - 顶栏/团队区显示非阻塞离线状态提示与“重连”按钮；
   - 在 `desktop/src/renderer/features/session/` 增加本机 ACP Agent 连通性预检卡片：新建会话或检测到无可用 Provider 时调用 `listProviders()`，直观呈现各 Agent 探测状态、失败原因、设置入口与“重新检测”按钮。
3. **个人会话主视图接入**：
   - 复用现有 `ConversationView` 与右侧本机文件/Git 面板承载个人会话读写、目录选择、首轮发送前团队上下文切换（发出首条消息后锁定）及代码检查点回退，支持本地历史与 `LocalConversationStore` 实时同步。

**演示方式**：运行 `npm run dev` 打开正式桌面窗口：1）用未加入团队的账号登录，查看无团队空态与预检引导、回到「个人」空间按目录新建并完成多轮对话；2）用多团队账号登录，在团队 A 与团队 B 之间切换，观察「个人」空间会话列表只展示当前选中团队的个人会话；3）断开本地服务端继续发送本机对话。

**最小回归**：扩展 `desktop/tests/session-model.test.ts` 与导航/工作台渲染单元回归测试，覆盖无团队登录、离线续用态、多团队过滤隔离、预检失败/恢复状态迁移。

---

## 停点 4 · 个人会话发布到 Project（含无团队）、停止共享全链路与文档收口

1. **会话头部芯片与「发布到 Project…」交互**：
   - 对齐方案 B 原型 `sessionMeta` 在会话头部渲染团队上下文芯片（未发消息前可改、发后锁定）与可见性芯片（`仅本人`、`Project 可见`、`仅共享摘要`、`已停止同步`）；
   - 实现「发布到 Project…」弹窗：
     - **已绑定团队会话**仅列同团队活跃 Project；**无团队个人会话**列出当前账号所属各团队下可访问的活跃 Project，并显式提示“当前会话尚未绑定团队；发布后会同步绑定目标 Project 所在的 Workspace 上下文”；
     - 支持选择共享档位（`完整定稿正文` / `仅共享状态与成果摘要`）；完整正文档位提供可勾选的“一并带入发布前已定稿的历史轮次（全量或从第 N 轮起）”，摘要档位支持编辑初始成果摘要；
     - 确认发布后调用 `registerConversation`（复用原 `conversationId`）与按需分批 `syncConversation`，更新本地 `LocalConversationStore` 绑定关系，左栏自动切换至「团队」空间并保持停留在本会话，原生绑定与目录授权不断链。
2. **「停止共享」与 Project 只读只看端展示**：
   - 实现「停止共享」确认弹窗（明示已上传保留只读且已被他人同步的内容无法收回），调用 `stop-sharing` 后更新本地 `LocalConversationStore` 为 `stopped`，左栏自动切回「个人」空间并停留在当前会话；
   - 适配 `desktop/src/renderer/features/session/` 与看板渲染：对 `shareMode === "summary_only"` 队友只读视图展示成果摘要卡片并提示“仅共享状态与成果摘要”；对 `shareStatus === "stopped"` 展示“已停止同步”徽标与只读保留提示；
   - 在发布前上传钩子位置预留本地扫描扩展接口，供后续 `HC-249` 接入脱敏检查。
3. **用户文档与收口**：更新 `docs/user/独立桌面工作台.md`，补充个人优先模式、多团队切换、两档发布到 Project（含无团队会话发布）与停止共享说明。

**演示方式**：启动双桌面账号 + 本地协作服务端：1）张三将一条无团队个人会话与一条团队内个人会话分别以“完整定稿正文（带历史）”与“仅共享状态与成果摘要”发布到 Project，验证发布前后同一会话继续提问无需重绑目录与 Agent；2）李四在队友区查看两类会话（摘要档位仅见摘要无历史、完整档位可拉取定稿）；3）张三点击“停止共享”后继续本机发消息，李四刷新后确认保留只读并显示“已停止同步”且不再收到后续新轮次。

**最小回归**：扩展 `desktop/tests/project-conversation-host.test.ts` 与端侧发布/停止共享集成测试；执行全套验证并记录证据。

---

## 交付核对

收口前运行并核对以下检查（无未验证的跳过项或虚假通过）：
- `npm run build` & `npm run typecheck`
- `npm run check:boundaries -- --self-check` & `npm run contracts:smoke`
- `npm run project:check`
- `npm --workspace @workbench/collaboration-client test`、`npm --workspace @workbench/acp-runtime test`、`npm --workspace @workbench/desktop test`
- `mvn -f server/pom.xml test`
- 将实测命令、结果与演示证据回写 [HC-239 Task](../task/HC-239-个人优先使用本机Agent.md)，状态标为 `待验收` 并执行 `npm run tasks:sync`。
