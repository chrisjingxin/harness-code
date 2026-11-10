---
id: HC-194
title: 每轮Token用量
spec: docs/developer/spec/HC-194-每轮Token用量.md
status: 已确认
---

# 每轮 Token 用量实施计划

需求见 [Task](../task/HC-194-每轮Token用量.md)，行为见 [已确认 Spec](../spec/HC-194-每轮Token用量.md)，执行见 [Todo](../todo/HC-194-每轮Token用量.md)。本阶段只生成计划，不实现。

## 顺序与公共约束

先完成 HC-194，再做 HC-193，后者复用轮次身份和历史摘要。两者独立交付；不新建共享第三 Task。用量统计不得依赖 HC-192 Trace 日志，已有未提交改动必须保留。

每一步先写最小失败测试，再实现、再检查邻近回归。下列步骤是相邻职责的小工作项，合在一个停点形成跨层可演示结果。不能只上线数据库、协议或按钮而宣称用户已能使用。公开生产接口和中文注释遵循 AGENTS.md。

## 停点 A：普通对话能显示并恢复每轮用量

### A1 调用事实与汇总（无依赖，中等）

新增 runtime 内独立用量收集模块，按 root Run 和 invocation 身份登记请求及最终用量，支持四字段 Usage 和可选缓存明细、累计流去重、部分缺失及重试。缓存不再次加进输入，缺失时不伪造命中率。运行边界只消费冻结汇总。主模型请求接入，包括明确登记已发起但缺失返回用量的请求。

邻近文件：runtime 新收集模块及其测试、主模型调用适配处。验收：100/20 与 150/30 汇总为 250/50；重复最终通知不增加；缺失、冲突、零调用符合 Spec。用 mock 断言真实请求身份，不能用 mock 汇总器自证。

### A2 终态与持久化（依赖 A1，中等）

ThreadPersistence 为 Run 保存四字段统计及终态；旧记录默认未知。RunCoordinator 完成/失败/取消均在持久化后发送同值；收拢调用后冻结。不得覆盖已有 HC-192 生命周期改动。

邻近文件：threads/thread_records.py、thread_persistence.py、host/run_coordinator.py 及对应测试。验收：完成/失败/取消与重新读取一致；注入写库失败不发送虚假的成功统计。Schema 版本通过现有入口递增，不手写平行存储。

### A3 两端契约和恢复摘要（依赖 A2，中等）

Protocol schema 改为 Spec 四字段 Usage，终态与 threads.open 的 run_summaries 统一；历史和实时保留 run_id。运行生成器并迁移全部消费方和 fixtures，不保留旧 Usage fallback。

邻近文件：protocol/schema/v3.json、生成输出、SDK 历史映射与 Agent 恢复返回。验收：Python/TS 合约对 null、完整性和安全整数校验一致；旧记录恢复未知。生成文件不计手工职责拆分。

### A4 多轮回答展示（依赖 A3，中等）

Interactive State 维护 runId→summary 映射并恢复；Web Timeline 将统计挂到对应最终回答/失败取消提示，支持精确格式、未知、下界及窄屏。共享状态变化同时迁移 TUI 使用 lastRun 的消费者。

邻近文件：interactive/state.ts、features/thread-feature.ts、web/presentation/timeline.tsx 及相邻样式/测试。验收：多轮不串位、重复事件不重复累计、复制正文不含统计。

**用户演示**：npm run dev → /web → 发两轮普通问题；分别查看回答下输入/输出 Token，刷新后仍一致。使用受控 mock 先验证精确值；真实供应商未返回 usage 时允许显示未知。此时子代理/压缩覆盖仍待停点 B，不能宣称完整功能交付。更新 Todo 及 tmp/handoff.md 后停下等用户查看。

## 停点 B：整轮执行全路径用量完整

进入 B 前先完成用户已确认的 A 验收修正：先写计时冻结、终态/存储一致和 Trace 展示失败测试；再将 Run 起点前移到准备前、在终态保存前冻结，将同值写入事件/历史/Trace 元数据；最后统一主 Run ROOT 行和分组的格式，保留原始 span 时长作详情诊断。回归包含失败/取消、保存耗时、后台释放和旧历史缺失字段。此修正作为当前唯一工作包，完成后重新交用户查看。

### B1 子代理调用归属（依赖 A，中等）

inline 与 managed child 的实际请求接入同一 root 收集器；父委派只返回结果，不重复上报汇总。验证两层嵌套、重试、错误、取消及请求清理，不改既有 slot/lease 生命周期。

邻近文件：runtime/agent_delegation.py、managed_agent_executor.py、调用适配及测试。验收：root+child+grandchild 精确求和；父工具摘要不会增加计数。

### B2 压缩调用与终态边界（依赖 B1，中等）

context_compaction 生成摘要的模型请求绑定触发该操作的 Run；无模型的微压缩不产生调用；独立压缩不归到上一轮。验证取消时已知小计、晚到回调不修改已冻结统计。

邻近文件：threads/context_compaction.py、请求适配及测试。验收：压缩请求用量计入一次；压缩前后估算 Token 不计作实际用量。

### B3 回归、文档与 review（依赖 B2，中等）

补跨层 mock 完整 Run（工具往返+child+压缩）及历史恢复验证。更新 docs/user/Web界面.md、现有上下文/会话架构与架构总览，说明未知和统计口径。用 code-review-and-quality review，结论写回 Task。

**用户演示**：在 /web 发起能触发子代理及压缩的受控场景，回答下查看完整汇总；重开会话比较相同值，并查看失败/缺失示例。提交检查通过、用户验收后再完成/归档 Task。

## 验证命令与完成信号

- Python：项目解释器通过 node scripts/dependencies/run_python.mjs -m pytest -q 执行新增用量测试及 tests/host/test_run_coordinator.py、tests/threads/test_thread_persistence.py、tests/threads/test_context_compaction.py（路径从 packages/agent 起或使用全路径）。
- CLI：在 packages/cli 下 bun test tests/interactive/state.test.ts tests/interactive/thread-feature.test.ts tests/web/presentation/timeline.test.tsx；B 阶段追加受影响 runtime/SDK 契约测试。
- 每停点运行 npm run protocol:check、npm run typecheck 及相关 focused tests；整任务提交前 npm run project:check、npm run typecheck、npm run test、npm run build。
- sandbox 禁止的宿主能力测试记录跳过，不申请额外权限。OpenWiki 命令可用则刷新，不可用记录原因。
- 版本本期不主动变更；Task 记录无版本修改。仅提交本任务范围，已有其他改动不得夹带。

## 风险与处理

已有 Trace 分支修改同文件：按现有工作区事实接入，不覆盖。全局回调重复计数：请求边界生成身份并测试。供应商不报告：保留未知而非估算。若实际引擎缺少请求级身份或无法收拢回调，停止实施回写 Spec，不临时发明 fallback。

用户确认 Plan/Todo 后，只实施停点 A；A 被查看并要求继续后实施 B。

