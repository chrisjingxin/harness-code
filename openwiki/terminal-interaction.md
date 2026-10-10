# 终端交互专题：时间线、检查器、命令与运行时语义

本页是 TUI（`npm run dev` 进入的交互终端）用户操作的完整参考：执行时间线里每类条目的含义与截断语义、项目检查器侧栏、全部内置 Slash Command、`/goal` 目标闭环、文件工具的先读/比较替换规则，以及 AGENTS/Skill 快照与上下文压缩的运行时行为。工作模式（Build/Compose/Plan）与键盘总表见[工作流](workflows.md)，审批档位与安全边界见[安全页](terminal-and-safety.md)。

## 1. 执行时间线：你能看到什么

一次 Run 期间，同一 Thread 的消息、工具事件、思考、审批/提问等 Interaction 按发生顺序混排在**一条时间线**里（`packages/cli/src/tui/presentation/timeline.tsx`）。它们不会被拆成“回答一个列表、工具另一个列表”——工具卡片始终出现在它实际执行的位置附近。

| 条目 | 呈现方式 | 截断/折叠语义 |
| --- | --- | --- |
| 用户消息 / 回答 | 正文按 Markdown 渲染 | — |
| 工具事件 | 独立工具卡（inline/block/diff/generic 四类） | 预览默认 12 行 / 4096 码点；`Ctrl+O` 展开工具详情后 write_file 正文最多 100 行 / 32768 码点（`presentation-shared/paint-budget.ts`）。预览只是显示上限，**不等于工具只处理了这些内容**。 |
| Diff | 终端 ≥120 列左右分栏，否则统一 diff | 同样有显示预算；截断时批准仍针对完整拟议变更（见[安全页](terminal-and-safety.md#审批响应与规则持久化)）。 |
| 思考（reasoning） | 独立条目，不是回答正文的一部分 | 进行中固定展开（末尾窗口 12 行/4096）；完成后点击折叠/展开，展开最多 40 行/8192。折叠时只显示“还有 N 行”。 |
| 审批/提问/目录信任 | 输入栏变成操作栏 | 同一 Run 多个交互请求排队，一次显示一个；已处理的在历史里保留“已允许/拒绝/已回答”状态。 |
| Run 终态 | RunFooter 一行摘要 | 结果、模型名、耗时、`formatUsage` 用量（输入/输出 token）、估算上下文占用。`/status` 弹窗另给上次 Run 的 input/output/cached token（`presentation/status-modal.tsx`）。 |

时间线底部固定顺序：阶段状态（TimelineActivity，显示当前已观测阶段与耗时）→ Todo 面板（Agent 有待办列表时钉住）→ 错误块 → RunFooter → 临时提示。显示的阶段是**已真实观测**的，不臆测内部动作；需要取消时按 `Ctrl+C`（`Esc` 不取消）。

### Activity 分组与子时间线

- 连续的工具活动会分组显示，终端下默认**折叠**；点击组的 ▶/▼ 展开或收起。
- Agent 用 `task` 委派子代理时，主时间线只显示 task 卡；按 `Esc`（或返回键）从子时间线回到主时间线，子时间线是只读的（详见[扩展页](extensions.md#子代理与-team)）。
- 尚未处理的 live Interaction（如等待你审批的请求）在时间线里不重复渲染正文，操作栏就是唯一入口。

### 只读查看浮层（Inspect Overlay）

`/goal`（无参）、`/plan-view`（运行中）、`/mcp`（运行中）会打开盖在时间线上的**只读浮层**：支持 Markdown 高亮、`j/k` 或方向键/PageUp/PageDown/Home/End 滚动、`Esc` 或 `q` 关闭。关闭浮层不会打断正在执行的 Run；但新的审批等独占 Interaction 到来时会自动关闭浮层。运行中查看计划走浮层；空闲时 `/plan-view` 走普通查看视图。

## 2. 项目检查器（侧栏）

输入栏左侧的 `[◧ 侧栏]` / `[◨ 侧栏]` 按钮点击即可开合侧栏（`presentation/input-bar.tsx`）。侧栏聚合：当前 Thread 标题、上下文占用、MCP 状态、工作区文件树、文件只读预览和状态页（Git 变更）。

**文件页**（侧栏可见且没有浮层抢焦点时，`tui/app.tsx`）：

| 按键 | 作用 |
| --- | --- |
| `1` 或 `[` | 切到文件页 |
| `2` 或 `]` | 切到状态页 |
| `↑/↓` 或 `j/k` | 在树中上/下移动；选中文件即打开只读预览 |
| `←/→` 或 `h/l` | 折叠/回到上级目录；展开/进入子目录 |
| `Return` 或 `Space` | 目录切换展开；文件打开预览 |
| `@` | 把当前选中文件的 `@路径` 填入输入草稿并关闭侧栏 |

- 预览是**只读**的：上限 256 KiB、2000 行、单行 20000 字符（`workspace/file-preview.ts`）；二进制（前 8 KiB 含 NUL）与非 UTF-8 显示“不支持”而非报错；读取期间文件变化会自动重试一次，仍变化提示“文件已变化，请重新刷新”。预览缓存最多 16 个文件 / 2 MiB。
- 状态页显示工作区 Git 变更列表，渲染上限 200 条；**非 Git 目录或 Git 探测失败时不显示变更列表**。
- 布局按终端宽度分档：≥150 列文件树与预览左右双列；≥116 列停靠压缩对话宽度；更窄时侧栏以覆盖抽屉形式出现，不保证固定宽度。

## 3. 内置 Slash Command 速查

以下为当前注册表（`packages/cli/src/interactive/commands.ts` 的 `builtinCommandDefinitions`）的全部内置命令。加 ★ 的在**运行中也可用**（`safety.runtime: "allowed"`）；未加 ★ 的要求空闲（`requiresIdle` 或未标 runtime allowed，运行中在命令菜单里显示“当前任务结束后可用”）。

| 命令 | 别名 | 用途 | 运行中 |
| --- | --- | --- | --- |
| `/help` ★ | — | 显示可用命令 | 可用 |
| `/quit` ★ | `/q` | 退出 | 可用（运行中先确认） |
| `/new` ★ | `/clear` | 开新 Thread | 可用（运行中确认并取消任务） |
| `/status` ★ | — | 运行状态查看 | 可用 |
| `/title <短标题>` ★ | — | 设置当前 Thread 标题 | 可用 |
| `/btw [问题]` ★ | — | 临时只读问答，不写入 Transcript | 可用 |
| `/goal …` ★ | — | Build 目标管理（见下节） | 可用 |
| `/plan [exit\|目标]` ★ | — | Build 计划模式 | 可用 |
| `/plan-view` ★ | — | 查看当前计划 | 可用 |
| `/agents` ★ | — | 只读浏览可派发 Agent | 可用 |
| `/teams [子命令]` ★ | — | 查看/控制 Agent Team | 可用（查看/控制类） |
| `/mcp [add\|remove]` ★ | — | 查看 MCP 状态；add/remove 管理 | 查看可用；变更需空闲 |
| `/compact` | — | 压缩上下文 | 需空闲 |
| `/resume` | `/continue`、`/threads` | Thread 恢复选择器 | 需空闲 |
| `/undo` | `/rewind`、`/rollback` | 回退会话与代码 | 需空闲 |
| `/redo` | — | 重做最近一次撤销（须先 undo） | 需空闲 |
| `/model [query]` | `/models` | 选择下一次 Run 的 Profile | 需空闲 |
| `/skills` | — | Skill 选择器 | 运行中显示禁用原因，不能选择 |
| `/web` | — | 浏览器接管当前会话 | 需空闲 |
| `/new-work <目标>` | — | 放下当前 Compose 需求、开新目标 | 需空闲 |
| `/abandon` | — | 废弃当前 Compose 需求（总是确认） | 需空闲 |

补充规则：

- **未知 `/命令` 不会发送给模型**，本地按编辑距离给最多 3 个相近建议；想发送以 `/` 开头的普通文本，写 `//文本`。
- Skill 以 `/skill:<id>` 形式出现在命令菜单（仅 enabled 且 userInvocable 的项）；Plugin Command 与内置命令同名时以 `<插件名>.<命令名>` 呈现，不能覆盖内置命令。
- 命令是否可见还受当前协商能力（capability）与工作模式限制，例如 `/goal`、`/plan` 仅 Build 可见。

## 4. `/goal`：目标闭环（仅 Build）

`/goal` 用于给 Build 任务设定可验收目标并驱动验收。argumentHint：`[<目标>|edit|pause|resume|clear]`。相关配置：`[goal] grader_model`（缺省继承当前 Run，不可用 grader 会在 Run 受理前失败）与 `max_iterations`（默认 3，范围 1–20，`packages/agent/harness_agent/config/config.py`）。**没有 `/goal model` 或 `/goal max-iterations` 子命令**；要调整就改配置文件后重启。

| 操作 | 输入 | 预期结果 |
| --- | --- | --- |
| 查看当前目标 | `/goal`（无参） | 打开只读浮层显示目标与验收条件；无 Thread 时提示用 `/goal <目标>` 创建 |
| 创建目标 | `/goal 完成X并通过Y测试` | 发起提案；Agent 会给出目标与**验收条件草案，必须经你确认**（reviewing 流）后才生效 |
| 替换目标 | 已有目标时再次 `/goal <新目标>` | 走 replace 提案，同样需确认；并发保护用 `expected_goal_id`/`expected_revision` |
| 修改目标 | `/goal edit <说明>`（或无说明打开编辑框） | 走 amend 提案修改目标/条件 |
| 暂停/恢复 | `/goal pause`、`/goal resume` | 无目标时拒绝；暂停后该目标不再驱动验收 |
| 清除 | `/goal clear` | 删除当前目标 |

关键语义：

- **运行中可用**：`/goal` 标记 `runtime: allowed`。任务执行中提交的目标请求会**排队**，提示“目标请求已排队，将在当前任务结束后继续”。
- **跨 Run 保留，不自动继续**：目标持久保存在 Thread 中，重启或 `/resume` 后仍在；但 Harness **不会在后台自动开新 Run 继续未完成的目标**。每个 Run 终态后，若服务端对账产生了续跑动作（continuation），只会**一次性消费**去重后提示/启动一次；恢复 Thread 时也只续接未完成的提案，已接受的目标不会自行启动新 Run。要继续验收，发送一条新消息（如“继续完成目标”）即可。
- **验收与 grader**：目标生效后，Run 内由**只读 grader**（工具仅限 `ls`/`read_file`/`glob`/`grep` 加受控的 `rerun_verification` 复验，`goals/tools.py`）对照验收条件指出缺口；Agent 在同一 Run 内可补做，最多迭代 `max_iterations` 轮。Agent 用 `update_goal` 提交 complete/blocked。grader 不提权、不写文件。
- **`/plan`、`/btw` 与 Compose 不参与验收**：计划模式只写会话计划；`/btw` 回答不进入 Transcript；Compose 有自己的检视流程。
- 撤销的影响：`/undo` 回退已完成的 Goal 时，目标定义保留但状态回到进行中，需重新验收。

## 5. 文件工具：先读、唯一匹配与 CAS

Agent 的文件修改由**先读 Snapshot + 精确字符串比较替换（CAS）**约束（`packages/agent/harness_agent/tools/snapshot_file_contract.py`）。用户一般不直接调用，但理解规则能看懂时间线里的失败与恢复：

- **`write_file` 只创建不存在的文件**；目标已存在报 `FILE_ALREADY_EXISTS`，正确动作是先读再用 `edit_file`。
- **`edit_file` 必须先 `read_file`** 取得当前 Thread 的 Snapshot，并提交**唯一** `old_string`；替换文本必须完全落在已读取的行范围内。不支持 `replace_all` 和行号批量 patch。
- **空文件**：已存在的空文件也必须先读，然后用空 `old_string` 编辑来初始化内容；对非空文件用空 `old_string` 报 `INVALID_EDIT`。
- **`delete_file` 需要完整读取**该文件后才能删除。
- 快照按 Thread/路径/backend 绑定；`/.harness/` 虚拟只读命名空间不能生成可写快照。

常见错误码与恢复（实现：`tools/snapshot_file_support.py`）：

| 错误码 | 含义 | Agent 应做的恢复 |
| --- | --- | --- |
| `SNAPSHOT_REQUIRED` / `SNAPSHOT_EXPIRED` / `STALE_FILE` / `UNREAD_RANGE` | 未读、快照过期、读后文件已变、目标不在已读范围 | 重新读取文件或区间后重试 |
| `EXACT_MATCH_NOT_FOUND` / `AMBIGUOUS_MATCH` | old_string 已不存在 / 不唯一 | 重新读取目标区间，提交唯一 old_string |
| `FILE_ALREADY_EXISTS` | write_file 拒绝覆盖 | 先读现有文件再 edit_file |
| `COMMIT_CONFLICT` | 提交前文件又被外部修改 | 重读重审，不覆盖外部修改 |
| `POST_WRITE_DRIFT` | 写入后被保存钩子等外部改动，快照不可用 | 以写入后的实际文档重新快照/重读 |
| `BACKEND_CAS_UNSUPPORTED` | 当前 backend 不支持安全比较替换 | 切换到支持文本 mutation 的执行模式 |
| `UNSUPPORTED_FILE_TYPE` | 非受支持文本（编码/换行混合/目录等） | 换用合适工具或人工处理 |

提交成功后，工具会附一次**有界只读 diagnostics**（LSP/诊断）摘要：最多 20 条、8 KiB、默认 1 秒超时（`tools/file_diagnostics.py`）。`status: "unavailable"` 或 `"timeout"`（含未配置 LSP 的情况）只表示**这次拿不到诊断**，**不等于“零问题”**；超时也不会影响已成功的写入。

## 6. AGENTS/Skill 快照与 `/compact`

- **每个顶层 Run 开始时重新冻结快照**：Run 准备阶段（`threads/context_lifecycle.py` 的 `prepare`）重新读取仓库 AGENTS 参考块与 Skill 目录，生成新的 `snapshot_id`/`skill_snapshot_id`。因此**修改 AGENTS.md 或项目/用户 Skill 后，下一个 Run 即生效；当前 Run 不热更新**。沙箱执行下这两类宿主来源整体省略。
- **`/compact`**（需空闲）：强制压缩较早上下文、保留最近两轮与完整可恢复 Transcript；无需压缩时明确 skipped，失败不伪装成功，压缩期间不接受新消息。详细行为与故障恢复见[工作流](workflows.md#高频-slash-command)与[排障 §18](troubleshooting.md#18-上下文压缩被跳过或失败)。
- **Skill 变更生效时机**：项目/用户 Skill 变更在下一 Run 生效（Run 准备阶段刷新 catalog）；仅 Plugin Skill 变更需要重启 Host（见[扩展页](extensions.md#项目和用户-skill)）。

## 7. 常见场景速查

- **任务跑偏了想停下**：`Ctrl+C` 取消当前 Run（`Esc` 只提示）；已批准的文件变更不会因此自动回滚，必要时用 `/undo` 选择回退范围。
- **想看 Agent 到底改了什么再批**：审批卡里的 Diff 被截断时，批准仍针对**完整**拟议变更；先要求 Agent 缩小本次改动或提供可完整审阅的差异，再决定是否批准。
- **输出很长看不全**：`Ctrl+O` 切换工具详情展开（write_file 正文最多 100 行）；预览上限不影响实际执行内容。
- **验收目标没有自动继续**：这是设计行为——目标跨 Run 保留但不在后台自动续跑；发一条新消息继续即可。
- **Agent 报快照/匹配错误**：让它重新读取相关文件或区间再改，不要要求盲写绕过 CAS。
- **改了 AGENTS.md/Skill 没反应**：当前 Run 不热更新；等本次 Run 结束，下一条消息（新 Run）生效。

## 来源与维护锚点

- 时间线与浮层：`packages/cli/src/tui/presentation/timeline.tsx`、`inspect-overlay.tsx`、`tui/application/adapter.ts`、`presentation-shared/paint-budget.ts`、`presentation-shared/formatters.ts`、`presentation/status-modal.tsx`。
- 检查器与预览：`packages/cli/src/tui/presentation/sidebar.tsx`、`sidebar/file-tree-widget.tsx`、`presentation/input-bar.tsx`、`packages/cli/src/workspace/file-preview.ts`、`packages/cli/src/tui/app.tsx`（侧栏按键绑定）。
- 命令注册与 Goal：`packages/cli/src/interactive/commands.ts`、`command-dispatcher.ts`、`packages/cli/src/interactive/features/goal-feature.ts`、`packages/agent/harness_agent/config/config.py`（goal）、`goals/tools.py`、`host/goal_proposal.py`。
- 文件工具与快照：`packages/agent/harness_agent/tools/snapshot_file_contract.py`、`snapshot_file_support.py`、`file_diagnostics.py`、`threads/snapshots.py`。
- 上下文快照：`packages/agent/harness_agent/threads/context_lifecycle.py`。
