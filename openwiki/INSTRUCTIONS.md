# Harness Code 用户指南生成契约

## 目标、事实源与编辑边界

- 用简体中文为从源码使用 Harness Code 的用户编写可独立操作的指南。`openwiki/quickstart.md` 是入口；读者应能从这里到达配置、终端交互、工作模式、安全、扩展、Web、日志、排障与覆盖索引。
- 本文件是长期的**能力与覆盖要求**，不是运行时事实的最终裁决。每次生成先核对当前 `README.md`、`package.json`、CLI parser、配置模型、Python/TypeScript 实现和相关测试。源码与本文件或已有生成页冲突时，以当前可验证实现为准，并在页面写清能力边界；不要延续过期行为。
- 生成只依赖本文件、当前源码/测试和已有 `openwiki/` 页面。任何关键步骤都须在本指南中完整说明；开发者过程资料可以帮助定位实现，但用户操作结论仍须核对代码和测试。
- 每项用户任务写清适用场景、前提、准确命令或按键、预期结果、权限与平台限制、失败后的安全恢复。正文优先写操作和可观察结果；源码路径集中放在各页末尾的“来源与维护锚点”，供增量更新定位。
- 只编辑 `openwiki/` 中受影响的生成页及导航，不改源码、`README.md` 或本控制文件。由 OpenWiki CLI 管理 `.last-update.json`，不要为了聊天式补页手工改写更新记录。保留准确页面和已有导航，避免无关重写。
- 不读取、展示或复制真实 API Key、Token、认证 Header、Web 接管 URL、完整业务日志或本机私有路径。示例只用占位变量名和虚构域名。未交付、未验证或仅企业提供的能力要明确标识，不写成已可用的产品功能。

## 页面结构与覆盖基线

| 用户主题 | 主要页面 | 必须给出的内容 |
| --- | --- | --- |
| 从源码开始 | `quickstart.md` | 工具链、依赖同步、最小配置、首次只读任务、开发检查、无头模式、平台边界 |
| 模型与运行时配置 | `configuration.md` | TOML 模板、优先级、Profile、密钥、`/model`、Goal grader、运行时池、工具延迟发现 |
| 日常任务与会话 | `workflows.md` | Build、Compose、Plan、`@` 引用、恢复、Undo/Redo、压缩 |
| 终端交互细节 | `terminal-interaction.md` | 时间线、检查器、完整内置命令、`/goal`、文件 Snapshot/CAS、Run 快照 |
| 审批与执行边界 | `terminal-and-safety.md` | 五档审批、Policy、目录信任、文件 Diff、远端执行 |
| 扩展能力 | `extensions.md` | Skill、Plugin、子代理、Team、MCP 及权限交集 |
| 本机 Web | `web-ui.md` | 接管/重连/归还、布局、Composer、命令菜单、审批与 Diff |
| 日志与恢复 | `diagnostics.md`、`troubleshooting.md`、`web-and-support.md` | 离线日志查询、20 类故障、安全恢复与求助材料 |
| 导航与验收 | `coverage-index.md` | 将本节主题逐项映射到实质页面与章节，并标出未交付或待验证项 |

页面可因实现变化增减，但以上能力不能只剩一段摘要。专题之间使用有效相对链接；覆盖索引只按当前能力、现有页面和源码锚点组织，不依赖仓库之外的资料。

## 1. 从源码启动与首次任务

- 当前是源码开发态。核对并写明 Node.js 20+、仓库指定的 npm、Bun 1.3.13、Python 3.11+、uv 和可用的 OpenAI-compatible 模型网关。不要宣称安装器、自动更新、通用预编译包或全平台发布已经交付。
- 在仓库根目录用 `npm run deps:sync` 同步 JS/Python 锁定依赖并应用所需补丁；只有依赖声明或包源变化才用 `npm run deps:sync -- --update-lock`。单独 `uv sync` 不能替代完整同步。包源覆盖变量 `HARNESS_NPM_REGISTRY`、`HARNESS_PYPI_INDEX` 只写占位示例，不写真实内网地址。
- 给出能直接复制的最小 `~/.harness/config.toml` 和环境变量示例，说明 `--cwd` 必须指向已存在工作区。用 `npm run dev` 启动真实 TUI，安排一次只读任务并说明成功时可观察到什么。
- 给出 `npm run deps:test`、`npm run test:project`、`npm run project:check`、`npm run typecheck` 的工程检查入口，并按当前脚本说明 `build`、`test:ts`、完整 `npm test` 和交互 TUI 对 Bun 的要求。无头示例使用 `npm run dev -- --non-interactive --message "..."`，可加 `--json`；无头没有人工审批、问答或目录信任处理器，也不与 `--resume` 合用。
- OpenTUI 需要与当前平台/架构匹配的 native optional package；缺包先核对 npm 源并重新同步，不复制其他机器的 `node_modules`。Linux 默认 glibc，musl 需 `OPENTUI_LIBC=musl`；Windows/macOS 限制应按当前支持矩阵说明；单平台通过不代表跨平台验收。

## 2. 模型、配置与运行时

- 用户配置默认 `~/.harness/config.toml`，可用 `--config <PATH>` 指定。说明 CLI > `HARNESS_*` 环境变量 > 显式配置 > 用户配置 > 默认值的优先级；工作区 `.harness/config.toml` 和 `.harness/config.local.toml` 不自动加载，检测到应在模型请求前拒绝。`config path`、`config show` 仅输出路径和脱敏有效值。
- 给完整、无真实凭据的 TOML v1 模板：`[config] version=1`、`[models] default_profile`、至少一个 `[models.profiles.<id>]`；Profile 包含 `provider="openai-compatible"`、`model`、`base_url`、`api_key_env`、`context_window_tokens`、`capabilities`，并解释可选 `provider_label`、`timeout_seconds`、`max_retries`、`reasoning.effort`、非秘密 `headers` 和秘密来源 `headers_env`。`api_key_env` 保存变量名。仅权限受限的用户级配置允许明文 `api_key` 降级；仓库配置、日志和文档不能出现密钥。`config show` 的密钥来源只能是 `api_key_source=environment|toml|missing` 等脱敏状态。
- 当前主模型走 OpenAI-compatible Chat Completions。说明 tool-calling/streaming/vision 能力、reasoning effort、context window 默认值与下限；未知能力、角色或 Profile 引用须拒绝。OpenWiki 生成器的模型配置与 Harness 的 Model Profile 是两套配置，不能混写。
- `/model` 或 `/models` 在空闲 Thread 选择下一次 Run 的 Profile，不热切当前 Run。用户级默认 Profile 的受控同步可能失败，届时当前 Thread 选择仍成立而新 Thread 默认未变；以 `run.started` 的实际模型为准。角色绑定可有 planner/executor/reviewer/tester/summarizer；主模型当前由 Single Agent 的 executor 绑定解析，不宣称 Planner→Executor 自动调度。
- 覆盖 `HARNESS_MODEL`、`HARNESS_BASE_URL`、`HARNESS_API_KEY_ENV`、`HARNESS_TIMEOUT_SECONDS`、`HARNESS_MAX_RETRIES`、`HARNESS_APPROVAL_MODE`、`HARNESS_SANDBOX`、`HARNESS_GOAL_GRADER_MODEL`、`HARNESS_GOAL_MAX_ITERATIONS` 的适用范围。
- `[goal] grader_model` 可引用已有 Profile，缺省继承实际主模型；`max_iterations` 默认 3、范围 1–20，不可用 grader 在 Run 受理前失败。`[runtime_pool]` 的 `max_profiles=8`、`idle_ttl_seconds=1800`、`close_timeout_seconds=15` 是当前默认；`pin_default_profile` 虽可解析，当前主池没有使用它，不能宣称会固定默认 Profile。`[tools] tool_search_defer="auto"` 的 DeepSeek 特例及 on/off 覆盖要以当前实现核对。

## 3. 终端交互、工作模式与会话

- 一条 TUI 时间线按发生顺序混排用户/Agent 消息、思考、工具、审批和提问；Activity 可折叠，子代理 task 卡进入只读子时间线。RunFooter 与 `/status` 展示实际结果、模型、耗时和用量。预览/思考/工具详情有显示预算；截断不改变真实执行或审批范围。审批 Diff 被截断时，应先取得可完整审阅的变更再决定是否批准。
- `@` 支持工作区文件搜索和 `@path`、`@path#L20-50`、`@"space path"#L10`；目录选择只导航，文件选择才插入草稿。说明小文件内联阈值、总预算、二进制/大文件/生成物/越界路径降级；降级不等于 Agent 已读取文件。
- 列出 Enter、Shift+Enter、`/`、Ctrl+P、Esc、Ctrl+C、Ctrl+O、Tab、Shift+Tab、空输入历史键和滚动键。Esc 不取消 Run；Ctrl+C 在运行中取消。项目检查器提供文件树、只读预览和 Git 状态；侧栏 `1`/`[`、`2`/`]`、方向键或 j/k、`@` 的实际行为要与 TUI 绑定一致。预览按当前限制处理大文件、二进制、非 UTF-8 和读取时变更；非 Git 工作区不显示变更列表。
- Build 是默认自主任务。Compose 是需求→规格→计划→实现→检视，固定产物位于 `docs/compose/<短名>/`：`task.md`、`spec.md`、`plan.md`、`todo.md`、`report.md`；可在确认阶段恢复，`/new-work` 开新需求，`/abandon` 不回滚文件。Build 的 `/plan` 只可写会话计划 `~/.harness/plans/<thread_id>.md`，与 Compose 计划阶段不同；说明进入、查看、批准实现、继续打磨与退出。
- 以 `packages/cli/src/interactive/commands.ts` 为内置 Slash Command 注册表，逐条列用途、别名、工作模式、能力要求和运行中可用性。至少覆盖 `/help`、`/quit`、`/new`、`/status`、`/title`、`/btw`、`/goal`、`/plan`、`/plan-view`、`/agents`、`/teams`、`/mcp`、`/compact`、`/resume`、`/undo`、`/redo`、`/model`、`/skills`、`/web`、`/new-work`、`/abandon`。同时列出 `/clear`、`/q`、`/continue`、`/threads`、`/rewind`、`/rollback`、`/models` 等实际别名。未知命令不送模型，`//` 可发送以斜杠开头的普通文本。运行中 `/skills` 显示禁用原因但不能选择；`/mcp` 可看状态，增删需空闲。
- `/goal` 仅 Build：无参查看；文字创建或替换；`edit`、`pause`、`resume`、`clear` 管理目标。验收条件草案须经确认；运行中请求排队，跨 Run 持久，不在后台无限自动续跑。说明只读 grader、受控复验、迭代上限和一次性 continuation；`/plan`、`/btw`、Compose 不参与验收。没有 `/goal model`、`/goal max-iterations` 子命令。
- `/compact` 可 skipped/failed，压缩不删除完整 Transcript；`/resume` 仅选择当前 project 的 Thread。历史、Checkpoint 和 Artifact 保存在 `~/.harness/threads.sqlite3`，清理数据库前先停机备份。Undo 说明代码与对话/仅对话/仅代码三种范围及非 Git 限制；Redo 只在 Undo 后、发送新 Prompt 前可用。
- 每个顶层 Run 准备阶段重新冻结 AGENTS 与项目/用户 Skill 快照；当前 Run 不热更新。`write_file` 只创建新文件，`edit_file` 须先 `read_file` 获取当前 Thread Snapshot、提交唯一且已读的 `old_string`，`delete_file` 须完整读取。空文件也要先读；不支持盲写、replace_all 或行号批量 patch。出现过期、未读、冲突或写后漂移时重读重审；LSP diagnostics unavailable/timeout 不代表零问题。

## 4. 审批、Policy 与执行环境

- 五档审批 `plan → default → auto-edit → auto → yolo` 的行为用矩阵解释，并写明默认 `auto`、旧值 `ask` 与 `default` 的兼容、Shift+Tab 切换、活动 Run 的确认与 busy 状态。`plan` 限制项目写入、会写 Shell、task 和会写 MCP；`auto-edit` 仅在授权工作区放行编辑；`auto` 对未由确定性规则裁决的风险走两阶段分类，不确定或失败回人工；`yolo` 仍受硬 Policy、路径与操作系统限制。只读 Shell 与分类器的具体边界以当前规则核对。
- 审批响应包括允许一次、本会话、本项目、拒绝、拒绝并反馈。本项目规则存 `.harness/settings.json`；危险根命令不可无条件永久放行。外部目录首次访问需目录信任，不能与历史 trust registry 混写。文件审批 Diff 有界但批准针对固定完整变更，提交前仍做版本比较；`COMMIT_CONFLICT` 不覆盖外部修改。
- Policy 规定角色能力上限，审批决定人工确认，sandbox 决定实际隔离；Goal、Compose、Plugin 子代理都不能提权。`/.harness/` 是受控只读逻辑命名空间。本机执行可能未隔离，不宣称存在通用本地容器 sandbox。企业远端仅在 Provider/factory 可用且验证后按 `[execution] backend="remote"`、`[execution.remote]` 或 `--sandbox=remote` 使用，失败不回落本机；认证不写进 TOML `params`。Shell 白名单不是沙箱，复杂语法按规则拒绝。

## 5. Skill、Plugin、子代理、Team 与 MCP

- 项目 Skill 位于 `.harness/skills/<name>/SKILL.md`，用户 Skill 位于 `~/.harness/skills/<name>/SKILL.md`；`skills list|inspect|enable|disable` 与 TUI `/skills` 职责不同。项目/用户 Skill 在下一 Run 刷新，Plugin Skill 需启动新 Host；市场能力需企业 Provider，不能宣称公网服务可用。
- Plugin 从本地目录或 zip 安装。覆盖 `plugins validate|install|list|inspect|enable|disable|update|remove`、user/workspace scope、受管 store、状态与组件。`validate` 不写 registry；`install` 必须真实 TTY 明确同意，不支持 `--yes` 绕过。安装确认后 user scope 初始有效状态为 enabled；workspace scope 的 user 记录为 disabled，但目标 workspace override 为 enabled，有效状态仍为 enabled。当前 CLI 不接受 `--capability-fingerprint`。管理动作影响下一 Host 启动快照，不热改当前 Host。
- Plugin Settings 仅在声明支持时管理：真实 TTY 无回显，非交互 set 用 `--secret-stdin`；秘密不进 argv、registry 或日志，只传给有效 MCP/Hook/LSP 子进程。说明 Command、Skill、Agent、Context、Team、MCP、Hook、LSP、Monitor 的可见位置，以及 staging 对 manifest、路径、大小、symlink、压缩比和特殊文件的检查。update 保留 activation；remove 默认保留 data，`--purge-data` 才清理。Plugin 不是 OS sandbox，只安装可信来源。
- 主 Agent 用 `task` 委派：explore 只读 `ls/read_file/glob/grep/lsp`，general-purpose 可完成多步骤任务，Plugin Agent 与父权限取交集。深度 1、同时最多 4 个、超额排队、默认 300 秒硬超时；取消父 Run 会取消子任务；超时可显示 `DELEGATION_TIMEOUT`，不自动判主 Run 失败。主线展示 task 卡，子时间线只读，审批仍由主会话处理；无交互通道而需人工审批时失败关闭。内置子代理不能再次 `task`，其它强制排除项按当前角色定义核对。
- `/agents` 浏览可用角色；`/teams` 负责查看、生成、异步运行、查询和取消 Team Run，不能与普通 Thread 恢复混同。`/mcp add <name> <command> [args]` 添加 stdio，`--url` 加可选 `--sse` 添加 HTTP/SSE，`/mcp remove <name>` 删除，裸 `/mcp` 查看状态；执行中只能查看。低频与 MCP 工具可经 `tool_search` 关键词或 `select:name` 发现，调用仍受 Policy 与审批。

## 6. 本机 Web 工作台

- 空闲时 `/web` 在 `127.0.0.1` 随机端口接管当前会话；CLI 保持 Host，Web/TUI 共用 Core、Timeline、审批和 Composer。页面关闭后归还 TUI，短暂刷新可重连；运行中和待审批/问答时的切换限制以当前实现核对。接管 URL 与 token 不进入日志、截图或求助材料，不建议对外监听。
- 覆盖 Thread 创建/搜索/恢复、文件栏、Model/Skills/MCP/Status Dock、Help、主题、Composer、Ctrl/Cmd+K 命令菜单、中文 IME、Markdown/代码复制、审批、问答和文件 Diff。Diff 可左右/行内切换，展示 old/new 行号与 +/-；截断时批准仍针对完整拟议变更。状态用文字/图标和可访问焦点，不只靠颜色。顶栏当前不渲染 Run 状态 chip；状态在时间线与 Composer 表达。
- 布局宽度、预览上限、重连时限与 token 轮换应核对 Web adapter/组件和测试再写具体值。Markdown 不执行 raw HTML、不自动加载远端图片，语法高亮资产离线；接管或重连失败应安全归还 TUI。

## 7. 本地日志与离线诊断

- 结构化日志位于 `~/.harness/logs/<YYYY-MM-DD>/`（Windows 使用用户目录对应路径），CLI 与 Python Agent 分别写 `.active.jsonl`，正常关闭/轮转后为 `.jsonl`。默认保留 14 天、总 200 MiB、单文件 16 MiB；只有关闭文件参与清理，异常退出的 active 文件仍可查询。
- `[diagnostics]` 覆盖 `level`（debug/info/warn/error）、`retention_days`、`max_total_mib`、`max_file_mib`；`HARNESS_LOG_LEVEL` 临时覆盖须重启进程。任何级别都不能记录 Prompt、模型正文、源码、完整工具入参/结果、凭据、绝对工作区路径或原始 RPC 帧；对外分享前仍检查敏感命名。
- `harness logs`（开发模式 `npm run dev -- logs`）离线读取 JSONL，不启动 sidecar、不访问 SQLite、查询本身不写新日志，也不接受 `--config`。默认最近 20 个 Thread；`--thread` 看过程树、`--run` 看单次 Run，二者互斥；`--level`、`--event`、`--component`、`--limit 1..1000` 组合过滤；`--flat` 表格与 `--cursor` 快照分页，`--json` 机器输出。给完整示例、字段意义和 CURSOR_EXPIRED/MISMATCH、LOG_ROOT_UNREADABLE、QUERY_OUTPUT_TOO_LARGE 等错误的安全处理；不存在的日志目录返回空结果，不报不可读。

## 8. 按症状恢复的 20 个主题

每个主题写“症状或稳定错误码 → 优先检查 → 安全操作 → 不该走的捷径”：

1. 模型配置或 API Key 缺失。
2. Python sidecar 启动失败或依赖不同步。
3. OpenTUI 原生包缺失。
4. Plugin 校验、安装或启用失败。
5. Adapter 更新后的 activation 与授权状态。
6. Qwen SubagentStop Hook warning。
7. Managed Plugin Agent 上下文异常。
8. Plugin staging 或 registry 失败。
9. Windows 平台支持边界。
10. 终端界面显示简化或被捕获。
11. 网关请求失败与 Provider 终态码。
12. 文件 Snapshot 过期、未读、匹配失败或 CAS 冲突。
13. 当前 Thread 的模型没有切换。
14. 协议版本或事件序号错误。
15. Run 的 Skill 快照不一致。
16. Thread 恢复与数据库迁移失败。
17. Web 工作台无法打开、接管或重连。
18. 上下文压缩 `manual_skipped`、`auto_skipped`、`*_failed` 或 overflow。
19. Runtime Pool 容量不足或关闭超时。
20. 用本地诊断日志定位故障。

- Provider 错误至少区分 `MALFORMED_TOOL_CALL`、`PROVIDER_OUTPUT_INTERRUPTED`、`PROVIDER_RATE_LIMITED`、`PROVIDER_RETRY_EXHAUSTED`、`PROVIDER_REQUEST_REJECTED`、`TOOL_CALL_ID_UNAVAILABLE`。已公开部分正文后不能自动重放同一回合；`retryable=true` 只表示修复后可开新 Run。
- 文件错误至少覆盖 `SNAPSHOT_REQUIRED`、`SNAPSHOT_EXPIRED`、`STALE_FILE`、`UNREAD_RANGE`、`EXACT_MATCH_NOT_FOUND`、`AMBIGUOUS_MATCH`、`FILE_ALREADY_EXISTS`、`INVALID_EDIT`、`COMMIT_CONFLICT`、`POST_WRITE_DRIFT`、`BACKEND_CAS_UNSUPPORTED`、`UNSUPPORTED_FILE_TYPE`；分别给重读、缩小目标或改用支持安全文本修改的执行方式，不能用盲写绕过 CAS。
- 遇到 `THREAD_STORE_UNAVAILABLE` 或 `CHECKPOINT_MIGRATION_*`，先停止全部 CLI/sidecar/migration worker，备份 `threads.sqlite3` 及 WAL/SHM，先用当前 `migration_recovery` 做只读诊断；确认停机后才能运行需要显式确认的写入恢复。不可手改 SQLite schema/version、删除 attempt/poison/backup 文件或绕过门禁。

## 生成、增量更新与验收

1. 先确认本文件与 `quickstart.md` 可读，发现受影响能力，再从当前 parser、配置、实现和测试核实事实。页面尾部写真实源码路径，便于 Git impact 将后续变更映射到对应页面。
2. `openwiki code --init --print` 生成完整指南；`openwiki code --update --print` 只刷新受影响页面、导航和覆盖索引，保留无关页面。新能力若没有对应页面，补专题或实质章节；能力覆盖以本文件和当前实现为准。聊天式补页不得伪造 `.last-update.json` 的 `command`、`gitHead`、时间或模型。
3. 检查所有 Markdown 的 UTF-8、代码围栏、相对文件与锚点；核对 CLI 命令、参数、错误码及源码路径；确认首页可到达专题、覆盖索引每项有实质说明、无凭据/接管 token/私有端点泄露。运行与改动范围相称的测试和构建，再报告验证结果及尚未验证的平台或发布能力。
