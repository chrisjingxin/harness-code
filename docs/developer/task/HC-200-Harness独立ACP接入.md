---
id: HC-200
title: Harness独立ACP接入
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P1
status: 待验收
owner: 张景新
branch: feat_hc_200_Harness独立ACP接入
scope: 在独立 Harness Agent 实现内提供 Python ACP 接入适配，复用现有运行/持久化服务，接入通用 Runner 并验证恢复与人工交互；并入原「补齐 ACP 缺口扩展」任务中归属 Agent 侧的 28 个 ACP 缺口、握手缺陷与三项启动性能优化。
acceptance: 真实 Harness 经 ACP 可建会话、流式运行、取消/回答和恢复；平台不导入内核类型，切换到其他 Agent 无需 Harness/Python；ACP通信.md 缺口表中归属 HC-200 的行全部「已关闭」附测试证据或用户确认放弃带日期。
user_docs: 实现阶段按范围更新独立桌面用户指南、docs/user/快速开始.md、docs/user/安全与沙箱.md 与 docs/user/Web界面.md；当前不新增产品运行承诺
developer_docs: docs/developer/architecture/多人协作工作台顶层设计.md、docs/developer/architecture/ACP通信.md；后续按本 Task 同名文件补 Spec、Plan、Todo
test_evidence: -
references: docs/developer/task/HC-192-协作工作台与会话交接.md；设计基线 02505619be4026c3dba0ec27aca729ae01a26968
completed_at: -
---

# HC-200 Harness独立ACP接入

## 当前等待安排（2026-11-10，合并后已结束）

2026-11-10 的调度曾要求本卡等同事交付 ACP 后再开发，见[当时的并行约定](../project/协作任务并行开发约定.md#0-当前调度等待同事交付-acp2026-11-10)。本分支已经做完停点 0 至 7，用户于 2026-11-11 验收。Agent 侧 `harness acp` 不再等待。通用运行时拉起进程仍归 HC-197，关窗口后保持运行和另一用户接手仍归 HC-196、HC-197。

## 需求与交付

让 Harness 成为可独立运行的 ACP Agent，桌面使用它与使用其他 Agent 一样经由协议接入。共享业务留在平台，已有模型、工具和上下文能力留在内核。

属于 [HC-192 总任务](./HC-192-协作工作台与会话交接.md)，共同边界以 [独立桌面总体设计](../architecture/多人协作工作台顶层设计.md) 为准，参考来源见 [Lody 对照](../research/192-Lody协作能力对照.md)。设计基线为本地提交 `0250561`。本文是子 Task，不是已确认 Spec 或实施计划；2026-11-06 由张景新认领，尚未实现。

## 范围与目标归属

- 现 packages/agent 内的独立 ACP 入口与必要应用服务接合，具体路径在 Spec 固定。
- ACP 会话到内部 Thread/Run/Interaction 的映射，原生上下文和检查点由 Agent 自己维护。
- 进程启动配置和退出、恢复回放、通用能力声明与失败语义。
- 内网模型/SDK 差异留在 Agent 配置与能力声明，不改变平台公共协议。

## 从原缺口扩展任务并入的 ACP 缺口（2026-11-06 用户确认）

HC-209 做出的 `harness acp` 已能对话、流式和审批，但和 TUI 相比还缺一批能力，登记在 [ACP通信.md](../architecture/ACP通信.md) 的缺口表里。用户确认：除不建议合并的项之外，原「补齐 ACP 缺口扩展」任务（已删除）的缺口全部并入本任务，缺口表「后续 Task」列已改为 HC-200。按缺的原因分四类：

| 类型 | 缺口 | 做法 |
|---|---|---|
| 已有实现但有缺陷 | 握手缺陷（`initialize` 未返回就收到 `session/new` 时，排队请求先回 `NOT_INITIALIZED`，见 Spec §6.1 S0 实测）、GAP-22/32 回放、GAP-23 稳定调用 id、GAP-31 模式回流、GAP-35 事件顺序、GAP-36/37/38 字段缺失 | 修 Python 侧实现，补回归测试 |
| 标准有、我们没接 | GAP-06 diff 前后文、GAP-21/27 `mcpServers`/`additionalDirectories`、GAP-24 `@` 文件内容块（Python 接收；界面发送归 HC-206）、GAP-33 会话分页 | 按 ACP 标准字段实现 |
| 标准可能已有、需核实 | GAP-07 用量与压缩、GAP-08 模型切换、GAP-02 Plan 模式 | Spec 阶段对照当前 ACP 标准逐条核实，有标准走标准，没有再扩展 |
| 标准没有、需扩展 | GAP-01 提问、GAP-03 goal、GAP-04 Compose、GAP-05 拒绝附反馈、GAP-09 撤销/重做、GAP-10 `/btw`、GAP-16/34 子代理、GAP-26 工作区外位置、GAP-28 Skill 斜杠、GAP-30 允许范围区分、GAP-39 改名 | `_meta.harnessCode` 载荷或 `_harnessCode/` 方法，只发给声明了扩展的客户端 |

另并入三项启动性能优化（实测拆解见 ACP通信.md「打开/刷新性能基线」）：无插件命令时也发一次空的 `available_commands_update`；定位 `session/list` 约 0.6s 的耗时；惰性导入以缩短约 1.3s 的 Python 冷启动。

未并入的缺口去向：GAP-11/12 → HC-199/207；GAP-13/14/15/17/18/19 → HC-201；GAP-20/29 → HC-197；GAP-25 → HC-206/202。

并入后需要额外对齐的交界：

- **HC-197**：`_meta.harnessCode` 扩展的协商方式和能力位，通用运行时怎样把未声明的扩展当作「不支持」处理。
- **HC-195**：GAP-33/36/39 涉及会话列表、摘要和标题；新平台的共享会话可能由云端管理，Spec 前先确认 Agent 侧只提供原生会话数据，还是仍负责列表与标题。
- **HC-201**：GAP-28/37 的命令来源与 Skill 管理面的边界。
- **HC-206**：GAP-24 的界面发送部分。

本地验证期间用现有 `harness web` 作为 ACP 测试客户端。用户 2026-11-06 确认：新增扩展（如 GAP-01 提问）可同步修改 `packages/cli/src/acp-web` 客户端与界面，以便在浏览器里直接验收；这部分属于测试客户端适配，随 HC-203 旧入口退役一并清理，新平台界面仍由 HC-206 消费同一协议实现。

## 架构分层与覆盖核对（2026-11-07 用户确认）

企业内其他 Coding Agent 大多魔改自 Cline、Pi、Qwen Code 等开源上游，不一定配合我们，所以平台只能依赖标准 ACP。长期原则写入 [Agent 接入架构](../architecture/Agent接入架构.md)，作为后续设计的指导：四层结构（桌面 UI / ACP 协议 / Provider 适配 / Agent 进程）；功能落点按「标准 ACP → 协议兼容 → 上移到平台 → 家族适配 → Harness 扩展」的顺序决定；Harness Code 是默认 Provider，但不是必需依赖，也没有特权路径；扩展命名空间保持 `harnessCode`，只作 Harness 的增强显示。代码目录也按四层组织（架构文档 §2.1）：Harness 是④ Agent 层的默认 Agent（`packages/agent`），对应的③层 Provider 是 `packages/providers/harness/`（HC-201）。本任务只改④层，按这套原则约束自己的输出，见 [Spec §4.2](../spec/HC-200-Harness独立ACP接入.md)。

HC-200 做完后，逐项核对 Harness Code 原有功能还有哪些没被 ACP 覆盖（Spec §23）：未覆盖项登记进缺口表并给出去向，是否继续在本任务内实现由用户看过清单后决定。

## 依赖与范围边界

Agent 侧适配已在本分支完成，并与 [HC-197](./HC-197-通用ACP运行时.md) 的能力、生命周期和扩展交界按 Spec 对齐。真实 Runner 接入与跨用户原会话接续仍需 HC-197、HC-196 对应停点，独立协议冒烟不能替代它们。

不把用户、设备、工作区、交接和 @引用业务加入 Python 内核；不模拟 TUI 输入，不经过旧 CLI 或把 JSON-RPC v3 改名成 ACP。不重写模型循环或交换其他 Agent 的私有检查点；Trace/专有设置的外层集成归 HC-201。

## 并行认领与接口交付

主责 Harness Python ACP 入口和必要内核适配，生产改动不进入通用 Runner/Java/UI。与 HC-197 共享协议进程场景，与 HC-201 明确 stderr/扩展归属和能力；Trace 解析与 UI 由 HC-201，不能两边采集同一日志。

本卡 Agent 侧适配已与设备、项目、对话、导航及 HC-201 的解析迁出并行完成。内网包缺口保留原逻辑，测试结论按实际环境记录；共享装配由统筹协调，见[并行开发约定](../project/协作任务并行开发约定.md)。

## S0 结论（2026-11-09）

S0 只读代码并写临时脚本，没有改产品代码和现有测试。八项结论里没有推翻 Spec §21 的五项决定，但有四处细节与原 Spec 不同，已回写 Spec，请用户确认：一是不存在「模型锁定」，`MODEL_SELECTION_LOCKED` 删除；二是 Skill 命令名不能用完整 id；三是 TUI 没有 `/compose`，命令改为 `/abandon`，`/undo` 的参数形式是 ACP 新增；四是子代理父卡关系改由翻译层用已有的 `tool.delta` 绑定得到，不改 Host 事件信封。

**测试基线（0.1）**：G1 `tests/host/acp` 317 通过 / 0 失败；G2 `tests/host` 647 通过 / 0 失败（26 条 warning，来自 Pydantic V1 与 Python 3.14、一个 aiosqlite 线程 warning）；G3 `bun test tests/acp-web` 347 通过 / 0 失败 / 15 跳过（15 条是需要 `HARNESS_E2E_CHROMIUM` 的浏览器 E2E，未配置按设计跳过），`npm run typecheck`（packages/cli）通过。

| 项 | 结论 | 对 Spec 的影响 |
|---|---|---|
| A 握手 | 排队的 `session/*` 先回 `-32600 NOT_INITIALIZED`，不是不回；只在 `ensure_ready()` 真让出事件循环时出现，本机真实路径同步完成所以暂观测不到；进程内替身（延迟 0.3s）稳定复现，顺序为 `session/new` 错误 → `session/list` 错误 → `initialize` 成功。脚本在 `tmp/hc200-s0/`（gitignore）。 | §6.1 补实测；S1 用延迟替身做测试；HC-209 记录已更正 |
| B 子代理父卡 | 信封无 `parent_tool_call_id`；但父 `task` 卡先收到 `tool.delta{child_execution_id}`，子代理审批动作自带子代理 `tool_call_id`。证据：`agent_delegation.py` 的 `_emit_child_binding`、`child_approval.py`。 | §7.3 改为翻译层用 `tool.delta` 绑定，不改 Host 信封 |
| C 模型锁定 | 不存在锁定：模型是每次 Run 的请求参数，历史 Run 不构成锁。ACP 连接目前没协商 `models.select`，带 `requested_primary_profile` 会被 Host 拒绝。证据：`agent_host.py` 的 `start_run` 能力检查、`execution_binding.py` 的 `resolve_execution_binding`。 | §9.2 删除 `MODEL_SELECTION_LOCKED`；S4 需给 `open_connection` 加 `models.select` |
| D Skill 命令 | 命令快照只含 `kind=="command"`；`RequestedSkill` 校验已能接受 Skill；Skill id 带 `/` 会被 `parse_slash` 截断。 | §11.2 命令名改为 `skill:<末段>`；Host 只改 `agent_commands()` |
| E 命令拼写 | `/undo` 在 TUI 是选择器，无参数；`/goal` 多 `edit`；没有 `/compose`，是 `/abandon`。其余一致。 | §11.3 表与说明已改 |
| F 工具状态 | 失败标记已在 Transcript JSON 的 `status` 里，丢失在 `ThreadMessage` 投影层。 | §12.3、§14.3 改为「读出」，不补记、不改表结构 |
| G 有序下发 | 事件走 `run.events` + 扇出任务，交互在 Run 协程内直接发送，所以会乱序。落点：`request_interaction` / `request_child_interaction` 改为入队 `run.events`，由 `_fanout_run_execution` 发送。 | §7.1 落点已定 |
| H 会话 MCP | digest 已进指纹且 manager 支持多份；切入点是 `_resolve_agent_engine_spec`，工具列表必须取自会话运行时；close 时要退役 owner。 | §9.3 补做法与风险 |

另外 TUI 里有、Spec 未覆盖的斜杠命令（供 S7）：`/help`、`/quit`、`/new`（`/clear`）、`/status`、`/resume`（`/continue`、`/threads`）、`/model`（`/models`）、`/skills`、`/agents`、`/teams`、`/mcp`、`/web`、`/plan`、`/plan-view`、`/code-index`、`/new-work`。

## S1 结果（2026-11-09）

协议底座已完成并有测试；两项性能目标（`initialize` ≤ 0.6s、`session/list` ≤ 0.1s）没有达到，原因和数据在后面，用户已决定暂缓。

**已完成（每项先写失败测试）**

| Todo | 结果 | 主要测试 |
|---|---|---|
| 1.1 测量脚本 | `packages/agent/scripts/acp_startup_probe.py`，输出四段耗时与中位数，`--home temp/real`、`--seed-threads` | `tests/test_acp_startup_probe.py` |
| 1.1a 分层测试 | 扫描 import，9 处白名单；发现第 10 处（`PathLocator` 里的 `WorkspacePathPolicy`）已写入 Spec §4.2 作为带退出条件的临时豁免，S2 的 2.7 删除 | `tests/host/acp/test_layering.py` |
| 1.2 握手闸门 | `initialize` 进行中到达的会话请求等待握手结果；未握手 `NOT_INITIALIZED`，握手失败 `HOST_INIT_FAILED`；`session/new` 响应一定排在 `initialize` 之后（重复 50 次） | `test_handshake_gate.py` |
| 1.3 命令表总推送 | new/load 后空表也推；测试客户端删除固定 500ms 等待，改为等到命令表（5s 只作兜底） | `test_server_commands.py`、`acp-agent-gateway.test.ts` |
| 1.5/1.6 分页 | 持久层 `list_threads_page`（键集分页）；ACP 层每页 50 条、游标不透明、`INVALID_CURSOR`；删除「有游标回空」旧分支 | `test_thread_persistence.py`、`test_server_sessions.py` |
| 1.7 会话摘要 | `sessionSummary` 扩展；未声明时整条连接无 `harnessCode`（递归扫描测试） | `test_extension_negotiation.py`、`ext.test.ts` |
| 1.8 resume/close | 能力声明、resume 不回放、close 取消在途 Run 且幂等；需要 SDK 的 `use_unstable_protocol=True` 才会路由这两个方法 | `test_server_resume_close.py` |
| 1.10 测试客户端 | 侧栏滚到底翻页、显示条数与最近一句、`session/resume`（本连接已开过的会话）；涉及 `interactive/catalog-feature`、侧栏组件的最小接入 | `acp-sessions-page.test.ts`、`thread-catalog-pagination.test.ts`、`workspace-sidebar.test.tsx` |

**验证**：G1 `tests/host/acp` 407 通过；G2 `tests/host` 742 通过；`tests/compose`/`code_index`/`extensions`/`goals`/`runtime`/`threads` 全过（extensions 里 `test_marketplace_install_recovers_old_version_after_switch_crash` 偶发失败，是 marketplace 快照目录竞态，与本任务无关）；G3 `bun test tests/acp-web tests/interactive` 592 通过 / 15 跳过，typecheck 干净；G4 `project:check` 与 `check:boundaries` 通过。

**性能实测（机器 load average 5～14，数字偏高，仅看趋势）**

| 指标 | 目标 | 改前（空闲） | 改后 |
|---|---|---|---|
| 启动到 `initialize` 响应，temp，中位 | ≤ 600ms | 1334ms | 1357～1446ms（几乎没变） |
| 启动到 `initialize` 响应，real，中位 | ≤ 600ms | 1412ms | 1493～1630ms |
| `session/list`，temp 种 200 线程 | ≤ 100ms | 50ms | 48ms |
| `session/list`，real（164MB 真实库），紧跟 `session/new` 发出 | ≤ 100ms | 593ms | **610～1728ms** |

最后一行要特别说明：第一版探针的「命令表等待」有缺陷（每次空等 5 秒），导致 `session/list` 总在预热完成后才发出，曾显示 0.7ms，那是假象。修正后真实路径是 `session/new` 之后立即 `session/list`，会撞上后台预热正在持有的线程库打开锁，等到打开完成。

**瓶颈（读代码加实测）**

1. **线程库打开约 600～680ms**，`session/list` 的 SQL 本身只要 0.24ms。耗时在 `ThreadPersistence.open → _prepare → _database_fingerprint_async`（`thread_persistence.py`）：`PRAGMA integrity_check`（约 112ms）加对 41 张表逐行算摘要（约 547ms），用来证明迁移前后数据没丢、没被改。它每次打开都无条件算。
2. **`initialize` 的 1.3～1.4s 基本是 Python 导入**：`openai` 约 408ms、`acp` SDK 约 200ms（握手必需）、`langchain`/`langsmith`/`langgraph` 合计约 250ms。`ensure_ready` 在握手阶段要构造插件 runtime（`_set_plugin_catalog`），而 `plugins.runtime` 顶层就导入 `langchain.agents.middleware`，所以这条链是握手真实需要的。
3. 已做的惰性导入只推迟了 `run_execution`、`compose.*`、`run_context` 等握手之外的引用，`initialize` 时间没有明显变化，因为 `openai`、`langchain` 仍经 `harness_gateway`、`plugins.runtime` 进入握手。

**用户决定（2026-11-09）**：性能优化先放一放，等 Electron 包完成后再看真实效果再评估，本任务不再继续改性能。具体处理：

| # | 事项 | 处理 |
|---|---|---|
| 1 | `session/list` ≤ 0.1s（是否降级线程库打开时的完整性检查） | 暂缓，不改。当前首次 `session/list` 约 0.6s。降级方案与风险见上面的瓶颈 1，需要时再确认 |
| 2 | `initialize` ≤ 0.6s（`openai` 惰性、插件 runtime 推迟到首个 Run） | 暂缓，不改。目标留待 Electron 包完成后按实际效果重新评估 |
| 3 | 本批做过的惰性导入与后台预热 | **已回退**：`run_coordinator.py`、`provider_retry.py` 与 HEAD 零差异；`agent_host.py` 的惰性导入、插件 catalog 惰性访问器、后台预热全部删除，`test_lazy_imports.py` 与预热测试删除。保留的只有与性能无关的改动：`list_threads_page`、线程库打开加锁（修并发双开）、`cleanup_stage_execution` 的未定义变量修复 |

回退后验证：G1 406 通过；G2 738 通过；`tests/compose`/`runtime`/`threads`/`extensions` 全过；`project:check` 与 `check:boundaries` 通过。`scripts/acp_startup_probe.py` 保留，以后复测用。

**实施中发现的非本任务缺陷（只登记，没有改）**

- `run_coordinator.cancel` 在 Run 状态为 `accepted` 时不会取消尚未启动的执行器：取消落在受理窗口会被标记为已取消，但执行器随后照常启动并一直阻塞，同一线程的下一次 Run 被串行卡住。是测试里把空命令表帧当作「已就绪」信号后才暴露的。建议登记为新缺口，归属待定。
- `agent_host.py` 里 `_provide_compose_services` 的 `cleanup_stage_execution` 闭包原本引用了不存在的变量 `persistence`（pyflakes 的未定义名检查发现），一旦被调用必然 `NameError`，已改为取本次 Run 的持久层。
- 用 `git checkout` 恢复破坏验证用的改动时曾误回滚过一次未提交的 `sessions.py`，已按设计原样重建并重跑 G1，全绿；之后改用编辑恢复。

## S2 结果（2026-11-09 实现，用户已验收）

用户按三步案例在 `harness web` 里确认通过：`default` 下修改已有文件时审批卡有左右对比；失败命令在刷新并重新打开同一会话后仍显示命令参数和失败状态；`task` 子代理的工具卡紧挨父任务卡成组，改文件的审批出现在子代理那一组上。

工具卡在实时和回放两种情况下都更准确：不乱序、id 稳定、审批带左右对比 diff、回放带参数和失败状态、子代理过程可见。自动化测试此前已通过。文中「还没有人按查看方式操作过」指的是写本节时的状态，现已由用户确认覆盖。

| Todo | 结果 | 主要测试 |
|---|---|---|
| 2.1 事件顺序 | 事件走 `run.events` 队列，交互请求原先在 Run 协程里直接发送，所以可能越过前面的事件。现在交互请求先往同一个队列放一个「屏障」，等扇出任务把前面的事件都送出后才发审批帧；扇出结束、Run 终态、Run 取消时屏障都会被解除，不会挂住 | `test_run_coordinator.py` 屏障 4 项（改前红）、`test_event_order.py`（ACP 层 200 轮，见下） |
| 2.2 稳定 id | 预检登记 `ToolCallIdStore` 由「指纹 → 单个 id」改成「指纹 → 先进先出队列」，`take` 消费队首；审批 payload 对每个 action 都按各自的工具名与参数取 id（原先只写第一个）；同名同参数的连续调用各拿各的 id；取不到时记诊断 | `test_approval_tool_calls.py`、`test_approval_protocol.py`（批量与重复调用） |
| 2.3 删参数匹配 | 删除 `_match_by_args`；审批带 id → 找不到卡就用同一个 id 先建卡，随后的 `tool.started` 复用；卡已收尾或已被占用才落兜底卡 | `test_translate.py` 3 新增 + 3 迁移 |
| 2.4/2.5 协议与全文 | v3 `fileDiffPresentation` 新增可选 `old_text`/`new_text`（各 ≤256 KiB，任一边超限则两个键都不带）；Host 在新建/修改/删除时写入。最大约 530 KiB，低于帧上限 8 MiB 与工具载荷上限 1 MiB | `test_snapshot_file_contract.py`、`tests/protocol` |
| 2.6 标准 diff | 权限请求的 `toolCall.content` 改为标准 `diff`（新建无 `oldText`，删除 `newText=""`，相对路径按工作区解析成绝对路径）；没有全文或整帧超过 6 MiB 时退回文本兜底；`harnessCode.approval.presentation` 的扩展副本不再重复带全文 | `test_permissions.py` 5 新增 |
| 2.7 工作区外位置 | 新增 `HostServicePort.resolve_display_path`，Host 用注册表只读视图解析，已授权的外部目录也能产出 `locations`；`PathLocator` 不再 import `policy.*`，分层测试的临时豁免清空（原设想的 `workspace_roots()` 已改定，见 Spec §7.5） | `test_resolve_display_path.py`、`test_layering.py` |
| 2.8 回放字段 | v3 `threadMessage` 的 tool 记录新增可选 `tool_call_id`/`arguments`/`status`；参数从前面 assistant 记录的 `tool_calls` 按 id 关联，超 256 KiB 不带；旧数据照旧 | `test_replay_tool_messages.py`、`test_thread_message_payload.py` |
| 2.9 回放翻译 | 回放的工具卡带 `rawInput`、标题、kind、位置、真实状态（failed/completed）；id 不变，同一历史两次回放逐字一致 | `test_replay_tool_detail.py` |
| 2.10 大历史耗时 | `scripts/acp_replay_probe.py`：5000 条历史的 `session/load` 中位 **430ms**（首轮含冷打开 1.3s），达标 ≤ 1.5s | `tests/test_acp_replay_probe.py`（冒烟） |
| 2.11 子代理可见 | 新增 `subagent` 扩展；子代理工具卡是标准卡，id 为 `{runId}:{executionId}:{toolCallId}`，标题带代理名前缀；父卡关系取自父 `task` 卡已有的 `tool.delta{child_execution_id}`，不改 Host 事件信封；子代理正文累加进父卡（64 KiB 截断）；子代理审批挂到它自己的卡上；未声明扩展的客户端也能看到子代理卡，只是没有 `parent` | `test_subagent_cards.py` |
| 2.12 测试客户端 | 审批卡的 diff 数据：扩展 presentation 优先，缺失时用标准 diff 合成；回放卡补回 `toolCallId`/参数/失败状态，与直播卡走同一条映射；子代理卡按 `executionId` 归入已有的 activity 分组，标题含代理名（`state.ts` 里非 root execution 原本硬编码为 `root`，现在用 executionId 作 `activityId`，Compose 既有分组测试全绿） | `permission.test.ts`、`replay.test.ts`、`subagent-parent.test.ts` |

**验证**：`tests/host/acp` 422 通过；`tests/host` 与 `tests/policy` 1815 通过；`protocol`/`tools`/`runtime`/`compose`/`threads`/`extensions` 1069 通过；`packages/protocol` 生成物一致；客户端 `acp-web` 与 `interactive` 606 通过、typecheck 干净；`tests/web` 430 通过，2 个 Playwright 用例因本机缺浏览器失败（环境基线，非回归）；`project:check` 与 `check:boundaries` 通过。pyflakes 的未定义名检查在收尾时抓出一处真实缺陷：`translate.py` 里 `parent_meta` 没导入，只有协商了 `subagent` 扩展才会触发，已修复并补测试。

**真实浏览器验收发现并已修复的问题（2026-11-09）**：用户在 `harness web` 里测试发现 4 处缺陷，单测都没有拦住，原因是测试停在组件和控制器层，没有覆盖 web adapter、恢复层和真实页面。修复后用 Playwright 驱动真实页面复测通过（演示环境 `tmp/hc200-demo/`，探针脚本 `tmp/hc200-demo/pw/`）。

| 现象 | 根因 | 修复 |
|---|---|---|
| 侧栏滚到底不加载下一页 | web adapter 的 intent 分发漏了 `threads-load-more`，意图没有交给控制器 | 补 `case`，并加 adapter 层测试 |
| 重新点开会话时间线为空 | 网关对已登记会话改用 `session/resume`，而界面每次打开都用返回的消息重建时间线，resume 不回放所以被清空 | `openThread` 一律用 `session/load`，删除 resume 分支与相关死字段 |
| 点开任意会话后列表塌回前 50 条 | 打开会话时 `catalogFeature.reset` 把会话目录清空，刷新只拿回第一页 | `reset` 不再清会话目录（它是工作区级的）；刷新也保留已加载的尾部 |
| 历史工具卡没有参数，失败的显示成功 | 恢复层 `restoreThread` 把工具项写死为 `arguments:""`、`status:"completed"`，且解析时丢掉了三个新字段 | 解析并映射 `tool_call_id`/`arguments`/`status`，回放卡与直播卡展示一致 |

另外：S1 的 Todo 1.10 里「刷新重连用 `session/resume`」不成立，这个客户端的界面没有保留旧时间线的机制，resume 在这里没有适用场景，已改为总是 load，`session/resume` 与 `session/close` 只保留服务端能力。

**已知限制与取舍（请确认）**

1. provider 在同一个 execution 里重复使用同一个 `tool_call_id` 时，事件卡会被改成合成 id（`runtime/execution_stream.py::allocate_tool_id`），而审批登记的是 provider 原始 id，这种极少见的情况下审批会落到兜底卡，不再靠参数猜测。这是 Spec §7.2 接受的取舍。要彻底解决，需要在 Host 里建立「provider id → 事件卡 id」的别名表，改动面较大，暂不做。
2. ACP 层的 200 轮顺序测试（`test_event_order.py`）验证的是「`tool_call` 先于 `request_permission`」，没能做出破坏验证（临时去掉屏障测试仍绿），因为进程内传输里两类帧共用一个发送队列，这里造不出乱序。真正的「改前红、改后绿」证据在协调器层的 `test_request_interaction_waits_for_event_fanout_barrier`。
3. 子代理分组复用了 activity 分组机制，没有做「缩进挂在某张父卡正下方」，也就是子代理卡会聚成一个以代理名为标题的组，紧邻其后，不是树状嵌套。
4. 回放的工具卡输出文本仍是 Transcript 里的原文，没有区分成功与失败的文案。
5. 仍未处理（S1 已登记）：`run_coordinator.cancel` 在 Run 处于 `accepted` 状态时不会取消尚未启动的执行器。

## S3 结果（2026-11-10，用户已验收）

用户按空目录三步案例自己验证：提问后按回答继续、批准计划后下拉回到原模式、拒绝并填写原因后下一句回复体现该原因。三条都通过。

提问、计划确认、拒绝并填写原因，都在 `harness web` 里走完。这三类表单只在客户端声明 `elicitation.form` 时启用。不声明时不提供计划模式，也不提供「拒绝并说明原因」。`/goal` 仍等到 S5 才在界面宣告，本停点只做脚本验证，浏览器里没有发这条命令。

填空提问是实施中补上的。模型问的是纯文本（没有选项，但允许「其他」）时，原先整张表被丢掉，工具输出变成 `(cancelled)`。现在收成一段必填文本。下面第 1 项就是靠这个修好后重测的。

| Todo | 结果 | 主要测试 |
|---|---|---|
| 3.1 表单通道 | 提问、计划、拒绝反馈、Goal 都走 `elicitation/create`；同一 Run 同时只挂一张表，第二张排队；取消时先摘掉登记再发 `$/cancel_request`，迟到回答丢弃 | `test_elicitation.py` |
| 3.2 取消交还 | Run 取消或连接断开时，待回答表单按取消交还 Host | `test_elicitation.py`、`test_server_cancel.py` |
| 3.3 提问形状 | 单选、多选、其他、多题；没有选项的填空收成必填字符串 | `test_elicitation.py`（含填空） |
| 3.4 不能提问 | 连接在、但客户端没声明提问能力时，向模型返回「当前客户端不支持提问，请自行决定或在回复中说明」，不回空答案 | `test_elicitation.py`、Host 交互适配测试 |
| 3.5 拒绝并反馈 | 声明了表单能力才出现该选项；页面按钮文案是「拒绝并反馈」，ACP 选项名仍是「拒绝并说明原因」 | `test_permissions.py`、`elicitation.test.ts` |
| 3.6 计划模式 | 有表单能力才暴露 `plan`；不支持时 `set_mode("plan")` 返回 `UNKNOWN_MODE` | `test_server_modes.py` |
| 3.7 模式回流 | 批准计划后 Host 广播 `thread.approval_mode`，测试客户端把下拉切回进入计划前的模式，且不再补发一次 `set_mode` | `test_server_modes.py`、`runtime.test.ts` |
| 3.8 Goal | 表单与「是否改过」的判定有脚本测试。浏览器未操作 | `test_elicitation.py`、`test_translate.py` |
| 3.9 审批扩展 | 声明扩展时，一次 / 本会话 / 本项目选项带 `scope`；请求明细超过 256 KiB 则截断。未声明扩展时不带这些字段 | `test_permissions.py` |
| 3.10 测试客户端 | 四种表单接入已有卡片；认不出的走通用表单。客户端声明 `elicitation.form` 和 `goal` | `elicitation.test.ts`、`acp-agent-gateway.test.ts` |
| 3.11 门槛与页面 | 见下方验证与三条查看记录 | G1–G4，Tabbit |

**浏览器**（`harness web --cwd /tmp/hc200-s3-web2`，Tabbit，任务名 HC-200 S3）。模式下拉显示的是英文 id（`plan` / `auto` / `default`），不是「先出计划」。文件树仍是预期中的 GAP-11：「当前入口暂不支持浏览工作区文件」。

工作区文件现在是：

- `hello.txt`：`hello-s3` 加换行，9 字节，没有被改成 goodbye。
- `README.md`：`本目录包含 hello.txt。`

1. 会话「先问方案再动手」。用户句是「先问我用哪种方案再动手」。提问记录为两题：
   - 「你希望我先做哪件事？请用一句话说明目标。」回答「只写 hello.txt，内容一行 hello-s3」。
   - 「确认目标后，你希望我怎么选方案？」回答「目标已经明确，你直接按最小改动开始」。
   Agent 随后写入 `/hello.txt`，回复「已创建 /hello.txt，内容只有一行 hello-s3。」
2. 会话「计划：将 README.md 写成一句话」。发送前下拉已是 `plan`。出现「审阅计划」，按钮是「批准并开始实现」（不是表单标题「批准并开始执行」）。点批准后，下拉回到进入计划前的 `auto`。同一轮里模型发现已经不在计划模式，又申请「进入计划模式」；那张卡只有「允许一次」和「拒绝」，点的是「拒绝」。这不是第 3 项。模式已经回到 `auto`，所以接着写 README 时没有再弹文件审批。注入的用户句是「用户已批准计划，Plan 模式约束已解除。……」README 写成上面那一句。
3. 同一会话把下拉切到 `default`，发送「现在把 /hello.txt 的内容改成 goodbye。不要提问，直接修改。」审批卡是「需要批准 / 文件变更需要审批」，按钮为允许一次、本会话允许、本项目允许、拒绝、拒绝并反馈。点的是页面上的「拒绝并反馈」，填写「因为会覆盖 hello-s3」。工具行是编辑 `/hello.txt` 失败、审批已拒绝。Run 为「已完成」时下拉仍是 `default`。Agent 回复：「/hello.txt 没有改成 goodbye。这次编辑被拒绝，原因是会覆盖现有的 hello-s3。文件内容仍是 hello-s3。」

中途有一次旧进程在计划卡还开着时退出，页面变成「harness web 已退出」，计划卡变成「已超时」。那一次不算。上面三条是之后那次还活着的页面上核对的。

**验证（填空题修复之后，2026-11-10）**：G1 `tests/host/acp` 443 通过；G2 `tests/host` 787 通过（既有的 Pydantic 3.14 警告，以及一条 aiosqlite 在事件循环关闭后的线程警告）；G3 `bun test tests/acp-web` 389 通过、15 跳过，`packages/cli` 的 `npm run typecheck` 通过；G4 `project:check` 与 `check:boundaries --self-check` 通过。`thread.approval_mode` 的协议生成是在加字段时检查过的，这次没有重跑生成。

## S4 结果（2026-11-10 实现，2026-11-11 用户已验收）

用户于 2026-11-11 验收停点 4。

会话配置和输入已接到 `harness web`。模型下拉、Compose 阶段条、用量和 `@文件` 在真实页面上走通。附加目录和会话 MCP 只在脚本里验证，浏览器不传这两项。

| Todo | 结果 | 主要测试 |
|---|---|---|
| 4.1 服务面 | `list_models`、`set_session_roots`、`set_session_mcp`、`authorize_existing_file` 从 Host 抽出，不读当前连接上的隐式状态 | `test_session_config_services.py`、`test_host_services.py` |
| 4.2 配置项 | `model` / `workflow` 两项；目录为空时不给模型项；new/load/resume 带 `configOptions`；握手带 `models.select` | `test_session_config.py` |
| 4.3 切换 | 切换只影响下一轮；未知项 `UNKNOWN_CONFIG_OPTION`，非法值 `INVALID_CONFIG_VALUE`；变化推 `config_option_update` | `test_session_config.py` |
| 4.4 Compose | `compose.progress` 变成标准 `plan`（需求/规格/计划/实现/检视，失败标在文案上）；`compose.summary` 变成消息 | `test_translate.py` |
| 4.5 用量 | 上下文数字齐全且有变化才发 `usage_update`；一轮结束的 `PromptResponse.usage` 单独映射 | `test_translate.py` |
| 4.6 附加目录 | 不是绝对路径、不存在、不是目录、不可信，整单拒绝并带回提交的路径；会话结束撤销 | `test_session_config_services.py` |
| 4.7 会话 MCP | stdio/http 进入下一轮合并快照；sse 和重名跳过并记诊断，诊断里没有命令、环境变量和请求头 | `test_session_config_services.py` |
| 4.8 文件内联 | 工作区内的 `file://` 读入模型输入，记录里只留 `@路径`；根外不读；超限和二进制用同一句占位 | `test_server_lifecycle.py`、`test_server_commands.py` |
| 4.9 格式对齐 | Python 附件块与页面 `resolveMentions` 的输出一致 | `inline-format.test.ts` |
| 4.10 测试客户端 | 模型和工作模式走 `configOptions`；用量走 `usage_update`；阶段条走 `plan`；整文件 `@` 额外发 `resource_link` | `acp-agent-gateway.test.ts`、`translate.test.ts` |
| 4.11 门槛与页面 | 见下方 | G1–G4，Tabbit |

**浏览器**（`bun src/index.ts web --cwd /tmp/hc200-s4-web`，实际目录 `/private/tmp/hc200-s4-web`，Tabbit 任务名 HC-200 S4）。`note.txt` 只有一行 `唯一标记：HC200-S4-CITRUS-8841`。文件树仍是 GAP-11。工作模式芯片是英文 Compose / Build。

第一次打开停在「本地 Agent 暂时不可用」：桥只留一条 WebSocket，有一条连接没被页面关掉，后面的升级都是 409。结束那条子进程后再刷新，页面进入工作台。这次没有改引导代码。

1. 模型下拉里原先选中的是 `grok / grok-4.7`。改成 `hy3` 后发「只回复一个字：好」。运行状态里当前模型是 `hy3 · auto/hy3`。时间线有一句「当前 Thread 已切换到 Hy3 (Magpie) · auto/hy3」；未来新会话的默认模型没改，因为客户端没有协商 `config.write`。回复是「好」，0 次工具调用。
2. 新建对话，空输入框按 Tab，芯片变成 Compose。发送「用分阶段协作，只做一件事：确认需求是给 note.txt 增加一行 hello」。阶段条先是需求完成、规格进行中，确认规格后变成需求完成、规格完成、计划进行中。页脚从「Compose · 规格」变成「Compose · 计划」。
3. 同一条 Build 会话连发两轮。运行状态「本轮用量」从 9,547 tokens 变成 9,876 tokens（第二轮附带 98% 缓存命中）。时间线上没有单独的 `context-updated` 行。
4. 第二轮输入 `@note.txt 解释一下。不要调用任何工具……`。回复直接写出 `HC200-S4-CITRUS-8841`，这一轮对话统计仍是 0 次工具调用，没有「读取文件」卡。
5. 附加目录和会话 MCP 没有在浏览器里操作。拒绝路径、替换撤销、stdio/http 生效和 sse/重名跳过都在第 4.6、4.7 行的 Host 测试里。

**验证（2026-11-10，浏览器之前）**：G1 `tests/host/acp` 452 通过；G2 `tests/host` 807 通过（Pydantic 3.14 警告、streamable_http 弃用警告，以及既有的 aiosqlite 事件循环关闭警告）；G3 `bun test tests/acp-web` 392 通过、15 跳过，`packages/cli` 的 `bun run typecheck` 通过；G4 `project:check` 与 `check:boundaries --self-check` 通过。浏览器验收没有再改生产代码，这四项没有重跑。

## S5 结果（2026-11-10 实现，2026-11-11 用户已验收）

用户于 2026-11-11 验收停点 5。其中包含后来补上的两处：接受目标后同一轮继续做，历史卡是「审核目标 / 已接受」；「新建对话」不再出现「未知命令：/thread.new」。

内置斜杠命令已接到 `harness web`。菜单、旁注、回退、改名、压缩和目标确认都在真实页面上走过。

| Todo | 结果 | 主要测试 |
|---|---|---|
| 5.1 服务面 | 压缩、旁注、回退、重做、回合列表、改名、目标查看/创建/变更、放弃 Compose 都从 Host 服务面走 | `test_host_services.py`、`test_thread_undo_redo.py` |
| 5.2 命令拦截 | 内置优先于 Plugin，再优先于 Skill；被挤掉的名字记 `acp.command.dropped`，不进菜单。命令不启动模型 Run，也不写入对话记录 | `test_builtin_commands.py` |
| 5.3 `/compact` | 回复带压缩前后 token，并补发 `usage_update`；线程忙时是可重试的 `THREAD_BUSY` | `test_builtin_commands.py` |
| 5.4 `/btw` | 旁注不入历史；缺问题是参数错误 | `test_builtin_commands.py`、`acp-agent-gateway.test.ts` |
| 5.5 `/undo`、`/redo` | 成功带 `historyChanged`。没有可退回合、不是 Git 仓库、没有处于回退中，各自有明确错误 | `test_thread_undo_redo.py`、`test_builtin_commands.py` |
| 5.6 `/title` | 成功后先推 `session_info_update`，再给「已改名为」；缺标题是参数错误 | `test_builtin_commands.py` |
| 5.7 `/goal`、`/abandon` | 无参数是查看；`pause` / `resume` / `clear` 带上当前目标编号和版本；创建和 `edit` 走确认卡；不支持表单时不宣告 `/goal` | `test_builtin_commands.py` |
| 5.8 Skill 命令 | 用户可调用的 Skill 以 `skill:` 加末段进入命令表，调用走普通 Run | `test_builtin_commands.py` |
| 5.9 `commands` 能力 | 来源字段在 `_meta.harnessCode`；命令响应带 `command`；目录变化后整表重发 | `test_builtin_commands.py` |
| 5.10 测试客户端 | 握手窗口里的命令表不再被丢掉；`historyChanged` 重新打开会话；旁注用临时样式 | `acp-agent-gateway.test.ts`、`translate.test.ts` |
| 5.11 门槛与页面 | 见下方 | G1–G4，Tabbit |

**浏览器**（`bun src/index.ts web --cwd /tmp/hc200-s5-web`，实际目录 `/private/tmp/hc200-s5-web`，Tabbit 任务名 HC-200 S5）。横幅有「ACP 过渡版本」。文件树仍是 GAP-11。工作模式芯片是英文 Build。默认审批是 `auto`，改文件不弹审批。

1. 输入 `/`，菜单 15 项：`compact`、`btw`、`undo`、`redo`、`title`、`goal`、`abandon`，以及 8 条 `skill:`（本机已安装的 Skill）。
2. `/btw 这个项目用什么测试框架` 打开「BTW 临时问答」。答案是看不出测试框架。关掉后正文里没有这句。刷新后重连，历史里也没有。
3. 先让 Agent 新建未跟踪的 `note.txt`（内容 `HC200-S5-CITRUS-8841`）。`/undo` 记下了回退，但文件还在：检查点是 Git 树，未跟踪文件不在树里。接着改已跟踪的 `seed.txt`。第一次回退没有把内容变回去，因为回合结束时又记了一次快照，把开始时的树盖掉了。改成同一回合只留第一次快照后，再改 `seed.txt` 为 `HC200-S5-SEED-UNDO`：`/undo` 磁盘回到 `HC200-S5-SEED-8841`，`/redo` 回到 `HC200-S5-SEED-UNDO`。时间线有刷新，但「已回退」「已重做」这两句不留在屏幕上：命令回复不进记录，刷新又把整段历史重放出来，被撤掉的那一轮仍然看得到。规格就是这样：截断发生在下一次发送，不发生在回退当时。
4. `/title 新名字` 后，侧栏标题马上变成「新名字」，正文有「已改名为：新名字」。
5. `/compact` 显示「已压缩上下文：约 602 → 602 tokens」，时间线有 `context-updated: usage (602/983616 tokens)`。这段历史太短，数字没有下降。运行状态里的「本轮用量」在这之前已经是「0 tokens (新会话)」，因为回退、重做和改名都不是模型回合，会把上一轮用量盖成 0。
6. `/goal 目标` 出现「审核目标」，按钮有「接受并开始」「驳回并反馈」。接受后第一次 `/goal pause` 显示 `error: GOAL_REVISION_CONFLICT`：暂停没有带上当前目标的编号和版本。补上之后重启页面，同一会话再发 `/goal pause`，正文是「目标已暂停」。

命令表还有一处：`session/new` 返回后紧跟着的命令表，以前会在会话登记前被丢掉，菜单是空的。现在握手窗口里先收下，菜单能出内置命令和 Skill。

手工复测又看到两处（同一天，停点 4/5 案例）：

1. `/goal 保持 seed.txt 为当前这一行` 点了「接受并开始」后直接「已完成」。确认卡收起后被画成「询问 / 已允许」，接受之后也没有启动续跑。现已在同一轮 prompt 里接着跑 `GoalContinuationRunInput`；历史卡标题是「审核目标」，状态是「已接受」。`/goal resume` 带回续跑时同样先回复再接着做。
2. 「新建对话」反复出现「未知命令：/thread.new」。ACP 命令表整表替换时丢掉了本地的 `thread.new`。替换后仍保留这条，侧栏按钮会清空当前会话。Agent 若占用了名字 `new`，按钮仍按 id `thread.new` 执行。

**验证（2026-11-10）**：G2 `tests/host` 821 通过，里面包含 ACP 宿主用例（Pydantic 3.14 警告、streamable_http 弃用警告，以及既有的 aiosqlite 事件循环关闭警告）。G3 `bun test tests/acp-web` 396 通过、15 跳过；命令表修复后的客户端类型检查已通过，这一轮没有再改 TypeScript。G4 `project:check` 与 `check:boundaries --self-check` 通过。

**复测修复后的验证（2026-11-10）**：`tests/host/acp` 467 通过。`bun test tests/acp-web` 397 通过、15 跳过；全量里「慢客户端」背压用例一次超过堆阈值，单跑通过（该用例写明全量偶发误报）。`packages/cli` 类型检查通过。目标历史卡用例在 `tests/web/presentation/timeline.test.tsx`。G4 `project:check` 与 `check:boundaries --self-check` 通过。

## S6 结果（2026-11-11，用户已验收）

收尾只改文档和官方 SDK 端到端测试，没有改生产代码。缺口表里归 HC-200 的 28 行都已关闭并写了测试名，没有待放弃的行。不进入 S7，不归档。

| Todo | 结果 |
|---|---|
| 6.1 两种端到端 | 官方 SDK 0.12.1。有表单、不声明扩展：`test_sdk_client_without_extensions_walks_question_plan_model_cancel_and_resume`。无表单、不声明扩展：`test_sdk_client_without_forms_refuses_plan_and_still_switches_cancels_and_resumes`（计划模式被拒，提问得到不支持，切模型、取消、resume 仍走通） |
| 6.1a 能力矩阵 | 写入 `docs/developer/architecture/Agent接入架构.md` §4.2 的 Harness 一行和紧随的八列表 |
| 6.2 缺口表 | `ACP通信.md` 中 GAP-01～10、16、21～24、26～28、30～39 为已关闭 |
| 6.3 架构文档 | 同文更新了方法表、扩展能力、`elicitation.py` / `config.py` / `inline.py`、UNSTABLE 说明和性能基线 |
| 6.4 用户文档 | `docs/user/Web界面.md`、`快速开始.md`、`安全与沙箱.md` |
| 6.5 真实模型 | 见下方。本停点没有新开页面 |
| 6.6 验收项 | 见下一节 |
| 6.7 门槛 | 见下方验证 |

**真实模型（与 mock 分开）**

S2、S3 已由用户在 `harness web` 确认，记录在上文。S4（2026-11-10，目录 `/tmp/hc200-s4-web`）用真实模型走过模型切换、Compose 阶段、本轮用量和 `@文件`。S5（同一天，目录 `/tmp/hc200-s5-web`）走过命令菜单、旁注、已跟踪文件的撤销/重做、改名、压缩和 `/goal pause`。

同一天后来修了两处，自动化已通过。用户于 2026-11-11 验收停点 5 时，这两处一并通过：

1. 接受目标后应在同一轮继续做，历史卡是「审核目标 / 已接受」。
2. 「新建对话」不应再出现「未知命令：/thread.new」。

页面上仍然如此，不算本停点做完：文件树是 GAP-11；审批模式 id 是英文；未跟踪文件不在 `/undo` 的 Git 树里；「本轮用量」是最近一轮模型的 token，不是一条一直跟着上下文大小走的水位。

**验证（2026-11-11）**：G1 `tests/host/acp` 469 通过（比停点 5 多了上面两条端到端；Pydantic 3.14 警告）。本停点没改 Host 方法，也没改测试客户端，G2、G3 没重跑。

性能探针（临时 HOME，不是门槛）：空库 5 轮，`initialize` 中位 1057 ms，`session/list` 中位 44 ms；200 条线程 3 轮，`initialize` 中位 1082 ms，`session/list` 中位 36 ms。冷启动仍高于 0.6 秒。真实线程库和整页打开时间这次没测。

G4：`npm run project:check` 与 `npm run check:boundaries -- --self-check` 通过。

## S7 结果（2026-11-11，用户已验收）

对照代码做了原有功能覆盖核对，没有改生产代码，也没有实现新缺口。

矩阵在 `docs/developer/architecture/ACP通信.md` 的「原有功能覆盖矩阵」。新缺口是 GAP-40 到 GAP-47，状态都是「未开始」。文件树、Git、设置、技能、插件、MCP 管理、代码索引、Trace、输入历史、刷新停任务仍用原来的 GAP-11 到 GAP-20、GAP-25、GAP-29，没有重复编号。

**结论：TUI 现在还不能在功能上被 ACP 链路替代。** 对话本身可以：流式回复、工具卡、取消、审批、提问、计划、目标、切模型、Compose、压缩、旁注、撤销最近一轮、改名、Skill 调用，都已经有标准 ACP 或斜杠命令。还差这些：

- 平台：文件树、Git、输入历史、活进程接管（GAP-11、12、25、20、46）。
- 管理面：设置、技能、插件、MCP 增删、代码索引、Trace、插件同意（GAP-13 到 19、45），建议继续归 HC-201。
- 交接：第二个查看者接手同一运行（GAP-47，HC-196）。
- 只有 Harness 有的操作：选更早回合再撤销、Agent 列表、Team、`/new-work`、直接 shell（GAP-40 到 44）。做不做由你看过清单再定，本任务没有建新任务。

**验证**：本停点只改文档。G1、G2、G3 没重跑。G4：`npm run project:check` 与 `npm run check:boundaries -- --self-check` 通过。`openwiki code --update --print` 本机没有该命令，退出 127，没有安装，也没有手改 `openwiki/`。

## 验收结果

用户于 2026-11-11 验收本任务。停点 2 至 7 都已验收。下面前三项勾上的是交付边界：行为仍归 HC-197、HC-196，本任务没有把未实现的能力记成已经做到。

- [x] 通用 acp-runtime 可启动实际 Python Harness ACP 进程，执行沿用内核唯一运行/终态与工具策略。等 HC-197。本任务只提供可对接的 `harness acp`。用户已验收这个边界（2026-11-11）。
- [x] ACP 建会话由 Agent 内部创建 Thread，对外只返回原生标识；平台和 Java 不读取 Harness SQLite/内部类型。`session/new` 的 `sessionId` 就是 Agent 生成的线程 id（`test_server_lifecycle.py`）。本任务没有让平台或 Java 去读 Harness 的库。
- [x] 流式消息、工具、取消、审批/提问经协议接续，换查看用户或关闭窗口不会丢失原执行通道。协议上的取消和恢复已有测试，但关掉 `harness web` 仍会停掉进程里的运行（GAP-20，等 HC-197）。用户已验收这个边界（2026-11-11）。
- [x] 原设备在线时用户 B 接手仍沿用同一 Agent 原生上下文，重启后按宣告能力恢复，历史回放不重复。等 HC-196。用户已验收这个边界（2026-11-11）。
- [x] Agent 异常、取消、恢复失败和不支持能力明确反馈，不在云端再建一套模型循环兜底。`test_server_failure.py`、`test_server_cancel.py`、`test_server_resume_close.py` 的找不到会话和忙、`test_server_modes.py` 的 `UNKNOWN_MODE`。本任务没有加第二套模型循环。
- [x] 不安装或不启动 Harness 时通用平台与其他 ACP 后端仍正常，Python 不进入基础平台安装/检查前置。桌面安装仍不依赖 Python，见 `docs/user/快速开始.md`。本停点没有把 `packages/agent` 放进新平台安装。
- [x] 内网 SDK 与配置逻辑保持既有约束；外部环境缺少私有包时记录实际限制，不替换生产 Trace 来源。本停点没有改 Trace 来源，也没有改内网 SDK 选择。缺私有包时的限制仍以既有环境记录为准，这次没有新的私有包环境可测。
- [x] 客户端不声明 `_meta.harnessCode` 扩展时（扩展本身保留），每个已实现功能仍能用标准 ACP 完整走通，只少增强显示（官方 SDK 客户端不声明扩展的端到端测试）。证据：`test_sdk_client_without_extensions_walks_question_plan_model_cancel_and_resume`。没有表单能力时计划模式和提问按 Spec §8.6 降级，见 `test_sdk_client_without_forms_refuses_plan_and_still_switches_cancels_and_resumes`。
- [x] 原有功能覆盖矩阵已写入 ACP通信.md，未覆盖项都已登记进缺口表并有去向，并给出「TUI 能否在功能上被 ACP 链路替代」的结论。见「S7 结果」。结论是还不能替代，差平台面板、管理面、交接，以及 GAP-40 到 GAP-44。

## 验证与后续流程

Python/TypeScript 双端以 mock 模型验证真实 ACP 进程、取消/恢复和人工交互，另记录真实 Agent 手工互通；真实模型和私有 SDK 证据分别留存。

本 Task 确认后先写同名 Spec；Spec 确认后写 Plan/Todo，并按可演示停点实施。继续遵守用户跳过 Skill 调用的要求，不因生成任务而直接写生产代码、认领分支或改变其他任务状态。当前只有任务文档，未运行上述产品验收。
