# HC-200：Harness独立ACP接入实施计划

来源：[Task](../task/HC-200-Harness独立ACP接入.md) / [Spec](../spec/HC-200-Harness独立ACP接入.md)。Task 与 Spec 已由用户确认（2026-11-07，Spec §21 五项决定均按推荐方案）。

执行规则：
- 每项先写失败测试，再写最小实现，再整理。
- 每次只推进到下一个可演示停点，到达后停下等用户确认。
- 检查范围按 AGENTS 的 HC-192 覆盖规则：每个停点只跑与改动相关的套件（§测试门槛），全库测试留给 HC-204。
- 不改 `apps/`、`packages/workbench-*`、`packages/acp-runtime`、根锁文件。

## 计划总览

```text
S0 摸底（无可见变化）
   └─ 核实 Spec §21 列出的 6 个待核实项 + 2 个实现落点，结论回写 Spec
S1 协议底座与性能          ← 只依赖 S0
   └─ 握手闸门、命令表总推送、session/list 分页与提速、惰性导入、resume/close、会话摘要
S2 工具卡保真              ← 依赖 S1 的 server 骨架改动
   └─ 事件顺序、稳定 id、标准 diff、工作区外位置、回放细节、子代理可见
S3 人工交互                ← 依赖 S2 的稳定 id（审批挂卡）
   └─ 表单模块；提问、计划模式与确认、拒绝附反馈、Goal 确认；模式回流
S4 会话配置与输入          ← 依赖 S3 的模式回流（compose/plan 互动）
   └─ model/workflow 配置项、用量、会话 MCP、附加目录、@ 文件内联
S5 内置命令                ← 依赖 S3（/goal 走表单）、S4（/compact 补发用量）
   └─ /compact /btw /undo /redo /title /goal /abandon、Skill 命令
S6 收尾
   └─ 缺口表逐行关闭、用户文档、真实模型冒烟、性能基线回写
S7 原有功能覆盖核对        ← 依赖 S6（以 HC-200 完成后的真实状态为准）
   └─ 逐项列出 Harness Code 原有功能，标出覆盖状态与去向（Spec §23）
```

贯穿全程的分层约束（Spec §4.2，原则见 [Agent 接入架构](../architecture/Agent接入架构.md)）：本任务只做④ Agent 进程层的默认 Agent Harness（`packages/agent`）中的 `harness acp`，不碰①②③的目录；④内部 ACP 翻译只在 `host/acp/`，业务改动放 Host 或业务模块。每个功能先找标准 ACP 做法；没有标准方法的用户操作做成斜杠命令；扩展只放附加信息，客户端不声明扩展时功能仍能完整走通；输出不暴露 Harness 内部概念。测试客户端里读取扩展的代码，只用于显示增强。

每个停点都同时改 Python（`packages/agent`）和测试客户端（`packages/cli/src/acp-web`），让该停点的效果能在 `harness web` 里看到。Host 服务面的抽取（Spec §14.1）拆到用到它的停点里做，不集中成一个大重构。

## 测试门槛（每个停点都跑）

```text
G1  cd packages/agent && .venv/bin/python -m pytest -q tests/host/acp
G2  cd packages/agent && .venv/bin/python -m pytest -q tests/host          # 动了 AgentHost / 服务面时
G3  cd packages/cli   && bun test tests/acp-web && npm run typecheck      # 动了测试客户端时
G4  npm run project:check && npm run check:boundaries                     # 每个停点结束
```

改 `protocol_v3.json` 的停点（S2、S3）另跑协议生成与 `packages/protocol` 的生成一致性检查，以及 `tests/host` 中 v3 处理器的相关测试，确认 TUI 路径行为不变。

## S0：摸底

**目的**：先把可能推翻 Spec 细节的未知项摸清，再写代码。只读代码或写临时脚本，不改产品代码。

| # | 待核实 | 怎么核实 | 影响 |
|---|---|---|---|
| A | 握手缺陷的真实表现（Spec §6.1） | 写流水线测试：一次写入 `initialize`、`session/new`、`session/list` 三帧，记录每个响应 | 确定测试的「改前失败」断言；更正 HC-209 记录 |
| B | 子代理事件能否定位父 `task` 调用（§7.3） | 读 `execution_stream.py` 子代理事件信封与 `task` 工具的派生点 | 是否需要 Host 补 `parent_tool_call_id` |
| C | 模型绑定什么时候锁定（§9.2） | 读 `describe_thread_binding` 与 `requested_primary_profile` 的校验 | `MODEL_SELECTION_LOCKED` 是否需要（S0 结论：不需要，见 Spec §9.2） |
| D | Skill 命令能否通过 `bind_commands` 校验（§11.2） | 读命令快照构建与 `RequestedSkill` 校验 | Host 侧是否要放宽 |
| E | TUI 内置命令的子命令拼写（§11.3） | 读 `packages/cli` 的 `/undo`、`/goal`、`/compose`、`/title`、`/btw` 实现 | 修正 Spec §11.3 表 |
| F | Transcript 里工具成功/失败的记录位置（§12.3） | 读工具结果写入与 `open_thread` 消息构建 | 是否需要 Host 开始补记状态（S0 结论：不需要，状态已落库，见 Spec §12.3） |
| G | §7.1 事件与交互的有序下发落点 | 读 `run_execution.py` 的扇出任务与交互下发路径 | 有序队列放在哪一层 |
| H | §9.3 会话 MCP 如何参与 engine 指纹 | 读 `McpConnectionManager` 与 engine spec 构建 | 会话 MCP 的接入点 |

**可演示停点 S0**：用户看不到功能变化。交付物是 8 项结论（写入 Task「S0 结论」一节）和必要的 Spec 修订。任何一项推翻 Spec 的决定（而不只是细节），立即停下回写 Spec 并请用户确认。

## S1：协议底座与性能

**目的**：打开 `harness web` 明显变快；握手阶段不再有请求挂住；会话列表能翻页并显示摘要；支持标准的 resume/close。

1. **测量脚本**：先写四段耗时的测量脚本（进程启动到 `initialize` 响应、`session/new`、首个 `available_commands_update`、`session/list`），记录改前基线。后面每项优化都用它对比。
1a. **分层架构测试**（Spec §4.2「代码位置」）：锁定 `host/acp/` 的 import 白名单，以及「ACP SDK 只出现在 `host/acp/` 和进程入口」。后面每个停点新增模块都要受它约束。
2. **握手闸门**（Spec §6.1）：`AcpServer` 增加 `_ready()` Future；所有会话方法开头等待它；三种结局各一个测试。
3. **命令表总推送**（§11.1 第一条）：new/load 之后无论有无命令都推一次；测试客户端删除 `settleCommandsMs` 的固定等待，改为等到命令表。
4. **`session/list` 提速**：按测量脚本打点结果定位 0.6s 的来源再优化；目标 ≤ 0.1s（200 个线程）。
5. **分页**（§12.1）：持久层 `list_threads_page(limit, after)`（含排序键索引核查）；服务面 `HostServicePort.list_threads_page`；游标编解码与 `INVALID_CURSOR`；删除「有游标就回空」的旧分支。
6. **会话摘要**（§12.2）：`ext.py` 新增 `sessionSummary` 能力与出口函数；Py/TS 能力名漂移测试同步。
7. **resume / close**（§6.3）：`initialize` 声明 `sessionCapabilities.resume/close`；按 Spec 表实现，含幂等 close 与跨连接 `THREAD_BUSY`。
8. **惰性导入**（§16 第 3 项）：用 `python -X importtime` 找出 `acp` 路径上的重型模块，推迟到首次需要；加一个测试锁定「`initialize` 完成后，langchain/provider 类模块未被导入」；配置错误仍在 `initialize` 阶段暴露（测试锁定）。
9. **测试客户端**：会话侧栏按 `nextCursor` 翻页；显示条数和预览；声明 `sessionSummary`；刷新重连改用 `session/resume`（客户端已有时间线时）。

**可演示停点 S1**：
- `harness web` 打开到能输入的时间，测量脚本对比改前改后（目标 ≤ 1.6s；达不到如实记录并回报）。
- 会话侧栏显示每个会话的消息条数和最近一句；超过 50 个会话时滚到底能加载下一页。
- 终端流水线贴入三帧，三个响应都到达。

## S2：工具卡保真

**目的**：工具卡在实时和回放两种情况下都准确：不重复、不乱序、带左右对比 diff、失败显示失败、子代理过程可见。

1. **事件顺序**（§7.1）：按 S0-G 的结论在 Host 实现有序下发；200 次顺序测试。
2. **稳定 id**（§7.2）：补齐缺 `tool_call_id` 的审批路径（批量审批后续动作、子代理审批、`execute`、MCP 工具）；删除 `translate.py` 的参数匹配降级；「审批先于工具卡」时用同 id 建卡的测试。
3. **标准 diff**（§8.1 第 1 条、D-4）：`protocol_v3.json` 的 `fileDiffPresentation` 新增 `old_text`/`new_text`，重新生成；`PreparedFileMutation` 写入全文（256 KiB 上限、二进制不带）；`permissions.py` 产出标准 `diff` 内容，超限回退文本；帧大小测试。
4. **工作区外位置**（§7.5）：`HostServicePort.resolve_display_path()`（Host 用注册表只读视图解析，S2 实施时改定，见 Spec §7.5）；`PathLocator` 改走它；根外路径不产出位置的测试。
5. **回放细节**（§12.3）：`threadMessage` tool 记录新增 `tool_call_id`/`arguments`/`status`（状态已在 Transcript 里，只需读出，见 Spec §12.3）；`sessions.py` 回放带 `rawInput`、标题、kind、locations、真实状态；5000 条历史的耗时预算测试（本机，非门槛，只记录）。
6. **子代理**（§7.3）：`ext.py` 新增 `subagent`；`translate.py` 产出子代理工具卡、正文累加进父卡、子代理审批挂卡（GAP-34）。
7. **测试客户端**：渲染标准 `diff`（已有 diff 组件，接入新数据源）；回放卡显示参数和失败；子代理卡按 `parent` 缩进挂在父卡下。

**可演示停点 S2**：
- 让 Agent 改一个已有文件：审批卡出现左右对比的 diff。
- 让 Agent 跑一个会失败的命令，然后刷新页面：恢复的工具卡显示参数和失败状态。
- 让 Agent 调用子代理：子代理的工具卡挂在父 `task` 卡下面，子代理要审批时审批出现在它自己的卡上。

## S3：人工交互

**目的**：TUI 里的提问、计划模式、拒绝附原因、Goal 确认，在 ACP 下都能用。

1. **表单模块**（D-1）：新建 `host/acp/elicitation.py`，集中所有 `elicitation/create` 的构造、回答解析、`$/cancel_request` 撤回；按客户端 `elicitation.form` 声明决定是否启用；待回答表与 Run 取消联动（§8.7）。
2. **提问**（§8.3）：schema 构造与回答映射；不支持表单时 Host 向模型返回明确错误（§8.6，Host 改动）。
3. **拒绝附反馈**（§8.2）：权限选项新增 `reject_with_feedback`；选中后的追问表单。
4. **计划**（§8.4、§9.1）：`modes.py` 按能力暴露 `plan`；`interaction.plan` 表单。
5. **模式回流**（§9.1、§14.2）：`protocol_v3.json` 新增 `thread.approval_mode` 通知并生成；Host 三个来源都广播；`AcpServer` 去重后发 `current_mode_update`。
6. **Goal**（§8.5）：`interaction.goal` 表单；`goal` 扩展能力；Goal 判定条件 → 标准 `plan` 更新（§7.6 的 Goal 行）。
7. **审批扩展字段**（§8.1 第 2、3 条）：`scope`、`requests`/`requestsTruncated`。
8. **测试客户端**：新建 `acp-web/client/elicitation.ts`，四种 schema 识别并接入控制器已有的卡片，认不出的走通用表单；声明 `elicitation.form` 与 `goal`。

**可演示停点 S3**：
- 让 Agent 向你提问（例如「先问我用哪种方案再动手」）：浏览器出现提问卡，选择后 Agent 按回答继续。
- 切到「先出计划」模式发一个任务：出现计划确认卡；批准后模式下拉自动切回原来的模式。
- 审批时选「拒绝并说明原因」，写原因：Agent 的下一句回复体现这条原因。

## S4：会话配置与输入

**目的**：能切模型和工作模式，能看到上下文用量，标准客户端传来的 MCP 和附加目录生效，`@文件` 首轮就带内容。

1. **服务面**：抽取 `list_models`；新增 `set_session_roots`、`set_session_mcp`（Spec §14.1）。
2. **配置项**（§9.2）：新建 `host/acp/config.py`；`model`、`workflow` 两项；`session/set_config_option` 与三类错误；new/load/resume 响应带 `configOptions`；变化时推 `config_option_update`。
3. **Compose 阶段**（§7.6 的 Compose 行）：`compose.progress` → 标准 `plan`；`compose.summary` → 消息块。
4. **用量**（§7.4）：`usage_update` 去重发送；`PromptResponse.usage`。
5. **附加目录**（§9.4）：校验、整单拒绝、`session` 作用域登记与撤销、诊断事件。
6. **会话 MCP**（§9.3）：按 S0-H 结论接入；sse/同名跳过；诊断不含敏感字段的测试。
7. **文件内联**（§10）：`resource_link`/`resource` 内联，预算与格式对齐 `mention-resolver.ts`；Py/TS 格式漂移测试；Transcript 只记原文。
8. **测试客户端**：模型选择器与工作模式切换接 `configOptions`；用量指示接 `usage_update`；Compose 阶段条接 `plan`；`@文件` 改发 `resource_link`（GAP-24 本地验证用；新平台的发送侧归 HC-206）。

**可演示停点 S4**：
- 模型下拉切换后发消息：Run 摘要里的模型是新选的模型。
- 切到「分阶段协作」发任务：出现 Compose 阶段条并随进度变化。
- 连续对话：上下文用量数字随之增长。
- 输入 `@某文件 解释一下`：Agent 第一轮回复就引用了文件内容，没有先调用读文件工具。

## S5：内置命令

**目的**：补全菜单里出现压缩、旁注提问、撤销/重做、改名、Goal、放弃 Compose 和 Skill 命令，执行结果即时可见。

1. **服务面**：抽取 `compact_thread`、`side_question`、`undo_thread`/`redo_thread`/`list_turns`、`set_thread_title`、`goal_inspect`/`goal_request`/`goal_mutate`、`compose_abandon`；v3 处理器变薄壳；每个方法跑 G2。
2. **命令拦截**：`commands.py` 加内置命令表（按能力筛选）与冲突规则；`session/prompt` 拦截内置命令，不启动 Run、不写 Transcript；结果消息块 `messageId = "cmd:{uuid}"`。
3. **逐个命令**（§11.3 表，按 S0-E 修正后的拼写）：每个成功一次、失败一次的测试；`/compact` 后补发 `usage_update`；`/title` 后发 `session_info_update`。
4. **Skill 命令**（§11.2）：Host 命令快照纳入用户可调用的 Skill（按 S0-D 结论）；删除 `commands.py` 里 `/skill:` 的限制。
5. **命令扩展字段与动态更新**（§11.4、§11.1 第二条）：`commands` 能力；catalog 变化时向所有会话重发。
6. **测试客户端**：命令表整表替换；`historyChanged` 自动重新 `session/load`；`ephemeral` 消息按旁注样式显示；声明 `commands`。

**可演示停点 S5**：
- 输入 `/` 看到这些命令（包括 `skill:xxx`）。
- `/btw 这个项目用什么测试框架`：答案以旁注样式出现，刷新后不在历史里。
- 改一个文件后 `/undo`：文件恢复，时间线自动刷新成回退后的样子；`/redo` 恢复。
- `/title 新名字`：侧栏会话标题立即变化。
- `/compact`：显示压缩前后 token 数，用量指示同步下降。

## S6：收尾

1. 缺口表（`ACP通信.md`）中归 HC-200 的 28 行逐行改为「已关闭」并附测试文件或用例名；做不完的行写明原因，交用户决定是否放弃。
2. `ACP通信.md`：方法表、扩展能力表、新模块、UNSTABLE 依赖说明、性能基线实测值。
3. 用户文档：`Web界面.md`、`快速开始.md`、`安全与沙箱.md`（Spec §20）。
4. 官方 Python SDK 客户端端到端测试（Spec §18.2 端到端行）：不声明扩展、声明 `elicitation.form` 两种。按 Agent 接入架构 §6 的测试项整理出 Harness 的能力矩阵，填进该文 §4.2 表格的 Harness 一行。
5. 真实模型手工冒烟：按 S1～S5 停点逐项在 `harness web` 里操作一遍，结果写进 Task。
6. Task 验收项逐条更新：Agent 侧已完成的打勾并附证据；依赖 HC-197/196 的两项保持未勾选并注明。

**可演示停点 S6**：缺口表中归 HC-200 的行全部「已关闭」或写明用户确认放弃的日期；Task 验收项状态与证据齐全（覆盖核对一项除外，留给 S7）。

## S7：原有功能覆盖核对

**目的**：确认 HC-200 做完后，Harness Code 原有功能里还有哪些没被 ACP 覆盖，每一项都有明确去向（Spec §23）。只产出清单，不实现新缺口。

1. 从代码列出原有功能：TUI 斜杠命令与快捷键、TUI 与旧 `/web` 的界面操作、v3 方法与通知、交互类型与 Run 模式、影响会话行为的命令行参数与配置项。
2. 逐项判定：已覆盖的附证据（测试名或冒烟记录）；未覆盖的按 Agent 接入架构 §3 的顺序（标准 ACP → 协议兼容 → 上移到平台 → Harness 扩展或斜杠命令 → 不支持并交用户确认）给出去向，并标明所属层。
3. 写入 `ACP通信.md` 新的「原有功能覆盖矩阵」一节；未覆盖项登记为缺口表新行。需要新任务的只列建议，不擅自建任务。
4. 给出结论：TUI 在功能上能否被 ACP 链路替代；不能的话，还差哪几项。

**可演示停点 S7**：用户看到一份覆盖矩阵和结论；决定新缺口是否在本任务继续做、哪些改归其他任务。之后 Task 状态改为「待验收」，不自动归档。

## 风险与应对

| 风险 | 应对 |
|---|---|
| `elicitation` 是 UNSTABLE，SDK 升级可能改形状 | 全部集中在 `elicitation.py` / `elicitation.ts`；S3 加一个 SDK 版本锁定测试，升级时必然先看到这里 |
| S0-B 结论是子代理事件定位不到父卡 | Host 补字段；如果补字段要改子代理执行模型，停下回报，GAP-16/34 改为「可见但不挂卡」并请用户确认 |
| 惰性导入达不到 0.6s | 如实记录瓶颈模块和实测数据，不为凑数字改变语义，交用户决定 |
| 抽服务面改到 v3 行为 | 每抽一个方法跑 G2；v3 处理器只做参数解析和调用 |
| 测试客户端改动和北辰的新 UI 重复 | 只改 `packages/cli/src/acp-web`，随 HC-203 退役；交互 schema 形状写在 Spec 里供 HC-206 复用 |
