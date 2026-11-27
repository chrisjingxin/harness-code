# HC-256 AI自主维护项目记忆

> 2026-11-26 统筹审查通过并派发完整实施。依次依据 [Task](../task/HC-256-AI自主维护项目记忆.md)、[Spec](../spec/HC-256-AI自主维护项目记忆.md) 执行；停点 0 为已完成的文档审查，原停点 1/2/3 合为本次完整交付的内部顺序，不再等待三轮派发。[Todo](../todo/HC-256-AI自主维护项目记忆.md) 维护勾选状态。

> **2026-11-26 用户交互修订：** 原两入口方案改为仅在管理台查看和编辑两份 MD。此次只删除 conversation-references.tsx 中的记忆专用导入、作用域参数/透传和组件挂载，保留引用业务与其它记忆能力。初版两入口交付/验证历史保留在文末与 Task，由此修订替代当前入口要求。

## 现状、方案与不动边界

旧实现把 Markdown 渲染结果、条目字段和来源证明捆绑，AI 的普通文字更新可能卡在目录确认，再因工具异常导致运行失败。改造将内容交给当前 Agent，宿主只处理身份、文件和并发；保留现有会话基线/变更增量与知识读取，避免覆盖同事已交付的上下文实现。

2026-11-26 只读基线：`harness_lody@dd879aa4`，开工工作区干净。CodeGraph 命令及工具不可用，本次按模块直接读取核对；没有读取真实用户记忆。当前入口与影响面如下：

| 位置 | 当前行为 | 实施动作 |
| --- | --- | --- |
| `desktop/src/main/workbench-context/types.ts`、`memory-store.ts` | entries/YAML、正文重渲染、4/8 KiB 门槛、提案预检/提交 | 改为指定文档 content/hash 读写、大小建议、即时原子保存；一次性旧格式备份迁移，不保留条目运行路径。 |
| 同目录 `service.ts` | 自动登记初始化、来源权限过滤、提案队列、终态提交；DeliveredContext/hash/送达快照 | 删除记忆条目初始化/来源门槛/待提交队列，接入整文即时写；保留 pendingDelivery、知识已读与稳定轮次清理。 |
| 同目录 `mcp-server.ts` | 旧两个记忆工具，conflict/error 自动 isError，64 KiB 请求上限 | 换为 read/update；可恢复记忆结果正常返回；超长请求明确 413；保留身份传输拒绝及两个知识工具、起草凭据用途隔离。 |
| `desktop/src/shared/workbench-context-host.ts`、`shared/index.ts` | 三个目录条目端口及导出 | 替换为 readMemory/updateMemory 和普通 MD 结果类型，迁移所有调用方。 |
| `desktop/src/main/workbench-context/context-ipc.ts`、`preload/index.ts` | list/confirm/remove directory IPC 与记忆专用原生选择器 | 换为两个固定文档 IPC，校验本人会话/登录代次/请求大小；不改真实执行目录的 IPC。 |
| `desktop/src/main/collaboration-ipc.ts`、会话工具卡 | pending/saving/终态结果映射 | 显示即时保存结果，沿同一 requestId/turnId/tool ID；不新增聊天展示协议。 |
| `desktop/src/renderer/features/workbench-context/directory-memory.tsx` | 结构化目录下拉和原生确认 | 改为同目录 `project-memory.tsx` 的轻量 ProjectMemory 组件，复用安全 Markdown、主题与文本框，删除旧组件；不建设新编辑器或版本系统。 |
| `renderer/features/admin/admin-page.tsx`、`admin.css`、`renderer/desktop-workbench.tsx` | 管理台 memory 分区、范围标签与本人会话作用域 | 消费两份 MD 编辑器，标签按账号/Team 表达，保留本人会话授权锚点与空状态。 |
| `renderer/features/collaboration/references/conversation-references.tsx` | 初版曾挂载 ProjectMemory | 按用户修订删除记忆专用导入、memoryScope 参数/透传和组件挂载；保留快照、范围、本人目标会话、草稿及新会话目录选择。 |
| `scripts/workbench/smoke-workbench-context.mjs`、`smoke-context-turns.mjs` 及相关 context/knowledge-draft ACP 夹具 | 旧工具名、pending/终态与条目断言 | 迁移必要受影响夹具与断言，检查新协议及原基线/增量；不保留旧测试入口兼容层。 |

`directory-facts.ts` 仅当最后消费者属于已删除的记忆事实证明时删除；知识适用范围还需要的 Git/仓库识别不删。`TeamKnowledge`、知识草稿/审核、服务端、线上契约、通用 ACP 方法、可选 Agent 内核均不扩展。先通过引用检索确认旧来源登记方法的实际消费者，再删除仅为记忆服务的死代码，不凭名字批量删除。

## 停点 0：可审查的文档链（当前交付）

完成四文档、HC-233 Task/Spec 和长期架构顶部继任说明；同步看板并运行 docs:check/tasks:check。回调统筹给出工具参数/结果、即时保存、迁移和 UI 决策，随后停止。

可观察结果：仅 docs/developer 下文件变化，生产代码和真实用户文件没有变化。Task 保持进行中，文档草案待统筹审查，不冒充整卡待验收。

## 内部步骤 1：普通 Markdown 与数据保护

前置：统筹确认 Spec，包括 hash CAS、无 Team 行为、清空语义、迁移内容保留与实际迁移时机，再派发存储工作；此项已在本轮完整派发中满足。

将 store/types 切换为两份独立文档读写；保留路径保护、短锁、同步临时文件和原子替换；删除旧条目硬门槛。增加合法旧格式识别、原字节备份、来源转为历史说明和损坏只读。测试只用 tmp 样本，不能读取默认用户根；不新建配置、双写或旧工具 alias。

可观察结果：隔离脚本读取普通 MD、按内容版本立即保存；旧格式样本的备份 hash 与原件一致；损坏样本字节不变；8 KiB 以上仍可保存并提示整理。记录必要结果后继续内部步骤 2，完整交付或真实阻塞再回调。

## 内部步骤 2：正式 MCP 即时更新与上下文接线

前置：停点 1 接口稳定，确认共享 service.ts/collaboration-ipc.ts 当前改动归属。

迁移正式 MCP 两工具、service 读写、提示和工具卡；移除 pending/正常终态写回，保留活动轮次、知识读版本及 pendingDelivery 送达机制。新结果不设置记忆业务 isError；认证失效仍按安全边界拒绝。保留请求体技术限制与明确反馈。

复用正式协调器 → ACP → HTTP MCP 的现有受控夹具，迁移旧输入和断言。确认 Agent 读最新内容、立即保存、冲突后仍可调用工具、取消/失败不回滚；首轮完整两份、后续只发变化文档，知识检索/固定版本接点正常；起草凭据没有记忆工具。

可观察结果：tmp 中 MCP 已 saved 的文字在终态前落盘；终态后仍在；工具卡对应原调用；增量夹具中相同正文不重复发送。仅完成必要接点检查，不运行全库回归，记录后继续内部步骤 3。

## 内部步骤 3：管理台 UI 与收口（按用户修订）

初版已替换 shared/preload/IPC 的旧三端口并接入轻量 ProjectMemory。当前保留管理台入口，移除引用预览的记忆挂载及参数；自动注入、MCP、存储、身份和目录授权保持原实现。保留中央聊天、头像、工具 UI、右侧文件/Git 以及原引用流程。

此次只运行 desktop typecheck/build、diff 和文档/任务检查，复用已通过且未受影响的 MCP/存储及管理台组件证据。不新增镜像 JSX 测试，不操控或重启真实 A/B；若需要界面操作，只走 CUA，不沿用旧 CDP 脚本。

收口时更新用户文档、本架构实施状态、Task/Todo/看板及必要冒烟证据，检查仅删除旧 canonical 路径且没有兼容残留。检视 OpenWiki 是否受本卡源变更影响；生成器可用时按仓库约定刷新，不手改生成页，不启动旧 CLI。未完成的真实迁移、双机、Windows/TDSQL 全验收明确留给统筹/HC-204。

可观察结果：引用弹窗不展示两份本人 MD，管理台仍可查看编辑两份 MD；原引用选择与草稿流程保留。保持待验收并回调，不自动归档、提交或推送。

## 验证与风险处理

文档阶段已运行 `npm run tasks:sync`、`npm run docs:check`、`npm run tasks:check`。实施阶段只补能验证本次行为的必要样本与冒烟，命令和输出记入 Task；不为简单文字修改写测试，不复跑无关既有全套。

实际外部编辑存在检查与替换之间的并发窗口，Spec 已写明边界；主路径保证同桌面多会话/UI 的内容版本冲突保护。迁移或权限问题返回实际状态，不尝试“修复”损坏原件；共享文件碰到他人未提交改动时保留并协调。发现协议与 Spec 冲突时先回写上游，不自行扩展后台 API 或换用新模型。

## 初版交付验证历史（2026-11-26）

普通 MD/迁移、MCP/增量、共享端口和两处 UI 消费均已实施，证据和诚实边界见 Task。已批准新版本首次正常访问时惰性迁移；本轮未读取真实用户记忆、未启动真实 A/B。统筹提供 CUA 组件＋mock host 正常编辑保存证据，直接复用；正式 Electron/IPC 两入口的端到端操作及完整失败矩阵仍未验证。OpenWiki 刷新已尝试，当前环境没有 openwiki 命令（退出127），未手改生成页。

## 用户交互修订验证（2026-11-26）

已移除引用预览的项目记忆依赖和挂载，管理台入口保留。desktop typecheck/build、docs:check、tasks:check、git diff --check 均通过。此次未改自动注入、MCP、存储和身份/目录授权，不重跑其既有验证；未操作或重启真实 A/B，保持待验收。
