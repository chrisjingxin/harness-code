# Lody 协作能力对照

更新：2026-11-06。服务于 [HC-192](../task/HC-192-协作工作台与会话交接.md) 与 [顶层设计草案](../architecture/多人协作工作台顶层设计.md)。本版按独立 Windows/macOS 桌面项目设计，本机执行、云端共享；原 TUI/独立 Web 退出目标产品，平台与 Harness 通过 ACP 解耦。下文区分参考事实、适配建议与未验证结果。

用户后续明确中间对话和右侧文件/变更沿用本仓库组件；Lody 主要用于新增协作能力/导航参考，不能因参考其消息组件而重写已完成 UI。当前源码的可复用点、旧依赖和 HC-205～208 主责见[既有界面复用边界](192-既有界面复用边界.md)，团队并行与未来云端认领见[并行开发约定](../project/协作任务并行开发约定.md)。

## 引用基线与复核方式

外部源码均使用公开仓库的固定提交链接，发布包使用固定版本。任何开发者可直接查看下列链接，或自行克隆仓库后检出表中提交；不要求具有研究者的本机目录、缓存、提取文件或下载清单。第三方代码只作为研究材料，不因引用而成为项目依赖。

主仓库生产源码阅读基线为 `bbb9adc0b8a632587a760faf78d4232b043e832a`；协作设计文档尚未对应生产实现。Lody 本地参考仍为下表固定提交，没有为本轮调研刷新参考仓库。

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

本节是尚未迁移的源码基线，以下旧路径不是新产品依赖清单。后续迁出组件并删除旧入口时，应同步移除失效链接或将必要历史证据固定到原提交，不为保留文档链接而保留旧运行代码。

- [Web server](../../../packages/cli/src/web/server.ts) 绑定本机地址，提供当前接管页面。
- [PresentationCoordinator](../../../packages/cli/src/presentation-coordinator/coordinator.ts) 在 TUI 与一个 Web 窗口之间转移输入权，拒绝第二个活动渲染连接。
- [WebUiGateway](../../../packages/cli/src/presentation-coordinator/web-ui-gateway.ts) 发布共享 InteractiveController 的视图片段，浏览器没有独立的多人共享服务。
- [RunCoordinator](../../../packages/agent/harness_agent/host/run_coordinator.py) 已有 Thread busy、请求幂等、运行与取消边界，可作为 Harness ACP 入口的业务基础。
- [ThreadPersistence](../../../packages/agent/harness_agent/threads/thread_persistence.py) 保管本机 Transcript 与模型检查点；平台多人历史不能通过共享该数据库文件实现。
- [提及搜索](../../../packages/cli/src/presentation-shared/mention-filter-policy.ts) 当前面向文件、目录与符号链接，需要增加平台会话/消息引用。
- 当前通用入口是本项目 JSON-RPC v3，没有现成的 ACP server。需要独立适配，不能仅更换方法名。
- 当前没有独立 Electron 桌面与多人云服务。双平台安装脚本和源码中的 Windows 分支不能作为桌面安装/打包已验收的证据；现有 CLI 的 Bun/OpenTUI 不应成为桌面 Runner 的依赖。

## 独立产品与复用落点

用户明确本分支可作为与 master 独立演进的新项目；本项目不再沿用原 TUI/Web 产品入口。参考 Lody 表示借鉴其有用模块和职责，不是整体嵌入 Lody CLI，也不是把新增逻辑放进 Harness 内核。目标包名见顶层设计第 4 节，目前均未建立。

| 参考或迁移内容 | 目标归属建议 | 解耦要求 |
| --- | --- | --- |
| 桌面窗口、preload、原生能力与托管 | apps/desktop、apps/runner 装配入口 | 入口负责组合，React 视图不依赖 Electron 主进程或旧 CLI |
| 主题、会话/工具、mentions、共享/交接交互 | packages/workbench-ui | 只消费新平台契约，旧 InteractiveSnapshot/Thread/Run 不成为公共类型 |
| 平台 HTTP/SSE 与设备命令/事件 | packages/workbench-contracts | 新独立包，不扩展或重导出旧 Harness packages/protocol |
| 本机受理/补传、ACP 会话与进程 | packages/runner-core、packages/acp-runtime | 不导入 Harness/旧 CLI；SDK 与适配器固定版本，不混用其内部状态类型 |
| 本机文件与 Git | packages/project-service | 从旧宿主提取后不回引原 Controller，所有 ACP 后端共用 |
| Harness 专有 Trace 与设置 | packages/harness-provider 的 runtime/ui 导出 | 通过通用接口注册，平台不解析 SDK marker，也不按 Agent 名称硬编码专有功能 |
| Harness 推理、工具与上下文 | 独立 Python ACP Agent，现 packages/agent | 只加入接入适配所需变更；用户、设备、交接和引用不进入内核 |

同一仓库保留 Harness 源码仅是维护位置选择，不代表它是桌面/Java/通用 Runner 的必需依赖。验收应包含不安装 Harness/Python 的平台启动和第二 ACP 后端互通，Harness 集成另验；通用包不能依赖可选集成包。新逻辑按功能落包并记录固定来源/许可，不创建同时包含 UI、云业务和内核代码的混合目录。

## 桌面与本机执行的参考边界

| 能力 | 固定源码入口 | 本项目可参考什么 |
| --- | --- | --- |
| 桌面生命周期与托管 | [application.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/electron/src/main/application.ts)、[cli-service.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/electron/src/main/services/cli-service.ts) | 桌面主进程托管本机执行进程，窗口与 Agent 生命周期分别管理，明确退出时收敛进程 |
| Win/Mac 原生窗口 | [window.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/electron/src/main/window.ts) | Mac hiddenInset 与 Windows titleBarOverlay 分别适配，主题和窗口颜色联动 |
| 渲染器到原生接口 | [preload/index.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/electron/src/preload/index.ts)、[ipc-bridge.ts](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/electron/src/preload/ipc-bridge.ts) | 通过 contextBridge 暴露 IPC，而非 React 直接操作文件与子进程；实际隔离配置由本产品 Spec 验证，不整份照抄 |
| 目标平台打包 | [electron-builder.yml](https://github.com/LodyAI/Lody/blob/58f594a27da5262cb51164daf8b6bbd0333c4541/apps/electron/electron-builder.yml) | Windows NSIS、Mac 产物/原生资源与签名配置组织；不继承 Lody 品牌、更新地址、渠道或证书 |

官方 [快速开始](https://lody.ai/zh/docs/quickstart/) 说明桌面默认启动本机 CLI daemon，用户也可将桌面作为其他机器的控制端；[交接指南](https://lody.ai/zh/docs/session-handoff/) 描述接手同一会话、工作树和分支。本项目采用原设备执行、共享历史的方向，不把交接解释为自动迁移代码和 Agent 检查点。

上述代码有真实的 Electron 与进程分层可参考，但公开桌面是 local-only 组合。完整云端业务仍不在公开源码内；本项目需自行实现 Java/TDSQL 服务及设备命令协议，不能把开启原有云标志当作已具备多人能力。原机器离线后可读本项目已同步的云端历史，继续执行等待原机器恢复；这是本项目的明确边界。

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

官方 [同一会话交接指南](https://lody.ai/blog/handoff-claude-code-session/) 描述同事打开已有 live session，沿用原 Agent 配置、工作树与分支后继续操作，与本项目用户间接续目标接近。本版采用本机执行，增加设备/项目登记与明确共享；首版按项目共享，不照搬其全部机器与组织授权模型，也不引入岗位角色。

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
| Harness 现有 React 视图与主题 | 迁入 workbench-ui 后归新产品，保留已确认视觉 | 不回引旧 CLI/状态；Harness Trace 视图单独进入集成包 |
| Lody Electron/本机进程分层 | 优先参考窗口、preload、托管与打包组织 | 与 React UI、Runner、Java 云业务分开；不引入其私有托管云依赖 |
| Lody mentions、平台身份与会话职责 | 优先提取纯逻辑、接口组织与行为测试 | 清理托管云依赖，不直接搬入整个产品入口或样式体系 |
| Lody ACP Runner 与适配器 | 标准生命周期归 acp-runtime，设备协作归 runner-core，专有能力注册集成 | 不通过旧 Harness CLI 或 JSON-RPC 充当通用 ACP；各后端 Win/Mac 能力分别验收 |
| 会话作者、去重、恢复模型 | Java 管理共享业务，Runner 记录实际执行和待补传事件 | 服务端身份/事务、有序事件、设备绑定、本机受理与结果未知边界 |
| Streams / CRDT 与同步示例 | 保留为研究与场景参考 | 首版在线共享采用 TDSQL + SSE，不增加另一套同步业务服务或重写 CRDT 引擎 |
| 现有文件、Git 与 Trace | 按 [功能迁移表](../architecture/多人协作工作台顶层设计.md#101-当前功能迁移与复用清单) 分别迁到 project-service 与 harness-provider | 迁出后删除旧消费者；Java 路由/存共享结果，不解析 marker；保留原功能/测试与内网 SDK 逻辑 |

具体需要移植的纯函数与依赖闭包在 Spec/Plan 逐项登记，注明固定来源、原许可证、项目适配和验证方式。源码链接本身不代表完成依赖审查、已构建或互通。

## 官方技术依据

- [ACP TypeScript SDK](https://agentclientprotocol.com/libraries/typescript)：本机 Client 的协议依赖候选；当前官方 API 与固定 Lody 源码可能不同，不能混用不同版本示例。实施时锁定具体版本并跑真实互通。
- [ACP Java 入口](https://agentclientprotocol.com/libraries/java) 与 [Java SDK](https://github.com/agentclientprotocol/java-sdk)：原服务器执行建议的调研材料，当前本机执行方案不以其为运行依赖。
- [Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[签名与公证](https://www.electronjs.org/docs/latest/tutorial/code-signing)：桌面/原生接口分层与目标平台分发的官方核对入口；不代表已构建、取得证书或完成双平台验收。
- [Spring Boot 系统要求](https://docs.spring.io/spring-boot/system-requirements.html)、[MVC 异步响应](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-async.html)、[SQL 集成](https://docs.spring.io/spring-boot/reference/data/sql.html)：本稿 JDK 21、MVC/SSE、JDBC 组合的核对入口。
- [TDSQL MySQL JDBC 接入](https://cloud.tencent.com/document/product/557/10238)、[使用限制](https://cloud.tencent.com/document/product/557/47511)：实际驱动、内核和迁移工具需在内网实例验证，不照抄旧驱动类名或假设全部原生 MySQL 能力。
- [ACP 初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话恢复](https://agentclientprotocol.com/protocol/v1/session-setup)、[内容块](https://agentclientprotocol.com/protocol/v1/content)：按宣告能力使用通用方法，展示历史不代表私有上下文已经恢复。

## 未验证项

没有运行参考项目、Electron、Runner、Java 服务、真实 Agent、模型请求、TDSQL 或部署。独立分包、TUI/Web 删除、无 Harness/Python 启动、第二 ACP 后端、Win/Mac 安装/休眠、跨设备续聊、数据库与内网 Trace 均是后续目标，没有实现或通过结论。普通 MySQL 测试不能代替 TDSQL 验收。
