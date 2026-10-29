# Harness Code 双模型协作（Fusion）设计与实现

> P0 闭环已实现。开发基线：Harness Code `dev_wdl / 68afe9f`，dsh-model-fusion `fcb2693`；协议更新至 **v3.11**。实施与测试记录见 [HC-183 Task](../task/archive/HC-183-双模型协作.md)。HC-189 已补角色用量、配置价格估算、只读探索和重复失败提示；缓存保活、运行中直接插话、Lead 写入接管、跨任务 checkpoint 复用未启用。
>
> 本文同时说明设计和实际代码。代码位置以“文件 + 符号”定位；`packages/...` 相对 Harness Code 仓库，`src/...` 相对 dsh-model-fusion 仓库。使用方法见 [模型配置](../../user/模型配置.md#fusion-双模型组合)。

## 一、背景与目标

### 1. 从 dsh-model-fusion 借鉴什么

**Lead 负责理解要求、派单和审阅；Sidekick 负责执行和返工；Host 负责权限、检查和记录。** Lead 通常选择能力更强的模型，Sidekick 通常选择成本较低的模型。角色名称本身不能保证模型强弱。

本方案依据 dsh-model-fusion 的实际代码功能制定：

| 核心能力 | DSH 源码 | Harness Code 对应实现 |
| --- | --- | --- |
| 固定两个真实模型 | `host/native-selection.ts`、`host/settings.ts` | `config/fusion.py`、`runtime/fusion/profile.py` |
| 判断、派单、直接问答和审阅 | `host/coordinator.ts` | `runtime/fusion/service.py` |
| 返工继续同一个子会话 | `host/native-worker.ts` | `host/fusion_worker.py::FusionWorkerRunner.run` |
| Host 运行检查，Lead 逐项验收 | `host/native-checks.ts`、`evidence/gate.ts` | `runtime/verification.py`、`runtime/fusion/acceptance.py::FusionAcceptance.review` |
| 只读 Lead、单写者、持久化和安全恢复 | `host/native-role-sandbox.ts`、`execution/write-lease.ts`、`task/sqlite-store.ts`、`recovery/reconcile.ts` | `roles.py`、`guard.py`、`store.py` |

Harness Code 复用现有 ModelProfile、AgentEnginePool、ManagedAgentExecutor、Snapshot 文件工具、审批和 ThreadPersistence，没有新建模型客户端或另一套 Run 系统。

### 2. 首版完成范围

- 通过 `/fusion <组合ID>` 选择双模型；普通问答由 Lead 直接完成。
- 改码任务交给 Sidekick；返工保留原子会话和历史。
- Host 核对文件并执行可信配置里的检查，Lead 对用户要求逐项审阅。
- 支持查询、继续、取消；结果不明时保留现场，必须先人工核查。
- CLI/TUI/Web 使用同一个 Feature、Gateway 和状态投影。

首版支持**本地工作区的 Build 用户消息**。远程执行 backend、Goal、Compose、Skill 和 Plan 不能与 Fusion 混用；远程配置在创建任务前明确拒绝。普通运行仍使用原有流程，包括已有 `experimental.delegation`。

## 二、设计思路

### 1. 主流程

~~~mermaid
flowchart TD
    A[用户提出需求] --> B[Host 固定两个模型和原有权限]
    B --> C[Lead 判断]
    C -->|只需回答| D[直接完成：未自动验证]
    C -->|需要改码| E[保存任务单和基线快照]
    E --> F[Sidekick 修改并提交报告]
    F --> G[Host 核对范围并运行检查]
    G --> H[Lead 逐项审阅]
    H -->|接受| I[记录完成并交还工作区]
    H -->|返工| J[反馈到同一个 Sidekick]
    J --> F
    H -->|需要用户处理| K[保存现场并等待用户]
    F -->|操作结果不明| L[保留写者，等待人工核查]
    G -->|操作结果不明| L
~~~

**任务单**保存用户原话、要求、目标、步骤、可改路径和检查 ID。**报告**只说明 Sidekick 做了什么。**审阅票据**由 Host 生成，绑定当前文件、任务单版本、报告和真实检查记录。Sidekick 自报“测试通过”不能代替 Host 的检查。

### 2. 五条实现原则

1. **沿现有 Run 启动。** `run.start` 增加 `fusion_profile_id`；受理、审批、取消和事件仍由 RunCoordinator 管理。
2. **从原始权限派生两个角色。** 先取得用户基础 Spec，再分别限制 Lead 和 Sidekick；不能从只读 Lead 派生可写 Sidekick。
3. **会话稳定，执行分轮。** 一个任务固定一个 Sidekick 会话和 checkpoint，每轮创建新的 execution ID。
4. **完成必须经过程序门禁。** 问答要调用直接完成工具，改码要通过检查和逐项审阅，不能只凭模型最终文本宣布成功。
5. **不重放结果不明的操作。** 超时、断开和取消不能证明命令停止，必须留下操作记录和写者占用。

## 三、整体架构

~~~mermaid
flowchart LR
    UI[CLI / TUI / Web] --> P[Protocol v3.11]
    P --> H[AgentHost / BuildRunAdapter]
    H --> L[Lead AgentEngine]
    L --> S[FusionService]
    S --> R[Host FusionRuntime]
    R --> W[Managed Sidekick]
    R --> V[共享检查执行器]
    S --> DB[Thread SQLite]
    W --> G[文件与命令守卫]
    V --> G
    S --> C[快照和审阅门禁]
~~~

### 1. 模块与代码入口

下表是实际实现位置。Python 路径相对 `packages/agent/harness_agent/`。

| 模块/符号 | 负责什么 | 改动时一起检查 |
| --- | --- | --- |
| `config/fusion.py`、`config.py`、`config_manifest.py` | 可信配置、合并、引用校验和脱敏摘要 | 用户模板、配置测试 |
| `runtime/fusion/profile.py::resolve_fusion_profile` | 校验两模型、目录和池容量，冻结本任务输入 | 配置指纹、恢复比较 |
| `runtime/fusion/roles.py::resolve_fusion_specs` | 从基础 Spec 分别派生角色和实际模型 | 能力白名单、提示词、Profile 指纹 |
| `runtime/fusion/tools.py::create_fusion_tools` | 模型可见的七个控制工具 | `tool_risk.py`、`approval_policy.py` |
| `runtime/fusion/service.py::FusionService` | 派单、探索、返工、续接和最终输出门禁 | 状态机、票据、失败测试 |
| `runtime/fusion/acceptance.py::FusionAcceptance` | 独立检查、快照、票据和逐项审阅 | 真实命令、重检和来源变化 |
| `host/fusion_worker.py::FusionWorkerRunner` | 实施/探索执行、独立 checkpoint、真实子审批及取消收尾 | 原生 Host、registry、Pool、取消 |
| `runtime/model_usage.py`、`runtime/fusion/usage.py` | 已观测用量与价格估算，未知值不算零 | 重试、恢复、缓存和价格完整性 |
| `runtime/fusion/store.py::FusionStateStore` | 任务、文件预留、排队、派发、证据及停止记录 | schema 验证、事务和崩溃测试 |
| `runtime/fusion/snapshot.py` | 独立文件快照、路径规范化和改动清单 | 范围快照、源码版本、不跟随 symlink、严格失败 |
| `runtime/fusion/guard.py` | 文件准备/提交守卫与 Shell 副作用登记 | Snapshot 文件契约、审批恢复、停止确认 |
| `host/fusion_runtime.py::FusionRuntime` | Host 装配、角色冻结和检查端口 | Pool、registry、索引和 checkpoint 生命周期 |
| `runtime/verification.py::ManagedVerificationPort` | 共用 backend、权限、审批、超时和执行锁 | Compose 调用方；旧 `compose/verification.py` 已删除 |
| `host/agent_host.py`、`run_coordinator.py`、`run_execution.py` | 启动、幂等绑定、RPC、Run 事件和取消 | 普通 Build、Shell、Goal、Compose 和旧连接 |
| `threads/thread_persistence.py::fusion_state_store` | 复用共享 SQLite 连接与项目隔离 | 数据库打开、验证和关闭 |

跨进程契约以 `packages/protocol/schema/v3.json` 为唯一来源，用 `npm run protocol:generate` 生成两端类型、校验器和 fixture。界面入口为 `packages/cli/src/interactive/features/fusion-feature.ts`，经 Gateway/IPC 调 Host；`fusion-summary.ts` 和共享 reducer 同时服务 TUI/Web。

### 2. 状态归属

- **可信 TOML**：模型组合和检查命令；不能由模型临时改写。
- **冻结配置**：当前任务真正使用的模型、目录、超时和指纹。
- **SQLite**：任务、任务单、报告、检查、票据和写者的事实来源。
- **RunContext**：本轮任务、角色、取消、审批及写者代号。共享 Engine 不捕获任务私有状态。
- **CLI 状态**：当前 Thread 的选择和 Host 状态展示，不决定任务是否完成。

## 四、详细设计

### 1. 配置与启动

在已有 `[config] version = 1` 的用户配置或显式 `--config` 文件中追加；`pro`、`fast` 必须已定义：

~~~toml
[fusion.profiles.default]
lead_profile_id = "pro"
sidekick_profile_id = "fast"
check_plan_ids = ["unit"]
max_rework_rounds = 3

[fusion.check_plans.unit]
command = "python -m pytest"
cwd = "."
timeout_seconds = 300
~~~

配置按组合/检查 ID、再按字段合并，显式文件覆盖用户文件，列表整项替换。未知字段、无效引用、重复检查 ID、空命令、负数返工上限和非正超时都拒绝。检查 `cwd` 必须是工作区内存在的相对目录。Fusion 不自动读取项目 TOML，也不提供 `config.write` 或独立环境变量入口。

启动顺序：**验证 Build 入口及 Goal/Plan 状态 → 冻结模型与检查 → 比对活动任务 → 派生两个 Spec → 准备 Lead Run**。

- 两模型需要现有凭据及 `tool-calling`、`streaming` 能力；缺少能力或密钥直接拒绝，不换模型。
- `runtime_pool.max_profiles >= 2`；Lead 等待子执行时仍占用根 Engine。其他固定占用可能继续触发现有容量错误。
- 允许两角色引用同一模型，但角色 Spec 和权限仍分别计算。
- 任务保存安全配置指纹。模型、检查、目录等改变后不能直接继续旧任务；单纯轮换密钥不改变指纹。
- 原始密钥、endpoint、Header 和检查正文不进入 Fusion 状态摘要；只在既有 Provider/执行配置中使用。
- Fusion Run 不使用实验委派覆盖，也不装配普通子代理、MCP、Skill 或 Plugin Hook。

### 2. 角色与控制工具

| 角色 | 可用能力 | 程序限制 |
| --- | --- | --- |
| Lead | 用户原有的读、搜索、代码索引、提问及 Fusion 控制工具 | 无文件写、Shell、普通 `task`、MCP、Skill 和记忆写入 |
| Sidekick | 用户原有的读、Snapshot 文件写、命令和报告工具 | 无再次派单、用户提问、计划切换和自行完成任务 |

工具既注入 `extra_root_tools`，也登记角色能力和风险分类。派单/返工按 `AGENT` 风险走原有审批；Sidekick 文件和命令仍分别审批。审批通过后，真正执行前再次核对当前权限和 Plan 约束。

| 工具 | 调用者 | 参数与结果 |
| --- | --- | --- |
| `fusion_finish_direct` | Lead，未派单 | `summary`；完成直接问答，标为 `unverified` |
| `fusion_delegate` | Lead，`READY` | `goal`、`brief`、`allowed_paths`、`check_plan_ids`；执行首轮并返回票据或待处理状态 |
| `fusion_rework` | Lead，可返工状态 | `feedback`；可选 `allowed_paths`、`reason`；向原 Sidekick 追加反馈 |
| `fusion_review_result` | Lead，`REVIEWING` | `ticket_id`、`decision=accept/reject`、逐项 `requirements`、`test_review_reason` |
| `fusion_status` | 两角色 | 无参数；读取任务要求、范围、检查和票据 |
| `fusion_submit_result` | Sidekick，执行中 | `status=completed/blocked/incomplete`、`summary`、`unresolved`；保存本轮报告及提交时的文件摘要 |

### 3. 任务单与持续 Sidekick

首轮派单示例：

~~~json
{
  "goal": "修复重复写入",
  "brief": "保留现有接口，修正去重逻辑并补充用例",
  "allowed_paths": ["src/store.py", "tests/"],
  "check_plan_ids": ["unit"]
}
~~~

Host 从任务创建时保存的 `source_message` 直接生成原文引用和 `r1/r2/...`，模型不再传 `user_requirements`。单段需求保存为一项，明确的行首列表按原文边界拆分；最多 32 项，超出时保留完整尾段，不截掉需求。实施建议只写在 `goal/brief`。`check_plan_ids` 只能选组合允许的检查，空列表表示使用组合的全部检查。

`allowed_paths` 使用**项目相对路径**，支持精确文件或以 `/` 结尾的目录。文件和目录可以尚不存在，由 Sidekick 创建；不需要用户先建空文件。例如，新增两个文件时填写 `["calc.py", "tests/test_calc.py"]`，允许在新目录中改码时填写 `["new/"]`。读取工具中的 `/calc.py` 是虚拟路径，不能直接作为派单范围；派单时应写 `calc.py`。

派单或返工的路径格式错误会返回 `FUSION_PATH_INVALID`，同时标出 `allowed_paths` 和正确格式提示。拒绝绝对路径、`..`、glob、symlink 路径以及 `.git`、`.harness-index`；错误参数不会派发 Worker 或改变任务状态。

首轮基线只取一次，返工继续与这份基线比较。返工先规范化全部路径，再用 path_allowed 判断是否真正增加权限：空列表、重复原范围、原目录内的子路径都沿用原任务单，不要求扩权原因，也不增加 revision。只有实际扩范围才要求 reason 并增加 revision；每轮仍更新 generation，使旧轮授权和旧票据失效。非法路径不会因已授权 ./ 而跳过校验。返工次数按组合限制，超过上限进入等待状态。

`run_worker` 每轮登记新的 execution ID；checkpoint ID 根据项目、Thread、任务和 `worker_session_id` 稳定计算。执行前比对历史身份和上一轮完整结束的 checkpoint 标记。正常结束后出现丢失、覆盖或不匹配时拒绝执行；若本轮已明确停止并记录中断，则只恢复上一完整 checkpoint。第一轮从未完整结束时，可保留文件和任务单、清理半轮上下文后重新准备；不重放待执行的旧工具。

子执行复用 Managed 执行器、父取消信号、真实审批和用量账本。审批携带该轮子 execution ID，不能混到根执行。索引查询租约由每轮自行借用和释放；文件读取快照也每轮关闭。任务未终结时保留 Worker checkpoint，完成或取消后清理。

### 4. 文件并行、命令协调和验收

**文件预留**表示任务本轮可以修改哪些文件。以真实启动目录为键，SQLite 按任务保存整组 `allowed_paths`。不同文件可并行；同名文件、目录与子文件、整个 `./` 目录相交时排队。已存在目录统一补 `/`；大小写及 Unicode 等价路径按冲突处理，实际写权限仍严格匹配路径。新文件可以直接声明，符号链接、越界路径和内部数据路径拒绝。

- `wait_for_lease` 一次申请整组范围。返工扩大范围时先交回旧组再申请，避免两个任务各拿一半互相等待。
- 冲突进入 `WAITING_RESOURCE`，保存未派发任务单，异步轮询短事务；没有数据库锁、Host 工具锁跨等待持有。范围可用后自动 `start_round`，只派发一次。
- 等待请求保存心跳。过期只失去排队顺序，活跃请求会重新入队；文件预留和执行中、结果不明的操作不会按超时释放。
- 新一轮或换写入角色递增 `generation`。文件准备和提交都检查角色、阶段、范围、revision、generation 及原文件版本（CAS）。写前拒绝记录“未开始”，不能变成假的未知操作。
- 暂停且确认停止后交回范围；取消清理排队请求、保留文件。取消排队后的提问只读；明确继续可恢复，具体返工反馈先交给 Lead。Sidekick 尚未启动的派发保留 `prepared`，不能误判成已执行。

**实际操作队列**由 `resources.py::FusionResources` 提供：文件操作只协调相关路径；命令和快照屏障临时协调整个启动目录的实际写入，确认结束后释放。Fusion 命令等待实际文件操作，不等待其他任务长期预留，避免两个并行任务在检查时互锁。普通无范围命令需等所有任务交回文件；这些任务的收尾可越过等待中的普通命令，防止反向阻塞。

所有写入口共用此队列：原生 Snapshot 文件工具、图工具及内联子执行、Direct Shell、Compose 检查、历史撤销/重做。取得跨进程操作许可后才取本地工具锁；审批在申请许可之前完成，执行前重查审批与权限。控制工具自身不持有长命令许可。

已确认停止自动释放；未知文件操作只保护其路径，未知命令保护启动目录。Host PID 已不存在时，只把运行记录转成可核查的 `unknown`，不释放权限，也不宣称子命令停止。迟到的可信停止回执可以释放保护；已人工核查的记录不能被迟到回调复活。

**快照**由 Host 计算。任务基线和候选只包含当前范围；扩范围时保留旧范围的原始基线，只为新文件取样。其他任务的文件变化不算本任务越界。命令另取源码快照核查范围外改动；Git 仅列举文件，不创建临时 index。常见缓存和依赖目录默认跳过，显式声明的文件仍参与比较。文件内容、类型和模式变化均计入摘要。

**检查**只运行冻结配置的命令。`ManagedVerificationPort.prepare` 先完成权限与审批，返回只能执行一次的动作；随后整组检查共用一个命令许可，逐项保存停止回执、源码摘要与 `verification_cycle`。已开始却缺少回执的检查不自动重放；退出码非零、源码被检查改动或停止不明，不能验收。

已保存检查仅在同一源码版本复用。另一任务改了源码时，重新检查并生成新票据，交 Lead 再确认；不重跑 Sidekick、不消耗返工轮次。最终接受在快照屏障内重查候选和源码摘要，再写审阅记录并完成任务。

**审阅票据**绑定任务单 revision、报告、候选摘要和检查记录。接受前必须重新计算文件摘要，并确认：

1. 没有范围外改动、未解决事项或尚未停止的副作用。
2. 计划检查全部成功且未改源码；旧票据不能用于新一轮。
3. 每条用户要求都有 `satisfied=true` 和 `file:相对路径` 或 `check:检查ID` 证据。
4. 本轮涉及测试文件时，Lead 填写测试审阅理由。

验证状态：有检查并全部通过为 `verified`；没配置检查但通过 Lead 审阅为 `review_only`；直接问答或尚未验收为 `unverified`。界面区分“检查通过，等待审阅”和“检查及审阅通过”。

**边界：**Shell 任意程序的每次文件操作无法靠参数白名单完全限制，首版依靠现有沙箱、审批及提交后快照核对；独立文件系统隔离属于后续能力。外部编辑器、独立数据目录下的其他实例以及 Git 忽略的范围外生成物不受这份 SQLite 写者锁直接约束，不能把该锁描述为系统级文件锁。

### 5. SQLite 与安全恢复

复用用户数据目录下的 `threads.sqlite3`。任务及证据按 `project_fingerprint` 隔离；同一项目 Thread 只保留一个活动任务；更新比较 `expected_version`，过期请求拒绝。网络、模型、审批和命令不持有数据库事务锁。

| 表 | 内容 |
| --- | --- |
| `fusion_tasks` | Thread、任务、阶段、active、version、模型摘要、当前任务单/报告/票据、会话身份 |
| `fusion_orders` | 不可覆盖的任务单 revision、用户原话、要求、范围、检查及首轮基线 |
| `fusion_outbox` | 唯一派发操作，`prepared/dispatched/accepted/result_recorded/not_started/stopped/inspected` 状态 |
| `fusion_messages` | 与派发操作绑定的原消息和 revision，恢复时核对消息摘要 |
| `fusion_evidence` | 报告、检查回执、票据和审阅记录 |
| `fusion_effects` | 操作 ID、execution、类型、参数摘要、任务版本、代号、结果与停止确认 |
| `fusion_reservations` | 每任务预留路径、所属角色和代号 |
| `fusion_generations` | 每个真实启动目录单调递增的授权代号 |
| `fusion_access` | 按序申请的实际操作、状态、停止关联、Host PID 与排队心跳 |

副作用先记录 `running`，再真正执行；只有确认停止才记成功/失败。结果不明保留 `unknown` 和写者。初始化时验证列、主键以及活动任务部分唯一索引，结构不符明确报错。

| 阶段 | 含义与下一步 |
| --- | --- |
| `READY` | 尚未派单；直接答复或派单 |
| `WAITING_RESOURCE` | 文件范围冲突；程序等待并自动继续，可取消 |
| `WORKER_RUNNING` | Sidekick 执行；报告后检查，阻塞时等待 |
| `CHECKING` | Host 检查；结果明确后审阅，不明则暂停核查 |
| `REVIEWING` | Lead 接受、拒绝或返工 |
| `PAUSED/WAITING_USER` | 保存现场；没有未停操作或未结束派发时自动让出目录；原 Thread 新消息明确继续 |
| `OUTCOME_UNKNOWN` | 展示待核查操作；记录人工确认前拒绝继续、返工和释放写者 |
| `COMPLETED/CANCELLED` | 任务终结，清理 Worker checkpoint 并交还工作区 |

状态查询与重连只读取和核对事实，不启动模型或命令。**用户发出新的 Fusion Run 才执行 `continue_pending`：**

| 已保存的事实 | 实际恢复动作 |
| --- | --- |
| 消息仍为 `prepared`，确认本轮子执行未启动 | 沿原操作、轮次和会话派发原消息 |
| Worker 已完整结束，checkpoint 身份和结束标记一致 | 允许在同一会话追加返工 |
| 报告已保存，派发已结束，检查未开始 | 核对报告时文件摘要后，只运行检查 |
| 部分检查回执已保存 | 源码版本一致时复用回执；源码变动则重新检查，缺失停止回执仍等待核查 |
| 票据或全部检查已保存，Lead 尚未接受 | 核对文件；源码版本变化则重新检查并发新票据，不重跑 Worker |
| 派发或副作用是否结束无法确认 | `OUTCOME_UNKNOWN`，保留写者和待核查操作 |
| 已明确停止的中断轮次 | 恢复上一完整 checkpoint；首轮没有完整记录时保留文件后重新准备，不重放半轮工具 |
| 未确认中断却发生历史缺失、不一致 | `WAITING_USER`；拒绝用空历史冒充完整会话 |
| 文件已被外部修改 | 旧票据失效，等待 Lead 返工或用户处理 |

人工恢复只记录核查说明摘要和“操作已停止”的声明，使任务进入 `PAUSED`；不会认定代码正确，也不会自动重放操作。取消任务不回滚工作区文件。

### 6. 协议与用户交互

| 契约 | 行为 |
| --- | --- |
| `run.start.fusion_profile_id` | minor 11 起支持；只允许 Build 用户消息，拒绝同时指定主模型 |
| `fusion.status(thread_id)` | 返回活动任务，或最近终结任务的安全状态和待核查操作 |
| `fusion.recover(task_id, expected_version, inspection_note, effects_stopped)` | 只在空闲 Thread 上记录明确的人工停止确认 |
| `fusion.cancel(task_id, expected_version, stopped_inspection_note?)` | 核对版本，停止当前所属 Run，再按持久化停止事实终结任务 |
| `fusion.progress` | 沿已有 Run 事件流投影安全状态和版本 |

新增 `fusion.read`、`fusion.manage`；管理方法走原有控制权机制。旧 minor 连接不接收整个 Fusion Run 流，防止只过滤新事件后产生序号缺口。普通 Run 事件不受影响。

~~~text
/fusion default                      选择组合；下一条需求启动 Fusion
/fusion status                       查看阶段、两模型和待核查操作
/fusion off                          无活动任务时退出选择
/fusion cancel                       结束当前任务，保留已经修改的文件
/fusion cancel --stopped <核查说明>   确认停止后直接结束当前任务
/fusion resolve                      在当前会话结束占用目录的另一任务
/fusion resolve --stopped <核查说明>  确认停止后结束占用任务
/fusion recover --stopped <核查说明>  确认相关操作停止后记录恢复
~~~

当前 Run 的普通取消只暂停任务；活动任务不能静默退出、换组合或启动普通改码。继续时在同一 Thread 发新消息，先读取 `fusion_status`，再审阅或返工。恢复与切换 Thread 后，共享 Controller 从 Host 恢复任务选择，不让 CLI 的旧状态决定任务身份。

`runtime/fusion/followup.py` 集中区分查看、继续原操作和新修改。暂停排队后的“继续返工，把问题修好”“请让 Sidekick 返工”等明确指令恢复 Lead 控制工具。只有不带新反馈的明确继续指令设置 `FusionRunBinding.resume_pending`；Build 运行器才会在模型前调用 `continue_pending`。带新反馈时先让 Lead 处理，不自动重放旧派单或检查。疑问、否定、引用及先核查再决定的条件句不会恢复排队；OUTCOME_UNKNOWN 始终只读，指令分类不代替停止核查和工具审批。

### 7. 验证与后续维护

| 测试位置 | 验证内容 |
| --- | --- |
| `tests/config/test_fusion_config.py`、`tests/runtime/test_fusion_profile.py` | 合并、引用、可信来源、冻结和脱敏 |
| `tests/runtime/test_fusion_roles.py`、`test_fusion_guard.py` | 原始权限派生、Lead 禁写、路径、提交和命令结果 |
| `tests/runtime/test_fusion_store.py`、`test_fusion_snapshot.py` | CAS、文件并行、自动排队、schema、迁移、重启及范围快照 |
| `tests/runtime/test_fusion_service.py`、`test_verification_shared.py` | 越界/漂移/失败拒收、逐项审阅、检查续接、终态释放 |
| `tests/host/test_fusion_run.py`、`test_fusion_execution.py` | 真实 Host/Pool/图/工具链，两模型、同会话返工、真实审批、取消、恢复与历史一致性 |
| `packages/cli/tests/interactive/fusion-feature.test.ts`、`tests/ipc/` | 共享入口、选择、恢复、中文状态、协议和双端帧 |

测试使用可控模型、虚构凭据和临时工作区。所有最终命令、全量结果及已有基线问题记录在 Task；不得把 Mock 测试描述成真实商业模型联调。

继续扩展时优先保持这些约束：共用模型/Run/审批路径；以数据库和当前文件决定状态；对副作用先登记、再执行；角色能力、协议、测试和用户说明同步修改。后续能力以对应 Task/Spec 确认范围和验收标准。

## 五、现行规则与历史背景

文件协调、审阅与恢复以第 4 节为准。旧的整目录单写者和早期补丁流程已移入 [历史记录](../project/Fusion历史改造记录.md)，不再作为当前操作方法。

## 六、两角色实时过程（2026-10-21）

Lead 和 Sidekick 共用一页时间线，按执行顺序显示独立的角色过程区。返工产生新的 Sidekick 执行和轮次；Lead 随后审阅时显示在其后，不能为排版把记录重新排序。

```text
FusionWorkerRunner.run
  → FusionWorkerObserver.emit_status(running)
  → ManagedAgentExecutor(passthrough) → 实时正文 / 工具事件
  → emit_status(completed / failed / cancelled)
  → 父 Run 的统一事件通道与 JSON-RPC event
  → applyFusionExecutionEvent → scopeTimeline → segmentTimeline
  → 原有 TUI / Web Timeline
```

### 事件与执行隔离

- `run.started.fusion` 建立 Lead 的角色记录，模型名来自冻结配置。
- 新的 `fusion.execution` 只公布 Sidekick 的安全任务 ID、角色、轮次、模型名及起止状态。信封中的执行、父执行、Run 和 Thread 身份不由模型文本决定。
- `FusionWorkerObserver` 单独开放实时正文，结束时不再重复 final content；普通 `ManagedChildObserver`、Plugin 和 Compose 的捕获策略保持原规则。Sidekick 的文字不注入父模型 Transcript，审批仍交给父 Run。
- UI 仅在同一 Run、任务和父 Lead 明确匹配时建立 Sidekick 过程。普通子代理即使名字相同，也不能因此混入主时间线。

### 共享投影与两端展示

- `interactive/fusion-execution.ts` 保存展示用的角色记录并处理结束、取消、失败；连接中断也复用同一收尾规则。结束后的迟到帧不能重新激活执行。
- `interactive/timeline-identity.ts` 统一提取条目身份，分组、过滤与收尾共用；同名工具仍按 Run / execution / activity / tool ID 区分。
- `timeline-scope.ts` 只放行已绑定的 Fusion 子执行。`timeline-activity-groups.ts` 复用原有分组结构和折叠控件，给出角色、真实模型、轮次和状态；Lead 的多个连续片段使用不同 key，保持时间顺序。
- TUI/Web 原有 Timeline 负责输出、工具详情和滚动。当前角色显示在状态行；每项任务的 Fusion 状态说明原位更新一条，避免状态版本增长造成重复长消息。
- 过程只保留在当前 Controller 及 Web 接管状态里，不新增过程持久表；重启后的历史恢复沿用原 Transcript。该展示状态不参与权限授予、写者释放或任务验收。

## 七、请求超时与单轮重复拒绝

模型 profile 的 timeout_seconds 同时限制网络等待和一次流式响应总时长。重试由 ManagedAgentExecutor 唯一负责；已公开输出后不自动重放。取消、超时不能替命令推断停止。

实施 Worker 保存报告后直接结束；连续三次同工具同拒绝码时提交 blocked，Lead 连续三次控制工具被拒时暂停。探索只返回调查摘要，受阻时结束，不向实施报告通道提交结果。Plan、只读核查、目录和后台命令约束继续由实际工具边界执行。

早期修复过程和旧整目录限制见 [历史记录](../project/Fusion历史改造记录.md)，当前文件协调以第 4 节和 HC-186 为准。

## 八、角色用量、只读探索和反馈（HC-189）

Lead 的批量调查可以调用 fusion_explore：无 allowed_paths、无实施轮次、无写者租约、无验收票据。每次探索新建临时 checkpoint，结束或取消后清理，不能复用实施历史。权限视图只给读工具和 fusion_status；Guard 和 Service 再拒绝写、命令、报告和再次委派。父 Run 的取消、审批、事件与 Pool 仍是唯一运行路径。池容量为 2 时可以交替探索和实施；图被淘汰后从冻结 Spec 重新登记，返工仍用原 checkpoint。其他活动执行占满池时，探索返回明确的资源繁忙工具结果，Lead 可读关键文件或等待。探索起止写入任务数据及 evidence，状态带 exploration；崩溃留下的运行显示在恢复时收束为 interrupted，不重放探索。

过程事件可带 kind=exploration，允许 round=0；实施仍从第一轮开始。CLI/Web 显示“Sidekick · 模型 · 只读探索”，不能把它排成实施第一轮或被迟到帧改成另一身份。

StreamSession 另存每次模型调用的已知用量；分片按最大累计值合并，多个模型调用按次累加。Managed 在每次 attempt 的成功、错误或取消边界把事实交给 Host；输出回滚不抹掉已观测消耗。FusionStateStore.record_usage 在同一短事务写唯一事件与累计，重复事件不重复计数；统计可以补入终态，但不改变 phase、generation、ticket。任务和进度通过 usage 字段公开角色输入/输出/缓存、完整性和可选估算。

价格来自 models.profiles.<id>.pricing；同币种且必要字段完整时计算普通输入、缓存输入、输出。差额只把 Sidekick 相同 token 代入 Lead 价格，不是全 Lead 实验或账单。没报告缓存就是未知，不是零；失败无用量时显示不完整。统计范围是此功能观测到的任务调用，不包含额外摘要请求或故障只读核查；后者不能变更旧任务或套用已变化模型的旧单价。落库失败只写安全诊断，不覆盖执行错误。

可信 lead_prompt_append / sidekick_prompt_append 不回传正文，参与配置及角色 prompt 指纹；附加文字不能扩大硬能力。只在真实连接与设置相同、或已配置可比较价格时给配对提醒，不能按 default 别名或窗口大小推断。

最近相邻两轮有相同 unresolved，或同一检查有相同失败摘要时，stagnation 提示 Lead 换策略。重复读取同一轮不计数，提示不改变轮次上限或放开验收。

拆分按职责进行：FusionAcceptance 持有检查/审阅，FusionWorkerRunner 持有模型执行和收尾；Store 的任务、租约、effects 仍共同提交，不为缩短文件打散事务。建议取舍与证据边界见 [改进审查](../research/189-Fusion改进审查.md)，行为和测试见 [HC-189 规格](../spec/HC-189-双模型探索与度量.md)。

## HC-185：故障时可以只读核查

### 用户新消息如何处理

任务是 `OUTCOME_UNKNOWN` 或 `reason=workspace_busy` 时，`FusionRuntime.prepare` 将本轮固定为 `inspection_only`。仍被占用时，新消息进入只读核查；占用已解除时，先 reconcile，再按普通流程恢复。不按“继续”“自己检查”等文字猜测授权。

只读核查使用当前配置的 Lead；旧任务配置变化不阻止查询，恢复写入仍需原配置指纹一致。Binding 和 RunContext 持有 Host 私有标记；不 claim/release 旧 `active_run`，不 resume/continue_pending，不删除旧 Worker checkpoint，不改停止记录或写租约。受理失败、取消和 Host 关闭同样不清理别人的运行。

能力仅保留原有只读工具与 `fusion_status`，移除 ask_user 和所有修改控制；工具注册、Service 实际调用边界同时限制。核查 Final gate 可以自然答复，Guard 不再直接结束该模式；连续三次同一工具错误则带说明结束，不更新任务。普通写入 Run 的未知状态停止门禁不变。核查期间任务变化，也不提升本轮权限。

### 状态与目录

`fusion.status` 必需返回 `task` 和可空 `workspace_blocker`。Store 新增 `workspace_owner(workspace)`，无需本会话存在任务即可查询；复用原租约规则和项目身份隔离。CLI 将目录结果与查询 Thread 绑定，保留版本及异步身份校验。无活动任务或只有终态历史任务时仍展示实际占用者，`/fusion resolve` 可以从当前会话处理它。

模型用的 `fusion_status` 额外返回 diagnostics：只读标记、实际命令目录、操作所属任务/会话、停止证据是否缺失。`unconfirmed` 只说明记录缺少停止依据，**不是已探测到进程还在运行**。没有 PID 时不自动确认停止，不自动填写 `--stopped`。

Worker 提示给出真实命令目录，并说明文件工具的虚拟 `/`。命令解析在副作用登记前拒绝显式 `cd /`、`find /` 及嵌套 Shell 变体；项目相对命令和普通 Python 字符串不受影响。

相关回归：`test_fusion_inspection.py`、`test_fusion_roles.py`、`test_fusion_guard.py`、`test_fusion_store.py` 以及 CLI `fusion-feature.test.ts`。核查不改用户任务数据库，也不停止系统进程。


### 文件工具错误的解析

文件工具返回 `{"ok":false,"error":{"code":"...","message":"..."}}`，Fusion 控制工具的业务错误返回 `{"error":"FUSION_..."}`。重试计数器按各工具现有格式提取错误码；只有字符串才参与错误码集合查询，对象和数组不能直接拿来查询，否则普通 ls 失败也会导致整轮 TypeError。

文件工具内嵌的 Fusion 错误码继续使用原有“同工具、同错误码连续三次”规则。其他文件错误交还模型纠正；只读核查按原规则计入未识别的工具失败，并在三次后收尾。没有改变文件工具协议、停止事实或写权限。

回归为 `test_fusion_guard.py` 中错误类型与两种工具格式，以及 `test_fusion_tool_errors.py` 的真实 Host 列目录失败/纠正、只读核查与连续错误场景。


## HC-186：迁移与当前对话核查

升级须重启共享该数据目录的所有旧 Host。首次打开旧库先建立权限为 `0600` 的 SQLite 备份，再在一个事务内转换旧租约、投影旧基线、使旧验收票据失效，最后删除 `fusion_leases`。备份失败不迁移；旧命令停止不明保留全目录保护。运行时只使用新结构。

普通命令可能没有 Fusion task ID。状态摘要对本项目未知操作返回 `operation_id/sequence`；`/fusion resolve --stopped <说明>` 调用受控的 `fusion.release`。Store 核对项目、精确操作、序号、未知状态和非空说明，仅存说明摘要。活动操作、任务所属操作和过期请求不能从这个入口释放；任务所属操作仍走已有 cancel/recover。该入口不向模型提供。

`FusionTaskStatus` 增加 `write_paths/resource_waits`，阶段增加 `WAITING_RESOURCE`。Host 进度事件沿原 Run 流发布，Interactive Core 把资源等待转成 `fusionWaitLabel`，经 Selector 同步到 TUI/Web。界面分别展示 Lead/Sidekick 时间线，资源排队不会显示为模型迟迟未响应。

完整规格和回归范围见 [HC-186 规格](../spec/HC-186-双模型文件并行执行.md)；完成后以对应归档 Task 的检查记录为准。


纯读取快照没有写入副作用，Host 退出后可以回收；历史文件还原归入命令保护。实际操作已登记但副作用记录尚未保存就退出时，待查操作列表仍保留操作编号，不能只显示空的“结果不明”。
