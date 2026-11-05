# HC-192：WebUI接入ACP协议执行清单

来源：[Plan](../plan/HC-192-WebUI接入ACP协议.md) / [Spec](../spec/HC-192-WebUI接入ACP协议.md) / [Task](../task/HC-192-WebUI接入ACP协议.md)。

规则：每次只推进到下一个停点；到达停点后勾选本节、把证据写回 Task，然后停下等用户确认。每个实现项都先写失败的测试。

状态：S0 已完成（0.1 到 0.14），等用户确认后进入停点 1。

## 停点 0：摸底与重构（无可见变化）

查看方式：Task「S0 结论」一节的验证结论，以及 `cd packages/agent && .venv/bin/python -m pytest -q tests/host` 全绿的输出。

- [x] 0.1 已认领（owner 张景新，分支 `feat_hc_192_WebUI接入ACP协议`，从 `dev` 切出，未提交文件原样保留）。
- [x] 0.2 基线：`tests/host` 246 passed；Python 全量 3007 passed / 5 skipped（首跑出现 1 个顺序相关的偶发失败 `test_capture_server_places_max_minor_inside_protocol`，单跑与重跑均通过）；`cd packages/cli && npm run test` 前半段 1345 pass / 1 skip / 0 fail，后半段 `takeover-recovery` 2 项因本机缺 Playwright 浏览器失败。裸 `bun test` 会误加载 Playwright 用例，不用。
- [x] 0.3 验证 A：可行。fd 复制与重定向后，`print`、`os.system`、`subprocess`（含继承 fd 1 的）输出全部只在 stderr，ACP 通道上 4 帧全合法。三处要自己处理：参数名反向、SIGTERM 无处理器、帧长不拒绝；另外 stdout 必须是管道。已写入 Spec §5.3。
- [x] 0.4 验证 B：可行。`tool_call_id` 在审批预检回调里已知，`payload.requests` 是任意 JSON，往 action 元素里加字段不破校验（payload 顶层加会破）。`execute` 与 MCP 工具暂无捕获点。已写入 Spec §6.4、GAP-23。
- [x] 0.5 验证 C：可行。模型与 presentation 里是虚拟路径，用 `WorkspacePathPolicy.validate_direct_path()` 换算；`/.harness/…`、`..`、未信任外部路径要跳过。已写入 Spec §6.2。
- [x] 0.6 验证 D：`host/acp/` 不被架构测试拦截；`main` 函数名与 console script 不能变；TS SDK 在企业内部源只有 0.25.1，已实测覆盖所需能力，浏览器 bundle 0.74 MB 无 `node:`；但 `InteractiveController` 间接依赖 Node 模块、且有一条架构测试限制控制器创建点。已写入 Spec §2、§8.5。
- [x] 0.7 验证推翻/修订了 Spec 的若干假设，已回写 Spec；**等用户确认修订点后再继续 0.8**（见 Task「S0 结论」）。
- [x] 0.8 抽取 `ensure_ready`（初始化资源块），v3 `_handle_initialize` 改为调用它；跑 `tests/host/`。完成：新增 `host/service_types.py`、`HostSnapshot`、`AgentHost.ensure_ready` 与 `_host_snapshot`；G1 407 passed / 1 skipped。
- [x] 0.9 抽取 `open_connection` / `close_connection` / `watch_thread` / `resolve_interaction`；跑 `tests/host/`。完成：另加 `fail_interaction`、`open_thread`、`open_and_watch_thread`、`unwatch_thread`；G1 416 passed / 1 skipped。
- [x] 0.10 抽取 `bind_commands`、`start_run`（含 undo 收敛、git 检查点、标题自动生成）；v3 处理器改为薄壳；跑 `tests/host/`。完成：`start_run` 带 `on_accepted` 回调保证响应先于事件；`_resolve_agent_engine_spec` 改显式 `interactive` 参数；G1 427 passed / 1 skipped。
- [x] 0.11 抽取 `cancel_run`、`set_approval_mode`、`list_threads`、`open_thread`；跑 `tests/host/`。完成：`_run_rpc_error` 改公开 `run_error_to_rpc_error`，删除无调用点的 `_threads_enabled`；G1 434 passed / 1 skipped，Python 全量 3066 passed / 5 skipped。
- [x] 0.12 为服务面新增直接调用的单元测试（不经过 JSON-RPC），确认与 v3 路径共用同一个 `RunCoordinator`。完成：含 AST 禁令测试与 `HostServicePort` 一致性测试；G1 448 passed / 1 skipped，全量 3080 passed / 5 skipped；`/tmp/v3-before.jsonl` 与 `/tmp/v3-after.jsonl` 对照无差异。
- [x] 0.13 `agent-client-protocol==0.12.1`（用户确认用最新稳定版）；加入 `pyproject.toml` 与锁文件，更新 `dependency-versions.json`、`dependency-inventory.json`、`内网迁移依赖清单.md`；`npm run deps:check` 通过。完成：uv.lock 仅新增该包，pydantic / anyio 等固定版本不变。
- [x] 0.14 Python 全量 3083 passed / 5 skipped；`deps:check` 通过；`project:check` 仅他人 187 文档链接报错（与本任务无关）；Code Review 发现已修复；证据写入 Task「S0 实施与 Review 结论」；**停下等待用户确认**。

## 停点 1：终端里用标准 ACP 对话一轮

查看方式：`cd packages/agent && HARNESS_ECHO_MODE=1 .venv/bin/python -m harness_agent acp`，逐行输入下面三条（每条一行）并观察输出：

```text
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"<当前目录的绝对路径>","mcpServers":[]}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<上一步返回的 sessionId>","prompt":[{"type":"text","text":"你好"}]}}
```

应看到：`initialize` 的能力声明、`session/new` 的 sessionId、若干 `session/update`（`agent_message_chunk`）、最后 `stopReason: end_turn`；不应出现任何非 JSON 的输出。另可运行 `cd packages/agent && .venv/bin/python -m pytest -q tests/host/acp` 看官方 SDK 客户端端到端测试。

- [ ] 1.1 `host/acp/ext.py`：`EXT_KEY`、`EXT_METHOD_PREFIX` 常量与测试。
- [ ] 1.2 `test_stdio_hygiene.py` 先失败，再实现 `stdio.py`：fd 复制与重定向（`input_stream` 传写端、`output_stream` 传读端）、非管道 stdout 启动即报错、自装 SIGTERM / SIGINT 处理器（取消 Run → `host.close()` → 退出码 0）、读端 8 MiB 帧长检查、stdin EOF 优雅退出；各有测试。
- [ ] 1.3 `main()` 内按 argv 分派 `acp`，函数名与 console script 目标不变，不影响无参数的 v3 模式；`tests/test_harness_agent_entry.py` 保持通过。
- [ ] 1.4 `test_translate.py` 先失败，再实现基础翻译：`content.delta`、`reasoning.delta`、`tool.started`、`tool.delta` 参数缓冲不外泄、`tool.completed`。
- [ ] 1.5 `tool_display.py`：kind 映射表、标题规则、`locations` 解析（按 0.5 的结论）与测试。
- [ ] 1.6 `test_server_lifecycle.py` 先失败，再实现 `initialize`（先不含扩展协商）、`session/new`（cwd 校验）、`session/prompt`（终态映射、update 先于响应的顺序保证）、`session/cancel`。
- [ ] 1.7 `test_server_failure.py`：`startup_error`、`run.failed`、畸形输入、帧超限。
- [ ] 1.8 `test_server_cancel.py`：取消活动 Run、取消后立即再发 prompt、终态补发未结束 tool_call 为 `failed`。
- [ ] 1.9 TypeScript `harness acp` 透传：`args.ts` / `index.ts` 新增 `acp` 命令，`tests/args.test.ts`、`tests/index.test.ts` 先失败再实现；继承 stdio 并透传退出码。
- [ ] 1.10 `test_sdk_client_e2e.py`：官方 SDK 客户端 `spawn_agent_process` 启动 `python -m harness_agent acp`，完成一轮对话。
- [ ] 1.11 Python 全量测试、`bun test`、`npm run typecheck`、`npm run project:check` 通过；证据写入 Task；停下等待用户确认。

## 停点 2：标准 ACP 客户端功能完整

查看方式：`cd packages/agent && .venv/bin/python -m pytest -q tests/host/acp -s` 看官方 SDK 客户端的完整场景输出；可选：把 `harness acp` 配进 Zed 的 `agent_servers` 试用（非验收项）。

- [ ] 2.0 先在 Python 内部审批预检回调里捕获 `tool_call_id`，写入每个 `action_requests` 元素（先文件类工具；`execute`、MCP 工具最后做，做不完登记 GAP-23）；测试先失败；确认 TUI 和现有审批测试不受影响。
- [ ] 2.1 `test_permissions.py` 先失败，再实现 `permissions.py`：审批 → `session/request_permission`（选项映射、文本兜底、用 `tool_call_id` 关联工具调用，缺失时降级匹配）。
- [ ] 2.2 outcome 处理：`selected` → decision，`cancelled` / 断开 / 异常 → `reject`；`session/cancel` 时丢弃迟到的应答。
- [ ] 2.3 `test_permissions_directory_trust.py` 先失败，再实现目录信任翻译（`allow_session` / `deny`），声明 `directory_trust` handle。
- [ ] 2.4 `test_server_sessions.py` 先失败，再实现 `session/list`、`session/load`（回放、线程忙、线程不存在、cwd 不匹配）、`session_info_update`。
- [ ] 2.5 `test_server_commands.py` 先失败，再实现 `available_commands_update`、`/命令 参数` 补全 `requested_skill`、每连接一次 `bind_commands`、不匹配当普通文本。
- [ ] 2.6 `test_server_modes.py` 先失败，再实现 4 个模式、`plan` 不暴露、`session/set_mode`、`current_mode_update`。
- [ ] 2.7 `test_extension_negotiation.py` 先失败，再实现扩展协商：声明有效才带 `_meta.harnessCode.approval` 与 `run`；没声明或格式错误按没声明处理。
- [ ] 2.8 SDK 端到端扩充：拒绝一次、允许一次、目录授权、`/命令`、列出并恢复会话、中途取消。
- [ ] 2.9 Python 全量测试与 `npm run project:check` 通过；证据写入 Task；停下等待用户确认。

## 停点 3：浏览器里能用

查看方式：`npm run dev -- web`（会自动打开浏览器）。发一条消息，观察流式文字、思考和工具卡片；运行中点取消，再立即发一条；左侧能看到会话列表。浏览器里没有「返回 TUI」按钮，文件树与 Git 面板显示「暂不支持」。

- [ ] 3.0 前置改造（Spec §8.5）：测试先失败（浏览器 bundle 无 `node:` 空桩的自动检查），再切断 `InteractiveController` 对 Node 模块的间接依赖（只改 import 与依赖注入，TUI 在 `src/index.ts` 注入原实现）；修改「控制器只能在 `src/index.ts` 创建」的架构测试，允许 `src/acp-web/client/` 作第二个装配点；`tests/interactive`、`tests/tui`、`tests/web/architecture.test.ts` 全绿。
- [ ] 3.1 `guard.test.ts` 先失败，再实现 `guard.ts`（Host、Origin 校验）。
- [ ] 3.2 `session-token.test.ts` 先失败，再实现两段式凭据（bootCode 滑动过期、wsToken 一次性与 60 秒过期、连续错误暂停、恒定时间比较）。
- [ ] 3.3 `framing.test.ts` 先失败，再实现行分帧与帧校验（大小、二进制、数组、含换行）。
- [ ] 3.4 `bridge.integration.test.ts` 先失败，再实现 `bridge.ts`：路由、`POST /acp/boot`、WebSocket ⇄ 子进程转发、关闭回收（EOF → SIGTERM → SIGKILL）、子进程崩溃、第二个连接被拒；使用假子进程。
- [ ] 3.5 `harness web` 命令（`args.ts` / `index.ts`）：启动桥、打印提示、打开浏览器；Ctrl+C 回收全部子进程；测试先失败。
- [ ] 3.6 构建：第二个浏览器 bundle、HTML 外壳、`bundle.ts` 与清单扩展、`tests/web/bundle.test.ts` 更新。
- [ ] 3.7 `@agentclientprotocol/sdk@0.25.1`（用户确认，企业内部源版本）及必需 peer `zod` 加入依赖并更新依赖文档，`deps:check` 通过。
- [ ] 3.8 自写 WebSocket Stream 适配（满足 SDK `Stream` 接口，一帧一条 JSON-RPC；二进制帧或非法 JSON 关闭连接），单元测试先失败。
- [ ] 3.9 `acp-agent-gateway.test.ts` 先失败，再实现 `AcpAgentGateway`：`startRun`、事件翻译、终态映射、`cancel`、`setApprovalMode`、`listThreads`、`openThread`（回放）、ID 别名、`onThreadSummary`、`onClose`。
- [ ] 3.10 权限请求 ⇄ Core 交互处理（审批与目录信任），Core 无法处理或超时回 `cancelled`。
- [ ] 3.11 `acp-not-supported.test.ts` 先失败，再实现缺口方法抛 `ACP_NOT_SUPPORTED`（带 GAP 编号）；`runtime.capabilities` 只含已支持的能力。
- [ ] 3.12 `local-ui-client.test.ts` 先失败，再实现 `LocalUiClient`：快照 → 切片、intent 转发、文件树 / 工作区 / Trace / 接管状态的固定值。
- [ ] 3.13 新入口 `acp-web/client/app.tsx`、`ext.ts`（扩展声明）；读取 boot 信息、建立 WebSocket。
- [ ] 3.14 界面最小调整：隐藏「返回 TUI / 退出」、文件树与 Git 的「暂不支持」说明、审批倒计时超过 24 小时不显示；组件测试先失败。
- [ ] 3.15 `tests/web/architecture.test.ts` 保持通过；`bun test`、`npm run typecheck`、`npm run build`、`npm run project:check` 通过。
- [ ] 3.16 浏览器 E2E（桥 + 脚本化假 ACP Agent）：首页、发送、流式、取消；真实浏览器人工走查并保留截图。
- [ ] 3.17 证据写入 Task；停下等待用户确认。

## 停点 4：完整验收

查看方式：按 Task 的 13 条验收逐条核对。重点：浏览器里让 Agent 修改一个文件，看到 diff 审批卡片并分别点允许与拒绝；让 Agent 访问工作区外目录，看到授权卡片；刷新页面后恢复历史会话；用错误 token、错误 Origin 访问被拒绝；点击一个未提供的功能看到带 `GAP-xx` 的提示；查看终端启动提示、`docs/user/Web界面.md` 的「当前不支持」一节和 `architecture/ACP通信.md` 的缺口表。

- [ ] 4.1 浏览器中的文件 diff 审批卡片与目录信任卡片：组件与适配测试先失败，再实现；真实改文件端到端验证。
- [ ] 4.2 刷新页面恢复历史会话（`session/list` + `session/load`）的浏览器 E2E。
- [ ] 4.3 安全 E2E：无 token、错 token、重放、过期、错 Origin、超限帧、二进制帧、第二个连接、浏览器关闭回收子进程、子进程崩溃的界面提示。
- [ ] 4.4 缺口治理：`harness web` 启动提示；界面缺口提示；缺口表（GAP 编号）迁入 `architecture/ACP通信.md`；`docs/user/Web界面.md` 增加「当前不支持」一节。
- [ ] 4.5 文档：`docs/user/快速开始.md`（`harness web`、`harness acp`）、`架构总览.md` 增量修订、ADR 0003 后续说明。
- [ ] 4.6 看板：为每组缺口建后续 Task（状态待认领），编号写回缺口表；`npm run tasks:sync`。
- [ ] 4.7 全量检查：Python 全量、`bun test`、`typecheck`、`build`、`project:check`、`deps:check`；区分既有失败与环境限制。
- [ ] 4.8 用 `agent-skills:code-review-and-quality` 复核全部 diff，结论写回 Task；修复发现的问题。
- [ ] 4.9 Task 证据完整、7 项交付标准逐项对照；停下等待用户验收，**验收通过后才执行** `npm run task:complete -- HC-192 --evidence "..."`。
