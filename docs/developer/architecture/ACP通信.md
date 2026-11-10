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

一期只实现标准 ACP 加少量 `_harnessCode` 扩展；标准协议没有的能力
（文件树、Git、模型切换等）按 §9 的缺口表逐条登记、编号上报给用户，
不静默省略。

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
| `server.py` | ACP 官方方法的实现入口（initialize/session-new/prompt/cancel/list/load/set_mode），分发到 Host |
| `translate.py` | v3 事件 → ACP `session/update` 的翻译器（文本增量、思考、工具生命周期、终态） |
| `permissions.py` | 审批 ⇄ `session/request_permission` 双向翻译（目录信任、file_diff presentation、拒绝/取消收敛） |
| `sessions.py` | `session/list`、`session/load`：ThreadSummary/回放消息 ↔ SessionInfo/历史帧 |
| `commands.py` | `available_commands_update`：Host 的 agent_commands ↔ ACP 斜杠命令 |
| `modes.py` | 审批模式 ⇄ ACP 会话模式（`session/set_mode`、`current_mode_update`） |
| `ext.py` | `_meta.harnessCode` 扩展协商常量与 negotiate（版本、能力位） |
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
| `acp-web/client/runtime.ts` | `createAcpRuntime`/`synthesizeAgentCommands`/`createAcpCommandRegistry` |
| `acp-web/client/local-ui-client.ts` | `InteractiveController` ⇄ `WebUiClient` 契约适配（缺口固定值、intent 转发） |
| `acp-web/bundle.ts` + `html.ts` | 浏览器 bundle 构建/清单校验与 HTML 外壳（源码/生产两种模式） |

## 翻译规则摘要（Spec §5.4–§6.4）

- **方法表**：`initialize`、`session/new`、`session/load`、`session/list`、`session/prompt`、`session/cancel`、`session/set_mode` 由 `AcpServer` 实现；Agent 主动向客户端发 `session/update`（含 `available_commands_update`、`current_mode_update` 等子类型）与 `session/request_permission`。
- **事件 → session/update**：正文 `agent_message_chunk`（messageId 维度的前缀 diff，只发增量）；思考 `agent_thought_chunk`；工具 `tool_call`/`tool_call_update`（title/kind/status/content/locations）；终态体现在 `session/prompt` 响应的 `stopReason`：正常结束为 `end_turn`、取消为 `cancelled`；运行失败以 JSON-RPC 错误返回。
- **审批 ⇄ request_permission**：v3 approval/directory_trust 统一翻成一个 `request_permission`；决定（allow/reject/kind）⇄ `selected.optionId`；`cancelled` 在取消与断连两个方向都成立；presentation（file_diff/目录信任详情）挂 `_meta.harnessCode.approval`。
- **审批模式 ⇄ 会话模式**：`session/new`/`session/load` 的 `modes` 字段承载 `default/plan/…`；`set_mode` 双向同步；Host 侧模型驱动的模式变化回流 GAP-31。

## 扩展约定（Spec §4.4 + 实现）

- 命名空间：`_meta.harnessCode`（载荷字段）与 `_harnessCode/<方法>`（扩展方法前缀）；扩展版本固定 `1`。
- 能力位：`approval`（审批 presentation/pending 收敛）与 `runSummary`（线程摘要更新通知）。
- 只对 `initialize` 的 `clientCapabilities` 里声明了该扩展的客户端发 `_meta.harnessCode` 与扩展方法；未声明的一律按标准 ACP 形状发（`ext.py`/`ext.ts` 单点判定，跨语言漂移由 `tests/acp-web/ext.test.ts` 锁）。
- 桥生成的 `_harnessCode/bridge/exit` 是唯一的桥侧扩展通知：子进程非预期退出时带退出码与脱敏 stderr 尾部。

## 桥的安全与生命周期（Spec §7.3/§7.4 + S3/S4 实现）

- 只绑 `127.0.0.1`；校验顺序固定 **Host → Origin → 凭据**，伪造 Host/Origin 不进凭据计数。
- 两阶段凭据：`bootCode`（打印在终端的 `#c=` 片段里，滑动过期 10 分钟）→ `POST /acp/boot` 换一次性 `wsToken`（60 秒 TTL）；都只存 SHA-256 digest，常量时间比较；连续 5 次错误码锁 30 秒返回 429。
- 单连接名额：第二个有效升级返回 409 且不烧 token；连接关闭到子进程回收完成前名额仍占着，防并发竞态双 spawn。
- 帧门禁：入站限 8 MiB、二进制 → 1003、非 JSON 对象/协议污染 → 1008/1011；出站对慢客户端有背压上限。
- 生命周期：ws 断开 → stdin EOF → SIGTERM（5s 宽限）→ SIGKILL（3s 宽限）；非预期崩溃先在 **stdio 全部读完后**发 `_harnessCode/bridge/exit`（保证最后几帧不丢），再以 1011 `agent-exited` 关闭。
- S4 补充：`Host.close()` 对仍在进行的 MCP 连接先 `cancel()` 再收尾——真实配置（2 个远程 HTTP MCP）下关闭耗时 4.5s → 0.37s，刷新页面不必再等旧进程。

## 打开/刷新性能基线（2026-11-06，HC-209 S4 实测）

`harness web` 每次打开或刷新页面约 2.9 秒才能输入，原因是每个页面连接都冷启动一个新的 `harness acp`。用户真实配置（2 个远程 HTTP MCP）、无头 Chromium 实测拆解：

| 阶段 | 耗时 | 说明与可选优化 |
|---|---|---|
| 页面与脚本加载 | ≈0.05s | 无需处理 |
| 刷新时等旧进程退出 | ≈0.45s（首次打开无） | 旧进程退出已从 4.5s 降到 0.37s；剩余是浏览器 409 重试间隔 450ms，可缩短到 150ms 左右 |
| Python 启动与导入（langchain 等，仅导入约 0.9s）+ initialize | ≈1.3–1.5s | 常驻或预热子进程即可消除；也可做惰性导入 |
| `session/list` | ≈0.6s | 原因未查，需先定位（疑似 SQLite 打开或列表查询） |
| 等待 `available_commands_update` | 固定 0.5s | 没有插件命令时 Python 不发命令清单，浏览器每次等满 `settleCommandsMs`；让 Python 始终发一次（可为空）即可 |

## 已知缺口（权威表）

治理规则（Spec §12.2 精简版）：

1. 缺口一律编号（GAP-xx），新缺口只允许追加、不复用旧号；
2. 每个用户可见的缺口必须在界面给出带编号的提示，不许静默吞掉；
3. 关闭一个缺口的唯一标准是：实现并过测试，然后把本行「状态」改成「已关闭」并附证据；
4. 放弃一个缺口要用户确认，表内记录确认日期；
5. **TUI 下线 Task 的前置条件是本表没有「未开始/进行中」的行。**

| 编号 | 功能 | 用户看到什么 | 原因 | 建议关闭方式 | 状态 | 后续 Task |
|------|------|--------------|------|--------------|------|-----------|
| GAP-01 | 提问（`ask_user`） | 工具得到空答案，模型会继续或重复提问 | ACP 无通用提问请求 | 自定义请求，或退化为带选项的权限请求 | 未开始 | HC-200 |
| GAP-02 | Plan 模式与计划确认 | 界面没有 plan 模式；审批模式下拉仍列出 plan，选中发送提示「GAP-02」 | ACP 无计划确认方法 | 自定义请求「确认计划」 | 未开始 | HC-200 |
| GAP-03 | 目标闭环（goal） | 无入口 | ACP 标准无对应方法/通知 | 自定义方法与通知 | 未开始 | HC-200 |
| GAP-04 | Compose 模式 | 无入口 | ACP 标准无对应方法 | 自定义方法与通知 | 未开始 | HC-200 |
| GAP-05 | 拒绝并附反馈 | 审批卡片没有「拒绝并反馈」 | ACP 权限响应只带 optionId，无反馈字段 | `_meta` 携带反馈文本，或自定义响应字段 | 未开始 | HC-200 |
| GAP-06 | 标准 `diff` 内容（`oldText/newText`） | 通用客户端只看到文本形式的 diff | ACP 权限载荷无前后文字段 | 审批预计算携带前后文 | 未开始 | HC-200 |
| GAP-07 | 上下文用量与压缩 | 无用量显示、无法手动压缩 | ACP 无用量通知与压缩方法 | `usage_update` + 自定义压缩方法 | 未开始 | HC-200 |
| GAP-08 | 模型选择与切换 | 无入口 | ACP 无模型列表/切换方法 | 标准会话配置项，或自定义方法 | 未开始 | HC-200 |
| GAP-09 | 撤销 / 重做 | 无入口 | ACP 标准无对应方法 | 自定义方法 | 未开始 | HC-200 |
| GAP-10 | 旁路提问 `/btw` | 无入口 | ACP 标准无对应方法 | 自定义方法 | 未开始 | HC-200 |
| GAP-11 | 文件树与文件预览 | 面板显示「暂不支持」 | 浏览器不可读本机文件，ACP 无文件浏览方法 | Electron 主进程直接读本机文件 | 未开始 | HC-199、HC-207 |
| GAP-12 | Git 面板、提交、推送 | 面板显示不可用 | ACP 无 Git 能力，浏览器不可执行 | Electron 主进程直接调用 git | 未开始 | HC-199、HC-207 |
| GAP-13 | 技能管理 | 无入口 | ACP 标准无对应方法 | 自定义方法 | 未开始 | HC-201 |
| GAP-14 | 插件与设置 | 无入口 | ACP 标准无对应方法 | 自定义方法 | 未开始 | HC-201 |
| GAP-15 | MCP 运行期增删 | 无入口 | ACP 标准无对应方法 | 自定义方法 | 未开始 | HC-201 |
| GAP-16 | 子代理 / Team | 无入口；只看到父级 `task` 工具卡 | ACP 无子代理事件模型 | 自定义方法与通知 | 未开始 | HC-200 |
| GAP-17 | 代码索引 | 无入口 | ACP 标准无对应方法 | 自定义方法与通知 | 未开始 | HC-201 |
| GAP-18 | 配置查看与修改 | 无入口 | ACP 标准无对应方法 | 自定义方法 | 未开始 | HC-201 |
| GAP-19 | Trace 面板 | 显示「未开启追踪」 | ACP 无 trace 通道 | 自定义通知，或直接读本机日志 | 未开始 | HC-201 |
| GAP-20 | 刷新页面重启 Python 并取消运行中任务 | 刷新后运行中的任务被取消 | 子进程生命周期绑定在桥连接上 | Electron 主进程常驻子进程 | 未开始 | HC-197 |
| GAP-21 | `session/new` 的 `mcpServers` 被忽略 | Zed 等客户端传入的 MCP 配置不生效 | v3 会话配置无此概念 | 并入会话级 MCP 配置 | 未开始 | HC-200 |
| GAP-22 | 历史回放的工具记录缺参数和状态 | 恢复的会话里工具卡片信息很少 | Transcript 未记录全量 | 读取 Transcript 里更完整的记录 | 未开始 | HC-200 |
| GAP-23 | 审批与工具卡关联的残余兜底匹配 | 同名同参调用可能出现「一次调用两张卡」 | 残余场景缺稳定调用 id | Python 分配稳定内部 id 贯穿事件与审批 | 未开始 | HC-200 |
| GAP-24 | `@` 文件提及不内联文件内容 | 提及只作为 `@路径` 文本发给 Agent | ACP 无本地文件读取，浏览器不可读 | `resource_link`/内容块，或 Electron 主进程读文件 | 未开始 | HC-200（界面发送归 HC-206） |
| GAP-25 | 输入历史（上下键）刷新后不保留 | 刷新页面后历史清空 | 目前只存在内存 | 浏览器本地存储，或 Electron 主进程落盘 | 未开始 | HC-206、HC-202 |
| GAP-26 | `locations` 只覆盖主工作区路径 | 已信任的工作区外目录里的文件无位置信息 | 位置解析只认 primary 根 | 复用 Host 完整根注册表（需 Host 暴露只读路径策略） | 未开始 | HC-200 |
| GAP-27 | `session/new` 的 `mcpServers`、`additionalDirectories` 被忽略且无诊断 | 客户端传入的 MCP 配置不生效，日志也无结构化事件 | 只在 stderr 记个数 | 新增诊断事件并把 MCP 配置并入会话配置 | 未开始 | HC-200 |
| GAP-28 | 普通 Skill 没有斜杠入口 | `/skill:xxx` 被当普通文本 | `available_commands` 只含 Plugin/Qwen 命令 | 扩展命令来源并放宽校验，或 Skill 自定义方法 | 未开始 | HC-200 |
| GAP-29 | 审批无超时，桥侧失联让 Run 一直挂着 | 页面关闭或桥断开时挂起的审批要等连接关闭才被拒 | v3 交互本就没有服务端超时 | 桥检测断线回 `cancelled`；或审批加可配置超时 | 未开始 | HC-197 |
| GAP-30 | `approve_thread`/`approve_project` 都映射 `allow_always` | 依赖 `kind` 的通用客户端无法区分两个选项 | ACP `kind` 粒度粗 | 选项名称写明范围（已写），或拆 kind/自定义字段 | 未开始 | HC-200 |
| GAP-31 | Host 侧模式变化不回流 `current_mode_update` | 界面显示的审批模式可能与实际不一致 | Host 无模式变化广播 | Host 广播事件，ACP 转成 `current_mode_update` | 未开始 | HC-200 |
| GAP-32 | 历史回放细节限制 | 超大历史首帧变慢；恢复会话看不出失败工具 | 回放不分块/分页、Transcript 无工具状态 | 回放分块与分页；Transcript 记录工具状态 | 未开始 | HC-200 |
| GAP-33 | `session/list` 固定 200 条不分页 | 超过 200 个会话时旧会话列不出来 | 一期不分页 | `cursor` 分页 | 未开始 | HC-200 |
| GAP-34 | 子代理审批只显示为独立兜底卡 | 子代理里的工具审批不挂在工具卡下 | 随 GAP-16 子代理事件缺失 | 随子代理过程可见化一起解决 | 未开始 | HC-200 |
| GAP-35 | 审批帧可能早于同轮正文与 `tool.started` | 偶尔先看到权限请求，正文稍后才出现 | 事件流没有排序机制 | Host 保证事件顺序，或翻译器按序号重排 | 未开始 | HC-200 |
| GAP-36 | 会话摘要缺字段 | 侧栏不显示消息条数与最近预览；未声明 `session/list` 时显示 GAP-36 提示 | `SessionInfo` 无 `created_at_ms`/`message_count`/首尾消息字段来源 | `SessionInfo._meta.harnessCode` 携带这四个字段 | 未开始 | HC-200 |
| GAP-37 | Agent 命令缺字段且晚到无补全 | 命令更新晚于 500ms 到达则这页无补全；与内置重名的命令被丢弃 | `AgentCommand` 无 `id`/`requested_skill_id`/`plugin_id` 来源 | 命令更新带 `_meta.harnessCode` 的 id 与来源；控制器支持动态命令表 | 未开始 | HC-200 |
| GAP-38 | 审批 `payload.requests` 无 ACP 来源 | 由 `toolCall.rawInput` 合成而非 v3 原样 | `request_permission` 无原始 requests 字段 | `_meta.harnessCode.approval` 携带 v3 原始 `requests` | 未开始 | HC-200 |
| GAP-39 | 手动重命名会话（`/title`） | `/title xx` 被当普通消息发给 Agent | 内置命令被 `threads.read` 能力隐藏；ACP 无改名方法 | 自定义方法 `_harnessCode/sessions/set_title` | 未开始 | HC-200 |
