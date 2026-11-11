# ACP 通信（HC-209）

## 为什么用 ACP

Harness Code 原来的界面通道是自家 JSON-RPC v3：能干活，但只有自己的 TUI 和
旧版 `/web` 能听懂。要让浏览器和将来的 Electron 桌面端都能用同一个 Agent
进程，又不想各写一套协议，就需要一个现成的通用协议。ACP（Agent Client
Protocol）正是这个定位：Zed 等编辑器已经内置了 ACP 客户端，第三方 Agent
也陆续支持。接入 ACP 后，我们的界面只面向一种协议写代码，`harness acp`
也能直接被 Zed 这类客户端当子进程拉起来用；同时 Interactive Core 的状态层
（会话、时间线、审批、命令）完全复用，不另起一套逻辑。

本文只描述 Harness 这一个 Agent 的 ACP 实现；平台怎样接入多种 Coding Agent、
功能该放在哪一层，以 [Agent 接入架构](Agent接入架构.md) 为准。

标准 ACP 能表达的能力走标准方法。`_meta.harnessCode` 只带增强显示，
不声明扩展的客户端仍能把已实现的功能走完。文件树、Git、设置面板等
仍按文末缺口表留给其他任务，不在这里静默补上。

## 拓扑

```text
┌─────────────────────────── 浏览器 ───────────────────────────┐
│ React WebApp                                                  │
│   └─ WebInteractiveAdapter ── LocalUiClient                   │
│        └─ InteractiveController（第二个装配点，               │
│           acp-web/client/session.ts）                         │
│             └─ AcpAgentGateway（ACP SDK ClientSideConnection）│
└───────────────────────│ WebSocket ────────────────────────────┘
                        │  原样转发 JSON-RPC 帧（不翻译）
┌───────────────────────▼───────────────────────────────────────┐
│ Bun 桥（harness web）：Host/Origin/凭据门禁 + 进程生命周期      │
└───────────────────────│ stdin/stdout ─────────────────────────┘
                        │  换行分隔 JSON-RPC
┌───────────────────────▼───────────────────────────────────────┐
│ Python：harness acp → AcpServer → AgentHost → AgentEngine      │
└───────────────────────────────────────────────────────────────┘

Zed 等 ACP 客户端：  ACP Client ──stdio──> harness acp（不经桥）
桌面工作台（HC-192 系列）：HC-197 通用 ACP 运行时以 stdio 启动 harness acp（HC-200），不经桥
```

桥只做三件事：身份门禁、进程生命周期（spawn/回收/崩溃通知）、字节透传；
协议翻译全在两端的 SDK 与适配层里，桥不认识任何 ACP 业务。

## 模块地图

### Python（packages/agent/harness_agent/host/acp/）

| 文件 | 职责 |
|------|------|
| `stdio.py` | 把真实 stdin/stdout 变成 ACP 专用帧通道；EOF/信号 → 取消 Run → 排空 → 收尾的顺序闸门 |
| `server.py` | ACP 官方方法的实现入口，分发到 Host。方法见下文「方法表」 |
| `translate.py` | v3 事件 → ACP `session/update` 的翻译器（文本增量、思考、工具生命周期、计划、用量、终态） |
| `permissions.py` | 审批 ⇄ `session/request_permission` 双向翻译（标准 diff、目录信任、拒绝/取消收敛） |
| `elicitation.py` | 提问、计划确认、目标确认、拒绝附反馈。全部走 UNSTABLE 的 `elicitation/create` |
| `sessions.py` | `session/list` 分页、`session/load` 回放：ThreadSummary/历史消息 ↔ SessionInfo/历史帧 |
| `commands.py` | 内置命令、Skill 命令与 `available_commands_update` |
| `modes.py` | 审批模式 ⇄ ACP 会话模式（含按能力暴露的 `plan`） |
| `config.py` | `model` / `workflow` 配置项，以及 `usage_update`、`PromptResponse.usage` |
| `inline.py` | `resource_link` / `resource` 读入模型输入；记录里只留原文和 `@路径` |
| `ext.py` | `_meta.harnessCode` 扩展协商（版本、能力位） |
| `tool_display.py` | 工具名/参数 → ACP toolCall 的展示字段（kind/title/content/locations） |

### CLI（packages/cli/src/）

| 文件 | 职责 |
|------|------|
| `acp-command.ts` | `harness acp`：算出 Python sidecar 的启动计划并以子进程运行，stdin/stdout 直通，不加任何包装 |
| `web-command.ts` | `harness web`：建桥、打印过渡提示与带 boot code 的地址、开浏览器、中断收尾 |
| `acp-web/ext.ts` | 桥/客户端共用的扩展常量（`harnessCode`、`_harnessCode/` 前缀、桥方法名） |
| `acp-web/bridge/guard.ts` | Host/Origin 精确匹配、content-type、限界 body、安全响应头（CSP/no-store 等） |
| `acp-web/bridge/session-token.ts` | bootCode 滑动窗口与 wsToken 一次性发放，digest-only 存储 + 错误锁定 |
| `acp-web/bridge/framing.ts` | 入站帧门禁（二进制/超限/换行/非对象）与按行切分、stderr 脱敏 |
| `acp-web/bridge/assets.ts` | 资源名白名单与资产服务（占位页/真实 bundle 两种提供者） |
| `acp-web/bridge/bridge.ts` | 路由 + ws 升级 + 单连接名额 + 双向转发 + 背压 + EOF→SIGTERM→SIGKILL 回收 |
| `acp-web/client/ws-stream.ts` | WebSocket ⇄ SDK Stream 适配（帧门禁、close code 翻译、写背压） |
| `acp-web/client/boot.ts` | 引导：hash/sessionStorage 取 bootCode → POST /acp/boot → 建 ws，含重试 |
| `acp-web/client/session.ts` | ACP 会话装配：connect → runtime → controller → LocalUiClient（唯一第二装配点） |
| `acp-web/client/app.tsx` | 浏览器入口 bootstrap（加载态、boot、worker URL、渲染、pagehide 收尾） |
| `acp-web/client/acp-agent-gateway.ts` | `AgentGateway` 契约的 ACP 实现：会话、prompt 驱动、取消、回放、审批、UNSUPPORTED 表 |
| `acp-web/client/translate.ts` | `session/update` → Core 事件的翻译（增量 diff、工具卡、终态、run meta） |
| `acp-web/client/replay.ts` | `session/load` 回放帧 → 历史时间线重建 |
| `acp-web/client/permission.ts` | `request_permission` → InteractionRequestEnvelope；响应 → ACP outcome |
| `acp-web/client/elicitation.ts` | `elicitation/create` 表单 ↔ 提问、计划、目标、拒绝反馈卡片 |
| `acp-web/client/runtime.ts` | `createAcpRuntime`/`synthesizeAgentCommands`/`createAcpCommandRegistry` |
| `acp-web/client/local-ui-client.ts` | `InteractiveController` ⇄ `WebUiClient` 契约适配（缺口固定值、intent 转发） |
| `acp-web/bundle.ts` + `html.ts` | 浏览器 bundle 构建/清单校验与 HTML 外壳（源码/生产两种模式） |

## 翻译规则摘要（Spec §5.4–§6.4）

### 方法表

客户端发给 Agent：

| 方法 | 稳定性 | 作用 |
|---|---|---|
| `initialize` | 稳定 | 握手。宣告读会话、恢复、关闭、列表、附加目录、内嵌上下文、HTTP MCP；不宣告图片、音频、SSE MCP |
| `session/new` | 稳定 | 建会话。`cwd` 必须是本进程工作区；可带 `mcpServers`、`additionalDirectories`；响应带 `modes` 和 `configOptions` |
| `session/load` | 稳定 | 回放完整历史后再响应。不做分页 |
| `session/list` | 稳定 | 键集游标，每页 50 条 |
| `session/prompt` | 稳定 | 一轮用户输入。内置斜杠命令在这里拦截，不启动模型 |
| `session/cancel` | 稳定 | 取消该会话当前 Run |
| `session/set_mode` | 稳定 | 切换审批模式。客户端没声明 `elicitation.form` 时，`plan` 回 `UNKNOWN_MODE` |
| `session/set_config_option` | 稳定 | 切换 `model` 或 `workflow`，只影响下一轮 |
| `session/resume` | UNSTABLE | 同一条连接上恢复空闲会话：返回模式和命令表，不回放历史 |
| `session/close` | UNSTABLE | 取消在途 Run，撤销该会话的附加目录和会话 MCP |

`authenticate`、`session/fork`、`session/delete` 不实现，由 SDK 回方法不存在。

Agent 发给客户端：

| 方法 | 稳定性 | 作用 |
|---|---|---|
| `session/update` | 稳定 | 正文、思考、工具卡、命令表、当前模式、配置项、会话信息、计划、用量 |
| `session/request_permission` | 稳定 | 审批和目录信任。文件变更带标准 `diff` |
| `elicitation/create` | UNSTABLE | 提问、计划确认、目标确认、拒绝后的反馈。没声明 `elicitation.form` 时不发 |

- **事件 → session/update**：正文 `agent_message_chunk`（messageId 维度的前缀 diff，只发增量）；思考 `agent_thought_chunk`；工具 `tool_call`/`tool_call_update`（title/kind/status/content/locations）；用量 `usage_update`；终态体现在 `session/prompt` 响应的 `stopReason`：正常结束为 `end_turn`、取消为 `cancelled`；运行失败以 JSON-RPC 错误返回。
- **审批 ⇄ request_permission**：v3 approval/directory_trust 统一翻成一个 `request_permission`；决定（allow/reject/kind）⇄ `selected.optionId`；`cancelled` 在取消与断连两个方向都成立。标准 diff 在工具卡的 `content` 里。声明了 `approval` 时，选项 `scope` 和原始 `requests` 挂 `_meta.harnessCode.approval`。
- **审批模式 ⇄ 会话模式**：`session/new`/`session/load`/`session/resume` 的 `modes` 承载 `default`/`auto-edit`/`auto`/`yolo`，声明了表单能力时再加 `plan`。Host 广播的模式变化转成 `current_mode_update`。批准计划后回到进入计划前的模式。

### UNSTABLE 依赖

`elicitation/create`、`session/resume`、`session/close` 属于 ACP 里尚未标成稳定的方法。官方 Python SDK `agent-client-protocol` 锁定 **0.12.1**（`test_elicitation.py` 的 `test_sdk_version_is_locked`，`test_sdk_client_e2e.py` 的 `test_sdk_version_is_pinned_release`）。客户端默认不路由这些方法，必须打开 `use_unstable_protocol`。表单的形状只写在 `elicitation.py` 和测试客户端 `packages/cli/src/acp-web/client/elicitation.ts`，SDK 升级时先看这两个文件和版本锁定测试。

## 扩展约定（Spec §4.4 + 实现）

- 命名空间：`_meta.harnessCode`（载荷字段）与 `_harnessCode/<方法>`（扩展方法前缀）；扩展版本固定 `1`。
- 能力位（未声明的客户端不收到对应字段；功能本身仍走标准 ACP）：

| 能力名 | 多出来的字段 |
|---|---|
| `approval` | 选项 `scope`（once / thread / project），以及审批 `requests`（超限截断） |
| `runSummary` | 正常结束的 `session/prompt` 响应带本轮耗时 |
| `sessionSummary` | 会话列表项带创建时间、消息条数、首尾一句 |
| `subagent` | 子代理工具卡带父调用 |
| `goal` | 握手里回报这个名字。目标表单和 `/goal` 是否出现看的是 `elicitation.form`；目标条目走标准 `plan` |
| `commands` | 命令来源；内置命令结果上的 `command`（例如要刷新历史）；`/btw` 的旁注标记 |

- 只对 `initialize` 的 `clientCapabilities` 里声明了该扩展的客户端发 `_meta.harnessCode` 与扩展方法；未声明的一律按标准 ACP 形状发（`ext.py`/`ext.ts` 单点判定，跨语言漂移由 `tests/acp-web/ext.test.ts` 锁）。`elicitation.form` 不是这个扩展，它是标准能力。
- 桥生成的 `_harnessCode/bridge/exit` 是唯一的桥侧扩展通知：子进程非预期退出时带退出码与脱敏 stderr 尾部。

## 桥的安全与生命周期（Spec §7.3/§7.4 + S3/S4 实现）

- 只绑 `127.0.0.1`；校验顺序固定 **Host → Origin → 凭据**，伪造 Host/Origin 不进凭据计数。
- 两阶段凭据：`bootCode`（打印在终端的 `#c=` 片段里，滑动过期 10 分钟）→ `POST /acp/boot` 换一次性 `wsToken`（60 秒 TTL）；都只存 SHA-256 digest，常量时间比较；连续 5 次错误码锁 30 秒返回 429。
- 单连接名额：第二个有效升级返回 409 且不烧 token；连接关闭到子进程回收完成前名额仍占着，防并发竞态双 spawn。
- 帧门禁：入站限 8 MiB、二进制 → 1003、非 JSON 对象/协议污染 → 1008/1011；出站对慢客户端有背压上限。
- 生命周期：ws 断开 → stdin EOF → SIGTERM（5s 宽限）→ SIGKILL（3s 宽限）；非预期崩溃先在 **stdio 全部读完后**发 `_harnessCode/bridge/exit`（保证最后几帧不丢），再以 1011 `agent-exited` 关闭。
- S4 补充：`Host.close()` 对仍在进行的 MCP 连接先 `cancel()` 再收尾——真实配置（2 个远程 HTTP MCP）下关闭耗时 4.5s → 0.37s，刷新页面不必再等旧进程。

## 打开/刷新性能基线

这些数字只作记录，不是自动门槛。目标仍是：打开到能输入 ≤ 1.6 秒，冷启动到 `initialize` ≤ 0.6 秒，`session/list` ≤ 0.1 秒。后两项里，冷启动没有达到；用户 2026-11-09 决定等 Electron 包后再评估，1.4 和 1.9 暂缓。

**2026-11-11 进程探针**（`packages/agent/scripts/acp_startup_probe.py`，Python 3.14.2，macOS arm64，临时 HOME，不读真实配置、不调用模型）：

| 场景 | 轮数 | `initialize` 中位 | `session/new` 中位 | 命令表中位 | `session/list` 中位 |
|---|---|---|---|---|---|
| 空线程库 | 5 | 1057 ms | 0.7 ms | 0.03 ms | 44 ms |
| 预置 200 条线程 | 3 | 1082 ms | 0.8 ms | 0.03 ms | 36 ms（返回 50 条，第一页） |

命令表在 `session/new` 之后马上发出，不再空等 0.5 秒。临时库上的 `session/list` 低于 0.1 秒。冷启动到 `initialize` 仍约 1.1 秒，高于 0.6 秒。2026-11-09 在 164 MB 真实线程库上紧跟 `session/new` 测到的 `session/list` 是 610～1728 ms，这次没有重测真实库。5000 条历史的 `session/load` 中位 430 ms，见 Task「S2 结果」，这次没有重测。

**2026-11-06 浏览器拆解（HC-209，历史）**：用户真实配置、无头 Chromium 下，`harness web` 从打开到能输入约 2.9 秒。页面与脚本约 0.05 秒，刷新时等旧进程约 0.45 秒，Python 启动加 `initialize` 约 1.3～1.5 秒，当时的 `session/list` 约 0.6 秒，另外还有固定 0.5 秒在等命令表。最后这一段已经去掉。这次没有重测整页打开时间，所以 1.6 秒的页面目标还没有新数字。

## 原有功能覆盖矩阵（2026-11-11，HC-200 S7）

对照的是代码，不是旧文档。命令来自 `packages/cli/src/interactive/commands.ts` 的 `builtinCommandDefinitions`，快捷键来自 `packages/cli/src/tui/application/shortcuts.ts`，协议来自 `packages/protocol/schema/v3.json` 的 `x-harness`。去向按 [Agent 接入架构](Agent接入架构.md) §3：标准 ACP → 协议兼容 → 上移平台 → 家族折算 → Harness 扩展或斜杠命令 → 不支持。本表只登记，不实现。

层：① 桌面/客户端，② 通用 ACP 运行时，③ Provider，④ Harness Agent。

### 斜杠命令

| 原有功能 | 状态 | 证据或去向 | 层 |
|---|---|---|---|
| `/help`、`/quit`（别名 `q`） | 已覆盖 | 命令表由 Agent 下发，退出是客户端自己的事。`test_server_commands.py` 的 `test_empty_commands_still_sends_update` | ① |
| `/new`（别名 `clear`） | 已覆盖 | 测试客户端保留本地命令 `thread.new`。`packages/cli` 的命令表测试 | ① |
| `/compact`、`/btw`、`/redo`、`/title`、`/goal`、`/abandon` | 已覆盖 | 见缺口表 GAP-07、10、09、39、03、04 | ④ |
| `/undo`（别名 `rewind`、`rollback`）最近一轮 | 已覆盖 | GAP-09。参数 `both`、`code`、`conversation` | ④ |
| `/undo` 打开历史回合选择器 | 未覆盖 | GAP-40。ACP 只回最近一轮 | ④，选择器在 ① |
| `/resume`（别名 `continue`、`threads`） | 已覆盖 | `session/list` 加 `session/load`。`test_server_sessions.py` | ④ |
| `/model`（别名 `models`） | 已覆盖 | 配置项 `model`。GAP-08 | ④ |
| `/skills` 调用 | 已覆盖 | `skill:` 命令。GAP-28 | ④ |
| `/skills` 安装、启停 | 未覆盖 | 已有 GAP-13，不另编号 | ③ / HC-201 |
| `/agents` | 未覆盖 | GAP-41。子代理过程见已关闭的 GAP-16 | ④ |
| `/teams` | 未覆盖 | GAP-42 | ④ |
| `/mcp` 查看和增删 | 未覆盖 | 已有 GAP-15。会话建立时带上的 MCP 见已关闭的 GAP-21 | HC-201 |
| `/web` | 未覆盖 | GAP-46。和 GAP-20 相邻：一个是接管活进程，一个是刷新把进程杀掉 | ① / HC-197 |
| `/new-work` | 未覆盖 | GAP-43。`/abandon` 已有 | ④ |
| `/plan`、`/plan-view` | 已覆盖 | 会话模式 `plan` 加标准 `plan` 更新。GAP-02；`test_goal_changed_becomes_a_plan` | ④ |
| `/code-index` | 未覆盖 | 已有 GAP-17 | HC-201 |
| `/status` | 部分覆盖 | 用量和模式已有。配置路径、版本等查看属于已有 GAP-18，不另编号 | ① + HC-201 |

### 快捷键

用户能感知的全局键如下。选择器里的上下、Esc、回车是客户端自己的焦点，不单列缺口。

| 原有功能 | 状态 | 证据或去向 | 层 |
|---|---|---|---|
| Ctrl+C 取消运行 | 已覆盖 | `session/cancel`。`test_server_cancel.py` | ④ |
| Ctrl+C 清空草稿、Ctrl+C / Ctrl+D 退出 | 已覆盖 | 客户端本地 | ① |
| Shift+Tab 切换审批模式 | 已覆盖 | `session/set_mode`。页面用下拉，键位由客户端做 | ④ / ① |
| 空输入 Tab 切换 Build / Compose | 已覆盖 | 配置项 `workflow`。`test_session_config.py` | ④ |
| Ctrl+O 展开工具、PgUp/PgDn 滚动、Ctrl+P 打开命令 | 已覆盖 | 客户端本地 | ① |
| 撤销对话框里的 1/2/3（对话、代码、两者） | 已覆盖 | 收成 `/undo` 的参数，不再做对话框 | ④ |
| 进入直接 shell 后 Esc 退出 | 未覆盖 | GAP-44。ACP 没有 `direct_shell` | ④ |

### 界面操作

| 原有功能 | 状态 | 证据或去向 | 层 |
|---|---|---|---|
| 发消息、流式正文、思考、工具卡、取消 | 已覆盖 | `test_server_lifecycle.py`、`test_sdk_client_e2e.py` | ④ |
| 审批、目录信任、左右 diff、拒绝并反馈 | 已覆盖 | GAP-06、05、30。`test_permissions.py` | ④ |
| 提问、计划确认、目标确认 | 已覆盖 | GAP-01、02、03。客户端要声明 `elicitation.form` | ④ |
| 侧栏会话、翻页、条数和预览、改名 | 已覆盖 | GAP-33、36、39 | ④ |
| 模型下拉、Compose 阶段、本轮用量、`@文件` | 已覆盖 | GAP-08、04、07、24 | ④ |
| 文件树、Git | 未覆盖 | 已有 GAP-11、GAP-12 | ① / HC-199、HC-207 |
| Trace | 未覆盖 | 已有 GAP-19 | HC-201 |
| 设置、技能管理、插件、运行期 MCP、代码索引 | 未覆盖 | 已有 GAP-18、13、14、15、17 | HC-201 |
| 输入历史 | 未覆盖 | 已有 GAP-25 | ① / HC-206、HC-202 |
| 刷新或断线取消运行中的任务 | 未覆盖 | 已有 GAP-20、GAP-29 | HC-197 |
| 插件安装前的同意卡 | 未覆盖 | GAP-45。`interaction.plugin_consent` 没有 ACP 翻译 | HC-201 |
| 第二个查看者接手同一运行 | 未覆盖 | GAP-47 | HC-196 |

### v3 方法

下面每个方法都对应上面某一行，不重复展开。

| 方法 | 状态 |
|---|---|
| `initialize`、`run.start`、`run.cancel`、`run.set_approval_mode`、`context.compact` | 已覆盖 |
| `threads.list`、`threads.open`、`threads.watch`、`threads.unwatch`、`threads.side_question`、`threads.set_title`、`threads.undo`、`threads.redo`、`threads.list_turns` | 已覆盖。`watch` 变成会话保持连接。`list_turns` 只为最近一轮服务，选更早回合见 GAP-40 |
| `models.list`、`compose.inspect`、`compose.abandon`、`goal.inspect`、`goal.request`、`goal.mutate` | 已覆盖 |
| `commands.bind` | 已覆盖。Agent 自己推命令表，客户端不再绑定 |
| `config.show`、`config.path`、`config.details`、`config.preview`、`config.commit`、`settings.list`、`settings.set`、`settings.remove` | 未覆盖，GAP-18 |
| `skills.*`、`plugins.*` | 未覆盖，GAP-13、GAP-14。调用 Skill 除外 |
| `agents.list`、`agents.inspect` | 未覆盖，GAP-41 |
| `teams.list`、`teams.inspect`、`teams.generate`、`teams.run`、`teams.cancel` | 未覆盖，GAP-42 |
| `mcp.status`、`mcp.add`、`mcp.remove` | 未覆盖，GAP-15 |
| `code_index.status`、`code_index.apply` | 未覆盖，GAP-17 |
| `host.attachment.create`、`host.attachment.revoke` | 未覆盖，GAP-46。会话附加目录是另一件事，已由 GAP-27 关闭 |
| `host.control.acquire`、`host.control.release`、`host.control.status` | 未覆盖，GAP-47 |

通知 `thread.summary`、`thread.approval_mode` 已覆盖。`code_index.changed` 随 GAP-17。事件 `run.*`、`content.delta`、`reasoning.delta`、`tool.*`、`compose.*`、`goal.changed` 已覆盖。`skill.loaded` 只在调用 Skill 时出现。`goal.evaluation` 没有单独的界面，目标确认走表单。

交互：`approval`、`question`、`directory_trust`、`plan`、`goal` 已覆盖。`plugin_consent` 见 GAP-45。

审批模式 `plan`、`default`、`auto-edit`、`auto`、`yolo` 已覆盖，下拉仍是这些英文 id。工作模式 `build`、`compose` 已覆盖。`direct_shell` 见 GAP-44。

### 启动参数和配置

| 原有功能 | 状态 | 去向 | 层 |
|---|---|---|---|
| `harness acp --cwd`、`--config` | 已覆盖 | 进程启动时绑定工作区和配置，不在会话中途改 | ④ |
| `harness --resume`、`-n` / `--message` | 已覆盖 | 对应 `session/load` 或 `session/resume`，以及一条 `session/prompt` | ④ |
| `--json`、`harness web --port`、`--no-open` | 已覆盖 | 客户端输出和桥的参数 | ① |
| `--sandbox` | 不进会话协议 | 只在拉起进程时由平台决定。TUI 会话中途没有这个开关，不另开缺口 | ① |
| 配置里的默认模型、默认审批模式 | 已覆盖 | 会话里再用配置项和 `session/set_mode` 改当前会话 | ④ |
| `[experimental.code_index]` | 未覆盖 | GAP-17 | HC-201 |

## 已知缺口（权威表）

治理规则（Spec §12.2 精简版）：

1. 缺口一律编号（GAP-xx），新缺口只允许追加、不复用旧号；
2. 每个用户可见的缺口必须在界面给出带编号的提示，不许静默吞掉；
3. 关闭一个缺口的唯一标准是：实现并过测试，然后把本行「状态」改成「已关闭」并附证据；
4. 放弃一个缺口要用户确认，表内记录确认日期；
5. **TUI 下线 Task 的前置条件是本表没有「未开始/进行中」的行。**

| 编号 | 功能 | 用户看到什么 | 原因 | 建议关闭方式 | 状态 | 证据 | 后续 Task |
|------|------|--------------|------|--------------|------|------|-----------|
| GAP-01 | 提问（`ask_user`） | 工具得到空答案，模型会继续或重复提问 | ACP 无通用提问请求 | 标准 `elicitation/create` 表单 | 已关闭 | `test_elicitation.py` 的 `test_question_accept_maps_indexes_back_to_ids`；`test_sdk_client_e2e.py` 的 `test_sdk_client_without_extensions_walks_question_plan_model_cancel_and_resume` | HC-200 |
| GAP-02 | Plan 模式与计划确认 | 界面没有 plan 模式；审批模式下拉仍列出 plan，选中发送提示「GAP-02」 | ACP 无计划确认方法 | 声明 `elicitation.form` 后暴露 `plan`，确认走表单 | 已关闭 | `test_server_modes.py` 的 `test_forms_client_lists_plan_and_keeps_configured_plan`、`test_set_plan_remembers_the_previous_mode`；同上端到端用例 | HC-200 |
| GAP-03 | 目标闭环（goal） | 无入口 | ACP 标准无对应方法/通知 | `/goal` 命令加确认表单；条目走标准 `plan` | 已关闭 | `test_builtin_commands.py` 的 `test_goal_forms_cover_inspect_mutate_create_and_abandon`、`test_accepted_goal_starts_the_continuation_before_the_prompt_returns`；`test_translate.py` 的 `test_goal_changed_becomes_a_plan` | HC-200 |
| GAP-04 | Compose 模式 | 无入口 | ACP 标准无对应方法 | 配置项 `workflow`；阶段走标准 `plan`；`/abandon` | 已关闭 | `test_session_config.py` 的 `test_echo_session_offers_workflow_without_a_model`、`test_compose_progress_becomes_a_plan_and_usage_dedupes` | HC-200 |
| GAP-05 | 拒绝并附反馈 | 审批卡片没有「拒绝并反馈」 | ACP 权限响应只带 optionId，无反馈字段 | 有表单能力时多一个选项，再追问一句原因 | 已关闭 | `test_permissions.py` 的 `test_reject_with_feedback_is_offered_only_with_forms`；`test_elicitation.py` 的 `test_feedback_decline_returns_none_without_touching_host` | HC-200 |
| GAP-06 | 标准 `diff` 内容（`oldText/newText`） | 通用客户端只看到文本形式的 diff | ACP 权限载荷无前后文字段 | 权限请求带标准 `diff` | 已关闭 | `test_permissions.py` 的 `test_permission_tool_call_carries_standard_diff` | HC-200 |
| GAP-07 | 上下文用量与压缩 | 无用量显示、无法手动压缩 | ACP 无用量通知与压缩方法 | `usage_update`、`PromptResponse.usage`、`/compact` | 已关闭 | `test_session_config.py` 的 `test_echo_prompt_response_carries_usage`；`test_builtin_commands.py` 的 `test_compact_reports_token_counts_and_does_not_start_a_run` | HC-200 |
| GAP-08 | 模型选择与切换 | 无入口 | ACP 无模型列表/切换方法 | 配置项 `model` | 已关闭 | `test_session_config.py` 的 `test_model_catalog_and_next_run_profile`；端到端用例切到 `slow` | HC-200 |
| GAP-09 | 撤销 / 重做 | 无入口 | ACP 标准无对应方法 | `/undo`、`/redo` | 已关闭 | `test_builtin_commands.py` 的 `test_undo_and_redo_report_history_changes`；`tests/host/test_thread_undo_redo.py` | HC-200 |
| GAP-10 | 旁路提问 `/btw` | 无入口 | ACP 标准无对应方法 | `/btw`，答案不入历史 | 已关闭 | `test_builtin_commands.py` 的 `test_btw_is_ephemeral_and_missing_args_are_rejected` | HC-200 |
| GAP-11 | 文件树与文件预览 | 面板显示「暂不支持」 | 浏览器不可读本机文件，ACP 无文件浏览方法 | Electron 主进程直接读本机文件 | 未开始 | — | HC-199、HC-207 |
| GAP-12 | Git 面板、提交、推送 | 面板显示不可用 | ACP 无 Git 能力，浏览器不可执行 | Electron 主进程直接调用 git | 未开始 | — | HC-199、HC-207 |
| GAP-13 | 技能管理 | 无入口 | ACP 标准无对应方法 | 自定义方法 | 未开始 | — | HC-201 |
| GAP-14 | 插件与设置 | 无入口 | ACP 标准无对应方法 | 自定义方法 | 未开始 | — | HC-201 |
| GAP-15 | MCP 运行期增删 | 无入口 | ACP 标准无对应方法 | 自定义方法 | 未开始 | — | HC-201 |
| GAP-16 | 子代理 / Team | 无入口；只看到父级 `task` 工具卡 | ACP 无子代理事件模型 | 子代理工具卡作为标准卡片，正文并入父卡 | 已关闭 | `test_subagent_cards.py` 的 `test_child_tool_card_with_binding`、`test_child_content_delta_appends_to_parent_card` | HC-200 |
| GAP-17 | 代码索引 | 无入口 | ACP 标准无对应方法 | 自定义方法与通知 | 未开始 | — | HC-201 |
| GAP-18 | 配置查看与修改 | 无入口 | ACP 标准无对应方法 | 自定义方法 | 未开始 | — | HC-201 |
| GAP-19 | Trace 面板 | 显示「未开启追踪」 | ACP 无 trace 通道 | 自定义通知，或直接读本机日志 | 未开始 | — | HC-201 |
| GAP-20 | 刷新页面重启 Python 并取消运行中任务 | 刷新后运行中的任务被取消 | 子进程生命周期绑定在桥连接上 | Electron 主进程常驻子进程 | 未开始 | — | HC-197 |
| GAP-21 | `session/new` 的 `mcpServers` 被忽略 | Zed 等客户端传入的 MCP 配置不生效 | v3 会话配置无此概念 | 并入会话级 MCP 配置 | 已关闭 | `tests/host/test_session_config_services.py` 的 `test_session_mcp_skips_sse_and_name_collisions` | HC-200 |
| GAP-22 | 历史回放的工具记录缺参数和状态 | 恢复的会话里工具卡片信息很少 | Transcript 未记录全量 | 回放带参数、状态、位置 | 已关闭 | `test_replay_tool_detail.py` 的 `test_replay_tool_carries_args_kind_locations`、`test_replay_tool_failed_status` | HC-200 |
| GAP-23 | 审批与工具卡关联的残余兜底匹配 | 同名同参调用可能出现「一次调用两张卡」 | 残余场景缺稳定调用 id | 每个审批都带工具调用 id | 已关闭 | `test_translate.py` 的 `test_two_approvals_with_distinct_ids_claim_their_own_cards`；`test_permissions.py` 的 `test_tool_call_id_links_to_the_announced_card` | HC-200 |
| GAP-24 | `@` 文件提及不内联文件内容 | 提及只作为 `@路径` 文本发给 Agent | ACP 无本地文件读取，浏览器不可读 | Agent 读 `resource_link` / 内联 `resource` | 已关闭 | `test_session_config.py` 的 `test_authorized_file_is_inlined_for_the_model_only`、`test_embedded_text_inlines_and_blob_is_rejected`。新平台若重写输入框，发送仍归 HC-206 | HC-200（界面发送归 HC-206） |
| GAP-25 | 输入历史（上下键）刷新后不保留 | 刷新页面后历史清空 | 目前只存在内存 | 浏览器本地存储，或 Electron 主进程落盘 | 未开始 | — | HC-206、HC-202 |
| GAP-26 | `locations` 只覆盖主工作区路径 | 已信任的工作区外目录里的文件无位置信息 | 位置解析只认 primary 根 | 复用 Host 完整根注册表 | 已关闭 | `tests/host/test_resolve_display_path.py` 的 `test_resolve_display_path_external_trusted_root` | HC-200 |
| GAP-27 | `session/new` 的 `mcpServers`、`additionalDirectories` 被忽略且无诊断 | 客户端传入的 MCP 配置不生效，日志也无结构化事件 | 只在 stderr 记个数 | 附加目录生效；跳过的 MCP 记诊断且不含命令 | 已关闭 | `test_session_config_services.py` 的 `test_additional_directory_rejections_keep_the_submitted_path`、`test_accepted_directory_is_revoked_on_close`；`test_server_lifecycle.py` 的 `test_untrustable_directory_rejects_the_whole_new_session`；MCP 诊断同 GAP-21 | HC-200 |
| GAP-28 | 普通 Skill 没有斜杠入口 | `/skill:xxx` 被当普通文本 | `available_commands` 只含 Plugin/Qwen 命令 | 用户可调用的 Skill 宣告为 `skill:` 命令 | 已关闭 | `test_builtin_commands.py` 的 `test_project_skill_slash_starts_a_normal_run` | HC-200 |
| GAP-29 | 审批无超时，桥侧失联让 Run 一直挂着 | 页面关闭或桥断开时挂起的审批要等连接关闭才被拒 | v3 交互本就没有服务端超时 | 桥检测断线回 `cancelled`；或审批加可配置超时 | 未开始 | — | HC-197 |
| GAP-30 | `approve_thread`/`approve_project` 都映射 `allow_always` | 依赖 `kind` 的通用客户端无法区分两个选项 | ACP `kind` 粒度粗 | 选项名称写明范围；声明 `approval` 时带 `scope` | 已关闭 | `test_permissions.py` 的 `test_options_follow_decisions_in_fixed_order`、`test_approval_extension_writes_scope_and_truncates_huge_requests` | HC-200 |
| GAP-31 | Host 侧模式变化不回流 `current_mode_update` | 界面显示的审批模式可能与实际不一致 | Host 无模式变化广播 | Host 广播，ACP 转成 `current_mode_update` | 已关闭 | `test_server_modes.py` 的 `test_approval_mode_echo_skips_the_mode_already_shown` | HC-200 |
| GAP-32 | 历史回放细节限制 | 超大历史首帧变慢；恢复会话看不出失败工具 | 回放不分块/分页、Transcript 无工具状态 | 完整回放，不做分页；5000 条耗时预算 | 已关闭 | 分页一半按 Spec §21 第 4 项关闭（用户 2026-11-07 确认 Spec）。`scripts/acp_replay_probe.py`：5000 条 `session/load` 中位 430ms；`tests/test_acp_replay_probe.py`。失败状态见 GAP-22 | HC-200 |
| GAP-33 | `session/list` 固定 200 条不分页 | 超过 200 个会话时旧会话列不出来 | 一期不分页 | 键集游标，每页 50 条 | 已关闭 | `test_server_sessions.py` 的 `test_list_paginates_120_threads_in_three_pages`、`test_list_invalid_cursor_returns_minus_32602` | HC-200 |
| GAP-34 | 子代理审批只显示为独立兜底卡 | 子代理里的工具审批不挂在工具卡下 | 随 GAP-16 子代理事件缺失 | 审批挂到子代理工具卡 | 已关闭 | `test_subagent_cards.py` 的 `test_child_approval_hangs_on_child_card` | HC-200 |
| GAP-35 | 审批帧可能早于同轮正文与 `tool.started` | 偶尔先看到权限请求，正文稍后才出现 | 事件流没有排序机制 | 同一 Run 的事件与审批按顺序送出 | 已关闭 | `test_event_order.py` 的 `test_permission_never_overtakes_event_frames` | HC-200 |
| GAP-36 | 会话摘要缺字段 | 侧栏不显示消息条数与最近预览；未声明 `session/list` 时显示 GAP-36 提示 | `SessionInfo` 无摘要来源 | 声明 `sessionSummary` 时带四字段 | 已关闭 | `test_extension_negotiation.py` 的 `test_session_list_carries_summary_meta_when_declared` | HC-200 |
| GAP-37 | Agent 命令缺字段且晚到无补全 | 命令更新晚于 500ms 到达则这页无补全；与内置重名的命令被丢弃 | 命令缺来源字段，空表不推送 | 来源字段；new/load 后必推命令表；目录变化整表重发 | 已关闭 | `test_server_commands.py` 的 `test_empty_commands_still_sends_update`；`test_builtin_commands.py` 的 `test_catalog_change_replaces_the_table_for_every_session` | HC-200 |
| GAP-38 | 审批 `payload.requests` 无 ACP 来源 | 由 `toolCall.rawInput` 合成而非 v3 原样 | `request_permission` 无原始 requests 字段 | 声明 `approval` 时携带 `requests` | 已关闭 | `test_permissions.py` 的 `test_approval_extension_writes_scope_and_truncates_huge_requests` | HC-200 |
| GAP-39 | 手动重命名会话（`/title`） | `/title xx` 被当普通消息发给 Agent | 内置命令被隐藏；ACP 无改名方法 | `/title` 后发 `session_info_update` | 已关闭 | `test_builtin_commands.py` 的 `test_title_updates_the_session_before_the_prompt_response` | HC-200 |
| GAP-40 | 选择更早的回合再撤销 | `/undo` 只能回最近一轮，不能点开历史回合 | TUI 有回合选择器，ACP 没有 | 斜杠命令增加回合参数；选择器放在客户端 | 未开始 | 覆盖矩阵 S7。来源 `commands.ts` 的 `thread.undo` | 建议新任务，或并入 HC-206 的客户端选择器。本任务不实现 |
| GAP-41 | 查看并指定 Agent | 没有 `/agents` 列表 | 子代理卡片已有，手动挑选没有 | Harness 斜杠命令 | 未开始 | 覆盖矩阵 S7。来源 `agents.list` / `agents.inspect` | 建议并入 HC-201。本任务不实现 |
| GAP-42 | Agent Team | 没有查看、生成、运行、取消 | 标准 ACP 没有 Team | Harness 斜杠命令 | 未开始 | 覆盖矩阵 S7。来源 `teams.*` | 建议新任务。本任务不建、不实现 |
| GAP-43 | `/new-work` | 不能放下当前 Compose 并马上开始新目标 | 只有 `/abandon` | Harness 斜杠命令 | 未开始 | 覆盖矩阵 S7。来源 `compose.new-work` | 建议新任务。本任务不实现 |
| GAP-44 | 直接 shell | 没有 `direct_shell`，也不能用 Esc 退出该模式 | ACP 会话模式只有审批模式和 build/compose | 增加一种会话模式，或一条斜杠命令 | 未开始 | 覆盖矩阵 S7。来源 `interactionMode` 与 `shortcuts.ts` | 建议由用户决定要不要做。本任务不实现 |
| GAP-45 | 插件同意 | 安装插件时没有同意卡 | `interaction.plugin_consent` 未翻译 | 并入插件管理，必要时再做成审批 | 未开始 | 覆盖矩阵 S7 | 建议 HC-201 |
| GAP-46 | TUI `/web` 接管活进程 | 不能把正在跑的 TUI 原进程交给浏览器 | `host.attachment` 没有 ACP 对应 | 平台把 Agent 进程留住，再让页面接上 | 未开始 | 覆盖矩阵 S7。与 GAP-20 不同 | HC-197 |
| GAP-47 | 控制权交接 | 第二个查看者不能接手同一运行 | `host.control.*` 没有 ACP 对应 | 设备与会话交接 | 未开始 | 覆盖矩阵 S7 | HC-196 |

证据里的测试文件，没写目录的都在 `packages/agent/tests/host/acp/`；写了 `tests/host/` 的在 `packages/agent/tests/host/`。归 HC-200 且已实现的行都是「已关闭」。GAP-40 到 GAP-47 是 S7 新登记的，尚未实现，也不在本任务里做。
