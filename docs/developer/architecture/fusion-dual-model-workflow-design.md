# Harness Code 双模型协作（Fusion）设计与实现

> P0 闭环已实现。开发基线：Harness Code `dev_wdl / 68afe9f`，dsh-model-fusion `fcb2693`；协议更新至 **v3.11**。实施与测试记录见 [HC-183 Task](../task/archive/HC-183-双模型协作.md)。P1 用量历史、成本展示和 P2 缓存、Lead 接管未纳入首版。
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
| 返工继续同一个子会话 | `host/native-worker.ts` | `host/fusion_runtime.py::run_worker` |
| Host 运行检查，Lead 逐项验收 | `host/native-checks.ts`、`evidence/gate.ts` | `runtime/verification.py`、`FusionService.review` |
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
| `runtime/fusion/tools.py::create_fusion_tools` | 模型可见的六个控制工具 | `tool_risk.py`、`approval_policy.py` |
| `runtime/fusion/service.py::FusionService` | 派单、返工、续接、检查、逐项审阅和最终输出门禁 | 状态机、票据、失败测试 |
| `runtime/fusion/store.py::FusionStateStore` | 七张扩展表、版本校验、派发、证据、副作用和写者 | schema 验证、事务和崩溃测试 |
| `runtime/fusion/snapshot.py` | 独立文件快照、路径规范化和改动清单 | Git index、不跟随 symlink、严格失败 |
| `runtime/fusion/guard.py` | 文件准备/提交守卫与 Shell 副作用登记 | Snapshot 文件契约、审批恢复、停止确认 |
| `host/fusion_runtime.py::FusionRuntime` | Host 装配、持续 Worker、真实子审批和检查端口 | Pool、registry、索引和 checkpoint 生命周期 |
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

首轮基线只取一次，返工继续与这份基线比较。扩大范围必须填写原因、增加任务单 revision 并使旧票据失效。返工次数按组合限制，超过上限进入等待状态。

`run_worker` 每轮登记新的 execution ID；checkpoint ID 根据项目、Thread、任务和 `worker_session_id` 稳定计算。执行前比对历史身份和上一轮完整结束的 checkpoint 标记。正常结束后出现丢失、覆盖或不匹配时拒绝执行；若本轮已明确停止并记录中断，则只恢复上一完整 checkpoint。第一轮从未完整结束时，可保留文件和任务单、清理半轮上下文后重新准备；不重放待执行的旧工具。

子执行复用 Managed 执行器、父取消信号、真实审批和用量账本。审批携带该轮子 execution ID，不能混到根执行。索引查询租约由每轮自行借用和释放；文件读取快照也每轮关闭。任务未终结时保留 Worker checkpoint，完成或取消后清理。

### 4. 写者、快照、检查和审阅

**写者**指当前有权修改工作区的人。SQLite 按真实工作区路径摘要保存唯一写者，并递增 `generation`（写者代号）；旧工具不能沿用过期授权。

- 派单登记写者、任务单和消息在同一短事务内完成；工作区被占用时全部回滚。
- 文件工具在准备、审批恢复和提交时检查角色、阶段、范围、revision 和写者代号；提交前先保存副作用记录。
- Sidekick 提交报告后关闭本轮写入。Host 确认副作用停止，才取得检查写者。
- 普通 Build 工具、Compose 检查、Direct Shell 和文件撤销/重做也检查 Fusion 写者。Direct Shell 持有 Host 写锁直到命令停止；取基线前等待已有普通写入结束。
- 只有实际 Fusion 任务中的六个已登记控制工具免查写者；普通扩展即使名称以 `fusion_` 开头，也不能绕过写入保护。
- 完成/取消和释放写者在同一 SQLite 事务中提交，避免留下已完成任务的占用。

**快照**由 Host 自己计算。Git 工作区使用临时 index，不改用户 index；统计已跟踪文件、非忽略的新文件及允许范围内的忽略文件。非 Git 工作区直接计算文件摘要。创建、修改、删除、文件类型和模式变化都参与比较；无法读取、路径越界或取样期间文件变化时拒绝验收。

**检查**只运行冻结配置中的命令，通过 `ManagedVerificationPort` 复用现有执行 backend、权限、审批和 Host 锁。配置命令不等于自动批准。审批后重新检查目录、候选文件、Plan 和写者；每项记录命令摘要、任务单版本、起止快照、时间、退出码和脱敏输出。退出码非零或检查改了源码，不能验收；超时 124 或缺少停止确认进入 `OUTCOME_UNKNOWN`。

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
| `fusion_leases` | 工作区唯一写者、所属任务和代号 |

副作用先记录 `running`，再真正执行；只有确认停止才记成功/失败。结果不明保留 `unknown` 和写者。初始化时验证列、主键以及活动任务部分唯一索引，结构不符明确报错。

| 阶段 | 含义与下一步 |
| --- | --- |
| `READY` | 尚未派单；直接答复或派单 |
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
| 部分检查回执已保存 | 复用原回执，只运行剩余计划；已开始却缺少回执时等待核查 |
| 票据或全部检查已保存，Lead 尚未接受 | 核对文件后恢复/重建票据，不重跑 Worker 或已有检查 |
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

### 7. 验证与后续维护

| 测试位置 | 验证内容 |
| --- | --- |
| `tests/config/test_fusion_config.py`、`tests/runtime/test_fusion_profile.py` | 合并、引用、可信来源、冻结和脱敏 |
| `tests/runtime/test_fusion_roles.py`、`test_fusion_guard.py` | 原始权限派生、Lead 禁写、路径、提交和命令结果 |
| `tests/runtime/test_fusion_store.py`、`test_fusion_snapshot.py` | CAS、单写者、原子派单、schema、重启和 Git index |
| `tests/runtime/test_fusion_service.py`、`test_verification_shared.py` | 越界/漂移/失败拒收、逐项审阅、检查续接、终态释放 |
| `tests/host/test_fusion_run.py`、`test_fusion_execution.py` | 真实 Host/Pool/图/工具链，两模型、同会话返工、真实审批、取消、恢复与历史一致性 |
| `packages/cli/tests/interactive/fusion-feature.test.ts`、`tests/ipc/` | 共享入口、选择、恢复、中文状态、协议和双端帧 |

测试使用可控模型、虚构凭据和临时工作区。所有最终命令、全量结果及已有基线问题记录在 Task；不得把 Mock 测试描述成真实商业模型联调。

继续扩展时优先保持这些约束：共用模型/Run/审批路径；以数据库和当前文件决定状态；对副作用先登记、再执行；角色能力、协议、测试和用户说明同步修改。P1/P2 必须另行确认范围和验收标准。

## 五、派单占用修复（2026-10-20）

同一目录已有旧任务占用时，重复派单不会释放写权限。占用是工作区级别，不能把 `FUSION_LEASE_BUSY` 解释成“Sidekick 模型会话卡住”。

修复链路：`start_round` 在原子事务中发现占用 → 返回安全占用摘要 → 当前任务记录 `WAITING_USER/workspace_busy` → `FusionEffectMiddleware.abefore_model` 在下一次模型请求前结束本轮。没有任务单、消息、轮次或子执行被部分登记，也不自动取消占用者。

- `workspace_blocker` 在既有任务 JSON 中保存，仅包含占用任务/会话 ID、阶段、轮次、安全原因及待核查标记；协议增加严格可空字段，不新增 SQLite 表。
- 查询和显式继续都核对数据库里的实际写者。占用仍在时不请求模型；占用解除时查询只提示可继续，用户新消息才恢复原首轮派单。
- `fusion_rework` 在没有任务单时返回 `FUSION_FIRST_ORDER_REQUIRED`；已有任务单而尚无票据仍允许按原规则返工。
- TUI/Web 共用占用文案及会话引导；较早发出的状态查询不能覆盖较新的进度。问答历史的“已处理”不表示任务完成。
- 测试覆盖真实 Host、Pool、图、Snapshot 文件工具、可信检查及审阅：占用只产生一次 Lead 请求，仍占用时的新消息产生零模型请求；旧任务正常取消后，同一任务完成首轮创建和验证。

## 六、两角色实时过程（2026-10-21）

Lead 和 Sidekick 共用一页时间线，按执行顺序显示独立的角色过程区。返工产生新的 Sidekick 执行和轮次；Lead 随后审阅时显示在其后，不能为排版把记录重新排序。

```text
FusionRuntime.run_worker
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

## 七、模型长等待和重复拒绝的收尾（2026-10-21）

`models.profiles.<ID>.timeout_seconds` 同时用于 HTTP 网络等待与一次流式响应的总时长。前者会被数据或心跳刷新，后者不会。统一模型适配器 `_ReasoningAwareChatOpenAI._astream` 从请求开始计时，经 `_astream_response` 保持原解析、工具与 usage 路径；响应到期抛 `MODEL_RESPONSE_TIMEOUT` 并关闭流，用户取消原样传播。Lead、Sidekick 和使用该适配器的普通模型遵守同一配置，非流式调用仍沿原 HTTP 超时。

重试仍由 `ManagedAgentExecutor` 唯一拥有。空输出按 `max_retries` 限次重试；已经公开正文则返回原有 `PROVIDER_OUTPUT_INTERRUPTED`，不重放内容与副作用。本次不增加整个开发任务的总时限，也不根据超时清除写者或未知操作。

Sidekick 在 `FusionEffectMiddleware.abefore_model` 进入下一次请求前检查：

```text
报告已保存？ → 是：结束本轮 → 原派单流程检查报告 → Host 检查 / Lead 处理
     否
连续三次同工具、同拒绝码？ → 是：现有 submit_result 保存 blocked → 结束本轮
     否
继续原模型和工具执行
```

计数读取当前图中的真实 `ToolMessage`，不放进共享 Engine 或新增数据库字段。成功工具结果、不同拒绝以及新的人类消息打断计数。blocked 只表示这一轮受阻，不允许验收成功；未知副作用、取消及写者规则继续生效。

命令约束复用 `policy/bash_parser.py` 的语法树与 `strip_wrappers`：识别真实 `&` 后台节点，允许普通 Python 参数和 here-doc 的位运算；展开 `bash -lc`、`sh -ec` 等脚本后再检查。选项解析遇到脚本路径或 `--` 即停止，避免把脚本参数误当成 Shell 选项。不能可靠展开的 Shell 载荷含后台语法时仍拒绝，Git 修改与内部目录限制保留。`WORKER_PROMPT` 同时提示优先使用文件工具，以及受阻时提交报告。

对应回归为 `test_model_response_deadline.py`、`test_fusion_execution_limits.py`、`test_fusion_stall.py`；原 `test_fusion_streaming.py` 在报告提交前验证实时正文，不再依赖报告后的冗余模型请求。


## 八、派单与恢复体验优化（HC-184，2026-10-21）

详见 [HC-184 Spec](../spec/HC-184-双模型协作体验优化.md)。原文需求由 Host 生成、闲置自动让出目录、当前会话处理占用这三项共同简化流程，已有角色、检查与审阅门禁继续有效。

### 1. 运行归属与目录写者

任务终态不能被迟到回调恢复；已取消或被新 Run 接替的执行会在下次模型请求前停止，不再要求补报告，Root 收尾清理取消后的 checkpoint。

任务 JSON 保存 `active_run={owner,run_id}`。`FusionRuntime.prepare` 用 `claim_run` 取得本轮归属，防止两个窗口同时执行同一个任务；目录 lease 则防止不同任务同时写目录。查询另一 Host 的活动执行不再暂停它。没有可靠退出记录的运行，不能仅因等待很久就接管。

准备失败、Root 结束或正常 Host 关闭时，按准确 owner/run_id 清理归属。迟到的旧回调不能暂停新 Run。受理前放弃的新空任务标记取消；已有任务暂停并保留。RunCoordinator 的 `on_abandon` 统一处理准备成功后未能真正受理的分支。

`begin_workspace_phase` 在一个短事务中取得目录并进入 Worker 执行、检查或审阅阶段，避免先取得目录、又因仍处于暂停阶段被其他窗口释放。首轮基线也在取得目录后读取。闲置释放不删除任务、不回滚文件；新 Run 恢复时重新取得目录并检查快照。

### 2. 断流与停止事实

Native Worker 真正退出并完成执行器收尾后，`record_worker_stopped` 按任务、派发和 execution ID 记录 stopped。模型断流或等待时取消，不再仅因 outbox 留在 dispatched 就误报结果不明。命令的停止事实仍单独判断；不能用“模型退出”推断所有命令已停。

命令结果不明时，两角色立即结束模型循环。Worker 的最终输出门禁不会再因报告缺失追加模型请求，任务保持 OUTCOME_UNKNOWN；Root 退出重新生成待查清单，移除已停止的派发，只保留真正未确认停止的操作。

模型已公开输出后断流，不自动重放响应。退出事实明确且没有未知命令时，任务进入 PAUSED，可直接发送“继续”；仍有不明命令时保留 OUTCOME_UNKNOWN。TUI/Web 共用明确的断流、继续和核查说明，原始协议错误码保留。中断恢复只用完整 checkpoint，不自动补跑半轮工具。

### 3. 当前会话处理占用

`/fusion resolve` 刷新当前任务及服务端占用者，读取占用任务当前版本，再按准确身份取消。成功后刷新当前任务，提示发送“继续”；不跳转旧 Thread。版本、占用者或当前对话变化时拒绝，避免结束错误任务。

`cancel/resolve --stopped <核查说明>` 只接受用户明确输入的停止确认。Host 使用已有 Run 停止和空闲锁；Store 在一个事务中记录核查摘要、结束准确任务并释放目录。`recover --stopped` 则用于保留并继续当前任务。没有核查说明的未知操作继续拒绝释放。重复读取相同未知状态不增加版本。

### 4. 错误和验证

模型控制工具返回带 error、field、action 的安全结果；校验错误不回显输入或密钥。结果按失败工具显示；连续三次相同控制失败会暂停，避免反复猜参数。首次派单和返工仍按是否已有任务单区分。

新增 `test_fusion_usability.py`、`test_fusion_management.py`，覆盖原文冻结、尾段保留、闲置让出、未知命令、原子核查取消、两个 Host 查询/启动、受理失败清理、第一/后续轮取消及流式断开后续接。CLI 回归覆盖当前会话 resolve、目标变化、切换会话、显式停止确认和流式失败提示；Protocol 共享样例覆盖停止说明的类型和长度。


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
