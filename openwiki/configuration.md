# 模型与配置指南

本页说明 Harness 如何读取配置、选择 OpenAI-compatible 模型、保护凭据，以及配置 Goal 验收、运行时池和工具延迟加载。示例不含真实密钥；请把占位 endpoint、model ID 和环境变量名替换成组织提供的值。首次准备开发环境见[快速开始](quickstart.md)；审批与执行安全边界见[终端交互与安全](terminal-and-safety.md#审批与执行边界)。

## 配置文件、校验与优先级

默认用户文件是 `~/.harness/config.toml`。用本机用户账户的编辑器创建或更新此文件；若 `.harness` 目录不存在，先在用户主目录下建立它。模板里的 `api_key_env` 与 `headers_env` 只写环境变量名，真实凭据须由组织批准的 Secret Manager、系统凭据工具或安全启动环境注入进程，勿将真实值放进仓库、TOML 或命令历史。普通运行和 `config show`/`config path` 都可用 `--config PATH` 指定显式配置。每份 TOML 文件都必须有 `[config]` 且仅含 `version = 1`；解析器会拒绝未知顶层区段、尚未实现的区段、未知字段、类型错误和不支持的值。Harness 不会对一般 TOML 字符串展开 `$VAR` 或 `${VAR}`；使用专门的 `*_env` 字段引用环境变量名。

对于同一设置，实际应用的覆盖层是：受支持的 CLI 覆盖（目前例如 `--sandbox`）→ `HARNESS_*` 环境变量 → 显式 `--config` 文件 → 用户配置 → 程序默认值。并非每个字段都支持 CLI 或环境变量覆盖。用户文件先加载，显式文件随后按字段覆盖；同名 Profile 逐字段合并，`headers`、`headers_env`、`reasoning` 等嵌套映射按键合并。

工作区 `.harness/config.toml` 和 `.harness/config.local.toml` **不会自动加载**。若检测到其中任一文件，运行会在模型请求前拒绝继续；只有通过 `--config` 精确指向该文件时才作为显式输入处理，并仍受显式配置的安全校验约束。团队配置宜迁移至用户级配置；若确需显式读取仓库文件，不要将任何凭据写入其中。

下面的模板覆盖本页讨论的模型、Goal、池、工具和诊断设置。`[approval]` 与 `[execution]` 只是当前有效的非秘密默认示例，可按需省略；没有写出的其他设置使用程序默认值。它不是所有扩展（如 MCP）的配置清单。

```toml
[config]
version = 1

[approval]
mode = "auto"

[execution]
backend = "local"

[models]
default_profile = "main"

[models.profiles.main]
provider = "openai-compatible"
provider_label = "企业主模型"
model = "your-main-model-id"
base_url = "https://gateway.example.invalid/v1"
api_key_env = "HARNESS_API_KEY"
timeout_seconds = 120
max_retries = 2
context_window_tokens = 128000
capabilities = ["tool-calling", "streaming"]

[models.profiles.main.reasoning]
effort = "medium"

# 固定 Header 只能放非秘密值。
[models.profiles.main.headers]
"X-Gateway-Tier" = "standard"

# 值必须是环境变量名，而不是 Header/密钥值。
[models.profiles.main.headers_env]
"X-Org-Token" = "HARNESS_ORG_TOKEN"

# 可选的独立 Goal grader Profile；删掉此段和下方 grader_model
# 即使用本次 Run 的主模型进行 Goal 验收。
[models.profiles.reviewer]
provider = "openai-compatible"
provider_label = "企业验收模型"
model = "your-review-model-id"
base_url = "https://gateway.example.invalid/v1"
api_key_env = "HARNESS_API_KEY"
context_window_tokens = 32768
capabilities = ["tool-calling", "streaming"]

[models.roles]
executor = "main"
reviewer = "reviewer"

[goal]
grader_model = "reviewer"
max_iterations = 3

[runtime_pool]
max_profiles = 8
idle_ttl_seconds = 1800
close_timeout_seconds = 15
pin_default_profile = false

[tools]
tool_search_defer = "auto"

[diagnostics]
level = "info"
retention_days = 14
max_total_mib = 200
max_file_mib = 16
```

把 `example.invalid` 换成网关提供的真实地址；它是保留的示例域名，并非可用服务。若网关不接受 `reasoning.effort`，移除该子表。认证 Header 仅在确实需要时放入 `headers_env`，并由安全的环境注入方式提供对应值。

## 模型 Profile 与能力

当前 Profile 使用 `provider = "openai-compatible"`，通过 OpenAI Chat Completions 兼容接口请求。不能把 Anthropic 或 Gemini 原生 SDK 配置写成当前支持的 Provider。每个 Profile 必须提供非空 `model` 与 `base_url`；`models.default_profile` 必须指向已定义 Profile。

| 字段 | 作用与校验 |
| --- | --- |
| `provider` | 只支持 `openai-compatible`；缺省也按此值解析，建议明确写出。 |
| `provider_label` | 供界面展示的非秘密名称，最长 80 个字符；缺省为 `OpenAI-compatible`。 |
| `api_key_env` | 密钥环境变量名，默认 `HARNESS_API_KEY`；必须是大写变量名格式，例如 `HARNESS_API_KEY`。它不是密钥值。 |
| `timeout_seconds` | 请求超时秒数，默认 120，最小 0.1。 |
| `max_retries` | 请求失败后的额外重试预算，默认 2、最小 0；实际最多尝试次数包含首次请求。只对被判定为可恢复的错误有限重试。 |
| `context_window_tokens` | 上下文窗口声明，默认 128000，显式值最小 16384。应与实际模型/网关一致。 |
| `capabilities` | 可声明 `tool-calling`、`streaming`、`vision`、`json-mode`；省略时按 `tool-calling` 与 `streaming` 处理。显式列表不能为空或含未知项。 |
| `reasoning.effort` | 可选，取 `low`、`medium` 或 `high`，传给 Chat Completions 请求；需确认网关支持。 |
| `headers` | 非秘密固定字符串 Header 映射。认证、Cookie、API-Key 等值不可字面量写入。 |
| `headers_env` | Header 名到环境变量名的映射；环境变量名必须符合大写命名格式。 |

Harness 根模型启动要求 `tool-calling` 和 `streaming` 两项能力。缺少必需能力时 Profile 不可用于根 Agent，即使 endpoint 与凭据正确；`vision` 和 `json-mode` 是可选能力声明，不会替代前两项。

`[models.roles]` 可引用 `planner`、`executor`、`reviewer`、`tester`、`summarizer`。角色未绑定时回退 `default_profile`；角色名或 Profile 引用无效会使配置失败。当前单 Agent 主模型绑定使用 executor/default Profile；配置多个角色**不表示**系统已自动构成 Planner→Executor→Reviewer 拓扑。不要依靠角色映射推断尚未运行的模型调度。

## 密钥与 Header 安全

推荐让受信任的密钥管理器、CI Secret 或本地安全启动器把凭据注入进程环境，不要在聊天、文档、命令行参数、仓库或日志里粘贴真实值。环境变量名（如 `HARNESS_API_KEY`）可以写在配置中；密钥本身不可以。

只有默认用户级 `~/.harness/config.toml` 允许在 Profile 中设置非空 `api_key`，它只是环境变量缺失时的低安全性降级值。环境值优先于 TOML 降级值。在 POSIX 系统上，加载含该字段的用户配置时会尝试将文件权限收紧为 `0600`；不能检查或收紧权限时会拒绝使用。显式 `--config` 文件不接受字面量 `api_key`，工作区配置也不能藉此绕过限制。优先使用 `api_key_env`，不建议启用明文降级值。

`headers` 只能放诸如非秘密路由标签的固定值；`Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`、`X-API-Key` 及名称中包含 authorization/API-key 的敏感头会被拒绝，改用 `headers_env`。不要用普通字符串内的 `$VAR` / `${VAR}` 语法代替环境变量专用字段。

## 覆盖变量与配置检查

模型环境覆盖修改当前 `default_profile` 的相应字段，不是修改所有 Profile：

- `HARNESS_MODEL`、`HARNESS_BASE_URL`、`HARNESS_API_KEY_ENV`
- `HARNESS_TIMEOUT_SECONDS`、`HARNESS_MAX_RETRIES`
- `HARNESS_APPROVAL_MODE`、`HARNESS_SANDBOX`
- `HARNESS_GOAL_GRADER_MODEL`、`HARNESS_GOAL_MAX_ITERATIONS`
- 诊断日志级别：`HARNESS_LOG_LEVEL`

例如 `HARNESS_API_KEY_ENV` 的值应是另一个环境变量的**名称**，而 `HARNESS_API_KEY`（或 Profile 配置的其他变量）才承载凭据。`HARNESS_SANDBOX` 可设为 `true`/`remote` 请求企业远端执行，或 `false`/`off` 关闭；CLI `--sandbox` 覆盖该环境层。它不是本机 Docker/Podman 容器开关。执行边界见[本机与远端执行环境](terminal-and-safety.md#本机与远端执行环境)。

在仓库根目录查看实际路径和脱敏后的有效配置：

```bash
npm run dev -- config path
npm run dev -- config show

# 检查显式文件（不会打印密钥值）
npm run dev -- config path --config ./harness-user.toml
npm run dev -- config show --config ./harness-user.toml
```

`config path` 报告工作区、实际加载路径和显式路径；`config show` 展示有效配置摘要，不展示 API Key 内容，密钥来源以 `environment`、`toml` 或 `missing` 表示。但脱敏不等于可公开：输出仍可能包含 endpoint、静态非秘密 Header、配置路径和工作区信息，分享前请检查并遮蔽内部信息。

## 在 Thread 中选择模型

交互式 TUI 空闲时使用 `/model` 或 `/models` 打开可用 Profile 选择器，可输入查询筛选后确认。选择影响当前 Thread 的**下一次 Run**，不会热切换正在运行的 Run。当前实现也会尝试把所选 Profile 写为未来新 Thread 的用户默认值；这两件事相互独立：若配置服务不可写、显式配置生效或更高优先级来源覆盖，当前 Thread 的选择仍保留，但新 Thread 默认可能不变。

Thread 恢复时会根据当前选择、持久化的 Run 绑定和旧版绑定解析模型；不要仅凭当前配置推断历史 Run 实际用了哪个模型。已受理 Run 的实际绑定是核对模型身份的权威依据。遇到 `MODEL_PROFILE_NOT_FOUND`、`MODEL_PROFILE_UNAVAILABLE` 或 `MODEL_PROFILE_CAPABILITY_MISSING` 时，先检查 Profile ID、密钥来源和必需能力，再重新选择或启动新 Run。

## Goal 验收模型

`[goal].grader_model` 是可选 Profile ID，必须引用配置中存在且可用于执行的 Profile。省略时 Grader 继承该次 Run 的**实际主模型**。显式指定的 Profile 不可用时以 `GOAL_GRADER_MODEL_UNAVAILABLE` 失败，不会静默退回主模型。`max_iterations` 默认 3，范围 1–20；环境变量 `HARNESS_GOAL_GRADER_MODEL` 和 `HARNESS_GOAL_MAX_ITERATIONS` 可覆盖相应字段。

该设置控制 Build Goal 验收流程的运行上限，不会安排后台任务，也不意味着 Harness 会在用户离开后自动继续。若验收模型报错，确认 Profile、endpoint、凭据和能力后再开始新的 Run。

## 运行时池

`[runtime_pool]` 配置共享 AgentEngine Pool：

| 字段 | 默认值 | 允许范围/含义 |
| --- | ---: | --- |
| `max_profiles` | 8 | 1–64；池中可缓存的引擎 Profile 上限。 |
| `idle_ttl_seconds` | 1800 | 60–86400；空闲引擎 TTL。TTL 检查由租约释放后的池清理触发，不是独立后台定时器；过期引擎可能要等下一次清理才退出。 |
| `close_timeout_seconds` | 15 | 1–120；池关闭时等待单个引擎清理的超时。超时会报告关闭失败，不表示 Thread 历史被删除。 |
| `pin_default_profile` | `false` | 布尔字段。当前配置解析了该值，但 AgentHost 创建主池时没有将它传入池，不能依赖它固定默认 Profile。 |

### 审批分类器模型（可选）

`[approval]` 区段支持 `classifier = "<profile id>"`，为 `auto` 档的 LLM 安全分类器指定独立 Profile。未配置时分类器复用当前 Run 的主模型（单次调用、无 SDK 重试）；显式指定的 Profile 缺失或无密钥时分类器优雅降级回主模型。分类调用与主对话事件流隔离，不会出现在 TUI 时间线；详见[审批与执行边界](terminal-and-safety.md#审批与执行边界)。

容量达到上限时，池尝试按最近使用情况淘汰空闲、安全候选；候选不得有活动 lease、Run 或排队任务，也不得处于 pinned 状态。若没有可安全淘汰的候选，会失败并报告 `RUNTIME_POOL_CAPACITY_EXHAUSTED`。此时等待活动 Run/租约结束后重试；若确有并发需求，可在校验允许的范围内提高 `max_profiles`，再重启使池配置生效。淘汰的是内存运行时引擎，不删除 SQLite 中保存的 Thread 历史。池参数在 AgentHost 创建池时读取，调整后需重启 Host 才能应用。

## 工具延迟加载

`[tools].tool_search_defer` 默认 `"auto"`，也接受布尔值：`true` 等于 `"on"`，`false` 等于 `"off"`。

- `"auto"`：根据模型信息识别 DeepSeek 系模型时关闭延迟加载，其它模型启用。该默认策略避免破坏对前缀缓存敏感模型的缓存。
- `"on"`：低频内置工具与 MCP 工具不在初始工具列表全部展开；模型可通过 `tool_search` 按关键词或 `select:name` 查找，命中后在后续请求中可见。
- `"off"`：将工具全量注入；`tool_search` 仍可用作发现辅助。

改动该项后应在新 Run 验证工具发现与目标工具调用。若模型找不到某个低频或 MCP 工具，确认延迟加载已启用并尝试使用准确工具名搜索；关闭延迟加载可作为诊断对照，但会增加初始工具列表规模。

## 常见失败与安全恢复

| 症状/错误 | 优先检查与恢复 |
| --- | --- |
| TOML 解析失败、缺少 `[config]`、版本不是 1 | 检查 TOML 引号、重复键和 `[config] version = 1`；每份用户/显式文件都必须独立声明版本。不要靠删除校验绕过。 |
| 未知字段、未知区段或提示区段 planned/not supported | 与当前已实现清单对照，删除无效字段。比如 `skills`、`agents`、`telemetry`、`updates`、`hooks`、`extensions`、`plugins` 等尚不能作为用户 TOML 区段使用；扩展功能可用不等于有同名 TOML 区段。 |
| Profile 无法启动或显示 `API_KEY_MISSING` | 确认 `api_key_env` 填的是变量名、进程确实收到对应值、Profile 的 `model`/`base_url` 正确；检查 `config show` 中的 `api_key_source`，但不要打印变量值。 |
| `MODEL_PROFILE_NOT_FOUND` / 角色引用错误 | 检查 `models.default_profile`、`models.roles` 和 `[goal].grader_model` 的 ID 是否与 Profile 名精确一致。 |
| `MODEL_PROFILE_CAPABILITY_MISSING` | 为实际支持工具调用与流式响应的模型声明两项必需能力；不要为了通过校验而虚报能力。 |
| 项目配置被拒绝 | 工作区配置不会自动加载。移入用户配置，或通过 `--config` 显式指定确切文件；显式文件仍不允许明文密钥。 |
| `/model` 已切换但新 Thread 仍用旧默认 | 当前 Thread 的选择与未来默认同步是独立操作。留意选择器对“未来新 Thread 默认未更新”的提示；可用 `npm run dev -- config show` 检查当前有效 Profile 与配置来源，并确认显式配置/环境覆盖是否仍在生效。重新选择不能保证绕过更高优先级覆盖。 |
| endpoint 拒绝请求、认证失败或超时 | 核对 Chat Completions 兼容路径、网关要求的模型 ID、超时、凭据来源和 Header 环境映射；不要将认证信息改写成 TOML 字面量 Header。 |
| `GOAL_GRADER_MODEL_UNAVAILABLE` | 检查 grader Profile 存在、密钥可用、能力满足要求；显式 grader 不会静默回退，修复配置后启动新 Run。 |
| `RUNTIME_POOL_CAPACITY_EXHAUSTED` | 等待运行与租约释放；必要时将 `max_profiles` 调到 1–64 的适当值并重启。不要认为此错误意味着 Thread 历史损坏或丢失。 |
| 关闭超时或资源清理失败 | 查看脱敏诊断并允许进程完成关闭；增大 `close_timeout_seconds` 仅适用于安全关闭时间确实不足的情况。超时本身不证明数据库或 Thread 历史已删除。 |

Provider 重试只针对有界预算内的可恢复错误；它不是无限重放。典型终态包括 `MALFORMED_TOOL_CALL`（模型输出的工具调用格式错误）、`PROVIDER_OUTPUT_INTERRUPTED`（流式输出中断）、`PROVIDER_RATE_LIMITED`（限流）、`PROVIDER_RETRY_EXHAUSTED`（瞬时错误耗尽重试预算）、`PROVIDER_REQUEST_REJECTED`（请求被 Provider 拒绝）和 `TOOL_CALL_ID_UNAVAILABLE`（工具事件缺少可关联 ID）。其中 `retryable=true` 表示修复条件后可尝试开启一个新 Run，不表示当前 Run 会再次播放；请求若已向用户公开部分正文，不应自动重放同一回合。遇到中断时先检查终态和已显示内容，再修正配置/等待限流解除后，明确提交新的 Run。

## 来源与维护锚点

- 配置格式、覆盖、Profile、环境变量、安全校验：`packages/agent/harness_agent/config/config.py`、`packages/agent/harness_agent/config/config_manifest.py`。
- 审批分类器 Profile：`packages/agent/harness_agent/config/config.py`（`[approval].classifier`）、`packages/agent/harness_agent/policy/classifier.py`。
- 配置写入白名单及来源限制：`packages/agent/harness_agent/config/config_change_service.py`、`packages/cli/src/interactive/features/model-feature.ts`。
- CLI 命令行语义：`packages/cli/src/args.ts`、`packages/cli/src/interactive/commands.ts`。
- Thread/Run 模型绑定和根模型能力：`packages/agent/harness_agent/runtime/execution_binding.py`。
- Goal Grader 绑定：`packages/agent/harness_agent/goals/context.py`。
- 运行时池与 Host 生命周期：`packages/agent/harness_agent/runtime/agent_engine.py`、`packages/agent/harness_agent/host/agent_host.py`。
- Provider 重试和稳定错误分类：`packages/agent/harness_agent/runtime/provider_retry.py`、`packages/agent/harness_agent/runtime/managed_agent_executor.py`。
