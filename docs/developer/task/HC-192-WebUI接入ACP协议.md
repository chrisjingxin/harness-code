---
id: HC-192
title: WebUI接入ACP协议
feature_area: Web UI 与 Agent 通信协议（ACP）
parent_task: -
decomposed_by: Kiro
priority: P1
status: 进行中
owner: 张景新
branch: feat_hc_192_WebUI接入ACP协议
scope: Python Agent 新增标准 ACP（Agent Client Protocol）的 stdio 入口 `harness acp`；新增 `harness web` 入口，由 Bun 进程启动 `harness acp` 子进程、提供网页文件、打开浏览器，并在浏览器 WebSocket 与子进程 stdio 之间原样转发 ACP 消息；浏览器里的新 Web 界面复用现有 React 组件，只新增「ACP 到界面状态」的适配层。第一期只做标准 ACP 能覆盖的能力，ACP 覆盖不了的功能暂时不提供，并登记在「ACP 缺口登记表」里留给后续阶段。现有 TUI、`/web` 接管、无头模式和 JSON-RPC v3 全部保持不变，TUI 下线另开 Task。
acceptance: 运行 `harness web` 后自动打开浏览器并出现对话界面；能发送消息并实时看到回复、思考和工具卡片；工具审批卡片能显示文件 diff 并正确放行或拒绝；能取消正在运行的任务；刷新页面或重新打开后能恢复历史会话；Agent 侧斜杠命令可用；不带 token、token 错误、Origin 不合法的浏览器连接被拒绝；用官方 ACP SDK 写的最小客户端直接启动 `harness acp`，能通过 stdio 完成握手并对话一轮，且 stdout 上只有合法 ACP 消息；原 TUI、`/web`、无头模式的行为和测试不变；「ACP 缺口登记表」逐项写明现状、ACP 缺什么、建议的扩展方式；缺口表使用 GAP 编号并在界面、终端、用户文档中可见，且每组缺口在看板上有后续 Task；Python 与 TypeScript 两端的相关测试和 `npm run project:check` 通过。
user_docs: docs/user/Web界面.md、docs/user/快速开始.md
developer_docs: docs/developer/spec/HC-192-WebUI接入ACP协议.md、docs/developer/plan/HC-192-WebUI接入ACP协议.md、docs/developer/todo/HC-192-WebUI接入ACP协议.md；完成后新增或增量修订 docs/developer/architecture/ 下的 ACP 架构文档，并同步 架构总览.md
test_evidence: -
references: tmp/handoff.md（本地交接稿，不入库）、docs/developer/research/168-dcode功能差距.md、docs/developer/architecture/adr/0002-project-host-multi-connection.md、docs/developer/architecture/adr/0003-single-interactive-core-dual-renderer.md、https://agentclientprotocol.com/protocol/transports、https://agentclientprotocol.com/protocol/extensibility
completed_at: -
---
# HC-192 WebUI接入ACP协议

## 需求来源与当前阶段

2026-11-05，用户计划最终只保留 Web UI、不再保留终端 TUI，并把 Web UI 包装成 Electron 桌面端；同时希望这个界面以后能通过 ACP 接入多种 Agent，而不只是自家 Agent。因此 Web UI 对外只应该有一套协议，就是 ACP。

经过对话确认，本任务只做第一步：**让 Web UI 通过标准 ACP 与自家 Agent 通信**。接入第三方 Agent、Electron 打包、补齐 ACP 缺口、TUI 下线都是后续 Task。

当前阶段：Task 与 Spec 均已由用户确认；[Plan](../plan/HC-192-WebUI接入ACP协议.md) 和 [Todo](../todo/HC-192-WebUI接入ACP协议.md) 已写成，等待用户确认后开始实现（尚未认领、未建分支、未改代码）。本任务改动跨进程协议，不属于快速通道，走完整流程：Task → Spec → Plan → Todo → 实现 → 检视。

## 通俗说明

现状：浏览器连的不是 Agent，而是 Bun/TS 进程里的 `WebUiGateway`。这个网关把 Agent 的事件整理成 8 个「视图切片」（`state.replace` / `state.patch`），再把浏览器发来的 25 种操作（`interactive.intent`）翻译成 JSON-RPC v3 调用 Python。这一整层是为了「TUI 和 Web 共用一个交互核心、可以互相接管」才有的。

痛点：这套协议是自研的，只有我们自己的前端能用。如果 Web UI 以后要接多种 Agent（它们最多只会说 ACP），就得在界面里同时维护「自有协议」和「ACP」两套客户端代码，每个界面功能都要接两遍。

做法：
1. Python Agent 增加一个标准 ACP 入口 `harness acp`，通过 stdio 收发 ACP 消息。ACP 目前正式定义的传输就是 stdio，Zed、官方 SDK 和绝大多数 ACP Agent 都是这样被客户端当子进程启动的，所以这是接入一切 ACP 客户端的基础。
2. 新增 `harness web`：Bun 进程启动 `harness acp` 子进程，提供网页文件、打开浏览器，并充当一座「桥」，把浏览器 WebSocket 里的 ACP 消息和子进程 stdio 来回原样转发，不解析内容。
3. 浏览器里的新界面直接是一个 ACP 客户端，复用现有 React 组件，中间只加一层「ACP 消息 → 组件能读的状态」的适配层。
4. 以后做成 Electron 时，主进程用同样的方式启动 `harness acp`（或任何别的 ACP Agent）并通过 Electron 内部通道转给界面，不再需要 WebSocket 桥。

一次 `harness web` 的链路：

```text
用户运行 harness web
  → Bun 进程：启动 `harness acp` 子进程、提供网页文件、打开浏览器（URL 带一次性 token）
  → 浏览器：带 token 向 Bun 的 WebSocket 建立连接
  → Bun：校验 Host、Origin、token → 通过后开始原样转发
  → 浏览器作为 ACP 客户端：initialize → session/new 或 session/load
  → 用户发送消息：session/prompt
      Agent 推送：session/update（文字、思考、工具调用、计划）
      需要审批：session/request_permission → 浏览器弹卡片 → 用户选择 → 返回结果
  → 用户取消：session/cancel
```

一个进程只说一种协议：`harness acp` 启动时 stdio 说 ACP，原来的 `harness`（TUI）和无头模式启动时 stdio 仍说 JSON-RPC v3。两者共用 Python 内部同一套 Run 调度、审批策略和会话存储，不会出现两套审批或两套 Run 状态。

改后收益：Web 与 Agent 之间使用公开标准，Zed、官方 SDK、以后的 Electron 都能直接对接；Python 不需要监听任何网络端口；Web 路径不再依赖 `WebUiGateway`、`PresentationCoordinator`（这一层在 TUI 下线时一并删除）。

## 已确认的决策

1. **范围**：本任务只做 Web UI ↔ 自家 Agent 改用 ACP；不下线 TUI（用户确认：先做 ACP，稳定后单独下线 TUI）。
2. **终态**：产品最终形态是 Electron 桌面端，不是纯浏览器访问；Web UI 对外只说 ACP（用户确认）。
3. **传输方案**：标准 stdio 是主路径，Python 新增 `harness acp` 入口；`harness web` 的 WebSocket 只是浏览器调试用的薄桥，放在 Bun 进程里，Python 不监听网络端口（用户确认；取代此前「Python 起 WebSocket」的方案）。
4. **一期能力边界**：只做标准 ACP 能覆盖的能力。一期 Web 功能比现在的 Web 少是可以接受的，但**少了什么必须记录**（见「ACP 缺口登记表」），不能悄悄丢。
5. **新入口**：`harness web`（用户确认）。原 `harness` 的 TUI 和 `/web` 接管保持不变，直到 TUI 下线 Task。
6. **前端复用**（用户确认）：复用现有 React 组件，只新增一层「ACP → 界面状态」的适配层，不重写界面。Spec 阶段只需要核实哪些组件可以直接复用、一期没有数据的组件如何隐藏或置灰。
7. **扩展原则**：ACP 覆盖不了的自家功能，以后走 ACP 官方的扩展机制（`_meta` 字段、以 `_` 开头的自定义方法、在初始化时用 `_meta` 声明扩展能力）；界面按「Agent 是否声明了该扩展」决定显示或隐藏对应面板，连接第三方 Agent 时自动退化为标准 ACP 功能。本任务一期只做标准能力；唯一的例外是用 `_meta` 携带审批的完整 diff 等展示信息（Spec D-5），并且只发给在 `initialize` 里声明了扩展的客户端，其它客户端行为完整。扩展前缀为 `_meta.harnessCode` 与 `_harnessCode/`（用户确认，见 Spec §4.4）。

8. **缺口治理**（用户要求）：一期功能比现在的 Web 少可以接受，但必须有记录，最终不可接受。缺口表使用固定编号 `GAP-xx`（Spec §12.3），权威版本迁入架构文档；缺口在界面和终端可见，不静默；归档前为每组缺口建好后续 Task；TUI 下线 Task 的前置条件是缺口表没有「未开始 / 进行中」的行（要么已关闭，要么用户确认放弃）。
9. **刷新页面会重启 Python 并取消运行中的任务**（用户确认可接受，登记为 GAP-20）：Electron 阶段由主进程常驻子进程解决。

## 范围

1. **Python 侧 ACP stdio 服务**：新增 `harness acp` 入口，stdout 只输出合法 ACP 消息（诊断走 stderr），支持 `initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`、`session/update`、`session/request_permission`，并按需声明 `loadSession` 等 Agent 能力。内部复用现有 `RunCoordinator`、审批策略和会话存储。
2. **Bun 侧 `harness web` 桥**：启动 `harness acp` 子进程、提供网页文件、打开浏览器；WebSocket 与 stdio 之间每条消息原样转发，不解析 ACP 内容。
3. **桥的安全**：只绑定 127.0.0.1；校验 Host 与 Origin；一次性 token 且有有效期；单帧大小有上限；子进程退出时关闭连接，连接断开时结束子进程。这部分尽量复用 `packages/cli/src/web/server.ts` 里已有的校验逻辑。
4. **新 Web 前端**：浏览器内的 ACP 客户端（优先使用官方 TypeScript SDK，Spec 阶段评估），加适配层，把 ACP 的 `session/update` 映射成对话时间线、思考、工具卡片、计划，把 `session/request_permission` 映射成审批卡片（含文件 diff）。
5. **审批 diff**：把现有 `file_diff` 的预计算内容放进 ACP 工具调用的 diff 内容里，让审批卡片仍能显示文件改动；放不下的字段进 `_meta` 并记入缺口登记表。
6. **斜杠命令**：只提供 Agent 侧命令（ACP 的 `available_commands_update`）；纯界面命令（如 `/web`、`/quit`）不在范围内。
7. **缺口登记**：产出「ACP 缺口登记表」，完成时随 Task 提交。

## 非范围

- 下线或删除 TUI、`PresentationCoordinator`、`WebUiGateway`、`HandoffState`、`/web` 接管（等 TUI 下线 Task）。
- 修改或删除 JSON-RPC v3、`packages/protocol` 现有方法；TUI 与无头模式继续使用它。
- 实现任何 ACP 自定义扩展方法（如 compose、goal 的专用方法）；一期只登记，不实现。
- Electron 打包与 Electron 主进程接入。
- 接入第三方 ACP Agent，以及为此需要的客户端能力（`fs/*` 读写文件、`terminal/*` 执行命令由客户端代理）。自家 Agent 在本机直接读写文件和执行命令，不使用这些能力。
- 文件树与文件预览、git 面板、Trace 面板、模型切换、技能/插件/MCP 管理、代码索引、配置界面等「ACP 之外」功能（见缺口登记表）。
- 让 Zed、VS Code 等编辑器实际接入的联调（本任务只保证标准 SDK 客户端能通过 stdio 对话）。
- 跨平台安装包与发布流程。

## 后续 Task 线索（不在本任务内，完成本任务时再正式立项）

1. 补齐 ACP 缺口：按缺口登记表逐项做成 ACP 扩展或辅助通道。
2. Electron 桌面端：主进程直接启动 ACP Agent 并转发给界面，替代 `harness web` 的 WebSocket 桥。
3. 接入第三方 ACP Agent：界面一侧实现 ACP 客户端能力（`fs/*`、`terminal/*`），并支持选择和管理多个 Agent。
4. TUI 与 `WebUiGateway` 下线：删除自有 UI 契约、接管状态机和 JSON-RPC v3 里只服务 TUI 的部分，届时 Python 才只剩 ACP 一种入口。**前置条件**：缺口表（Spec §12.3 / 架构文档）里没有「未开始」或「进行中」的行，每一行要么已关闭，要么用户确认放弃；立项时把它抄成该 Task 的验收项。

## ACP 缺口登记表（初版，Spec 阶段逐项核实后补全）

下表基于 2026-11-05 对代码的只读调研。「ACP 对应」一栏是初步判断，Spec 阶段需要对照最新 ACP 规范逐项核实，不能直接当结论。「建议扩展方式」是给后续 Task 的方向，不是本任务的承诺。

| 功能 | 现有实现位置 | ACP 对应 | 一期 Web | 建议扩展方式 |
|---|---|---|---|---|
| 对话与流式输出（文字、思考、工具调用） | 事件 `content.delta`、`reasoning.delta`、`tool.*`；`interactive/features/run-feature.ts` | 有：`session/prompt` + `session/update` | 提供 | 无需扩展 |
| 取消运行 | `run.cancel` | 有：`session/cancel` | 提供 | 无需扩展 |
| 会话恢复 | `threads.open` | 部分：`session/load`（需 Agent 声明能力） | 提供 | 无需扩展 |
| 工具审批（含文件 diff） | `interaction.approval`；`web/presentation/file-diff-approval.tsx`；`policy/approval_policy.py` | 部分：`session/request_permission` + 工具调用 diff 内容 | 提供 | 风险说明等额外字段放 `_meta` |
| Agent 侧斜杠命令 | `initialize.agent_commands`、`commands.bind` | 有：`available_commands_update` | 提供 | 无需扩展 |
| 审批模式（plan / default / auto-edit / auto / yolo） | `run.set_approval_mode`；`policy/approval_mode.py` | 部分：session mode 需要映射语义 | Spec 评估，倾向提供 | 语义对不上的模式用 `_meta` 标注 |
| Plan 展示与确认 | `interaction.plan`；`tools/plan_file.py` | 部分：有计划更新通知，但「确认计划」没有标准形态 | 只展示，确认缺口 | 自定义请求「确认计划」 |
| 提问（`ask_user`） | `interaction.question`；`tools/ask_user.py` | 无直接对应 | 缺口 | 自定义请求，或退化为带选项的权限请求 |
| 目录信任 | `interaction.directory_trust`；`policy/trust_gate.py`；`directory-trust-approval.tsx` | 无专用形态，可用 `session/request_permission` 表达 | 提供（用户确认，Spec §6.4） | 已用标准权限请求解决 |
| compose 模式 | `harness_agent/compose/*`；`compose.inspect/abandon`；`work-item-view.tsx` | 无 | 缺口 | 自定义方法 + 自定义通知（进度、总结） |
| 目标闭环（goal） | `harness_agent/goals/*`；`goal.*`；`goal-view.tsx` | 无 | 缺口 | 自定义方法 + 自定义通知（评估、变更） |
| 上下文面板与压缩 | `context.updated`、`context.compact`；`context-dock/status-panel.tsx` | 无 | 缺口 | 自定义通知（用量）+ 自定义方法（压缩） |
| 模型切换 | `models.list`；`run.start.model_selection`；`models-panel.tsx` | 未见专用标准项，待核实 | 缺口 | 优先看 session config 类标准能力，否则自定义方法 |
| 会话列表与标题 | `threads.list`、`threads.set_title`、`thread.summary` | 部分：`session/list` 属于较新的可选能力，待核实 | Spec 评估 | 标准能力不足的部分用自定义方法 |
| 撤销 / 重做（含代码回滚） | `threads.list_turns/undo/redo`；`GitCheckpointService` | 无 | 缺口 | 自定义方法 |
| 旁路提问 `/btw` | `threads.side_question` | 无 | 缺口 | 自定义方法 |
| 文件树与文件预览 | `cli/src/workspace/explorer.ts`、`file-preview.ts`；`workspace-sidebar/` | 无（ACP 的 `fs/*` 是 Agent 请求客户端读写文件，方向相反） | 缺口 | Electron 主进程直接读本机文件，不经 Agent |
| git 面板、提交、推送 | `interactive/features/workspace-git.ts`；`git-panel.tsx` | 无 | 缺口 | Electron 主进程直接调 git，不经 Agent |
| 技能管理 | `skills.*`；`skills-panel.tsx` | 无 | 缺口 | 自定义方法 |
| 插件管理与设置 | `plugins.*`、`settings.*`、`interaction.plugin_consent` | 无 | 缺口 | 自定义方法 |
| MCP 管理 | `mcp.*`；`mcp-panel.tsx` | 部分：`session/new` 可传 MCP 配置，运行期增删无 | 缺口 | 运行期增删用自定义方法 |
| 子代理 / Team | `agents.*`、`teams.*`；`agents-panel.tsx` | 无 | 缺口 | 自定义方法 |
| 代码索引 | `code_index.*` | 无 | 缺口 | 自定义方法 + 自定义通知 |
| 配置查看与修改 | `config.*`；`settings-dialog.tsx` | 无 | 缺口 | 自定义方法 |
| Trace 面板 | `contracts/trace.ts`；`web/presentation/trace/` | 无 | 缺口 | 自定义通知，或直接读本机日志 |
| 终端与文件由客户端代理 | Python 在本机直接读写文件、执行命令 | 有但方向相反：`fs/*`、`terminal/*` | 不使用，Agent 继续本机执行 | 接入第三方 Agent 时由客户端实现 |

扩展方法的命名前缀需要使用我们能控制的域名做反向域名标签（ACP 扩展约定），具体前缀在 Spec 阶段与用户确认。

## 验收标准

1. 运行 `harness web` 后，浏览器自动打开，页面出现对话界面。
2. 发送一条消息，能实时看到回复文字；模型有思考内容时能看到思考；调用工具时能看到工具卡片及其结果。
3. 需要审批的文件修改，审批卡片显示文件 diff；点击允许后文件被修改，点击拒绝后文件不变，Agent 收到拒绝结果。
4. 运行中点击取消，任务停止，界面显示已取消，且可以立即发起下一轮。
5. 刷新页面或重新执行 `harness web` 后，可以打开之前的会话并看到历史消息。
6. 输入 `/` 能看到 Agent 侧斜杠命令并可执行。
7. 以下浏览器连接都被桥拒绝且 Agent 不受影响：不带 token、token 错误、token 重复使用、token 过期、Origin 不是网页所在 Origin、帧超过大小上限。关闭浏览器标签后子进程被回收；子进程异常退出时界面显示明确错误。
8. 用官方 ACP SDK 写的最小客户端（只作为测试用例，不入产品）直接启动 `harness acp`，通过 stdio 完成 `initialize → session/new → session/prompt` 并收到流式回复；`harness acp` 的 stdout 上只出现合法 ACP 消息，诊断信息只出现在 stderr；畸形输入不会使进程崩溃。
9. 现有行为不变：`harness`（TUI）、TUI 内 `/web` 接管、`harness -p`（无头）以及它们的既有测试全部照常通过。
10. 「ACP 缺口登记表」随本 Task 提交，每一行都有：现状、ACP 缺什么、建议的扩展方式；Spec 评估后的结论回填到表里。
11. 测试覆盖：Python 端 ACP 派发与流式行为、TypeScript 端桥转发与前端适配层都有测试；包含取消、断连、畸形帧、终态错误事件。
12. `cd packages/agent && .venv/bin/python -m pytest -q`、`cd packages/cli && bun test`、`npm run typecheck`、`npm run project:check` 通过；环境原因无法运行的项记录跳过原因。
13. 缺口治理落实：缺口表使用 GAP 编号并迁入 `architecture/ACP通信.md`；`docs/user/Web界面.md` 有「当前不支持」一节；被调用的缺口功能在界面显示带编号的提示；`harness web` 启动时终端有过渡版本提示；每组缺口在看板上有后续 Task，编号已写回缺口表。

## 主要风险与待 Spec 决定

- **Python 内部复用边界**：现在 `AgentHost` 把 stdio 上的 JSON-RPC v3 和 Run、会话、审批深度绑在一起（`host/agent_host.py` 约 6250 行）。`harness acp` 需要在不复制逻辑的前提下接入同一套 `RunCoordinator` 和审批流程，Spec 要给出清晰的分层，避免出现两套 Run 状态。
- **审批信息承载**：`file_diff`、风险说明等字段能否完整放进标准的权限请求和工具调用内容，决定了审批卡片是否有损。
- **会话与 Thread 的对应**：ACP 的 session 和现有 Thread 如何一一对应，`session/load` 如何回放历史，需要在 Spec 里写明。
- **适配层粒度**：已确定复用组件，但现有组件依赖 8 个视图切片，适配层要补出哪些切片、一期缺数据的切片如何呈现（隐藏或置灰），Spec 要写清楚。
- **官方 SDK**：浏览器与 Python 各自是否使用官方 ACP SDK、版本与依赖治理（依赖清单、`deps:check`）在 Spec 阶段评估。
- **WebSocket 桥的位置**：桥放在 Bun 进程里，尽量复用 `web/server.ts` 的校验逻辑；Spec 需要确认这些逻辑能与旧 `PresentationCoordinator` 解耦，不把旧接管状态机带进新路径。
- **ACP 版本演进**：远程传输（Streamable HTTP）目前还在官方草案阶段，本任务不依赖它；Electron 阶段的最终传输在后续 Task 中确定。
- **编号核对**：HC-192 在 2026-11-05 核对时未被分支或文档占用；当时工作区另有他人暂存的 187/188 调研与 188 Task 文件，本任务不触碰，后来已移到独立分支 `wip/docs-187-188-hc188`。

## 对 handoff 的更正

`tmp/handoff.md` 与当前代码和后续讨论有出入，以本 Task 为准：

1. 现有 UI 契约版本是 `UI_CONTRACT_VERSION = 10`（`packages/cli/src/presentation-coordinator/contracts/messages.ts`），不是 7。
2. handoff 设想的「Agent 端暴露本地 WebSocket」不再采用：主路径改为标准 stdio，WebSocket 只在 Bun 进程里做浏览器调试桥。Python 里现有的 `host/attachments.py` 不用于本任务。

## 流程与交付

- 路径：完整流程，不走快速通道（涉及跨进程协议与新依赖）。
- 下一步：用户确认本 Task 后，用 `agent-skills:spec-driven-development` 与 `mattpocock:codebase-design` 写 Spec；Spec 开头先核实官方 ACP 规范与 SDK 现状、逐个梳理现有 Web 组件依赖的视图切片、核实缺口登记表的判断；Spec 确认后写 Plan（标出可演示停点）和 Todo。
- 认领与分支：`npm run task:claim -- HC-192 --owner <名称> --branch feat_hc_192_WebUI接入ACP协议`。

## S0 结论（2026-11-05）

S0 的探索由 DeepSeek 子 agent 只读完成（Todo 0.2 到 0.6），没有修改仓库文件。要点与证据：

**基线**
- `packages/agent`：`tests/host` 246 passed（21 秒）；全量 3007 passed / 5 skipped（175 秒）。首跑出现 1 个顺序相关的偶发失败 `tests/host/test_server.py::test_capture_server_places_max_minor_inside_protocol`（`KeyError: 'result'`），单跑和重跑均通过。
- `packages/cli`：`npm run test` 前半段 1345 pass / 1 skip / 0 fail；后半段 `tests/web/takeover-recovery.test.ts` 2 项因本机未安装 Playwright 浏览器失败（环境原因，非回归）。裸 `bun test` 会把 Playwright 的 `.spec.ts` 当 bun 测试加载，不能用。

**验证 A（官方 Python SDK 接管 stdio）**：可行。fd 复制与重定向后，`print`、`os.system`、`subprocess`（包括继承 fd 1 的）输出都只出现在 stderr，ACP 通道 4 帧全部合法；stdin EOF 退出码 0。要自己处理：`run_agent` 的两个参数名与语义相反；stdout 必须是管道；SDK 不处理 SIGTERM（退出码 -15）；`stdio_buffer_limit_bytes` 不会拒绝超长帧。

**验证 B（审批 `tool_call_id`）**：可行。`tool_call_id` 在审批预检回调里已知；`payload.requests` 是任意 JSON，往每个 action 元素里加字段不破 schema（payload 顶层加会破）；`execute` 与 MCP 工具暂无捕获点。

**验证 C（虚拟路径）**：模型与审批 presentation 里是虚拟路径（`/src/a.ts`）；用 `WorkspacePathPolicy.validate_direct_path()` 换算，`/.harness/…`、`..`、未信任外部路径需跳过。

**验证 D**：`host/acp/` 不被架构测试拦截；`__main__.py` 的 `main` 与 console script 目标不能改名。TS SDK 最新 2.4.0（默认入口仍是 ACP v1），浏览器打包 0.81 MB、无 `node:`。`InteractiveController` 打包能成功（2.6 MB），但经由 `infrastructure`、`mention-resolver`、`prompt-history` 间接引入 `node:fs/promises`、`node:path`、`node:os`、`node:buffer`，Bun 静默换成空桩；另有架构测试限制控制器只能在 `src/index.ts` 创建。

**对 Spec 的修订**：§2（SDK 版本与实测事实）、§3（测试命令）、§4.3 D-3（前置改造）、§5.3（stdio 四条实现要求）、§6.2（路径换算）、§6.4（`tool_call_id` 关联）、§8.1 与新增 §8.5（控制器前置改造、WebSocket 流自写）、§11（依赖版本）、§12.3（GAP-23 改写，新增 GAP-24、GAP-25）、§13。

**已确认**：Python SDK 用最新稳定版 `agent-client-protocol==0.12.1`（1.0.0 仍是 rc，不用）；TypeScript SDK 用企业内部源的 `@agentclientprotocol/sdk@0.25.1`（npm 最新是 2.4.0，但内部源只有 0.25.1；已实测 0.25.1 覆盖 `ClientSideConnection`、`listSessions`、`loadSession`、`session_info_update`、`current_mode_update`、`available_commands_update`、`_meta`，浏览器打包 0.74 MB 无 `node:`）。

**待用户确认的修订点**：见对话。确认后继续 Todo 0.8（抽取 AgentHost 服务面）。

## S0 实施与 Review 结论（2026-11-05）

**分工**：探索与开发由 DeepSeek 子 agent 完成，方案设计与 Code Review 由 Claude 子 agent 完成，主 agent 复核并修复 Review 发现。

**实施内容**（Todo 0.7a、0.8 到 0.13）
- `packages/agent/harness_agent/host/agent_host.py`：抽出服务方法 `ensure_ready`、`open_connection`、`bind_commands`、`start_run`、`cancel_run`、`set_approval_mode`、`list_threads`、`open_thread`、`watch_thread`、`open_and_watch_thread`、`unwatch_thread`、`resolve_interaction`、`fail_interaction`；v3 的 `_handle_*` 全部保留名字与签名，变成薄壳；`_resolve_agent_engine_spec` 增加必填 `interactive` 参数；`_run_rpc_error` 公开为 `run_error_to_rpc_error`；`_require_threads_capability` 拆出 `_require_threads_available`；删除无调用点的 `_threads_enabled`；新增 `workspace` 属性。
- 新增 `host/service_types.py`（数据类与 `HostServicePort`），新增三个测试文件：`test_v3_characterization.py`（25 个特征化用例，已在 `git archive HEAD` 导出的重构前代码上验证通过）、`test_host_services.py`（服务面直测）。
- 依赖：`agent-client-protocol==0.12.1`（`uv.lock` 只新增该包，`pydantic 2.12.5`、`anyio 4.12.1` 等固定版本不变），三份依赖文档同步，`npm run deps:check` 退出码 0。

**Code Review 发现与处理**
- 阻断 B1（已修）：`_handle_peer_response` 薄壳对「未知 id 的 error、缺 result、格式错误的 error」不再回 `REQUEST_EXPIRED`，与重构前不一致。已修复，并在 `test_peer_response_matrix` 补三个用例。
- 重要 I1（已补）：`_connection_handles_for` 与 `_prepare_run` 不读 ContextVar 的测试；I2（已修）：代码索引 `start()` 改为每次 `ensure_ready` 都尝试且放在置位之后，行为与重构前每次 initialize 一致，并补两条测试；I3（登记）：见下。
- 次要（已处理）：`_threads_enabled` 已真正删除；`HostServicePort` 补 `workspace`、`run_error_to_rpc_error`，`resolve_interaction` 返回类型改为 Literal，一致性测试加固（同步/异步、参数种类、必填性）；AST 禁用测试扩大到 `_prepare_run`、`_schedule_thread_title_autogen`、`_record_workspace_git_checkpoint`、`_fanout_run_execution`、`_host_snapshot`；`HostSnapshot` 的「拷贝」说明订正为「顶层容器是新对象」。
- 登记、不处理的小差异：`commands.bind` 的「已绑定」检查与参数校验的先后顺序有细微变化（`_dispatch_current` 已先做 schema 校验，几乎不可达）；`HostSnapshot` 的读取时机提前一个 await；teams 和 `_acquire_default_agent_engine_locked` 两处仍读「当前连接」的 handles（语义与重构前一致，ACP 下预取的 Engine profile 的 `interactive` 与会话 Run 不同，只是池里多一个条目，S1 设计时记一笔）。

**依赖文档漂移（建议另立 Task）**：`docs/developer/project/内网迁移依赖清单.md` 的闭包清单在本任务之前就与 `uv.lock` 不一致（锁文件实际 84 个外部包，文档列 92 行，其中 9 个不在锁文件里、约 24 个版本不同，且「下载源 mirrors.aliyun.com」与锁文件里的 `pypi.org` 不符）。本任务只按文档现有口径加了一条并 +1，**文档里的总数并不代表锁文件的真实数量**。需要整份重新对账，不在 HC-192 范围内；归档前在看板建一个后续 Task 并写回此处。

**验证数字（主 agent 复核）**
- `tests/host`、架构、qwen、入口等门槛测试：451 passed / 1 skipped。
- Python 全量：3083 passed / 5 skipped（基线 3007 / 5，新增 76 个用例）。
- `npm run deps:check`：退出码 0。
- `npm run project:check`：失败，唯一报错是他人文档 `research/187-Fusion对照Devin改进.md` 的无效本地链接，与本任务无关。
- v3 对照录制（echo 模式 8 帧）：抹掉连接 id、时间戳、随机 `event_id` 后，重构前后 0 行差异。

**未做**：`AcpServer`、`translate.py`、`permissions.py`、`stdio.py`（S1 起）；没有改 `packages/protocol`、`packages/cli`、TUI、无头模式。

## S1 实施与 Review 结论（2026-11-05）

**分工**：同 S0。DeepSeek 子 agent 开发，Claude 子 agent 设计与 Code Review，主 agent 复核并修复。

**实施内容**（Todo 1.1 到 1.11）
- Python：新增 `harness_agent/host/acp/`（`ext`、`stdio`、`server`、`translate`、`tool_display`）。`python -m harness_agent acp` 在 stdout 上只输出 ACP 消息；`main()` 按 argv 分派，无参数时仍是 v3。
- 支持的 ACP 方法：`initialize`、`session/new`、`session/prompt`、`session/cancel`，以及 `session/update`（文本、思考、工具卡）。能力声明如实：`loadSession:false`，`sessionCapabilities:{}`；`modes` 只返回当前模式。
- stdout 保护：启动时复制并重定向 fd，非管道 stdout 直接报错；`print`、孙进程、继承 stdin 都不会污染协议；读端 8 MiB 帧长检查；SIGTERM / SIGINT 取消在途 Run 后退出码 0；stdin EOF 同样取消并等待收尾。
- `toolCallId` 形如 `{run_id}:{原 id}`；子 agent 事件暂不外发（GAP-16）。
- TypeScript：`harness acp` 命令（`packages/cli/src/acp-command.ts`）一字节不改地透传 stdio 与退出码，转发 SIGTERM；子进程环境带 `PYTHONSAFEPATH=1`，降低仓库顶层 `acp/` 目录遮蔽官方 SDK 的风险（R12，仅 TS 启动器有此保护）。

**Code Review 发现与处理**
- 无阻断项，结论「可以提交」。
- 已修：恶意 JSON（深嵌套触发 `RecursionError`）会让帧守卫崩溃，现在回 -32600 并继续，守卫任务崩溃时进程以 1 退出；关停时处于准备阶段的会话现在也会被标记取消；终态事件翻译或发送失败时，`session/prompt` 以 -32603 收尾，不再悬挂；`tool.completed` 不再把已宣布的标题改回裸工具名；`wait_closed()` 恒失败的死代码已删；`test_sdk_client_e2e.py` 补了真实入口的工具卡场景，两个名不副实的测试已改名。
- 已登记 GAP：GAP-16 子 agent 过程不可见、GAP-26 `locations` 只含主工作区路径、GAP-27 `mcpServers` / `additionalDirectories` 被忽略（只在 stderr 记数量）。
- 次要、延后（进入 S2 到 S4 顺手处理，不单独立项）：`prompt_text` 未把工作区内 `file://` 链接转成相对路径、也不解码 URL 转义；`_fit_update` 只裁剪 `ToolCallUpdate`；连接断开后无标志位；未检查 stderr 与 stdout 是否同一管道（`2>&1`）；信号处理器先于 `host.close()` 移除；`claim_protocol_fds` 缺直接单测；`session/new` 的 cwd 含 NUL 会抛 `ValueError`。
- 偏差记录：工作区校验放在 `execute` 的 `acp` 分支；参数无法解析时 `announce_input` 返回空列表；`ShutdownAware` 配合 `cast`。
- 修复测试稳定性：`acp-command.test.ts` 的 SIGTERM 用例原先固定睡 300ms，偶发在 `trap` 装好前就发信号（退出码 128）；改为等假 sidecar 输出 ready 后再发，连续 6 次通过。

**验证数字（主 agent 复核）**
- `tests/host/acp`：153 passed；`test_sdk_client_e2e.py`：6 passed。
- Python 全量：3244 passed / 5 skipped（S0 为 3083 / 5）。
- CLI `npm run test` 主批：1355 pass / 1 skip / 0 fail；`tests/web/takeover-recovery.test.ts` 2 项失败，原因是本机缺 Playwright 浏览器，与本任务无关。
- `npm run typecheck`、`npm run deps:check` 通过；`npm run project:check` 仅剩他人 `research/187-*` 的无效链接。
- 手动：`HARNESS_ECHO_MODE=1 bun packages/cli/src/index.ts acp --cwd <仓库根>`，`initialize` 与 `session/new` 返回合法响应，stdout 无杂音。

**未做**：审批 / 目录信任、`session/list` / `session/load`、`/命令`、模式切换、扩展协商（S2）；`harness web`（S3）；`packages/protocol`、TUI、无头模式均未改动。

## S2 实施与 Review 结论（2026-11-05）

**分工**：同 S0。探索与开发由 DeepSeek 子 agent 完成（开发分 A、B 两段），方案设计与 Code Review 由 Claude 子 agent 完成，主 agent 复核并修复 Review 发现。

**实施内容**（Todo 2.0 到 2.9）
- **`tool_call_id` 进审批 payload**：新增 `runtime/approval_tool_calls.py`（`ToolCallIdStore`，256 条上限、不设 TTL，因为审批没有超时）。预检回调里记下「工具名 + 参数」指纹对应的 provider id，审批 payload 生成点（`run_coordinator.py`）写入 `action_requests[i].tool_call_id`；子代理路径直接带上现成的 id。一次覆盖全部需要审批的工具族（探索发现 `execute`、MCP 其实都有捕获点，比 Spec 的假设更好）。同一批里「工具名 + 参数」完全相同时不注入。v3 的唯一可见变化就是这个可能多出的键，TUI 与 TS 校验器都把 `requests` 当 `unknown`，不受影响（`protocol-contract.test.ts` 加了 1 条用例锁定）。
- **审批与目录信任**：新增 `host/acp/permissions.py`（纯函数 + `PermissionBroker`）。审批帧经 outbox 进 `_pump` 串行处理，先补卡再起独立权限任务；客户端断开、JSON-RPC 错误、畸形响应、`cancelled`、未知选项一律 reject（目录信任为 deny）并回填 Host。**审批不加超时**（v3 本来就没有，TUI 也无限等人）。目录信任卡片为 `trust:{request_id}`，只有 `allow_session` / `deny`。
- **会话**：`session/list`（固定 200 条，echo 模式回 `-32603 THREADS_UNAVAILABLE_IN_ECHO_MODE`）、`session/load`（回放历史，全部 update 排在响应之前；线程忙 `-32603` + `THREAD_BUSY`；不存在 `-32002`）、`thread.summary` → `session_info_update`（连接开了 `threads.read`，`_sender` 对其它 method 静默丢弃）。
- **命令与模式**：握手期 `bind_commands` 一次，`/命令 参数` 补全 `requested_skill`（`raw_invocation` 逐字等于整条消息），`available_commands_update` 只在列表非空时发；4 个模式（`default` / `auto-edit` / `auto` / `yolo`，产品默认是 `auto`），`session/set_mode` 错误按表映射。
- **扩展协商**：`clientCapabilities._meta.harnessCode` 声明有效才回报能力并启用 `_meta.harnessCode.approval`（只挂在权限请求的 `toolCall` 上）与 `run`（`session/prompt` 响应）；格式错误、版本不识别按没声明处理。
- **端到端**：官方 SDK 客户端 + 真实子进程，覆盖拒绝一次、允许一次、目录授权（允许 / 拒绝）、`/命令`、列出并恢复会话、审批挂起时取消、扩展协商。

**Code Review 发现与处理**
- 无阻断项，结论「可以提交并进入 S3」。
- 重要 R1（已修）：翻译或补卡阶段抛异常时审批不会被拒绝，加上没有超时，Run 会永久挂住。现在 `_pump` 对 interaction 帧的异常立刻 `fail_interaction`；另在起权限任务前再看一眼 `cancel_requested`，减少取消窗口里多弹一次框。
- 重要 R2（已修）：provider 重复使用 tool_call id 时，审批挂在「幻影卡」上，同一次调用出现两张卡。`prepare_approval` 在按 id 找不到时先按「同名 + 参数相同」认领已有卡。
- 重要 R3（已补）：新增 7 条回归，并逐个把对应护栏改坏确认测试变红——翻译失败拒绝、id 复用认领、已取消会话不再弹窗、同 id 第二个审批落兜底卡、Run 收敛清缓存、Host 侧取消后清权限任务；未声明客户端的全帧扫描补上会话列表、历史回放、命令推送。
  - 例外：「取消时先取消 Run 再取消权限任务」的顺序在同一事件循环轮次内生效，无法稳定检测，只保留了 `agent.resumes == []` 的断言作为弱护栏，主要靠 docstring 与代码审阅。
- 次要（已处理）：`load_session` 失败时只摘本次新增的订阅；`run_coordinator.py` 重复导入；`MAX_TOOL_CALL_IDS` 补 `ponytail:` 注释；`watch_thread` 的 docstring。
- 次要（延后）：`PermissionBroker._run` 收尾无 try/finally 保护；子代理卡标题未净化；回放里用户消息不切块、`iso_from_ms` 对异常值会抛；命令推送顺序依赖 SDK 内部写响应的时机（升级 SDK 时必须重跑 `test_available_commands_sent_after_session_new_response`）；对整批请求逐条算 sha256；若干 `sleep` 后断言「没发生」的时序用例；ruff 19 条非门禁提示。
- **目录信任短路（开发自报的风险）**：Review 用真实 registry 验证，生产里工作区外的未信任路径会弹信任卡；开发看到的短路只来自测试夹具里不存在的 `/ext/a.txt`。夹具已用 `write_file` 并强制 `_directory_trust_already_granted=False`，S3 联调时应改用真实的工作区外临时目录再验一次。
- 偏离记录：`_meta` 位置在 2.7 才从请求层改到 `toolCall` 上；目录信任夹具不用 `ls`（并发安全，Host 直接放行）；进程内测试的 socket 读上限对齐生产 `MAX_FRAME_BYTES+1`。

**新登记缺口**（详见 Spec §12.3）：GAP-28 普通 Skill 无斜杠入口、GAP-29 审批无超时需桥侧存活检测、GAP-30 `allow_always` 语义、GAP-31 Host 侧模式变化不回流、GAP-32 回放细节限制、GAP-33 列表不分页、GAP-34 子代理审批兜底卡、GAP-35 审批卡片顺序；GAP-23 缩小为 id 重复 / 参数被截断的残余。

**验证数字（主 agent 复核）**
- `tests/host/acp`：317 passed。
- `tests/host` 等回归门槛：782 passed / 1 skipped。
- `tests/runtime`：276 passed。
- Python 全量：3436 passed / 5 skipped（S1 为 3244 / 5）。
- CLI `npm run test` 主批：1356 pass / 1 skip / 0 fail；`tests/web/takeover-recovery.test.ts` 2 项因本机缺 Playwright 浏览器失败，与本任务无关。
- `npm run typecheck`、`npm run deps:check` 通过。

**未做**：`harness web`、WebSocket 桥与浏览器端（S3、S4）；`usage_update`、`ask_user` / 计划 / 目标交互（保守默认，见缺口表）；没有用 Zed 真机试用；`session/load` 之后继续对话没有端到端测试（`make_persistent_host` 没配模型，S3 联调时补）。
