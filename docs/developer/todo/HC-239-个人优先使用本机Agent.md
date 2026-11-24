# HC-239 个人优先使用本机 Agent · 执行清单

[Task](../task/HC-239-个人优先使用本机Agent.md) · [Spec](../spec/HC-239-个人优先使用本机Agent.md) · [Plan](../plan/HC-239-个人优先使用本机Agent.md) · [方案 B 交互原型（已过期）](../previews/personal-team-workbench/README.md) · [最新协作工作台原型](../previews/collaboration-workbench/README.md)

## 停点 1 · 全栈共享契约、服务端两档发布与停止共享

- [x] 更新 `server/src/main/resources/db/schema.sql` 中 `wb_conversation`（新增 `share_mode`、`share_status`、`stopped_at` 非空列）及 `Foundation.java` 启动必检列清单。
- [x] 更新 `contracts/schema/organization.schema.json`、`contracts/openapi/organization.openapi.json`、`contracts/fixtures/organization.json` 与 `packages/collaboration-client/src/types/organization.ts`，补齐 `ConversationShareMode`、`ConversationShareStatus`、`stoppedAt`、`ConversationRegisterRequest` 可选字段（`conversationId`、`shareMode`、`initialBrief`）与 `POST .../stop-sharing`。
- [x] 实现 Java 服务端登记复用/幂等/冲突检查、`summary_only` 禁传正文（`400`）与 `history` 恒返空、`stop-sharing` 幂等端点（已停止后 `sync` 返回 `409 CONVERSATION_SHARING_STOPPED`）。
- [x] 更新 `CollaborationClient`、`CollaborationState`（本窗口已确认账号断网后保留只读/本机离线可用身份快照，登出或 `401` 立即清空）与 `ConversationUploads`（按档位投递及收到 `409` 停传清理）。
- [x] 查看方式与停点演示验收：补齐契约测试、Java 服务端测试与客户端测试并全部通过；通过 `npm run contracts:smoke` 与本地服务端 API 验证两档登记、正文拦截、停止共享幂等与 `409` 拒绝。

## 停点 2 · 执行作用域解耦、本机个人会话独立存储与离线执行

- [x] 更新 `packages/acp-runtime`（`LocalAcpScope` 可空化、`buildNativeBindingIdentity` 仅按账号与会话计算）与 `desktop/src/shared/`（`LocalExecutionScope`、`localExecutionKey`、`PersonalKey` 及 `LocalConversationsHost` 契约）。
- [x] 实现 `desktop/src/main/local-conversation-store.ts`（按 `<originSha256>/<accountId>/` 隔离的 `index.json` 与单会话 JSON、原子写入、4 MiB 自动折叠旧轮摘要、500 条上限与写失败保护），并扩展 `PersonalStore` 支持无团队/未发布会话草稿与右侧面板状态读写。
- [x] 改造 `CodeCheckpoints` 与 `LocalExecutionCoordinator`：拆分 `authorizeLocal` 与云端发布投递判断，每个成功终态必写本机 `LocalConversationStore`、仅活跃共享会话进入 `ConversationUploads`，预留 `contextAssembler` 扩展槽供 `HC-233` 接入；在 `desktop/src/main/index.ts` 与 `desktop/src/preload/index.ts` 挂载 `LocalConversationsHost` IPC。
- [x] 查看方式与停点演示验收：运行 `acp-runtime` 与 `desktop` 相关单测全部通过；在无团队账号或关闭本地服务端的情况下验证本机会话创建、多轮执行、重启恢复与检查点可用。

## 停点 3 · 对齐方案 B 原型的双轨左栏、登录即用与冷启动预检

- [x] 参照 `docs/developer/previews/personal-team-workbench/` 改造 `desktop/src/ui/navigation/`：实现顶部 `个人 | 团队` 分段切换、「个人」空间按本机工程目录折叠分组展示全部个人会话（不设团队/无团队筛选）、底部已发布提示、「团队」空间多 Workspace 下拉切换与按 Project 折叠分组的协作会话，并提供右键上下文菜单与居中重命名弹窗。
- [x] 改造 `desktop/src/renderer/desktop-workbench.tsx`：移除“未加入团队”阻塞入口，支持断网续用态直接进入工作台（顶栏/团队区提供非阻塞离线提示与重连入口），并实现本机 ACP Agent 连通性预检引导卡。
- [x] 接通个人会话主界面（复用 `ConversationView` 与右侧本机文件/Git 面板），个人空间仅保留本机状态与目录分组展示。
- [ ] 查看方式与停点演示验收：运行 `npm run dev`，演示未入团账号预检并完成个人对话、按工程目录组织个人会话、右键菜单及弹窗重命名、以及断网状态下继续个人对话。（用户明确跳过本轮 agent-desktop E2E 实测，留待验收）

## 停点 4 · 个人会话发布到 Project、停止共享全链路与文档收口

- [x] 对齐方案 B 原型实现会话头部 `sessionMeta` 芯片（共享档位/同步状态）与右侧动作入口。
- [x] 实现「发布到 Project…」弹窗：汇总当前账号所加入团队的活跃 Project 供个人会话发布；支持两档共享（完整正文支持勾选带入已定稿历史分批补传、摘要档位自动随已定稿轮次生成默认摘要并可编辑）与不可收回确认，发布成功后自动切至「团队」空间并停留在当前会话。
- [x] 实现「停止共享」确认弹窗、本地状态切换与空间自动切回「个人」空间，同时在 Project 看板与队友只读视图中准确呈现“仅共享状态与成果摘要”卡片与“已停止同步”只读标志。
- [ ] 查看方式与停点演示验收：运行本地服务端与双桌面账号，走通无团队会话与团队内会话的两档发布、发布前后同一原生会话继续对话不断链、队友按档位同步查看以及停止共享后保留只读不再上传。（用户明确跳过本轮 agent-desktop E2E 实测，留待验收）

## 收口

- [x] 运行全栈构建、类型、边界、契约、Java 单测与工作区测试（`build`、`typecheck`、`check:boundaries -- --self-check`、`contracts:smoke`、`project:check`、`mvn test` 及各包 `test`）。
- [x] 更新 `docs/user/独立桌面工作台.md`，将最终测试与冒烟证据回写 [HC-239 Task](../task/HC-239-个人优先使用本机Agent.md) 并将状态更新为 `待验收`（执行 `npm run tasks:sync`）。
