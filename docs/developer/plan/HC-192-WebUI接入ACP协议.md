# HC-192：WebUI接入ACP协议实施计划

来源：[Task](../task/HC-192-WebUI接入ACP协议.md) / [Spec](../spec/HC-192-WebUI接入ACP协议.md)。Task 与 Spec 已由用户确认。实现严格 TDD：每一项先写失败的测试，再写最小实现，再整理。每次只推进到下一个可演示停点，到达后停下等用户确认。

## 计划总览

按「先把风险最大的地方摸清，再自底向上、纵向切片」排序：

```text
S0 摸底与重构（无可见变化）
   └─ 验证 4 个未知项 + 抽出 AgentHost 服务面 + 引入 Python SDK
S1 终端里能用标准 ACP 对话一轮
   └─ harness-agent acp：initialize / new / prompt / cancel，流式文字、思考、工具卡片
S2 标准 ACP 客户端功能完整
   └─ 审批（含 diff 与目录信任）、会话列表与恢复、斜杠命令、模式、扩展协商
S3 浏览器里能用
   └─ harness web：桥 + 浏览器 ACP 客户端 + 复用现有界面，发消息、流式回复、取消
S4 完整验收
   └─ 审批卡片与 diff、刷新恢复、安全拒绝、缺口治理、文档、后续 Task
```

依赖方向：S1 依赖 S0 的服务面；S2 依赖 S1 的服务器骨架；S3 依赖 S2 的 ACP 子集稳定；S4 依赖 S3。

可并行的部分（只在需要时，且文件互不重叠）：TypeScript 的 `guard.ts`、`session-token.ts`、`framing.ts` 是纯函数，不依赖 Python，可以与 S1/S2 并行准备；但按「停点交付」规则，对用户可见的推进仍然一次只做一个停点。

## S0：摸底与重构

**目的**：把会推翻设计的未知项在写 ACP 代码之前摸清，并先做完风险最高的重构。

1. **认领与基线**：认领 Task、建分支；运行现有 Python 与 TypeScript 测试，记录基线（含已知失败）。
2. **四个小验证（只读或临时脚本，不进仓库产品代码）**
   - A. 官方 Python SDK 的 `run_agent` 能否接管「复制出来的 stdout 描述符 + stdin」，同时 fd 1 被重定向到 stderr 后 `print` 不污染。
   - B. 审批请求能否低成本拿到 `tool_call_id`（读 `execution_stream.py` 的审批中断数据和 `run_coordinator` 的审批收集）。
   - C. Deepagents 虚拟路径能否解析成工作区绝对路径（决定 `locations` 能否填）。
   - D. `host/acp/` 子包是否被 `tests/test_architecture.py` 允许；npm 包 `@agentclientprotocol/sdk` 的传递依赖和打包体积。
3. **抽取 AgentHost 服务面**（Spec §5.2）：按「初始化资源 → 连接登记与关闭 → 命令绑定 → 启动 Run → 取消与模式 → 会话读取与订阅 → 交互应答」的顺序，每抽一个方法就跑一次 `tests/host/`，v3 处理器变成薄壳。不改任何行为。
4. **引入 Python SDK**：确认版本后加入 `pyproject.toml` 与锁文件，更新依赖清单文档，`deps:check` 通过（按 Spec「先问再做」，加依赖前向用户确认版本）。

**S0 探索结论（2026-11-05，已完成 0.2 到 0.6）**：四个小验证全部有结论，Spec 已据此修订（§2、§4.3、§5.3、§6.2、§6.4、§8.5、GAP-23 到 GAP-25）。要点：官方 Python SDK 可按计划接管 stdio，但 SIGTERM、帧大小上限、非管道 stdout 三处要自己处理；审批的 `tool_call_id` 可以由 Python 在预检回调里捕获并写入每个 action，不改协议 schema；`host/acp/` 不被架构测试拦截；TS SDK 在企业内部源的 0.25.1 版可打进浏览器 bundle 并覆盖所需能力；`InteractiveController` 在浏览器里运行需要先切断对 Node 模块的间接依赖，并修改一条架构测试。

**可演示停点 S0**：用户看不到功能变化。交付物是一份验证结论（写入 Task）和「现有测试全绿」的证据。四个小验证中任何一个结论推翻 Spec 假设，立即停下回写 Spec，不继续往下做。

## S1：终端里用标准 ACP 对话一轮

**目的**：`harness-agent acp` 能被官方 SDK 客户端驱动，完成最小闭环。

1. 扩展常量模块 `host/acp/ext.py`（`EXT_KEY="harnessCode"`、`EXT_METHOD_PREFIX="_harnessCode/"`），先于其它代码。
2. `stdio.py`：fd 洁癖加 `run_agent` 接管（注意 `input_stream` 传写端、`output_stream` 传读端）；非管道 stdout 启动即报错；自装 SIGTERM / SIGINT 处理器；读端包 8 MiB 帧长检查；`__main__.py` 的 `main()` 内按 argv 分派 `acp`（函数名和 console script 目标不变）。
3. `translate.py` 的基础部分：`content.delta`、`reasoning.delta`、`tool.started`、`tool.delta`（参数缓冲）、`tool.completed`；`tool_display.py` 的 kind、标题。
4. `server.py` 的基础方法：`initialize`（不含扩展协商）、`session/new`（含 cwd 校验、`modes` 先返回固定值）、`session/prompt`（含终态映射和顺序保证）、`session/cancel`；`startup_error` 处理。
5. TypeScript `harness acp` 透传命令（`args.ts`、`index.ts`），让用户可以直接 `harness acp`。
6. 官方 SDK 客户端端到端测试和 stdout 洁癖测试。

**可演示停点 S1**：在终端里运行 echo 模式的 `harness-agent acp`，逐行贴入 JSON 能看到 `initialize`、`session/new`、`session/prompt` 的流式 `session/update` 和 `end_turn`；SDK 客户端测试通过；stdout 上没有任何非 ACP 内容。

## S2：标准 ACP 客户端功能完整

**目的**：Zed 或官方 SDK 示例客户端这类「没有扩展」的客户端，也能完整使用一期功能。

1. 审批：先在 Python 内部审批预检回调里捕获 `tool_call_id` 并写入每个 `action_requests` 元素（`execute`、MCP 工具的捕获点放最后，做不完登记 GAP-23）；再做 `permissions.py` 的审批翻译、选项映射、`outcome` 处理、与工具调用的关联、取消时的收敛。
2. 目录信任翻译（标准权限请求）。
3. 会话：`session/list`、`session/load` 回放、`session_info_update`（标题）、线程忙与不存在的错误。
4. 斜杠命令：`available_commands_update`、`/命令 参数` 补全 `requested_skill` 与命令绑定。
5. 模式：4 个审批模式、`session/set_mode`、`current_mode_update`。
6. 扩展协商：解析客户端声明，声明有效时才带 `_meta.harnessCode.*`（审批的完整 `file_diff`、运行摘要）；没声明的客户端行为完整。
7. 终态补发：取消或失败时把未结束的 tool_call 置为 `failed`。

**可演示停点 S2**：用官方 SDK 客户端（不声明扩展）完成：一次需要审批的文件修改（拒绝与允许各一次）、一次访问工作区外目录的授权、`/命令` 调用、列出并恢复会话、中途取消。声明扩展的客户端能额外收到 `_meta.harnessCode`。可选：把 `harness acp` 配进 Zed 试用（不属于验收）。

## S3：浏览器里能用

**目的**：`harness web` 打开浏览器，在现有界面里完成对话。

0. **前置改造（Spec §8.5）**：让 `InteractiveController` 能进浏览器 bundle——切断对 Node 模块的间接依赖（只改 import 与注入），修改「控制器只能在 `src/index.ts` 创建」的架构测试，增加「浏览器 bundle 无 `node:` 空桩」的自动检查。TUI 相关测试必须保持全绿。
1. TypeScript 纯函数与测试：`guard.ts`、`session-token.ts`、`framing.ts`。
2. 桥 `bridge.ts`：路由、两段式凭据、WebSocket ⇄ 子进程、生命周期回收；用假子进程做集成测试。
3. 命令：`harness web`（`args.ts`、`index.ts`），启动提示和自动打开浏览器。
4. 构建：第二个浏览器 bundle（`scripts/build-web-assets.ts`、`bundle.ts`）、HTML 外壳、`@agentclientprotocol/sdk@0.25.1`（企业内部源版本）与必需 peer `zod` 的引入与依赖文档。
5. 浏览器端：自写的 WebSocket Stream 适配、`AcpAgentGateway`（含 ID 别名、`openThread`、权限请求到 Core 的交互处理）、`LocalUiClient`、新入口 `app.tsx`；`ext.ts` 常量和扩展声明。
6. 界面最小调整（Spec §8.4）：隐藏「返回 TUI / 退出」、文件树与 Git 的空态说明、审批倒计时。
7. 不支持的方法抛 `ACP_NOT_SUPPORTED`（带 GAP 编号）。

**可演示停点 S3**：`npm run dev -- web` 打开浏览器：看到现有对话界面，发消息能流式看到回复、思考和工具卡片，运行中可取消并立即再发，会话列表可见。审批卡片与刷新恢复放到 S4 验收，但代码路径已就绪。

## S4：完整验收

1. 浏览器里的审批卡片（含文件 diff）和目录信任卡片，真实改一个文件的端到端验证。
2. 刷新页面恢复历史会话；安全拒绝场景（无 token、错 token、重放、过期、错 Origin、超限帧、二进制帧、第二个连接）。
3. 缺口治理（Spec §12.2）：`ACP_NOT_SUPPORTED` 提示、启动时终端提示、缺口表迁入架构文档、用户文档「当前不支持」一节。
4. 文档：`docs/user/快速开始.md`、`docs/user/Web界面.md`、`architecture/ACP通信.md`、`架构总览.md`、ADR 0003 的后续说明。
5. 看板：为每组缺口建后续 Task，编号写回缺口表。
6. 全量检查与 Review：包级、项目级检查，用 `agent-skills:code-review-and-quality` 复核 diff，结论写回 Task。

**可演示停点 S4**：用户逐条核对 Task 的 13 条验收，确认后才执行 `npm run task:complete` 归档。

## 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 抽取 `AgentHost` 服务面时误改 v3 行为 | 高：影响 TUI 与无头模式 | 先抽取、后写 ACP；每抽一个方法跑 `tests/host/`；不合并任何顺手的改动 |
| Python SDK 不能按预期接管流，或 0.x 版本变动 | 中 | S0-A 先验证；版本精确固定；退路是自写 JSONL 层（ACP 方法只有约 8 个） |
| `execute`、MCP 工具的审批预检回调没有现成捕获点 | 低：个别审批卡片与工具卡片分开显示 | 先做文件类工具；这两类退回「工具名 + 参数」匹配，登记 GAP-23，做完关闭 |
| 切断控制器对 Node 模块的依赖时误改 TUI 行为 | 中 | 只改 import 与依赖注入；TUI 路径在 `src/index.ts` 注入原实现；`tests/interactive`、`tests/tui` 全绿作为门槛；打包结果自动检查无 `node:` 空桩 |
| SDK 的 SIGTERM、帧长、非管道 stdout 处理需要自己实现 | 低 | S1 里各有对应测试（stdio 洁癖测试、帧超限测试、SIGTERM 退出码测试） |
| `architecture.test.ts` 等架构测试拦截新文件 | 低 | 新代码放 `src/acp-web/` 与 `host/acp/`；S0-D 确认 |
| 一次改动面太大难以检视 | 中 | 严格按停点推进，每个停点单独验证并写回 Task 证据 |
| ACP WebSocket 方案（RFD）后续变化 | 低 | 桥只做「一帧一条消息」的转发，将来换官方方案只改桥 |

## 验证命令汇总

```text
cd packages/agent && .venv/bin/python -m pytest -q
cd packages/agent && .venv/bin/python -m pytest -q tests/host/acp
cd packages/cli && npm run test      # 显式目录列表；其中 takeover-recovery 2 项因本机缺 Playwright 浏览器已知失败
npm run typecheck
npm run build
npm run project:check
npm run deps:check
```

环境原因无法运行的项，记录跳过原因，不声称通过。

## 回退

每个停点单独提交（提交由用户指令触发）。S0 的重构是纯重构，回退即还原 `agent_host.py`；S1 起新增文件集中在 `host/acp/`、`acp-web/`，回退即删除这些目录并还原 `__main__.py`、`args.ts`、`index.ts` 的少量改动。不影响 TUI、`/web`、无头模式。
