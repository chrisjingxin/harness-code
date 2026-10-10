# 用户指南覆盖索引

本页是 `docs/user/` 九份输入文档主题的覆盖映射。生成页以当前 CLI、源码与测试核对后的行为为准，正文操作不依赖旧文档；旧文档仅作为历史对照列在页尾维护线索中。

## 覆盖映射

### 1. 从源码启动和验证（原「快速开始」）

| 主题 | 位置 |
| --- | --- |
| 工具链、依赖同步、`--update-lock`、包源变量 | [快速开始 §1–2](quickstart.md#1-准备开发工具)、[§2](quickstart.md#2-安装并同步锁定依赖) |
| 最小 `~/.harness/config.toml`、密钥环境变量、只读首次任务 | [快速开始 §3–4](quickstart.md#3-创建最小用户配置并设置密钥) |
| 开发检查命令、Bun 边界、无头运行 | [快速开始 §5](quickstart.md#5-开发验证与无头运行) |
| OpenTUI native 包、musl、平台矩阵、发布渠道边界 | [快速开始 §6 与 Backlog](quickstart.md#6-平台与能力边界) |

### 2. 模型、配置和运行时（原「模型配置」与配置模板）

| 主题 | 位置 |
| --- | --- |
| 配置位置、优先级、工作区配置拒绝 | [配置 §配置文件、校验与优先级](configuration.md#配置文件校验与优先级) |
| 完整 TOML 模板、Profile 字段、能力、reasoning、headers | [配置 §模型 Profile 与能力](configuration.md#模型-profile-与能力) |
| 明文密钥降级规则、`config path/show` 脱敏 | [配置 §密钥与 Header 安全](configuration.md#密钥与-header-安全) |
| 环境变量清单、覆盖示例 | [配置 §覆盖变量与配置检查](configuration.md#覆盖变量与配置检查) |
| `/model` 切换语义、Run 绑定 | [配置 §在 Thread 中选择模型](configuration.md#在-thread-中选择模型) |
| Goal grader、runtime_pool、tool_search_defer、分类器 Profile | [配置 §Goal 验收模型](configuration.md#goal-验收模型)、[§运行时池](configuration.md#运行时池)、[§工具延迟加载](configuration.md#工具延迟加载)、[§审批分类器模型](configuration.md#审批分类器模型可选) |
| Provider 终态错误码与 retryable | [配置 §常见失败与安全恢复](configuration.md#常见失败与安全恢复) |

### 3. 日常交互、工作模式和会话（原「交互使用」）

| 主题 | 位置 |
| --- | --- |
| Build/Compose、`/new-work`、`/abandon`、Compose 产物 | [工作流 §选择工作方式](workflows.md#选择工作方式build-或-compose) |
| `/plan`、`/plan-view`、计划文件 `~/.harness/plans/` | [工作流 §先规划再实现](workflows.md#先规划再实现build-的-plan)、[§会话计划文件](workflows.md#会话计划文件) |
| `@` 引用与降级规则 | [工作流 §@ 引用](workflows.md#让-agent-看到正确文件-引用) |
| Slash 命令、运行中限制、未知命令、`//` | [工作流 §高频 Slash Command](workflows.md#高频-slash-command)、[交互专题 §内置 Slash Command 速查](terminal-interaction.md#3-内置-slash-command-速查) |
| 时间线消息/工具/思考/审批/用量呈现、预览截断、只读浮层 | [交互专题 §执行时间线](terminal-interaction.md#1-执行时间线你能看到什么) |
| 项目检查器：文件树/状态/只读预览、`1`/`[`、`2`/`]`、j/k、`@` 填入 | [交互专题 §项目检查器](terminal-interaction.md#2-项目检查器侧栏) |
| 快捷键、Esc/Ctrl+C、审批操作栏 | [工作流 §键盘操作速查](workflows.md#键盘操作速查) |
| `/goal` 查看/创建/替换/edit/pause/resume/clear、验收条件确认、只读 grader、max_iterations、跨 Run 保留与不自动继续 | [交互专题 §/goal](terminal-interaction.md#4-goal目标闭环仅-build) |
| 文件工具 Snapshot/CAS、空文件、错误码与恢复、LSP diagnostics unavailable | [交互专题 §文件工具](terminal-interaction.md#5-文件工具先读唯一匹配与-cas)、[排障 §12](troubleshooting.md#12-文件-snapshot-过期或未读取) |
| AGENTS/Skill 每 Run 快照冻结、`/compact` | [交互专题 §AGENTS/Skill 快照](terminal-interaction.md#6-agentsskill-快照与-compact) |
| `/compact`、`/resume`、undo/redo 范围 | [工作流 §恢复、撤销与重做](workflows.md#恢复撤销与重做) |
| Skills 目录、`skills` CLI、生效时机 | [扩展 §Skill](extensions.md#项目和用户-skill) |

### 4. 审批、Policy 与执行环境（原「安全与沙箱」）

| 主题 | 位置 |
| --- | --- |
| 五档审批矩阵、`auto` 分类器、fail closed | [安全页 §审批模式](terminal-and-safety.md#审批模式) |
| 审批响应五种、settings.json 层级、目录信任卡、Diff 上限、`COMMIT_CONFLICT` | [安全页 §审批响应与规则持久化](terminal-and-safety.md#审批响应与规则持久化) |
| Policy/审批/sandbox 关系、Shell 白名单 | [安全页 §Policy、审批与 sandbox 的关系](terminal-and-safety.md#policy审批与-sandbox-的关系) |
| 远端执行、`--sandbox` 值域 | [安全页 §本机与远端执行环境](terminal-and-safety.md#本机与远端执行环境) |

### 5. Plugin、子代理、Team 与 MCP（原「插件管理」与「subagent」）

| 主题 | 位置 |
| --- | --- |
| Plugin 来源、Adapter、validate/install、TTY consent、安装即启用 | [扩展 §插件](extensions.md#插件先验证再确认再重启) |
| list/inspect 状态、scope、update/remove/purge、Settings 与 `--secret-stdin` | [扩展 §Settings](extensions.md#settings秘密不进入命令行) |
| staging 校验与供应链边界 | [扩展 §供应链段落](extensions.md#插件先验证再确认再重启) |
| 子代理深度/并发/超时/权限交集、`/agents`、`/teams` | [扩展 §子代理与 Team](extensions.md#子代理与-team) |
| `/mcp`、tool_search 发现 | [扩展 §MCP](extensions.md#mcp按需接入外部工具) |

### 6. 本机 Web 工作台（原「Web界面」及交互使用 Web 章节）

| 主题 | 位置 |
| --- | --- |
| `/web` 接管、bootstrap/重连 token 保护与轮换、刷新重连、归还 TUI、65s/运行中限制 | [Web §接管、重连与归还](web-ui.md#接管重连与归还) |
| 主题切换、顶栏状态层级、Run 状态文案、Work Item 卡、Git 状态标签 | [Web §主题与状态](web-ui.md#主题与状态) |
| 三栏贴边布局、侧栏/Dock 拖宽范围、内容列封顶与 Dock 预留宽度语义、Thread/Files 分区、工具调用卡片 | [Web §工作区外围与布局](web-ui.md#工作区外围与布局) |
| Composer 下拉、命令菜单（Ctrl/Cmd+K、`//`、IME、capability 显隐）、Tab/Shift+Tab | [Web §Composer、命令菜单与输入](web-ui.md#composer命令菜单与输入) |
| Markdown 安全边界、离线 Shiki 高亮与 64 KiB/2000 行降级、focus ring 可访问性 | [Web §Markdown、代码与可访问性](web-ui.md#markdown代码与可访问性) |
| 审批/问题表单、文件 Diff 卡（760px split/unified、行号、200 行/16 KiB 截断语义、240px 预览） | [Web §审批、问答与文件变更 Diff](web-ui.md#审批问答与文件变更-diff) |

### 7. 本地日志与离线诊断（原「日志与诊断」）

原「日志与诊断」全部二级/三级主题逐项映射：

| 主题 | 位置 |
| --- | --- |
| 存储位置、目录/文件权限、`.active.jsonl`/`.jsonl` 生命周期、孤儿活跃文件 | [诊断 §存储位置、文件命名与生命周期](diagnostics.md#存储位置文件命名与生命周期) |
| 轮转与清理（14 天/200 MiB/16 MiB、只清已关闭文件） | [诊断 §轮转与清理](diagnostics.md#轮转与清理) |
| `[diagnostics]` TOML、`HARNESS_LOG_LEVEL` 临时覆盖、重启生效、级别语义 | [诊断 §配置与级别](diagnostics.md#配置与级别) |
| 安全与脱敏红线（零正文/凭据/绝对路径/原帧、白名单 Schema） | [诊断 §脱敏红线](diagnostics.md#脱敏红线任何级别包括-debug) |
| `harness logs` 离线边界、Thread 列表（默认 20）、`--thread` 过程树、`--run`、`--level/--event/--component/--limit` | [诊断 §离线查询](diagnostics.md#离线查询harness-logs) |
| `--flat` 表格列与 256 KiB 截断提示、`--cursor` 快照分页 | [诊断 §平铺表格与 Cursor 分页](diagnostics.md#5-平铺表格与-cursor-分页--flat) |
| `--json` 输出字段（query_schema_version/matched_count/next_cursor/diagnostics 等） | [诊断 §机器可读 JSON](diagnostics.md#6-机器可读-json--json) |
| 全部错误码（THREAD_RUN_CONFLICT、CURSOR_EXPIRED/MISMATCH、LOG_ROOT_UNREADABLE、QUERY_OUTPUT_TOO_LARGE 等） | [诊断 §错误处理](diagnostics.md#错误处理) |

### 8. 按症状恢复（原「故障排查」，全部 20 个二级主题）

逐项位置见[故障排查](troubleshooting.md)：

| 主题 | 位置 |
| --- | --- |
| 1. 模型配置或 API Key 缺失 | [排障 §1](troubleshooting.md#1-模型配置或-api-key-缺失) |
| 2. Python sidecar 无法启动 | [排障 §2](troubleshooting.md#2-python-sidecar-无法启动或依赖不同步) |
| 3. OpenTUI 原生包缺失 | [排障 §3](troubleshooting.md#3-opentui-原生包缺失) |
| 4. Plugin 校验/安装/启用失败 | [排障 §4](troubleshooting.md#4-plugin-校验安装或启用失败) |
| 5. Adapter 重新授权 | [排障 §5](troubleshooting.md#5-adapter-更新后是否需要重新授权)（旧 fingerprint 流程已过期） |
| 6. Qwen SubagentStop warning | [排障 §6](troubleshooting.md#6-qwen-subagentstop-hook-warning) |
| 7. Managed Plugin Agent 上下文异常 | [排障 §7](troubleshooting.md#7-managed-plugin-agent-上下文异常) |
| 8. Plugin staging/registry 失败 | [排障 §8](troubleshooting.md#8-plugin-staging-或-registry-失败) |
| 9. Windows 支持状态 | [排障 §9](troubleshooting.md#9-windows-平台支持边界) |
| 10. 终端显示简化/被捕获 | [排障 §10](troubleshooting.md#10-终端界面显示简化或被捕获) |
| 11. 网关请求失败（Provider 终态码） | [排障 §11](troubleshooting.md#11-网关请求失败provider-终态码) |
| 12. 文件 Snapshot 错误码 | [排障 §12](troubleshooting.md#12-文件-snapshot-过期或未读取) |
| 13. 模型未切换 | [排障 §13](troubleshooting.md#13-当前-thread-的模型没有切换) |
| 14. 协议/序号错误 | [排障 §14](troubleshooting.md#14-协议版本或序号错误) |
| 15. Skill 快照不一致 | [排障 §15](troubleshooting.md#15-运行时-skill-快照不一致) |
| 16. Thread 恢复与迁移 | [排障 §16](troubleshooting.md#16-无法恢复-thread含数据库迁移) |
| 17. Web 接管/重连 | [排障 §17](troubleshooting.md#17-web-工作台无法打开或立即断开) |
| 18. 上下文压缩 skipped/failed/overflow | [排障 §18](troubleshooting.md#18-上下文压缩被跳过或失败) |
| 19. Runtime Pool 容量/关闭超时 | [排障 §19](troubleshooting.md#19-runtime-pool-容量不足或关闭超时) |
| 20. 本地日志查询 | [排障 §20](troubleshooting.md#20-使用本地诊断日志排查故障) |
| 求助材料与脱敏要求 | [支持入口页 §请求帮助时提供什么](web-and-support.md#请求帮助时提供什么) |
| 配置类失败速查 | [配置 §常见失败与安全恢复](configuration.md#常见失败与安全恢复) |

## 已确认的源码差异（相对旧文档）

1. **Plugin 安装状态**：旧文档「安装后默认 disabled、`enable --capability-fingerprint`」过期；当前 parser 拒绝该 flag，TTY consent 成功后写入 activation：user scope 初始 `enabled`；workspace scope 的 user 记录为 `disabled` 但目标 workspace override 为 `enabled`（有效 activation 即 `enabled`）。见[扩展：插件](extensions.md#插件先验证再确认再重启)。
2. **审批默认档位是 `auto`**（`policy/approval_mode.py`），未知值收紧为 `default`。
3. **Skill 生效时机**：下一 Run 即生效（Run 准备阶段刷新 catalog）；仅 Plugin Skill 变更需重启 Host。旧文档两种说法冲突，以此为准。
4. **auto 分类器已实际接入**：`auto_mode.py` docstring「F4 占位」为过期注释，两阶段 LLM 分类器生效，可配 `[approval] classifier`。
5. **子代理 300 秒超时**无环境变量可调；`tool_search` 不在 general-purpose 强制排除列表。
6. **日志目录是 `~/.harness/logs`**，旧文档 `~/.harness/debug` 说法过期（见 `packages/cli/src/diagnostic-log/runtime/index.ts`）。
7. **依赖源优先级**：`npm config get registry`/`PIP_INDEX_URL` 高于 `HARNESS_NPM_REGISTRY`/`HARNESS_PYPI_INDEX`。
8. **目录信任卡**只有「本会话信任/拒绝」两项；持久化信任走 `~/.harness/settings.json` 的 trusted_directories。
9. **Web 顶栏**当前不渲染 Run 状态 chip（旧文档相反）；状态在时间线与 Composer 表达。
10. **Plugin 重新授权**：旧文档「`enable --capability-fingerprint`、`authorization_state=reauthorization-required`」过期；当前 parser 拒绝该 flag，全仓无 `PLUGIN_REAUTHORIZATION_REQUIRED` 码，Adapter 刷新保留 activation（`packages/agent/tests/test_plugin_refresh.py`）。

## 尚未交付或需要复核

- **安装器、自动更新与发布渠道**：未交付，指南只覆盖源码工作流（`README.md`、`package.json`）。
- **完整跨平台最终用户验收**：`scripts/dependencies/vendor_policy.mjs` 列出 native 支持矩阵，但单平台成功不等于全部平台验收。
- **企业远端 sandbox**：CLI 支持 `--sandbox=remote`；Provider/factory/认证由企业提供，失败不回退本机。
- **通用本地 LSP client**：无 Plugin LSP manager 时只返回未连接。
- **`pin_default_profile`**：配置可解析但 AgentHost 创建主池未使用，不可依赖（`config.py`、`agent_host.py`）。

## 维护线索

输入对照（历史）：`docs/user/快速开始.md`、`模型配置.md`、`交互使用.md`、`安全与沙箱.md`、`插件管理.md`、`subagent.md`、`Web界面.md`、`日志与诊断.md`、`故障排查.md`。关键事实源：`packages/cli/src/args.ts`、`packages/cli/src/interactive/commands.ts`、`packages/cli/src/tui/application/shortcuts.ts`、`packages/agent/harness_agent/config/config.py`、`policy/`、`plugins/`、`runtime/`、`tools/`、`threads/`、`diagnostic_log/` 与相关测试。更新流程：`openwiki code --update --print`，按 Git impact 只改受影响页面。
