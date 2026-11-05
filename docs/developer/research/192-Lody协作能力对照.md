# Lody 协作能力对照

日期：2026-11-05。服务于 [HC-192](../task/HC-192-协作工作台与会话交接.md) 与 [顶层设计草案](../architecture/多人协作工作台顶层设计.md)。本文区分已核对的参考实现、本项目的适配选择与尚未验证的结果。

## 引用基线与复核方式

外部源码均使用公开仓库的固定提交链接，发布包使用固定版本。任何开发者可直接查看下列链接，或自行克隆仓库后检出表中提交；不要求具有研究者的本机目录、缓存、提取文件或下载清单。第三方代码只作为研究材料，不因引用而成为项目依赖。

主仓库源码阅读基线为 `bbb9adc0b8a632587a760faf78d4232b043e832a`；当前新增协作文档尚未对应生产实现。

| 项目 | 固定提交 | 验证边界 |
| --- | --- | --- |
| [LodyAI/Lody](https://github.com/LodyAI/Lody/tree/58f594a27da5262cb51164daf8b6bbd0333c4541) | `58f594a27da5262cb51164daf8b6bbd0333c4541` | 固定源码基线；未运行互通验证 |
| [loro-dev/loro](https://github.com/loro-dev/loro/tree/ea1d383e2c106c0233ac6986a998f6af688cf613) | `ea1d383e2c106c0233ac6986a998f6af688cf613` | 固定源码基线；未运行互通验证 |
| [loro-dev/protocol](https://github.com/loro-dev/protocol/tree/1776306b473e2dd618975383c498a282851c1837) | `1776306b473e2dd618975383c498a282851c1837` | 固定源码基线；未运行互通验证 |
| [loro-dev/loro-mirror](https://github.com/loro-dev/loro-mirror/tree/97fd2f0f79aa797e16829435b08727cd6212787b) | `97fd2f0f79aa797e16829435b08727cd6212787b` | 固定源码基线；未运行互通验证 |
| [LodyAI/acp-extension-claude](https://github.com/LodyAI/acp-extension-claude/tree/5b07ae5cbba1ef8a98d35791ca54ad424921ec7d) | `5b07ae5cbba1ef8a98d35791ca54ad424921ec7d` | 固定源码基线；未运行互通验证 |
| [LodyAI/acp-extension-codex](https://github.com/LodyAI/acp-extension-codex/tree/304d594ee59d7ee69c1cd22d9b6b163b639329cf) | `304d594ee59d7ee69c1cd22d9b6b163b639329cf` | 固定源码基线；未运行互通验证 |
| [LodyAI/acp-extension-core](https://github.com/LodyAI/acp-extension-core/tree/ea90d0b23d4f850c66c0f542f53cbc596ef2c62f) | `ea90d0b23d4f850c66c0f542f53cbc596ef2c62f` | 固定源码基线；未运行互通验证 |

其他按需参考材料：[Loro Todo](https://github.com/loro-dev/loro-todo/tree/9be4ea261b08691b6b74c8a76afdf6eeca2e1c89)（协作应用）、[CodeMirror 绑定](https://github.com/loro-dev/loro-codemirror/tree/8bf98874fd8467e2b041e60691820367ec1affe9)（文本/光标协作）、[Deno API 示例](https://github.com/loro-dev/loro-examples-deno/tree/0488b793f58966101c5f71e036a6a369fc4e4428)、[Awesome Lody](https://github.com/LodyAI/awesome-lody/tree/6065dc417f36b83b13aadaf61c5b3df3fcb5f5b7)（工作流资源）、[OMP ACP 适配器](https://github.com/LodyAI/acp-extension-omp/tree/f0572cd904b88f9d80101d9b32ec7d5bffe1b6d1)。这些入口同样固定到已下载阅读的版本；Deno 示例不是服务端模板。

Lody 的其余 ACP 子模块版本可从 [.gitmodules](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/.gitmodules) 和固定提交中的 gitlink 查看，不按各适配器当前主分支推断行为。包版本以 [锁文件](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/pnpm-lock.yaml) 为准。可自行取得所需文件，不依赖预先复制整套参考工程；本项目没有安装或运行这些参考项目。

## 主仓库当前行为

- [Web server](../../../packages/cli/src/web/server.ts) 绑定本机地址，提供当前接管页面。
- [PresentationCoordinator](../../../packages/cli/src/presentation-coordinator/coordinator.ts) 在 TUI 与一个 Web 窗口之间转移输入权，拒绝第二个活动渲染连接。
- [WebUiGateway](../../../packages/cli/src/presentation-coordinator/web-ui-gateway.ts) 发布共享 InteractiveController 的视图片段，浏览器没有独立的多人共享服务。
- [RunCoordinator](../../../packages/agent/harness_agent/host/run_coordinator.py) 已有 Thread busy、请求幂等、运行与取消边界，可作为 Harness ACP 入口的业务基础。
- [ThreadPersistence](../../../packages/agent/harness_agent/threads/thread_persistence.py) 保管本机 Transcript 与模型检查点；平台多人历史不能通过共享该数据库文件实现。
- [提及搜索](../../../packages/cli/src/presentation-shared/mention-filter-policy.ts) 当前面向文件、目录与符号链接，需要增加平台会话/消息引用。
- 当前通用入口是本项目 JSON-RPC v3，没有现成的 ACP server。需要独立适配，不能仅更换方法名。

## Lody 的已确认机制

以下链接均指向上表的固定提交；短文件名是链接标签，完整仓库路径在链接中。

| 能力 | 公开源码入口 | 观察到的行为 |
| --- | --- | --- |
| 工作区数据与持久化 | [doc.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/cli/src/lib/loro/doc.ts) | 创建本地 Repo 与 SQLite 存储，远程传输可随后接入 |
| 展示镜像和历史写入 | [session-mirror.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/shared/src/session-mirror.ts)、[history-writer.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/shared/src/history-writer.ts) | 显示与写入分工，历史变更经过统一入口 |
| 历史存储边界 | [roost.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/shared/src/session-data/roost.ts) | 另有 Roost 历史后端，不能把全部历史描述为固定一种 CRDT 结构 |
| ACP 运行 | [acp-runner.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/cli/src/agent/acp-runner.ts)、[agent-client.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/cli/src/agent/agent-client.ts) | 使用 ACP Client，处理通知和权限请求，保留底层 session 身份 |
| 输入加速与去重 | [session-dispatch-watcher.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/cli/src/session/session-dispatch-watcher.ts)、[rpc.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/loro-streams-rpc/src/rpc.ts) | RPC 可先送达输入，持久历史补偿，按输入 ID 避免再次执行 |
| @对话 | [mention-session-source.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/components/src/components/mentions/mention-session-source.ts) | 显示名称与真实会话 ID 分开，发送时形成可解析链接 |
| 历史读取 | [lody-mcp-server.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/cli/src/mcp/lody-mcp-server.ts)、[session-history-handler.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/cli/src/mcp/session-history-handler.ts) | 按页读取会话历史，引用工作区与授权上下文匹配 |
| 作者身份 | [message-author.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/shared/src/message-author.ts) | 人类身份、消息作者和实际执行配置分别表达 |
| 文件协作 | [code-collab-v2-service.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/cli/src/lib/code-collab/code-collab-v2-service.ts) | 文件操作经机器服务，写入检查原文件摘要，不自动同步全部代码目录 |
| 平台边界 | [local.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/platform/src/local.ts)、[capabilities.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/platform/src/capabilities.ts) | 公开本地模式关闭团队共享等云能力，代码存在不等于默认可用 |
| Claude 协议入口 | [serve.ts](https://github.com/LodyAI/acp-extension-claude/blob/5b07ae5cbba1ef8a98d35791ca54ad424921ec7d/src/serve.ts) | 默认可走 ACP v1，实验 v2 另行选择 |
| Codex 协议入口 | [index.ts](https://github.com/LodyAI/acp-extension-codex/blob/304d594ee59d7ee69c1cd22d9b6b163b639329cf/src/index.ts)、[CodexAcpServer.ts](https://github.com/LodyAI/acp-extension-codex/blob/304d594ee59d7ee69c1cd22d9b6b163b639329cf/src/CodexAcpServer.ts) | 存在 v1/v2 路由及转换，专有扩展仍须匹配 |

Loro 的 [公共入口](https://github.com/loro-dev/loro/blob/ea1d383e2c106c0233ac6986a998f6af688cf613/crates/loro/src/lib.rs) 提供快照和增量导入/导出。它负责数据合并，不能单独替代网络服务、账号关系或执行调度。

## 同步服务与前端示例

| 材料 | 可访问入口 | 用途与边界 |
| --- | --- | --- |
| 当前 Streams 集成测试 | [RPC 集成测试](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/loro-streams-rpc/tests/loro-streams-rpc.integration.test.ts) | 以 `loro dev` 启动临时 SQLite 服务；本项目尚未执行该测试 |
| SQLite Streams 开发服务 | [sqlite-riverrun 0.3.0](https://www.npmjs.com/package/@loro-dev/sqlite-riverrun/v/0.3.0) | 原发布包含 README、类型和 `dist/index.mjs.map` 内嵌源码；提供流读写、快照、SSE 与临时状态，不包含完整云端业务 |
| CLI 开发服务 | [loro-cli 0.6.0](https://www.npmjs.com/package/@loro-dev/loro-cli/v/0.6.0) | 原包的 `dist/cli.mjs.map` 内含 `commands/dev.ts` 与内联服务源码；这不是完整原始构建/测试树 |
| WebSocket TypeScript 服务 | [SimpleServer](https://github.com/loro-dev/protocol/blob/1776306b473e2dd618975383c498a282851c1837/packages/loro-websocket/src/server/simple-server.ts) | 认证、文档加载/保存、房间广播的扩展点；不是当前 Streams 的直接替换件 |
| Rust + SQLite 示例 | [simple-server.rs](https://github.com/loro-dev/protocol/blob/1776306b473e2dd618975383c498a282851c1837/rust/loro-websocket-server/examples/simple-server.rs) | 同步与持久化的另一种组织参考，不是 Java 服务 |
| 多客户端测试 | [e2e.test.ts](https://github.com/loro-dev/protocol/blob/1776306b473e2dd618975383c498a282851c1837/packages/loro-websocket/tests/e2e.test.ts) | 可借鉴双客户端、断线和恢复场景；没有本项目已通过结论 |
| React / Jotai 状态绑定 | [Loro Mirror](https://github.com/loro-dev/loro-mirror/tree/97fd2f0f79aa797e16829435b08727cd6212787b) | 借鉴订阅与状态映射，不因此引入 CRDT 或改变现有主题 |

需要阅读发布包源码时，从对应版本页取得 tarball 并查看其 source map；不需要研究者提取出的副本。也可直接获取 [sqlite-riverrun 0.3.0 tarball](https://registry.npmjs.org/@loro-dev/sqlite-riverrun/-/sqlite-riverrun-0.3.0.tgz) 和 [loro-cli 0.6.0 tarball](https://registry.npmjs.org/@loro-dev/loro-cli/-/loro-cli-0.6.0.tgz)。包完整性以对应版本的 registry 元数据为依据，查看源码不要求执行包脚本。

Lody 对 [streams-crdt 0.19.2](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/patches/@loro-dev__streams-crdt@0.19.2.patch) 和 [sqlite-riverrun 0.3.0](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/patches/@loro-dev__sqlite-riverrun@0.3.0.patch) 有额外补丁；原始 npm 包没有应用这些补丁，选择 Streams 时必须同时研究消费方与补丁。

[Cloud API 契约](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/cloud-api/AGENTS.md) 明确只包含公开操作名和 DTO，不包含 Convex schema、handler、业务实现或部署配置。本轮检查的公开仓库和发布物没有提供完整托管业务后端。同步开发服务与完整云端业务服务应分别描述。

## 用户与交接场景

官方 [同一会话交接指南](https://lody.ai/blog/handoff-claude-code-session/) 描述同事打开已有 live session，沿用原 Agent 配置、工作树与分支后继续操作，与本项目用户间接续目标接近。指南还涉及机器/项目分享；首版采用服务器执行、工作区成员共享，不照搬全部机器授权模型。

| 参考入口 | 已核对的实现 | 本项目采用方式 |
| --- | --- | --- |
| [PlatformUser / PlatformIdentity](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/platform/src/provider.ts) | 用户 ID 与展示资料、会话状态、工作区目录分别表达 | Java 返回普通用户，登录来源隔离在身份入口 |
| [平台 React 订阅](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/platform/src/react.ts) | 页面通过接口读取身份与工作区，不直接依赖特定认证服务 | Java API 接在工作台入口，组件不按账号名或岗位分支 |
| [本地身份与目录注入](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/platform/src/local.ts) | 宿主可注入身份和隐式工作区，本地模式关闭云能力 | 参考注入方式，不把单用户本地模式作为多人平台 |
| [平台测试](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/platform/test/platform.test.ts) | 合成用户与目录验证状态变化及能力边界 | 借鉴用户加载、切换与范围测试；本轮未运行 |
| [消息作者模型](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/packages/shared/src/message-author.ts) | 人类消息按 userId 记录，Agent 展示作者不承担人类授权 | 作者与交接人关联内部用户 ID，不因切换账号改写历史 |

默认预置 `user01`、`user02`、`user03` 普通账号，成员能力相同，不绑定岗位或业务角色。Java 按预置用户名查询启用用户并建立演示会话，成员关系同样来自初始化数据；内网真实登录到内网阶段开发。

Lody 代码支持“身份与登录来源分离”的借鉴，但不证明存在可直接复制的预置账号后端。本项目的交接确认状态、预览时固定引用草稿、Java/TDSQL 数据模型是适配设计，不能描述为 Lody 已交付的相同实现。后续真实账号与内部用户 ID 明确绑定，不按显示名自动合并。

## 复用方式与 Java / TDSQL 取舍

| 材料 | 首版处理 | 需补齐的适配 |
| --- | --- | --- |
| Harness 现有 React 视图与主题 | 提取复用，保持已确认布局、头像与工具表现 | 从 CLI 状态对象转为平台 DTO |
| Lody mentions、平台身份与会话职责 | 优先提取纯逻辑、接口组织与行为测试 | 清理托管云依赖，不直接搬入整个产品入口或样式体系 |
| Lody ACP 适配器 | 优先使用固定版本现有实现 | Java SDK 与通用方法及专有能力分别互通 |
| 会话作者、去重、恢复模型 | 在 Java 中借鉴实现 | 服务端身份、TDSQL 事务、有序事件与执行绑定 |
| Streams / CRDT 与同步示例 | 保留为研究与场景参考 | 首版在线共享采用 TDSQL + SSE，不增加另一套同步业务服务或重写 CRDT 引擎 |
| 现有文件、Git 与 Trace | 按 [功能迁移表](../architecture/多人协作工作台顶层设计.md#101-当前功能迁移与复用清单) 逐项保留 | Java 宿主等价适配，保留原规则与测试夹具；Harness SDK 采集不改 |

具体需要移植的纯函数与依赖闭包在 Spec/Plan 逐项登记，注明固定来源、原许可证、项目适配和验证方式。源码链接本身不代表完成依赖审查、已构建或互通。

## 官方技术依据

- [ACP Java 入口](https://agentclientprotocol.com/libraries/java) 与 [Java SDK](https://github.com/agentclientprotocol/java-sdk)：Java Client、stdio 和示例作为依赖候选，实施前固定发布版本并验证互通。
- [Spring Boot 系统要求](https://docs.spring.io/spring-boot/system-requirements.html)、[MVC 异步响应](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-async.html)、[SQL 集成](https://docs.spring.io/spring-boot/reference/data/sql.html)：本稿 JDK 21、MVC/SSE、JDBC 组合的核对入口。
- [TDSQL MySQL JDBC 接入](https://cloud.tencent.com/document/product/557/10238)、[使用限制](https://cloud.tencent.com/document/product/557/47511)：实际驱动、内核和迁移工具需在内网实例验证，不照抄旧驱动类名或假设全部原生 MySQL 能力。
- [ACP 初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话恢复](https://agentclientprotocol.com/protocol/v1/session-setup)、[内容块](https://agentclientprotocol.com/protocol/v1/content)：按宣告能力使用通用方法，展示历史不代表私有上下文已经恢复。

## 未验证项

没有运行参考项目、Java 服务、真实 Agent、模型请求、TDSQL 或外网部署。源文件与固定版本的可定位性只证明研究依据可复核；真实 ACP 互通、跨设备续聊、数据库适配与内网采集分别留证。普通 MySQL 开发测试不能代替 TDSQL 验收。
