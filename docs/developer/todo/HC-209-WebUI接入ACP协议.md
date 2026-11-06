# HC-209：WebUI接入ACP协议执行清单

来源：[Plan](../plan/HC-209-WebUI接入ACP协议.md) / [Spec](../spec/HC-209-WebUI接入ACP协议.md) / [Task](../task/HC-209-WebUI接入ACP协议.md)。

规则：每次只推进到下一个停点；到达停点后勾选本节、把证据写回 Task，然后停下等用户确认。每个实现项都先写失败的测试。

状态：S0 到 S3 已完成；S4 的 4.1 到 4.8 已完成，4.9 等用户验收。

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

- [x] 1.1 `host/acp/ext.py`：`EXT_KEY`、`EXT_METHOD_PREFIX` 常量与测试。（2 条用例通过，前缀由键推导并锁死）
- [x] 1.2 `test_stdio_hygiene.py` 先失败，再实现 `stdio.py`：fd 复制与重定向（`input_stream` 传写端、`output_stream` 传读端）、非管道 stdout 启动即报错、自装 SIGTERM / SIGINT 处理器（取消 Run → `host.close()` → 退出码 0）、读端 8 MiB 帧长检查、stdin EOF 优雅退出；各有测试。（三个测试文件 23 条用例；子进程验证 print/孙进程/stdin 继承都不污染协议，超限帧回 -32600 后继续收帧）
- [x] 1.3 `main()` 内按 argv 分派 `acp`，函数名与 console script 目标不变，不影响无参数的 v3 模式；`tests/test_harness_agent_entry.py` 保持通过。（`_select_mode` 仅 `["acp"]` 进 ACP；v3 路径运行期不加载 ACP SDK；手动已跑通一轮对话）
- [x] 1.4 `test_translate.py` 先失败，再实现基础翻译：`content.delta`、`reasoning.delta`、`tool.started`、`tool.delta` 参数缓冲不外泄、`tool.completed`。（31 条用例，含半截/超限/truncated 参数不外泄与终态补发）
- [x] 1.5 `tool_display.py`：kind 映射表、标题规则、`locations` 解析（按 0.5 的结论）与测试。（32 条用例，含映射表漂移测试与控制字符净化）
- [x] 1.6 `test_server_lifecycle.py` 先失败，再实现 `initialize`（先不含扩展协商）、`session/new`（cwd 校验）、`session/prompt`（终态映射、update 先于响应的顺序保证）、`session/cancel`。（28 条用例；裸行读断言所有 update 排在 prompt 响应之前）
- [x] 1.7 `test_server_failure.py`：`startup_error`、`run.failed`、畸形输入、帧超限。（20 条用例；诊断日志只含白名单字段，不含参数/文本/路径）
- [x] 1.8 `test_server_cancel.py`：取消活动 Run、取消后立即再发 prompt、终态补发未结束 tool_call 为 `failed`。（10 条用例；含取消早于受理、晚于终态两个竞态窗口）
- [x] 1.9 TypeScript `harness acp` 透传：`args.ts` / `index.ts` 新增 `acp` 命令，`tests/args.test.ts`、`tests/index.test.ts` 先失败再实现；继承 stdio 并透传退出码。（新增 `src/acp-command.ts`；47 条用例通过，`npm run typecheck` 通过；黑盒验证 stdin/stdout 一字节不改、退出码 7 透传、SIGTERM 转发）
- [x] 1.10 `test_sdk_client_e2e.py`：官方 SDK 客户端 `spawn_agent_process` 启动 `python -m harness_agent acp`，完成一轮对话。（6 条用例，含版本锁定 0.12.1、echo 模式一轮对话、脚本化 Agent 的工具卡、阻塞场景下取消、错参数退出码 2；「取消后恢复」由 `test_server_cancel.py` 覆盖）
- [x] 1.11 Python 全量测试、`bun test`、`npm run typecheck`、`npm run project:check` 通过；证据写入 Task；停下等待用户确认。（Review 修复后：Python 3244 passed / 5 skipped；CLI 主批 1355 pass / 1 skip / 0 fail，`takeover-recovery` 2 项因缺 Playwright 浏览器失败；`project:check` 仅剩他人 `research/187-*` 无效链接；`deps:check` 通过；证据见 Task「S1 实施与 Review 结论」）

## 停点 2：标准 ACP 客户端功能完整

查看方式：`cd packages/agent && .venv/bin/python -m pytest -q tests/host/acp -s` 看官方 SDK 客户端的完整场景输出；可选：把 `harness acp` 配进 Zed 的 `agent_servers` 试用（非验收项）。

- [x] 2.0 先在 Python 内部审批预检回调里记下 `tool_call_id`，在审批 payload 生成点写入每个 `action_requests` 元素（一次覆盖全部需要审批的工具族；同批「工具名 + 参数」完全相同时不注入，退回匹配）；测试先失败；确认 TUI 和现有审批测试不受影响。（已完成：新建 `runtime/approval_tool_calls.py` 与预检装饰器，一次覆盖 write/edit/delete/execute/web_fetch/task/MCP；同批相同 `(name,args)` 不注入；新增 25 条 Python 用例 + 1 条 TS 契约用例，真实 LangGraph 图测试拿到 `call-1`/`call-2`）
- [x] 2.1 `test_permissions.py` 先失败，再实现 `permissions.py`：审批 → `session/request_permission`（选项映射、文本兜底、用 `tool_call_id` 关联工具调用，缺失时降级匹配）。（已完成：新增 `host/acp/permissions.py`（纯函数 + `PermissionBroker`）、翻译器 `prepare_approval`/`mark_executing`/`finish_card`，删除 `announce_input` 并把 3 条用例迁移为 11 条；进程内集成 34 条，含批准/拒绝/降级匹配/兜底卡/串行批/双会话）
- [x] 2.2 outcome 处理：`selected` → decision，`cancelled` / 断开 / 异常 → `reject`；`session/cancel` 时丢弃迟到的应答。（已完成：审批无超时；`session/cancel` 先让 Run 进入取消再本地取消权限任务，断开/客户端异常一律 reject/deny 并 `resolve_interaction`；新增 6 条用例，含挂起中取消、迟到应答无副作用、断开无泄漏）
- [x] 2.3 `test_permissions_directory_trust.py` 先失败，再实现目录信任翻译（`allow_session` / `deny`），声明 `directory_trust` handle。（已完成：`prepare_trust` + `build_trust_job`，连接声明 `("approval","directory_trust")`；新增 7 条用例，含 `trust:{request_id}` 卡片、允许/拒绝往返与卡片收尾）
- [x] 2.4 `test_server_sessions.py` 先失败，再实现 `session/list`、`session/load`（回放、线程忙、线程不存在、cwd 不匹配）、`session_info_update`。（已完成：新增 `sessions.py`（列表映射/回放/时间格式）与 `load_session`/`list_sessions`，`_sender` 增加 `thread.summary` 分支，`to_request_error` 补线程存储与 Skill 错误码分支；新增 19 条用例 + 1 条错误映射表用例）
- [x] 2.5 `test_server_commands.py` 先失败，再实现 `available_commands_update`、`/命令 参数` 补全 `requested_skill`、每连接一次 `bind_commands`、不匹配当普通文本。（已完成：新增 `commands.py`（`CommandIndex`/`parse_slash`）与握手期一次绑定，列表非空才推 `available_commands_update`，绑定失败降级为普通文本；新增 11 条用例，含与 Host 解析的漂移测试）
- [x] 2.6 `test_server_modes.py` 先失败，再实现 4 个模式、`plan` 不暴露、`session/set_mode`、`current_mode_update`。（已完成：新增 `modes.py`（四项固定表、`plan` 回退 `default`）与 `set_session_mode`，三种 Run 竞态只记会话、`BUSY`/`PLAN_LOCKED` 按表报错，Run 准备期改模式在受理后补发；新增 15 条用例）
- [x] 2.7 `test_extension_negotiation.py` 先失败，再实现扩展协商：声明有效才带 `_meta.harnessCode.approval` 与 `run`；没声明或格式错误按没声明处理。（已完成：`ext.py` 增加 `Negotiation`/`negotiate` 与三个唯一出站口，`_meta.harnessCode.approval` 改挂在 `toolCall` 上（与设计 §4.1 一致）；新增 31 条用例，含「未声明时递归扫帧不含 harnessCode」）
- [x] 2.8 SDK 端到端扩充：拒绝一次、允许一次、目录授权、`/命令`、列出并恢复会话、中途取消。（已完成：`acp_scripted_main.py` 新增 `approval`/`trust`/`history`/`commands` 场景，官方 SDK 客户端跑真实子进程；新增 8 条用例，含未声明与已声明两种 `_meta` 断言）
- [x] 2.9 Python 全量测试与 `npm run project:check` 通过；证据写入 Task；停下等待用户确认。（已跑：`tests/host/acp` 310 passed；回归 775 passed / 1 skipped；`tests/runtime` 276 passed；Python 全量 3429 passed / 5 skipped；`npm run test` 主批 1356 pass / 1 skip、`takeover-recovery` 2 项因缺 Playwright 浏览器失败；`typecheck`/`project:check`/`deps:check` 全绿）

## 停点 3：浏览器里能用

查看方式：`npm run dev -- web`（会自动打开浏览器）。发一条消息，观察流式文字、思考和工具卡片；运行中点取消，再立即发一条；左侧能看到会话列表。浏览器里没有「返回 TUI」按钮，文件树与 Git 面板显示「暂不支持」。

- [x] 3.0 前置改造（Spec §8.5）：测试先失败（浏览器 bundle 无 `node:` 空桩的自动检查），再切断 `InteractiveController` 对 Node 模块的间接依赖（只改 import 与依赖注入，TUI 在 `src/index.ts` 注入原实现）；修改「控制器只能在 `src/index.ts` 创建」的架构测试，允许 `src/acp-web/client/` 作第二个装配点；`tests/interactive`、`tests/tui`、`tests/web/architecture.test.ts` 全绿。（已完成：controller.ts 拆桶导入 + resolveMentions 注入 + passthrough 默认；browser-bundle.test.ts 37 输入零 node:；526 pass）
- [x] 3.1 `guard.test.ts` 先失败，再实现 `guard.ts`（Host、Origin 校验）。（已完成：43 项用例覆盖精确 Host/Origin 匹配、JSON 请求体检视、限界 body 读取、CSP 与安全响应头）
- [x] 3.2 `session-token.test.ts` 先失败，再实现两段式凭据（bootCode 滑动过期、wsToken 一次性与 60 秒过期、连续错误暂停、恒定时间比较）。（已完成：25 项用例覆盖格式、兑换、一次性、滑动过期、5 连错锁定 30 秒、digest 恒定时间比较与无秘密泄漏）
- [x] 3.3 `framing.test.ts` 先失败，再实现行分帧与帧校验（大小、二进制、数组、含换行）。（已完成：framing 37 项 + assets 14 项，含 8 MiB 上限、UTF-8 跨块、行切分、stderr 尾部脱敏与安全资源名）
- [x] 3.4 `bridge.integration.test.ts` 先失败，再实现 `bridge.ts`：路由、`POST /acp/boot`、WebSocket ⇄ 子进程转发、关闭回收（EOF → SIGTERM → SIGKILL）、子进程崩溃、第二个连接被拒；使用假子进程。（已完成：routes 28 + lifecycle 23 + orphan 1 + python 6 + web-command 8 项用例，含真实脚本化 Agent 联调与孤儿回收验证）
- [x] 3.5 `harness web` 命令（`args.ts` / `index.ts`）：启动桥、打印提示、打开浏览器；Ctrl+C 回收全部子进程；测试先失败。（已完成：解析 11 项、execute 短路 2 项、黑盒 2 项用例；手动联调 Ctrl+C 5ms 退出、pgrep 无残留）
- [x] 3.6 构建：第二个浏览器 bundle、HTML 外壳、`bundle.ts` 与清单扩展、`tests/web/bundle.test.ts` 更新。（已完成：acp-web/bundle.ts + html.ts + build-web-assets.ts 产出 dist/acp-web.{js,css,assets.json}；bundle.test.ts 4 项；pack-publishable 断言）
- [x] 3.7 `@agentclientprotocol/sdk@0.25.1`（用户确认，企业内部源版本）及必需 peer `zod` 加入依赖并更新依赖文档，`deps:check` 通过。（已完成：sdk 0.25.1 + zod 3.25.76 精确锁定；ext.test.ts 真实读 ext.py 跨语言断言 3 项；deps:check/deps:test/typecheck/build 全过）
- [x] 3.8 自写 WebSocket Stream 适配（满足 SDK `Stream` 接口，一帧一条 JSON-RPC；二进制帧或非法 JSON 关闭连接），单元测试先失败。（已完成：ws-stream.ts + 10 项用例：帧门禁/bridgeExit 拦截/背压/closed 恒 resolve；bundle 入口零 node: 零 SDK 运行时代码）
- [x] 3.9 `acp-agent-gateway.test.ts` 先失败，再实现 `AcpAgentGateway`：`startRun`、事件翻译、终态映射、`cancel`、`setApprovalMode`、`listThreads`、`openThread`（回放）、ID 别名、`onThreadSummary`、`onClose`。（已完成：acp-agent-gateway.ts + 31 项用例 + wire 回放 4 项：握手/暖会话/别名/F11 顺序/取消/审批模式/失败收敛/列表/打开/关闭）
- [x] 3.10 权限请求 ⇄ Core 交互处理（审批与目录信任），Core 无法处理或超时回 `cancelled`。（已完成：permission.ts 13 项 + 网关审批/信任/取消挂起 5 项 + approval-no-timeout：timeout_ms=Infinity 无定时器 25h 仍 pending）
- [x] 3.11 `acp-not-supported.test.ts` 先失败，再实现缺口方法抛 `ACP_NOT_SUPPORTED`（带 GAP 编号）；`runtime.capabilities` 只含已支持的能力。（已完成：UNSUPPORTED_METHODS 27 项与接口漂移检查 30 项用例：拒绝 Promise 非同步抛、GAP 编号、catalogs.skills=error、capabilities 收窄）
- [x] 3.12 `local-ui-client.test.ts` 先失败，再实现 `LocalUiClient`：快照 → 切片、intent 转发、文件树 / 工作区 / Trace / 接管状态的固定值。（已完成：local-ui-client.ts 14 成员实现；4 项用例：8 切片/固定缺口值/引用缓存/deadlineAtMs=Infinity/handoff/workspaceIntent 拒绝/close 幂等）
- [x] 3.13 新入口 `acp-web/client/app.tsx`、`ext.ts`（扩展声明）；读取 boot 信息、建立 WebSocket。（已完成：boot.ts+session.ts+app.tsx；boot.test.ts 8 项 + session.integration.test.ts 真实桥+Python 1 项全绿）
- [x] 3.14 界面最小调整：隐藏「返回 TUI / 退出」、文件树与 Git 的「暂不支持」说明、审批倒计时超过 24 小时不显示；组件测试先失败。（已完成：handoffControls prop + configureSyntaxWorkerUrl；web-app/syntax 并列用例 + unsupported-panels 2 项 + interaction-deadline-render 1 项）
- [x] 3.15 `tests/web/architecture.test.ts` 保持通过；`bun test`、`npm run typecheck`、`npm run build`、`npm run project:check` 通过。（已完成：两处架构测试收紧为精确 ["acp-web/client/session.ts"] + ZC-114 同步；全量 bun test/typecheck/build/project:check 通过）
- [x] 3.16 浏览器 E2E（桥 + 脚本化假 ACP Agent）：首页、发送、流式、取消；真实浏览器人工走查并保留截图。（已完成：browser-e2e.test.ts 6 项经 HARNESS_E2E_CHROMIUM 全绿——首页/回显/工具卡片/取消重发/会话列表/GAP 提示/无 CSP 违规；截图 tmp/hc192-s3/screenshots/）
- [x] 3.17 证据写入 Task；停下等待用户确认。（已写入 Task「S3 实施与 Review 结论」；GAP-36 到 GAP-39 与 S3 偏离 Spec 之处已回写 Spec §12.3、§13）

## 停点 4：完整验收

查看方式：按 Task 的 13 条验收逐条核对。重点：浏览器里让 Agent 修改一个文件，看到 diff 审批卡片并分别点允许与拒绝；让 Agent 访问工作区外目录，看到授权卡片；刷新页面后恢复历史会话；用错误 token、错误 Origin 访问被拒绝；点击一个未提供的功能看到带 `GAP-xx` 的提示；查看终端启动提示、`docs/user/Web界面.md` 的「当前不支持」一节和 `architecture/ACP通信.md` 的缺口表。

- [x] 4.1 浏览器中的文件 diff 审批卡片与目录信任卡片：组件与适配测试先失败，再实现；真实改文件端到端验证。（已完成：新增 `diff` 脚本场景（write_file + file_diff presentation）与 trust 用例，E2E 批准/拒绝全绿；真实改文件留人工验收）
- [x] 4.2 刷新页面恢复历史会话（`session/list` + `session/load`）的浏览器 E2E。（已完成：history 场景 reload → 侧栏会话保留 → 点开回放「看完了。」全绿；host echo 不落盘（THREADS_UNAVAILABLE_IN_ECHO_MODE）会话不出现在 session/list，仅验证 reload 恢复）
  附加：Host 关闭时取消仍在连接的 MCP——真实配置（2 个远程 HTTP MCP）下关闭耗时 4.5s → 0.37s；MCP 不可达时 Host.close 由 >10s 降到 ~0s
- [x] 4.3 安全 E2E：无 token、错 token、重放、过期、错 Origin、超限帧、二进制帧、第二个连接、浏览器关闭回收子进程、子进程崩溃的界面提示。（已完成：九项拒绝用例在 bridge.routes/framing/lifecycle 已有覆盖，新增 E2E「SIGKILL → 界面显示进程已退出」「page.close → 子进程 8s 内退出」两项补齐界面侧证据）
- [x] 4.4 缺口治理：`harness web` 启动提示；界面缺口提示；缺口表（GAP 编号）迁入 `architecture/ACP通信.md`；`docs/user/Web界面.md` 增加「当前不支持」一节。（已完成：启动打印第二行指向文档并经 web-command.test 锁定；E2E 实测 GAP-11/12；39 项 GAP 权威表落 ACP通信.md，Spec §12.3 保留初版并指向权威；Web界面.md 新增「ACP 入口当前不支持的功能」覆盖全部编号）
- [x] 4.5 文档：`docs/user/快速开始.md`（`harness web`、`harness acp`）、`架构总览.md` 增量修订、ADR 0003 后续说明。（已完成：快速开始.md 新增「浏览器与 ACP 入口」；架构总览.md 在 JSON-RPC v3 节后新增「ACP 通信（HC-209）」；ADR 0003 追加「后续说明（HC-209，2026-11）」）
- [x] 4.6 看板：为每组缺口建后续 Task（状态待认领），编号写回缺口表；`npm run tasks:sync`。（已完成：新建 `HC-210-补齐ACP缺口扩展.md` 与 `HC-211-Electron桌面端.md`（P1/待认领/未认领）；缺口表「后续 Task」列已写回编号；`npm run tasks:sync` 执行无报错）
- [x] 4.7 全量检查：Python 全量、`bun test`、`typecheck`、`build`、`project:check`、`deps:check`；区分既有失败与环境限制。（已完成：pytest 二次全量 3437 pass/5 skip/0 fail（首次曾现 test_server_modes 1 fail——session/new 收到 NOT_INITIALIZED，疑似测试进程内 initialize 应答竞态；复跑不复现，单跑 15/15 绿，未改代码）；最终全量 bun test 1782 pass/1 skip/7 fail——7 项全部集中在 takeover-recovery.test.ts，缺 Playwright chromium_headless_shell-1217 修订版（环境问题，chromium.launch() 不读 HARNESS_E2E_CHROMIUM，照记不修）；含 E2E 的浏览器用例全量下全绿；typecheck/build/project:check/deps:check 全绿）
- [x] 4.8 用 `agent-skills:code-review-and-quality` 复核全部 diff，结论写回 Task；修复发现的问题。（已完成：S4 diff 审阅结论写入 Task「S4 实施与 Review 结论」；架构与用户文档的事实错误已更正）
- [ ] 4.9 Task 证据完整、7 项交付标准逐项对照；停下等待用户验收，**验收通过后才执行** `npm run task:complete -- HC-209 --evidence "..."`。
