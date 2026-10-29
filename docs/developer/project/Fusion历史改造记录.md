# Fusion 历史改造记录

本文保留当时的修复背景，不能据此选择当前恢复或写权限规则。当前实现见 [Fusion 设计与实现](../architecture/fusion-dual-model-workflow-design.md)，使用方法见 [使用指南](../../user/fusion-guide.md)。

## 1. 派单占用修复（2026-10-20）

本节记录 HC-186 之前的故障背景。整目录单写者及普通冲突返回 `FUSION_LEASE_BUSY` 的路径已由第 4 节文件预留、自动排队替代。`LEASE_BUSY` 也从未等于模型会话或进程卡住。

当时的修复链路（已替代）：`start_round` 在原子事务中发现占用 → 返回安全占用摘要 → 当前任务记录 `WAITING_USER/workspace_busy` → `FusionEffectMiddleware.abefore_model` 在下一次模型请求前结束本轮。没有任务单、消息、轮次或子执行被部分登记，也不自动取消占用者。

- `workspace_blocker` 在既有任务 JSON 中保存，仅包含占用任务/会话 ID、阶段、轮次、安全原因及待核查标记；协议增加严格可空字段，不新增 SQLite 表。
- 查询和显式继续都核对数据库里的实际写者。占用仍在时不请求模型；占用解除时查询只提示可继续，用户新消息才恢复原首轮派单。
- `fusion_rework` 在没有任务单时返回 `FUSION_FIRST_ORDER_REQUIRED`；已有任务单而尚无票据仍允许按原规则返工。
- TUI/Web 共用占用文案及会话引导；较早发出的状态查询不能覆盖较新的进度。问答历史的“已处理”不表示任务完成。
- 测试覆盖真实 Host、Pool、图、Snapshot 文件工具、可信检查及审阅：占用只产生一次 Lead 请求，仍占用时的新消息产生零模型请求；旧任务正常取消后，同一任务完成首轮创建和验证。

## 2. 模型长等待和重复拒绝的收尾（2026-10-21）

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


## 3. 派单与恢复体验优化（HC-184，2026-10-21）

本节保留故障处理背景；目录写权限的当前规则以第 4 节和 HC-186 为准，正常范围冲突自动排队。

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


