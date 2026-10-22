# Skill、插件、子代理与 MCP

扩展能让 Harness 接入额外工作方法、工具或专业角色，同时也扩大了需要审查的供应链和进程边界。本页自包含 Skill、Plugin、子代理、Team 与 MCP 的完整操作说明。

## 项目和用户 Skill

项目 Skill 放在：

```text
<workspace>/.harness/skills/<name>/SKILL.md
```

用户 Skill 放在 `~/.harness/skills/<name>/SKILL.md`（也兼容 `~/.harness/skills/local/<name>/SKILL.md`）。Skill 目录在每次 Run 启动准备阶段刷新并冻结快照：**修改 Skill 目录后，下一次 Run 即生效**，无需重启；但 Plugin 带来的 Skill 只在 Host 启动时解析，变更 Plugin 需重启 Host。同名时使用完整 canonical ID 区分，例如 `project/review`。

在仓库根目录或以 `--cwd` 指定工作区运行：

```bash
npm run dev -- skills list
npm run dev -- skills inspect project/review
npm run dev -- skills disable project/review
npm run dev -- skills enable project/review
```

CLI 还支持 `skills trust|install|update|remove|market`（install/update 需 `--market`）；管理操作经 JSON-RPC 交给已启动的 sidecar 执行。TUI 内的 `/skills` 是选择器，把一个 Skill 附到下一条消息，二者用途不同。

交互会话中用 `/skills` 搜索并将一个 Skill 附到下一条消息。Skill 内容不是权限授予：不能新增工具、放宽 Policy 或绕过审批。企业市场安装/更新只通过已配置 Provider；没有 Provider 时应得到明确诊断，而不是访问公网。

## 插件：先验证、再确认、再重启

Plugin 管理在 Shell CLI 完成，不在 TUI/Web 提供安装面板。来源可以是本地目录或 zip；Harness 复制到受管存储，不从原始源码目录直接执行。支持 portable、Claude Code、Qwen/DevAgent 和 Hybrid 格式，但只有适配后真正有效的组件才会进入运行 catalog。

建议从**插件源码目录之外的、已存在的工作区**执行：

```bash
# 可选但推荐：不写入 registry 的安装前诊断
npm run dev -- plugins validate /path/to/plugin --cwd /path/to/workspace
# 安装到用户作用域；也可明确 --scope workspace
npm run dev -- plugins install /path/to/plugin --scope user --cwd /path/to/workspace
npm run dev -- plugins list --cwd /path/to/workspace
# 完整启动新 Host，加载新的启动快照
npm run dev -- --cwd /path/to/workspace
```

预期：安装会显示名称、版本、实际可用组件和警告。安装/更新只在 stdin、stdout、stderr 均为真实 TTY 时显示一次确认；输入 `y`/`yes` 才继续。没有 `--yes` 绕过选项。当前用户文档说明确认成功后在所选作用域直接启用；随后仍必须启动一个新 Host，Command、Skill、Agent、MCP、Hook 或 LSP 才会进入运行快照，不能热加载。

`list`/`inspect` 的状态含义：`loaded` 是有效组件已进入 catalog，`disabled` 是已安装但不装配，`warning` 是部分有效、部分跳过/失败，`failed` 是没有安全可用组件。`workspace` 覆盖优先于 `user`；停用、更新或删除都只影响下一 Host。`update` 保留 activation；`remove` 默认保留 Plugin data，只有 `--purge-data` 清数据。

常用管理命令：

```text
plugins inspect <name> [--scope user|workspace]
plugins enable|disable <name> [--scope user|workspace]
plugins update <name> [--source <source>]
plugins remove <name> [--purge-data]
plugins settings list|set|remove ...
```

### Settings：秘密不进入命令行

仅在 Plugin 声明 Settings 时使用。先列出声明，再通过受控标准输入写值：

```bash
npm run dev -- plugins settings list <name> --cwd /path/to/workspace
printf '%s' "$PLUGIN_SECRET" | npm run dev -- plugins settings set <name> <setting> --secret-stdin
npm run dev -- plugins settings remove <name> <setting>
```

真实 TTY 会无回显读取；非交互 set 必须显式带 `--secret-stdin`。秘密不能作为位置参数或选项值传入，list/set/remove 都不会回显。值只在**下一 Host**启动时传给该 Plugin 的有效 MCP、Hook 或 LSP 子进程，不会给 Command、Skill 或 Agent 注入环境变量。

运行时 Plugin 不是操作系统 sandbox。目录/zip 先复制到 0700 staging 区，校验 manifest、路径、大小、压缩比，拒绝 symlink 与特殊文件，再复制到内容寻址存储并二次校验 digest；进程以最小环境运行。即便如此，启用前仍应审查来源、实际有效组件和诊断；Plugin 子进程不会继承模型 API Key 或任意 Harness 环境变量，但仍应只启用可信来源。registry 与 digest 字段（含 `capability_fingerprint`）不可手改。

> **版本差异提示：** 旧文档与部分示例描述“安装后 disabled、以 `--capability-fingerprint` enable”的流程；当前 CLI parser 不接受该 flag。安装确认后按 scope 写入 activation：user scope 直接 `enabled`；workspace scope 的 user 记录为 `disabled`，但目标 workspace 的 override 为 `enabled`，有效 activation 即 `enabled`。以当前 CLI `--help` 与错误提示为准，勿手改 registry。

## 子代理与 Team

主 Agent 可用 `task` 委派工作；你可以在提示中要求“用 `explore` 搜索……”或通过 `/agents` 查看当前可派发角色。

| 角色 | 适合场景 | 边界 |
| --- | --- | --- |
| `explore` | 只读代码定位与搜索 | 仅 `ls`、`read_file`、`glob`、`grep`、`lsp`；无 Shell、写入、网络、MCP 或 Skill。 |
| `general-purpose` | 独立调研或实现任务 | 继承父任务的有效工具/Skill/MCP，但强制排除 `task`、问答与计划模式控制；始终受父 Policy 与审批约束。 |
| Plugin Agent | 可信插件提供的专门工作 | 声明能力与父权限取交集；交互不可用时 fail closed。 |

子代理最多一层委派，父会话同时最多运行 4 个，超额会排队；默认单个子代理 300 秒超时（当前无环境变量可调整该值）。取消父 Run 会取消执行中和排队中的子代理。超时会在 task 卡显示 `timed_out` / `DELEGATION_TIMEOUT`，主任务可继续，不会被自动判为失败；深度超限报 `DELEGATION_DEPTH_EXCEEDED`。子代理需要人工审批而无交互通道时失败关闭。TUI/Web 的 `task` 卡可进入只读子时间线；TUI 按 `Esc`、Web 选择返回主对话回到主线，审批仍在主会话 FIFO 队列中处理。

### Team：从定义到异步运行

空闲时使用 `/teams` 或 `/teams list` 查看固定 Plugin Team 与当前 Host 的预览 Team：

```text
/teams show <team-id>
/teams generate <team-id> <lead-agent> <worker1,worker2> [max-parallelism]
/teams run <team-id> <任务描述>
/teams status <run-id>
/teams cancel <run-id>
```

`show` 用于先核对任务 DAG；`run` 异步返回 run ID，随后用 `status` 查询或用 `cancel` 只取消该 Team Run。生成和运行需等当前任务结束；Team 不绕过正常 Policy、审批、取消或持久化规则。

## MCP：按需接入外部工具

交互式 Thread 中：

```text
/mcp
/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /tmp
/mcp add service --url https://example.invalid/mcp
/mcp add events --url https://example.invalid/sse --sse
/mcp remove filesystem
```

`/mcp` 显示连接状态、工具和脱敏错误；添加 stdio 或 HTTP/SSE server 会持久化到用户配置，并尝试热连接。执行中只能刷新状态，不能增删。模型默认使用 `tool_search` 以关键词或 `select:name1,name2` 精确发现低频/MCP 工具后再调用。Plugin MCP 与用户 MCP 合并进同一 Host generation；单个 server 连接失败只影响自身。

只配置你理解且信任的服务：MCP 的文件、网络和副作用能力仍受其自身实现、Harness Policy 和审批共同约束，不是安全隔离。若连接失败，先用 `/mcp` 查看该服务的脱敏状态，核对 command、URL、认证或外部进程，而不是放宽权限掩盖错误。

## 来源与维护锚点

- Skill 目录与生效时机：`packages/agent/harness_agent/extensions/skills.py`、`packages/agent/harness_agent/host/agent_host.py`（Run 准备阶段刷新 catalog）。
- Plugin CLI、consent、安装即启用语义与 staging：`packages/cli/src/args.ts`、`packages/cli/src/index.ts`、`packages/agent/harness_agent/plugins/manager.py`、`plugins/store.py`。
- 子代理委派、超时与权限交集：`packages/agent/harness_agent/runtime/agent_delegation.py`、`builtin_agents.py`、`child_approval.py`。
- Team 与 MCP：`packages/cli/src/interactive/command-dispatcher.ts`、`interactive/features/mcp-feature.ts`、`packages/agent/harness_agent/host/agent_host.py`。
- 工具延迟发现：`packages/agent/harness_agent/runtime/deferred_tools.py`。
：`packages/cli/src/interactive/command-dispatcher.ts`、`interactive/features/mcp-feature.ts`、`packages/agent/harness_agent/host/agent_host.py`。
- 工具延迟发现：`packages/agent/harness_agent/runtime/deferred_tools.py`。
