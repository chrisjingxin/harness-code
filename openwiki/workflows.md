# 日常任务：Build、Compose、Plan 与会话操作

本页说明在 TUI（或已接管的 Web）中把需求变成可审查结果的常用流程。先在仓库根目录执行 `npm run dev`；运行中只有少数命令可用，普通文本会保留为草稿而不会插队发送。时间线各条目的呈现与截断、检查器侧栏、完整命令速查、`/goal` 闭环和文件工具规则见[终端交互专题](terminal-interaction.md)。

## 选择工作方式：Build 或 Compose

空闲且输入框为空、没有浮层时按 `Tab`，可在两种模式间切换；消息颜色会保留发送当时的模式。

| 模式 | 适用任务 | 你会看到什么 | 注意事项 |
| --- | --- | --- | --- |
| **Build**（默认） | 小改动、排查、明确的实现任务 | 一条消息交给主 Agent 自主完成 | 可用 `/plan` 和 `/goal`；仍受审批模式约束。 |
| **Compose** | 需求尚不清晰、需要规格/计划/检视留档的改动 | 需求 → 规格 → 计划 → 实现 → 检视；文档保存到 `docs/compose/<短名>/task.md`、`spec.md`、`plan.md`、`todo.md`、`report.md` | 不会提高任何权限；已确认阶段中断后进入同一 Compose 会话会继续，而非重问。 |

### Build：直接完成一项开发任务

1. 使用明确目标、范围和验证方式发送请求，例如：`修复登录表单的空值校验；先阅读相关测试，修改后运行对应测试。`
2. 审阅时间线中的读取、命令、Diff 和审批。需要取消时按 `Ctrl+C`；`Esc` 不会取消。
3. 任务结束后检查变更和测试结果；需要继续同一上下文时直接发送下一条消息，需要换话题则 `/new`。

预期：Agent 在当前 Thread 保留对话、工具记录和已批准改动。修改文件、执行高风险命令或联网时是否需要确认由[审批与执行边界](terminal-and-safety.md#审批与执行边界)决定。

### Compose：用文档化流程完成较大需求

1. 按 `Tab` 切到 Compose，再发送需求。
2. 回答澄清问题，确认需求/规格/计划文档；简单需求可能跳过单独的规格确认。
3. 实现阶段按 TDD 工作，随后进入检视；确认检视后该需求完成。
4. 要放弃当前需求但保留文件和代码，使用 `/abandon` 并确认；要立即开启另一项需求，使用 `/new-work <目标>`。

预期：每套需求的过程文档可提交到 Git，适合团队审查。文档根默认为 `docs/compose`，短名（slug）最长 48 字符、非 ASCII 名称会回退为 `work-<哈希前缀>`；固定文件名为 `task.md`、`spec.md`、`plan.md`、`todo.md`、`report.md`（检视报告固定为 `report.md`，见 `packages/agent/harness_agent/compose/document_paths.py`）。`/abandon` 不回滚代码或文档，二次确认后进度回到空闲；Compose 也不改变 Shell、网络、MCP 或写入的审批规则。

## 先规划再实现：Build 的 `/plan`

`/plan` 是 **Build 模式**的受限规划，不是 Compose 的 Plan 阶段。

```text
/plan
# 然后发送你的规划目标

# 或者一步提交目标
/plan 为支付回调增加幂等校验，并列出修改与测试步骤
```

进入后，项目写入、会写/破坏性 Shell、`task` 子代理及非明确只读的 MCP 会被拒绝；Agent 只能研究并写会话计划。计划保存于用户目录 `~/.harness/plans/<thread_id>.md`，不会写进仓库。计划预览中可：

- **批准并开始实现**：退出计划模式，恢复此前审批档位，并自动开始实现；
- **继续打磨**：附加整体意见或选中行批注，继续保持规划限制；
- **放弃计划**：退出且不改项目文件。

使用 `/plan-view` 重新打开当前计划；`/plan exit` 在普通计划状态下退出。若当前 Run 已接受一次性进入计划的请求，Host 可能拒绝中途退出，须等待该 Run 结束。无头模式没有这类确认交互，会安全拒绝相关提议。

## 让 Agent 看到正确文件：`@` 引用

在输入栏输入 `@` 浏览工作区，或直接写路径。常用写法：

```text
@packages/cli/src/index.ts 解释这个入口
@packages/cli/src/index.ts#L20-50 只检查这段参数处理
@"docs/my guide.md"#L10 检查带空格路径的第 10 行
```

- 小型 UTF-8 文件会直接附给下一条消息；单文件少于 10KB、300 行，单条消息累计最多 20KB、500 行。
- 指定行范围可引用更大文本，但源文件超过 16MiB 仍只传路径和大小；二进制、图片、锁文件、生成物、非 UTF-8、工作区外或不存在路径同样会降级/忽略。
- 降级并不等于 Agent 已读文件；它应再通过受控读取工具检查。修改前如果文件被 IDE 或其他人改过，应要求重新读取。
- 行号切片也接受 IDE 风格 `@path:20-50`；带空格路径写 `@"路径"#L10`。

## 高频 Slash Command

完整内置命令注册表（含运行中可用性、别名与 `/goal` 全部子命令）见[终端交互专题 §3–4](terminal-interaction.md#3-内置-slash-command-速查)；下表只列日常高频项。

| 目标 | 空闲时操作 | 预期结果/限制 |
| --- | --- | --- |
| 查看可用能力 | `/help`、`/status` | 命令菜单会按当前协商能力和状态隐藏不可用项。 |
| 发送以 `/` 开头的普通文本 | `//api/users 在哪里` | `//` 转义为普通消息；未知 `/命令` 不会发送给模型。 |
| 命名或新建会话 | `/title <短标题>`、`/new` | 标题出现在恢复列表；运行中 `/new` 会先确认并取消任务。 |
| 临时只读问答 | `/btw <问题>` | 回答在浮层中显示，不写入 Transcript、SQLite 或 Compose 工作项。 |
| 管理上下文 | `/compact` | 仅空闲时可用；压缩较早内容、保留最近两轮与完整可恢复 Transcript。无需压缩时明确提示 skipped，摘要失败不会伪装成功；压缩期间不接受新消息，不要重复提交。 |
| 选择模型 | `/model` 或 `/models` | 仅影响当前 Thread 的**下一次** Run；详见[配置](configuration.md#在-thread-中选择模型)。 |
| 管理扩展 | `/skills`、`/mcp`、`/agents`、`/teams` | 分别装配下一条消息的 Skill、查看/管理 MCP、浏览角色或管理 Team；详见[扩展](extensions.md)。 |

执行中仍可使用 `/help`、`/status`、`/btw`、`/title`、`/goal`、`/plan`、`/plan-view`、`/mcp`、`/agents` 和 `/teams`（查看/控制类，见命令定义 `runtime: allowed`）；`/compact`、`/resume`、`/undo`、`/redo`、`/model`、`/web`、`/new-work`、`/abandon` 要等任务结束。`/skills` 未标记 `runtime: allowed`，active Run 中它保留在命令菜单里但显示"当前任务结束后可用"的禁用原因，不能执行选择；同样地，Plugin Command（要求 `requiresIdle`）运行中禁用。普通文本和 `//` 文本不会送入正在运行的任务。未知 `/命令` 不会发给模型，本地会给出相近命令建议；`/skills` 是选择器，Skill 以 `/skill:<id>` 形式出现在命令菜单（仅 enabled 且 userInvocable 的项，`packages/cli/src/interactive/commands.ts`）。Plugin Command 与内置命令冲突时以 `<插件名>.<命令名>` 出现。

## 键盘操作速查

| 按键 | 空闲时 | 运行中 |
| --- | --- | --- |
| `Enter` | 发送消息 | 仍可编辑草稿但不发送 |
| `Shift+Enter` | 输入换行 | 同上 |
| `/` 或 `Ctrl+P` | 打开命令菜单 | 运行中隐藏不可见项，保留禁用项并显示原因 |
| `Ctrl+O` | 切换工具详情展开 | 可用 |
| `Shift+Tab` | 循环审批档位（见[安全页](terminal-and-safety.md#审批与执行边界)） | 需 Host 确认；有待处理交互时返回 busy |
| `Tab`（空输入） | 切换 Build/Compose 工作模式 | 不可用 |
| `Esc` | 关闭菜单/浮层；无草稿时清除已选 Skill | **不取消 Run**，仅提示用 Ctrl+C |
| `Ctrl+C` | 有草稿先清空草稿，再按一次退出 | 取消当前 Run |
| `Ctrl+D` | 退出 | 退出（先取消） |
| 空输入 `↑/↓` | 回填历史消息 | — |
| `PageUp`/`PageDown`、`Ctrl+↑/↓`、`Home/End` | 滚动时间线 | 可用 |

审批出现时输入栏变为操作栏（底部区域按审批/目录信任/提问/计划/Goal 分别渲染），用方向键或数字键选择响应，`Enter` 确认、`Esc` 关闭选择器；同一 Run 的多个交互请求排队一次显示一个。

## 恢复、撤销与重做

### 恢复 Thread

在同一项目的交互式会话中使用 `/resume`，或从 Shell 启动：

```bash
npm run dev -- --resume
```

选择器显示短标题、更新时间和消息数，不要求也不接受 Thread ID。`--resume <id>`、`--resume=<id>` 都会报错；旧 `--continue`/`-c` 已废弃。恢复范围仅是当前 project，完整 Transcript 保存在 `~/.harness/threads.sqlite3`。

若恢复失败，先确认当前工作区与创建会话时相同、CLI 与 Python sidecar 来自同一源码/虚拟环境。不要未备份就删除 `threads.sqlite3`、`-wal` 或 `-shm`；迁移类错误的专门恢复步骤见[故障排查 §16](troubleshooting.md#16-无法恢复-thread含数据库迁移)。

### 撤销/重做当前会话和代码

- `/undo`（也可 `/rewind`、`/rollback`）打开历史回合选择器；二次确认时选择“代码与对话一起回退”（推荐）、“仅对话”或“仅还原代码”。非 Git 工作区仅支持仅回退对话。
- 回退后进入暂存态，**在发送新的 Prompt 前**可用 `/redo` 恢复最近一次撤销。
- 一旦发送新 Prompt，redo 不再可用。已完成的 `/goal` 被撤销时，目标定义保留但状态变为进行中，后续需重新验收。

这不是 Git reset 的替代品：先理解目标回合及代码影响，再确认。文件外部修改或 Snapshot 冲突时，应按[文件冲突恢复](troubleshooting.md#12-文件-snapshot-过期或未读取)重新读取和审查。

### 会话计划文件

Build 计划模式下 Agent 只能写会话计划文件。Agent 看到的虚拟路径是 `/.harness/plan.md`，磁盘实际落在 `~/.harness/plans/<thread_id>.md`（权限 0700，不进入 Git，也不会出现在项目文件树）。这是受控逻辑命名空间，不是工作区真实路径，不能用它向项目写文件。

## 来源与维护锚点

- TUI 命令、快捷键与运行中限制：`packages/cli/src/interactive/commands.ts`、`command-dispatcher.ts`、`packages/cli/src/tui/application/shortcuts.ts`。
- `@` 引用与降级规则：`packages/cli/src/workspace/mention-resolver.ts`、`packages/cli/src/presentation-shared/mention-parse-policy.ts`。
- 计划文件、Compose 文档与 Goal：`packages/agent/harness_agent/tools/plan_file.py`、`compose/document_paths.py`、`packages/cli/src/interactive/features/goal-feature.ts`。
- 撤销/重做与 Thread 恢复：`packages/cli/src/tui/presentation/undo-modal.tsx`、`packages/agent/harness_agent/threads/`。