---
id: HC-227
title: 内核ACP命令与回放补齐
feature_area: 独立桌面协作工作台
parent_task: HC-192
decomposed_by: Coordinator
priority: P1
status: 待验收
owner: hc227-pyacp
branch: feat_hc_227_内核ACP命令与回放补齐
scope: 补齐 Python 内核 harness acp 的内置斜杠命令（多轮 /undo list 与指定回合回退关闭 GAP-40、/plan、/plan-view、/goal cancel）、session/load 与 session/resume 的 workflow 与 plan 状态恢复、清理 server.py 死代码与 docstring 漂移，并同步校准 docs/developer/architecture/ACP通信.md。
acceptance: /undo list 列出可回退回合且 /undo <N> [both|code|conversation] 与 /undo [both|code|conversation] <N> 按 1-based 回退；/plan 在声明 elicitation.form 时切换 plan 模式并可选运行（未声明时给出明确提示）；/plan-view 只读调用 open_thread(session_id, assume_idle=False) 展示计划、Compose 与 Goal；/goal cancel 映射至 goal_mutate(cancel_pending)；session/load 与 session/resume 从 thread_mode 恢复 workflow 且 session/load 在历史回放后补发 AgentPlanUpdate；server.py 死代码清理且 test_layering.py 零违规；packages/agent/tests/host/acp 全套通过且 ACP通信.md 漂移全部修复。
user_docs: 不涉及（内核 ACP 协议命令与会话回放补齐，桌面端 UI 消费不在本任务范围）
developer_docs: docs/developer/architecture/ACP通信.md
test_evidence: PYTHONPATH="$PWD/packages/agent" /Users/zhangjingxin/Code/MyRepo/harness-code/packages/agent/.venv/bin/python -m pytest packages/agent/tests/host/acp -> 479 passed, 1 warning in 107.66s (0:01:47)；tasks:sync 与 tasks:check 通过
references: docs/developer/task/HC-200-Harness独立ACP接入.md；docs/developer/architecture/ACP通信.md
completed_at: -
---

# HC-227 内核ACP命令与回放补齐

## 现状痛点与解决思路

### 1. 现状痛点

在 [HC-200](./HC-200-Harness独立ACP接入.md) 交付内核 `harness acp` 后，代码与 [ACP通信.md](../architecture/ACP通信.md) 对照存在多处缺口与文档漂移：

- **多轮 `/undo` 未闭环（GAP-40）**：只支持回退最新一轮，无法列出可回退回合或指定 1-based `#N` 回退。
- **缺 `/plan` 与 `/plan-view`**：`commands.py` 未实现 `/plan` 与 `/plan-view`，文档却误标为「已覆盖」并错引 `test_goal_changed_becomes_a_plan`。
- **`/goal cancel` 缺失**：`HostServicePort.goal_mutate` 已支持 `cancel_pending`，但 `/goal` 命令未映射 `cancel` / `cancel_pending`。
- **`load_session` / `resume_session` 状态丢失**：恢复历史线程时未从 `opened["thread_mode"]` 还原 `session.workflow`（导致 Compose 线程在 `configOptions` 里退回 `build`），且 `session/load` 未在回放后推送 `compose_progress` / `goal` 对应的 `AgentPlanUpdate(session_update="plan")`。
- **死代码与文档漂移**：`server.py` 残留未调用的 `prompt_text()` / `_resource_link_text()` / `_report_ignored()` 与「四个方法」旧注释；`ext.py` 的 `CAP_SUBAGENT` 注释错位；`ACP通信.md` 在 `compose.inspect`、`/help` 与 `/quit`、`goal.evaluation` 与 `_IGNORED_EVENT_TYPES`、`context.updated` 投影字段及 `GAP-40` 状态上与代码不一致。

### 2. 核心解决思路

1. **内置命令补齐（`commands.py` + `server.py`）**：
   - `/undo` 保留无参 / `both` / `code` / `conversation` 原行为，新增 `/undo list` 与 `/undo <N> [mode]` / `/undo [mode] <N>` 按 1-based 回合号定位未回退回合。
   - `/plan` 在 `self._forms=True` 时切换 `plan` 模式、发 `current_mode_update` 并在带文本时直接于 `plan` 模式启动 Run；`self._forms=False` 时拦截并返回需声明 `elicitation.form` 的明确提示。
   - `/plan-view` 调用 `host.open_thread(session_id, assume_idle=False)`，只读格式化 `plan` 正文、`compose_progress` 与 `goal` 状态。
   - `/goal cancel` / `/goal cancel_pending` 映射到 `host.goal_mutate(..., action="cancel_pending")`。
2. **回放状态恢复（`translate.py` + `sessions.py` + `server.py`）**：
   - 将 `compose_plan_entries` 与 `goal_plan_entries` 从 `translate.py` 抽为公共纯函数供 `sessions.py::replay_plan_update` 复用。
   - `_prepare_thread_session` 在 `load_session` 与 `resume_session` 均从 `opened["thread_mode"]` 恢复 `session.workflow`；`load_session` 在历史消息回放之后、`LoadSessionResponse` 返回之前补发 `AgentPlanUpdate`。
3. **死代码清理与文档对齐**：
   - 移除 `server.py` 死函数及 `__all__` 冗余导出，修正 `AcpServer` 与 `ext.py` 注释。
   - 按真实代码全面校准 [ACP通信.md](../architecture/ACP通信.md) 并以新增测试证据关闭 `GAP-40`。

## 变更文件

- 代码：`packages/agent/harness_agent/host/acp/{commands,ext,server,sessions,translate}.py`
- 测试：`packages/agent/tests/host/acp/{test_builtin_commands,test_server_commands,test_server_resume_close,test_server_sessions}.py`
- 架构文档：`docs/developer/architecture/ACP通信.md`

## 验证结果

- `PYTHONPATH="$PWD/packages/agent" /Users/zhangjingxin/Code/MyRepo/harness-code/packages/agent/.venv/bin/python -m pytest packages/agent/tests/host/acp`：**479 passed, 1 warning in 107.66s (0:01:47)**（含 `test_layering.py` 4 项零违规检查）。
- `node --no-warnings --experimental-loader ./scripts/typescript_loader.mjs scripts/project/index.ts tasks:sync` 与 `tasks:check`：通过。
