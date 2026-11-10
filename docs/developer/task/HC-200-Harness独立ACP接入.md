---
id: HC-200
title: Harness独立ACP接入
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Codex
priority: P1
status: 进行中
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

先与 [HC-197](./HC-197-通用ACP运行时.md) 固定 ACP 能力/生命周期/扩展交界，再在 Agent 包独立做适配，不等协作 UI 或 [HC-196](./HC-196-设备接入与本机执行.md) 全部完成。真实 Runner 接入与跨用户原会话接续仍需 HC-197/196 对应停点，独立协议冒烟不能替代它们。

不把用户、设备、工作区、交接和 @引用业务加入 Python 内核；不模拟 TUI 输入，不经过旧 CLI 或把 JSON-RPC v3 改名成 ACP。不重写模型循环或交换其他 Agent 的私有检查点；Trace/专有设置的外层集成归 HC-201。

## 并行认领与接口交付

主责 Harness Python ACP 入口和必要内核适配，生产改动不进入通用 Runner/Java/UI。与 HC-197 共享协议进程场景，与 HC-201 明确 stderr/扩展归属和能力；Trace 解析与 UI 由 HC-201，不能两边采集同一日志。

可与设备/项目/对话/导航及 HC-201 的解析/视图迁出并行，接口约定在 Spec 审查后执行。内网包缺口保留原逻辑，测试结论按实际环境记录；共享装配由统筹协调，见[并行开发约定](../project/协作任务并行开发约定.md)。

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

## S2 结果（2026-11-09 实现，用户已确认查看方式）

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

## S3 结果（2026-11-10，用户已确认）

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

## 验收结果

- [ ] 通用 acp-runtime 可启动实际 Python Harness ACP 进程，执行沿用内核唯一运行/终态与工具策略。
- [ ] ACP 建会话由 Agent 内部创建 Thread，对外只返回原生标识；平台和 Java 不读取 Harness SQLite/内部类型。
- [ ] 流式消息、工具、取消、审批/提问经协议接续，换查看用户或关闭窗口不会丢失原执行通道。
- [ ] 原设备在线时用户 B 接手仍沿用同一 Agent 原生上下文，重启后按宣告能力恢复，历史回放不重复。
- [ ] Agent 异常、取消、恢复失败和不支持能力明确反馈，不在云端再建一套模型循环兜底。
- [ ] 不安装或不启动 Harness 时通用平台与其他 ACP 后端仍正常，Python 不进入基础平台安装/检查前置。
- [ ] 内网 SDK 与配置逻辑保持既有约束；外部环境缺少私有包时记录实际限制，不替换生产 Trace 来源。
- [ ] 客户端不声明 `_meta.harnessCode` 扩展时（扩展本身保留），每个已实现功能仍能用标准 ACP 完整走通，只少增强显示（官方 SDK 客户端不声明扩展的端到端测试）。
- [ ] 原有功能覆盖矩阵已写入 ACP通信.md，未覆盖项都已登记进缺口表并有去向，并给出「TUI 能否在功能上被 ACP 链路替代」的结论。

## 验证与后续流程

Python/TypeScript 双端以 mock 模型验证真实 ACP 进程、取消/恢复和人工交互，另记录真实 Agent 手工互通；真实模型和私有 SDK 证据分别留存。

本 Task 确认后先写同名 Spec；Spec 确认后写 Plan/Todo，并按可演示停点实施。继续遵守用户跳过 Skill 调用的要求，不因生成任务而直接写生产代码、认领分支或改变其他任务状态。当前只有任务文档，未运行上述产品验收。
