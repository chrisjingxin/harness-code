# 终端交互、审批与执行边界

Harness Code 默认从本机终端启动 TUI，把文字、工具事件、审批和提问放在同一个 Thread。日常操作流程见[工作流页](workflows.md)；时间线条目、检查器侧栏与命令速查见[终端交互专题](terminal-interaction.md)；本页说明权限规则。

## 完成任务的基本节奏

1. 在仓库根目录执行 `npm run dev`，在输入栏用自然语言描述目标。
2. 先从只读任务开始，审阅 Agent 的结论和工具时间线。
3. 当任务要修改文件、运行有副作用命令、联网、访问外部目录或委派子代理时，阅读请求摘要与 Diff，再选择允许或拒绝。
4. 执行中用 `Ctrl+C` 取消当前 Run；`Esc` 只关闭菜单/浮层。任务结束后可继续提问或用 `/new` 建立新 Thread。

常用按键速查见[工作流页的键盘操作速查](workflows.md#键盘操作速查)。输入 `@` 可以把工作区内的文本文件或行号范围附给下一次提问，超限或二进制路径会降级或忽略。

## Thread、命令与工作方式

- `/help`：显示当前协商到的命令；菜单会隐藏客户端或运行状态不支持的项。
- `/status`：查看工作区、模型、审批、上下文、MCP、Skill/Agent 等脱敏状态。
- `/resume` 或启动参数 `--resume`：仅在当前项目范围恢复 Thread；完整记录在用户目录的 SQLite 中。
- `/model`：为下一次 Run 选择模型，见[配置页](configuration.md)。
- `/compact`：空闲时压缩模型上下文，不删除可恢复的完整 Transcript。
- `/new`、`/title`、`/undo`、`/redo`：分别新建、命名、回退或恢复会话/代码状态；回退前应理解其二次确认选项。

运行中输入栏仍可编辑，但普通文字和 `//` 转义文本不会发送到当前 Run；用 `Ctrl+C` 取消。仍可用 `/help`、`/status`、`/btw`、`/title`、`/goal`、`/plan`、`/plan-view`、只读 `/mcp`/`/agents` 以及部分 `/teams` 查询/取消；`/compact`、`/resume`、`/undo`、`/redo`、`/model`、`/web`、Skill 选择、Team generate/run 要等任务结束。

工作模式有 Build 与 Compose。Build 是默认自主执行；Compose 会围绕需求、规格、计划、实现、检视建立文档化流程。它**不提升权限**，所有写入、命令、网络和 MCP 调用仍受当前审批与 Policy 约束。`/plan` 是 Build 的受限规划模式，不等于 Compose 的计划阶段：在计划模式中项目写入、会写 Shell 与子代理会被拒绝，只有会话计划文件可写。具体工作流见[日常任务页](workflows.md)。

## 审批与执行边界

默认执行环境是**本机且未隔离**。Harness 会限制内置文件工具在工作区内操作，但 `execute`、MCP 和外部工具并不是完整的操作系统沙箱；只应在可信开发环境中运行。

### 审批模式

`Shift+Tab` 在 `plan → default → auto-edit → auto → yolo` 间循环切换，空闲时影响下一次 Run，活动 Run 在无待处理交互时可提交切换（对后续决策生效）。存在待处理审批、问答或目录信任时切换会返回可重试的 busy；它只保存于当前会话，重启后回到配置默认值。产品默认档位是 **`auto`**（`HARNESS_APPROVAL_MODE` 或 `[approval] mode` 可改）；旧的 `ask` 值按 `default` 处理，未知值会安全收紧为 `default`。在未受信目录中，切换到 `auto`/`yolo` 会被锁定在 `default`。

| 模式 | 项目文件写入 | 会写/破坏性 Shell、子代理 | 联网请求 |
| --- | --- | --- | --- |
| `plan` | 拒绝 | 拒绝 | 允许（只读浏览） |
| `default` | 逐次确认 | 逐次确认 | 逐次确认 |
| `auto-edit` | 工作区内自动执行 | 逐次确认 | 逐次确认 |
| `auto`（默认） | 自动执行（工作区内） | 经 LLM 分类器判定，不确定时人工确认 | 同左 |
| `yolo` | 自动执行 | 自动执行 | 自动执行 |

`auto` 档的处理链：编辑类快速通道 → 只读白名单 → 破坏性命令守卫（`rm -rf /`、`git push --force`、`git reset --hard` 等模式默认硬拦截，用户消息明确表达破坏意图时降级为询问）→ 未决项交给两阶段 LLM 分类器（第一阶段快判，仅 `allow` 且高置信才放行；否则第二阶段复核）。分类器异常、超时或输出不可解析时**失败关闭**改为人工审批；连续 3 次拒绝也会回退人工。分类调用与主对话事件流隔离，不出现在时间线；可为它配置独立 Profile（`[approval] classifier`，见[配置页](configuration.md#审批分类器模型可选)）。

`yolo` 只跳过 Harness 的人工确认，不绕过硬 Policy、外部路径规则或操作系统限制。

### 审批响应与规则持久化

审批页会展示文件路径、增删统计和有界 Diff（最多 200 行 / 16 KiB）。即使预览截断，批准对应的仍是该次完整拟议变更；不确定时应拒绝并要求更小、更可审查的改动。响应有五种：

- **允许一次**：仅当前请求。
- **本会话允许**：存内存，仅当前 Thread 会话有效。
- **本项目允许**：持久化到项目 `.harness/settings.json` 的 permissions；规则层级为 项目 `.harness/settings.json` → 用户 `~/.harness/settings.json` → 系统 `/etc/harness/settings.json`（macOS `/Library/Application Support/Harness/`、Windows `C:/ProgramData/harness/`），会话层无文件。危险根命令不会被无条件永久放行，应纳入团队审查。
- **拒绝** / **拒绝并反馈**：反馈文本会转达给 Agent 用于修正方向。

首次访问工作区外目录需要目录信任卡，当前只有**本会话信任 / 拒绝**两项；持久化信任列表由用户级 `~/.harness/settings.json` 单独管理，未受信目录中隐藏“始终允许”并锁定 `default` 档。写入前还会比较文件版本，外部修改导致 `COMMIT_CONFLICT` 时不会覆盖，应重新读取并审查。

### Policy、审批与 sandbox 的关系

Policy 是角色能力上限（决定某类工具是否可用），审批决定已获能力是否需要人确认，sandbox 决定实际隔离强度；三者不能互相替代。Goal 验收与 Compose 不提权，grader 只读；受管 Plugin 子代理权限取父权限与角色上限的交集。`/.harness/` 是受控只读逻辑命名空间，不是宿主真实路径。

Shell 白名单拒绝复合命令、管道、重定向、命令替换等难以可靠解析的语法；命中白名单也不等于命令沙箱，仍是本机进程执行。

## 本机与远端执行环境

企业如果已交付并验证远端执行 Provider，可在用户级/显式配置 `[execution] backend = "remote"` 配合 `[execution.remote]`（必填 `provider`、`factory`，`working_directory` 须为绝对沙箱路径），或单次使用：

```bash
# 请求企业远端 provider
npm run dev -- --sandbox
# 等价的显式写法；关闭本次 CLI 覆盖可用 --sandbox=false 或 --sandbox=off
npm run dev -- --sandbox=remote
```

认证不写入 TOML 的 `params`。远端 provider 负责认证、同步、网络与生命周期；不可用时任务失败，**不会回退到本机**。当前没有 Docker、Podman 或通用本机容器 sandbox；没有企业 provider 时不要填写猜测的 `factory` 配置。

## 数据边界

不要把 API Key、Token、云凭据或其他秘密放进工作区、Prompt、截图或 Issue。日志和 UI 会做脱敏，但这不替代你的数据最小化责任。

## 来源与维护锚点

- 审批模式与切换：`packages/agent/harness_agent/policy/approval_mode.py`、`packages/cli/src/tui/application/shortcuts.ts`。
- 五档矩阵与审批流水线：`packages/agent/harness_agent/policy/tool_risk.py`、`approval_policy.py`、`auto_mode.py`。
- LLM 分类器：`packages/agent/harness_agent/policy/classifier.py`。
- 审批响应、目录信任与规则层级：`packages/cli/src/presentation-shared/interaction-policy.ts`、`packages/agent/harness_agent/policy/permission_rules.py`、`trust_gate.py`。
- Shell 白名单与远端执行：`packages/agent/harness_agent/policy/shell_allow_list.py`、`packages/agent/harness_agent/config/config.py`（`[execution]`）。
- Diff 有界预览与提交冲突：`packages/agent/harness_agent/tools/file_mutation.py`。
