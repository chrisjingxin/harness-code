# HC-209：WebUI接入ACP协议规格

来源：[Task](../task/HC-209-WebUI接入ACP协议.md)。Task 的范围、入口（`harness web`）、传输方案（stdio 为主、WebSocket 只做浏览器调试桥）和前端复用方式（复用组件、只写适配层）已由用户确认。本规格把它们落实到模块、接口、映射表和验证方式。

状态：用户已确认（2026-11-05），包括扩展前缀 `_meta.harnessCode` / `_harnessCode/`。后续按 [Plan](../plan/HC-209-WebUI接入ACP协议.md) 与 [Todo](../todo/HC-209-WebUI接入ACP协议.md) 实施。

---

## 1. 目标与成功标准

**目标**：用户运行 `harness web`，浏览器里的现有 Web 界面通过标准 ACP（Agent Client Protocol）与 Python Agent 对话。同一个 Agent 也能通过 `harness acp`（stdio）被任何 ACP 客户端驱动。

**成功标准**（对应 Task 的 12 条验收，这里给出怎么验证）：

| # | 结果 | 怎么验证 |
|---|---|---|
| 1 | `harness web` 打开浏览器并出现对话界面 | 浏览器 E2E 测试；人工运行 |
| 2 | 流式回复、思考、工具卡片 | Python 事件翻译单测 + 浏览器适配层单测 + 人工 |
| 3 | 审批卡片显示 diff，允许/拒绝生效 | Python 权限映射单测 + 浏览器适配层单测 + 人工（真实改文件） |
| 4 | 取消运行并可立即再发 | 官方 SDK 客户端集成测试 + 人工 |
| 5 | 刷新后恢复历史会话 | `session/list` + `session/load` 集成测试 + 人工 |
| 6 | Agent 侧斜杠命令 | `available_commands_update` 单测 + 命令调用集成测试 |
| 7 | 非法浏览器连接被拒、子进程被回收 | 桥的单元与集成测试（见 §8） |
| 8 | 官方 SDK 客户端经 stdio 对话一轮，stdout 洁净 | 用 `agent-client-protocol` 写的测试客户端 |
| 9 | TUI、`/web` 接管、无头模式不变 | 既有测试全部通过 |
| 10 | ACP 缺口登记表随 Task 提交并回填 | 文档检查（§12） |
| 13（新增） | 每组缺口在看板有后续 Task，编号写回缺口表 | 归档前人工核对看板 |
| 11 | 双端测试覆盖取消、断连、畸形帧、终态错误 | §10 测试清单 |
| 12 | 包级与项目级检查通过 | §3 命令 |

---

## 2. 前置调研结论（2026-11-05 核实）

下列事实决定了设计，Spec 里的选择都建立在它们之上。

**ACP 协议与 SDK**

1. ACP 当前正式传输只有 stdio：客户端把 Agent 当子进程启动，消息按换行分隔，单条消息不得含换行；Agent 的 stdout 只能出现合法 ACP 消息（[传输](https://agentclientprotocol.com/protocol/transports)）。
2. 官方对 WebSocket 的方案还是 RFD（草案，状态 Active）：WebSocket 文本帧里放且只放一条 JSON-RPC 消息，二进制帧忽略，JSON 数组一律拒绝（[RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)）。我们的桥按这个格式做，将来可以平滑换成官方方案。
3. 扩展有正式机制：`_meta` 字段、以 `_` 开头的自定义方法、在初始化时用 `_meta` 声明扩展能力；不认识的通知必须忽略（[扩展](https://agentclientprotocol.com/protocol/extensibility)）。
4. TypeScript SDK `@agentclientprotocol/sdk`：npm 上最新是 2.4.0（2026-11-02），但**企业内部源只有 0.25.1（2026-06-13），本任务按 0.25.1 实施**（用户确认）。Apache-2.0，必需的 peer 依赖只有 `zod`。S0 追加实测 0.25.1：支持本任务用到的全部能力（`ClientSideConnection`、`Stream` 类型、`listSessions`、`loadSession`、`session_info_update`、`current_mode_update`、`available_commands_update`、各类型的 `_meta`）；打进浏览器 bundle，Bun 成功，0.74 MB，无 `node:` 引用。0.25.1 没有 `createWebSocketStream`，所以 WebSocket 流适配本来就要自己写（见 §8.5）。它是 1.0 之前的 API（构造方式为 `new ClientSideConnection(toClient, stream)`），升级到 1.x 或 2.x 时 `AcpAgentGateway` 里的连接创建和处理器注册要跟着改，改动集中在这一个文件。浏览器 WebSocket 不能带自定义头，所以鉴权放在 URL 里。
5. Python SDK `agent-client-protocol` 当前 0.12.1（未到 1.0），Apache-2.0，核心只依赖 `pydantic>=2.7`，`run_agent(agent, input_stream, output_stream)` 支持自定义流。在本仓库 `packages/agent/.venv` 里 `uv pip install --dry-run` 验证：只新增这一个包，pydantic 2.12.5、anyio 4.12.1 等固定版本不变。S0 实测：`run_agent` 的 `input_stream` 参数要传**写端**（`StreamWriter`）、`output_stream` 要传**读端**（`StreamReader`），名字和语义相反；复制出来的 stdout 必须是管道、套接字或字符设备（重定向到普通文件会抛 `ValueError`）；SDK 不安装信号处理器，SIGTERM 会直接杀进程；`stdio_buffer_limit_bytes` 只是读缓冲大小，不会拒绝超长帧。

**现有代码**

6. Web 前端只通过一个窄接口取数据：`WebUiClient`（`web/ui-client.ts`，提供 8 个视图切片、`submitIntent`、订阅）。`WebApp` 和所有组件不直接碰 WebSocket 或协议。已有 `WebInteractiveAdapter` 在其上叠加表现状态（草稿、菜单、面板）。
7. Interactive Core（`packages/cli/src/interactive/`，6558 行）自身没有 `node:`、`process`、`Bun` 引用，对外只通过 `AgentGateway` 接口（`interactive/ports/agent-gateway.ts`）取 Agent 的能力。它已经包含事件折叠成时间线、活动状态机、会话恢复、命令菜单、审批与提问卡片等全部逻辑。**但 S0 实测：`controller.ts` 通过 `../infrastructure`（含 IPC 客户端、Prompt 历史文件存储）、`../workspace/mention-resolver.ts`、`../tui/application/prompt-history.ts` 间接引入了 `node:fs/promises`、`node:path`、`node:os`、`node:buffer`**。Bun 打浏览器 bundle 时会静默换成空桩，打包成功（2.6 MB）但相关功能一调用就报错。另有一条架构测试（`tests/web/architecture.test.ts`）规定 `createInteractiveController(` 的生产调用点只能是 `src/index.ts`。
8. Python 侧业务（`RunCoordinator`、审批、会话存储）不依赖传输方言；与 JSON-RPC 耦合的只有 `AgentHost.run/send/dispatch` 和 `ProtocolInteractionAdapter`。`AgentHost` 已能登记额外连接（`create_connection(sender, ...)`），事件会通过该连接的 `sender` 回调推出。
9. Harness 的工具分类 `ToolKind`（read/edit/delete/execute/fetch…）与 ACP 的 `ToolKind` 基本同名，映射成本很低。
10. v3 的 `tool.started` 事件只有工具名，**没有参数**；参数要从 `tool.delta` 的 `arguments_delta` 拼出。审批请求的 payload 里每个动作只有 `name`、`args`、`description` 三个键，**没有 `tool_call_id`**；但 S0 查实 `tool_call_id` 在审批前的预检回调里是已知的，`payload.requests` 的 schema 是任意 JSON，往每个 action 元素里加 `tool_call_id` 不破坏校验。审批用的文件 diff 是 `unified_diff` 文本（最多 16 KiB / 200 行），**不是 ACP `diff` 内容要求的 `oldText/newText` 全文**。
11. 历史消息（`threads.open`）里的 tool 记录只有工具名和结果文本，没有调用 id、参数、状态。

---

## 3. 命令

```text
# Python Agent（packages/agent）
测试：    cd packages/agent && .venv/bin/python -m pytest -q
只跑 ACP： cd packages/agent && .venv/bin/python -m pytest -q tests/host/acp
启动 ACP： python -m harness_agent acp        # stdio；等价于 harness-agent acp

# TypeScript CLI（packages/cli）
测试：    cd packages/cli && npm run test   # 显式目录列表；裸 bun test 会误加载 Playwright 的 e2e 用例
类型检查： npm run typecheck
构建：    npm run build                       # 含新增的 ACP Web bundle
运行：    harness web                         # 开发时：npm run dev -- web
          harness acp                         # 把 sidecar 的 stdio 原样透传给编辑器

# 项目级
npm run project:check
npm run deps:check                            # 新增依赖后必须通过
```

---

## 4. 总体设计

### 4.1 拓扑

```text
  浏览器（现有 React 组件，不改）
    │  WebApp ← WebInteractiveAdapter（不改）← LocalUiClient（新）← InteractiveController（现有 Interactive Core，不改）
    │                                                                   │ AgentGateway 接口
    │                                                        AcpAgentGateway（新）
    │                                                                   │ @agentclientprotocol/sdk（ClientSideConnection）
    ▼   WebSocket：一帧 = 一条 JSON-RPC
  ┌──────────────────────────── harness web（Bun/TS 进程）────────────────────────────┐
  │  静态文件服务 + 桥：校验 Host / Origin / 一次性 token → 每个 WebSocket 对应一个     │
  │  Python 子进程；帧 ⇄ stdio 行，原样转发，不解析 ACP 内容                         │
  └───────────────────────────────────────────────────────────────────────────────────┘
    ▼   stdio：换行分隔的 JSON-RPC（标准 ACP）
  python -m harness_agent acp（Python 进程）
    AcpServer（新）：ACP 方法 → AgentHost 服务面；v3 事件/审批 → ACP 更新/权限请求
        │
    AgentHost → RunCoordinator / 审批 / Thread 存储（现有，业务不复制）
```

Electron 阶段：主进程同样启动 `python -m harness_agent acp`，用 Electron 内部通道代替 WebSocket 桥；`AcpAgentGateway` 以下不变。第三方 ACP Agent 也走同样的子进程 + stdio。

### 4.2 三个模块与建设顺序

| 模块 id | 职责 | 依赖 |
|---|---|---|
| `acp-agent` | Python 侧：`harness acp` 入口、AcpServer、事件与权限翻译、AgentHost 服务面 | 无（只依赖现有业务） |
| `web-bridge` | Bun 侧：`harness web` / `harness acp` 命令、静态服务、WebSocket ⇄ stdio 桥 | `acp-agent` 的 stdio 契约 |
| `web-acp-client` | 浏览器侧：`AcpAgentGateway`、`LocalUiClient`、新入口 bundle | `acp-agent` 的 ACP 子集；`web-bridge` 提供连接 |

建设顺序：`acp-agent` → `web-bridge` → `web-acp-client`。`acp-agent` 完成后即可用官方 SDK 测试客户端独立验证，不依赖前端。

### 4.3 关键决策（含已放弃的方案）

**D-1：Python 侧用「服务面 + 翻译器」，不在内部再说一遍 v3。**
- 放弃方案：`AcpServer` 把 ACP 请求拼成内部 v3 JSON-RPC，调用 `host.dispatch_connection`，再把响应拆回来。这样 `AgentHost` 零改动，但 v3 永远不能删，和「TUI 下线后只剩 ACP」的目标冲突，还多一层 schema 校验与字符串 id 转换。
- 采用方案：从 `AgentHost` 现有 `_handle_*` 里抽出一组不依赖 ContextVar 的服务方法（见 §5.2），v3 处理器变成薄壳调用它们，`AcpServer` 也调用它们。TUI 下线时删掉薄壳即可。
- 风险：要动 `agent_host.py`（约 6250 行）。控制办法：这一步是纯重构，先于任何 ACP 代码完成，用现有 `tests/host/` 全部通过作为门槛，并且只抽 §5.2 列出的方法。

**D-2：一个进程只说一种方言。** `python -m harness_agent`（无参数）仍是 v3，TUI 和无头模式照旧；`python -m harness_agent acp` 只说 ACP。两种方言不会在同一进程里并存，也就不存在两套 Run 状态。

**D-3：浏览器侧复用 Interactive Core，只替换它下面的 `AgentGateway`。**
- 放弃方案：写一个新的 ACP → 视图切片的折叠器，直接实现 `WebUiClient`。需要重写事件折叠、活动状态机、会话恢复、命令菜单、审批卡等已经测试过的逻辑。
- 采用方案：新增 `AcpAgentGateway`（把 ACP 翻译成 `AgentGateway` 约定的 v3 事件形状），复用 `InteractiveController`；再新增很薄的 `LocalUiClient`，把控制器快照用现有 `select*View` 选择器切成 8 个视图切片，满足 `WebUiClient`。`WebApp`、`WebInteractiveAdapter`、全部组件不改。
- 代价（明确记录）：v3 的事件词汇暂时留在浏览器的 Interactive Core 里，形成「Python：v3 → ACP；浏览器：ACP → v3 形状」的两次翻译。退出条件：TUI 下线 Task 完成后，Interactive Core 改成直接消费 ACP 形状，`AcpAgentGateway` 里的反向翻译随之删除。
- 前置改造（S0 实测发现，见 §8.5）：要让控制器能在浏览器里运行，必须先切断它对 Node 模块的间接依赖，并修改那条「控制器只能在 `src/index.ts` 创建」的架构测试，让 `src/acp-web/client/` 成为第二个合法的装配点。

**D-4：一个 WebSocket 连接对应一个 Python 子进程。** ACP 的 `initialize` 每个连接只能有一次，子进程的生命周期必须和连接一致。刷新页面 = 旧连接关闭、旧进程退出、新连接新进程；运行中的任务会被取消（与编辑器关掉面板一致），会话数据在 SQLite 里不丢，新页面通过 `session/load` 恢复。代价是每次刷新有一次 Python 启动开销。Electron 主进程常驻子进程，不受此影响。

**D-5：审批 diff 先用 `_meta` 完整携带，标准内容给文本兜底。** ACP 的 `diff` 内容要 `oldText/newText` 全文，而现有预计算只有被截断的 `unified_diff`。一期不改审批预计算，把完整的 `file_diff` 放进工具调用的 `_meta.harnessCode.approval`（我们的界面按它渲染，完全无损），同时放一段文本兜底（Markdown 代码块里的 unified diff），保证 Zed 等通用客户端至少能看到改动。二期要产出标准 `diff` 内容时，扩展审批预计算携带前后文。竞品里 codex-acp 对 JetBrains AIR 的做法类似：把 Git 补丁文本放在 `_meta` 里，标准的 `oldText/newText` 只留占位。

**D-6：一期只开放 `build` 工作模式。** compose、direct_shell 不暴露。

### 4.4 扩展命名与协商

**竞品怎么做**（2026-11-05 核对公开源码与文档）：

| 实现 | 自定义方法 | `_meta` 键 | 备注 |
|---|---|---|---|
| Goose | `_goose/…`，试验性的加 `_goose/unstable/…` | 未核实 | 产品名作前缀 |
| CodeBuddy | `_codebuddy.ai/…` | `codebuddy.ai/…` 平铺键 | 产品域名作前缀（没有倒序）；文档把每个键标注为「公共/私有」，并要求标准 ACP 面零 `_meta` 也必须完整可用 |
| claude-agent-acp | — | `_meta.claudeCode`（嵌套对象） | 产品名；另沿用 Zed 的 `terminal_info`、`terminal_output` 等无前缀键 |
| codex-acp | `_auth/…`、`_session/…` | `_meta.jetbrains.air`（嵌套）、`_meta.codex` | 厂商加客户端名两级；**客户端在 `initialize` 里声明才启用**，没声明的客户端只拿到标准字段 |
| Qwen Code | 用 SDK 的 `extMethod` | 未核实前缀 | 主要走标准能力 |

ACP 官方推荐「反向域名 + `/`」（如 `com.example/name`），但没有一个主流实现严格照做；实际是「产品名」或「厂商.客户端」的嵌套对象。共同点有两条：扩展可选、不认识的一方忽略；带扩展的字段只发给声明过的客户端。

**本任务的约定**（用户已确认；将来要换成域名风格，只需改两个常量）：

```text
_meta 对象：      _meta.harnessCode          # 嵌套对象，里面再放 approval、run 等子键
自定义方法前缀：  _harnessCode/              # 例如 _harnessCode/threads/undo（二期以后使用，一期不实现）
版本：            _meta.harnessCode.version = 1
常量位置：        Python host/acp/ext.py 的 EXT_KEY、EXT_METHOD_PREFIX；TypeScript acp-web/ext.ts 同名常量
```

**协商（照 codex-acp 的做法）**：

```text
客户端 → initialize.clientCapabilities._meta.harnessCode = {version: 1, capabilities: ["approval", "runSummary"]}
Agent  → 只有客户端声明了，才在后面的消息里带 _meta.harnessCode.*，
         并在 initialize 响应的 agentCapabilities._meta.harnessCode 里回报自己支持的能力
没声明（Zed、官方 SDK 示例客户端等）→ 只有标准字段和文本兜底，行为完整可用
```

声明格式出错或版本不识别时，按「没声明」处理（保守，不报错）。

---

## 5. 模块 acp-agent（Python）

### 5.1 文件布局

架构测试限制：包根只能有 `__init__.py`、`__main__.py`；非 `host/` 的模块不能 import `harness_agent.host.*`。所以 ACP 代码放在 `host/` 下：

```text
packages/agent/harness_agent/
  __main__.py              # 增加 acp 分支：按 argv[1] == "acp" 选择 AcpServer
  host/
    agent_host.py          # 抽出服务方法（§5.2），v3 处理器改为薄壳
    acp/
      __init__.py          # 只导出 run_acp_stdio
      stdio.py             # fd 洁癖 + 用 SDK 的 run_agent 接管 stdin/stdout
      server.py            # AcpServer：实现 SDK 的 Agent 接口，调用 AgentHost 服务面
      translate.py         # 纯函数/小状态机：v3 事件 → ACP session/update
      permissions.py       # 审批请求 ⇄ session/request_permission
      tool_display.py      # 工具 kind、标题、位置的展示规则
packages/agent/tests/host/acp/   # 对应测试（见 §10）
```

### 5.2 AgentHost 服务面（D-1 的具体接口，S0 已实现）

这是 `AcpServer` 能调用的全部东西。每个方法从现有 `_handle_*` 抽出，**v3 行为不变**，不再从 ContextVar 取当前连接，而是显式传入。服务方法直接长在 `AgentHost` 类上（没有新建服务类，理由见 S0 方案：服务方法要用约 15 个私有协作者，拆出去只会换个文件写同样的代码并制造循环引用）。`host/service_types.py` 只放数据类和 `HostServicePort`（`typing.Protocol`），`AcpServer` 只依赖它；一致性测试保证 `AgentHost` 满足它。

```python
class HostServicePort(Protocol):
    async def ensure_ready(self) -> HostSnapshot
        # 资源初始化（技能目录、配置、MCP 后台连接、代码索引 start），可重复调用，只做一次
    def open_connection(self, sender, *, enabled_capabilities, interaction_handles,
                        capability_ceiling=..., role="owner") -> ProtocolConnection
        # 登记一条已协商好的外部连接；未知 handle 与缺 sender 抛 ValueError
    async def bind_commands(self, connection, snapshot_id, bindings: Sequence[tuple[id, name]]) -> None
    async def start_run(self, connection, request: StartRunRequest, *,
                        on_accepted: Callable[[RunAccepted], Awaitable[None]] | None = None) -> RunAccepted
        # 受理 Run；含 undo 收敛、git 检查点、标题自动生成；on_accepted 在受理后、事件扇出前调用
    async def cancel_run(self, connection, thread_id, run_id) -> CancelResult
    async def set_approval_mode(self, connection, thread_id, run_id, approval_mode) -> ApprovalModeResult
    async def list_threads(self, limit) -> list[ThreadSummary]
    async def open_thread(self, thread_id, *, assume_idle=False) -> dict      # 只读历史，不登记 watch
    def watch_thread(self, connection, thread_id) -> None                      # 只登记，线程可以尚未落库
    async def open_and_watch_thread(self, connection, thread_id) -> dict       # 同一个 idle 窗口里读历史并登记
    def unwatch_thread(self, connection, thread_id) -> bool
    def resolve_interaction(self, connection, request_id, result) -> "resolved" | "expired" | "invalid"
    def fail_interaction(self, connection, request_id, error: RpcError) -> bool
    async def close_connection(self, connection) -> None                       # 取消该连接发起的 Run，挂起的交互 fail-closed
```

`AgentHost` 另有只读属性 `workspace`，`AcpServer` 校验 `session/new` 的 `cwd` 时使用。

关键约定：
- **`start_run` 的顺序**：受理 → 调 `on_accepted` → 排标题自动生成 → 起事件扇出任务。v3 在 `on_accepted` 里发响应，保证「响应先于事件」；`AcpServer` 在回调里登记会话当前的 `run_id`，保证登记不晚于第一个事件。`on_accepted` 抛异常则不排标题、不起扇出。它返回 `RunAccepted` 而不是 `RunExecution`，因为 `events` 迭代器只能被消费一次，扇出任务已经在消费。
- **连接**：`AcpServer` 用 `role="owner"` 登记连接，并启用 `run.multithread`（ACP 会话天然可并发）。服务方法**不**经过 `ControlLease` 的 permit：该互斥只为 owner 与 attached 之间转移控制权而设，ACP 进程里没有 attachment，不变量天然成立；因此 ACP 进程里不能暴露 `host.control.*` 和 `host.attachment.*`。
- **事件与交互沿用原路径**：`_fanout_agent_event` 和 `ProtocolInteractionAdapter` 没有改动，ACP 连接的 `sender` 照样收到 v3 形状的帧（`event`、`thread.summary`、`interaction.approval` / `interaction.directory_trust`），由 `AcpServer` 自己翻译。`sender` 必须快速返回（事件只入队，交互请求只起任务去发 `session/request_permission`），而且不要抛异常：`_fanout_agent_event` 发现非 owner 连接的 `sender` 抛异常会关闭该连接，等于取消它的所有 Run。
- **`resolve_interaction` 的 `request_id`** 是 v3 `InteractionRequest.request_id`（待回答表的键），与 ACP 线路上的 JSON-RPC id 无关；官方 Python SDK 的 `request_permission` 自己分配线路 id（S2 已核实）。
- **机器检查**：AST 测试禁止服务方法体里出现 `_current_connection`、不带参数的 `_connection_capabilities()` / `_connection_handles()` / `_connection_watches()`、`send_response`、`send_error`、`send_notification`、`_connection_context`。

不变量：
- `start_run`、`cancel_run`、`resolve_interaction` 与 v3 路径调用同一个 `RunCoordinator`（测试 `test_service_and_v3_paths_share_one_run_coordinator` 锁定）；ACP 路径不得复制 `_handle_run_start` 里的 undo 状态收敛和 git 检查点逻辑。
- ACP 连接的 `interaction_handles` 声明 `approval` 和 `directory_trust`。`ProtocolInteractionAdapter` 对未声明的类型（question、plan、goal、plugin_consent）直接返回安全默认值（plan abandoned、goal cancelled、question 空答案），**不会向客户端发请求**。这是现有的「保守拒绝」机制，ACP 路径沿用，不新增分支。
- 抽取完成后，既有 `tests/host/` 全部通过，且没有新增行为（S0 另增 25 个特征化测试，在重构前的代码上就通过）。

### 5.3 启动与 stdout 洁癖（`stdio.py`）

`harness acp` 的 stdout 必须只出现合法 ACP 消息。现有 v3 路径靠「代码里不要 print」的约定，没有运行期保护；ACP 模式加固：

```text
输入 → 进程最早处：把真实 stdout（fd 1）复制出来，专供 ACP 写帧
      → 把 fd 1 重定向到 stderr，并让 sys.stdout 指向 sys.stderr
      → 把复制出来的 fd 和 stdin 交给 SDK 的 run_agent(agent, input_stream, output_stream)
      → 任何库的 print、继承 fd 1 的子进程输出都落到 stderr，不会污染协议通道
输出 → stdout 上只有 ACP 帧；诊断走 stderr 与既有诊断日志
```

S0 实测带来的实现要求：

1. 给 `run_agent` 的参数名和语义相反：`input_stream` 传写端（包装复制出来的 fd 的 `StreamWriter`），`output_stream` 传读端（包装 stdin 的 `StreamReader`）。
2. 复制出来的 fd 必须是管道、套接字或字符设备。`harness acp > 文件` 这种重定向不受支持：启动时检测，打印一行明确的 stderr 错误后以非 0 退出，不静默失败。编辑器和我们的桥都用管道，不受影响。
3. SDK 不处理信号：我们自己安装 SIGTERM / SIGINT 处理器，行为是「取消该连接的 Run → `host.close()` → 退出码 0」。stdin EOF 时 `run_agent` 会自己返回，随后走同一条收尾路径。
4. `stdio_buffer_limit_bytes` 不会拒绝超长帧，所以与 v3 的 8 MiB 上限对齐要自己做：在读端包一层长度检查，超过 8 MiB 的帧按 JSON-RPC `-32600` 拒绝并继续（桥侧同样限制 8 MiB）。

### 5.4 ACP 方法

| 方法 | 行为 |
|---|---|
| `initialize` | 协议版本固定 1。返回 `agentInfo{name:"harness-code", version}`；`agentCapabilities`：`loadSession:true`，`promptCapabilities` 全 false，`mcpCapabilities{http:false,sse:false}`，`sessionCapabilities{list:{}}`；`authMethods:[]`。读取 `clientCapabilities._meta.harnessCode`（§4.4），声明有效才在 `agentCapabilities._meta.harnessCode` 回报并启用扩展字段。客户端 `fs` / `terminal` 能力一律不使用。内部调用 `ensure_ready()` 和 `open_connection()`。 |
| `session/new` | 生成 `sessionId`（= `thread_id`，uuid4）。`cwd` 必须解析为本进程绑定的工作区，否则返回 `-32602`，消息说明工作区不一致（Host 在启动时固定一个工作区，不支持按会话切换）。`mcpServers` 一期忽略，写诊断日志。返回 `modes`（见下）。随后推送一次 `available_commands_update`（命令表为空时不发）。**不调用 `watch_thread`**：单连接下自己发起的 Run 事件和标题广播本来就发给 owner 连接。线程在第一次 Run 受理时才落库。 |
| `session/load` | 仅当线程存在且空闲：`open_thread` 后按顺序回放 `user_message_chunk` / `agent_message_chunk`；历史里的 tool 记录回放成一条 `completed` 的 `tool_call`（`toolCallId = "{sessionId}:h{序号}"`，标题为工具名，内容为结果文本，没有参数和状态）；全部回放完再返回响应。线程有活动 Run 返回 `-32603`，`data={"code":"THREAD_BUSY","retryable":true}`。线程不存在返回 `-32002`，**包括 `session/new` 之后还没有过任何一轮 Run 的 id**（线程尚未落库，必须至少有过一轮 Run 才能被 load）。用 `open_and_watch_thread` 在同一个 idle 窗口里读历史并订阅；失败时只摘掉本次新加的订阅。ACP 的错误码在 `to_request_error` 里集中映射，不改 v3 的映射。 |
| `session/list` | 调用 `list_threads(limit)`，只返回当前工作区的线程。字段：`sessionId`、`cwd`（工作区绝对路径）、`title`（标题，缺省取首条消息前 40 字）、`updatedAt`（ISO 8601）。一期不分页：ACP 的 `session/list` 请求没有 limit 参数，服务端固定取 200 条，不返回 `nextCursor`。echo 模式没有线程存储，返回 `-32603`（`data.code="THREADS_UNAVAILABLE_IN_ECHO_MODE"`），不是空列表。 |
| `session/prompt` | 见 §5.5。 |
| `session/cancel`（通知） | 找到该会话当前 `run_id`，调用 `cancel_run`；没有活动 Run 则忽略。 |
| `session/set_mode` | 见 §5.6。 |
| 其它 | 未实现的标准方法返回 `-32601`。 |

`session/new` 和 `session/load` 的响应带 `modes`；`session/load` 的 `cwd` 同样必须匹配工作区。

### 5.5 `session/prompt` 的执行流

```text
输入：sessionId、prompt（ContentBlock 数组）
 → 校验：会话已 new/load；本会话没有活动 Run；文本非空
 → 内容转换：text 块用换行拼接；resource_link 块转成 "@相对路径" 文本；
              其它块类型客户端不会发（promptCapabilities 全 false），收到则 -32602
 → 命令识别：文本以 "/名称 参数" 开头且名称在 agent_commands 里（大小写不敏感）
              → 补全 requested_skill{id, args, raw_invocation, command_name}
              （连接建立时已按 bind_commands 绑定过；不匹配的 "/xxx" 当普通文本）
 → start_run(mode=build, run_id=uuid4, approval_mode=当前会话模式)
 → 事件经 sender 到 translate.py，边翻译边推 session/update
 → 收到该 Run 的终态事件：先推完它之前的所有 update，再返回 prompt 响应
终态映射：
   run.completed → stopReason "end_turn"（用量与耗时放 _meta，见 §6.3）
   run.cancelled → stopReason "cancelled"
   run.failed    → JSON-RPC 错误 -32603，data = {code, message, retryable}
```

顺序保证：所有写 stdout 的动作经同一个有序队列。终态事件在事件流里排在最后，所以 `session/update` 一定先于 `session/prompt` 的响应到达客户端。

`startup_error`（如模型未配置）：`session/new` 照常成功；`session/prompt` 返回 `-32603`，`data.code` 为 `MODEL_CONFIGURATION_REQUIRED` 或 `CONFIGURATION_ERROR`，界面能显示原因。

取消：`session/cancel` 后，若有等待客户端回答的权限请求，客户端按 ACP 约定回 `cancelled`；Agent 侧丢弃迟到的回答（请求 id 已不存在时忽略）。Run 以 `cancelled` 终态结束。仍处于 `pending`/`in_progress` 的 tool_call 在终态时统一补发 `failed` 更新，避免界面卡在运行中。

### 5.6 审批模式作为 ACP 会话模式

对外暴露 4 个模式：`default`（逐项确认）、`auto-edit`（自动批准编辑）、`auto`（分类器判断）、`yolo`（全部放行）。`plan` 不暴露：它依赖「确认计划」交互，而 ACP 没有标准形态，一期会被默认放弃（见缺口登记表）。

- `session/new` / `load` 返回的 `currentModeId`：取配置里的默认审批模式（**产品默认是 `auto`，不是 `default`**）；若是 `plan` 则回退 `default`。
- `session/set_mode`：没有活动 Run 时只记在会话上，下一次 `start_run` 作为 `approval_mode` 传入；有活动 Run 时调用 `set_approval_mode`。错误映射：`RUN_APPROVAL_MODE_BUSY`（正在等审批）→ `-32603`，`data.retryable=true`；`RUN_APPROVAL_MODE_PLAN_LOCKED` → `-32603`，`data.code` 带原码、`retryable=false`；`RUN_APPROVAL_MODE_NOT_FOUND` / `TERMINAL` / `CANCELLED`（Run 刚好结束或正在被取消的竞态）不报错，只记在会话上。
- 模式变化后推送 `current_mode_update`。

---

## 6. 翻译规则（`translate.py`、`permissions.py`、`tool_display.py`）

翻译器是纯逻辑：输入 v3 事件记录（`AgentEvent.record()` 的字典），输出零到多条 ACP `session/update`。每个会话一个小状态对象，保存：当前消息序号（用于 `messageId`）、工具调用表 `{toolCallId → 工具名、参数缓冲、状态、kind}`。

### 6.1 事件 → `session/update`

| v3 事件 | ACP 更新 | 说明 |
|---|---|---|
| `content.delta {text}` | `agent_message_chunk` | `messageId = "{run_id}:m{序号}"`；遇到工具调用后再来文本，序号加一 |
| `reasoning.delta {text}` | `agent_thought_chunk` | 同样带 `messageId`，前缀 `t` |
| `tool.started {tool_call_id, name}` | `tool_call` | `status:"pending"`，`kind` 与 `title` 见 §6.2；此时没有参数 |
| `tool.delta {arguments_delta}` | 不立即推送 | 只拼进参数缓冲（避免推半截 JSON） |
| `tool.delta {output_delta}` | `tool_call_update` | `status:"in_progress"`，追加文本内容 |
| 审批请求到达（§6.4） | 先补一条 `tool_call_update`，再发权限请求 | 此时参数已完整：补 `rawInput`、更新 `title`、`locations`。`_meta.harnessCode.approval` 只放在随后权限请求的 `toolCall` 上，这条更新不带（diff 最多 16 KiB，不发两遍）。审批帧可能比 `tool.started` 更早到达，此时现建卡片，迟到的 `tool.started` 不重复建 |
| `interaction.resolved` | `tool_call_update` | 审批通过则 `in_progress`；被拒不单独推，等 `tool.completed` |
| `tool.completed {result}` | `tool_call_update` | `completed` 或（`is_error`）`failed`；`content` 为结果文本；`rawInput` 若还没推过就补上；`rawOutput` 为结果文本 |
| `run.completed / cancelled / failed` | 不产生 update | 触发 prompt 响应（§5.5） |
| `thread.summary`（通知） | `session_info_update` | 标题或更新时间变化 |
| `run.started`、`run.progress`、`skill.loaded`、`context.updated`、`compose.*`、`goal.*` | 一期丢弃 | `context.updated` 可映射 `usage_update`，二期接入（见缺口登记表） |

不认识的事件类型：丢弃并写诊断日志，不报错。

### 6.2 工具展示（`tool_display.py`）

`kind` 来自现有 `policy/tool_risk.py` 的 `TOOL_KIND_MAP`：

| Harness 工具 | ACP `kind` |
|---|---|
| `read_file`、`ls`、`lsp`、`codebase_explore` | `read` |
| `grep`、`glob`、`web_search`、`tool_search`、`memory_search` | `search` |
| `write_file`、`edit_file` | `edit` |
| `delete_file` | `delete` |
| `execute` | `execute` |
| `web_fetch` | `fetch` |
| `enter_plan_mode`、`exit_plan_mode` | `switch_mode` |
| `task`、`ask_user`、`write_todos`、`memory_save`、MCP 工具、其它 | `other` |

`title`：参数未到时用工具名；参数到齐后改为「动作 + 关键参数」，例如 `edit_file src/a.py`、`execute npm test`（命令截断到 120 字符，不做脱敏以外的改写）。`locations`：模型和审批 presentation 里的文件路径是「以 `/` 开头、相对工作区根」的虚拟路径（如 `/src/a.ts`），不是绝对路径。要换算成绝对路径，调用 `policy/workspace_boundary.py` 的 `WorkspacePathPolicy.validate_direct_path()`；解析失败（`/.harness/…`、含 `..`、未信任的工作区外路径）就省略 `locations`，不猜。

### 6.3 终态附带信息

`session/prompt` 响应的 `_meta.harnessCode.run` 放 `{usage, duration_ms, context}`（取自 `run.completed`），供 Web 界面的运行摘要使用。只发给声明了 `harnessCode` 扩展的客户端（见 §4.4）。

### 6.4 审批 ⇄ `session/request_permission`

**v3 → ACP**（`ProtocolInteractionAdapter` 经 sender 收到 `interaction.approval` 请求帧）：

```text
输入：request_id、payload{description, requests.action_requests[{name,args,description}], decisions, presentation?}
 → 关联工具调用：优先用 action 里新增的 tool_call_id（S0 查实可行：Python 在审批预检回调里捕获它，写入每个
                 action_requests 元素，不改 packages/protocol 的 schema）
                 没有 tool_call_id（同一批里出现两次完全相同的「工具名 + 参数」时不注入）或对不上：按「工具名相同 + 参数相同」
                 找最早的、还没结束的 tool_call；仍找不到：新建 toolCallId = "approval:{request_id}" 的卡片（降级）
 → 发 session/request_permission{sessionId, toolCall, options}
      toolCall：带 title、kind、status:"pending"、rawInput、locations、
                content：[文本兜底：description + 若有 presentation 则附 unified diff 代码块]、
                _meta.harnessCode.approval：{type:"approval", requestId, description, presentation(完整 file_diff，保持 v3 原样的 snake_case)}
                键名统一 camelCase（requestId、targetPath、toolName、shadowsWorkspace）
                （只发给声明了 harnessCode 扩展的客户端；其它客户端只看到标准字段和文本兜底）
      options（optionId 直接用 v3 的 decision 字符串）：
         approve_once    → kind allow_once   "允许一次"
         approve_thread  → kind allow_always "本会话内总是允许"
         approve_project → kind allow_always "本项目内总是允许"
         reject          → kind reject_once  "拒绝"
         （payload.decisions 里没有的选项不发；计划类审批只有前后两项）
 → 等客户端响应
输出：outcome.selected{optionId} → resolve_interaction({decision: optionId})
      outcome.cancelled          → resolve_interaction({decision: "reject"})
      连接断开 / 客户端 JSON-RPC 错误 / 响应格式错误 → 默认拒绝（目录信任为 deny）（fail-closed：出现异常时一律按最保守的拒绝处理，不会因出错而放行）
```

**审批不加超时。** v3 的交互本来就没有服务端超时（帧里的 `timeout_ms` 只是给客户端看的建议值），TUI 也是无限等人；人可能离开很久，自作主张超时拒绝会误伤。客户端断开走 fail-closed，用户可随时 `session/cancel`，stdin EOF 时取消并排空。代价是桥侧需要自己的存活检测（见 GAP-29）。

JSON-RPC 请求 id 由官方 SDK 自行分配整数，v3 的 `request_id` 只在 Python 内部和 `resolve_interaction` 里使用，二者不需要映射表。

`reject_with_feedback`（拒绝并附反馈）一期不提供：ACP 的权限响应只有 `optionId`，没有文字字段。记入缺口登记表。

**目录信任（用户确认一期就做）**：工具要访问工作区外的目录时，v3 会发 `interaction.directory_trust`。翻译成同一个 `session/request_permission`：

```text
输入：request_id、payload{directory, target_path, tool_name, access(read|write), shadows_workspace, decisions}
 → 发 session/request_permission
      toolCall：toolCallId = "trust:{request_id}"，title = "访问工作区外目录：{directory}"，
                kind = access==write ? edit : read，status = pending，
                locations = [{path: target_path}]（本来就是绝对路径），
                content = 文本说明（哪个工具、读还是写、是否会遮住工作区内同名路径），
                _meta.harnessCode.approval = {type:"directory_trust", request_id, directory,
                                              targetPath, toolName, access, shadowsWorkspace}
      options：allow_session → kind allow_always "本会话内允许访问该目录"
               deny          → kind reject_once  "拒绝"
 → outcome.selected{optionId} → resolve_interaction({decision: optionId})
   outcome.cancelled / 异常 / 断开 → {decision: "deny"}（保守拒绝）
```

**提问、计划、目标**：一期不声明这些 handle，沿用保守默认：`ask_user` 得到空答案，计划被放弃，目标被取消。用户在界面上只会看到对应工具失败或没有效果，所以这些在缺口登记表里是「必须在 TUI 下线前关闭」的项（见 §12.2）。

---

## 7. 模块 web-bridge（Bun/TS）

### 7.1 文件布局与命令

架构测试 `tests/web/architecture.test.ts` 限制 `src/web/` 根目录文件白名单。新代码放在新目录 `src/acp-web/`，避免触碰这些约束：

```text
packages/cli/src/
  args.ts / index.ts        # 新增 web、acp 两个子命令的解析与分派
  acp-web/
    bridge.ts               # createAcpWebBridge：HTTP 路由 + WebSocket ⇄ 子进程
    framing.ts              # 行分帧：stdout 字节流 → 完整行；帧大小上限；换行检查
    guard.ts                # Host / Origin / token 校验（纯函数，可单测）
    session-token.ts        # 一次性 token 的生成与消费
    html.ts                 # ACP 入口的 HTML 外壳
    client/                 # 浏览器端（模块 web-acp-client）
```

- `harness web [--cwd <dir>] [--config <path>] [--no-open]`：启动桥、打印 URL、打开浏览器；Ctrl+C 退出并回收所有子进程。
- `harness acp [--cwd <dir>] [--config <path>]`：不启动桥，直接用继承的 stdio 运行 sidecar 的 `acp` 模式（给编辑器配置用）。透传子进程退出码。
- sidecar 的 argv 由 `resolveAgentProcessBinding` 的结果末尾追加 `"acp"`；环境变量 `HARNESS_COMMAND_KIND` 设为 `acp`（只用于日志）。不复用 `startAgent`：它会做 v3 握手。

### 7.2 路由与会话

| 路径 | 行为 |
|---|---|
| `GET /acp/` | 静态 HTML 外壳，不含任何密钥 |
| `GET /acp/app.js`、`/acp/app.css`、`/acp/syntax-worker.js` | 构建产物，白名单，只允许 GET |
| `POST /acp/boot` | 请求体 `{"code": "<bootCode>"}`；校验通过返回 `{"cwd": "<工作区绝对路径>", "wsToken": "<一次性 token>"}` |
| `GET /acp/ws?t=<wsToken>`（Upgrade） | 校验通过后升级，并为该连接启动一个 Python 子进程 |
| 其它 | 404 |

两段式凭据，分别解决「首次打开」和「刷新」：

```text
启动：桥生成 bootCode（32 字节随机数），只放在打开浏览器的 URL 片段里：
      http://127.0.0.1:<端口>/acp/#c=<bootCode>
      （片段不会发给服务端，也不进访问日志）
页面：读出 bootCode → 存进 sessionStorage → 清掉地址栏片段
      → POST /acp/boot 换取 {cwd, wsToken}
      → 用 wsToken 连接 WebSocket（wsToken 只能用一次，60 秒有效）
刷新：sessionStorage 里仍有 bootCode → 再次 POST /acp/boot 换新的 wsToken
过期：bootCode 在「最近一次成功使用」之后 10 分钟失效；失效后只能重新运行 harness web
```

`cwd` 来自 `harness web` 解析出的工作区，是 `session/new` 所需的绝对路径；浏览器自己不可能知道它。

### 7.3 安全（fail closed：任何一项校验不过就拒绝，不降级放行）

```text
输入：每个 HTTP / Upgrade 请求
 → Host 必须是 127.0.0.1:<本服务端口>，否则 403（挡 DNS 重绑定）
 → POST /acp/boot 和升级请求的 Origin 必须等于 http://127.0.0.1:<本服务端口>，否则 403
   （挡其它网站向本机端口发起的跨站请求）
 → /acp/boot：bootCode 必须匹配且未过期，否则 403；连续错误 5 次后本进程内暂停校验 30 秒
 → /acp/ws：wsToken 必须存在、长度合理、未过期（签发后 60 秒内）、从未使用过，否则 403
 → wsToken 通过后立即作废；同一时刻最多一个活动 WebSocket，已有活动连接时拒绝新的升级（409）
 → 单帧大小上限 8 MiB（与 v3 一致）；超限、二进制帧、JSON 数组、含换行的帧：关闭连接（1008 / 1009）
输出：校验通过的连接才会启动子进程
```

- 服务只绑定 `127.0.0.1`，端口随机；禁止开启访问日志或接入代理（wsToken 出现在升级 URL 的查询参数里）。
- bootCode、wsToken 都是 32 字节随机数的 base64url；比较用恒定时间。
- 响应头和 CSP 沿用现有 `web/server.ts` 的常量：`default-src 'none'`、`script-src 'self'`、`connect-src 'self' ws://127.0.0.1:*`（多一个 `'self'` 是为了允许 `POST /acp/boot`），Host / Origin 校验抽成 `guard.ts` 的纯函数。旧 server 可以改为调用它，但本任务不强制改旧 server。
- 静态文件和 HTML 外壳不含任何密钥，所以本机其它进程能取到它们也没有风险；能拿到 `wsToken` 必须先知道 `bootCode`，而 `bootCode` 只存在于打开浏览器的 URL 片段和该页面的 `sessionStorage` 里。已知限制：URL 作为参数传给系统的 `open` 命令时，短时间内可能被同机其它用户的 `ps` 看到，和现有 `/web` 接管的处理方式一致，仍然接受。

### 7.4 桥的转发与子进程生命周期

```text
WebSocket 文本帧 ──校验──▶ child.stdin.write(帧 + "\n")
child.stdout ──按行切分──▶ 每行一个 WebSocket 文本帧
child.stderr ──▶ 诊断日志（不转发给浏览器）
```

- 桥不解析 ACP 内容，只做帧校验（大小、类型、无换行）。
- WebSocket 关闭 → 关闭子进程 stdin（EOF），等待最多 5 秒让它优雅退出，超时 SIGTERM，再超时 SIGKILL。
- 子进程异常退出 → 以 1011 关闭 WebSocket，close reason 带退出码和 stderr 末尾 200 字符（已过滤密钥形态）。
- `harness web` 退出（Ctrl+C）→ 关闭所有 WebSocket 与子进程，释放端口。
- 子进程启动失败（如找不到 Python）→ 升级成功后立即以 1011 关闭，页面显示明确错误。

---

## 8. 模块 web-acp-client（浏览器）

### 8.1 分层

```text
入口：src/acp-web/client/app.tsx（新 bundle，不改旧 app.tsx）
  → 读取 boot 信息 → 建立 WebSocket → 自写的 WebSocket Stream 适配（约 40 行，见 §8.5）
  → ClientSideConnection（官方 SDK）
  → AcpAgentGateway（实现 AgentGateway）
  → InteractiveController（现有）
  → LocalUiClient（实现 WebUiClient）
  → createWebInteractiveAdapter（现有）→ WebApp（现有）
```

### 8.2 AcpAgentGateway（ACP ⇄ AgentGateway）

`AgentGateway` 有约 40 个方法。一期实现下表中的方法；其余方法对应的能力不会出现在 `runtime.capabilities` 里，界面按现有的能力开关隐藏入口，所以正常情况下不会被调用。万一仍被调用（例如用户手敲了某个斜杠命令），网关抛出 `AgentGatewayError(code="ACP_NOT_SUPPORTED", message="该功能暂未通过 ACP 提供（GAP-xx）")`，由 Core 现有的错误路径显示给用户，不返回空结果（空结果会让用户误以为功能存在但没数据）。

| AgentGateway 方法 | 一期实现 |
|---|---|
| `startRun` | 必要时先 `session/new`（见下「ID 别名」），再 `session/prompt`；把 `session/update` 翻译成 `EventEnvelope`（`content.delta`、`reasoning.delta`、`tool.started`、`tool.delta`、`tool.completed`），把 prompt 响应翻译成唯一终态事件 |
| `cancel` | 发 `session/cancel` 通知 |
| `setApprovalMode` | `session/set_mode` |
| `listThreads` | `session/list` |
| `openThread` | `session/load`，缓冲回放的 update，拼成 `ThreadsOpenResult.messages`（`kind: user / assistant / tool`）；`plan`、`goal` 等字段给空值 |
| `setInteractionHandler` | 收到 `session/request_permission` 时，从 `_meta.harnessCode.approval` 取出 `type`（approval 或 directory_trust）、`requestId` 和对应字段，构造 `InteractionRequestEnvelope` 交给 Core；Core 的回答 `{decision}` 转成 `outcome.selected{optionId: decision}`；Core 无法处理或超时则回 `outcome.cancelled` |
| `onThreadSummary` | 来自 `session_info_update` |
| `onClose` | WebSocket 关闭 |
| 其余（模型、技能、MCP、插件、Agent、Team、目标、压缩、撤销重做、配置、代码索引、/btw、Compose） | 抛 `ACP_NOT_SUPPORTED`（含缺口编号）；对应能力不进 `capabilities` |

**ID 别名**：Interactive Core 在新会话的第一次提交时自己生成 `threadId`，而 ACP 的 `sessionId` 由 Agent 分配。网关在 `startRun` 里遇到未知 `threadId` 时先 `session/new`，把「Core 的 id ↔ ACP 的 sessionId」登记到一张双向表，并在向 Core 发出的所有事件、`ThreadSummary`、列表结果里统一用 Core 的 id；页面刷新后这张表清空，一律使用 ACP 的 sessionId。这张表只在网关内部，Core 看不到差别。

**能力声明**：初始化后构造 `InteractiveRuntime`：`capabilities = ["run.cancel", "run.approval_mode", "threads.read"]`（`run.approval_mode` 仅当 Agent 返回了 `modes`），`workspace` 取 boot 信息里的 `cwd`，`agentCommands` 来自 `available_commands_update`，`modelConfigured` 先置 true（真正的模型配置错误在第一次 prompt 时以错误形式出现）。

### 8.3 LocalUiClient（InteractiveController → WebUiClient）

- `getState()`：用现有选择器 `selectConversationView / selectInteractionView / selectNavigationView / selectCommandView / selectRuntimeView / selectWorkItemView` 从控制器快照生成 6 个切片；`workspaceTree`、`workspacePreview` 固定为 idle 空态。
- `submitIntent(intent)`：交给 `controller.dispatch(intent)`，返回其 `IntentOutcome`。
- `workspaceIntent`：一律返回 `rejected`（文件树二期）。
- `getHandoffState()`：固定为已接管（`web-active`），`ready/returnToTui/requestExit`：no-op 或关闭页面提示。
- Trace 相关：`loadThreadTrace` 返回「未开启追踪」空态；`getLiveTrace` 返回空数组。
- 订阅：控制器每次发布快照，重新生成切片并通知订阅者（沿用现有 adapter 的 frame batching，不在这里再做节流）。

### 8.4 界面上必须处理的残留

以下是复用组件时，一期会露出的、需要最小改动的点（具体改动放 Plan，原则是只加条件、不重构）：

1. 顶栏的「返回 TUI」「退出 Harness」按钮：在 ACP 入口下不显示（通过 `runtime` 里一个布尔字段或 `WebApp` 的可选 prop 控制）。
2. 左侧文件树：`workspaceTree` 为空态时显示「暂不支持」而不是空白；入口 Tab 保留，避免布局跳动。
3. Git 面板：`runtime.git` 为 `unavailable`，面板显示不可用说明。
4. 审批卡片的倒计时：ACP 没有超时概念，`deadlineAtMs` 给一个固定的远期值并让组件在该值超过 24 小时时不显示倒计时（现有 v3 路径默认也是 24 小时，沿用同一表现）。

### 8.5 控制器上浏览器的前置改造（S0 实测发现）

S0 把 `controller.ts` 单独打成浏览器 bundle：能成功（57 个模块，2.6 MB），但 Bun 把下面这些 Node 模块静默换成了空桩，对应功能在浏览器里一调用就会报错：

```text
controller.ts → workspace/mention-resolver.ts                      → node:fs/promises（@ 文件提及解析）
controller.ts → infrastructure/index.ts
                → prompt-history-file-store.ts → tui/application/prompt-history.ts → node:path（输入历史落盘）
                → agent-client-gateway.ts → ipc/client.ts → diagnostic-log → node:os / node:buffer
```

做法（S3 的第一步，先于任何 ACP 前端代码）：

1. **只改 import 与注入，不改行为**：`controller.ts` 与各 feature 不再引用 `infrastructure/index.ts` 这个总出口，改为只引用它真正需要的具体模块；依赖 Node 的两样东西（@ 文件提及解析、输入历史存储）改为通过 `InteractiveControllerOptions` 注入。TUI 路径在 `src/index.ts` 注入原来的 Node 实现，行为不变，既有 `tests/interactive`、`tests/tui` 全部通过。
2. **浏览器侧注入内存版本**：输入历史用内存存储（刷新后不保留，见 GAP-25）；@ 文件提及不在浏览器里读文件（见 GAP-24）。
3. **用打包结果当验收**：`bun build --target=browser` 打 `acp-web/client/app.tsx`，用 metafile 或产物检查，不得出现 `node:` 的 polyfill 桩。把这个检查写成自动化测试，防止以后又有人引回来。
4. **修改一条架构测试**：`tests/web/architecture.test.ts` 里「`createInteractiveController(` 的生产调用点只能是 `src/index.ts`」，改为允许 `src/acp-web/client/` 作为第二个装配点（新增一条断言：该目录里只能有一处调用）。这条规则原本服务于「TUI 与 Web 共用一个控制器」，现在 Web 是独立进程里的独立控制器，不再违背它的目的。
5. **WebSocket 流自己写**：0.25.1 没有现成的 WebSocket 流（新版有，但在 `experimental/` 子路径下，且带我们用不上的 cookie 和连接 id 处理）。0.25.1 的 `Stream` 类型就是 `{ readable: ReadableStream<AnyMessage>, writable: WritableStream<AnyMessage> }`，我们自写一个满足它的适配器，约 40 行：一帧一条 JSON-RPC，收到二进制帧或非法 JSON 则关闭连接。有单元测试。

---

## 9. 数据与错误语义

**ID 对应**：`sessionId` = `thread_id`（Python 侧）；Run 的 `run_id` 由 AcpServer 生成并只在 Python 内部和日志里使用；ACP 没有 Run 的概念。

**错误码**：

| 情况 | JSON-RPC 错误 |
|---|---|
| 未知会话 | `-32002` |
| 参数不合法（cwd 不匹配、内容块类型不支持） | `-32602` |
| 方法未实现 | `-32601` |
| 会话忙（`THREAD_BUSY`、`CONNECTION_RUN_BUSY`） | `-32603`，`data{code, retryable:true}` |
| Run 失败、配置错误、持久化不可用 | `-32603`，`data{code, message, retryable}` |
| 帧超限或解析失败 | 沿用 SDK 的标准错误 |

**一致性**：同一会话同一时刻最多一个活动 Run；`session/load` 只能在空闲时进行；`session/new` 之前不允许 `session/prompt`。

---

## 10. 测试策略

遵循仓库规范：先写失败测试再实现；用 mock 模型与 echo 模式，不使用真实 Key；双端都覆盖。

**Python（`packages/agent/tests/host/acp/`，沿用 `_capture` 替换 sender 的写法和 `allow_echo=True`、`_BlockingAgent`、`_StreamingAgent` 夹具）**

| 测试 | 覆盖 |
|---|---|
| `test_translate.py` | 每种 v3 事件 → update 的表格；参数缓冲在 `tool.delta` 阶段不外泄；`tool.completed` 补 `rawInput`；终态时补发 `failed` |
| `test_permissions.py` | 审批 → 权限请求（选项、`_meta`、文本兜底）；每种 outcome → decision；关联不到工具调用时的降级卡片 |
| `test_server_lifecycle.py` | initialize → new → prompt（echo）→ 流式 update → `end_turn`；顺序保证（update 先于响应） |
| `test_server_cancel.py` | 取消活动 Run → `cancelled`；等待审批时取消；取消后立即再发 prompt |
| `test_server_sessions.py` | `session/list`、`session/load` 回放、线程忙、线程不存在、cwd 不匹配 |
| `test_server_commands.py` | `available_commands_update`；`/命令 参数` 补全 `requested_skill`；不匹配当普通文本 |
| `test_server_modes.py` | 4 个模式、`plan` 不暴露、有无活动 Run 的 `set_mode` |
| `test_server_failure.py` | `startup_error`、`run.failed`、畸形输入、stdin EOF 优雅退出 |
| `test_permissions_directory_trust.py` | 目录信任 → 权限请求；两个选项 → decision；取消与断开 → deny |
| `test_extension_negotiation.py` | 声明 `harnessCode` 与否：没声明的客户端拿不到任何 `_meta.harnessCode`，行为完整；声明格式错误按没声明处理 |
| `test_stdio_hygiene.py` | 子进程里 `print`、继承 fd 1 的孙进程输出都不进 ACP 通道；stdout 每一行都是合法 ACP 消息 |
| `test_sdk_client_e2e.py` | 用官方 `agent-client-protocol` 的客户端 `spawn_agent_process` 启动 `python -m harness_agent acp`，跑完整一轮对话（验收 #8） |
| 回归 | 既有 `tests/host/` 全部通过（D-1 抽取的门槛） |

**TypeScript（`packages/cli/tests/acp-web/`）**

| 测试 | 覆盖 |
|---|---|
| `guard.test.ts`、`session-token.test.ts` | Host / Origin / bootCode / wsToken 的全部拒绝分支；wsToken 一次性与 60 秒过期；bootCode 10 分钟滑动过期；连续错误后的暂停；恒定时间比较 |
| `framing.test.ts` | 行切分（跨块、多行一块、超大行）；含换行的帧被拒 |
| `bridge.integration.test.ts` | 回环 WebSocket 对假子进程（回显脚本）：转发、关闭回收、子进程崩溃、超限帧、二进制帧、第二个连接被拒 |
| `acp-agent-gateway.test.ts` | 每种 ACP update → `EventEnvelope`；权限请求 ⇄ 审批；`session/load` 回放 → `ThreadsOpenResult`；ID 别名；终态映射 |
| `local-ui-client.test.ts` | 控制器快照 → 切片；intent 转发；不支持的 intent 返回 rejected |
| `acp-not-supported.test.ts` | 被调用的缺口方法抛 `ACP_NOT_SUPPORTED` 且消息带缺口编号 |
| 组件测试 | 在现有 `render.ts` / `fixtures.ts` 基础上，ACP 入口隐藏「返回 TUI」按钮、空态文案 |
| `tests/web/architecture.test.ts` | 保持通过（新代码不进 `src/web/`） |
| 浏览器 E2E | 沿用现有 Playwright 配置，用桥 + 假子进程（脚本化 ACP Agent）验证首页、发送、流式、审批、刷新恢复 |

**覆盖不到的、必须人工验证的**：真实模型下的一次完整改文件审批；在 Zed 里接入 `harness acp`（非本任务验收，但建议顺手试一次）。

---

## 11. 边界

**始终做**
- 先写失败测试；Python 测试用 `.venv/bin/python -m pytest`；TS 用 `cd packages/cli && npm run test`（或 `bun test <具体目录>`）。
- 抽取服务方法时保持 v3 行为不变，每一步跑 `tests/host/`。
- 所有对外帧都校验大小；所有拒绝路径写诊断日志（不含 token 和原始帧）。
- 新代码的中文说明与 docstring/JSDoc 遵守仓库注释规范（模块头三问、复杂流程 ASCII 图只放头部）。

**先问再做**
- 新增依赖：`agent-client-protocol`（Python，建议固定 `==0.12.1`）、`@agentclientprotocol/sdk`（npm，固定 `0.25.1`，企业内部源可用版本，用户已确认；需同时引入必需 peer `zod`）。同步更新 `dependency-versions.json`、`dependency-inventory.json`、`内网迁移依赖清单.md`，并通过 `deps:check`。
- 修改 `packages/protocol` 或 `generated.ts`、SQLite schema。本规格不需要。
- 改旧的 `web/server.ts` 去复用 `guard.ts`。
- 改 `WebApp` 的 props（§8.4 的最小条件除外）。

**绝不做**
- 在 ACP 路径复制 `_handle_run_start` 里的 undo 收敛、git 检查点或审批决策逻辑。
- 让 Python 进程监听任何网络端口。
- 在 `harness acp` 的 stdout 写任何非 ACP 内容。
- 在日志、`_meta`、错误信息里放 token、环境变量值或请求头。
- 删除或改动 TUI、`/web` 接管、`WebUiGateway`、JSON-RPC v3 方法。

---

## 12. 文档影响与缺口治理

### 12.1 文档影响

- 用户文档：`docs/user/快速开始.md`（`harness web`、`harness acp`）、`docs/user/Web界面.md`（新增「ACP 入口当前不支持的功能」一节，按缺口编号逐条列出）。
- 开发者文档：新增 `docs/developer/architecture/ACP通信.md`（拓扑、翻译规则、扩展约定、**已知缺口表的权威版本**）；增量修订 `架构总览.md`；更新 `adr/0003-single-interactive-core-dual-renderer.md` 的后续说明（Interactive Core 在 TUI 下线后的去向）。

### 12.2 缺口治理（用户要求：一期功能变少可以接受，但必须有记录；最终不可接受）

一期 Web（ACP 入口）比现在的 Web 功能少，这是**过渡状态**，不是终态。为了不被遗忘，做五件事：

1. **登记**：权威清单是 `architecture/ACP通信.md` 的「已知缺口」表，Task 里的表是初版，完成时迁入并以架构文档为准。每行固定字段：`编号`、`功能`、`用户看到什么`、`原因`、`建议关闭方式`、`状态`（未开始 / 进行中 / 已关闭 / 用户确认放弃）、`后续 Task`。
2. **让缺口可见，不静默**：
   - 对应能力不进 `runtime.capabilities`，界面入口按现有开关隐藏或置灰；
   - 万一被调用，网关抛 `ACP_NOT_SUPPORTED`，消息带缺口编号，用户在界面看到「该功能暂未通过 ACP 提供（GAP-xx）」；
   - `harness web` 启动时在终端打印一行：当前为 ACP 过渡版本，部分功能暂不可用，清单见文档。
3. **用户文档同步**：`Web界面.md` 的「当前不支持」一节引用同一组编号。
4. **立项不丢失**：HC-209 归档前，必须为每组缺口在看板建好后续 Task（状态「待认领」），并把 Task 编号写回缺口表。Task 的验收标准新增这一条（见 Task #13）。
5. **闸门**：TUI 下线 Task 的前置条件是缺口表里没有「未开始」或「进行中」的行；每一行要么「已关闭」，要么「用户确认放弃」（带日期，记在表里）。这条写进 Task 的后续线索，TUI 下线 Task 立项时照抄为验收项。

### 12.3 缺口表初版（编号固定，后续只增不改号）

> 权威版本已于 S4 迁入 `docs/developer/architecture/ACP通信.md`，以架构文档为准；本表保留为初版记录。

| 编号 | 功能 | 一期用户看到什么 | 建议关闭方式 |
|---|---|---|---|
| GAP-01 | 提问（`ask_user`） | 工具得到空答案，模型会继续或重复提问 | 自定义请求，或退化为带选项的权限请求 |
| GAP-02 | Plan 模式与计划确认 | 界面没有 plan 模式；输入框的审批模式下拉仍列出 plan，选中后发送会提示「该功能暂未通过 ACP 提供（GAP-02）」 | 自定义请求「确认计划」 |
| GAP-03 | 目标闭环（goal） | 无入口 | 自定义方法与通知 |
| GAP-04 | Compose 模式 | 无入口 | 自定义方法与通知 |
| GAP-05 | 拒绝并附反馈 | 审批卡片没有「拒绝并反馈」 | `_meta` 携带反馈文本，或自定义响应字段 |
| GAP-06 | 标准 `diff` 内容（`oldText/newText`） | 通用客户端只看到文本形式的 diff | 审批预计算携带前后文 |
| GAP-07 | 上下文用量与压缩 | 无用量显示、无法手动压缩 | `usage_update` + 自定义压缩方法 |
| GAP-08 | 模型选择与切换 | 无入口 | 标准会话配置项，或自定义方法 |
| GAP-09 | 撤销 / 重做 | 无入口 | 自定义方法 |
| GAP-10 | 旁路提问 `/btw` | 无入口 | 自定义方法 |
| GAP-11 | 文件树与文件预览 | 面板显示「暂不支持」 | Electron 主进程直接读本机文件 |
| GAP-12 | Git 面板、提交、推送 | 面板显示不可用 | Electron 主进程直接调用 git |
| GAP-13 | 技能管理 | 无入口 | 自定义方法 |
| GAP-14 | 插件与设置 | 无入口 | 自定义方法 |
| GAP-15 | MCP 运行期增删 | 无入口 | 自定义方法 |
| GAP-16 | 子代理 / Team | 无入口；ACP 侧只看到父级 `task` 工具卡，看不到子代理的过程（S1 起子代理事件一律丢弃，否则子代理的文字会混进主消息） | 自定义方法与通知 |
| GAP-17 | 代码索引 | 无入口 | 自定义方法与通知 |
| GAP-18 | 配置查看与修改 | 无入口 | 自定义方法 |
| GAP-19 | Trace 面板 | 显示「未开启追踪」 | 自定义通知，或直接读本机日志 |
| GAP-20 | 刷新页面会重启 Python 并取消运行中的任务（D-4） | 刷新后运行中的任务被取消 | Electron 主进程常驻子进程 |
| GAP-21 | `session/new` 的 `mcpServers` 被忽略 | Zed 等客户端传入的 MCP 配置不生效 | 将其并入会话级 MCP 配置 |
| GAP-22 | 历史回放里的工具记录没有参数和状态 | 恢复的会话里工具卡片信息很少 | 读取 Transcript 里更完整的记录 |
| GAP-26 | `locations` 只覆盖主工作区路径（S1 实现） | 已信任的工作区外目录里的文件不会出现位置信息，客户端无法「跟随」 | 让位置解析复用 Host 的完整根注册表（需要给 `AgentHost` 暴露只读的路径策略） |
| GAP-27 | `session/new` 的 `mcpServers`、`additionalDirectories` 被忽略，只在 stderr 记个数（S1 实现） | 客户端传入的 MCP 配置不生效，诊断日志里也没有结构化事件 | 新增诊断事件名（属于诊断日志 schema 的跨包改动）并把 MCP 配置并入会话级配置 |
| GAP-23 | 审批与工具卡的关联在少数情形下退回「工具名 + 参数」匹配（S2 已覆盖全部工具族的 `tool_call_id`，残余如下） | 同一批里「工具名 + 参数」完全相同的调用、参数被截断、provider 重复使用 tool_call id（按序号编号的 provider 必现）时，可能出现「一次调用两张卡」，多出的兜底卡由终态补发收尾 | 在 Python 里给每次工具调用分配稳定的内部 id 并贯穿事件与审批；做完即关闭 |
| GAP-24 | 输入框 @ 文件提及不在浏览器里内联文件内容（S3 已核实：控制器默认直通，`@路径` 作为文本发送） | 提及只作为 `@路径` 文本发给 Agent，由 Agent 用工具读取 | 经 ACP 的 `resource_link` / 内容块，或 Electron 主进程读文件 |
| GAP-25 | 输入历史（上下键）刷新后不保留 | 刷新页面后历史清空 | 浏览器本地存储，或 Electron 主进程落盘 |
| GAP-28 | 普通 Skill 没有斜杠入口：`available_commands` 只含 Plugin / Qwen 命令（`HostSnapshot.agent_commands`），不含 TUI 里的 `/skill:<id>` | ACP 用户无法用斜杠调用普通 Skill；`/skill:xxx` 被当作普通文本 | 扩展命令列表来源（跨包改动）并放宽 `requested_skill` 校验，或提供 Skill 专用自定义方法 |
| GAP-29 | 审批无超时，桥侧失联会让 Run 一直挂着（S3 的桥必须自己做存活检测） | 浏览器页面关闭或桥断开时，挂起的审批要等连接关闭才被拒绝 | 桥侧检测断线并回 `cancelled`；或为审批增加可配置的超时 |
| GAP-30 | `approve_thread` 与 `approve_project` 都映射成 `allow_always`，后者会持久化项目规则 | 依赖 `kind` 做「记住选择」的通用 ACP 客户端无法区分这两个选项 | 选项名称里写明范围（已写），或拆成不同 `kind`/自定义字段 |
| GAP-31 | Host 侧发起的模式变化不回流 `current_mode_update`：模型调用 `enter_plan_mode` 且被批准后 Host 进入 plan，ACP 会话仍显示旧模式（S3 前需实测确认，与 GAP-02 相关） | 界面显示的审批模式可能与实际不一致 | Host 在模式变化时广播事件，ACP 侧转成 `current_mode_update` |
| GAP-32 | 历史回放的细节限制：用户消息不切块、回放不设条数上限、失败工具回放为 `completed`（后者并入 GAP-22） | 超大历史时首帧会变慢；恢复的会话里看不出哪个工具失败过 | 回放分块与分页；Transcript 记录工具状态 |
| GAP-33 | `session/list` 固定 200 条、不分页 | 超过 200 个会话时旧会话列不出来 | 实现 `cursor` 分页 |
| GAP-34 | 子代理审批只显示为独立的兜底卡（GAP-16 的补充） | 子代理里的工具审批卡片不挂在任何工具卡下 | 随子代理过程可见化一起解决 |
| GAP-35 | 审批帧可能比同轮正文和 `tool.started` 更早到达，卡片显示顺序可能与模型输出顺序差几毫秒（S3 网关未加排序机制） | 偶尔先看到权限请求，正文稍后才出现 | Host 保证事件顺序，或翻译器按序号重排 |
| GAP-36 | 会话摘要缺字段：`ThreadSummary` 的 `created_at_ms`、`message_count`、`first_message`、`latest_message` 在 ACP `SessionInfo` 里没有来源 | 侧栏只按更新时间排序，不显示消息条数与最近一条预览；Agent 未声明 `session/list` 时侧栏显示带 GAP-36 的提示 | `SessionInfo._meta.harnessCode` 携带这四个字段（Python 侧改） |
| GAP-37 | Agent 命令缺字段：`AgentCommand` 的 `id`、`requested_skill_id`、`plugin_id` 无来源；`/命令` 补全只认页面启动后 500 ms 内到达的 `available_commands_update` | 用 `name` 合成 `id` 与 `requested_skill_id`，`plugin_id` 固定 `acp`；命令更新晚到则这一页没有补全，刷新后恢复；与内置命令重名的命令被丢弃 | 命令更新带 `_meta.harnessCode` 的 id 与来源；控制器支持动态命令表 |
| GAP-38 | 审批 `payload.requests` 无 ACP 来源 | 由权限请求的 `toolCall.rawInput` 合成 `{action_requests:[{name,args,description}]}`，不是 v3 原样；文件 diff 审批详情里能看到，普通审批卡与现状一样不显示该块 | `_meta.harnessCode.approval` 携带 v3 原始 `requests` |
| GAP-39 | 手动重命名会话（`/title`） | ACP 入口下没有入口：`/title` 要求 `threads.read` 能力而被隐藏，输入 `/title xx` 会当普通消息发给 Agent；网关的 `setThreadTitle` 抛 GAP-39 | 自定义方法 `_harnessCode/sessions/set_title`（Python 侧改） |

---

## 13. 已确认决定与待实施时核实项

**已确认（2026-11-05 用户）**

1. 目录信任一期就做，映射成标准权限请求（§6.4）。
2. 刷新页面会取消运行中的任务可以接受，但必须登记并最终解决（GAP-20，§12.2）。
3. 审批与工具调用的关联：Python 在审批预检回调里记下 `tool_call_id`，在生成审批 payload 时写入每个 action（S2 已实现，覆盖全部需要审批的工具族，包括 `execute` 与 MCP）；同一批里「工具名 + 参数」完全相同的调用不注入，退回匹配（GAP-23 缩小后的残余）。
4. 用户明确要求：一期缩水必须有记录、最终不能接受（§12.2 的治理方案）。

**扩展前缀（用户确认）**：`_meta.harnessCode` 与 `_harnessCode/`（§4.4）。

**S0 已核实**

- 虚拟路径可用 `validate_direct_path()` 换算成绝对路径（§6.2）。
- 在 `host/` 下新建 `acp/` 子包不会被 `tests/test_architecture.py` 拦截；`__main__.py` 的 `main` 函数名和 console script 目标不能变，`acp` 分支在 `main()` 内部按 argv 分派。
- TS SDK 可以打进浏览器 bundle（§2 第 4 条）。
- 官方 Python SDK 能按 §5.3 接管 stdio，但有四条实现要求（§5.3）。
- 控制器在浏览器里运行需要前置改造（§8.5）。
- 全量测试基线见 Task「S0 结论」。

**S3 已核实与决定（2026-11-06）**

S3 的实施细节以设计稿（本地 `/tmp/hc192-s3-design.md`，未入库）为准，与本 Spec §7、§8 不一致之处如下，归档前在 Todo 4.5 时并入正文：

- 文件布局：桥在 `packages/cli/src/acp-web/bridge/`（`guard`、`session-token`、`framing`、`assets`、`bridge`），浏览器端在 `acp-web/client/`，`ext.ts`、`html.ts`、`bundle.ts` 在 `acp-web/` 根层；`harness web` 命令在 `src/web-command.ts`（与 `acp-command.ts` 同级，安装根解析依赖这个位置）。参数为 `--cwd`、`--config`、`--port`、`--no-open`；Windows 直接拒绝。
- 路由：`GET /`、`GET /assets/*`、`POST /acp/boot`、`GET /acp/ws`；检查顺序固定为 Host → Origin → 凭据；bootCode 在有活动连接时顺延滑动窗口；wsToken 先检视、名额通过后才消耗，409 不烧 token；名额包含回收中的连接。CSP 的 `connect-src` 写确切端口。
- 子进程崩溃：桥先发 `_harnessCode/bridge/exit` 通知帧（退出码、信号、脱敏后的 stderr 末尾），再以 1011 关闭；WebSocket close reason 只放短码（最长 123 字节装不下诊断）。通知在 stdio 全部读完后才发，子进程最后写出的帧不会丢。
- 浏览器侧：`controller.ts` 只拆桶文件导入并注入 `resolveMentions`（默认直通）；三处架构测试（`tests/web/architecture.test.ts`、`tests/acceptance/a-matrix.test.ts`、`tests/tui/architecture.test.ts`）只允许 `acp-web/client/session.ts` 作第二装配点。浏览器自建 `CommandRegistry`，去掉插件命令的 `skills.read` 要求，Skill 面板入口保持隐藏。
- 网关：Agent 未声明 modes 或目标模式不在 `availableModes` 里时不调 `session/set_mode`；对 Core 暴露的审批 `request_id` 为 `${runId}:${ACP requestId}`，避免 Agent 跨 Run 复用 id 时上一轮的迟到应答误结算本轮；审批无倒计时（`timeout_ms: Infinity`）。
- 「update 先于响应」由 SDK 0.25.1 保证：其消息循环对通知是 `await notificationHandler(...)`，通知与响应天然串行；网关再在 `sessionUpdate` 内同步翻译入队。升级 SDK 时要重跑排序用例。
- 界面：`WebApp` 新增可选 `handoffControls`（默认 `true`，ACP 入口传 `false`）；语法高亮 Worker 地址经 `configureSyntaxWorkerUrl` 指向 `/assets/syntax-worker.js`；文件树与 Git 显示带 GAP-11、GAP-12 的「暂不支持」。模型、Skill 面板在 ACP 入口下被能力门禁隐藏，GAP-08、GAP-13 没有可点击的入口。
- TS SDK + zod 打进浏览器 bundle 后零 `node:`；`dist/acp-web.js` 约 2.0 MB（minify 后，含 React、控制器、SDK、zod）。

---

## 14. 建议的可演示停点（交给 Plan 细化）

| 停点 | 用户能看到什么 | 内容 |
|---|---|---|
| S0 | 无可见变化（内部） | AgentHost 抽出服务面；官方 Python SDK 流接管 stdin/stdout 的验证；`tests/host/` 全绿 |
| S1 | 终端里用官方 SDK 示例客户端对话一轮，流式回复 | `harness-agent acp`：initialize / new / prompt / cancel；stdout 洁净 |
| S2 | 同一个客户端里看到审批（含目录信任）、会话列表、恢复、斜杠命令、模式切换；不声明扩展的客户端也完整可用 | 翻译器、权限映射、扩展协商完整 |
| S3 | `harness web` 打开浏览器，发消息、流式回复、取消 | 桥 + `AcpAgentGateway` + `LocalUiClient` + 新 bundle |
| S4 | 浏览器里审批改文件并看到 diff；刷新后恢复历史；非法连接被拒；终端和文档里都能查到当前缺口 | 审批卡片、安全测试、文档、缺口表定稿、后续 Task 全部建好 |
