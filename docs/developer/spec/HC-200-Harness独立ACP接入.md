# HC-200：Harness独立ACP接入规格

来源：[Task](../task/HC-200-Harness独立ACP接入.md)。Task 已确认三件事：Harness 作为独立 ACP Agent 接入新平台；原「补齐 ACP 缺口扩展」任务中 Agent 侧的 28 个缺口、握手缺陷和三项启动性能优化并入本任务；可以修改现有 `harness web` 测试客户端，用来在浏览器里验收。本规格把这些要求落实到协议映射、Host 改动、错误语义和验证方式。

状态：用户已确认（2026-11-07，第 21 节五项决定均按推荐方案）。北辰的 HC-197 还没开始写代码，本规格先按「平台只依赖标准 ACP」设计；分层与决策顺序以 [Agent 接入架构](../architecture/Agent接入架构.md) 为准（第 4.2 节）。

---

## 1. 目标与成功标准

**目标**：`harness acp` 对任何标准 ACP 客户端都完整可用。新平台（HC-197 的通用运行时）不认识 Harness 的私有字段，也能建会话、流式运行、取消、回答提问、确认计划、恢复会话。Harness 特有的增强信息（会话摘要、命令来源、子代理归属等）只发给声明了 `_meta.harnessCode` 扩展的客户端。

**现状痛点**：HC-209 做出的 `harness acp` 只覆盖了对话、工具卡和审批。提问、计划确认、模型切换、撤销、`/btw` 这些功能在 TUI 里能用，走 ACP 就用不了；另外还有几处细节缺陷，比如偶尔一次调用出现两张卡、审批卡先于正文出现。每次打开页面要等约 2.9 秒才能输入。

**解决思路**：能用 ACP 标准表达的一律走标准，标准没有的才用 `_meta.harnessCode` 扩展。业务全部复用 AgentHost 现有能力，ACP 层只做翻译。

**成功标准**：

| # | 结果 | 怎么验证 |
|---|---|---|
| 1 | 标准 ACP 客户端（不声明扩展）能完成：新建/恢复/续接会话、流式对话、工具卡、取消、审批、提问、计划确认、切换模型 | 官方 Python SDK 客户端端到端测试（§18.2） |
| 2 | 第 3 节所列 28 个缺口每个都关闭并有测试证据，或由用户确认放弃并记下日期 | 缺口表逐行核对（§20） |
| 3 | 握手阶段的每个请求都有响应，客户端不会挂住 | 流水线发送测试（§6.1） |
| 4 | 打开 `harness web` 到能输入的耗时从约 2.9 秒降到 1.6 秒以内（真实配置，5 次取中位数） | 性能脚本记录（§16） |
| 5 | 在浏览器里可以亲眼看到提问卡、计划确认、拒绝附反馈、模型切换、用量、撤销/重做、子代理工具卡 | `harness web` 人工冒烟（§17、§22） |
| 6 | 没有 Harness/Python 时新平台照常工作；平台代码不 import Harness 类型 | 本任务不改 `apps/`、`packages/workbench-*`、`packages/acp-runtime`；`npm run check:boundaries` 通过 |
| 7 | Python 与 TypeScript 双端测试覆盖取消、断连、畸形帧和终态错误 | §18 测试清单 |

Task 验收中的「通用 acp-runtime 启动真实 Harness」和「用户 B 接手同一会话」依赖 HC-197/196 的实现，本任务只交付 Agent 侧能力和协议冒烟证据，不把它们算作已通过（§19）。

---

## 2. 前置调研结论（2026-11-06 核实）

**ACP 标准与 SDK 现状**

1. 仓库锁定的两个 SDK 版本：Python `agent-client-protocol==0.12.1`，TypeScript `@agentclientprotocol/sdk@0.25.1`。下面的能力在两边都有类型定义和方法：

| 标准能力 | 稳定性（SDK 注释） | 对应缺口 |
|---|---|---|
| `session/list` 的 `cursor` / `nextCursor` 分页 | 稳定 | GAP-33 |
| `session/resume`（续接会话但不回放历史）、`session/close` | 稳定 | Task「恢复不重复回放」 |
| `sessionCapabilities.additionalDirectories` 以及 new/load/resume 上的 `additionalDirectories` | 稳定 | GAP-27 |
| `session/new` / `load` / `resume` 的 `mcpServers`（stdio、http、sse） | 稳定 | GAP-21/27 |
| 会话配置项 `configOptions`、`session/set_config_option`、`config_option_update`，`category: "model"` | 稳定 | GAP-08、GAP-04 |
| `usage_update`（上下文已用/窗口大小/费用） | 稳定 | GAP-07 |
| 工具调用内容 `diff`（`path` / `oldText` / `newText`） | 稳定 | GAP-06 |
| `plan` 会话更新（整表替换的计划条目） | 稳定 | GAP-04、GAP-03 的进度展示 |
| `PromptCapabilities.embeddedContext` 与 `resource` 内容块 | 稳定 | GAP-24 |
| `elicitation/create`（表单式向用户要输入） | **UNSTABLE**，需客户端在 `clientCapabilities.elicitation.form` 声明 | GAP-01、02、03、05 |
| `PromptResponse.usage`（本轮 token 用量） | **UNSTABLE** | GAP-07 |

结论：原缺口表里约一半的缺口是按 HC-209 时期的理解写成「ACP 没有」，其实现在已经有标准做法了。没有标准的只剩会话改名、撤销/重做、`/btw`、上下文压缩、子代理归属、Goal 状态和几项「附加字段」类缺口。

2. ACP 没有「客户端修改会话标题」「撤销」「压缩」这类方法，但标准里有 `available_commands_update`：Agent 宣告斜杠命令，客户端把 `/名称 参数` 当普通 prompt 发过来，Agent 自己识别并执行。claude-agent-acp 等实现就是这样做内置命令的。本规格用这个机制承载没有标准方法的用户操作（§11）。

**现有代码**

3. Python 的 SDK 接收循环为每个请求单独起一个任务（`acp/connection.py` 的 `_process_message`），所以 `initialize` 还在 `ensure_ready()` 中等待时，`session/new` 会并发进入 `new_session`，看到 `_connection is None` 就立刻回 `-32600 NOT_INITIALIZED`。HC-209 记录的是「不回响应」，和代码推断对不上。实施第一步要先用流水线测试复现，确认真实表现（§6.1）。S0 实测见 §6.1：缺陷表现确为 `NOT_INITIALIZED`，且只在 `ensure_ready()` 真实让出事件循环时出现。
4. AgentHost 已经实现了全部业务，都是 v3 处理器：`threads.undo/redo/set_title/side_question/list_turns`、`context.compact`、`models.list`、`goal.inspect/request/mutate`、`compose.inspect/abandon`。四种交互也都有：`interaction.question`、`interaction.plan`、`interaction.goal`、`interaction.plugin_consent`。这些处理器从 ContextVar 读取当前连接，ACP 不能直接调用。按 HC-209 D-1 的做法，要抽成显式接收 `conn` 参数的服务方法（§14.1）。
5. `server.py` 目前只把 `approval` 和 `directory_trust` 两种交互翻译成 ACP，其他交互一律立刻 fail-closed（直接拒绝，不让 Run 卡住）。`modes.py` 永远不暴露 `plan`。`translate.py` 丢弃所有子代理事件。`sessions.py` 回放工具时固定为 `completed`、不带参数，`session/list` 固定返回 200 条。新会话的 `mcpServers` 和 `additionalDirectories` 只在 stderr 记一个数量。
6. 审批预计算（`tools/file_mutation.py` 的 `PreparedFileMutation`）手里有改前和改后的全文，但写进 v3 `fileDiffPresentation` 的只有截断后的 `unified_diff`（最多 16 KiB）。
7. `WorkspaceRootRegistry`（`policy/workspace_roots.py`）已经支持 `session` 作用域的额外根，是「哪些目录可以访问」的唯一事实源。`PathLocator` 目前只认主工作区。
8. 线程摘要（`ThreadSummary`）本来就有 `created_at_ms`、`message_count`、`first_message`、`latest_message`。`list_threads` 的排序是 `updated_at_ms DESC, thread_id ASC`，可以直接按这两个字段做键集分页。

---

## 3. 范围：28 个缺口与对应做法

| 缺口 | 做法 | 标准/扩展 | 章节 |
|---|---|---|---|
| 握手缺陷 | 握手闸门：等 `initialize` 完成后再处理会话请求 | 标准行为 | §6.1 |
| GAP-01 提问 | `interaction.question` → `elicitation/create` 表单 | 标准（UNSTABLE） | §8.3 |
| GAP-02 Plan 模式 | 暴露 `plan` 模式；`interaction.plan` → 表单 | 标准（UNSTABLE） | §8.4、§9.1 |
| GAP-03 Goal | `/goal` 命令；`interaction.goal` → 表单；目标条目 → `plan`；完整状态走扩展 | 标准 + 扩展 `goal` | §8.5、§11.3 |
| GAP-04 Compose | 配置项 `workflow`（build/compose）；阶段 → `plan`；`/abandon` | 标准 | §9.2、§7.6 |
| GAP-05 拒绝附反馈 | 选项「拒绝并说明原因」+ 追问表单 | 标准（UNSTABLE） | §8.2 |
| GAP-06 diff 前后文 | 权限请求带标准 `diff` 内容 | 标准 | §8.1 |
| GAP-07 用量与压缩 | `usage_update` + `PromptResponse.usage`；`/compact` 命令 | 标准 | §7.4、§11.3 |
| GAP-08 模型切换 | 配置项 `model` | 标准 | §9.2 |
| GAP-09 撤销/重做 | `/undo`、`/redo` 命令 | 标准命令 + 扩展 `commands` 提示刷新 | §11.3 |
| GAP-10 `/btw` | `/btw` 命令，答案不入历史 | 标准命令 + 扩展 `commands` | §11.3 |
| GAP-16 子代理 | 子代理工具卡作为标准卡片；正文并入父 `task` 卡；归属走扩展 | 标准 + 扩展 `subagent` | §7.3 |
| GAP-21 `mcpServers` | 会话级 MCP 生效 | 标准 | §9.3 |
| GAP-22 回放工具细节 | 回放带参数、状态、位置 | 标准 | §12.3 |
| GAP-23 稳定调用 id | 每个审批都带工具调用 id，删除按参数匹配的降级逻辑 | 标准 | §7.2 |
| GAP-24 `@` 文件内容 | `resource_link` 由 Agent 读取内联；`resource` 直接内联 | 标准 | §10 |
| GAP-26 工作区外位置 | `locations` 解析覆盖所有已授权根 | 标准 | §7.5 |
| GAP-27 MCP/附加目录与诊断 | `additionalDirectories` 生效 + 结构化诊断事件 | 标准 | §9.3、§9.4 |
| GAP-28 Skill 斜杠入口 | 可由用户调用的 Skill 宣告为 `skill:<id>` 命令 | 标准 | §11.2 |
| GAP-30 允许范围 | 选项名写明范围 + `_meta.harnessCode.scope` | 标准 + 扩展 `approval` | §8.1 |
| GAP-31 模式回流 | Host 广播模式变化 → `current_mode_update` | 标准 | §9.1、§14.3 |
| GAP-32 大历史回放 | 回放耗时预算与分块；不做分页（理由见 §12.3） | 标准 | §12.3 |
| GAP-33 会话分页 | 键集游标 | 标准 | §12.1 |
| GAP-34 子代理审批挂卡 | 子代理审批挂到子代理工具卡 | 标准 | §7.3 |
| GAP-35 事件顺序 | Host 保证同一 Run 的事件与交互按顺序送出 | 标准行为 | §7.1 |
| GAP-36 会话摘要字段 | `SessionInfo._meta.harnessCode.summary` | 扩展 `sessionSummary` | §12.2 |
| GAP-37 命令字段与晚到 | 命令带来源扩展字段；命令表变化时重发 | 标准 + 扩展 `commands` | §11.4 |
| GAP-38 原始审批请求 | `_meta.harnessCode.approval.requests` | 扩展 `approval` | §8.1 |
| GAP-39 会话改名 | `/title` 命令 → `session_info_update` | 标准命令 | §11.3 |

另外三项性能优化见 §16。

---

## 4. 总体设计

### 4.1 设计原则

1. **标准优先。** 标准能表达就走标准；扩展只放「附加信息」，不放「必需流程」。不声明扩展的客户端（HC-197、Zed）也必须能把每个功能完整走通。
2. **能力缺失就不宣告。** 如果客户端没声明 `elicitation.form`，就不暴露 `plan` 模式，不提供「拒绝并说明原因」选项，也不把提问能力交给模型（§8.6）。不给出一个点了必然失败的开关。
3. **执行权威只有一个。** Run、审批、检查点、标题、Goal、Compose 的状态都只在 AgentHost 里。ACP 层不缓存业务状态，只保留「连接 ↔ 会话」的登记，以及翻译所需的临时映射。
4. **不保留旧路径。** 被替换掉的降级逻辑（按参数匹配工具卡、`plan` 回退、空命令表不发）直接删除，不留开关。

### 4.2 在 Agent 接入架构中的位置（2026-11-07 用户确认）

平台接入各种 Coding Agent 的长期原则见 [Agent 接入架构](../architecture/Agent接入架构.md)，本规格只能在它的约束下细化。要点：

```text
① 桌面 UI 层         只按标准 ACP 事件 + 能力渲染，不认识任何 Agent
② ACP 协议层         标准 ACP 客户端 + 协议兼容垫片（按版本，不按 Agent）
③ Provider 适配层    每个上游家族一份描述（harness 默认 / cline / pi / qwen …），可选
④ Agent 进程         harness acp（本任务） / cline --acp / pi-acp / qwen --acp …
```

企业内的其他 Agent 大多魔改自 Cline、Pi、Qwen Code，不一定愿意配合我们，所以平台的任何功能都不能依赖某个 Agent 的配合。Harness 在平台眼里只是④中的一家：它是默认 Provider，但不是必需依赖，除了 `_meta.harnessCode` 的增强显示外没有特权路径。

本任务只交付④中的 `harness acp`。每个功能按架构文档 §3 的决策顺序找落点：

```text
1. 标准 ACP 已有          → 用标准
2. 标准有但版本有差异     → 属于②，本任务不做；Harness 按当前 SDK 的标准形状输出
3. 可以不依赖 Agent 完成  → 属于平台，本任务不做；Harness 自己的同类能力照常保留
4. 某家族上游自带         → 属于③，与 Harness 无关
5. 只有 Harness 能做      → `_meta.harnessCode`，只作增强显示，不能是必需流程
```

由此对本任务的硬约束：
1. 客户端不声明扩展时，每个功能仍能用标准 ACP 完整走通，只少增强显示（§13，Task 验收项）。
2. 没有标准方法的用户操作做成 Agent 宣告的斜杠命令（D-2），不新增自定义方法。
3. 能力没在 `initialize` 里宣告，就不能依赖它（§4.1 第 2 条）；客户端没声明的能力，Harness 也不使用（§8.6）。
4. 输出只用 ACP 概念，不暴露 Thread、Run、Interaction 等 Harness 内部概念；`sessionId` 对外不透明。
5. Harness 的 ACP 行为也要能通过架构文档 §6 的一致性测试，S6 产出 Harness 那一行能力矩阵。

**代码位置**（架构文档 §2.1）：本任务的生产代码只在④层：`packages/agent`，也就是默认 Agent Harness。不新建、也不修改①②③的任何目录（`apps/`、`packages/workbench-*`、`packages/acp-runtime`、`packages/providers/`）。Harness 的③层 Provider（`packages/providers/harness/`）归 HC-201。④层内部同样分层，ACP 相关代码不能散落到业务模块里：

```text
packages/agent/harness_agent/
  host/acp/          ACP 出口：只做 ACP ⇄ Host 服务的翻译（stdio、server、translate、permissions、
                     elicitation、sessions、commands、config、modes、ext、tool_display）
                     只能经 HostServicePort 调用 Host，不 import 运行时、工具、持久层的内部模块
  host/              AgentHost 与服务面（service_types.py 的 HostServicePort）：Harness 业务的唯一入口
  其余目录           运行时、工具、策略、上下文、持久化：不知道 ACP 的存在
```

规则：
- Harness 业务改动（例如有序下发、工具状态读出、Skill 进命令快照）放在 Host 或业务模块，不写进 `host/acp/`。
- `host/acp/` 调用 Harness 业务只经 `HostServicePort`。除了 `harness_agent.host.*`，它只能 import 一份白名单里的只读模块，也就是常量、错误类型和数据记录。白名单就是现有代码里已经在用的 9 处：`__version__`、`diagnostic_log.runtime.ensure_log`、`extensions.plugin_skills.SkillError`、`extensions.skills.SkillError`、`threads.thread_persistence.ThreadPersistenceError`、`threads.thread_records.ThreadSummary`、`protocol.generated.MAX_FRAME_BYTES`、`policy.tool_risk.TOOL_KIND_MAP`、`tools.file_tool_catalog`。白名单要新增条目，必须先改本节。
  - **S1 实测补充（2026-11-09，架构测试首次扫描）**：现有代码实际有 10 处，漏数的一处是 `tool_display.py` 的 `PathLocator` 里延迟 import 的 `policy.workspace_boundary.WorkspacePathPolicy`。它是**临时豁免**：S2 的 2.7 让 `PathLocator` 改走 `HostServicePort.workspace_roots()`（§7.5）后，这条 import 随之消失，同时从测试的豁免清单里删掉。在那之前架构测试把它列为带退出条件的单独豁免项，不算正式白名单。
- 反方向：除了 `host/acp/` 和进程入口 `__main__.py`，`harness_agent` 中任何模块都不能 import ACP SDK（`acp`）或 `host.acp`。
- 上面两条写成架构测试（AST 扫描 import），在 S1 加入。
- 测试客户端改动只在 `packages/cli/src/acp-web`。这个目录不属于任何一层，随 HC-203 退役，所以不能把它当成①层的实现参考。

与「上移到平台」的功能（架构文档 §5）的关系：文件树、Git、输入历史本来就不在本任务；会话列表、`@文件`、代码回退，平台以后可以自己做。Harness 的 `session/list`、`resource_link` 读取、`/undo` 仍然保留，因为它们是 Harness 作为 Agent 的原生能力，纯标准客户端（如 Zed）也要用。两边同时存在时由平台决定用哪个，Harness 不需要感知。

本任务完成后要做一次「原有功能覆盖核对」（§23），按同一决策顺序给出每个未覆盖功能的去向。

### 4.3 拓扑（不变）

```text
任意 ACP 客户端（HC-197 通用运行时 / Zed / harness web 浏览器）
        │ stdio：换行分隔 JSON-RPC（harness web 经 Bun 桥转发，桥不解析内容）
        ▼
python -m harness_agent acp
  stdio.py   帧守卫与有序关闭（握手闸门新增在 server.py）
  server.py  ACP 方法 → HostServicePort；发送泵串行发出 session/update
  translate.py / permissions.py / elicitation.py（新）/ sessions.py / commands.py / config.py（新）
        │ HostServicePort（窄接口，§14.1 扩充）
        ▼
AgentHost → RunCoordinator / 审批 / Thread 存储 / Goal / Compose / MCP / 工作区根注册表
```

### 4.4 关键决策（含已放弃的方案）

**D-1：人工交互统一走 `elicitation/create` 表单。**
- 放弃方案 A：自定义 `_harnessCode/interaction/*` 方法。这样 HC-197 必须认识 Harness 的私有方法，违背「平台不识别 Harness 结构」的要求。
- 放弃方案 B：把提问降级成带选项的权限请求。多选、「其他」自由输入、计划反馈文本都表达不了。
- 采用方案：提问、计划确认、Goal 确认、拒绝反馈都转成 JSON Schema 表单。通用客户端只要实现一个表单渲染器，就能覆盖全部四种交互。
- 风险：`elicitation` 在两个 SDK 里都标着 UNSTABLE，以后协议可能改形状。控制办法：全部集中在一个新模块 `host/acp/elicitation.py`（浏览器端对应 `acp-web/client/elicitation.ts`）。协议变化时只改这两处，并在 `ACP通信.md` 记下这项依赖。

**D-2：没有标准方法的用户操作，做成 Agent 宣告的斜杠命令。** 涉及 `/compact`、`/btw`、`/undo`、`/redo`、`/title`、`/goal`、`/abandon`。
- 放弃方案：每个操作一个 `_harnessCode/threads/*` 扩展方法。通用客户端看不到也调不了。
- 采用方案：命令出现在标准 `available_commands_update` 里，任何客户端的补全菜单都能列出来。命令在 `session/prompt` 里被 Agent 拦截执行，不启动模型 Run。执行结果以一段 `agent_message_chunk` 文本告诉用户。声明了 `commands` 扩展的客户端还能在响应 `_meta` 里拿到结构化结果，比如「历史已变化，需要重新加载」。

**D-3：会话列表和标题由 Agent 提供原生数据。** Harness 自己的 SQLite 是这些数据的事实源，`session/list` 和标题都从这里出。如果 HC-195 的云端共享会话以后要在平台层另做聚合，读的也是 Agent 通过 ACP 给出的这份原生数据，不另建第二份。北辰确认前按此实施，见 §21。

**D-4：审批 diff 产出标准 `diff` 内容。** 这是 HC-209 D-5 留给二期的事。v3 `fileDiffPresentation` 新增可选字段 `old_text`、`new_text`（各不超过 256 KiB，超限或二进制时不带）。ACP 权限请求据此附上标准 `diff` 内容。原来的文本兜底只在没有全文时使用。

**D-5：子代理只做「可见」，不做独立会话。** 子代理工具卡作为标准工具卡发出，id 带执行 id 前缀，标题带代理名前缀；子代理的正文累加进父 `task` 卡的输出。挂在哪个父卡下、属于哪个代理，通过 `subagent` 扩展告知。放弃方案：每个子代理映射成一个 ACP 子会话。ACP 没有父子会话的概念，客户端会把它们当成独立对话列出来。

**D-6：版本号不升级，只新增能力名。** 扩展仍是 `version: 1`。新增能力 `sessionSummary`、`commands`、`subagent`、`goal`。老客户端会忽略不认识的能力名（`ext.py` 现有规则），所以这样改是向后兼容的。

**D-7：扩展命名空间保持 `harnessCode`，只服务 Harness。** 放弃方案：设计一份「企业通用扩展规范」让其他 Agent 也实现。企业内其他 Agent 魔改自开源上游，不一定配合我们，不会去实现这份规范，设计了也只有 Harness 一家用。想让所有 Agent 都有的体验，按 [Agent 接入架构](../architecture/Agent接入架构.md) §3 走标准 ACP 或上移到平台。

### 4.5 与其他任务的交界

| 任务 | 交界内容 | 本规格的约定 |
|---|---|---|
| HC-197 通用 ACP 运行时 | 生命周期、能力、扩展 | 平台只需要标准 ACP（§5 的方法表）。`_meta.harnessCode` 是可选的，平台不声明也功能完整。平台要用的 UNSTABLE 能力是 `elicitation.form`，需要在 `clientCapabilities` 里声明；不声明时提问、计划模式、拒绝附反馈都不可用（§8.6）。进程退出码、stderr 只写诊断信息这两条沿用 HC-209。 |
| HC-195 共享会话 | 会话列表、摘要、标题 | 见 D-3。 |
| HC-201 Harness 扩展集成 | Skill/命令、Trace、stderr | 本任务只把「可由用户调用的 Skill」宣告成命令（GAP-28）。Skill 的安装/启用/管理面（GAP-13）、Trace、配置都归 HC-201。stderr 仍只写诊断，本任务不新增 Trace 输出。 |
| HC-206 对话视图复用 | GAP-24 界面发送部分；交互卡片 | 本任务定义 Agent 接收什么内容块（§10）和表单的 schema 形状（§8），HC-206 按这份约定渲染。 |
| HC-203 旧入口退役 | `harness web` 测试客户端改动 | §17 的改动随旧入口一起退役。 |

---

## 5. ACP 方法与能力声明

### 5.1 方法表

| 方法 | 方向 | 现状 | 本任务 |
|---|---|---|---|
| `initialize` | C→A | 已有 | 新增能力声明（§5.2）；握手闸门（§6.1）；惰性导入（§16） |
| `session/new` | C→A | 已有 | `mcpServers`、`additionalDirectories` 生效；响应带 `configOptions`；之后必发命令表 |
| `session/load` | C→A | 已有 | 回放带工具细节；同上 |
| `session/resume` | C→A | 无 | **新增**：续接会话，不回放历史 |
| `session/close` | C→A | 无 | **新增**：释放会话（取消在途 Run、退订、释放会话级 MCP 和目录） |
| `session/list` | C→A | 已有 | 游标分页；`_meta.harnessCode.summary` |
| `session/prompt` | C→A | 已有 | 内置命令拦截；`resource`/`resource_link` 内联；`PromptResponse.usage` |
| `session/cancel` | C→A | 已有 | 同时撤回在途的表单请求 |
| `session/set_mode` | C→A | 已有 | 允许 `plan`（客户端支持表单时） |
| `session/set_config_option` | C→A | 无 | **新增**：`model`、`workflow` |
| `session/update` | A→C | 已有 | 新增子类型 `usage_update`、`plan`、`config_option_update`、`session_info_update`（改名后） |
| `session/request_permission` | A→C | 已有 | 标准 `diff`；拒绝附反馈选项 |
| `elicitation/create` | A→C | 无 | **新增**：提问、计划、Goal、反馈 |
| `$/cancel_request` | A→C | 无 | **新增**：Run 取消时撤回还没回答的表单 |

不实现：`session/delete`（删除会话会影响 HC-195 的共享会话，等平台确定归属后另立任务）、`session/fork`（UNSTABLE）、`authenticate`、`terminal/*`、`fs/*`（Agent 自己读写文件）。

### 5.2 `initialize` 响应的能力

```text
agentCapabilities:
  loadSession: true
  promptCapabilities: { image: false, audio: false, embeddedContext: true }
  mcpCapabilities:    { http: true, sse: false }
  sessionCapabilities:
    list: {}
    resume: {}
    close: {}
    additionalDirectories: {}
  _meta.harnessCode: { version: 1, capabilities: [协商后开启的能力] }   # 只发给声明了扩展的客户端
```

`sse: false` 的原因：Host 的 MCP 客户端目前只接 stdio 和 http，不为 ACP 单独补一种传输。客户端如果传了 sse 服务器，按 §9.3 的规则跳过并记诊断。

---

## 6. 会话生命周期

### 6.1 握手闸门（握手缺陷）

```text
收到任意 session/* 请求
  ├─ 还没收到 initialize                   → -32600 NOT_INITIALIZED（立即）
  ├─ initialize 正在执行                     → 等 initialize 结束
  │     ├─ initialize 成功 → 正常处理
  │     └─ initialize 失败 → -32603 HOST_INIT_FAILED（与 initialize 同因）
  └─ initialize 已成功                       → 正常处理
```

- 用一个 `asyncio.Future` 实现：`initialize` 一进入就创建，结束时 resolve。所有会话方法开头 `await self._ready()`。
- 不变量：**每个带 id 的请求必有且只有一个响应。** 用测试锁定：一次写入 `initialize`、`session/new`、`session/list` 三帧，三个响应都必须到达；`session/new` 的响应要排在 `initialize` 响应之后。
- 实施前先复现：按 §2 第 3 条，先写流水线测试确认现在的真实表现。如果实际是 `-32600` 而不是「不回」，也照样改成上面的行为，并把 HC-209 那条记录更正为实测结果。
- **S0 实测（2026-11-09）**：真实表现是「排队的 `session/*` 请求在 `initialize` 响应之前各回一个 `-32600 NOT_INITIALIZED`」，不是不回响应。触发条件是 `AcpServer._connection` 赋值之前 `ensure_ready()` 真的让出事件循环：进程内测试让 `ensure_ready()` 先 `sleep 0.3s`，三帧流水线稳定得到顺序 `session/new` 错误 → `session/list` 错误 → `initialize` 成功。本机真实路径（echo 与非 echo）里 `ensure_ready()` 全程同步完成、从不让出，`initialize` 先跑完，所以线上暂时观测不到，但冷缓存、慢盘等真实 I/O 让出时窗口就会打开。因此 S1 的测试用「`ensure_ready()` 带延迟的替身 Host」做确定性复现，不依赖真实 Host 的时序。

### 6.2 会话与线程的映射（不变的部分）

- `sessionId` 就是 Python 的 `thread_id`，对外不透明。平台只把它当字符串保存，不解析。
- 一个进程绑定一个工作区，`cwd` 必须解析到同一目录，否则回 `WORKSPACE_MISMATCH`（保持 HC-209 行为）。
- 同一会话同时最多一个 Run，再发 prompt 回 `THREAD_BUSY`（可重试）；不同会话可以并发。

### 6.3 `session/resume` 与 `session/close`

| | `session/load` | `session/resume` | `session/close` |
|---|---|---|---|
| 用途 | 首次打开历史会话 | 断线重连、平台切换查看者后续接（客户端已有历史） | 客户端不再使用该会话 |
| 回放历史 | 是，全部回放完才返回响应 | **否** | — |
| 校验 | cwd、线程存在 | 同 load | 会话属于本连接 |
| 订阅线程事件 | 是 | 是 | 退订 |
| 会话级 MCP/目录 | 按本次请求的列表生效 | 同左 | 释放 |
| 在途 Run | — | 如果线程有本连接遗留的活动 Run，继续向本连接推送；属于其他连接的回 `THREAD_BUSY` | 先取消再释放 |
| 错误 | `THREAD_NOT_FOUND` / `THREAD_BUSY` / `WORKSPACE_MISMATCH` | 同 load | 未知会话静默成功（幂等） |

`session/resume` 是 Task 验收「换查看用户或关闭窗口后恢复，历史回放不重复」在 Agent 侧的落点。真正跨用户接续，要等 HC-196/197 把同一个 Agent 进程交给另一个查看者时才能验证（§19）。

### 6.4 连接断开

保持 HC-209 的顺序：stdin EOF 或信号 → 取消所有 Run → 等响应写出 → 关闭连接。新增两点：还没回答的表单请求一律按「取消」交还给 Host；会话级 MCP 连接随 `Host.close()` 一起收尾。

---

## 7. 运行流与事件翻译

### 7.1 事件顺序（GAP-35）

**要求**：同一个 Run 的事件（`content.delta`、`tool.started`……）和交互请求（`interaction.*`），到达 `AcpServer._sender` 的顺序必须等于 Host 产生它们的顺序。

**做法**：在 Host 一侧解决。同一 Run 的事件扇出与交互请求下发共用一条有序队列，交互请求排队，不能越过前面还没送出的事件。ACP 侧的发送泵本来就是串行的，不需要改。

**S0 结论（2026-11-09，读代码）**：乱序的机制是两条异步路径。事件经 `_emit`（`run_coordinator.py`）只做 `run.events.put_nowait`，再由独立的扇出任务 `_fanout_run_execution`（`agent_host.py`）逐条发给连接；交互请求则在 Run 执行协程里由 `request_interaction`（`run_coordinator.py`）直接 `await` 发送，不经过 `run.events`。`execute()` 先把工具信号放进 `run.events`，紧接着同协程就 `await` 交互，交互帧可能先于还没被扇出任务取走的事件到达 ACP。落点定为：`_CoordinatorLifecyclePort.request_interaction` 与子代理的 `request_child_interaction` 不再直接发送，而是把「交互帧」作为一种队列项放进同一个 `run.events`，由 `_fanout_run_execution` 在轮到它时发送；交互的结果仍由 future 回给等待方。改动规模：中，不动协议和 ACP 泵。

**测试**：脚本化模型先输出一段正文，再调用要审批的工具。断言客户端收到的顺序是：正文 → `tool_call`（pending）→ `request_permission`，跑 200 次不能有一次乱序。

### 7.2 稳定调用 id（GAP-23）

- Host 保证每条审批请求的每个动作都带 `tool_call_id`。HC-209 已经在预检回调里加过，本任务要补齐还缺的路径，比如批量审批里的第二个以后的动作、子代理审批。
- `translate.py` 删掉「同名 + 参数相同」的降级匹配（`_match_by_args`）。审批找不到对应工具卡，只剩一种合法情况：工具卡还没开始流式输出。这时用同一个 id 先建卡，后续 `tool.started` 复用这张卡，不会出现第二张。
- 兜底卡 `approval:{request_id}` 只留给不对应任何工具调用的交互，比如目录信任。

### 7.3 子代理（GAP-16、GAP-34）

```text
子代理事件（带 parent_execution_id）
  ├─ tool.started / tool.delta / tool.completed
  │    → 标准 tool_call / tool_call_update
  │      toolCallId = "{runId}:{executionId}:{toolCallId}"
  │      title      = "{代理名}：{工具标题}"
  │      _meta.harnessCode.parent = {toolCallId: 父 task 卡 id, agentId, executionId}   # 仅 subagent 扩展
  ├─ content.delta（子代理正文）
  │    → 累加进父 task 卡的 content（替换语义，累计上限 64 KiB，与工具输出一致）
  ├─ reasoning.delta → 丢弃（保持现状，避免噪声）
  └─ 子代理审批 → 挂到上面那张子代理工具卡（GAP-34），不再建兜底卡
```

前提：子代理事件要能定位到「是哪次 `task` 工具调用派生了它」。

**S0 结论（2026-11-09，读代码）**：事件信封（`AgentEvent`）没有 `parent_tool_call_id`，`parent_execution_id` 指向父 execution 而不是工具卡。但 `AgentDelegator` 在子代理启动前，会向父 `task` 工具卡发一条 `tool.delta {tool_call_id, child_execution_id, child_agent_id}`（`agent_delegation.py`），这就是现成的「父工具卡 ↔ 子 execution」绑定。子代理审批的动作里已经带子代理自己的 `tool_call_id`，信封里带子代理的 `execution_id`，所以 ACP 侧能直接算出子代理工具卡 id。**决定：不改 Host 事件信封**，`translate.py` 记住 `child_execution_id → 父 task 工具卡 id` 这一份翻译所需的临时映射（属于 §4.1 第 3 条允许的翻译映射），用它填 `_meta.harnessCode.parent` 并把子代理正文累加进父卡。极端情况下没收到绑定事件，则子代理卡照常显示，只是不挂到父卡下、不带 `parent`（可见但不挂卡）。放弃的方案：在信封里新增 `parent_tool_call_id`——能做（小改动），但会动 Host 事件结构且 TUI 用不上，没必要。§14.3 第 2 条里「子代理事件信封带 `parent_tool_call_id`」相应删除。

### 7.4 用量（GAP-07 用量部分）

| 来源 | 输出 | 条件 |
|---|---|---|
| `context.updated` | `usage_update {used: estimated_tokens, size: context_window_tokens}` | 两个字段都是整数才发；值和上次相同时不重复发 |
| `run.completed.usage` | `PromptResponse.usage {inputTokens, outputTokens, cachedReadTokens, totalTokens}` | 总是带（UNSTABLE 字段，客户端不认识会忽略） |
| `run.completed`（整份） | `_meta.harnessCode.run` | `runSummary` 扩展（保持现状） |

`/compact` 执行完也补发一次 `usage_update`（§11.3）。

### 7.5 工作区外文件的位置（GAP-26）

`PathLocator` 改成通过 Host 解析路径：`HostServicePort.resolve_display_path(raw, *, tool_name) -> str | None`，Host 用 `WorkspaceRootRegistry` 的只读视图、按与 `WorkspacePathPolicy.validate_direct_path` 完全相同的语义解析。只要路径落在已授权的根里（primary、session、project、user），就产出绝对路径的 `locations`；越界、未信任、无法解析的返回 `None`，不产出位置也不报错。本 Run 的一次性授权没有 run 上下文，不在此列。（S2 实施时由原设想的 `workspace_roots()` 改定：注册表类型属于 `policy.*`，不能出现在 `host/acp/` 的 import 里，所以由 Host 解析、只把结果字符串交出来。）

### 7.6 Compose 与 Goal 进度

| 来源 | 输出 |
|---|---|
| `compose.progress.stages` | 标准 `plan` 更新：每个阶段一条，`content` = 阶段中文名，`status`：pending → `pending`，current → `in_progress`，confirmed/skipped → `completed`，failed → `completed` 并在名称后加「（失败）」。`priority` 一律 `medium` |
| `compose.summary` | 一段 `agent_message_chunk`，`messageId = "{runId}:compose-summary"` |
| `goal.changed` / `goal.evaluation` | 没有 Compose 活动时，把 Goal 的判定条件发成标准 `plan` 更新（满足 → `completed`，检查中 → `in_progress`，其余 → `pending`）。完整的 Goal 投影走 `session_info_update._meta.harnessCode.goal`（`goal` 扩展） |

同一时间只有一份 `plan`。Compose 进行中时以 Compose 阶段为准，Goal 状态只通过扩展发出。

---

## 8. 人工交互

### 8.1 审批（GAP-06、GAP-30、GAP-38）

在 HC-209 映射的基础上做三处变化：

1. **标准 diff**：presentation 带 `old_text`/`new_text` 时，权限请求的 `toolCall.content` 改成 `[{type: "diff", path: 绝对路径, oldText, newText}]`。新建文件 `oldText = null`，删除文件 `newText = ""`。没有全文（超过 256 KiB）时，退回现在的 Markdown 文本兜底。单帧上限沿用 `_fit_update` 的规则，超限时先去掉 diff 改用文本兜底。
2. **允许范围**：选项名称保持「本会话内总是允许」「本项目内总是允许」。声明了 `approval` 扩展时，每个 `PermissionOption._meta.harnessCode.scope` 分别为 `"once" | "thread" | "project"`。ACP 的 `kind` 不变，因为标准 `kind` 粒度只到 once/always，这一项用名称加扩展来关闭。
3. **原始请求**：`approval` 扩展下 `toolCall._meta.harnessCode.approval.requests` 带 v3 原样的 `requests`。序列化后超过 256 KiB 就不带，改为 `requestsTruncated: true`。

### 8.2 拒绝并说明原因（GAP-05）

```text
审批的 decisions 含 reject_with_feedback 且客户端声明了 elicitation.form
  → 选项里多一个 {optionId: "reject_with_feedback", kind: "reject_once", name: "拒绝并说明原因"}
用户选了它
  → Agent 立即发 elicitation/create：
      message: "请说明拒绝原因，Agent 会据此调整"
      schema:  {feedback: string, 必填, maxLength 4000}
  ├─ accept → resolve_interaction(decision="reject_with_feedback", feedback=文本)
  └─ decline / cancel / 断开 → resolve_interaction(decision="reject")
```

客户端没声明表单能力时不提供这个选项（保持现状）。

### 8.3 提问（GAP-01）

`interaction.question` 的一组问题合成一张表单：

| v3 问题字段 | 表单属性 `q_{序号}` |
|---|---|
| `multi_select = false` | 单选：`type: string`，`oneOf: [{const: value, title: label}]` |
| `multi_select = true` | 多选：`type: array`，`items.anyOf: [{const, title}]` |
| `allow_other = true` | 再加一个可选文本属性 `q_{序号}_other`，标题「其他（可选）」 |
| `header` / `question` / `body` | 属性 `title` = header 或 question，`description` = body |
| `options[].description` | 拼进 `description`，每行「label：description」 |

- `message` = 第一个问题的 `question`；有多个问题时为「Agent 有 N 个问题需要你回答」。
- 所有选择题都是必填，`_other` 选填。
- 回答映射：`answers[question.id]` = 选中的 value 列表，加上非空的 `_other` 文本。accept 时 resolve；decline/cancel 时用 `fail_interaction` 交还 Host（Host 按「用户未回答」把结果告诉模型），不返回空答案。
- 属性名用序号而不用 `question.id`，因为 id 可能含 JSON Schema 不允许的字符。序号到 id 的映射保存在 ACP 侧的待回答表里。

### 8.4 计划确认（GAP-02）

```text
interaction.plan
  → elicitation/create
      message: "请确认执行计划（{plan_display_path}）\n\n{plan_markdown，最多 16 KiB，超出截断并注明}"
      schema:
        decision: string 必填，oneOf 只列 payload.decisions 里有的值：
                  approved「批准并开始执行」 / revise「需要修改」 / abandoned「放弃」
        feedback: string 选填，maxLength 4000，title「修改意见」
  ├─ accept → resolve(decision, feedback)
  └─ decline / cancel → resolve(decision="abandoned")
```

批准后 Host 会把审批模式从 `plan` 切回进入计划前的模式。这次模式变化通过 §9.1 的回流机制发出 `current_mode_update`。

### 8.5 Goal 确认（GAP-03）

```text
interaction.goal
  → elicitation/create
      message: "确认目标：{objective}\n假设：…（每行一条）"
      schema:
        decision: oneOf（只列 payload.decisions 里的）accepted「接受」/ edited「修改判定条件后接受」/ rejected「拒绝」
        criteria: string 选填，多行，default = 原判定条件逐行拼接，title「判定条件（每行一条）」
        feedback: string 选填，maxLength 4000
  ├─ accept + edited → criteria 按行切分、去空行；切完为空或超过 32 条 → 当作 rejected，并在 feedback 里注明原因
  ├─ accept + 其他 → 原样 resolve
  └─ decline / cancel → resolve(decision="cancelled")
```

### 8.6 客户端不支持表单时

| 交互 | 行为 |
|---|---|
| `interaction.question` | `open_connection` 的 `interaction_handles` 不包含 `question`。Host 收到模型的提问调用时，向模型返回明确的「当前客户端不支持提问，请自行决定或在回复中说明」，不再是空答案（§14.3） |
| `interaction.plan` | 不暴露 `plan` 模式；`set_mode("plan")` 回 `UNKNOWN_MODE` |
| `interaction.goal` | `/goal` 不出现在命令表；直接输入 `/goal …` 当普通文本 |
| `interaction.plugin_consent` | 本任务不做，一律 fail-closed（插件安装属于 HC-201 管理面） |

### 8.7 表单的取消与断开

- `session/cancel` 或 Run 终止时，对还没回答的表单发 `$/cancel_request`，并按「取消」交还 Host。之后客户端再回答，直接丢弃。
- 表单不设超时，与审批一致：用户可能离开几分钟。断开由连接关闭驱动。
- 同一 Run 同时最多一个表单在等回答（Host 的交互本身是串行的）。万一出现第二个，排队等前一个结束，不并发弹出。

---

## 9. 会话配置

### 9.1 审批模式（GAP-02、GAP-31）

- 客户端声明了 `elicitation.form` 时，`availableModes` 是五项：`plan`「先出计划」、`default`、`auto-edit`、`auto`、`yolo`；没声明时仍是四项。配置默认值是 `plan` 但客户端不支持表单时，回退 `default`（保持现状）。
- **模式回流**：Host 新增「线程审批模式已变化」通知（§14.3），覆盖三种来源：计划批准后自动切换、Run 内的模式提交、其他连接修改。`AcpServer` 收到后更新会话登记，模式确实变了才发 `current_mode_update`。`set_session_mode` 自己引起的变化只发一次，不因回流重复发。

### 9.2 配置项：模型与工作模式（GAP-08、GAP-04）

`session/new`、`load`、`resume` 的响应带 `configOptions`，变化时推 `config_option_update`（整份）。

| id | 类型 | category | 选项 | 生效方式 |
|---|---|---|---|---|
| `model` | select | `model` | 模型目录里的 Profile（`picker_summary` 的 id 和名称），当前值 = 线程最近一次请求的选择，没有就用默认 Profile | 写入会话登记；下一次 prompt 的 `StartRunRequest.requested_primary_profile`。Run 进行中修改只影响下一轮 |
| `workflow` | select | `{"id": "harness.workflow"}`（自定义类别，ACP 允许） | `build`「直接执行」、`compose`「分阶段协作」 | 下一次 prompt 的 `StartRunRequest.mode` |

- 模型目录为空或配置有错：不出现 `model` 项（不宣告空开关）。
- **没有「模型锁定」**（S0 结论，2026-11-09，读代码）：模型选择在 Host 里是每次 Run 的请求参数（`StartRunRequest.requested_primary_profile`），Run 受理时才固化绑定，有历史 Run 也允许换（`resolve_execution_binding` 没有这类拒绝分支，`tests/host/test_server.py` 有「同一 Thread 后续 Run 立即采用新主模型」的测试）；TUI 的 `/model` 同样只改客户端状态，随下一次 `run.start` 下发。所以原先设想的 `MODEL_SELECTION_LOCKED` 错误**删除**，`set_config_option(model)` 在 Run 进行中也直接接受，只影响下一轮（上面表格已写明）。
- **能力前提**：Host 只在连接协商了 `models.select` 时才接受非空的 `requested_primary_profile`（否则回 `-32002 MODELS_SELECT_CAPABILITY_REQUIRED`）。现在 `initialize` 里 `open_connection` 的能力只有 `run.multithread`、`run.cancel`、`threads.read`，S4 要把 `models.select` 加进去（模型目录为空时 `model` 项本来就不出现，不冲突）。
- 仅存的「不可热切换」是旧版（v5）线程绑定，只在连接没协商 `models.select` 时才会出现；ACP 连接协商了该能力，所以不会遇到。
- 未知 `configId` 或值：`-32602 UNKNOWN_CONFIG_OPTION` / `INVALID_CONFIG_VALUE`。
- `direct_shell` 不暴露（TUI 专有）。

### 9.3 会话级 MCP（GAP-21、GAP-27）

```text
session/new|load|resume 的 mcpServers
  → 逐个转成 McpServerConfig（stdio：command/args/env；http：url/headers）
     ├─ sse 类型 / 字段不合法 → 跳过，记诊断 acp.session.mcp_rejected
     ├─ 与配置文件里的服务器同名 → 跳过（配置文件优先），记诊断
     └─ 合法 → 加入该会话的 MCP 集合
  → 该会话后续 Run 的工具集 = 配置文件里的 MCP + 会话 MCP
```

- 复用 `McpConnectionManager` 和现有的 engine 指纹机制：会话 MCP 集合的指纹参与 Agent engine 的身份计算，不同 MCP 集合的会话互不影响。
- **S0 结论（2026-11-09，读代码）**：MCP 集合已经通过 `McpConfigSnapshot.digest` 进入 engine 指纹（`AgentEngineProfile.mcp_config_fingerprint`），`McpConnectionManager` 也已按 digest 存多份运行时并用租约借用，所以「会话 MCP 靠指纹隔离」可行。唯一的切入点是 `AgentHost._resolve_agent_engine_spec`（以及子代理 spec 的同类位置）：它现在硬取 Host 全局的 `self._mcp_snapshot` 和 `self._mcp_manager.get_tools()`。做法：`AgentHost` 记 `thread_id → 会话 MCP 快照`；`_resolve_agent_engine_spec` 增加可选的快照覆盖，合并配置文件/插件/会话三组服务器后重新算快照；**工具列表也必须取自对应快照的运行时，不能再取全局 manager**（最容易漏的点）。同名冲突沿用 `_combine_mcp_snapshot` 的「先到者优先并记 warning」规则，配置文件优先。`session/close` 和连接断开必须退役该会话的 owner，否则 stdio 子进程会泄漏。风险：每个会话一份快照会让 engine 池的 profile 数增加（受 `max_profiles` 限制）。
- 不落库：ACP 规定 load/resume 会重新传完整列表，所以每次请求都按本次列表生效。
- 连接失败不影响会话创建（与配置文件里的 MCP 行为一致）。失败原因进诊断日志。
- 安全：客户端就是启动 Agent 的本地进程，可信度与命令行参数相同。诊断里只记服务器名、类型和数量，绝不记 command、env、headers（可能含密钥）。

### 9.4 附加目录（GAP-27）

- `additionalDirectories` 的每一项都必须是绝对路径、存在、是目录，并且通过 `WorkspaceRootRegistry` 的可信校验（不能是文件系统根、家目录或系统目录）。任意一项不合格，整个请求回 `-32602 INVALID_ADDITIONAL_DIRECTORY`，`data.path` 带出这一项。
- 合格的目录以 `session` 作用域登记到注册表，只对这个会话的 Run 生效。`session/close` 或连接关闭时撤销。
- load/resume 传的列表是完整列表：先撤销该会话旧的会话级根，再登记新的。
- `session/list` 不回报 `additionalDirectories`，因为它不落库。
- 诊断事件 `acp.session.directories`：记数量和结果，不记路径原文（路径可能含用户名，按现有脱敏规则处理）。

---

## 10. Prompt 输入：文件内容（GAP-24 接收侧）

| 内容块 | 处理 |
|---|---|
| `text` | 原样 |
| `resource_link`（`file://` 且落在已授权根内） | Agent 读文件，按 HC-166 的预算（单文件 10 KB、单轮合计 20 KB，超出降级为占位）内联成 HC-166 的「Attached Context Block」，放在正文前面 |
| `resource_link`（其他 scheme 或根外路径） | 保持 `@uri` 文本，不读取 |
| `resource`（嵌入资源，`text` 形式） | 内容由客户端给出，按同样的预算和格式内联；`blob` 形式回 `UNSUPPORTED_CONTENT_BLOCK` |
| `image` / `audio` | `UNSUPPORTED_CONTENT_BLOCK`（不变） |

- 预算和格式与 TUI 侧 `mention-resolver.ts` 保持一致：Python 实现一份同样的规则，用双端漂移测试锁定格式相同。
- 写进 Transcript 的用户消息是用户的原始文本加 `@路径`，不是内联后的全文，和 TUI 一致。内联块只进入模型输入。

---

## 11. Agent 命令

### 11.1 命令表的来源与推送

```text
命令表 = 内置命令（§11.3，按客户端能力筛选）
       + Plugin/Qwen 命令（现有）
       + 可由用户调用的 Skill（skill:<id>，GAP-28）
名称冲突：内置 > Plugin > Skill；被挤掉的条目不宣告，记诊断
```

- `session/new`、`load`、`resume` 的响应发出后，**一定**推一次 `available_commands_update`，表为空也推（性能优化 1）。
- 命令表变化时（Host 的 Skill/Plugin catalog 变了，连接重新绑定），向本连接所有会话重发。客户端按最新一次整表替换（GAP-37 晚到）。

### 11.2 Skill 斜杠入口（GAP-28）

- Host 的命令快照纳入 `user_invocable` 的普通 Skill：名称 `skill:<id>`，描述取 Skill 的 description，参数提示取 argument-hint，并参与 `bind_commands` 绑定。Host 现有 `RequestedSkill` 校验能否接受这类条目，Plan 阶段先核实；如果不能，在 Host 侧放宽，不在 ACP 侧绕开。
  - **S0 结论（2026-11-09，读代码）**：命令快照现在只收 `kind=="command"` 的 Plugin/Qwen 命令（`SkillRegistry.agent_commands()`，`plugin_skills.py`），不含普通 Skill。`bind_commands` 校验的是 (id, 名称) 集合，要求与快照完全一致。`RequestedSkill` 校验对 `kind=="skill"` 只查 `user_invocable`，不要求 raw_invocation。所以 Host 侧唯一的改动是 `agent_commands()` 追加「启用且 `user_invocable` 的 `kind=="skill"`」条目，`bind_commands` 与 `RequestedSkill` 校验都不用改。
- `commands.py` 里关于 `/skill:<id>`「S2 不做」的限制删除。**S0 修正**：Skill 的完整 id 形如 `{来源}/{名称}`（例如 `project/review`），里面带 `/`，而 `parse_slash` 的名称正则是 `[^\s/]+`，`/skill:project/review` 会被截成名称 `skill:project` 加参数 `/review`，所以命令名不能直接用完整 id。命令名用 `skill:<id 末段>`（例如 `skill:review`）；末段重名时改用 `skill:<完整 id 把 / 换成 :>`（例如 `skill:project:review`）。`CommandSpec` 里仍记完整 id，供 `RequestedSkill` 使用。TUI 里的 `/skill:<id>` 只是菜单标签（选中后「武装」该 Skill，下一条普通消息才带 `requested_skill`），不是可解析的命令；ACP 里用户输入 `/skill:review 参数` 时由 Agent 拦截，转成带 `requested_skill={id, args}` 的普通 Run。

### 11.3 内置命令

所有内置命令都在 `session/prompt` 里被拦截：不启动模型 Run，用户输入的命令文本不写进 Transcript。响应的 `stopReason` 都是 `end_turn`，失败时回 JSON-RPC 错误。执行结果用一段 `agent_message_chunk` 告诉用户，`messageId = "cmd:{uuid}"`，不入历史。

| 命令 | 参数 | 执行 | 给用户的文本 | `commands` 扩展的响应 `_meta.harnessCode.command` |
|---|---|---|---|---|
| `/compact` | 无 | Host `compact_thread`；线程忙回 `THREAD_BUSY` | 「已压缩上下文：约 A → B tokens」 | `{name: "compact"}`，并补发 `usage_update` |
| `/btw <问题>` | 必填 | Host `side_question`，只读、不用工具、不落库 | 答案原文 | `{name: "btw", ephemeral: true}`；那段消息 chunk 也带 `_meta.harnessCode.ephemeral: true` |
| `/undo [both\|code\|conversation]` | 默认 `both`；不是 Git 仓库时 `both` 只回退对话，`code` 回 `WORKSPACE_NOT_GIT_REPOSITORY` | Host `undo_thread`；目标是 `list_turns` 里最近一个未回退的用户回合 | 「已回退第 N 轮，恢复 X 个文件。重新打开会话可看到回退后的历史」 | `{name: "undo", historyChanged: true}` |
| `/redo` | 无 | Host `redo_thread` | 「已重做，恢复 X 个文件」 | `{name: "redo", historyChanged: true}` |
| `/title <标题>` | 必填 | Host `set_thread_title`；成功后对本会话发 `session_info_update`（标准），其他连接由 `thread.summary` 广播得知 | 「已改名为：…」 | `{name: "title"}` |
| `/goal <目标>` | 有参数时提交目标 | Host `goal_request`，然后按 Host 返回的处置启动 `GoalProposalRunInput` Run（这时会真的跑模型，并走 §8.5 的确认） | 由 Run 自己输出 | `{name: "goal"}` |
| `/goal pause\|resume\|clear\|edit [说明]` | 子命令 | Host `goal_mutate`（`edit` 为 `goal_request` 的 amend） | 「目标已暂停/已恢复/已清除」 | `{name: "goal", goal: 投影}` |
| `/goal` | 无参数 | Host `goal_inspect` | 当前目标与判定条件摘要 | 同上 |
| `/abandon` | 子命令 | Host `compose_abandon` | 「已放弃当前 Compose 进度，对话保留」 | `{name: "abandon"}` |

- 命令文本和行为对齐 TUI 现有的同名命令。**S0 核对（2026-11-09，读 `packages/cli`）**：`/compact`、`/btw`、`/redo`、`/title` 与上表一致。`/undo` 在 TUI 里没有参数形式，是打开历史回合选择器、再选 `both`/`conversation`/`code`；ACP 没有选择器，所以 `/undo [both|code|conversation]` 是 ACP 新增的参数形式，目标固定为最近一个未回退的用户回合（TUI 另有别名 `rewind`、`rollback`，ACP 不做）。`/goal` 的子命令除 `pause`、`resume`、`clear` 外还有 `edit [说明]`。TUI 没有 `/compose`，放弃 Compose 的命令是 `/abandon`（TUI 另有 `/new-work <目标>`，不在本任务范围，留给 S7 核对）。
- `/goal` 只在客户端支持表单时宣告（§8.6）。其余命令总是宣告。
- 用户接受目标后，同一轮 `session/prompt` 先不返回。确认 Run 的终态里若有 `goal_continuation`，接着启动 `GoalContinuationRunInput`，Run 编号用 `continuation_id`。`/goal resume` 带回续跑时，先回复「目标已恢复」，再在同一轮里启动这次续跑。取消、失败，或变更还在排队，都不再接着跑。
- `/undo`、`/redo` 之后，通用客户端看到的仍是旧时间线，直到用户重新打开会话；测试客户端收到 `historyChanged` 会自动重新 `session/load`（§17）。ACP 没有「历史已重置」的标准通知，这是有意的取舍。

### 11.4 命令的扩展字段（GAP-37）

`commands` 扩展下，每个 `AvailableCommand._meta.harnessCode = {id, source: "builtin" | "plugin" | "skill", requestedSkillId?, pluginId?}`。客户端可以据此区分来源，也能区分与自己内置命令同名的条目。

---

## 12. 会话列表与回放

### 12.1 分页（GAP-33）

- 每页 50 条。游标 = `base64url(JSON {u: updated_at_ms, t: thread_id})`，对客户端不透明。
- 下一页条件：`updated_at_ms < u OR (updated_at_ms = u AND thread_id > t)`，排序不变。
- 还有下一页才带 `nextCursor`。
- 游标解不开或字段不合法：回 `-32602 INVALID_CURSOR`。现在的做法是收到游标就回空列表，这一行为删除。
- `cwd` 不是本工作区：回空列表（保持现状）。
- 持久层新增 `list_threads_page(limit, after)`，原来的 `list_threads(limit)` 保留给 v3 处理器。

### 12.2 会话摘要（GAP-36）

`sessionSummary` 扩展下 `SessionInfo._meta.harnessCode.summary = {createdAt: ISO, messageCount, firstMessage, latestMessage}`。两段消息都单行化并截到 200 字符。不声明扩展时保持标准字段。

### 12.3 回放（GAP-22、GAP-32）

- Host 的 `open_thread` 消息里，tool 记录新增 `tool_call_id`、`arguments`（序列化后最多 256 KiB，超出不带）和 `status`（`completed` / `failed`）。**S0 结论（2026-11-09，读代码）**：成功/失败状态已经写进 Transcript 了——`run_execution.py` 把工具消息的 error 状态写成 `tool_status`，`thread_persistence.py` 落库时写入记录 JSON 的 `status` 字段（缺省为 `success`）。丢失发生在读出时：`ThreadMessage` 没有状态字段，`_thread_message_from_transcript` 与 `_thread_message_payload` 都只投影 kind/content/tool_name/created_at_ms。所以**不需要补记，也不改 SQLite 表结构**：只要给 `ThreadMessage` 加 `tool_status`，从记录的 `status` 读出（`success`→`completed`，`error`→`failed`），再随 v3 `threadMessage` 的 `status` 发出。旧数据本来就带默认值，不需要迁移。
- 回放的工具卡带 `rawInput`、按参数生成的标题（`tool_title(name, args)`）、`kind`、`locations` 和真实状态。id 仍是 `{sessionId}:h{下标}`，同一份历史每次回放 id 都一样。
- **大历史**：ACP 规定 `session/load` 要在响应前推送完整历史，所以不做分页，也不截断。改为设耗时预算：5000 条消息的线程从收到 `load` 到响应完成不超过 1.5 秒（本机测量）。超预算时先优化读取，比如只读回放需要的列，不改协议语义。GAP-32 里「分页」这一半按「ACP 语义不允许」关闭，需要用户确认（§21）。
- 改名后：`session_info_update` 的发送沿用 `thread.summary` 广播路径（GAP-39 的标准部分）。

---

## 13. 扩展协商（`ext.py` 与 `acp-web/ext.ts`）

| 能力名 | 状态 | 打开后多出来的字段 |
|---|---|---|
| `approval` | 已有，扩充 | `toolCall._meta.harnessCode.approval`（原有）+ `requests` / `requestsTruncated` + 选项上的 `scope` |
| `runSummary` | 已有 | `PromptResponse._meta.harnessCode.run` |
| `sessionSummary` | 新增 | `SessionInfo._meta.harnessCode.summary` |
| `commands` | 新增 | `AvailableCommand._meta.harnessCode`；内置命令响应的 `_meta.harnessCode.command`；`/btw` 消息 chunk 的 `ephemeral` |
| `subagent` | 新增 | 子代理工具卡的 `_meta.harnessCode.parent` |
| `goal` | 新增 | `session_info_update._meta.harnessCode.goal` |

规则沿用 HC-209：所有出站的 `harnessCode` 字段只能从 `ext.py` 的出口函数产出；没声明的连接一个字节也不出现，用递归扫描测试锁定；Python 和 TypeScript 两边的能力名常量用漂移测试锁定一致。

---

## 14. Host 侧改动

### 14.1 `HostServicePort` 新增的服务方法

按 HC-209 D-1 的做法，从 `_handle_*` 抽出显式接收 `conn` 的服务方法，v3 处理器变成薄壳。只抽下表列出的方法：

| 服务方法 | 来源处理器 | 用途 |
|---|---|---|
| `compact_thread(conn, thread_id)` | `_handle_context_compact` | `/compact` |
| `side_question(conn, thread_id, question, model_profile_id)` | `_handle_threads_side_question` | `/btw` |
| `undo_thread(conn, thread_id, target_turn_id, mode)` / `redo_thread(conn, thread_id)` / `list_turns(conn, thread_id)` | 同名处理器 | `/undo`、`/redo` |
| `set_thread_title(conn, thread_id, title)` | `_handle_threads_set_title` | `/title` |
| `list_models(conn, thread_id)` | `_handle_models_list` | `model` 配置项 |
| `goal_inspect` / `goal_request` / `goal_mutate`（各带 `conn`） | 同名处理器 | `/goal` |
| `compose_abandon(conn, thread_id, reason)` | `_handle_compose_abandon` | `/abandon` |
| `list_threads_page(limit, after)` | 新增 | §12.1 |
| `resolve_display_path(raw, *, tool_name)` | 新增（Host 用注册表只读视图解析显示路径） | §7.5 |
| `workspace_roots()` | 新增（注册表只读视图；S4 校验附加目录时再定是否需要） | §9.4 |
| `set_session_roots(conn, thread_id, directories)` / `set_session_mcp(conn, thread_id, servers)` | 新增 | §9.3、§9.4 |

服务方法体内禁止读取 `_current_connection`，沿用 HC-209 的 AST 测试来检查。

### 14.2 v3 协议的增补（`protocol_v3.json` 与生成代码）

| 位置 | 变化 | 原因 |
|---|---|---|
| `fileDiffPresentation` | 新增可选字段 `old_text: string \| null`、`new_text: string \| null`（各不超过 256 KiB） | D-4 |
| `threadMessage`（tool 记录） | 新增可选字段 `tool_call_id`、`arguments`、`status` | §12.3 |
| notifications | 新增 `thread.approval_mode {thread_id, mode}`，只发给协商了 `run.approval_mode` 的连接 | §9.1 |

`packages/protocol` 的生成代码按现有生成流程同步更新。TUI 会忽略这些新增的可选字段，行为不变。

### 14.3 Host 行为的改动

1. 同一 Run 的事件与交互共用一条有序下发路径（§7.1）。
2. 审批动作一律带 `tool_call_id`（§7.2）。子代理不改事件信封，翻译层用 `tool.delta` 里的 `child_execution_id` 绑定关系定位父卡（§7.3）。
3. 计划批准后切换模式、Run 内提交模式、其他连接改模式，都广播 `thread.approval_mode`（§9.1）。
4. 连接的 `interaction_handles` 里没有 `question` 时，提问工具向模型返回明确错误，不再给空答案（§8.6）。
5. `ThreadMessage` 读出 Transcript 里已有的工具成功/失败状态（§12.3），不新增补记。
6. 命令快照纳入用户可调用的 Skill（§11.2）。
7. `initialize` 里 `open_connection` 的能力增加 `models.select`（§9.2），否则 Host 拒绝非空的 `requested_primary_profile`。

---

## 15. 错误语义（新增部分）

| 场景 | JSON-RPC code | `data.code` | retryable |
|---|---|---|---|
| 未握手就发会话请求 | -32600 | `NOT_INITIALIZED` | 否 |
| 握手失败后到达的会话请求 | -32603 | `HOST_INIT_FAILED` | 是 |
| 游标非法 | -32602 | `INVALID_CURSOR` | 否 |
| 附加目录不合格 | -32602 | `INVALID_ADDITIONAL_DIRECTORY`（`data.path`） | 否 |
| 未知配置项或值 | -32602 | `UNKNOWN_CONFIG_OPTION` / `INVALID_CONFIG_VALUE` | 否 |
| 内置命令参数缺失或非法 | -32602 | `INVALID_COMMAND_ARGUMENTS` | 否 |
| 内置命令时线程忙 | -32603 | `THREAD_BUSY` | 是 |
| `/undo` 没有可回退的回合 | -32602 | `NOTHING_TO_UNDO` | 否 |
| `/redo` 不在回退状态 | -32602 | `THREAD_NOT_IN_REVERTED_STATE`（沿用 Host） | 否 |
| `/undo code` 但不是 Git 仓库 | -32602 | `WORKSPACE_NOT_GIT_REPOSITORY`（沿用 Host） | 否 |
| 嵌入资源为 blob | -32602 | `UNSUPPORTED_CONTENT_BLOCK`（不变） | 否 |

Host 抛出的稳定错误码，一律经 `to_request_error` 这一个出口映射，不在各个命令里各写一套。

---

## 16. 性能

| 项 | 做法 | 目标（本机、用户真实配置、5 次取中位数） |
|---|---|---|
| 1 空命令表等待（0.5s） | §11.1 总是推命令表 | 浏览器不再等满 `settleCommandsMs` |
| 2 `session/list`（约 0.6s） | 先打点定位：SQLite 打开、Thread 存储初始化、查询，三段分别计时；按结果优化，比如把打开存储挪到 `initialize` 的并行段，或给查询补索引 | ≤ 0.1s（200 个线程的库） |
| 3 Python 冷启动 + `initialize`（1.3–1.5s） | `harness acp` 路径惰性导入：langchain、provider、MCP 适配等模块推迟到第一次 prompt 或第一次需要时再导入；`initialize` 只做配置读取和必需的快照 | 从进程启动到 `initialize` 响应 ≤ 0.6s |
| 合计 | — | 打开 `harness web` 到能输入 ≤ 1.6s（原约 2.9s） |

- 用一个可重复的测量脚本（放在 `packages/agent/tests/support/` 或 `scripts/`，由 Plan 定）记录每段耗时，结果写回 `ACP通信.md` 的性能基线表。
- 惰性导入不能改变行为：配置错误仍在 `initialize` 阶段通过 `startup_error` 反映，不推迟到第一次 prompt。
- 达不到目标时，记录实测数据和瓶颈，交给用户决定，不为了凑数字改变语义。
- 不在本任务内：Bun 桥 409 重试间隔（450ms → 150ms），那是旧 Web 刷新路径的问题，不属于 Agent。

---

## 17. 测试客户端（`harness web`）改动

用户已授权修改，作用只是验收。改动限于 `packages/cli/src/acp-web/` 和 `InteractiveController` 必需的接入点，不改 `apps/`、`packages/workbench-*`。

| 能力 | 客户端改动 |
|---|---|
| 声明 | `initialize` 声明 `elicitation.form: {}`，扩展能力加上 `sessionSummary`、`commands`、`subagent`、`goal` |
| 表单 | 新增 `acp-web/client/elicitation.ts`：按 schema 识别出提问、计划、Goal、反馈四种表单，转成控制器已有的提问卡、计划确认卡、Goal 卡、拒绝反馈输入。认不出的 schema 用通用表单兜底渲染 |
| 用量 | `usage_update` → 现有上下文用量指示 |
| 配置项 | `configOptions` / `config_option_update` → 现有模型选择器与工作模式切换 |
| `plan` | `plan` 更新 → Compose 阶段条（已有组件） |
| 会话列表 | 按 `nextCursor` 翻页；显示 `summary` 里的条数和预览 |
| 命令 | 动态命令表（整表替换）；`historyChanged` → 重新 `session/load`；`ephemeral` 消息按旁注样式显示 |
| 子代理 | 按 `parent` 把子代理工具卡缩进挂在父卡下面 |
| 缺口提示 | 关闭的缺口删掉对应的 GAP 提示文案 |

TypeScript 改动遵守 AGENTS 的双端覆盖要求：每项都有 `packages/cli/tests/acp-web/` 下的单测。

---

## 18. 测试策略

### 18.1 命令

```text
cd packages/agent && .venv/bin/python -m pytest -q tests/host/acp     # ACP 层
cd packages/agent && .venv/bin/python -m pytest -q tests/host         # Host 服务面重构门槛
cd packages/cli   && npm run test && npm run typecheck                # 测试客户端
npm run project:check && npm run check:boundaries                     # 项目级
```

全库测试按用户要求留给 HC-204 统一执行。本任务每个停点只跑上面这些与改动相关的套件。

### 18.2 必测清单

| 类别 | 用例 |
|---|---|
| 握手 | 流水线三帧都有响应；未握手回 `NOT_INITIALIZED`；握手失败后的排队请求回 `HOST_INIT_FAILED` |
| 生命周期 | resume 不回放；close 取消在途 Run 并释放资源；重复 close 幂等；resume 别的连接的活动线程回 `THREAD_BUSY` |
| 顺序与 id | §7.1 的 200 次顺序测试；同名同参连续两次调用各有一张卡且审批挂对；子代理审批挂在子代理卡上 |
| 交互 | 四种表单的 schema 形状快照；accept/decline/cancel 各自的映射；Run 取消时发出 `$/cancel_request` 并丢弃迟到回答；不支持表单时不宣告对应模式、命令和选项；提问工具向模型返回明确错误 |
| 配置 | 切换模型影响下一轮的 `requested_primary_profile`；锁定时报错；`workflow=compose` 启动 Compose Run；模式回流只发一次 |
| MCP/目录 | 合法目录生效、非法目录整单拒绝；同名 MCP 被跳过并记诊断；诊断里没有 env/headers；close 后根被撤销 |
| 输入 | `resource_link` 内联遵守 10 KB/20 KB 预算；根外链接不读；与 TS `mention-resolver` 的格式漂移测试 |
| 命令 | 每个内置命令成功一次、失败一次；命令不写 Transcript；空命令表也推送；catalog 变化后重发 |
| 列表与回放 | 三页翻完无重复无遗漏；非法游标；回放带参数和失败状态；5000 条历史的耗时预算 |
| 扩展 | 没声明扩展时，递归扫描所有出站帧无 `harnessCode`；声明后各能力字段齐全；Py/TS 常量漂移 |
| 端到端 | 官方 Python SDK 客户端（不声明扩展、声明 `elicitation.form`）走通：新建 → 提问回答 → 计划确认 → 切模型 → 取消 → resume |
| 性能 | 测量脚本输出四段耗时（不作为自动化门槛，只记录） |

所有测试使用 mock 模型或脚本化模型，不注入真实 API Key。另外用真实模型手工跑一次 `harness web` 冒烟并保留记录。

---

## 19. 边界（明确不做）

- 不改 `apps/desktop`、`apps/runner`、`packages/workbench-*`、`packages/acp-runtime`。HC-197 的通用运行时与真实接通由 HC-197/196 完成，本任务只给出可对接的 Agent 和协议证据。
- Task 验收中「通用 acp-runtime 启动实际 Python Harness」「用户 B 接手同一 Agent 原生上下文」两项，本任务交付后仍保持未勾选，标注「等 HC-197/196 停点」。
- 不做 `session/delete`、`session/fork`、图片/音频输入、`plugin_consent`、Skill/插件/MCP 的管理面（HC-201）、文件树和 Git（HC-199/207）、输入历史（HC-206/202）。
- 不新增模型循环，不在 ACP 层复制业务状态，不保留按参数匹配的工具卡降级逻辑。
- 不把 v3 改名成 ACP：v3 只增补 §14.2 的三项可选字段和通知，TUI 行为不变。

---

## 20. 文档影响与缺口关闭

- `docs/developer/architecture/ACP通信.md`：方法表、扩展能力表、新模块（`elicitation.py`、`config.py`）、性能基线实测值、UNSTABLE 依赖说明；缺口表逐行改为「已关闭」并附测试文件名或用例名。
- `docs/developer/architecture/Agent接入架构.md`：§4.2 表中 Harness 一行填入实测能力矩阵（来自 §18.2 官方 SDK 端到端测试，按该文 §6 的测试项）。
- `docs/user/Web界面.md`：删除已关闭缺口的提示，补充提问、计划模式、模型切换、内置命令的用法。
- `docs/user/快速开始.md`：补充 `harness acp` 可被任意 ACP 客户端使用的说明和能力范围。
- `docs/user/安全与沙箱.md`：说明会话级附加目录和 MCP 的授权边界。
- 关闭标准沿用缺口表治理规则第 3 条：实现并通过测试，状态改为「已关闭」并附证据。用户确认放弃的行写明日期。

---

## 21. 需要用户确认的决定

1. **D-1**：四种人工交互都走 UNSTABLE 的 `elicitation/create`（协议以后可能变，改动集中在两个文件）。另一个选择是自定义 `_harnessCode/` 方法，但 HC-197 就得认识 Harness 私有方法。
2. **D-2**：压缩、`/btw`、撤销/重做、改名、Goal、放弃 Compose 都做成 Agent 宣告的斜杠命令，不做扩展方法。代价是 `/undo` 之后，通用客户端要手动重新打开会话才能看到回退后的历史。
3. **D-3**：会话列表和标题由 Agent 提供原生数据。北辰写 HC-195 时如有不同意见再调整。
4. **GAP-32 的「分页」一半**：按「ACP 规定 load 必须回放完整历史」关闭，改用耗时预算（5000 条 ≤ 1.5s）。
5. **性能目标**：打开到可输入 ≤ 1.6s，冷启动到 `initialize` ≤ 0.6s，`session/list` ≤ 0.1s。达不到时记录实测数据，回来找你定。

实施时先核实、再定细节的项（不影响上面的决定）：握手缺陷的真实表现（§6.1）；子代理事件能否定位父 `task` 卡（§7.3）；模型绑定什么时候锁定（§9.2）；Skill 命令能否通过 Host 现有绑定校验（§11.2）；TUI 内置命令的子命令拼写（§11.3）；Transcript 里工具成功/失败的记录位置（§12.3）。

---

## 22. 建议的可演示停点（交给 Plan 细化）

| 停点 | 内容 | 用户能看到什么 |
|---|---|---|
| S1 协议底座与性能 | 握手闸门、命令表总推送、`session/list` 定位与分页、惰性导入、resume/close、会话摘要 | `harness web` 打开明显变快；会话侧栏显示条数和预览，能翻页；测量脚本输出四段耗时 |
| S2 工具卡保真 | 事件顺序、稳定 id、标准 diff、工作区外位置、回放细节、子代理可见 | 审批卡出现左右对比的 diff；恢复的会话里工具卡带参数，失败的显示失败；子代理工具卡挂在父卡下面 |
| S3 人工交互 | 表单模块；提问、计划模式与确认、拒绝附反馈、Goal 确认；模式回流 | 浏览器里 Agent 提问能回答；切到计划模式能确认计划，批准后模式自动切回；拒绝时能写原因 |
| S4 会话配置与输入 | `model` / `workflow` 配置项、用量、会话 MCP、附加目录、`@` 文件内联 | 能切模型、切 Compose 并看到阶段条；上下文用量实时变化；`@文件` 首轮就带内容 |
| S5 内置命令 | `/compact`、`/btw`、`/undo`、`/redo`、`/title`、`/goal`、`/abandon`、Skill 命令 | 补全菜单里出现这些命令，执行后界面即时反映结果 |
| S6 收尾 | 缺口表逐行关闭、用户文档、真实模型冒烟记录 | 缺口表中归属 HC-200 的行全部关闭或注明放弃日期 |
| S7 原有功能覆盖核对 | §23 | 一份功能覆盖矩阵；未覆盖项都登记进缺口表并有去向 |

---

## 23. 原有功能覆盖核对（2026-11-07 用户要求）

**为什么要做**：缺口表是 HC-209 时期按「TUI 和旧 `/web` 能做、ACP 不能做」整理的，没有和 Harness Code 的全部功能逐项核对过。HC-200 做完后，要用一次完整核对确认还有哪些原有功能 ACP 没覆盖，避免 TUI 下线时才发现漏项。

**核对对象**（以代码为准，不以文档为准）：

| 来源 | 列什么 |
|---|---|
| TUI 斜杠命令与快捷键（`packages/cli` 命令注册处） | 每个命令和快捷键 |
| TUI 与旧 `/web` 的界面功能（对话、侧栏、设置、Trace、文件/Git、弹窗） | 每个用户可见的操作 |
| v3 协议方法与通知（`protocol_v3.json`） | 每个方法，判断它对应的用户功能 |
| 交互类型（`interaction.*`）与 Run 模式（build/compose/direct_shell 等） | 每一种 |
| 命令行参数与配置项中影响会话行为的部分 | 每一项 |

**流程**：

```text
逐项列出原有功能
  → 判断 ACP 下的现状：已覆盖（附证据：测试名或冒烟记录）/ 未覆盖
  → 未覆盖的，按 [Agent 接入架构](../architecture/Agent接入架构.md) §3 的决策顺序找去向：
      1. 标准 ACP 能表达 → Harness 用标准实现（优先）
      2. 标准有但版本有差异 → ②协议层
      3. 可以不依赖 Agent 完成 → 上移到平台（①或平台服务），所有 Agent 受益
      4. 只有 Harness 能做 → `_meta.harnessCode` 扩展（只放附加信息），或 Harness 宣告的斜杠命令
      5. 不打算支持 → 写明原因，交用户确认
  → 未覆盖项登记为缺口表新行（新 GAP 编号，按缺口表治理规则）
```

**产出**：
- 功能覆盖矩阵（原有功能 / 覆盖状态 / 证据或去向 / 所属层），写进 `ACP通信.md` 新的一节。
- 缺口表新增行，「后续 Task」列填写具体任务号；需要新任务的，列出建议交用户决定，不擅自建任务。
- 回答一个结论性问题：TUI 是否可以在功能上被 ACP 链路替代；不能的话，还差哪几项。

**不在本节做的**：核对只产出清单和去向，不顺手实现新发现的缺口。归 HC-200 的新缺口是否在本任务内继续做，由用户看过清单后决定。
